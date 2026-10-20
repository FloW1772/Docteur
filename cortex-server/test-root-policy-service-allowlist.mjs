// Root Policy V2A — exact policy-defined SERVICE_RESTART allowlist (V2 rebuilt from the reviewed code; V1 = historical fixture).
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateText } from './root-policy-v2-candidate.mjs';
import { loadHistoricalV1 } from './fixtures/root-policy-history.mjs';
import { buildDefaultPolicy, RUNTIME_RESTART_BOUNDARY } from './src/lib/root-policy/default-policy.js';
import { createEngine } from './src/lib/root-policy/engine.js';
import { canonicalize, validatePolicy } from './src/lib/root-policy/schema.js';

// V1 compatibility is checked against the historical signed V1 (verified with its own historical anchor), never the live file.
const { text: V1_TEXT, policy: V1 } = loadHistoricalV1();
const V2 = JSON.parse(buildCandidateText({ issuedAt: '2026-10-19T00:00:00.000Z' }));
const DIGEST = 'a'.repeat(64);
const engineFor = (policy) => createEngine({ getPolicy: () => ({ valid: true, policy, version: policy.version }) });
const e1 = engineFor(V1);
const e2 = engineFor(V2);
const request = (serviceId = 'kiwix-serve', over = {}) => ({
  action: 'SERVICE_RESTART', module: 'runtime-supervisor', trustDomain: 'RUNTIME', actor: { kind: 'USER' },
  userInitiated: true, certifiedBoundary: true,
  context: { serviceId, target: serviceId, payloadHash: DIGEST },
  ...over,
});
const decide = (engine, req) => engine.decide(req);

test('historical signed V1 is byte-identical to V1 generation and preserves the legacy serviceAllowlistRequired behavior', () => {
  assert.equal(canonicalize(buildDefaultPolicy({ version: 1, issuedAt: V1.issuedAt })), V1_TEXT);
  assert.deepEqual(validatePolicy(V1), { ok: true });
  assert.equal(decide(e1, request('syntactically-valid-non-approved')).code, 'REQUIRE_LOCAL_APPROVAL', 'V1 only checked presence and reached the approval layer');
});

test('V2 candidate declares exactly one certified restart boundary and one exact service', () => {
  assert.deepEqual(validatePolicy(V2), { ok: true });
  assert.deepEqual(V2.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].covers, ['SERVICE_RESTART']);
  assert.deepEqual(V2.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist, ['kiwix-serve']);
  assert.deepEqual(Object.entries(V2.modules).filter(([, m]) => m.approvalBoundary === RUNTIME_RESTART_BOUNDARY).map(([name]) => name), ['runtime-supervisor']);
  assert.equal(V2.capabilities['RUNTIME.RESTART_SERVICE'].constraints.serviceAllowlistRequired, true);
});

test('V2 allows only the exact Kiwix identity with a consistent target and digest-shaped payloadHash', () => {
  const d = decide(e2, request());
  assert.deepEqual([d.decision, d.code, d.boundary], ['ALLOW', 'ALLOW_CERTIFIED_BOUNDARY', RUNTIME_RESTART_BOUNDARY]);
  for (const serviceId of ['ollama', 'docteur-backend', 'docteur-frontend', 'comfyui', 'unknown-service', 'kiwix', 'kiwix-serve-extra']) {
    const denied = decide(e2, request(serviceId));
    assert.deepEqual([denied.decision, denied.code], ['DENY', 'DENY_SERVICE_NOT_ALLOWLISTED'], serviceId);
  }
});

test('policy denial happens before lifecycle delegation for every non-allowlisted service', () => {
  let delegateInvocations = 0;
  const gateThenDelegate = (serviceId) => {
    const d = decide(e2, request(serviceId));
    if (d.decision === 'ALLOW') delegateInvocations++;
    return d;
  };
  for (const id of ['ollama', 'docteur-backend', 'docteur-frontend', 'comfyui', 'unknown-service']) assert.equal(gateThenDelegate(id).decision, 'DENY');
  assert.equal(delegateInvocations, 0);
});

