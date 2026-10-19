// [Companion V1] COMP-6A — unit tests of the pure UI contracts / view model (Node type stripping). No browser, no network.
// Usage: node --test scripts/test-companion-ui-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  privacyBadge, privacyChange, memoryOffContract, modelStatusLabel, memoryStateLabel, confirmationKindOf, confirmationReady, buildApprovalIntent, proposalUiState,
  availableControls, previewRows, errorText, resultView, displayText, proposedByLabel, STATE_TEXT, PRIVACY_SCOPES, secondsLeft, originLabel, userConfirmed,
} from '../src/lib/companion/ui-contracts.ts';
import { INTENT_FIELDS } from '../cortex-server/src/lib/companion-human-approval.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const proposal = (extra = {}) => ({
  proposalId: '11111111-1111-4111-8111-111111111111', actionId: 'COMPANION.MEMORY.SET_ENABLED', actionVersion: 1, riskClass: 'LOCAL_MUTATION', parameters: { memoryId: 'm1', enabled: false },
  target: { kind: 'MEMORY', id: 'm1' }, digest: 'a'.repeat(64), digestShort: 'aaaaaaaaaaaa', proposedBy: 'USER', status: 'PENDING', resultCode: null, createdAt: iso(NOW - 1000),
  expiresAt: iso(NOW + 600_000), expired: false, previewStale: false, idempotency: 'IDEMPOTENT', confirmationKind: 'SIMPLE_CONFIRM',
  preview: { action: 'Disable', summary: 'companionEnabled: true → false', changes: [{ field: 'companionEnabled', from: true, to: false }], effects: ['MEMORY_EXCLUDED_FROM_CONTEXT'], reversible: 'YES', privacyImpact: { level: 'TIGHTENS' }, confirmation: { level: 'STANDARD' }, pointOfNoReturn: 'TRANSACTION_COMMIT', parameters: { memoryId: 'm1', enabled: false } },
  ...extra,
});
const challenge = (extra = {}) => ({ nonce: 'n'.repeat(32), uiSessionId: 's'.repeat(32), proposalId: proposal().proposalId, actionId: 'COMPANION.MEMORY.SET_ENABLED', actionDigest: 'a'.repeat(64), actionDigestShort: 'aaaaaaaaaaaa', previewSha256: 'b'.repeat(64), confirmationKind: 'SIMPLE_CONFIRM', typedPhrase: null, requiredAcknowledgements: [], issuedAt: iso(NOW), expiresAt: iso(NOW + 120_000), ...extra });
const trusted = { isTrusted: true, type: 'click', detail: 1 };

test('privacy badges: four scopes, NEVER_CLOUD explicit; unknown scope fail-closed; change direction', () => {
  assert.deepEqual([...PRIVACY_SCOPES], ['PRIVATE_LOCAL', 'LOCAL_SHARED_CONTEXT', 'CLOUD_ALLOWED', 'NEVER_CLOUD']);
  const nc = privacyBadge('NEVER_CLOUD');
  assert.match(nc.label, /NEVER_CLOUD.*jamais/); assert.equal(nc.tone, 'danger'); assert.match(nc.description, /ne quitte jamais/);
  assert.equal(privacyBadge('CLOUD_ALLOWED').tone, 'warn');
  for (const bad of ['PUBLIC', null, undefined, 42, '__proto__', 'toString']) { const b = privacyBadge(bad); assert.deepEqual([b.known, b.scope, b.tone], [false, 'UNKNOWN', 'danger'], String(bad)); }
  assert.equal(privacyChange('NEVER_CLOUD', 'PRIVATE_LOCAL'), 'LOOSENS_CLOUD');
  assert.equal(privacyChange('PRIVATE_LOCAL', 'CLOUD_ALLOWED'), 'LOOSENS_CLOUD');
  assert.equal(privacyChange('PRIVATE_LOCAL', 'LOCAL_SHARED_CONTEXT'), 'RELAXES_LOCAL');
  assert.equal(privacyChange('PRIVATE_LOCAL', 'NEVER_CLOUD'), 'TIGHTENS');
  assert.equal(privacyChange('PRIVATE_LOCAL', 'PRIVATE_LOCAL'), 'NONE');
  assert.equal(privacyChange('X', 'PRIVATE_LOCAL'), 'UNKNOWN');
});

