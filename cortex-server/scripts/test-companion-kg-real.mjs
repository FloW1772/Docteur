// COMP-7 real production smoke. READ ONLY: every SQLite handle is readonly and
// the KnowledgeGraphStore is opened without initialize/migrations.
import '../test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { KnowledgeGraphStore } from '../src/lib/kg-store.js';
import { createKnowledgeGraphApi } from '../src/lib/kg-consumer-api.js';
import { createCompanionKgReadPort, COMPANION_KG_LIMITS } from '../src/lib/kg-companion-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'data', 'cortex.sqlite');
const COMPANION = path.join(ROOT, 'data', 'companion-v1', 'companion.sqlite');
const RECOVERY = path.join(ROOT, 'data', 'backups', 'pre-kg-youtube-seed-2026-10-18T16-23-45-863Z.sqlite');
const EXPECTED = Object.freeze({ entities: 12_728, relationships: 13_585, provenanceRefs: 13_645, claims: 0 });

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fileState = () => ({ canonical: hash(DB), companion: hash(COMPANION), recovery: hash(RECOVERY) });
const counts = (db) => ({
  entities: db.prepare('SELECT COUNT(*) FROM kg_entities').pluck().get(),
  relationships: db.prepare('SELECT COUNT(*) FROM kg_relationships').pluck().get(),
  provenanceRefs: db.prepare('SELECT COUNT(*) FROM kg_source_refs').pluck().get(),
  claims: db.prepare('SELECT COUNT(*) FROM kg_claims').pluck().get(),
});
const sample = (db, targetPrefix) => db.prepare(`
  SELECT r.source_entity_id AS videoId, video.name AS videoLabel,
         r.target_entity_id AS targetId, target.name AS targetLabel
  FROM kg_relationships r
  JOIN kg_entities video ON video.entity_id = r.source_entity_id
  JOIN kg_entities target ON target.entity_id = r.target_entity_id
  JOIN kg_entity_identifiers targetIdentifier ON targetIdentifier.entity_id = target.entity_id
  WHERE r.relationship_type = 'MEMBER_OF'
    AND video.name GLOB '*[A-Za-z0-9]*'
    AND targetIdentifier.scheme = 'external'
    AND targetIdentifier.status = 'ACTIVE'
    AND targetIdentifier.original_value LIKE ?
  ORDER BY r.relationship_id
  LIMIT 1`).get(`${targetPrefix}%`);

const inspect = new Database(DB, { readonly: true, fileMustExist: true });
const before = counts(inspect);
assert.deepEqual(before, EXPECTED);
assert.equal(inspect.prepare("SELECT value FROM kg_metadata WHERE key = 'schema_version'").pluck().get(), '2.3.0');
assert.equal(inspect.prepare("SELECT value FROM kg_metadata WHERE key = 'activation_state'").pluck().get(), 'ACTIVE');
assert.ok(inspect.prepare("SELECT 1 FROM kg_metadata WHERE key = 'population_run:kgpop_20261018162411_ae6cf280'").get());
const collection = sample(inspect, 'docteur:neuron:');
const playlist = sample(inspect, 'youtube:playlist:');
assert.ok(collection && playlist, 'real collection and playlist membership samples exist');
console.log(JSON.stringify({ sampleShape: {
  collectionVideoChars: collection.videoLabel.length, collectionVideoHasLetterOrNumber: /[\p{L}\p{N}]/u.test(collection.videoLabel),
  collectionTargetChars: collection.targetLabel.length, playlistVideoChars: playlist.videoLabel.length, playlistTargetChars: playlist.targetLabel.length,
} }));
inspect.close();

const filesBefore = fileState();
const store = new KnowledgeGraphStore(DB, { readOnly: true, production: true, timeout: COMPANION_KG_LIMITS.timeoutMs });
store.open();
store.initialized = true; // current schema was checked above; never invoke migrations on production smoke
const certified = createKnowledgeGraphApi(store).forConsumer('companion');
const traced = {
  consumer: 'companion',
  retrieveKnowledge: async (req) => certified.retrieveKnowledge(req).catch(error => { console.log(JSON.stringify({ readFailure: { operation: 'retrieveKnowledge', code: error?.code ?? 'UNKNOWN' } })); throw error; }),
  getNeighborhood: async (req) => certified.getNeighborhood(req).catch(error => { console.log(JSON.stringify({ readFailure: { operation: 'getNeighborhood', code: error?.code ?? 'UNKNOWN' } })); throw error; }),
};
const port = createCompanionKgReadPort({ consumer: traced, enabled: true });

