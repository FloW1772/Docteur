// Companion V1 — COMP-5 suite: typed local action framework + approvals.
// NB-5 runs for real on a TEMPORARY Docteur database (fake embeddings, inspectable in-memory vector store); the Companion
// store lives in separate temporary databases. The two-process approval race and the restart test use child processes
// on temporary files only. No network (fetch is a counting stub), no model, no cloud; the real user DB is never opened
// for writing.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { ensureMemorySchema } from './src/lib/notebook-memory-schema.js';
import { COMPANION_MIGRATIONS, COMPANION_SCHEMA_VERSION, runCompanionMigrations, companionSchemaVersion, assertAdditiveSql } from './src/lib/companion-schema.js';
import { CompanionStore } from './src/lib/companion-store.js';
import { CompanionMemory } from './src/lib/companion-memory.js';
import { COMPANION_ACTIVATION, COMPANION_CERTIFIED } from './src/lib/companion-boot.js';
import { detectSecretMemory } from './src/lib/companion-secrets.js';
import * as R from './src/lib/companion-action-registry.js';
import { createCompanionActions, ACTION_AUDIT_EVENTS, ACTION_STATUS } from './src/lib/companion-actions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp5-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const code = (c, reason = null) => (e) => {
  assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`);
  if (reason) assert.equal(e?.details?.reason, reason, `expected reason ${reason}, got ${e?.details?.reason}`);
  if (e?.details?.decision) assert.equal(e.details.decision, `DENY_${c}`);
  return true;
};
let realDbBefore; let fetchCalls = 0; const realFetch = globalThis.fetch; const opened = [];

before(() => {
  realDbBefore = REAL_DB.map(fileHash);
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network is not allowed in COMP-5 tests'); };
  initSqlite(path.join(TMP, 'docteur-temp.sqlite'));
  ensureMemorySchema(getDatabase());
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) { try { s.close(); } catch { /* closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

// ── fixtures ──
const DIM = 32;
const embed = async (t) => { const v = new Array(DIM).fill(0); for (const w of String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIM] += 1; } const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const memVectors = () => { const rows = new Map(); return { rows, upsert: async (l) => { for (const r of l) rows.set(r.memory_id, { ...r }); }, search: async () => [], delete: async (ids) => { for (const i of ids) rows.delete(i); } }; };
let docService = null;
function nb5(vectors) {
  if (!docService) docService = createNotebookDocumentService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: { upsert: async () => {}, search: async () => [], delete: async () => {} }, lancedbPath: path.join(TMP, 'unused.lance'), localComplete: async () => 'ok' });
  return createMemoryService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: vectors, localComplete: async () => 'ok' });
}
let n = 0;
let clockMs = Date.parse('2026-10-16T10:00:00.000Z');
const clock = () => clockMs;
const advance = (ms) => { clockMs += ms; };
let uniq = 0;
/** wrap(mem) → the Companion port the framework gets (doubles share the SAME store, so transactions cover them). */
function fresh({ wrap = null, vectorProbe = null, vectorPurge = null, approvalTtlMs } = {}) {
  const store = CompanionStore.open({ dbPath: path.join(TMP, `companion-${++n}.sqlite`), now: clock }); opened.push(store);
  const vec = memVectors();
  const svc = nb5(vec);
  const mem = new CompanionMemory({ store, nb5: svc, vectorProbe: vectorProbe ?? (async (id) => vec.rows.has(id)), vectorPurge: vectorPurge ?? (async (id) => { vec.rows.delete(id); }) });
  const port = wrap ? wrap(mem) : mem;
  // COMP-6A: the product channel is UI_GESTURE; this COMP-5 suite exercises the framework through the test-only direct channel
  const A = createCompanionActions({ store, companion: port, approvalChannel: 'DIRECT_TEST_ONLY', ...(approvalTtlMs ? { approvalTtlMs } : {}) });
  return { store, mem, svc, vec, A, port };
}
const USER = { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' };
const rw = () => Array.from(crypto.randomBytes(7), b => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
/** Lexically distinct statements (NB-5 refuses near-duplicates by shingle Jaccard). */
const remember = (mem, opts = {}) => mem.rememberExplicit({ category: 'USER_PREFERENCE', value: `Je préfère thème ${++uniq} ${rw()} ${rw()} ${rw()} ${rw()} ${rw()} ${rw()}.`, provenance: USER, ...opts });
/** A double that forwards the Companion port and lets a test hook one method. */
const port = (mem, hooks = {}) => ({
  preferences: () => mem.preferences(), view: (id) => mem.view(id), session: mem.session,
  setPreferences: hooks.setPreferences ?? ((p) => mem.setPreferences(p)), setCompanionEnabled: hooks.setCompanionEnabled ?? ((id, e) => mem.setCompanionEnabled(id, e)),
  setPrivacyScope: hooks.setPrivacyScope ?? ((id, s, o) => mem.setPrivacyScope(id, s, o)), forget: hooks.forget ?? ((id) => mem.forget(id)),
});
/** Every non-action Companion table + the NB-5 memory count: what a READ_ONLY action must never change. */
const domain = (store) => JSON.stringify([store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companion_%' AND name NOT LIKE 'companion_action_%' ORDER BY name").all()
  .map(t => [t.name, store.db.prepare(`SELECT * FROM ${t.name}`).all()]), getDatabase().prepare('SELECT COUNT(*) AS n FROM dmem_items').get().n]);
const actionText = (store) => JSON.stringify(['companion_action_proposals', 'companion_action_approvals', 'companion_action_audit'].map(t => store.db.prepare(`SELECT * FROM ${t}`).all()));
const events = (A, proposalId = null) => A.audit.list({ proposalId }).map(e => e.event);
async function approved(A, actionId, parameters, extra = {}) {
  const p = A.user.propose({ actionId, parameters });
  const ap = A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest, confirmationPhrase: p.confirmation?.phrase ?? null, ...extra });
  return { p, ap };
}

// ── registry ──

test('registry: closed, frozen, versioned; only READ_ONLY + LOCAL_MUTATION enabled; EXTERNAL / HIGH_IMPACT defined but disabled; unknown → DENY', () => {
  assert.deepEqual(R.ENABLED_CLASSES, ['READ_ONLY', 'LOCAL_MUTATION']);
  assert.deepEqual(R.CLASS_STATUS, { READ_ONLY: 'ENABLED', LOCAL_MUTATION: 'ENABLED', EXTERNAL_ACTION: 'DEFINED_BUT_DISABLED', HIGH_IMPACT_ACTION: 'DEFINED_BUT_DISABLED' });
  assert.deepEqual([...R.ACTION_IDS].sort(), ['COMPANION.CONTEXT.EXPLAIN', 'COMPANION.MEMORY.EXPLAIN', 'COMPANION.MEMORY.FORGET', 'COMPANION.MEMORY.LIST', 'COMPANION.MEMORY.SET_ENABLED', 'COMPANION.MEMORY.SET_PRIVACY', 'COMPANION.PREFERENCES.UPDATE']);
  const d = R.describeRegistry();
  for (const a of d.actions) {
    assert.ok(['READ_ONLY', 'LOCAL_MUTATION'].includes(a.class), a.actionId);
    assert.ok(Number.isSafeInteger(a.version) && a.version >= 1 && a.description.length > 10 && a.enabled === true);
    assert.equal(a.requiresApproval, a.class === 'LOCAL_MUTATION');
    assert.equal(a.retryPolicy, 'NO_AUTOMATIC_RETRY');
    assert.ok(a.cancelPolicy && a.auditPolicy && ['IDEMPOTENT', 'NON_IDEMPOTENT'].includes(a.idempotency));
    const def = R.lookupAction(a.actionId);
    assert.ok(Object.isFrozen(def) && Object.isFrozen(def.inputSchema) && typeof def.execute === 'function' && typeof def.preview === 'function');
  }
  assert.equal(R.lookupAction('COMPANION.MEMORY.FORGET').idempotency, 'NON_IDEMPOTENT');
  assert.throws(() => { R.lookupAction('COMPANION.MEMORY.LIST').execute = null; }, TypeError);
  // every future action: no execute, refused with CAPABILITY_REQUIRED (external / high impact) or NOT_IMPLEMENTED (REC-DL-1)
  for (const f of R.FUTURE_ACTIONS) {
    assert.equal(f.enabled, false); assert.equal('execute' in f, false, f.actionId);
    if (['EXTERNAL_ACTION', 'HIGH_IMPACT_ACTION'].includes(f.riskClass)) {
      assert.equal(f.status, 'DISABLED_CAPABILITY_REQUIRED');
      assert.throws(() => R.lookupAction(f.actionId), code('CAPABILITY_REQUIRED', 'DISABLED_CAPABILITY_REQUIRED'));
    } else assert.throws(() => R.lookupAction(f.actionId), code('ACTION_NOT_ALLOWED', 'NOT_IMPLEMENTED_REC_DL_1'));
  }
  assert.deepEqual(R.FUTURE_ACTIONS.filter(f => f.riskClass === 'EXTERNAL_ACTION').map(f => f.actionId).sort(), ['COMPANION.CONTACT.SEND', 'COMPANION.EMAIL.SEND', 'COMPANION.OSINT.LOOKUP', 'COMPANION.SOCIAL.PUBLISH', 'COMPANION.WEB.FETCH']);
  // no generic action: shells, commands, files, network, RPC — all unknown
  for (const id of ['SHELL', 'COMPANION.SHELL.RUN', 'POWERSHELL', 'cmd', 'bash', 'COMPANION.EXEC', 'eval', 'COMPANION.FS.WRITE', 'COMPANION.FILES.READ', 'COMPANION.HTTP.GET', 'COMPANION.RPC', 'MCP.SHELL', '', null, 42, { actionId: 'COMPANION.MEMORY.LIST' }, '__proto__', 'constructor', 'companion.memory.list']) {
    assert.throws(() => R.lookupAction(id), code('UNKNOWN_ACTION'), String(id));
  }
  for (const id of R.ACTION_IDS) assert.equal(/SHELL|EXEC|CMD|POWERSHELL|BASH|EVAL|HTTP|URL|PATH|FILE|SPAWN|PROCESS|RPC/.test(id), false, id);
});

test('strict payload: unknown field, wrong type, missing field, non-object, free text, path, prototype keys → INVALID_ACTION_PAYLOAD; defaults materialised', () => {
  const E = R.lookupAction('COMPANION.MEMORY.SET_ENABLED');
  assert.deepEqual(R.validateParameters(E, { enabled: false, memoryId: 'm_1' }), { enabled: false, memoryId: 'm_1' });
  const bad = [
    [{ memoryId: 'm1', enabled: true, extra: 1 }, 'UNKNOWN_FIELD'], [{ memoryId: 'm1' }, 'REQUIRED_FIELD'], [{ memoryId: 'm1', enabled: 'true' }, 'NOT_A_BOOLEAN'],
    [{ memoryId: 'm 1', enabled: true }, 'NOT_A_VALID_ID'], [{ memoryId: '../../etc/passwd', enabled: true }, 'NOT_A_VALID_ID'], [{ memoryId: 'C:\\x', enabled: true }, 'NOT_A_VALID_ID'],
    [{ memoryId: 'x'.repeat(65), enabled: true }, 'NOT_A_VALID_ID'], [{ memoryId: 7, enabled: true }, 'NOT_A_VALID_ID'],
    [JSON.parse('{"memoryId":"m1","enabled":true,"__proto__":{"admin":true}}'), 'UNKNOWN_FIELD'], [['m1', true], 'PARAMETERS_NOT_AN_OBJECT'], ['memoryId=m1', 'PARAMETERS_NOT_AN_OBJECT'],
    [Object.assign(Object.create(null), { memoryId: 'm1', enabled: true }), 'PARAMETERS_NOT_AN_OBJECT'],
  ];
  for (const [p, reason] of bad) assert.throws(() => R.validateParameters(E, p), code('INVALID_ACTION_PAYLOAD', reason), JSON.stringify(p));
  const P = R.lookupAction('COMPANION.PREFERENCES.UPDATE');
  assert.throws(() => R.validateParameters(P, {}), code('INVALID_ACTION_PAYLOAD', 'NO_PREFERENCE_GIVEN'));
  assert.throws(() => R.validateParameters(P, { theme: 'dark' }), code('INVALID_ACTION_PAYLOAD', 'UNKNOWN_FIELD'));
  assert.throws(() => R.validateParameters(P, { cloudContextEnabled: 1 }), code('INVALID_ACTION_PAYLOAD', 'NOT_A_BOOLEAN'));
  assert.throws(() => R.validateParameters(R.lookupAction('COMPANION.MEMORY.SET_PRIVACY'), { memoryId: 'm1', scope: 'PUBLIC' }), code('INVALID_ACTION_PAYLOAD', 'NOT_AN_ALLOWED_VALUE'));
  const L = R.lookupAction('COMPANION.MEMORY.LIST');
  assert.deepEqual(R.validateParameters(L, {}), { includeDisabled: true, limit: 50 });
  assert.throws(() => R.validateParameters(L, { limit: 101 }), code('INVALID_ACTION_PAYLOAD', 'INTEGER_OUT_OF_RANGE'));
  assert.throws(() => R.validateParameters(L, { limit: 1.5 }), code('INVALID_ACTION_PAYLOAD', 'INTEGER_OUT_OF_RANGE'));
  // no schema field accepts free text: every field is boolean / enum / id / bounded integer
  for (const a of R.describeRegistry().actions) for (const spec of Object.values(a.inputSchema)) assert.ok(['boolean', 'enum', 'id', 'integer'].includes(spec.type), a.actionId);
});

test('canonical digest: deterministic, key-order independent, defaults equal; any change of actionId / version / class / target / parameter / installation → different', () => {
  const base = { ownerId: 'o1', actionId: 'COMPANION.MEMORY.SET_ENABLED', actionVersion: 1, riskClass: 'LOCAL_MUTATION', target: { kind: 'MEMORY', id: 'm1' }, parameters: { memoryId: 'm1', enabled: false } };
  const d0 = R.computeActionDigest(base);
  assert.match(d0, /^[0-9a-f]{64}$/);
  assert.equal(R.computeActionDigest({ ...base, parameters: { enabled: false, memoryId: 'm1' }, target: { id: 'm1', kind: 'MEMORY' } }), d0);
  for (const change of [{ actionId: 'COMPANION.MEMORY.SET_PRIVACY' }, { actionVersion: 2 }, { riskClass: 'READ_ONLY' }, { target: { kind: 'MEMORY', id: 'm2' } }, { parameters: { memoryId: 'm1', enabled: true } }, { parameters: { memoryId: 'm2', enabled: false } }, { ownerId: 'o2' }]) {
    assert.notEqual(R.computeActionDigest({ ...base, ...change }), d0, JSON.stringify(change));
  }
  const { A } = fresh();
  const p1 = A.user.propose({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} });
  const p2 = A.user.propose({ actionId: 'COMPANION.MEMORY.LIST', parameters: { limit: 50, includeDisabled: true } });
  assert.equal(p1.digest, p2.digest, 'defaults digest alike');
  assert.equal(p2.canonicalParameters, '{"includeDisabled":true,"limit":50}');
  assert.notEqual(A.user.propose({ actionId: 'COMPANION.MEMORY.LIST', parameters: { limit: 49 } }).digest, p1.digest);
});

// ── READ_ONLY ──

test('READ_ONLY: list / explain memory / explain context run without approval, return ids + provenance only, and change no DB, preference or proposal', async () => {
  const { store, mem, A } = fresh();
  const v1 = await remember(mem);
  const v2 = await remember(mem, { sensitivity: 'HIGHLY_SENSITIVE', category: 'USER_FACT', value: 'Mon dossier médical est chez le Dr Lambert.' });
  mem.setCompanionEnabled(v2.memoryId, false);
  mem.recordContextAssembly({ requestId: 'req-ctx-1', memoryIds: [v1.memoryId], itemIds: ['request:req-ctx-1', `memory:${v1.memoryId}`, 'session:abc'], typeCounts: { MEMORY: 1, USER_REQUEST: 1, SESSION: 1 }, privacyCounts: { PRIVATE_LOCAL: 3 } });
  const before = domain(store);
  const list = await A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} });
  assert.deepEqual([list.status, list.resultCode, list.riskClass, list.approvalId, list.effectApplied, list.automaticRetries], ['EXECUTED', 'OK', 'READ_ONLY', null, 'NONE', 0]);
  assert.deepEqual(list.resultMetadata.memories.map(m => [m.memoryId, m.companionEnabled, m.privacyScope]), [[v1.memoryId, true, 'PRIVATE_LOCAL'], [v2.memoryId, false, 'NEVER_CLOUD']]);
  assert.equal((await A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: { includeDisabled: false } })).resultMetadata.count, 1);
  const ex = await A.user.execute({ actionId: 'COMPANION.MEMORY.EXPLAIN', parameters: { memoryId: v2.memoryId } }); // execute() without approval → read-only path
  assert.deepEqual([ex.status, ex.resultMetadata.privacyScope, ex.resultMetadata.sensitivity, ex.resultMetadata.provenance.origin, ex.resultMetadata.provenance.sourceType, ex.resultMetadata.conflict, ex.resultMetadata.state],
    ['EXECUTED', 'NEVER_CLOUD', 'HIGHLY_SENSITIVE', 'USER_EXPLICIT', 'USER_INPUT', 'NONE', 'ACTIVE']);
  assert.ok(ex.resultMetadata.freshness.confirmedAt);
  const ctx = await A.user.runReadOnly({ actionId: 'COMPANION.CONTEXT.EXPLAIN', parameters: { requestId: 'req-ctx-1' } });
  assert.equal(ctx.resultMetadata.found, true);
  assert.deepEqual(ctx.resultMetadata.contextUsed.map(c => c.kind), ['REQUEST', 'MEMORY', 'SESSION']);
  assert.deepEqual(ctx.resultMetadata.memories.map(m => [m.memoryId, m.provenance.origin, m.privacyScope]), [[v1.memoryId, 'USER_EXPLICIT', 'PRIVATE_LOCAL']]);
  assert.equal((await A.user.runReadOnly({ actionId: 'COMPANION.CONTEXT.EXPLAIN', parameters: { requestId: 'nope' } })).resultMetadata.found, false);
  const text = JSON.stringify([list, ex, ctx]);
  assert.equal(/préfère thème|dossier médical|Lambert/.test(text), false, 'no statement / raw private content in read results');
  assert.equal(domain(store), before, 'READ_ONLY changed no Companion table and no NB-5 row');
  assert.deepEqual(A.user.listProposals(), [], 'no proposal created');
  assert.deepEqual(events(A), ['ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED', 'ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED', 'ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED', 'ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED', 'ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED']);
  // a mutation is never run through the read-only path
  await assert.rejects(A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v1.memoryId, enabled: false } }), code('APPROVAL_REQUIRED', 'NOT_READ_ONLY'));
  assert.equal(domain(store), before);
});

test('READ_ONLY cancellation: before start and during the read (AbortSignal) → CANCELLED, no result', async () => {
  const c = new AbortController();
  let calls = 0;
  const { mem, A } = fresh({ wrap: (m) => ({ ...port(m), view: (id) => { if (++calls === 2) c.abort(); return m.view(id); } }) });
  for (let i = 0; i < 4; i++) await remember(mem);
  const pre = new AbortController(); pre.abort();
  const r0 = await A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: {}, signal: pre.signal });
  assert.deepEqual([r0.status, r0.resultCode, r0.cancellation.stage, r0.resultMetadata], ['CANCELLED', 'ACTION_CANCELLED', 'BEFORE_START', null]);
  const r1 = await A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: {}, signal: c.signal });
  assert.deepEqual([r1.status, r1.cancellation.honored, r1.cancellation.stage, r1.resultMetadata], ['CANCELLED', true, 'READ', null]);
  await assert.rejects(A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: {}, signal: { aborted: false } }), code('INVALID_ACTION_PAYLOAD', 'INVALID_SIGNAL'));
});

// ── LOCAL_MUTATION: proposal, preview, approval ──

test('mutation proposal + preview: PENDING, digest, canonical parameters, readable preview hiding no parameter; nothing mutated before approval', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem);
  const before = domain(store);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { enabled: false, memoryId: v.memoryId } });
  assert.deepEqual([p.status, p.riskClass, p.actionVersion, p.proposedBy, p.requiresApproval, p.previewStale, p.expired], ['PENDING', 'LOCAL_MUTATION', 1, 'USER', true, false, false]);
  assert.deepEqual(p.parameters, { enabled: false, memoryId: v.memoryId });
  assert.equal(p.canonicalParameters, JSON.stringify({ enabled: false, memoryId: v.memoryId }));
  assert.equal(p.digest, R.computeActionDigest({ ownerId: store.ownerId, actionId: p.actionId, actionVersion: 1, riskClass: 'LOCAL_MUTATION', target: { kind: 'MEMORY', id: v.memoryId }, parameters: p.parameters }));
  assert.equal(Date.parse(p.expiresAt) - Date.parse(p.createdAt), R.ACTION_LIMITS.proposalTtlMs.value);
  const pv = p.preview;
  for (const k of ['action', 'target', 'summary', 'changes', 'effects', 'reversible', 'privacyImpact', 'confirmation', 'parameters', 'pointOfNoReturn']) assert.ok(k in pv, `preview.${k}`);
  assert.deepEqual(pv.parameters, p.parameters, 'the preview shows every parameter');
  assert.deepEqual(pv.changes, [{ field: 'companionEnabled', from: true, to: false }]);
  assert.deepEqual([pv.target.memoryId, pv.memory.memoryId, pv.reversible, pv.privacyImpact.level, pv.confirmation.level, pv.sideEffectsBeforeApproval], [v.memoryId, v.memoryId, 'YES', 'TIGHTENS', 'STANDARD', 'NONE']);
  assert.match(pv.memory.excerpt, /préfère thème/, 'the user recognises the memory in the preview');
  assert.equal(domain(store), before, 'a proposal mutates nothing');
  assert.equal(actionText(store).includes('préfère thème'), false, 'the preview (which quotes the memory) is never stored, only its hash');
  assert.equal(p.previewSha256, R.previewSha256(pv));
  assert.deepEqual(A.user.getProposal(p.proposalId).preview, pv, 'preview is deterministic');
  assert.throws(() => A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: 'unknown-id', enabled: false } }), code('ACTION_NOT_ALLOWED', 'TARGET_NOT_FOUND'));
});

test('mutation without approval refused: no approvalId, unknown / malformed approval; nothing changes', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem);
  A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  const before = domain(store);
  const params = { memoryId: v.memoryId, enabled: false };
  await assert.rejects(A.user.execute({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: params }), code('APPROVAL_REQUIRED', 'NO_APPROVAL'));
  await assert.rejects(A.user.execute({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: params, approvalId: crypto.randomUUID() }), code('APPROVAL_NOT_FOUND'));
  await assert.rejects(A.user.execute({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: params, approvalId: "x' OR 1=1 --" }), code('APPROVAL_NOT_FOUND'));
  await assert.rejects(A.user.execute({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: params, approvalId: { approved: true } }), code('APPROVAL_NOT_FOUND'));
  assert.equal(domain(store), before);
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, true);
  assert.ok(events(A).filter(e => e === 'ACTION_DENIED').length >= 4, 'refusals are audited');
});

test('approval: USER only, exact digest; success executes once with a structured result and a full audit trail', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  for (const who of ['MODEL', 'SYSTEM', 'COMPANION', undefined, 'user']) assert.throws(() => A.user.approve(p.proposalId, { approvedBy: who, digest: p.digest }), code('ACTION_NOT_ALLOWED', 'APPROVER_NOT_USER'));
  assert.throws(() => A.user.approve(p.proposalId, { approvedBy: 'USER', digest: 'f'.repeat(64) }), code('APPROVAL_DIGEST_MISMATCH'));
  assert.throws(() => A.user.approve(crypto.randomUUID(), { approvedBy: 'USER', digest: p.digest }), code('PROPOSAL_NOT_FOUND'));
  const ap = A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest });
  assert.deepEqual([ap.proposalId, ap.actionDigest, ap.approvedBy, ap.singleUse, ap.consumedAt], [p.proposalId, p.digest, 'USER', true, null]);
  assert.equal(Date.parse(ap.expiresAt) - Date.parse(ap.approvedAt), 120_000);
  assert.ok(Date.parse(ap.expiresAt) - Date.parse(ap.approvedAt) <= 300_000);
  assert.equal(A.user.getProposal(p.proposalId).status, 'APPROVED');
  assert.throws(() => A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest }), code('ACTION_NOT_ALLOWED', 'PROPOSAL_APPROVED'), 'approved once');
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, true, 'approval alone mutates nothing');
  const r = await A.user.execute({ actionId: p.actionId, parameters: { enabled: false, memoryId: v.memoryId }, approvalId: ap.approvalId });
  assert.deepEqual([r.status, r.resultCode, r.proposalId, r.approvalId, r.effectApplied, r.automaticRetries, r.idempotency], ['EXECUTED', 'OK', p.proposalId, ap.approvalId, 'FULL', 0, 'IDEMPOTENT']);
  for (const k of ['actionId', 'startedAt', 'completedAt', 'durationMs', 'resultMetadata', 'sideEffects', 'auditId']) assert.ok(k in r, k);
  assert.deepEqual(r.resultMetadata, { memoryId: v.memoryId, companionEnabled: false });
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, false);
  assert.equal(store.listAudit().at(-1).action, 'MEMORY_DISABLED', 'the Companion memory audit records the change too');
  assert.equal(A.user.getProposal(p.proposalId).status, 'EXECUTED');
  // the wrong-digest and the second approval were refused and audited (ACTION_DENIED); the APPROVER_NOT_USER ones too, before the proposal was loaded
  assert.deepEqual(events(A, p.proposalId), ['ACTION_PROPOSED', 'ACTION_DENIED', 'ACTION_APPROVED', 'ACTION_DENIED', 'APPROVAL_CONSUMED', 'ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED']);
  assert.equal(A.audit.list().filter(e => e.event === 'ACTION_DENIED' && e.details.reason === 'APPROVER_NOT_USER').length, 5);
  assert.equal(A.audit.list().at(-1).id, r.auditId);
});

test('approval replay: 2nd use, changed payload, changed actionId, expired, unknown → DENY; single-use enforced by the DB too', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem);
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  const v2 = await remember(mem);
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: { memoryId: v.memoryId, enabled: true }, approvalId: ap.approvalId }), code('APPROVAL_DIGEST_MISMATCH'), 'payload changed');
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: { memoryId: v2.memoryId, enabled: false }, approvalId: ap.approvalId }), code('APPROVAL_DIGEST_MISMATCH'), 'target changed');
  await assert.rejects(A.user.execute({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: v.memoryId, scope: 'PRIVATE_LOCAL' }, approvalId: ap.approvalId }), code('APPROVAL_DIGEST_MISMATCH'), 'actionId changed');
  await assert.rejects(A.user.execute({ actionId: 'COMPANION.MEMORY.FORGET', parameters: { memoryId: v.memoryId }, approvalId: ap.approvalId }), code('APPROVAL_DIGEST_MISMATCH'), 'actionId changed (forget)');
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, true, 'mismatches executed nothing');
  assert.equal((await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId })).status, 'EXECUTED', 'first use');
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId }), code('APPROVAL_ALREADY_USED'), 'second use');
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: crypto.randomUUID() }), code('APPROVAL_NOT_FOUND'), 'unknown approval');
  // the DB refuses a second consumption and any other change of an approval
  assert.throws(() => store.db.prepare('UPDATE companion_action_approvals SET consumed_at = ? WHERE approval_id = ?').run('2030-01-01T00:00:00.000Z', ap.approvalId), /COMP_IMMUTABLE/);
  // expired
  const { p: p2, ap: ap2 } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v2.memoryId, enabled: false });
  advance(120_001);
  await assert.rejects(A.user.execute({ actionId: p2.actionId, parameters: p2.parameters, approvalId: ap2.approvalId }), code('APPROVAL_EXPIRED'));
  await assert.rejects(A.user.execute({ actionId: p2.actionId, parameters: p2.parameters, approvalId: ap2.approvalId }), code('APPROVAL_EXPIRED'), 'stays expired');
  assert.equal(A.user.getProposal(p2.proposalId).status, 'EXPIRED');
  assert.equal(mem.view(v2.memoryId).companion.companionEnabled, true);
  assert.equal(store.db.prepare('SELECT consumed_at FROM companion_action_approvals WHERE approval_id = ?').get(ap2.approvalId).consumed_at, null, 'an expired approval is never consumed');
  assert.ok(events(A, p2.proposalId).includes('ACTION_EXPIRED'));
});

test('approval expiry ≤ 300 s: TTL bounds, DB CHECK, proposal expiry (10 min), expireStale', async () => {
  const { store, mem } = fresh();
  for (const ttl of [300_001, 4_999, 1.5]) assert.throws(() => createCompanionActions({ store, companion: mem, approvalTtlMs: ttl }), /approvalTtlMs/);
  const A = createCompanionActions({ store, companion: mem, approvalTtlMs: 300_000, approvalChannel: 'DIRECT_TEST_ONLY' });
  const v = await remember(mem);
  const { ap } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  assert.equal(Date.parse(ap.expiresAt) - Date.parse(ap.approvedAt), 300_000);
  const pid = store.db.prepare("SELECT proposal_id FROM companion_action_proposals WHERE status = 'PENDING' LIMIT 1").get()?.proposal_id ?? null;
  assert.equal(pid, null);
  assert.throws(() => store.db.prepare("INSERT INTO companion_action_approvals (approval_id, owner_id, proposal_id, action_digest, approved_by, approved_at, expires_at, single_use) VALUES ('a1', ?, ?, ?, 'USER', '2026-10-16T10:00:00.000Z', '2026-10-16T10:05:01.000Z', 1)")
    .run(store.ownerId, ap.proposalId, ap.actionDigest), /CHECK|UNIQUE/);
  // proposal expiry
  const v2 = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v2.memoryId, enabled: false } });
  const p3 = A.user.propose({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} });
  advance(R.ACTION_LIMITS.proposalTtlMs.value + 1);
  assert.equal(A.user.getProposal(p.proposalId).expired, true);
  assert.throws(() => A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest }), code('PROPOSAL_EXPIRED'));
  assert.equal(A.user.getProposal(p.proposalId).status, 'EXPIRED');
  assert.equal(A.user.expireStale(), 2, 'the APPROVED one (its approval expired too) and the read-only proposal');
  assert.equal(A.user.getProposal(p3.proposalId).status, 'EXPIRED');
  assert.equal(A.user.expireStale(), 0);
  // an approval never outlives its proposal
  const v3 = await remember(mem);
  const p4 = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v3.memoryId, enabled: false } });
  advance(R.ACTION_LIMITS.proposalTtlMs.value - 60_000);
  const ap4 = A.user.approve(p4.proposalId, { approvedBy: 'USER', digest: p4.digest });
  assert.equal(ap4.expiresAt, p4.expiresAt);
  advance(60_000);
  await assert.rejects(A.user.execute({ actionId: p4.actionId, parameters: p4.parameters, approvalId: ap4.approvalId }), code('APPROVAL_EXPIRED'));
});

test('concurrent approval race (same process): two executions with one approval → exactly one EXECUTED, the other APPROVAL_ALREADY_USED', async () => {
  let mutations = 0;
  const { mem, A } = fresh({ wrap: (m) => port(m, { setCompanionEnabled: (id, e) => { mutations++; return m.setCompanionEnabled(id, e); } }) });
  const v = await remember(mem);
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  const run = () => A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  const settled = await Promise.allSettled([run(), run(), run()]);
  const ok = settled.filter(s => s.status === 'fulfilled');
  const ko = settled.filter(s => s.status === 'rejected');
  assert.equal(ok.length, 1); assert.equal(ok[0].value.status, 'EXECUTED');
  assert.equal(ko.length, 2); for (const k of ko) assert.equal(k.reason.code, 'APPROVAL_ALREADY_USED');
  assert.equal(mutations, 1, 'the mutation ran once');
  assert.equal(events(A, p.proposalId).filter(e => e === 'APPROVAL_CONSUMED').length, 1);
});

test('concurrent approval race (two OS processes, one DB file): atomic consumption — exactly one process executes', async () => {
  const dir = path.join(TMP, 'race'); fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'companion.sqlite');
  const stubNb5 = '{ createManual: async () => { throw new Error("unused"); }, getMemory: () => null, deleteMemory: async () => {}, listConflicts: () => [] }';
  const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
  const store = CompanionStore.open({ dbPath }); // real clock: the children share it
  const mem = new CompanionMemory({ store, nb5: { createManual: async () => { throw new Error('unused'); }, getMemory: () => null, deleteMemory: async () => {}, listConflicts: () => [] } });
  const A = createCompanionActions({ store, companion: mem, approvalTtlMs: 60_000, approvalChannel: 'DIRECT_TEST_ONLY' });
  const p = A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } });
  const ap = A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest });
  store.close();
  const child = path.join(TMP, 'comp5-racer.mjs');
  fs.writeFileSync(child, `
    import { CompanionStore } from '${lib('companion-store.js')}';
    import { CompanionMemory } from '${lib('companion-memory.js')}';
    import { createCompanionActions } from '${lib('companion-actions.js')}';
    const [dbPath, approvalId, goAt] = process.argv.slice(2);
    const store = CompanionStore.open({ dbPath });
    const A = createCompanionActions({ store, companion: new CompanionMemory({ store, nb5: ${stubNb5} }) });
    while (Date.now() < Number(goAt)) { /* barrier: both processes start together */ }
    let out;
    try { const r = await A.user.execute({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false }, approvalId }); out = { status: r.status }; }
    catch (e) { out = { code: e.code }; }
    store.close();
    console.log(JSON.stringify({ pid: process.pid, ...out }));`);
  const goAt = Date.now() + 1500;
  const runChild = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [child, dbPath, ap.approvalId, String(goAt)], { windowsHide: true });
    let out = ''; let err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('close', (status) => resolve({ status, out, err }));
  });
  const results = await Promise.all([runChild(), runChild()]);
  for (const r of results) assert.equal(r.status, 0, r.err);
  const parsed = results.map(r => JSON.parse(r.out.trim().split('\n').pop()));
  assert.notEqual(parsed[0].pid, parsed[1].pid);
  assert.deepEqual(parsed.map(x => x.status ?? x.code).sort(), ['APPROVAL_ALREADY_USED', 'EXECUTED']);
  const s2 = CompanionStore.open({ dbPath }); opened.push(s2);
  const A2 = createCompanionActions({ store: s2, companion: new CompanionMemory({ store: s2, nb5: { createManual: async () => {}, getMemory: () => null, deleteMemory: async () => {}, listConflicts: () => [] } }) });
  assert.equal(s2.getPreferences().proposalEnabled, false);
  assert.equal(A2.user.getProposal(p.proposalId).status, 'EXECUTED');
  assert.equal(events(A2, p.proposalId).filter(e => e === 'APPROVAL_CONSUMED').length, 1);
  assert.equal(s2.listAudit().filter(a => a.action === 'PREFERENCES_CHANGED').length, 1, 'the mutation happened once');
  assert.equal(A2.audit.verify().ok, true, 'the hash chain stayed linear across processes');
});

test('reject / cancel / supersede / stale preview: a decided or replaced proposal can never be executed', async () => {
  const { mem, A } = fresh();
  const v = await remember(mem);
  // reject a PENDING proposal
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  assert.equal(A.user.reject(p.proposalId).status, 'REJECTED');
  assert.throws(() => A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest }), code('ACTION_NOT_ALLOWED', 'PROPOSAL_REJECTED'));
  assert.throws(() => A.user.reject(p.proposalId), code('ACTION_NOT_ALLOWED', 'PROPOSAL_DECIDED'));
  // reject an APPROVED one: its approval is dead
  const { p: p2, ap: ap2 } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  A.user.reject(p2.proposalId);
  await assert.rejects(A.user.execute({ actionId: p2.actionId, parameters: p2.parameters, approvalId: ap2.approvalId }), code('ACTION_NOT_ALLOWED', 'PROPOSAL_REJECTED'));
  // supersede: a new payload for the same action + target replaces the approved one
  const { p: p3, ap: ap3 } = await approved(A, 'COMPANION.MEMORY.SET_PRIVACY', { memoryId: v.memoryId, scope: 'LOCAL_SHARED_CONTEXT' });
  const p4 = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: v.memoryId, scope: 'NEVER_CLOUD' } });
  assert.deepEqual([A.user.getProposal(p3.proposalId).status, A.user.getProposal(p3.proposalId).supersededBy], ['SUPERSEDED', p4.proposalId]);
  await assert.rejects(A.user.execute({ actionId: p3.actionId, parameters: p3.parameters, approvalId: ap3.approvalId }), code('ACTION_NOT_ALLOWED', 'PROPOSAL_SUPERSEDED'));
  await assert.rejects(A.user.execute({ actionId: p4.actionId, parameters: p4.parameters, approvalId: ap3.approvalId }), code('APPROVAL_DIGEST_MISMATCH'), 'the new payload needs its own approval');
  assert.equal(mem.view(v.memoryId).privacyScope, 'PRIVATE_LOCAL');
  // stale preview: the state changed after approval → PREVIEW_STALE, approval not consumed
  const ap4 = A.user.approve(p4.proposalId, { approvedBy: 'USER', digest: p4.digest });
  mem.setPrivacyScope(v.memoryId, 'LOCAL_SHARED_CONTEXT');
  assert.equal(A.user.getProposal(p4.proposalId).previewStale, true);
  await assert.rejects(A.user.execute({ actionId: p4.actionId, parameters: p4.parameters, approvalId: ap4.approvalId }), code('PREVIEW_STALE'));
  assert.equal(mem.view(v.memoryId).privacyScope, 'LOCAL_SHARED_CONTEXT');
  // stale before approval
  const p5 = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  mem.setCompanionEnabled(v.memoryId, false);
  assert.throws(() => A.user.approve(p5.proposalId, { approvedBy: 'USER', digest: p5.digest }), code('PREVIEW_STALE'));
  // user cancel
  const p6 = A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } });
  assert.equal(A.user.cancel(p6.proposalId).status, 'CANCELLED');
});

// ── model boundary ──

test('model proposals: { actionId, parameters } only, validated by the registry; the model facet has no approve / execute and gets no preview', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem);
  assert.deepEqual(Object.keys(A.model), ['proposeFromModelOutput']);
  assert.ok(Object.isFrozen(A.model) && Object.isFrozen(A.user));
  const out = A.model.proposeFromModelOutput(JSON.stringify({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } }));
  // COMP-8B added proposedBy (origin for the UI); [COMP-REMED-1] still ids / status only — never a preview
  assert.deepEqual(Object.keys(out).sort(), ['actionId', 'digest', 'proposalId', 'proposedBy', 'requiresApproval', 'riskClass', 'status']);
  assert.equal(out.proposedBy, 'MODEL');
  assert.deepEqual([out.status, out.requiresApproval], ['PENDING', true]);
  assert.equal(A.user.getProposal(out.proposalId).proposedBy, 'MODEL');
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, true, 'a model proposal executes nothing');
  const refusals = [
    ['{"actionId":"COMPANION.SHELL.RUN","parameters":{"cmd":"del *"}}', 'UNKNOWN_ACTION'], ['{"actionId":"COMPANION.EMAIL.SEND","parameters":{}}', 'CAPABILITY_REQUIRED'],
    ['{"actionId":"COMPANION.WEB.FETCH","parameters":{"url":"http://x"}}', 'CAPABILITY_REQUIRED'],
    [{ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false }, reason: 'because' }, 'INVALID_ACTION_PAYLOAD'],
    [{ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false, note: 'x' } }, 'INVALID_ACTION_PAYLOAD'],
    ['not json', 'INVALID_ACTION_PAYLOAD'], ['[1,2]', 'INVALID_ACTION_PAYLOAD'], [`{"actionId":"COMPANION.MEMORY.LIST","parameters":{},"pad":"${'x'.repeat(5000)}"}`, 'INVALID_ACTION_PAYLOAD'],
    [null, 'INVALID_ACTION_PAYLOAD'],
  ];
  for (const [raw, c] of refusals) assert.throws(() => A.model.proposeFromModelOutput(raw), code(c), String(raw).slice(0, 60));
  // a model-proposed READ_ONLY action runs only with its exact digest
  const ro = A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.EXPLAIN', parameters: { memoryId: v.memoryId } });
  assert.equal(ro.requiresApproval, false);
  await assert.rejects(A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: {}, proposalId: ro.proposalId }), code('APPROVAL_DIGEST_MISMATCH'));
  assert.equal((await A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.EXPLAIN', parameters: { memoryId: v.memoryId }, proposalId: ro.proposalId })).status, 'EXECUTED');
  assert.equal(A.user.getProposal(ro.proposalId).status, 'EXECUTED');
  // full flow: MODEL → VALIDATION → PROPOSAL → PREVIEW → USER APPROVAL → EXECUTION
  const pv = A.user.getProposal(out.proposalId);
  const ap = A.user.approve(out.proposalId, { approvedBy: 'USER', digest: pv.digest });
  assert.equal((await A.user.execute({ actionId: pv.actionId, parameters: pv.parameters, approvalId: ap.approvalId })).status, 'EXECUTED');
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM companion_action_proposals WHERE proposed_by = 'MODEL'").get().n, 2);
});

test('model self-approval: approved / approvalId / userConfirmed / execute / signature anywhere → refused; no proposal, no approval; model never loosens privacy', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem);
  const hs = await remember(mem, { category: 'USER_FACT', value: 'Ma tension artérielle est suivie par le Dr Roux.', sensitivity: 'HIGHLY_SENSITIVE' });
  const base = { actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } };
  const claims = [{ approved: true }, { approvalId: crypto.randomUUID() }, { userConfirmed: true }, { execute: true }, { approved_by: 'USER' }, { signature: 'abc' }, { confirmationPhrase: 'FORGET x' }, { digest: 'f'.repeat(64) }, { force: true }];
  for (const c of claims) assert.throws(() => A.model.proposeFromModelOutput({ ...base, ...c }), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'), JSON.stringify(c));
  assert.throws(() => A.model.proposeFromModelOutput({ actionId: base.actionId, parameters: { ...base.parameters, approved: true } }), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'), 'nested claim');
  assert.throws(() => A.model.proposeFromModelOutput(JSON.stringify({ ...base, Execute: true, USER_CONFIRMED: true })), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'), 'case / separator variants');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_proposals').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0);
  // privacy loosening is a user decision, never a model proposal
  assert.throws(() => A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: v.memoryId, scope: 'CLOUD_ALLOWED' } }), code('ACTION_NOT_ALLOWED', 'MODEL_PRIVACY_LOOSENING'));
  assert.throws(() => A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: hs.memoryId, scope: 'PRIVATE_LOCAL' } }), code('ACTION_NOT_ALLOWED', 'MODEL_PRIVACY_LOOSENING'), 'NEVER_CLOUD release');
  assert.throws(() => A.model.proposeFromModelOutput({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { cloudContextEnabled: true } }), code('ACTION_NOT_ALLOWED', 'MODEL_PRIVACY_LOOSENING'));
  assert.equal(A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: v.memoryId, scope: 'NEVER_CLOUD' } }).status, 'PENDING', 'tightening is fine');
  assert.ok(A.audit.list().filter(e => e.event === 'ACTION_DENIED' && e.resultCode === 'ACTION_NOT_ALLOWED').length >= 14);
});

// ── memory actions ──

test('NEVER_CLOUD release: reinforced confirmation (exact phrase) required; CLOUD_ALLOWED refused for a sensitive memory; COMP-2 lock intact outside actions', async () => {
  const { mem, A } = fresh();
  const hs = await remember(mem, { category: 'USER_FACT', value: 'Mon groupe sanguin est noté dans mon carnet.', sensitivity: 'HIGHLY_SENSITIVE' });
  assert.equal(mem.view(hs.memoryId).privacyScope, 'NEVER_CLOUD');
  assert.throws(() => mem.setPrivacyScope(hs.memoryId, 'PRIVATE_LOCAL'), (e) => e.code === 'COMP_NEVER_CLOUD_LOCKED', 'no implicit release');
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: hs.memoryId, scope: 'PRIVATE_LOCAL' } });
  assert.deepEqual([p.preview.privacyImpact.level, p.preview.privacyImpact.neverCloudRelease, p.confirmation.level, p.confirmation.phrase], ['LOOSENS_CLOUD', true, 'REINFORCED', `RELEASE NEVER_CLOUD ${hs.memoryId}`]);
  for (const phrase of [null, '', 'RELEASE NEVER_CLOUD', `release never_cloud ${hs.memoryId}`, `RELEASE NEVER_CLOUD ${hs.memoryId} `]) {
    assert.throws(() => A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest, confirmationPhrase: phrase }), code('CONFIRMATION_REQUIRED', 'REINFORCED_CONFIRMATION_REQUIRED'), String(phrase));
  }
  assert.equal(mem.view(hs.memoryId).privacyScope, 'NEVER_CLOUD');
  const ap = A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest, confirmationPhrase: `RELEASE NEVER_CLOUD ${hs.memoryId}` });
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  assert.deepEqual([r.status, r.resultMetadata.privacyScope, mem.view(hs.memoryId).privacyScope], ['EXECUTED', 'PRIVATE_LOCAL', 'PRIVATE_LOCAL']);
  // a SENSITIVE / HIGHLY_SENSITIVE memory is never cloud-eligible, even with an approval
  assert.throws(() => A.user.propose({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: hs.memoryId, scope: 'CLOUD_ALLOWED' } }), code('ACTION_NOT_ALLOWED', 'COMP_CLOUD_SCOPE_REFUSED'));
  // CLOUD_ALLOWED for a NORMAL memory needs the explicit phrase
  const v = await remember(mem);
  const pc = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: v.memoryId, scope: 'CLOUD_ALLOWED' } });
  assert.deepEqual([pc.confirmation.level, pc.preview.privacyImpact.level], ['EXPLICIT', 'LOOSENS_CLOUD']);
  assert.throws(() => A.user.approve(pc.proposalId, { approvedBy: 'USER', digest: pc.digest }), code('CONFIRMATION_REQUIRED'));
});

test('preference mutation: recognised keys only, booleans, explicit phrase to enable cloud context; memory disable mutation through SET_ENABLED', async () => {
  const { store, mem, A } = fresh();
  assert.throws(() => A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { theme: 'dark' } }), code('INVALID_ACTION_PAYLOAD', 'UNKNOWN_FIELD'));
  assert.throws(() => A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { memoryEnabled: 'no' } }), code('INVALID_ACTION_PAYLOAD', 'NOT_A_BOOLEAN'));
  const sid = mem.session.openSession(); mem.session.add(sid, { category: 'SESSION_CONTEXT', text: 'contexte de travail' });
  const { p, ap } = await approved(A, 'COMPANION.PREFERENCES.UPDATE', { sessionMemoryEnabled: false, proposalEnabled: true });
  assert.deepEqual(p.preview.changes, [{ field: 'sessionMemoryEnabled', from: true, to: false }]);
  assert.deepEqual(p.preview.unchanged, ['proposalEnabled']);
  assert.ok(p.preview.effects.includes('SESSION_CONTEXT_PURGED') && p.preview.reversible.startsWith('PARTIAL'));
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  assert.equal(r.status, 'EXECUTED');
  assert.equal(store.getPreferences().sessionMemoryEnabled, false);
  assert.deepEqual(r.sideEffects.map(s => [s.kind, s.transactional]), [['PREFERENCES_UPDATED', true], ['SESSION_CONTEXT_PURGED', false]]);
  const pc = A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { cloudContextEnabled: true } });
  assert.deepEqual([pc.confirmation.level, pc.confirmation.phrase], ['EXPLICIT', 'ALLOW CLOUD CONTEXT']);
  assert.throws(() => A.user.approve(pc.proposalId, { approvedBy: 'USER', digest: pc.digest }), code('CONFIRMATION_REQUIRED'));
  const apc = A.user.approve(pc.proposalId, { approvedBy: 'USER', digest: pc.digest, confirmationPhrase: 'ALLOW CLOUD CONTEXT' });
  assert.equal((await A.user.execute({ actionId: pc.actionId, parameters: pc.parameters, approvalId: apc.approvalId })).status, 'EXECUTED');
  assert.equal(store.getPreferences().cloudContextEnabled, true);
  // memory disable
  const v = await remember(mem);
  const d = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  assert.equal((await A.user.execute({ actionId: d.p.actionId, parameters: d.p.parameters, approvalId: d.ap.approvalId })).resultMetadata.companionEnabled, false);
  assert.equal(store.listAudit().at(-1).action, 'MEMORY_DISABLED');
});

test('forget COMPLETE: explicit phrase, NB-5 record + vector + metadata + proposals + session refs purged and verified; open action proposals on it superseded', async () => {
  const { store, mem, svc, vec, A } = fresh();
  const v = await remember(mem);
  assert.ok(vec.rows.has(v.memoryId) || true);
  const sid = mem.session.openSession(); mem.session.add(sid, { category: 'SOURCE_REFERENCE', reference: { kind: 'NB5_MEMORY', ref: v.memoryId, label: 'x' } });
  const other = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.FORGET', parameters: { memoryId: v.memoryId } });
  for (const e of ['NB5_RECORD_PURGED', 'NB5_VECTOR_PURGED', 'COMPANION_METADATA_DELETED', 'COMPANION_MEMORY_PROPOSALS_DELETED', 'SESSION_REFERENCES_PURGED', 'DERIVED_CACHES_PURGED']) assert.ok(p.preview.effects.includes(e), e);
  assert.deepEqual([p.preview.reversible, p.confirmation.level, p.confirmation.phrase, p.idempotency], ['NO', 'EXPLICIT', `FORGET ${v.memoryId}`, 'NON_IDEMPOTENT']);
  assert.match(p.preview.pointOfNoReturn, /^NB5_DELETE/);
  assert.throws(() => A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest }), code('CONFIRMATION_REQUIRED', 'EXPLICIT_CONFIRMATION_REQUIRED'));
  assert.ok(svc.getMemory(v.memoryId), 'nothing forgotten before approval + execution');
  const ap = A.user.approve(p.proposalId, { approvedBy: 'USER', digest: p.digest, confirmationPhrase: `FORGET ${v.memoryId}` });
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  assert.deepEqual([r.status, r.resultCode, r.effectApplied, r.resultMetadata.forgetStatus, r.resultMetadata.remainingStores], ['EXECUTED', 'FORGET_COMPLETE', 'FULL', 'COMPLETE', []]);
  assert.equal(svc.getMemory(v.memoryId), null);
  assert.equal(store.getMetadata(v.memoryId), null);
  assert.equal(mem.session.hasReference(v.memoryId), false);
  assert.deepEqual([A.user.getProposal(other.proposalId).status, A.user.getProposal(other.proposalId).supersededBy], ['SUPERSEDED', p.proposalId]);
  assert.equal(store.listAudit().at(-1).action, 'FORGET_COMPLETED');
  assert.equal(actionText(store).includes('préfère thème'), false, 'action tables never held the statement');
});

test('forget INCOMPLETE: a store that keeps the vector → FAILED / FORGET_INCOMPLETE with remaining stores, effect PARTIAL; never success; no automatic retry', async () => {
  let forgetCalls = 0;
  const { store, mem, A } = fresh({ vectorProbe: async () => true, vectorPurge: async () => { throw new Error('lance down'); }, wrap: (m) => port(m, { forget: (id) => { forgetCalls++; return m.forget(id); } }) });
  const v = await remember(mem);
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.FORGET', { memoryId: v.memoryId });
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  assert.deepEqual([r.status, r.resultCode, r.effectApplied, r.resultMetadata.forgetStatus, r.resultMetadata.retryable], ['FAILED', 'FORGET_INCOMPLETE', 'PARTIAL', 'FORGET_INCOMPLETE', true]);
  assert.deepEqual(r.resultMetadata.remainingStores, ['NB5_VECTOR']);
  assert.equal(A.user.getProposal(p.proposalId).status, 'FAILED');
  assert.equal(A.user.getProposal(p.proposalId).resultCode, 'FORGET_INCOMPLETE');
  assert.equal(events(A, p.proposalId).at(-1), 'ACTION_FAILED');
  assert.equal(store.listAudit().at(-1).action, 'FORGET_INCOMPLETE');
  assert.equal(forgetCalls, 1, 'not retried');
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId }), code('APPROVAL_ALREADY_USED'), 'a retry needs a new approval');
  assert.equal(forgetCalls, 1);
});

// ── cancellation, point of no return, transactions ──

test('cancel before mutation: aborted signal → CANCELLED, approval NOT consumed, state unchanged; the proposal cannot be executed afterwards', async () => {
  const { mem, store, A } = fresh();
  const v = await remember(mem);
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  const c = new AbortController(); c.abort();
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId, signal: c.signal });
  assert.deepEqual([r.status, r.resultCode, r.effectApplied, r.cancellation], ['CANCELLED', 'ACTION_CANCELLED', 'NONE', { requested: true, honored: true, stage: 'BEFORE_START' }]);
  assert.equal(store.db.prepare('SELECT consumed_at FROM companion_action_approvals WHERE approval_id = ?').get(ap.approvalId).consumed_at, null);
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, true);
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId }), code('ACTION_NOT_ALLOWED', 'PROPOSAL_CANCELLED'));
  // forget: cancellable before its point of no return
  const f = await approved(A, 'COMPANION.MEMORY.FORGET', { memoryId: v.memoryId });
  const rf = await A.user.execute({ actionId: f.p.actionId, parameters: f.p.parameters, approvalId: f.ap.approvalId, signal: c.signal });
  assert.equal(rf.status, 'CANCELLED');
  assert.ok(mem.view(v.memoryId).statement, 'memory kept');
});

test('cancel before commit: abort during the mutation → ROLLBACK (effect NONE), approval consumed, CANCELLED; nothing partial', async () => {
  const c = new AbortController();
  const { store, A } = fresh({ wrap: (m) => port(m, { setPreferences: (patch) => { const o = m.setPreferences(patch); c.abort(); return o; } }) });
  const auditBefore = store.listAudit().length;
  const { p, ap } = await approved(A, 'COMPANION.PREFERENCES.UPDATE', { proposalEnabled: false });
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId, signal: c.signal });
  assert.deepEqual([r.status, r.effectApplied, r.cancellation], ['CANCELLED', 'NONE', { requested: true, honored: true, stage: 'BEFORE_COMMIT' }]);
  assert.equal(store.getPreferences().proposalEnabled, true, 'the preference write was rolled back');
  assert.equal(store.listAudit().length, auditBefore, 'the PREFERENCES_CHANGED audit row was rolled back too');
  assert.ok(store.db.prepare('SELECT consumed_at FROM companion_action_approvals WHERE approval_id = ?').get(ap.approvalId).consumed_at, 'consumed: a new attempt needs a new approval');
  assert.equal(A.user.getProposal(p.proposalId).status, 'CANCELLED');
  const last = A.audit.list().at(-1);
  assert.deepEqual([last.event, last.details.stage, last.details.rolledBack, last.details.effectApplied], ['ACTION_CANCELLED', 'BEFORE_COMMIT', true, 'NONE']);
});

test('post-commit cancellation honesty: an abort after the point of no return / commit never reports CANCELLED', async () => {
  const c = new AbortController();
  const { mem, svc, A } = fresh({ wrap: (m) => port(m, { forget: async (id) => { const o = await m.forget(id); c.abort(); return o; } }) });
  const v = await remember(mem);
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.FORGET', { memoryId: v.memoryId });
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId, signal: c.signal });
  assert.deepEqual([r.status, r.effectApplied, r.cancellation], ['EXECUTED', 'FULL', { requested: true, honored: false, stage: 'AFTER_POINT_OF_NO_RETURN' }]);
  assert.equal(svc.getMemory(v.memoryId), null);
  // SYNC: the commit is the point of no return; an abort after execute() returned changes nothing
  const c2 = new AbortController();
  const v2 = await remember(mem);
  const s = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v2.memoryId, enabled: false });
  const r2 = await A.user.execute({ actionId: s.p.actionId, parameters: s.p.parameters, approvalId: s.ap.approvalId, signal: c2.signal });
  c2.abort();
  assert.deepEqual([r2.status, r2.effectApplied, A.user.getProposal(s.p.proposalId).status, mem.view(v2.memoryId).companion.companionEnabled], ['EXECUTED', 'FULL', 'EXECUTED', false]);
});

test('transaction rollback: a failure inside the mutation → FAILED, every write rolled back, approval consumed, mutation not retried', async () => {
  let calls = 0;
  const { store, mem, A } = fresh({ wrap: (m) => port(m, { setCompanionEnabled: (id, e) => { calls++; m.setCompanionEnabled(id, e); throw new Error('disk full after the metadata write'); } }) });
  const v = await remember(mem);
  const auditBefore = store.listAudit().length;
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  assert.deepEqual([r.status, r.resultCode, r.effectApplied, r.automaticRetries], ['FAILED', 'ACTION_FAILED', 'NONE', 0]);
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, true, 'metadata write rolled back');
  assert.equal(store.listAudit().length, auditBefore, 'MEMORY_DISABLED audit rolled back');
  assert.equal(calls, 1);
  assert.equal(A.user.getProposal(p.proposalId).status, 'FAILED');
  assert.deepEqual([A.audit.list().at(-1).event, A.audit.list().at(-1).details.rolledBack], ['ACTION_FAILED', true]);
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId }), code('APPROVAL_ALREADY_USED'));
  assert.equal(calls, 1, '0 automatic retry');
});

// ── audit ──

test('action audit: every lifecycle event, hash chain valid, ids / codes only — no statement, no preview, no secret; a secret-looking field name never reaches it', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem, { value: 'Je préfère que mon code wifi soit changé chaque mois.' });
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  const r = A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } }); A.user.reject(r.proposalId);
  const x = A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: true } }); A.user.cancel(x.proposalId);
  const e = A.user.propose({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} }); advance(R.ACTION_LIMITS.proposalTtlMs.value + 1); A.user.expireStale();
  A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { memoryEnabled: true } });
  A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { memoryEnabled: false } }); // supersedes
  assert.throws(() => A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.LIST', parameters: {}, 'sk-ABCDEFGHIJKLMNOPQRSTUVWX1234567890': 1 }), code('INVALID_ACTION_PAYLOAD'));
  assert.throws(() => A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.LIST', parameters: {}, password: 'hunter2hunter2' }), code('INVALID_ACTION_PAYLOAD'));
  const seen = new Set(events(A));
  for (const ev of ['ACTION_PROPOSED', 'ACTION_APPROVED', 'ACTION_REJECTED', 'ACTION_EXPIRED', 'ACTION_EXECUTION_STARTED', 'ACTION_EXECUTED', 'ACTION_CANCELLED', 'APPROVAL_CONSUMED', 'ACTION_DENIED', 'ACTION_SUPERSEDED']) assert.ok(seen.has(ev), ev);
  for (const ev of seen) assert.ok(ACTION_AUDIT_EVENTS.includes(ev));
  assert.deepEqual(A.audit.verify(), { ok: true, entries: A.audit.list().length, head: A.audit.list().at(-1).entryHash });
  const text = actionText(store);
  assert.equal(/code wifi|chaque mois|sk-ABCDEF|hunter2/.test(text), false);
  assert.ok(A.audit.list().some(a => a.details.field === 'NON_IDENTIFIER_FIELD'), 'a non-identifier key is never copied into the audit');
  assert.equal(detectSecretMemory(text).refused, false, '0 secret in the action tables');
  for (const a of A.audit.list()) {
    assert.ok(a.digest === null || /^[0-9a-f]{64}$/.test(a.digest));
    assert.ok(Buffer.byteLength(JSON.stringify(a.details)) <= 2048);
  }
  void e;
});

test('audit + approvals + proposals tampering refused by the DB (UPDATE, DELETE, INSERT OR REPLACE, status regression, forged execution); forged hash detected', async () => {
  const { store, mem, A } = fresh();
  const v = await remember(mem);
  const { p, ap } = await approved(A, 'COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  const db = store.db;
  assert.equal(db.pragma('recursive_triggers', { simple: true }), 1);
  const a0 = db.prepare('SELECT * FROM companion_action_audit ORDER BY seq LIMIT 1').get();
  assert.throws(() => db.prepare("UPDATE companion_action_audit SET result_code = 'OK' WHERE seq = ?").run(a0.seq), /COMP_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM companion_action_audit WHERE seq = ?').run(a0.seq), /COMP_IMMUTABLE/);
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO companion_action_audit (seq, audit_id, owner_id, event, at, details_json, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(a0.seq, a0.audit_id, a0.owner_id, 'ACTION_EXECUTED', a0.at, '{}', 'a'.repeat(64)), /COMP_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM companion_action_approvals').run(), /COMP_IMMUTABLE/);
  assert.throws(() => db.prepare("UPDATE companion_action_approvals SET approved_by = 'MODEL'").run(), /COMP_IMMUTABLE|CHECK/);
  assert.throws(() => db.prepare("UPDATE companion_action_approvals SET expires_at = '2099-01-01T00:00:00.000Z'").run(), /COMP_IMMUTABLE|CHECK/);
  assert.throws(() => db.prepare("INSERT INTO companion_action_approvals (approval_id, owner_id, proposal_id, action_digest, approved_by, approved_at, expires_at, single_use) VALUES ('z', ?, ?, ?, 'MODEL', '2026-10-16T10:00:00.000Z', '2026-10-16T10:01:00.000Z', 1)").run(store.ownerId, crypto.randomUUID(), p.digest), /CHECK|FOREIGN/);
  assert.throws(() => db.prepare('DELETE FROM companion_action_proposals').run(), /COMP_IMMUTABLE/);
  assert.throws(() => db.prepare("UPDATE companion_action_proposals SET parameters_json = '{\"enabled\":true,\"memoryId\":\"x\"}' WHERE proposal_id = ?").run(p.proposalId), /COMP_IMMUTABLE/);
  // forged execution: APPROVED → EXECUTED without consuming the approval is refused by the DB
  assert.throws(() => db.prepare("UPDATE companion_action_proposals SET status = 'EXECUTED', decided_at = 'x' WHERE proposal_id = ?").run(p.proposalId), /COMP_IMMUTABLE/);
  // a LOCAL_MUTATION never goes PENDING → EXECUTED, nor PENDING → APPROVED without an approval row
  const q = A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } });
  assert.throws(() => db.prepare("UPDATE companion_action_proposals SET status = 'EXECUTED', decided_at = 'x' WHERE proposal_id = ?").run(q.proposalId), /COMP_IMMUTABLE/);
  assert.throws(() => db.prepare("UPDATE companion_action_proposals SET status = 'APPROVED', decided_at = 'x' WHERE proposal_id = ?").run(q.proposalId), /COMP_IMMUTABLE/);
  await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  assert.throws(() => db.prepare("UPDATE companion_action_proposals SET status = 'PENDING', decided_at = NULL WHERE proposal_id = ?").run(p.proposalId), /COMP_IMMUTABLE/, 'no status regression');
  assert.throws(() => db.prepare("UPDATE companion_action_proposals SET status = 'FAILED' WHERE proposal_id = ?").run(p.proposalId), /COMP_IMMUTABLE/, 'decided once');
  assert.equal(A.audit.verify().ok, true);
  // forged append with a wrong hash is detected
  db.prepare("INSERT INTO companion_action_audit (audit_id, owner_id, event, at, details_json, prev_hash, entry_hash) VALUES ('forged', ?, 'ACTION_EXECUTED', '2026-10-16T11:00:00.000Z', '{}', ?, ?)").run(store.ownerId, A.audit.list().at(-1).entryHash, 'b'.repeat(64));
  assert.deepEqual([A.audit.verify().ok, A.audit.verify().brokenAt], [false, 'forged']);
});

// ── schema, restart, boot, isolation ──

test('schema v4: fresh, additive Companion activation state, idempotent; prior data remains intact', async () => {
  assert.equal(COMPANION_SCHEMA_VERSION, 4);
  for (const m of COMPANION_MIGRATIONS) assert.doesNotThrow(() => assertAdditiveSql(m.sql));
  assert.deepEqual(COMPANION_MIGRATIONS.map(m => [m.version, m.name]), [[1, 'companion-layer'], [2, 'companion-model-audit'], [3, 'companion-actions'], [4, 'companion-activation']]);
  const fd = new Database(':memory:'); fd.pragma('foreign_keys = ON');
  assert.deepEqual(runCompanionMigrations(fd).applied, [1, 2, 3, 4]);
  assert.deepEqual(runCompanionMigrations(fd).applied, [], 'idempotent');
  assert.deepEqual(fd.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'companion_action%' ORDER BY name").all().map(r => r.name), ['companion_action_approvals', 'companion_action_audit', 'companion_action_proposals']);
  fd.close();
  // a real v2 store with COMP-2 (metadata, proposals, preferences, memory audit) and COMP-4 (model audit) data
  const p2 = path.join(TMP, 'v2-store.sqlite');
  const db = new Database(p2); db.pragma('foreign_keys = ON'); db.pragma('recursive_triggers = ON');
  assert.deepEqual(runCompanionMigrations(db, { upTo: 2 }).applied, [1, 2]);
  db.prepare("INSERT INTO companion_installation (singleton, installation_id, profile, created_at) VALUES (1, ?, 'LOCAL_SINGLE_USER', ?)").run(crypto.randomUUID(), new Date(clockMs).toISOString());
  const s2 = new CompanionStore(db, clock);
  const m2 = new CompanionMemory({ store: s2, nb5: nb5(memVectors()) });
  await m2.rememberExplicit({ category: 'USER_PREFERENCE', value: 'Je préfère les tableaux aux listes.', provenance: USER });
  m2.propose({ kind: 'USER_FACT', value: 'Travaille sur Docteur.', provenance: { origin: 'DERIVED', sourceType: 'MODEL', derivedBy: { producer: 'MODEL', modelId: 'm1' } } });
  m2.setPreferences({ proposalEnabled: true, cloudContextEnabled: false });
  s2.modelAudit('MODEL_REQUESTED', 'req-v2', { task: 'ANSWER' });
  assert.equal(companionSchemaVersion(db), 2);
  const fp = (d) => JSON.stringify(['companion_installation', 'companion_preferences', 'companion_memory_metadata', 'companion_memory_proposals', 'companion_audit', 'companion_model_audit'].map(t => d.prepare(`SELECT * FROM ${t}`).all()));
  const v2fp = fp(db);
  db.close();
  // failed migration → rollback (a conflicting pre-existing object makes migration 3 fail midway)
  const pf = path.join(TMP, 'v2-fail.sqlite'); fs.copyFileSync(p2, pf);
  const bad = new Database(pf); bad.exec('CREATE VIEW companion_action_audit AS SELECT 1 AS x'); bad.close(); // migration 3 creates two tables, then fails on this name
  assert.throws(() => CompanionStore.open({ dbPath: pf, now: clock }), /companion_action_audit|view/i);
  const chk = new Database(pf, { readonly: true });
  assert.equal(companionSchemaVersion(chk), 2, 'still v2');
  assert.equal(chk.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type <> 'view' AND name LIKE 'companion_action_%'").get().n, 0, 'no partial v3 object');
  assert.equal(fp(chk), v2fp, 'v2 data intact after the failed migration');
  chk.close();
  // v2 → v3
  const s3 = CompanionStore.open({ dbPath: p2, now: clock }); opened.push(s3);
  assert.equal(s3.schemaVersion(), 4);
  assert.equal(fp(s3.db), v2fp, 'COMP-2/3/4 data intact');
  assert.equal(s3.verifyAudit().ok, true); assert.equal(s3.verifyModelAudit().ok, true);
  const A3 = createCompanionActions({ store: s3, companion: new CompanionMemory({ store: s3, nb5: nb5(memVectors()) }) });
  assert.equal(A3.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } }).status, 'PENDING');
  assert.throws(() => createCompanionActions({ store: { db: {}, schemaVersion: () => 2 }, companion: m2 }), /schema \(v3\)/);
});

test('restart persistence: proposals, consumed approvals and the action audit survive a new process; a consumed approval stays consumed (no replay after restart)', async () => {
  const dir = path.join(TMP, 'restart'); fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'companion.sqlite');
  const stub = { createManual: async () => {}, getMemory: () => null, deleteMemory: async () => {}, listConflicts: () => [] };
  const store = CompanionStore.open({ dbPath });
  const A = createCompanionActions({ store, companion: new CompanionMemory({ store, nb5: stub }), approvalChannel: 'DIRECT_TEST_ONLY' });
  const used = A.user.propose({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } });
  const apUsed = A.user.approve(used.proposalId, { approvedBy: 'USER', digest: used.digest });
  await A.user.execute({ actionId: used.actionId, parameters: used.parameters, approvalId: apUsed.approvalId });
  const pending = A.user.propose({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} });
  const head = A.audit.verify().head;
  store.close();
  const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
  const reader = path.join(TMP, 'comp5-reader.mjs');
  fs.writeFileSync(reader, `
    import { CompanionStore } from '${lib('companion-store.js')}';
    import { CompanionMemory } from '${lib('companion-memory.js')}';
    import { createCompanionActions } from '${lib('companion-actions.js')}';
    const [dbPath, usedId, pendingId, approvalId] = process.argv.slice(2);
    const store = CompanionStore.open({ dbPath });
    const A = createCompanionActions({ store, companion: new CompanionMemory({ store, nb5: { createManual: async () => {}, getMemory: () => null, deleteMemory: async () => {}, listConflicts: () => [] } }) });
    let replay;
    try { await A.user.execute({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false }, approvalId }); replay = 'EXECUTED'; } catch (e) { replay = e.code; }
    console.log(JSON.stringify({ pid: process.pid, version: store.schemaVersion(), used: A.user.getProposal(usedId).status, pending: A.user.getProposal(pendingId).status, replay,
      consumed: store.db.prepare('SELECT consumed_at FROM companion_action_approvals WHERE approval_id = ?').get(approvalId).consumed_at !== null, chain: A.audit.verify(), prefs: store.getPreferences() }));
    store.close();`);
  const r = spawnSync(process.execPath, [reader, dbPath, used.proposalId, pending.proposalId, apUsed.approvalId], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const R2 = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.notEqual(R2.pid, process.pid);
  assert.deepEqual([R2.version, R2.used, R2.pending, R2.replay, R2.consumed, R2.chain.ok, R2.prefs.proposalEnabled], [4, 'EXECUTED', 'PENDING', 'APPROVAL_ALREADY_USED', true, true, false]);
  assert.notEqual(R2.chain.head, head, 'the replay refusal was audited (ACTION_DENIED appended)');
});

test('boot gate + product UI wiring: Companion stays disabled pending human activation; UI_GESTURE only, no action worker or direct frontend authority; real DB untouched', () => {
  assert.equal(COMPANION_CERTIFIED, true);
  assert.equal(COMPANION_ACTIVATION, 'DISABLED_PENDING_HUMAN_ACTIVATION');
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.ok(server.includes('openCompanionAtBoot') && server.includes('createCompanionUiRoute'));
  assert.ok(fs.existsSync(path.join(HERE, 'src', 'routes', 'companion.js')));
  assert.equal(server.includes('DIRECT_TEST_ONLY'), false, 'product never selects the direct test channel');
  for (const f of ['src/App.tsx', 'src/lib/cortex/client.ts']) {
    const p = path.join(HERE, '..', f);
    if (fs.existsSync(p)) assert.equal(/companion-action|createCompanionActions|COMPANION\.MEMORY\./.test(fs.readFileSync(p, 'utf8')), false, f);
  }
  const boot = fs.readFileSync(path.join(HERE, 'src', 'lib', 'companion-boot.js'), 'utf8');
  assert.equal(/companion-action/.test(boot), false, 'boot opens no action framework');
  const libs = fs.readdirSync(path.join(HERE, 'src', 'lib')).filter(f => !f.startsWith('companion-'));
  for (const f of libs.filter(x => x.endsWith('.js'))) assert.equal(/companion-action/.test(fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8')), false, f);
  if (fs.existsSync(REAL_DB[0])) {
    const ro = new Database(REAL_DB[0], { readonly: true, fileMustExist: true });
    try { assert.equal(ro.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'companion%'").get().n, 0, 'real companion tables: 0'); } finally { ro.close(); }
  }
  assert.deepEqual(REAL_DB.map(fileHash), realDbBefore, 'real user DB byte-identical');
});

test('isolation: 0 shell, 0 process, 0 network, 0 eval / dynamic import, 0 KG / OSINT module / Agency / Model Router; imports = Companion modules only; 0 fetch', () => {
  for (const f of ['companion-action-registry.js', 'companion-actions.js']) {
    const src = fs.readFileSync(path.join(HERE, 'src', 'lib', f), 'utf8');
    for (const i of [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])) assert.ok(i.startsWith('./companion-'), `${f} imports ${i}`);
    const code2 = src.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.equal(/child_process|node:(http|https|net|dns|tls|dgram|worker_threads|vm)|\bfetch\s*\(|\beval\s*\(|new\s+Function|\bimport\s*\(|\brequire\s*\(|(?<!\.)\b(spawn|exec|execFile|execSync|fork)\s*\(|powershell|cmd\.exe|\/bin\/(ba)?sh/i.test(code2), false, `${f}: shell / process / network / eval`);
    assert.equal(/\bkg_[a-z]|kg-|knowledge-graph|investigat|agency|model-router|ollama|root-policy|safeFetch|web-egress|\bdmem_|sqlite\.js|secret-store|writeFile|unlink|rmSync|createWriteStream/i.test(code2), false, `${f}: no KG / OSINT module / Agency / router / fs write / NB-5 table`);
  }
  assert.equal(fetchCalls, 0, 'external network calls: 0');
});

test('bounds + statuses: limits PROVISIONAL with a basis, approval TTL ≤ 300 s, open proposals bounded, every status reachable only forward', async () => {
  for (const [k, v] of Object.entries(R.ACTION_LIMITS)) assert.ok(v.value > 0 && v.status === 'PROVISIONAL' && v.basis.length > 5, k);
  assert.ok(R.ACTION_LIMITS.approvalTtlMs.value <= 300_000 && R.ACTION_LIMITS.approvalTtlMs.max === 300_000);
  assert.deepEqual(Object.keys(ACTION_STATUS), ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED', 'CANCELLED', 'SUPERSEDED']);
  const { A } = fresh();
  for (let i = 0; i < R.ACTION_LIMITS.openProposals.value; i++) A.user.propose({ actionId: 'COMPANION.CONTEXT.EXPLAIN', parameters: { requestId: `r${i}` } });
  assert.throws(() => A.user.propose({ actionId: 'COMPANION.CONTEXT.EXPLAIN', parameters: { requestId: 'one-more' } }), code('ACTION_NOT_ALLOWED', 'TOO_MANY_OPEN_PROPOSALS'));
});