test('memory OFF contract: durable / session / proposals / context OFF, forget available; missing preferences = OFF', () => {
  assert.deepEqual(memoryOffContract({ memoryEnabled: false, sessionMemoryEnabled: true, proposalEnabled: true, cloudContextEnabled: true }),
    { off: true, durableRetrieval: 'OFF', sessionMemory: 'OFF', proposals: 'OFF', contextMemory: 'OFF', forgetAvailable: true, cloudContext: 'OFF' });
  assert.equal(memoryOffContract(null).off, true);
  const on = memoryOffContract({ memoryEnabled: true, sessionMemoryEnabled: false, proposalEnabled: true, cloudContextEnabled: false });
  assert.deepEqual([on.off, on.durableRetrieval, on.sessionMemory, on.proposals, on.forgetAvailable], [false, 'ON', 'OFF', 'ON', true]);
});

test('model status: only the seven metadata states; unknown = "non affirmé", never available', () => {
  for (const s of ['LOCAL_AVAILABLE', 'LOCAL_UNAVAILABLE', 'NOT_RUN', 'RUNNING', 'TIMEOUT', 'CANCELLED', 'ERROR']) assert.equal(modelStatusLabel(s).known, true, s);
  const u = modelStatusLabel('AVAILABLE');
  assert.deepEqual([u.known, u.status, u.tone], [false, 'UNKNOWN', 'danger']);
  assert.match(u.label, /non affirmé/);
  assert.equal(memoryStateLabel('WEIRD').known, false);
  assert.equal(originLabel('USER_CONFIRMED'), 'Proposé puis confirmé par vous');
  assert.equal(userConfirmed('DERIVED'), false);
});

test('confirmation kinds and exact readiness: simple / typed (exact, no trim, no case folding) / reinforced (every ack + phrase); unknown = never ready', () => {
  assert.equal(confirmationKindOf({ riskClass: 'READ_ONLY', confirmationKind: 'NONE' }), 'NONE');
  assert.equal(confirmationKindOf({ riskClass: 'LOCAL_MUTATION', confirmationKind: 'TYPED_CONFIRM' }), 'TYPED_CONFIRM');
  assert.equal(confirmationKindOf({ riskClass: 'LOCAL_MUTATION', confirmationKind: 'AUTO' }), 'UNKNOWN');
  assert.equal(confirmationKindOf({ riskClass: 'EXTERNAL_ACTION', confirmationKind: 'SIMPLE_CONFIRM' }), 'UNKNOWN');
  assert.equal(confirmationReady('SIMPLE_CONFIRM', challenge(), '', []), true);
  assert.equal(confirmationReady('SIMPLE_CONFIRM', null, '', []), false, 'no challenge, no confirmation');
  const t = challenge({ confirmationKind: 'TYPED_CONFIRM', typedPhrase: 'FORGET m1' });
  assert.equal(confirmationReady('TYPED_CONFIRM', t, 'FORGET m1', []), true);
  for (const wrong of ['', 'forget m1', 'FORGET m1 ', ' FORGET m1', 'FORGET']) assert.equal(confirmationReady('TYPED_CONFIRM', t, wrong, []), false, wrong);
  const r = challenge({ confirmationKind: 'REINFORCED_CONFIRM', typedPhrase: 'RELEASE NEVER_CLOUD m1', requiredAcknowledgements: ['A', 'B'] });
  assert.equal(confirmationReady('REINFORCED_CONFIRM', r, 'RELEASE NEVER_CLOUD m1', ['A']), false);
  assert.equal(confirmationReady('REINFORCED_CONFIRM', r, 'RELEASE NEVER_CLOUD', ['A', 'B']), false);
  assert.equal(confirmationReady('REINFORCED_CONFIRM', r, 'RELEASE NEVER_CLOUD m1', ['B', 'A']), true);
  assert.equal(confirmationReady('REINFORCED_CONFIRM', { ...r, requiredAcknowledgements: [] }, 'RELEASE NEVER_CLOUD m1', []), false, 'reinforced without acks is malformed');
  assert.equal(confirmationReady('UNKNOWN', challenge(), '', []), false);
  assert.equal(confirmationReady('NONE', challenge(), '', []), false);
});