const collectionVideo = await port.retrieve(collection.videoLabel);
const collectionLookup = await port.retrieve(collection.targetLabel);
const playlistVideo = await port.retrieve(playlist.videoLabel);
const unknown = await port.retrieve('zzzzcomp7unknownzzzz-20261018');
store.close();

const contains = (result, value) => result.items.some(x => x.text.includes(value));
const knownVideo = contains(collectionVideo, collection.videoLabel);
const collectionMembership = collectionVideo.items.some(x => x.type === 'MEMBERSHIP' && x.text.includes(collection.targetLabel));
const playlistMembership = playlistVideo.items.some(x => x.type === 'MEMBERSHIP' && x.text.includes(playlist.targetLabel));
const knownCollection = contains(collectionLookup, collection.targetLabel);
const provenance = [collectionVideo, collectionLookup, playlistVideo].some(r => r.items.some(x => x.provenance.length > 0));
const authorityNone = [collectionVideo, collectionLookup, playlistVideo, unknown].every(r => r.authority === 'NONE');
const bounded = [collectionVideo, collectionLookup, playlistVideo, unknown].every(r => r.items.length <= COMPANION_KG_LIMITS.maxResults
  && r.items.every(x => x.text.length <= COMPANION_KG_LIMITS.maxTextPerResult)
  && r.items.reduce((n, x) => n + x.text.length, 0) <= COMPANION_KG_LIMITS.maxContextChars
  && r.items.flatMap(x => x.provenance).length <= COMPANION_KG_LIMITS.maxProvenanceItems);
const noClaims = [collectionVideo, collectionLookup, playlistVideo, unknown].every(r => r.factStatus === 'NO_SUPPORTED_KG_FACT' && r.items.every(x => x.type !== 'CLAIM'));
const unknownEmpty = unknown.status === 'EMPTY' && unknown.items.length === 0;

console.log(JSON.stringify({ diagnostic: {
  collectionVideo: { status: collectionVideo.status, reason: collectionVideo.reason ?? null, types: collectionVideo.items.map(x => x.type), count: collectionVideo.items.length },
  collectionLookup: { status: collectionLookup.status, reason: collectionLookup.reason ?? null, types: collectionLookup.items.map(x => x.type), count: collectionLookup.items.length },
  playlistVideo: { status: playlistVideo.status, reason: playlistVideo.reason ?? null, types: playlistVideo.items.map(x => x.type), count: playlistVideo.items.length },
  unknown: { status: unknown.status, reason: unknown.reason ?? null, types: unknown.items.map(x => x.type), count: unknown.items.length },
} }));

assert.ok(knownVideo, 'known video retrieval');
assert.ok(knownCollection, 'known collection retrieval');
assert.ok(collectionMembership, 'collection MEMBER_OF retrieval');
assert.ok(playlistMembership, 'playlist MEMBER_OF retrieval');
assert.ok(provenance, 'provenance preserved');
assert.ok(authorityNone, 'authority NONE');
assert.ok(bounded, 'all COMP-7 bounds');
assert.ok(noClaims, 'zero claims means no supported factual claim');
assert.ok(unknownEmpty, 'unknown query is empty');

const verify = new Database(DB, { readonly: true, fileMustExist: true });
const after = counts(verify);
verify.close();
const filesAfter = fileState();
assert.deepEqual(after, before, 'KG counts unchanged');
assert.deepEqual(filesAfter, filesBefore, 'canonical KG, Companion, and recovery files byte-unchanged');

console.log(JSON.stringify({
  before, after,
  smoke: { knownVideo, knownCollection, collectionMembership, playlistMembership, unknownEmpty, provenance, authorityNone, bounded, noClaims },
  filesUnchanged: filesAfter.canonical === filesBefore.canonical && filesAfter.companion === filesBefore.companion && filesAfter.recovery === filesBefore.recovery,
  titlesPrinted: false,
}));
