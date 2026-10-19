// [COMP-7 PRODUCT WIRING] real-data smoke. READ ONLY against the real KG; never invokes a model.
// Real KG: every SQLite handle is readonly and the KnowledgeGraphStore is opened without initialize/migrations.
// Companion: a throwaway temporary store (the real Companion store is never opened). The product wiring and the
// product route are used as shipped; the model is replaced by a boundary capture that runs the Companion model's own
// validateAssembly + buildCompanionMessages (what the local runtime would receive) and contacts nothing.
// Prints counts, booleans and codes only — no title, label or answer text.
import '../test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Hono } from 'hono';

import { KnowledgeGraphStore } from '../src/lib/kg-store.js';
import { COMPANION_KG_LIMITS } from '../src/lib/kg-companion-context.js';
import { CompanionStore } from '../src/lib/companion-store.js';
import { validateAssembly, buildCompanionMessages } from '../src/lib/companion-model.js';
import { wireCompanionConversation } from '../src/lib/wire-companion-conversation.js';
import { createCompanionUiRoute } from '../src/routes/companion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DB = path.join(DATA, 'cortex.sqlite');
const WATCHED = [DB, `${DB}-wal`, path.join(DATA, 'companion-v1', 'companion.sqlite'),
  ...(fs.existsSync(path.join(DATA, 'backups')) ? fs.readdirSync(path.join(DATA, 'backups')).filter(f => f.startsWith('pre-kg-')).map(f => path.join(DATA, 'backups', f)) : [])];
const hash = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'absent');
const fileState = () => Object.fromEntries(WATCHED.map(f => [path.relative(ROOT, f), hash(f)]));
const counts = (db) => ({
  entities: db.prepare('SELECT COUNT(*) FROM kg_entities').pluck().get(),
  relationships: db.prepare('SELECT COUNT(*) FROM kg_relationships').pluck().get(),
  provenanceRefs: db.prepare('SELECT COUNT(*) FROM kg_source_refs').pluck().get(),
  relationshipProvenance: db.prepare('SELECT COUNT(*) FROM kg_relationship_provenance').pluck().get(),
  claims: db.prepare('SELECT COUNT(*) FROM kg_claims').pluck().get(),
});
const sample = (db, targetPrefix) => db.prepare(`
  SELECT video.name AS videoLabel, target.name AS targetLabel
  FROM kg_relationships r
  JOIN kg_entities video ON video.entity_id = r.source_entity_id
  JOIN kg_entities target ON target.entity_id = r.target_entity_id
  JOIN kg_entity_identifiers ti ON ti.entity_id = target.entity_id
  WHERE r.relationship_type = 'MEMBER_OF' AND video.name GLOB '*[A-Za-z0-9]*'
    AND ti.scheme = 'external' AND ti.status = 'ACTIVE' AND ti.original_value LIKE ?
  ORDER BY r.relationship_id LIMIT 1`).get(`${targetPrefix}%`);
const multi = (db) => db.prepare(`
  SELECT video.name AS videoLabel, COUNT(DISTINCT target.name) AS n
  FROM kg_relationships r JOIN kg_entities video ON video.entity_id = r.source_entity_id
  JOIN kg_entities target ON target.entity_id = r.target_entity_id
  WHERE r.relationship_type = 'MEMBER_OF' AND video.name GLOB '*[A-Za-z0-9]*'
  GROUP BY r.source_entity_id HAVING COUNT(DISTINCT target.name) >= 2 ORDER BY r.source_entity_id LIMIT 1`).get();
// (memberships to identically-labelled collections are byte-identical context texts: the COMP-3 dedup merges them
// and keeps both provenances — so the check needs two DISTINCT collection labels)
const ollamaUp = () => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 11434 });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.setTimeout(500, () => { s.destroy(); resolve(false); });
});

let fetchCalls = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network is not allowed in this smoke'); };

const inspect = new Database(DB, { readonly: true, fileMustExist: true });
const before = counts(inspect);
assert.equal(inspect.prepare("SELECT value FROM kg_metadata WHERE key = 'schema_version'").pluck().get(), '2.3.0');
assert.equal(inspect.prepare("SELECT value FROM kg_metadata WHERE key = 'activation_state'").pluck().get(), 'ACTIVE');
const collection = sample(inspect, 'docteur:neuron:');
const playlist = sample(inspect, 'youtube:playlist:');
const both = multi(inspect);
inspect.close();
assert.ok(collection && playlist, 'real collection and playlist membership samples exist');
const filesBefore = fileState();
const runtimeAvailable = await ollamaUp();