test('approval intent: only from a trusted pointer / keyboard event; exactly the server fields; a synthetic click or a boolean builds nothing', () => {
  assert.equal(buildApprovalIntent(challenge(), { isTrusted: false, type: 'click', detail: 1 }, {}, NOW), null, 'script click');
  assert.equal(buildApprovalIntent(challenge(), { type: 'click' }, {}, NOW), null);
  assert.equal(buildApprovalIntent(challenge(), null, {}, NOW), null);
  assert.equal(buildApprovalIntent(challenge(), { isTrusted: 'true', type: 'click' }, {}, NOW), null);
  assert.equal(buildApprovalIntent(challenge(), { isTrusted: true, type: 'focus' }, {}, NOW), null);
  assert.equal(buildApprovalIntent(challenge({ confirmationKind: 'NONE' }), trusted, {}, NOW), null);
  const i = buildApprovalIntent(challenge(), trusted, { typed: 'x', acknowledgements: ['A'] }, NOW);
  assert.deepEqual(i, { proposalId: challenge().proposalId, actionDigest: 'a'.repeat(64), confirmationKind: 'SIMPLE_CONFIRM', uiSessionId: 's'.repeat(32), nonce: 'n'.repeat(32), createdAt: iso(NOW), gesture: { kind: 'POINTER', trusted: true } });
  assert.equal(buildApprovalIntent(challenge(), { isTrusted: true, type: 'click', detail: 0 }, {}, NOW).gesture.kind, 'KEYBOARD', 'Enter / Space on a button');
  const typed = buildApprovalIntent(challenge({ confirmationKind: 'REINFORCED_CONFIRM', typedPhrase: 'P', requiredAcknowledgements: ['A'] }), trusted, { typed: 'P', acknowledgements: ['A'] }, NOW);
  assert.deepEqual([typed.typedPhrase, typed.acknowledgements], ['P', ['A']]);
  for (const k of Object.keys(typed)) assert.ok(INTENT_FIELDS.includes(k), `${k} is a server intent field`);
  for (const k of ['humanConfirmed', 'approved', 'approvedBy', 'execute']) assert.equal(k in typed, false);
});

test('lifecycle states: PENDING / EXPIRED / APPROVED / EXECUTING / EXECUTED / FAILED / INCOMPLETE / CANCELLED; unknown status fail-closed; FORGET_INCOMPLETE never success', () => {
  assert.equal(proposalUiState({ proposal: proposal(), now: NOW }), 'PENDING');
  assert.equal(proposalUiState({ proposal: proposal({ expiresAt: iso(NOW - 1) }), now: NOW }), 'EXPIRED');
  assert.equal(proposalUiState({ proposal: proposal({ expired: true }), now: NOW }), 'EXPIRED');
  const approval = { approvalId: 'x', proposalId: 'p', approvedBy: 'USER', approvedAt: iso(NOW), expiresAt: iso(NOW + 120_000), singleUse: true };
  assert.equal(proposalUiState({ proposal: proposal({ status: 'APPROVED' }), approval, now: NOW }), 'APPROVED');
  assert.equal(proposalUiState({ proposal: proposal({ status: 'APPROVED' }), approval, now: NOW + 120_000 }), 'EXPIRED', 'approval expiry');
  assert.equal(proposalUiState({ proposal: proposal({ status: 'APPROVED' }), executing: true, now: NOW }), 'EXECUTING');
  const res = (extra) => ({ actionId: 'a', proposalId: 'p', approvalId: 'x', status: 'EXECUTED', resultCode: 'OK', startedAt: iso(NOW), completedAt: iso(NOW), durationMs: 1, resultMetadata: {}, sideEffects: [], effectApplied: 'FULL', cancellation: { requested: false }, automaticRetries: 0, ...extra });
  assert.equal(proposalUiState({ proposal: null, result: res({}), now: NOW }), 'EXECUTED');
  const inc = res({ status: 'FAILED', resultCode: 'FORGET_INCOMPLETE', effectApplied: 'PARTIAL', resultMetadata: { remainingStores: ['NB5_VECTOR'] } });
  const v = resultView(inc);
  assert.deepEqual([v.state, v.success, v.tone], ['INCOMPLETE', false, 'warn']);
  assert.match(v.detail, /pas un succès/); assert.match(v.detail, /NB5_VECTOR/);
  assert.equal(resultView(res({ status: 'EXECUTED', effectApplied: 'PARTIAL' })).success, false, 'a partial effect is never a success');
  assert.equal(resultView(res({ status: 'CANCELLED', effectApplied: 'NONE', cancellation: { requested: true, honored: true, stage: 'BEFORE_COMMIT' } })).state, 'CANCELLED');
  assert.match(resultView(res({ cancellation: { requested: true, honored: false, stage: 'AFTER_POINT_OF_NO_RETURN' } })).detail, /trop tard/);
  assert.equal(resultView(res({ status: 'MAYBE' })).state, 'UNKNOWN');
  assert.equal(resultView(res({ status: 'MAYBE' })).success, false);
  assert.equal(proposalUiState({ proposal: proposal({ status: 'APPROVED_BY_MODEL' }), now: NOW }), 'UNKNOWN');
  assert.equal(proposalUiState({ proposal: proposal({ status: 'FAILED', resultCode: 'FORGET_INCOMPLETE' }), now: NOW }), 'INCOMPLETE');
  // controls: unknown enables nothing, expired only re-confirmation, executed nothing
  assert.deepEqual(availableControls('UNKNOWN', { confirmationReady: true, challengeReady: true, cancellableWhileExecuting: true }), { canConfirm: false, canReject: false, canExecute: false, canCancel: false, canReconfirm: false });
  assert.deepEqual(availableControls('EXPIRED'), { canConfirm: false, canReject: false, canExecute: false, canCancel: false, canReconfirm: true });
  assert.equal(availableControls('PENDING', { confirmationReady: true, challengeReady: false }).canConfirm, false, 'no challenge → no confirm');
  assert.equal(availableControls('PENDING', { confirmationReady: true, challengeReady: true }).canConfirm, true);
  assert.equal(availableControls('APPROVED').canExecute, true);
  assert.equal(availableControls('EXECUTING').canCancel, false);
  assert.equal(availableControls('EXECUTING', { cancellableWhileExecuting: true }).canCancel, true);
  for (const s of ['EXECUTED', 'FAILED', 'INCOMPLETE', 'CANCELLED', 'REJECTED', 'SUPERSEDED']) assert.deepEqual(Object.values(availableControls(s, { confirmationReady: true, challengeReady: true })), [false, false, false, false, false], s);
  for (const s of Object.keys(STATE_TEXT)) assert.ok(STATE_TEXT[s].label.length > 3);
  assert.equal(secondsLeft(iso(NOW + 1500), NOW), 2); assert.equal(secondsLeft('bad', NOW), 0);
});

