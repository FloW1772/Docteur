// Companion V1 — COMP-6A suite: human approval proof (UI gesture channel) over the COMP-5 framework.
// NB-5 runs for real on a TEMPORARY Docteur database; Companion stores are temporary files. No network (fetch is a
// counting stub), no model, no route, no UI wiring; the real user DB is never opened for writing.
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initSqlite, getDatabase } from './src/lib/sqlite.js';
import { createNotebookDocumentService } from './src/lib/notebook-documents.js';
import { createMemoryService } from './src/lib/notebook-memory.js';
import { ensureMemorySchema } from './src/lib/notebook-memory-schema.js';
import { CompanionStore } from './src/lib/companion-store.js';
import { CompanionMemory } from './src/lib/companion-memory.js';
import { COMPANION_SCHEMA_VERSION } from './src/lib/companion-schema.js';
import { createCompanionActions, APPROVAL_CHANNELS } from './src/lib/companion-actions.js';
import { CONFIRMATION_KIND, REINFORCED_ACKNOWLEDGEMENTS, GESTURE_LIMITS, INTENT_FIELDS, validateIntentShape } from './src/lib/companion-human-approval.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp6a-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const code = (c, reason = null) => (e) => {
  assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`);
  if (reason) assert.equal(e?.details?.reason, reason, `expected reason ${reason}, got ${e?.details?.reason}`);
  return true;
};
let realDbBefore; let fetchCalls = 0; const realFetch = globalThis.fetch; const opened = [];
before(() => {
  realDbBefore = REAL_DB.map(fileHash);
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network is not allowed in COMP-6A tests'); };
  initSqlite(path.join(TMP, 'docteur-temp.sqlite'));
  ensureMemorySchema(getDatabase());
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of opened) { try { s.close(); } catch { /* closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});

const DIM = 32;
const embed = async (t) => { const v = new Array(DIM).fill(0); for (const w of String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIM] += 1; } const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const noVec = () => { const rows = new Map(); return { rows, upsert: async (l) => { for (const r of l) rows.set(r.memory_id, r); }, search: async () => [], delete: async (ids) => { for (const i of ids) rows.delete(i); } }; };
let docService = null;
const nb5 = (vectors) => {
  if (!docService) docService = createNotebookDocumentService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: noVec(), lancedbPath: path.join(TMP, 'x.lance'), localComplete: async () => 'ok' });
  return createMemoryService({ embedText: embed, embeddingModel: 'm', embedFormat: {}, vectorStore: vectors, localComplete: async () => 'ok' });
};
let clockMs = Date.parse('2026-10-16T12:00:00.000Z');
const clock = () => clockMs;
const advance = (ms) => { clockMs += ms; };
let n = 0;
function fresh(opts = {}) {
  const store = CompanionStore.open({ dbPath: path.join(TMP, `c-${++n}.sqlite`), now: clock }); opened.push(store);
  const vec = noVec();
  const mem = new CompanionMemory({ store, nb5: nb5(vec), vectorProbe: async (id) => vec.rows.has(id), vectorPurge: async (id) => { vec.rows.delete(id); } });
  return { store, mem, A: createCompanionActions({ store, companion: mem, ...opts }) };
}
const rw = () => Array.from(crypto.randomBytes(7), b => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
const remember = (mem, opts = {}) => mem.rememberExplicit({ category: 'USER_PREFERENCE', value: `Préférence gestuelle ${rw()} ${rw()} ${rw()} ${rw()} ${rw()}.`, provenance: { origin: 'USER_EXPLICIT', sourceType: 'USER_INPUT' }, ...opts });
/** What the UI builds after a trusted gesture: only the fields of the challenge it received, plus the person's input. */
const intentFor = (ch, extra = {}) => ({
  proposalId: ch.proposalId, actionDigest: ch.actionDigest, confirmationKind: ch.confirmationKind, uiSessionId: ch.uiSessionId, nonce: ch.nonce,
  createdAt: new Date(clock()).toISOString(), gesture: { kind: 'POINTER', trusted: true },
  ...(ch.typedPhrase ? { typedPhrase: ch.typedPhrase } : {}), ...(ch.requiredAcknowledgements.length ? { acknowledgements: [...ch.requiredAcknowledgements] } : {}), ...extra,
});

test('product mode: UI_GESTURE is the default; a plain approve() never approves (approvedBy USER, humanConfirmed, any flag); direct channel only in test mode', async () => {
  const { store, mem, A } = fresh();
  assert.equal(A.approvalChannel, 'UI_GESTURE');
  assert.deepEqual(APPROVAL_CHANNELS, ['UI_GESTURE', 'DIRECT_TEST_ONLY']);
  const v = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  for (const opts of [{ approvedBy: 'USER', digest: p.digest }, { approvedBy: 'USER', digest: p.digest, humanConfirmed: true }, { humanConfirmed: true, userGesture: true, approved: true }, {}]) {
    assert.throws(() => A.user.approve(p.proposalId, opts), code('APPROVAL_REQUIRED', 'HUMAN_GESTURE_REQUIRED'));
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0);
  assert.equal(A.user.getProposal(p.proposalId).status, 'PENDING');
  assert.ok(A.audit.list().filter(e => e.event === 'ACTION_DENIED' && e.details.reason === 'HUMAN_GESTURE_REQUIRED').length === 4);
  // the direct channel is refused outside test mode, and unknown channels always
  const saved = process.env.DOCTEUR_TEST_MODE;
  try {
    delete process.env.DOCTEUR_TEST_MODE;
    assert.throws(() => createCompanionActions({ store, companion: mem, approvalChannel: 'DIRECT_TEST_ONLY' }), /tests only/);
  } finally { process.env.DOCTEUR_TEST_MODE = saved; }
  assert.throws(() => createCompanionActions({ store, companion: mem, approvalChannel: 'HUMAN_CONFIRMED' }), /unknown approval channel/);
  // no product source selects the direct channel
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk(path.join(HERE, 'src')), ...walk(path.join(HERE, '..', 'src'))].filter(x => /\.(js|ts|tsx)$/.test(x))) {
    if (f.endsWith(path.join('lib', 'companion-actions.js'))) continue;
    assert.equal(fs.readFileSync(f, 'utf8').includes('DIRECT_TEST_ONLY'), false, f);
  }
});

test('full flow: proposal → preview → challenge → trusted gesture → intent → COMP-5 approval (re-validated) → execution; audit binds the approval to the UI channel', async () => {
  const { mem, A } = fresh();
  const v = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  const { uiSessionId } = A.gesture.openUiSession();
  assert.match(uiSessionId, /^[A-Za-z0-9_-]{32}$/);
  const ch = A.gesture.issueChallenge({ uiSessionId, proposalId: p.proposalId });
  assert.deepEqual([ch.proposalId, ch.actionDigest, ch.previewSha256, ch.confirmationKind, ch.typedPhrase, ch.requiredAcknowledgements], [p.proposalId, p.digest, p.previewSha256, 'SIMPLE_CONFIRM', null, []]);
  assert.equal(Date.parse(ch.expiresAt) - Date.parse(ch.issuedAt), GESTURE_LIMITS.challengeTtlMs.value);
  assert.equal(A.user.getProposal(p.proposalId).status, 'PENDING', 'a challenge approves nothing');
  const ap = A.gesture.submitIntent(intentFor(ch));
  assert.deepEqual([ap.proposalId, ap.actionDigest, ap.approvedBy, ap.singleUse, ap.consumedAt], [p.proposalId, p.digest, 'USER', true, null]);
  const approvedEntry = A.audit.list().find(e => e.event === 'ACTION_APPROVED');
  assert.deepEqual([approvedEntry.details.channel, approvedEntry.details.confirmationKind, approvedEntry.details.gesture], ['UI_GESTURE', 'SIMPLE_CONFIRM', 'POINTER']);
  assert.match(approvedEntry.details.uiSession, /^[0-9a-f]{16}$/);
  assert.match(approvedEntry.details.nonce, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(A.audit.list()).includes(ch.nonce) || JSON.stringify(A.audit.list()).includes(uiSessionId), false, 'nonce / session id are never stored, only short hashes');
  const r = await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId });
  assert.equal(r.status, 'EXECUTED');
  assert.equal(mem.view(v.memoryId).companion.companionEnabled, false);
});

test('negatives: no gesture, untrusted gesture, fake booleans, wrong digest, wrong proposal, wrong kind, unknown / other-session nonce, unknown session, clock window', async () => {
  const { mem, store, A } = fresh();
  const v = await remember(mem); const v2 = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  const p2 = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v2.memoryId, enabled: false } });
  const s1 = A.gesture.openUiSession().uiSessionId; const s2 = A.gesture.openUiSession().uiSessionId;
  const fresh1 = () => A.gesture.issueChallenge({ uiSessionId: s1, proposalId: p.proposalId });
  let ch = fresh1();
  const { gesture: _g, ...noGesture } = intentFor(ch);
  assert.throws(() => A.gesture.submitIntent(noGesture), code('APPROVAL_INTENT_INVALID', 'GESTURE'), 'no gesture');
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { gesture: { kind: 'POINTER', trusted: false } })), code('APPROVAL_INTENT_INVALID', 'GESTURE'), 'untrusted');
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { gesture: { kind: 'SCRIPT', trusted: true } })), code('APPROVAL_INTENT_INVALID', 'GESTURE'));
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { gesture: { kind: 'POINTER', trusted: 'true' } })), code('APPROVAL_INTENT_INVALID', 'GESTURE'));
  for (const fake of [{ humanConfirmed: true }, { approved: true }, { approvedBy: 'USER' }, { userConfirmed: true }, { execute: true }]) {
    assert.throws(() => A.gesture.submitIntent(intentFor(ch, fake)), code('APPROVAL_INTENT_INVALID', 'UNKNOWN_FIELD'), JSON.stringify(fake));
  }
  assert.throws(() => A.gesture.submitIntent({ humanConfirmed: true }), code('APPROVAL_INTENT_INVALID', 'UNKNOWN_FIELD'), 'a bare boolean is nothing');
  assert.throws(() => A.gesture.submitIntent(true), code('APPROVAL_INTENT_INVALID', 'NOT_AN_OBJECT'));
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { nonce: crypto.randomBytes(24).toString('base64url') })), code('APPROVAL_INTENT_INVALID', 'UNKNOWN_NONCE'));
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { uiSessionId: crypto.randomBytes(24).toString('base64url') })), code('UI_SESSION_UNKNOWN'));
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { uiSessionId: s2 })), code('APPROVAL_INTENT_MISMATCH', 'OTHER_UI_SESSION'));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 0, 'shape / session refusals keep the challenge but approve nothing');
  // binding mismatches burn the challenge
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { actionDigest: 'f'.repeat(64) })), code('APPROVAL_DIGEST_MISMATCH', 'INTENT_DIGEST_DIFFERS'), 'wrong digest');
  assert.throws(() => A.gesture.submitIntent(intentFor(ch)), code('APPROVAL_INTENT_REPLAYED'), 'burnt');
  ch = fresh1();
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { proposalId: p2.proposalId, actionDigest: p2.digest })), code('APPROVAL_INTENT_MISMATCH', 'PROPOSAL_DIFFERS'), 'wrong proposal');
  ch = fresh1();
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { confirmationKind: 'TYPED_CONFIRM' })), code('APPROVAL_INTENT_MISMATCH', 'CONFIRMATION_KIND_DIFFERS'));
  ch = fresh1();
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { createdAt: new Date(clock() - 60_000).toISOString() })), code('APPROVAL_INTENT_EXPIRED', 'CREATED_OUTSIDE_CHALLENGE_WINDOW'), 'created before the challenge');
  ch = fresh1();
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { createdAt: new Date(clock() + 60_000).toISOString() })), code('APPROVAL_INTENT_EXPIRED', 'CREATED_OUTSIDE_CHALLENGE_WINDOW'), 'created in the future');
  ch = fresh1();
  assert.throws(() => A.gesture.submitIntent(intentFor(ch, { typedPhrase: 'whatever' })), code('APPROVAL_INTENT_INVALID', 'UNEXPECTED_TYPED_PHRASE'));
  // a challenge for proposal p cannot be redeemed after a newer challenge for p replaced it
  const old = fresh1(); const newer = fresh1();
  assert.throws(() => A.gesture.submitIntent(intentFor(old)), code('APPROVAL_INTENT_REPLAYED'));
  assert.equal(A.gesture.submitIntent(intentFor(newer)).proposalId, p.proposalId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_action_approvals').get().n, 1);
  assert.ok(A.audit.list().filter(e => e.event === 'ACTION_DENIED').length >= 16, 'every refusal audited');
});

test('expiry + replay: an expired intent / challenge never approves; a used intent is REPLAYED; closing the UI session voids its challenges', async () => {
  const { mem, A } = fresh();
  const v = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  const s = A.gesture.openUiSession().uiSessionId;
  const ch = A.gesture.issueChallenge({ uiSessionId: s, proposalId: p.proposalId });
  const late = intentFor(ch);
  advance(GESTURE_LIMITS.challengeTtlMs.value);
  assert.throws(() => A.gesture.submitIntent(late), code('APPROVAL_INTENT_EXPIRED', 'CHALLENGE_EXPIRED'));
  assert.throws(() => A.gesture.submitIntent(late), code('APPROVAL_INTENT_REPLAYED'), 'an expired challenge stays dead');
  const ch2 = A.gesture.issueChallenge({ uiSessionId: s, proposalId: p.proposalId });
  const intent = intentFor(ch2);
  const ap = A.gesture.submitIntent(intent);
  assert.throws(() => A.gesture.submitIntent(intent), code('APPROVAL_INTENT_REPLAYED', 'NONCE_ALREADY_USED'), 'replayed intent');
  assert.throws(() => A.gesture.issueChallenge({ uiSessionId: s, proposalId: p.proposalId }), code('ACTION_NOT_ALLOWED', 'PROPOSAL_APPROVED'), 'one approval per proposal');
  // the approval itself still expires (COMP-5) and is single-use
  assert.equal((await A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId })).status, 'EXECUTED');
  await assert.rejects(A.user.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId }), code('APPROVAL_ALREADY_USED'));
  // closing a UI session voids its open challenges
  const v2 = await remember(mem);
  const q = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v2.memoryId, enabled: false } });
  const s3 = A.gesture.openUiSession().uiSessionId;
  const chq = A.gesture.issueChallenge({ uiSessionId: s3, proposalId: q.proposalId });
  assert.equal(A.gesture.closeUiSession(s3), true);
  assert.throws(() => A.gesture.submitIntent(intentFor(chq)), code('UI_SESSION_UNKNOWN'));
  // a proposal that expires caps the challenge
  const v3 = await remember(mem);
  const r = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v3.memoryId, enabled: false } });
  advance(10 * 60_000 - 30_000);
  const chr = A.gesture.issueChallenge({ uiSessionId: s, proposalId: r.proposalId });
  assert.equal(chr.expiresAt, A.user.getProposal(r.proposalId).expiresAt);
  advance(30_000);
  assert.throws(() => A.gesture.issueChallenge({ uiSessionId: s, proposalId: r.proposalId }), code('PROPOSAL_EXPIRED'));
});

test('confirmation levels: SIMPLE (set enabled, preferences), TYPED (forget, cloud context), REINFORCED (NEVER_CLOUD release = acknowledgements + exact phrase); a typo does not burn the challenge', async () => {
  const { mem, svc, A } = { ...fresh() };
  assert.deepEqual(CONFIRMATION_KIND, { STANDARD: 'SIMPLE_CONFIRM', EXPLICIT: 'TYPED_CONFIRM', REINFORCED: 'REINFORCED_CONFIRM' });
  const s = A.gesture.openUiSession().uiSessionId;
  const v = await remember(mem);
  const kind = (actionId, parameters) => { const p = A.user.propose({ actionId, parameters }); return { p, ch: A.gesture.issueChallenge({ uiSessionId: s, proposalId: p.proposalId }) }; };
  assert.equal(kind('COMPANION.PREFERENCES.UPDATE', { proposalEnabled: false }).ch.confirmationKind, 'SIMPLE_CONFIRM');
  const cloud = kind('COMPANION.PREFERENCES.UPDATE', { cloudContextEnabled: true });
  assert.deepEqual([cloud.ch.confirmationKind, cloud.ch.typedPhrase], ['TYPED_CONFIRM', 'ALLOW CLOUD CONTEXT']);
  // forget = TYPED_CONFIRM with the exact phrase
  const f = kind('COMPANION.MEMORY.FORGET', { memoryId: v.memoryId });
  assert.deepEqual([f.ch.confirmationKind, f.ch.typedPhrase], ['TYPED_CONFIRM', `FORGET ${v.memoryId}`]);
  for (const wrong of [undefined, '', `forget ${v.memoryId}`, `FORGET ${v.memoryId} `, 'FORGET']) {
    const intent = intentFor(f.ch); if (wrong === undefined) delete intent.typedPhrase; else intent.typedPhrase = wrong;
    assert.throws(() => A.gesture.submitIntent(intent), code('CONFIRMATION_REQUIRED', 'TYPED_CONFIRM_PHRASE_MISMATCH'), String(wrong));
  }
  const apf = A.gesture.submitIntent(intentFor(f.ch, { gesture: { kind: 'KEYBOARD', trusted: true } }));
  const rf = await A.user.execute({ actionId: f.p.actionId, parameters: f.p.parameters, approvalId: apf.approvalId });
  assert.deepEqual([rf.status, rf.resultCode], ['EXECUTED', 'FORGET_COMPLETE']);
  // NEVER_CLOUD release = REINFORCED: both acknowledgements AND the exact phrase
  const hs = await remember(mem, { category: 'USER_FACT', value: `Donnée médicale ${rw()} ${rw()} ${rw()} ${rw()}.`, sensitivity: 'HIGHLY_SENSITIVE' });
  const rel = kind('COMPANION.MEMORY.SET_PRIVACY', { memoryId: hs.memoryId, scope: 'PRIVATE_LOCAL' });
  assert.deepEqual([rel.ch.confirmationKind, rel.ch.typedPhrase, rel.ch.requiredAcknowledgements], ['REINFORCED_CONFIRM', `RELEASE NEVER_CLOUD ${hs.memoryId}`, [...REINFORCED_ACKNOWLEDGEMENTS]]);
  assert.throws(() => A.gesture.submitIntent(intentFor(rel.ch, { acknowledgements: [] })), code('CONFIRMATION_REQUIRED', 'ACKNOWLEDGEMENTS_REQUIRED'));
  assert.throws(() => A.gesture.submitIntent(intentFor(rel.ch, { acknowledgements: [REINFORCED_ACKNOWLEDGEMENTS[0]] })), code('CONFIRMATION_REQUIRED', 'ACKNOWLEDGEMENTS_REQUIRED'));
  assert.throws(() => A.gesture.submitIntent(intentFor(rel.ch, { typedPhrase: 'RELEASE NEVER_CLOUD' })), code('CONFIRMATION_REQUIRED', 'REINFORCED_CONFIRM_PHRASE_MISMATCH'));
  assert.equal(mem.view(hs.memoryId).privacyScope, 'NEVER_CLOUD', 'nothing released by a partial confirmation');
  const apr = A.gesture.submitIntent(intentFor(rel.ch));
  assert.equal((await A.user.execute({ actionId: rel.p.actionId, parameters: rel.p.parameters, approvalId: apr.approvalId })).status, 'EXECUTED');
  assert.equal(mem.view(hs.memoryId).privacyScope, 'PRIVATE_LOCAL');
  void svc;
});

test('COMP-5 stays the authority: a state change after the challenge → PREVIEW_STALE; a superseded proposal → refused; READ_ONLY needs no challenge', async () => {
  const { mem, A } = fresh();
  const s = A.gesture.openUiSession().uiSessionId;
  const v = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: v.memoryId, scope: 'LOCAL_SHARED_CONTEXT' } });
  const ch = A.gesture.issueChallenge({ uiSessionId: s, proposalId: p.proposalId });
  mem.setPrivacyScope(v.memoryId, 'NEVER_CLOUD'); // the world changed after the person saw the preview
  assert.throws(() => A.gesture.submitIntent(intentFor(ch)), code('PREVIEW_STALE'));
  assert.throws(() => A.gesture.submitIntent(intentFor(ch)), code('APPROVAL_INTENT_REPLAYED'), 'the nonce was consumed before the approval was attempted');
  assert.throws(() => A.gesture.issueChallenge({ uiSessionId: s, proposalId: p.proposalId }), code('PREVIEW_STALE'));
  const q = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  const chq = A.gesture.issueChallenge({ uiSessionId: s, proposalId: q.proposalId });
  A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: true } }); // supersedes q
  assert.throws(() => A.gesture.submitIntent(intentFor(chq)), code('ACTION_NOT_ALLOWED', 'PROPOSAL_SUPERSEDED'));
  const ro = A.user.propose({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} });
  assert.throws(() => A.gesture.issueChallenge({ uiSessionId: s, proposalId: ro.proposalId }), code('ACTION_NOT_ALLOWED', 'APPROVAL_NOT_APPLICABLE'));
  assert.equal((await A.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} })).status, 'EXECUTED');
  assert.throws(() => A.gesture.issueChallenge({ uiSessionId: s, proposalId: crypto.randomUUID() }), code('PROPOSAL_NOT_FOUND'));
});

test('model boundary: the model facet has no gesture / approve / execute; intent fields in a model output are refused; a model proposal still needs the human gesture', async () => {
  const { mem, A } = fresh();
  const v = await remember(mem);
  assert.deepEqual(Object.keys(A.model), ['proposeFromModelOutput']);
  for (const k of ['humanConfirmed', 'nonce', 'gesture', 'uiSessionId', 'typedPhrase', 'acknowledgements', 'intent']) {
    assert.throws(() => A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false }, [k]: true }), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'), k);
  }
  const out = A.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  assert.equal(A.user.getProposal(out.proposalId).proposedBy, 'MODEL');
  assert.throws(() => A.user.approve(out.proposalId, { approvedBy: 'USER', digest: out.digest }), code('APPROVAL_REQUIRED', 'HUMAN_GESTURE_REQUIRED'));
  const s = A.gesture.openUiSession().uiSessionId;
  const ch = A.gesture.issueChallenge({ uiSessionId: s, proposalId: out.proposalId });
  const ap = A.gesture.submitIntent(intentFor(ch));
  assert.equal(ap.approvedBy, 'USER');
  assert.equal((await A.user.execute({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false }, approvalId: ap.approvalId })).status, 'EXECUTED');
});

test('UI service (server half of the port): UI_GESTURE only; model status from the model audit only; secret-shaped summaries withheld; no nonce / session in DTOs it adds', async () => {
  const { deriveModelStatus, summarize, createCompanionUiService, MODEL_UI_STATUS } = await import('./src/lib/companion-ui-service.js');
  assert.deepEqual(MODEL_UI_STATUS, ['LOCAL_AVAILABLE', 'LOCAL_UNAVAILABLE', 'NOT_RUN', 'RUNNING', 'TIMEOUT', 'CANCELLED', 'ERROR']);
  const e = (action, code) => ({ action, at: 'x', details: code ? { code } : {} });
  assert.equal(deriveModelStatus([]).status, 'NOT_RUN');
  assert.equal(deriveModelStatus([e('MODEL_REQUESTED')]).status, 'RUNNING');
  assert.equal(deriveModelStatus([e('MODEL_REQUESTED'), e('MODEL_COMPLETED')]).status, 'LOCAL_AVAILABLE');
  assert.equal(deriveModelStatus([e('MODEL_TIMEOUT', 'MODEL_TIMEOUT')]).status, 'TIMEOUT');
  assert.equal(deriveModelStatus([e('MODEL_CANCELLED', 'MODEL_CANCELLED')]).status, 'CANCELLED');
  assert.equal(deriveModelStatus([e('MODEL_FAILED', 'LOCAL_MODEL_UNAVAILABLE')]).status, 'LOCAL_UNAVAILABLE');
  assert.equal(deriveModelStatus([e('MODEL_FAILED', 'MODEL_PROVIDER_ERROR')]).status, 'ERROR');
  assert.deepEqual(summarize('Mon mot de passe est hunter2hunter2'), { summary: null, withheld: 'SECRET_SHAPE' });
  assert.equal(summarize('x'.repeat(300)).summary.length, 141);
  const direct = fresh({ approvalChannel: 'DIRECT_TEST_ONLY' });
  assert.throws(() => createCompanionUiService({ actions: direct.A, companion: direct.mem, store: direct.store }), /UI_GESTURE/);
  const { store, mem, A } = fresh();
  const ui = createCompanionUiService({ actions: A, companion: mem, store });
  const st = await ui.getStatus();
  assert.deepEqual([st.activation, st.schemaVersion, st.model.status, st.model.source], ['DISABLED_PENDING_HUMAN_ACTIVATION', 4, 'NOT_RUN', 'COMPANION_MODEL_AUDIT']);
  store.modelAudit('MODEL_REQUESTED', 'r1', {}); store.modelAudit('MODEL_FAILED', 'r1', { code: 'LOCAL_MODEL_UNAVAILABLE' });
  assert.equal((await ui.getStatus()).model.status, 'LOCAL_UNAVAILABLE', 'from metadata, never a probe');
  const v = await remember(mem);
  const rows = await ui.listMemories();
  assert.deepEqual([rows.length, rows[0].memoryId, rows[0].privacyScope, rows[0].summaryWithheld], [1, v.memoryId, 'PRIVATE_LOCAL', null]);
  assert.match(rows[0].summary, /^Préférence gestuelle/);
  const p = await ui.propose('COMPANION.MEMORY.SET_ENABLED', { memoryId: v.memoryId, enabled: false });
  assert.deepEqual([p.confirmationKind, p.digestShort, p.proposedBy], ['SIMPLE_CONFIRM', p.digest.slice(0, 12), 'USER']);
  const { uiSessionId } = await ui.openUiSession();
  const ch = await ui.issueChallenge(uiSessionId, p.proposalId);
  const ap = await ui.submitIntent(intentFor(ch));
  assert.deepEqual(Object.keys(ap).sort(), ['approvalId', 'approvedAt', 'approvedBy', 'expiresAt', 'proposalId', 'singleUse']);
  await assert.rejects(ui.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId }), code('INVALID_ACTION_PAYLOAD'), 'executionId required');
  const r = await ui.execute({ actionId: p.actionId, parameters: p.parameters, approvalId: ap.approvalId, executionId: 'exec-0001' });
  assert.equal(r.status, 'EXECUTED');
  await assert.rejects(ui.submitIntent({ humanConfirmed: true }), code('APPROVAL_INTENT_INVALID'));
  await assert.rejects(ui.propose('COMPANION.SHELL.RUN', {}), code('UNKNOWN_ACTION'));
  await assert.rejects(ui.propose('COMPANION.EMAIL.SEND', {}), code('CAPABILITY_REQUIRED'));
  const svcSrc = fs.readFileSync(path.join(HERE, 'src', 'lib', 'companion-ui-service.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const i of [...svcSrc.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])) assert.ok(i.startsWith('./companion-'), i);
  assert.equal(/child_process|node:(http|https|net)|\bfetch\s*\(|ollama|model-router|investigat|\bkg_/i.test(svcSrc), false);
});

test('bounds, shape contract, isolation: sessions / challenges bounded; intent fields closed; 0 network, 0 process, schema 3, real DB untouched', async () => {
  for (const [k, v] of Object.entries(GESTURE_LIMITS)) assert.ok(v.value > 0 && v.status === 'PROVISIONAL' && v.basis.length > 5, k);
  assert.ok(GESTURE_LIMITS.challengeTtlMs.value <= 120_000);
  assert.deepEqual(INTENT_FIELDS, ['proposalId', 'actionDigest', 'confirmationKind', 'uiSessionId', 'nonce', 'createdAt', 'gesture', 'typedPhrase', 'acknowledgements']);
  assert.throws(() => validateIntentShape(Object.assign(Object.create(null), { a: 1 })), code('APPROVAL_INTENT_INVALID', 'NOT_AN_OBJECT'));
  const { mem, A } = fresh();
  const ids = []; for (let i = 0; i < 9; i++) ids.push(A.gesture.openUiSession().uiSessionId);
  assert.equal(A.gesture.stats().uiSessions, GESTURE_LIMITS.uiSessions.value);
  const v = await remember(mem);
  const p = A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: v.memoryId, enabled: false } });
  assert.throws(() => A.gesture.issueChallenge({ uiSessionId: ids[0], proposalId: p.proposalId }), code('UI_SESSION_UNKNOWN'), 'oldest session evicted');
  const s = ids.at(-1);
  for (let i = 0; i < GESTURE_LIMITS.challengesPerSession.value; i++) {
    const m = await remember(mem);
    A.gesture.issueChallenge({ uiSessionId: s, proposalId: A.user.propose({ actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: m.memoryId, enabled: false } }).proposalId });
  }
  assert.throws(() => A.gesture.issueChallenge({ uiSessionId: s, proposalId: p.proposalId }), code('ACTION_NOT_ALLOWED', 'TOO_MANY_CHALLENGES'));
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'companion-human-approval.js'), 'utf8');
  for (const i of [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])) assert.ok(i === 'node:crypto' || i.startsWith('./companion-'), i);
  const code2 = src.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.equal(/child_process|node:(http|https|net|dns|tls)|\bfetch\s*\(|\beval\s*\(|new\s+Function|\bimport\s*\(|(?<!\.)\b(spawn|exec|execFile|fork)\s*\(|investigat|model-router|ollama|root-policy|\bkg_|sqlite|writeFile/i.test(code2), false);
  assert.equal(COMPANION_SCHEMA_VERSION, 4, 'activation migration is additive');
  const server = fs.readFileSync(path.join(HERE, 'src', 'server.js'), 'utf8');
  assert.ok(server.includes('openCompanionAtBoot') && server.includes('createCompanionUiRoute'), 'typed UI route is wired behind the boot gate');
  assert.equal(server.includes('DIRECT_TEST_ONLY'), false, 'product cannot select the direct test channel');
  assert.equal(fetchCalls, 0);
  assert.deepEqual(REAL_DB.map(fileHash), realDbBefore);
});