const store = new KnowledgeGraphStore(DB, { readOnly: true, production: true, timeout: COMPANION_KG_LIMITS.timeoutMs });
store.open();
store.initialized = true; // schema checked above; never invoke migrations on the production store

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp7-real-'));
const companionStore = CompanionStore.open({ dbPath: path.join(TMP, 'companion.sqlite') });
const captured = [];
const boundaryModel = {
  async executeCompanionLocal({ requestId, context }) {
    captured.push(buildCompanionMessages(validateAssembly(context, requestId)));
    return { status: 'COMPLETED', requestId, text: 'MODEL_NOT_RUN', truncated: false, effectiveModel: null, requestedModel: null, durationMs: 0, contextItems: null };
  },
};
const companion = {
  preferences: () => ({ memoryEnabled: false, sessionMemoryEnabled: false, proposalEnabled: false, cloudContextEnabled: false }),
  session: { list: () => [] }, view: () => null, recordContextAssembly: () => { throw new Error('no Companion audit expected'); },
};
const memoryPort = { retrieve: async () => { throw new Error('NB-5 must not be read with memory off'); } };
const logs = [];
const { conversation, kgGate } = wireCompanionConversation({
  companion, memoryPort, kgStore: store, env: {}, store: companionStore, model: boundaryModel,
  logger: { info: (o, m) => logs.push({ o, m }), warn: (o, m) => logs.push({ o, m }), error: (o, m) => logs.push({ o, m }) },
});
const app = new Hono().route('/api', createCompanionUiRoute({ service: {}, conversation }));
const ask = async (text) => {
  const res = await app.request('/api/companion/answers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal(res.status, 200);
  const { value } = await res.json();
  const messages = captured.at(-1);
  const data = JSON.parse(messages[1].content.split('\n').slice(2, -1).join('\n'));
  return { value, kg: data.retrievedData.filter(i => i.kind === 'KG_RESULT').map(i => ({ ...i, parsed: JSON.parse(i.text) })), messages };
};

const video = await ask(collection.videoLabel);
const coll = await ask(collection.targetLabel);
const play = await ask(playlist.videoLabel);
const multiVideo = both ? await ask(both.videoLabel) : null;
const unknown = await ask('zzzzcomp7wiringunknownzzzz-20261019');
store.close();
companionStore.close();

const memberships = (r) => r.kg.filter(i => i.parsed.relation === 'MEMBER_OF');
const all = [video, coll, play, unknown, ...(multiVideo ? [multiVideo] : [])];
const result = {
  kgGate: kgGate.reason,
  knownVideo: video.value.diagnostics.kgContextUsed && video.kg.some(i => i.parsed.label === collection.videoLabel),
  knownCollection: coll.value.diagnostics.kgContextUsed && coll.kg.some(i => i.parsed.label === collection.targetLabel || i.parsed.collection === collection.targetLabel),
  collectionMembership: memberships(video).some(i => i.parsed.collection === collection.targetLabel),
  playlistMembership: memberships(play).some(i => i.parsed.collection === playlist.targetLabel),
  multiMembershipVideo: multiVideo ? { memberships: memberships(multiVideo).length, expectedAtLeast: Math.min(2, both.n) } : null,
  memberOfOnly: all.every(r => r.kg.every(i => i.parsed.relation === undefined || i.parsed.relation === 'MEMBER_OF')),
  unknownEmpty: unknown.value.diagnostics.kgContextUsed === false && unknown.kg.length === 0,
  provenance: [video, coll, play].every(r => r.value.kgProvenance.length > 0 && r.value.kgProvenance.every(p => p.authority === 'NONE' && p.sourceRef)),
  authorityNone: all.every(r => r.kg.every(i => i.parsed.authority === 'NONE' && i.flags.includes('AUTHORITY_NONE'))),
  noClaims: all.every(r => r.kg.every(i => i.parsed.factStatus === 'NO_SUPPORTED_KG_FACT')),
  bounded: all.every(r => r.kg.length <= COMPANION_KG_LIMITS.maxResults && r.kg.every(i => i.text.length <= COMPANION_KG_LIMITS.maxTextPerResult)
    && r.value.diagnostics.kg.chars <= COMPANION_KG_LIMITS.maxContextChars),
  policyFromCode: all.every(r => r.messages[0].role === 'system' && !r.kg.some(i => r.messages[0].content.includes(i.parsed.label ?? '\u0000'))),
  logsContentFree: ![collection.videoLabel, collection.targetLabel, playlist.videoLabel, playlist.targetLabel].some(s => JSON.stringify(logs).includes(s)),
  diagnostics: all.map(r => ({ kgContextUsed: r.value.diagnostics.kgContextUsed, status: r.value.diagnostics.kg.status, used: r.value.diagnostics.kg.used, chars: r.value.diagnostics.kg.chars })),
};

const verify = new Database(DB, { readonly: true, fileMustExist: true });
const after = counts(verify);
verify.close();
const filesAfter = fileState();
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
globalThis.fetch = realFetch;

console.log(JSON.stringify({ before, after, countsIdentical: JSON.stringify(before) === JSON.stringify(after), filesUnchanged: JSON.stringify(filesBefore) === JSON.stringify(filesAfter),
  watchedFiles: Object.keys(filesBefore).length, fetchCalls, ollamaLoopback: runtimeAvailable ? 'AVAILABLE_NOT_USED' : 'UNAVAILABLE', model: 'NOT_RUN', result, titlesPrinted: false }, null, 1));

for (const k of ['knownVideo', 'knownCollection', 'collectionMembership', 'playlistMembership', 'memberOfOnly', 'unknownEmpty', 'provenance', 'authorityNone', 'noClaims', 'bounded', 'policyFromCode', 'logsContentFree']) assert.ok(result[k], k);
if (result.multiMembershipVideo) assert.ok(result.multiMembershipVideo.memberships >= result.multiMembershipVideo.expectedAtLeast, 'multi-membership video keeps its memberships');
assert.deepEqual(after, before, 'KG counts unchanged');
assert.deepEqual(filesAfter, filesBefore, 'production files byte-unchanged');
assert.equal(fetchCalls, 0, 'no network');