test('model labelling: PROPOSED_BY_MODEL, never "approved by model"; preview rows hide nothing (extra preview fields listed)', () => {
  assert.match(proposedByLabel('MODEL').label, /^PROPOSED_BY_MODEL/);
  assert.equal(/APPROVED_BY_MODEL|approuvé par le modèle/i.test(JSON.stringify([proposedByLabel('MODEL'), STATE_TEXT])), false);
  assert.equal(proposedByLabel('SYSTEM').model, false);
  const rows = previewRows(proposal({ preview: { ...proposal().preview, sneaky: 'value', other: { a: 1 } } }));
  const keys = rows.map(r => r.key);
  for (const k of ['action', 'target', 'riskClass', 'summary', 'changes', 'effects', 'reversible', 'privacyImpact', 'pointOfNoReturn', 'confirmation', 'expiresAt', 'digest', 'parameters', 'extra:sneaky', 'extra:other']) assert.ok(keys.includes(k), k);
  assert.match(rows.find(r => r.key === 'changes').value, /companionEnabled : true → false/);
  assert.equal(rows.find(r => r.key === 'reversible').value, 'Réversible');
  assert.equal(rows.find(r => r.key === 'digest').value, 'aaaaaaaaaaaa');
});

test('error states: every required code has a text; unknown code = refusal, not success; secrets masked in display', () => {
  for (const c of ['APPROVAL_REQUIRED', 'APPROVAL_EXPIRED', 'APPROVAL_ALREADY_USED', 'PREVIEW_STALE', 'FORGET_INCOMPLETE', 'ACTION_FAILED', 'LOCAL_MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_CANCELLED',
    'APPROVAL_INTENT_REPLAYED', 'APPROVAL_INTENT_EXPIRED', 'APPROVAL_DIGEST_MISMATCH', 'CONFIRMATION_REQUIRED', 'UI_SESSION_UNKNOWN']) assert.equal(errorText(c).known, true, c);
  const u = errorText('SOMETHING_NEW'); assert.deepEqual([u.known, u.text], [false, 'Refusé (raison inconnue).']);
  assert.match(errorText('FORGET_INCOMPLETE').text, /pas un succès/);
  for (const s of ['sk-ABCDEFGHIJKLMNOPQRSTUV123', 'Authorization: Bearer abcdefghijklmnop.qrs', 'mot de passe : hunter22', 'api_key=0123456789abcdef', '-----BEGIN RSA PRIVATE KEY-----', 'otpauth://totp/x?secret=ABC', 'a'.repeat(64)]) {
    assert.equal(displayText(s), '[masqué]', s);
  }
  assert.equal(displayText('Je préfère les réponses courtes.'), 'Je préfère les réponses courtes.');
  const memId = 'mem-0f8a3c52-6c1e-4f6b-9a2d-1b7e4c9d0a11'; // NB-5 id shape: 40 chars, never masked
  assert.equal(displayText(memId), memId);
  assert.equal(displayText(JSON.stringify({ memoryId: memId })), JSON.stringify({ memoryId: memId }));
  assert.equal(displayText(null), '—');
  assert.equal(displayText('x'.repeat(10), 5), 'xxxxx…');
});
