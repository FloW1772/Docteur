// Root Policy — actor/version scope of the owned-Kiwix PROCESS_STOP exception (regression for the too-broad engine f16bc002…).
//
// The engine lets the Kiwix lifecycle stop its OWN child under V2 without the MAITRE approval boundary. That exception must stay narrow:
//   A. under V2 (rebuilt from the reviewed code = the shipped signed V2) only USER and MODULE get ALLOW_STOP_ALWAYS; every
//      attacker-influenceable actor kind is denied;
//   B. under the HISTORICAL signed V1 (fixtures/root-policy-v1-signed, verified with its own historical anchor) the Kiwix
//      PROCESS_STOP decisions are exactly the HEAD (37c80c8) V1 decisions — never ALLOW.
// The V1 expectations below were derived by running the HEAD engine (e629fb8b…) over the same requests, not written by hand.
//
// ROOT_POLICY_ENGINE_UNDER_TEST=<path to an engine.js> runs these checks against another engine (used to prove they fail on f16bc002…).
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCandidateText } from './root-policy-v2-candidate.mjs';
import { HISTORICAL_V1, SHIPPED_POLICY, loadHistoricalV1 } from './fixtures/root-policy-history.mjs';
import { ACTORS } from './src/lib/root-policy/schema.js';

const enginePath = process.env.ROOT_POLICY_ENGINE_UNDER_TEST
  ? pathToFileURL(path.resolve(process.env.ROOT_POLICY_ENGINE_UNDER_TEST)).href
  : new URL('./src/lib/root-policy/engine.js', import.meta.url).href;
const { createEngine } = await import(enginePath);

const HISTORICAL = loadHistoricalV1();
const V1 = HISTORICAL.policy;
const V2_TEXT = buildCandidateText({ issuedAt: SHIPPED_POLICY.issuedAt });
const V2 = JSON.parse(V2_TEXT);
const engineFor = (policy) => createEngine({ getPolicy: () => ({ valid: true, policy, version: policy.version }) });

const STOP_ALLOWED = ['USER', 'MODULE'];
const STOP_DENIED = ['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'PLUGIN', 'MCP', 'REMOTE', 'CONNECTOR', 'DOCUMENT'];
const OWNED = { serviceId: 'kiwix-serve', ownership: 'OWNED_CHILD' };
const stop = (kind, over = {}) => ({
  action: 'PROCESS_STOP', module: 'kiwix', trustDomain: 'PROCESS', actor: { kind }, userInitiated: true, context: { ...OWNED }, ...over,
});
const pair = (d) => [d.decision, d.code];

test('the actor lists cover every actor kind the schema knows', () => {
  assert.deepEqual([...STOP_ALLOWED, ...STOP_DENIED].sort(), [...ACTORS].sort());
});

test('A. V2: owned Kiwix PROCESS_STOP is ALLOW_STOP_ALWAYS for USER and MODULE only', () => {
  assert.equal(V2.version, 2);
  const e2 = engineFor(V2);
  for (const kind of STOP_ALLOWED) {
    for (const userInitiated of [true, false]) {
      assert.deepEqual(pair(e2.decide(stop(kind, { userInitiated }))), ['ALLOW', 'ALLOW_STOP_ALWAYS'], `${kind} userInitiated=${userInitiated}`);
    }
  }
  for (const kind of STOP_DENIED) {
    for (const userInitiated of [true, false]) {
      for (const certifiedBoundary of [undefined, true]) {
        const d = e2.decide(stop(kind, { userInitiated, certifiedBoundary }));
        assert.equal(d.decision, 'DENY', `${kind} userInitiated=${userInitiated} certifiedBoundary=${certifiedBoundary} must be denied`);
        assert.notEqual(d.code, 'ALLOW_STOP_ALWAYS', kind);
      }
    }
  }
});

test('A. V2: the exception needs the exact owned-child descriptor (no widening through context)', () => {
  const e2 = engineFor(V2);
  for (const context of [{ serviceId: 'kiwix-serve' }, { serviceId: 'kiwix-serve', ownership: 'EXTERNAL' }, { serviceId: 'ollama', ownership: 'OWNED_CHILD' }, {}]) {
    assert.notEqual(e2.decide(stop('USER', { context })).code, 'ALLOW_STOP_ALWAYS', JSON.stringify(context));
  }
  assert.notEqual(e2.decide(stop('USER', { trustDomain: 'RUNTIME' })).code, 'ALLOW_STOP_ALWAYS', 'trust domain must be PROCESS');
  assert.notEqual(e2.decide(stop('USER', { module: 'maitre' })).code, 'ALLOW_STOP_ALWAYS', 'module must be kiwix');
});

test('the policies under test are the historical signed V1 and the reviewed shipped V2 (exact identities)', () => {
  const r = HISTORICAL.verification;
  assert.deepEqual([r.ok, r.version, r.sha256, r.keyId], [true, 1, HISTORICAL_V1.sha256, HISTORICAL_V1.keyId], 'historical V1 verified with its own historical anchor');
  assert.equal(crypto.createHash('sha256').update(V2_TEXT, 'utf8').digest('hex'), SHIPPED_POLICY.sha256, 'V2 rebuilt from the reviewed code = the shipped signed V2 bytes');
});

test('B. V1: Kiwix PROCESS_STOP decisions are identical to HEAD (never ALLOW, no stop-always exception)', () => {
  const e1 = engineFor(V1);
  // HEAD V1 semantics: `kiwix` is not a V1 module and only USER/MODULE may ever request PROCESS_STOP.
  const expectedOnProcess = (kind) => (STOP_ALLOWED.includes(kind) ? ['DENY', 'DENY_UNKNOWN_MODULE'] : ['DENY', 'DENY_ACTOR_NOT_PERMITTED']);
  const expectedOnRuntime = (kind) => (STOP_ALLOWED.includes(kind) ? ['DENY', 'DENY_TRUST_DOMAIN_MISMATCH'] : ['DENY', 'DENY_ACTOR_NOT_PERMITTED']);
  const contexts = [OWNED, { serviceId: 'kiwix-serve' }, { serviceId: 'kiwix-serve', ownership: 'EXTERNAL' }, { serviceId: 'ollama', ownership: 'OWNED_CHILD' }, {}];
  for (const kind of ACTORS) {
    for (const context of contexts) {
      for (const userInitiated of [true, false]) {
        for (const certifiedBoundary of [undefined, true]) {
          const label = `${kind} ${JSON.stringify(context)} ui=${userInitiated} cb=${certifiedBoundary}`;
          assert.deepEqual(pair(e1.decide(stop(kind, { context, userInitiated, certifiedBoundary }))), expectedOnProcess(kind), label);
          assert.deepEqual(pair(e1.decide(stop(kind, { context, userInitiated, certifiedBoundary, trustDomain: 'RUNTIME' }))), expectedOnRuntime(kind), `${label} RUNTIME`);
        }
      }
    }
  }
});

test('B. V1: the MAITRE stop boundary is untouched', () => {
  const e1 = engineFor(V1);
  const maitre = (over = {}) => ({ action: 'PROCESS_STOP', module: 'maitre', trustDomain: 'MAITRE', actor: { kind: 'USER' }, ...over });
  assert.deepEqual(pair(e1.decide(maitre({ certifiedBoundary: true }))), ['ALLOW', 'ALLOW_CERTIFIED_BOUNDARY']);
  assert.equal(e1.decide(maitre()).decision, 'REQUIRE_APPROVAL');
});
