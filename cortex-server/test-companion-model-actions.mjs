// Companion V1 — model action proposals (COMP-8 / COMP-8B contract), rebuilt in COMP-REMED-1 as a REAL node:test suite.
//
// Why rebuilt: the COMP-8 script ran top-level asserts and a hand-made counter, never set a failing exit code, and
// exercised APIs that do not exist in the certified framework. Original check → classification (COMP-REMED-1):
//   valid READ_ONLY parse, parameters === {}            TEST_CONTRACT_ERROR: COMP-5 certifies materialised defaults
//                                                       ({ includeDisabled: true, limit: 50 }); asserted as such below
//   valid LOCAL_MUTATION parse / riskClass / approval   kept
//   unknown / external action refused                   kept (+ high-impact)
//   privacy-loosening "parsed"                          kept as PARSE; refusal happens at proposal (MODEL_PRIVACY_LOOSENING)
//   forbidden approval fields / self-approval / flood   kept
//   malformed JSON / oversized                          kept
//   prototype pollution { __proto__: … } literal        TEST_DEFECT: a JS literal sets the prototype (no key reaches
//                                                       JSON) → that output was VALID; now sent as raw JSON text
//   control chars in an unknown "name" field            TEST_DEFECT: refused for the wrong reason; now in a real field
//   runReadOnly(id, {}) / actions.preview() / companion null   TEST_API_ERROR: not the certified API; replaced by the
//                                                       real facets (user.runReadOnly({ … }), proposal preview)
//   UI service proposeFromModel                         kept + CODE_DEFECTS fixed: user fallback removed, full DTO
// Also covered: the real companion-model.js envelope parsing through Model Router V1 against the fake HTTP runtime
// (CODE_DEFECT fixed: a malformed proposal crashed the answer through an audit event that did not exist).
// Temporary stores only; fetch is a counting stub (loopback fake runtime only).
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompanionStore } from './src/lib/companion-store.js';
import { CompanionMemory } from './src/lib/companion-memory.js';
import { createCompanionActions } from './src/lib/companion-actions.js';
import { createCompanionUiService } from './src/lib/companion-ui-service.js';
import { createCompanionModel, MODEL_ERROR } from './src/lib/companion-model.js';
import { createCompanionContextEngine } from './src/lib/companion-context.js';
import { createOllamaClient } from './src/lib/ollama.js';
import { lookupAction, parseModelActionOutput, ACTION_IDS, FUTURE_ACTIONS } from './src/lib/companion-action-registry.js';
import { startFakeOllama } from './fixtures/fake-ollama-server.mjs';
import { parseStrictJson, STRICT_JSON_MAX_DEPTH } from './src/lib/companion-contracts.js';
import { createCompanionUiRoute } from './src/routes/companion.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-remed-ma-'));
const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.join(HERE, 'data', f));
const fileHash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent');
const code = (c, reason = null) => (e) => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code}: ${e?.message}`); if (reason) assert.equal(e?.details?.reason, reason, `reason ${e?.details?.reason}`); return true; };
const realFetch = globalThis.fetch; let externalFetch = 0; let realBefore; const stores = []; const servers = [];
before(() => {
  realBefore = REAL_DB.map(fileHash);
  globalThis.fetch = async (u, o) => { if (!/^http:\/\/127\.0\.0\.1:/.test(String(u?.url ?? u))) { externalFetch++; throw new Error('no external network'); } return realFetch(u, o); };
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const s of servers) await s.close();
  for (const s of stores) { try { s.close(); } catch { /* closed */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
});
const STUB_NB5 = { createManual: async () => { throw new Error('unused'); }, getMemory: () => null, deleteMemory: async () => {}, listConflicts: () => [] };
let n = 0;
function rig({ approvalChannel } = {}) {
  const store = CompanionStore.open({ dbPath: path.join(TMP, `c-${++n}.sqlite`) }); stores.push(store);
  const mem = new CompanionMemory({ store, nb5: STUB_NB5 });
  const actions = createCompanionActions({ store, companion: mem, ...(approvalChannel ? { approvalChannel } : {}) });
  return { store, mem, actions };
}
const intentFor = (ch) => ({ proposalId: ch.proposalId, actionDigest: ch.actionDigest, confirmationKind: ch.confirmationKind, uiSessionId: ch.uiSessionId, nonce: ch.nonce, createdAt: new Date().toISOString(), gesture: { kind: 'POINTER', trusted: true }, ...(ch.typedPhrase ? { typedPhrase: ch.typedPhrase } : {}), ...(ch.requiredAcknowledgements.length ? { acknowledgements: [...ch.requiredAcknowledgements] } : {}) });

test('parser: valid READ_ONLY and LOCAL_MUTATION proposals, defaults materialised (COMP-5 contract), classes and approval requirement', () => {
  const ro = [
    [{ actionId: 'COMPANION.MEMORY.LIST', parameters: {} }, { includeDisabled: true, limit: 50 }],
    [{ actionId: 'COMPANION.MEMORY.EXPLAIN', parameters: { memoryId: 'mem-123456' } }, { memoryId: 'mem-123456' }],
    [{ actionId: 'COMPANION.CONTEXT.EXPLAIN', parameters: { requestId: 'req-123' } }, { requestId: 'req-123' }],
  ];
  for (const [p, expected] of ro) {
    const parsed = parseModelActionOutput(JSON.stringify(p));
    assert.equal(parsed.actionId, p.actionId);
    assert.deepEqual(parsed.parameters, expected, p.actionId);
    assert.equal(lookupAction(parsed.actionId).riskClass, 'READ_ONLY');
    assert.equal(lookupAction(parsed.actionId).requiresApproval, false);
  }
  for (const p of [
    { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { memoryEnabled: false } },
    { actionId: 'COMPANION.MEMORY.SET_ENABLED', parameters: { memoryId: 'mem-123', enabled: true } },
    { actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: 'mem-123', scope: 'NEVER_CLOUD' } },
    { actionId: 'COMPANION.MEMORY.FORGET', parameters: { memoryId: 'mem-123' } },
  ]) {
    const parsed = parseModelActionOutput(JSON.stringify(p));
    assert.deepEqual([parsed.actionId, parsed.parameters], [p.actionId, p.parameters]);
    assert.deepEqual([lookupAction(p.actionId).riskClass, lookupAction(p.actionId).requiresApproval], ['LOCAL_MUTATION', true]);
  }
  // a privacy-loosening proposal PARSES (the parser is shape-only); it is refused when proposed by the model (below)
  assert.equal(parseModelActionOutput({ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: 'mem-123', scope: 'CLOUD_ALLOWED' } }).parameters.scope, 'CLOUD_ALLOWED');
});

test('parser refusals: unknown, disabled external, high-impact, forbidden approval fields (any depth / case), self-approval, flood (max 1), malformed, oversized, prototype pollution, control characters', () => {
  for (const id of ['UNKNOWN_ACTION', 'MALICIOUS.ACTION', 'COMPANION.SHELL.RUN', '__proto__']) assert.throws(() => parseModelActionOutput({ actionId: id, parameters: {} }), code('UNKNOWN_ACTION'), id);
  for (const f of FUTURE_ACTIONS.filter(x => x.riskClass === 'EXTERNAL_ACTION' || x.riskClass === 'HIGH_IMPACT_ACTION')) {
    assert.throws(() => parseModelActionOutput({ actionId: f.actionId, parameters: {} }), code('CAPABILITY_REQUIRED'), f.actionId);
  }
  assert.ok(FUTURE_ACTIONS.some(f => f.riskClass === 'HIGH_IMPACT_ACTION'), 'high-impact actions exist and are refused');
  const base = { actionId: 'COMPANION.MEMORY.LIST', parameters: {} };
  for (const extra of [{ approved: true }, { approvalId: 'x' }, { approved_by: 'USER' }, { userConfirmed: true }, { execute: 'now' }, { nonce: 'abc', gesture: { kind: 'POINTER' } }, { Signature: 's' }, { humanConfirmed: true }, { digest: 'f'.repeat(64) }]) {
    assert.throws(() => parseModelActionOutput(JSON.stringify({ ...base, ...extra })), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'), JSON.stringify(extra));
  }
  assert.throws(() => parseModelActionOutput({ actionId: 'COMPANION.MEMORY.EXPLAIN', parameters: { memoryId: 'm1', approved: true } }), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'), 'nested claim');
  assert.throws(() => parseModelActionOutput(JSON.stringify({ ...base, actionId2: 'COMPANION.MEMORY.EXPLAIN', parameters2: {} })), code('INVALID_ACTION_PAYLOAD', 'UNKNOWN_FIELD'), 'two actions in one output');
  assert.throws(() => parseModelActionOutput(JSON.stringify([base, base])), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_NOT_AN_OBJECT'), 'an array of proposals');
  for (const bad of ['not json at all', '{incomplete', '{"actionId":"TEST"', '{"actionId":"TEST", "parameters":}', '', 'null', '42']) assert.throws(() => parseModelActionOutput(bad), code('INVALID_ACTION_PAYLOAD'), bad);
  assert.throws(() => parseModelActionOutput(JSON.stringify({ ...base, parameters: { limit: 1 }, pad: 'x'.repeat(5000) })), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_TOO_LARGE'));
  // prototype pollution: sent as raw JSON so the keys really reach the parser
  for (const raw of ['{"actionId":"COMPANION.MEMORY.LIST","parameters":{"__proto__":{"admin":true}}}', '{"actionId":"COMPANION.MEMORY.LIST","parameters":{"constructor":{"prototype":{"x":1}}}}', '{"actionId":"COMPANION.MEMORY.LIST","parameters":{"prototype":{"x":1}}}', '{"__proto__":{"admin":true},"actionId":"COMPANION.MEMORY.LIST","parameters":{}}']) {
    assert.throws(() => parseModelActionOutput(raw), code('INVALID_ACTION_PAYLOAD'), raw);
  }
  assert.equal({}.admin, undefined, 'Object.prototype untouched');
  // control characters in a REAL field
  for (const id of ['mem\u0000x', 'mem\u001fx', 'mem\nx', 'mem x']) assert.throws(() => parseModelActionOutput({ actionId: 'COMPANION.MEMORY.FORGET', parameters: { memoryId: id } }), code('INVALID_ACTION_PAYLOAD', 'NOT_A_VALID_ID'), JSON.stringify(id));
  assert.throws(() => parseModelActionOutput({ actionId: 'COMPANION.CONTEXT.EXPLAIN', parameters: { requestId: 'r\u0007' } }), code('INVALID_ACTION_PAYLOAD', 'NOT_A_VALID_ID'));
  assert.ok(ACTION_IDS.length === 7);
});

test('model facet: PROPOSED_BY_MODEL, PENDING, no approve / execute on the facet; privacy relaxation refused; direct execution impossible', async () => {
  const { actions } = rig();
  assert.deepEqual(Object.keys(actions.model), ['proposeFromModelOutput']);
  const ro = actions.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} });
  const mu = actions.model.proposeFromModelOutput({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } });
  for (const p of [ro, mu]) { assert.deepEqual([p.proposedBy, p.status], ['MODEL', 'PENDING']); assert.equal(actions.user.getProposal(p.proposalId).proposedBy, 'MODEL'); }
  assert.deepEqual([ro.requiresApproval, mu.requiresApproval], [false, true]);
  for (const p of [{ actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: 'mem-123', scope: 'CLOUD_ALLOWED' } }, { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { cloudContextEnabled: true } }]) {
    assert.throws(() => actions.model.proposeFromModelOutput(p), (e) => e.code === 'ACTION_NOT_ALLOWED' && ['MODEL_PRIVACY_LOOSENING', 'TARGET_NOT_FOUND'].includes(e.details?.reason), JSON.stringify(p));
  }
  assert.throws(() => actions.model.proposeFromModelOutput({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { cloudContextEnabled: true } }), code('ACTION_NOT_ALLOWED', 'MODEL_PRIVACY_LOOSENING'));
  // the model has no path to an approval or an execution; a plain approve is refused in product mode
  assert.throws(() => actions.user.approve(mu.proposalId, { approvedBy: 'USER', digest: mu.digest }), code('APPROVAL_REQUIRED', 'HUMAN_GESTURE_REQUIRED'));
  await assert.rejects(actions.user.execute({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } }), code('APPROVAL_REQUIRED', 'NO_APPROVAL'));
  assert.equal(actions.user.getProposal(mu.proposalId).status, 'PENDING', 'nothing approved, nothing executed');
});

test('READ_ONLY model proposal runs without approval under its exact digest; LOCAL_MUTATION model proposal: human gesture → approval → executed ONCE → replay refused', async () => {
  const { actions, store } = rig();
  const ro = actions.model.proposeFromModelOutput({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} });
  await assert.rejects(actions.user.runReadOnly({ actionId: 'COMPANION.MEMORY.LIST', parameters: { limit: 5 }, proposalId: ro.proposalId }), code('APPROVAL_DIGEST_MISMATCH'));
  const r = await actions.user.execute({ actionId: 'COMPANION.MEMORY.LIST', parameters: {}, proposalId: ro.proposalId });
  assert.deepEqual([r.status, actions.user.getProposal(ro.proposalId).status], ['EXECUTED', 'EXECUTED']);
  const mu = actions.model.proposeFromModelOutput({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } });
  const s = actions.gesture.openUiSession().uiSessionId;
  const ch = actions.gesture.issueChallenge({ uiSessionId: s, proposalId: mu.proposalId });
  const intent = intentFor(ch);
  const ap = actions.gesture.submitIntent(intent);
  assert.equal(ap.approvedBy, 'USER');
  assert.throws(() => actions.gesture.submitIntent(intent), code('APPROVAL_INTENT_REPLAYED'), 'intent replay');
  const before = store.listAudit().filter(a => a.action === 'PREFERENCES_CHANGED').length;
  const out = await actions.user.execute({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false }, approvalId: ap.approvalId });
  assert.equal(out.status, 'EXECUTED');
  await assert.rejects(actions.user.execute({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false }, approvalId: ap.approvalId }), code('APPROVAL_ALREADY_USED'), 'single-use');
  assert.equal(store.listAudit().filter(a => a.action === 'PREFERENCES_CHANGED').length, before + 1, 'mutation executed exactly once');
  assert.equal(store.getPreferences().proposalEnabled, false);
});

test('UI service proposeFromModel: MODEL only (no USER fallback), full DTO for the review, envelope fields closed, refusals structured', async () => {
  const { actions } = rig();
  const ui = createCompanionUiService({ actions, companion: { preferences: () => ({}), view: () => null }, store: { schemaVersion: () => 3, listModelAudit: () => [] } });
  const dto = await ui.proposeFromModel({ rawOutput: JSON.stringify({ text: 'Je peux désactiver les propositions.', actionProposal: { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } } }) });
  assert.deepEqual([dto.proposedBy, dto.status, dto.riskClass, dto.confirmationKind, dto.requiresApproval], ['MODEL', 'PENDING', 'LOCAL_MUTATION', 'SIMPLE_CONFIRM', true]);
  for (const k of ['preview', 'expiresAt', 'digest', 'digestShort', 'parameters', 'target']) assert.ok(dto[k], `full DTO: ${k}`);
  assert.deepEqual(dto.preview.changes, [{ field: 'proposalEnabled', from: true, to: false }]);
  const roDto = await ui.proposeFromModel({ rawOutput: { actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} } } });
  assert.deepEqual([roDto.proposedBy, roDto.confirmationKind], ['MODEL', 'NONE']);
  // the former user fallback: { actionId, parameters } without rawOutput used to create a USER proposal
  await assert.rejects(ui.proposeFromModel({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { cloudContextEnabled: true } }), code('INVALID_ACTION_PAYLOAD', 'UNKNOWN_FIELD'));
  await assert.rejects(ui.proposeFromModel({}), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_REQUIRED'));
  await assert.rejects(ui.proposeFromModel({ rawOutput: { actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} }, approved: true } }), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'), 'envelope self-approval');
  await assert.rejects(ui.proposeFromModel({ rawOutput: { actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} }, actionProposal2: {} } }), code('INVALID_ACTION_PAYLOAD', 'ENVELOPE_UNKNOWN_FIELD'), 'two proposals');
  await assert.rejects(ui.proposeFromModel({ rawOutput: 'x'.repeat(20_000) }), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_TOO_LARGE'));
  await assert.rejects(ui.proposeFromModel({ rawOutput: '{bad' }), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_NOT_JSON'));
  await assert.rejects(ui.proposeFromModel({ rawOutput: { actionProposal: { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { cloudContextEnabled: true } } } }), code('ACTION_NOT_ALLOWED', 'MODEL_PRIVACY_LOOSENING'));
  const listed = await ui.listProposals();
  assert.deepEqual(listed.map(p => p.proposedBy).sort(), ['MODEL', 'MODEL'], 'only the two model proposals are open; no USER proposal was created by the model endpoint');
});

test('real companion-model.js through Model Router V1 (fake HTTP runtime): envelope → one validated proposal; a malformed / self-approving proposal is dropped, the text kept, never a crash; non-string text refused; oversized text cut on a UTF-8 boundary', async () => {
  const replies = [];
  const srv = await startFakeOllama({ models: ['llama3.2:3b'], chat: (body) => ({ json: { model: body.model, message: { role: 'assistant', content: replies.shift() }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 5 } }) });
  servers.push(srv);
  const store = CompanionStore.open({ dbPath: path.join(TMP, `m-${++n}.sqlite`) }); stores.push(store);
  const cm = createCompanionModel({ client: createOllamaClient(srv.url), store, getSettings: () => ({ strict_local_mode: true }), enforcePolicy: () => ({ decision: 'ALLOW' }) });
  const engine = createCompanionContextEngine({ companion: { preferences: () => ({ memoryEnabled: false, sessionMemoryEnabled: false, proposalEnabled: false, cloudContextEnabled: false }), session: { list: () => [] }, view: () => null, recordContextAssembly: () => {} }, memoryPort: { retrieve: async () => ({ results: [] }) } });
  const ask = async (content, i) => { replies.push(content); const ctx = await engine.assemble({ requestId: `ma-${i}`, userRequest: 'Que peux-tu faire ?' }); return cm.executeCompanionLocal({ requestId: `ma-${i}`, context: ctx, timeoutMs: 5000 }); };
  const ok1 = await ask(JSON.stringify({ text: 'Voici.', actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} } }), 1);
  assert.deepEqual([ok1.text, ok1.actionProposal?.actionId, ok1.actionProposal?.parameters, ok1.actionProposalRejected], ['Voici.', 'COMPANION.MEMORY.LIST', { includeDisabled: true, limit: 50 }, null]);
  const bad = await ask(JSON.stringify({ text: 'Je garde le texte.', actionProposal: { actionId: 'NOPE', parameters: {} } }), 2);
  assert.deepEqual([bad.status, bad.text, bad.actionProposal, bad.actionProposalRejected], ['COMPLETED', 'Je garde le texte.', null, 'NOT_IN_REGISTRY'], 'malformed proposal dropped, text kept (formerly COMP_INTERNAL crash)');
  const self = await ask(JSON.stringify({ text: 'ok', actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {}, approved: true } }), 3);
  assert.deepEqual([self.actionProposal, self.actionProposalRejected], [null, 'MODEL_SELF_APPROVAL']);
  const env = await ask(JSON.stringify({ text: 'ok', approved: true, actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} } }), 4);
  assert.deepEqual([env.actionProposal, env.actionProposalRejected], [null, 'ENVELOPE_UNKNOWN_FIELD'], 'an approval claim next to the proposal refuses it');
  await assert.rejects(ask(JSON.stringify({ text: { evil: true }, actionProposal: null }), 5), code(MODEL_ERROR.MODEL_INVALID_RESPONSE));
  const big = await ask('é'.repeat(3000), 6); // 6000 bytes > 4096
  assert.ok(Buffer.byteLength(big.text) <= 4096 && !big.text.includes('�') && big.truncated === true, 'cut on a character boundary, reported');
  const plain = await ask('Réponse simple.', 7);
  assert.deepEqual([plain.text, plain.actionProposal, plain.modelParsed], ['Réponse simple.', null, false]);
  const completed = store.listModelAudit().filter(a => a.action === 'MODEL_COMPLETED');
  assert.ok(completed.some(a => a.details.actionProposalRejected === 'NOT_IN_REGISTRY'), 'the rejection is audited in the existing event');
  assert.equal(store.verifyModelAudit().ok, true);
  assert.equal(externalFetch, 0);
  assert.deepEqual(REAL_DB.map(fileHash), realBefore);
});

// ── [COMP-REMED-2] CR-1: duplicate JSON keys in model output are REFUSED (never last-wins / first-wins / merged) ──
const DUP = (e) => { assert.equal(e?.code, 'STRICT_JSON_INVALID', e?.message); assert.equal(e?.details?.reason, 'DUPLICATE_KEY', e?.message); return true; };
const LIST = { actionId: 'COMPANION.MEMORY.LIST', parameters: {} };

test('[COMP-REMED-2] CR-1 strict parser: duplicate keys refused per object at any depth (decoded key value), separate objects allowed, JSON.parse grammar and results kept, bounded, no content in errors', () => {
  const deep = (inner, levels) => '{"a":'.repeat(levels) + inner + '}'.repeat(levels);
  for (const t of [
    '{"response":"A","response":"B"}',                                                                // 1. top level
    '{"actionProposal":{"actionId":"A","actionId":"B","parameters":{}}}',                             // 2. actionId
    '{"actionProposal":{"parameters":{"enabled":true,"enabled":false}}}',                             // 3. parameters key
    deep('{"x":1,"x":1}', 20),                                                                        // 4. deeply nested (same value too)
    '{"items":[{"x":1,"x":2}]}', '[[{"ok":1},{"x":1,"x":2}]]',                                        // 5. object inside an array
    '{"actionId":"A","action\\u0049d":"B"}', '{"\\u0061":1,"a":2}', '{"a\\/b":1,"a/b":2}',            // 6. escaped-equivalent
    '{"actionProposal":{"actionId":"A","approved":false,"approved":true}}',                           // 7. forbidden approval field
    '{"__proto__":{"a":1},"__proto__":{"b":2}}', '{"__proto__":1,"\\u005f_proto__":2}',               // 8. __proto__ representations
    '{"a":{},"a":[]}', '{"a":1,"b":2,"a":3}',
  ]) assert.throws(() => parseStrictJson(t), DUP, t);
  // 9. the same key in DIFFERENT objects is allowed (key sets are per object)
  assert.deepEqual(parseStrictJson('{"a":{"id":1},"b":{"id":2}}'), { a: { id: 1 }, b: { id: 2 } });
  assert.deepEqual(parseStrictJson('[{"x":1},{"x":2}]'), [{ x: 1 }, { x: 2 }]);
  assert.deepEqual(parseStrictJson('{"id":{"id":{"id":1}}}'), { id: { id: { id: 1 } } });
  assert.deepEqual(parseStrictJson('{"a":1,"A":2,"x":"x"}'), { a: 1, A: 2, x: 'x' }, 'keys are case-sensitive; a value equal to a key is not a key');
  assert.deepEqual(parseStrictJson('{"t":"\\"a\\":1,\\"a\\":2"}'), { t: '"a":1,"a":2' }, 'a duplicate-looking string is content, not keys (no regex)');
  // same results as JSON.parse on duplicate-free input (one parse, the validated value is the one used)
  for (const t of ['{"actionId":"COMPANION.MEMORY.LIST","parameters":{"limit":5}}', ' \n{"a":[1,-0.5e3,true,false,null,"\\u00e9\\ud83d\\ude00"]}\t', '"x"', '42', 'null', '{"10":1,"2":2,"b":3}']) {
    assert.deepEqual(parseStrictJson(t), JSON.parse(t), t);
  }
  // 12-13. malformed / trailing garbage still refused; a syntax error wins over a duplicate (plain-text callers)
  for (const t of ['{bad', '{"a":1', '{"a":1}x', '{"a":1}{"a":1}', '{"a":1,}', "{'a':1}", '', '﻿{}', '"a\u0001"', '{"a":1,"a":2']) {
    assert.throws(() => parseStrictJson(t), (e) => e.details?.reason === 'NOT_JSON', JSON.stringify(t));
  }
  // bounded recursion
  assert.doesNotThrow(() => parseStrictJson('['.repeat(STRICT_JSON_MAX_DEPTH) + ']'.repeat(STRICT_JSON_MAX_DEPTH)));
  assert.throws(() => parseStrictJson('['.repeat(STRICT_JSON_MAX_DEPTH + 1) + ']'.repeat(STRICT_JSON_MAX_DEPTH + 1)), (e) => e.details?.reason === 'TOO_DEEP');
  assert.throws(() => parseStrictJson('{"a":'.repeat(100_000)), (e) => e.details?.reason === 'TOO_DEEP', 'no unbounded recursion');
  // prototype: "__proto__" stays an own data key exactly as with JSON.parse; Object.prototype untouched
  const p = parseStrictJson('{"__proto__":{"admin":true}}');
  assert.equal(Object.getPrototypeOf(p), Object.prototype); assert.ok(Object.hasOwn(p, '__proto__')); assert.equal({}.admin, undefined);
  // the error never carries the model text
  assert.throws(() => parseStrictJson('{"k":"SENSITIVE-MARKER","k":"SENSITIVE-MARKER"}'), (e) => !`${e.message}${JSON.stringify(e.details)}`.includes('SENSITIVE-MARKER'));
});

test('[COMP-REMED-2] CR-1 registry + UI service + typed route: duplicate-key model output → MODEL_OUTPUT_DUPLICATE_KEY; 0 proposal / approval / execution / mutation; valid output and max-one-action unchanged', async () => {
  const { actions, store } = rig();
  const ui = createCompanionUiService({ actions, companion: { preferences: () => ({}), view: () => null }, store: { schemaVersion: () => 3, listModelAudit: () => [] } });
  const route = createCompanionUiRoute({ service: ui });
  const post = async (text) => { const r = await route.request('http://localhost/companion/model-proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }); return { status: r.status, json: await r.json() }; };
  const prefsBefore = JSON.stringify(store.getPreferences());
  const REFUSED = code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_DUPLICATE_KEY');
  // the registry parser (proposal text)
  for (const raw of [
    '{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":false}}', // the CERT evidence
    '{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{}}',
    '{"actionId":"COMPANION.MEMORY.LIST","parameters":{"limit":5},"parameters":{"limit":7}}',
    '{"actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":true,"proposalEnabled":false}}',
    '{"actionId":"COMPANION.MEMORY.LIST","action\\u0049d":"COMPANION.PREFERENCES.UPDATE","parameters":{}}',
    '{"actionId":"COMPANION.MEMORY.LIST","approved":false,"approved":true,"parameters":{}}', // never relies on "the last value"
  ]) assert.throws(() => parseModelActionOutput(raw), REFUSED, raw);
  assert.throws(() => actions.model.proposeFromModelOutput('{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.MEMORY.LIST","parameters":{}}'), REFUSED, 'even an identical duplicate');
  // the UI service envelope (string rawOutput)
  for (const raw of [
    '{"text":"A","text":"B","actionProposal":{"actionId":"COMPANION.MEMORY.LIST","parameters":{}}}',
    '{"response":"...","actionProposal":{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{}}}',
    '{"actionProposal":{"actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":true,"proposalEnabled":false}}}',
    '{"actionProposal":{"actionId":"COMPANION.MEMORY.LIST","parameters":{}},"actionProposal":{"actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":false}}}',
    '{"actionProposal":{"actionId":"COMPANION.MEMORY.LIST","approved":false,"approved":true,"parameters":{}}}',
    '{"actionProposal":{"actionId":"COMPANION.MEMORY.LIST","action\\u0049d":"COMPANION.PREFERENCES.UPDATE","parameters":{}}}',
  ]) await assert.rejects(ui.proposeFromModel({ rawOutput: raw }), REFUSED, raw);
  // the typed route: c.req.json() would have resolved these last-wins before the service saw them
  for (const body of [
    '{"rawOutput":{"actionProposal":{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":false}}}}',
    '{"rawOutput":{"actionProposal":{"actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":true,"proposal\\u0045nabled":false}}}}',
    '{"rawOutput":{"actionProposal":{"actionId":"COMPANION.MEMORY.LIST","parameters":{}}},"rawOutput":{"actionProposal":{"actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":false}}}}',
    JSON.stringify({ rawOutput: '{"actionProposal":{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{}}}' }),
  ]) {
    const r = await post(body);
    assert.deepEqual([r.status, r.json.ok, r.json.error?.code, r.json.error?.reason], [400, false, 'INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_DUPLICATE_KEY'], body);
    assert.equal(JSON.stringify(r.json).includes('PREFERENCES'), false, 'no model content echoed');
  }
  assert.equal((await post('x'.repeat(70 * 1024))).json.error?.reason, 'MODEL_OUTPUT_TOO_LARGE', 'route body bounded before parsing');
  assert.equal((await post('{"rawOutput":"{}"} trailing')).json.error?.code, 'INVALID_ACTION_PAYLOAD', 'route: trailing garbage refused');
  // nothing came out of any refused output
  const events = actions.audit.list().map(e => e.event);
  for (const ev of ['ACTION_PROPOSED', 'ACTION_APPROVED', 'ACTION_EXECUTED']) assert.equal(events.filter(e => e === ev).length, 0, `${ev}: 0`);
  assert.deepEqual([actions.user.listProposals({ status: 'PENDING' }).length, actions.user.listProposals({ status: 'APPROVED' }).length], [0, 0], '0 proposal');
  assert.equal(JSON.stringify(store.getPreferences()), prefsBefore, '0 mutation');
  // 12-14. malformed / trailing garbage / max one action / prototype keys: unchanged refusals
  await assert.rejects(ui.proposeFromModel({ rawOutput: '{"actionProposal":{"actionId":"COMPANION.MEMORY.LIST","parameters":{}}} x' }), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_NOT_JSON'));
  assert.throws(() => parseModelActionOutput('{"actionId":"COMPANION.MEMORY.LIST","parameters":{}}}'), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_NOT_JSON'));
  await assert.rejects(ui.proposeFromModel({ rawOutput: JSON.stringify({ actionProposal: LIST, actionProposal2: LIST }) }), code('INVALID_ACTION_PAYLOAD', 'ENVELOPE_UNKNOWN_FIELD'));
  assert.throws(() => parseModelActionOutput(JSON.stringify([LIST, LIST])), code('INVALID_ACTION_PAYLOAD', 'MODEL_OUTPUT_NOT_AN_OBJECT'));
  assert.throws(() => parseModelActionOutput('{"actionId":"COMPANION.MEMORY.LIST","parameters":{"__proto__":{"admin":true}}}'), code('INVALID_ACTION_PAYLOAD', 'UNKNOWN_FIELD'));
  assert.throws(() => parseModelActionOutput('{"actionId":"COMPANION.MEMORY.LIST","__proto__":{"approved":true},"parameters":{}}'), code('ACTION_NOT_ALLOWED', 'MODEL_SELF_APPROVAL'));
  assert.equal({}.admin, undefined); assert.equal({}.approved, undefined);
  // 10. ordinary valid model proposals still pass — string, object, and through the route — one proposal each
  const viaString = await ui.proposeFromModel({ rawOutput: JSON.stringify({ text: 'Je peux lister.', actionProposal: LIST }) });
  const viaRoute = await post(JSON.stringify({ rawOutput: { text: 'Je peux désactiver.', actionProposal: { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { proposalEnabled: false } } } }));
  assert.deepEqual([viaString.proposedBy, viaString.status, viaRoute.status, viaRoute.json.value?.proposedBy, viaRoute.json.value?.confirmationKind], ['MODEL', 'PENDING', 200, 'MODEL', 'SIMPLE_CONFIRM']);
  assert.equal(actions.audit.list().filter(e => e.event === 'ACTION_PROPOSED').length, 2, 'exactly the two valid outputs became proposals');
  assert.equal(JSON.stringify(store.getPreferences()), prefsBefore, 'a proposal is not a mutation');
});

test('[COMP-REMED-2] CR-1 real companion-model.js (Model Router V1, fake HTTP runtime): a duplicate-key envelope refuses the WHOLE answer (MODEL_INVALID_RESPONSE / MODEL_OUTPUT_DUPLICATE_KEY), audited without content; plain text and a valid proposal right after are unchanged', async () => {
  const replies = [];
  const srv = await startFakeOllama({ models: ['llama3.2:3b'], chat: (body) => ({ json: { model: body.model, message: { role: 'assistant', content: replies.shift() }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 5 } }) });
  servers.push(srv);
  const store = CompanionStore.open({ dbPath: path.join(TMP, `d-${++n}.sqlite`) }); stores.push(store);
  const cm = createCompanionModel({ client: createOllamaClient(srv.url), store, getSettings: () => ({ strict_local_mode: true }), enforcePolicy: () => ({ decision: 'ALLOW' }) });
  const engine = createCompanionContextEngine({ companion: { preferences: () => ({ memoryEnabled: false, sessionMemoryEnabled: false, proposalEnabled: false, cloudContextEnabled: false }), session: { list: () => [] }, view: () => null, recordContextAssembly: () => {} }, memoryPort: { retrieve: async () => ({ results: [] }) } });
  const ask = async (content, i) => { replies.push(content); const ctx = await engine.assemble({ requestId: `cr1-${i}`, userRequest: 'Que peux-tu faire ?' }); return cm.executeCompanionLocal({ requestId: `cr1-${i}`, context: ctx, timeoutMs: 5000 }); };
  const REFUSED = (e) => { assert.equal(e?.code, MODEL_ERROR.MODEL_INVALID_RESPONSE, e?.message); assert.equal(e?.details?.reason, 'MODEL_OUTPUT_DUPLICATE_KEY'); return true; };
  const dups = [
    '{"text":"SENSITIVE-MARKER","actionProposal":{"actionId":"COMPANION.MEMORY.LIST","actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{}}}',
    '{"text":"SENSITIVE-MARKER","text":"B"}',
    '{"text":"SENSITIVE-MARKER","actionProposal":{"actionId":"COMPANION.MEMORY.LIST","approved":false,"approved":true,"parameters":{}}}',
    '{"text":"SENSITIVE-MARKER","actionProposal":{"actionId":"COMPANION.PREFERENCES.UPDATE","parameters":{"proposalEnabled":true,"proposal\\u0045nabled":false}}}',
    '[{"x":1,"x":2}]',
  ];
  for (const [i, raw] of dups.entries()) await assert.rejects(ask(raw, i), REFUSED, raw);
  const failed = store.listModelAudit().filter(a => a.action === 'MODEL_FAILED');
  assert.equal(failed.length, dups.length); assert.ok(failed.every(a => a.details.reason === 'MODEL_OUTPUT_DUPLICATE_KEY' && a.details.code === MODEL_ERROR.MODEL_INVALID_RESPONSE));
  assert.equal(store.listModelAudit().filter(a => a.action === 'MODEL_COMPLETED').length, 0, 'no answer delivered from an ambiguous envelope');
  assert.equal(JSON.stringify(store.listModelAudit()).includes('SENSITIVE-MARKER'), false, 'audit holds no model content');
  // 11. ordinary text, a broken envelope (plain text) and a valid proposal: unchanged contract
  const plain = await ask('Réponse simple.', 10);
  assert.deepEqual([plain.status, plain.text, plain.actionProposal, plain.modelParsed], ['COMPLETED', 'Réponse simple.', null, false]);
  const broken = await ask('{"text":"a","text":"b"', 11);
  assert.deepEqual([broken.status, broken.modelParsed, broken.actionProposal], ['COMPLETED', false, null], 'not JSON → plain text, as before');
  const valid = await ask(JSON.stringify({ text: 'Voici.', actionProposal: LIST }), 12);
  assert.deepEqual([valid.text, valid.actionProposal?.actionId, valid.actionProposalRejected], ['Voici.', 'COMPANION.MEMORY.LIST', null]);
  assert.equal(store.verifyModelAudit().ok, true);
  assert.equal(externalFetch, 0);
  assert.deepEqual(REAL_DB.map(fileHash), realBefore);
});