test('serviceId must exist and be syntactically valid; wildcard, regex, prefix, and normalization tricks fail', () => {
  assert.equal(decide(e2, request('', { context: { serviceId: '', target: '', payloadHash: DIGEST } })).code, 'DENY_UNKNOWN_CAPABILITY');
  for (const serviceId of ['*', '^kiwix.*$', 'kiwix serve', 'Kiwix-serve', '../kiwix-serve', 'kiwix_serve', 'kiwix-serve/']) {
    assert.equal(decide(e2, request(serviceId)).code, 'DENY_SERVICE_ID_INVALID', serviceId);
  }
});

test('serviceId and target are one exact identity; both mismatch directions deny', () => {
  const a = request('kiwix-serve'); a.context.target = 'ollama';
  const b = request('ollama'); b.context.target = 'kiwix-serve';
  assert.deepEqual([decide(e2, a).decision, decide(e2, a).code], ['DENY', 'DENY_SERVICE_TARGET_MISMATCH']);
  assert.deepEqual([decide(e2, b).decision, decide(e2, b).code], ['DENY', 'DENY_SERVICE_TARGET_MISMATCH']);
  for (const target of [undefined, null, '', 'kiwix-serve-extra', 'KIWIX-SERVE']) {
    const r = request(); r.context.target = target;
    assert.equal(decide(e2, r).code, 'DENY_SERVICE_TARGET_MISMATCH', String(target));
  }
});

test('payloadHash remains mandatory and must be a canonical SHA-256 digest', () => {
  for (const payloadHash of [undefined, null, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    const r = request(); r.context.payloadHash = payloadHash;
    assert.deepEqual([decide(e2, r).decision, decide(e2, r).code], ['DENY', 'DENY_SERVICE_DEFINITION_DIGEST_INVALID'], String(payloadHash));
  }
});

test('missing, empty, malformed, or wrong-type allowlists fail schema validation and fail closed in the engine', () => {
  const mutations = [
    (p) => { delete p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist; },
    (p) => { p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist = []; },
    (p) => { p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist = 'kiwix-serve'; },
    (p) => { p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist = [null]; },
    (p) => { p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist = ['*']; },
    (p) => { p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist = ['^kiwix.*$']; },
    (p) => { p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist = ['kiwix-serve', 'kiwix-serve']; },
  ];
  for (const mutate of mutations) {
    const p = structuredClone(V2); mutate(p);
    assert.equal(validatePolicy(p).ok, false);
    assert.equal(decide(engineFor(p), request()).decision, 'DENY');
  }
});

test('V2 requires the capability constraint and an allowlisted SERVICE_RESTART boundary', () => {
  const mutations = [
    (p) => { delete p.capabilities['RUNTIME.RESTART_SERVICE'].constraints; },
    (p) => { delete p.capabilities['RUNTIME.RESTART_SERVICE'].constraints.serviceAllowlistRequired; },
    (p) => { p.capabilities['RUNTIME.RESTART_SERVICE'].constraints.serviceAllowlistRequired = false; },
    (p) => { p.capabilities['RUNTIME.RESTART_SERVICE'].constraints.serviceAllowlistRequired = 'true'; },
    (p) => { p.modules['runtime-supervisor'].approvalBoundary = null; },
  ];
  for (const mutate of mutations) {
    const p = structuredClone(V2); mutate(p);
    assert.equal(validatePolicy(p).ok, false);
    assert.equal(decide(engineFor(p), request()).decision, 'DENY');
  }
});

test('allowlist comparison is semantic exact equality, never substring or prefix matching', () => {
  const p = structuredClone(V2);
  p.approvalBoundaries[RUNTIME_RESTART_BOUNDARY].serviceAllowlist = ['kiwix-serve-extra'];
  assert.deepEqual(validatePolicy(p), { ok: true });
  assert.equal(decide(engineFor(p), request('kiwix-serve')).code, 'DENY_SERVICE_NOT_ALLOWLISTED');
  assert.equal(decide(engineFor(p), request('kiwix-serve-extra')).code, 'ALLOW_CERTIFIED_BOUNDARY');
});
