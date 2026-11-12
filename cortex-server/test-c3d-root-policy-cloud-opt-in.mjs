// C3d — Root Policy enforceCloudAi: the cloud is open only when cloudEnabled is exactly the boolean `true`.
// An absent, null, string, numeric or object value is refused (DENY_CLOUD_NOT_ENABLED), like an explicit false.
// Strict Local still wins, secret exposure is still refused, and an explicit true still works. The signed policy
// document (policy/root-policy.json + .sig.json) is not touched: only the engine's typed-context conversion changes.
// Run: node --test test-c3d-root-policy-cloud-opt-in.mjs
//
// Isolation: Root Policy loaded read-only from ./policy with an in-memory audit (no dataDir), no database, no network.
import './test-setup.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRootPolicy, enforceCloudAi, getRootPolicyStatus } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.join(HERE, 'policy');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(POLICY, f))).digest('hex');
const SIGNED = ['root-policy.json', 'root-policy.sig.json'];
let signedBefore;

const msgs = [{ role: 'user', content: 'C3d synthetic question' }];
const NOT_TRUE = [undefined, null, false, 'true', 'false', 1, 0, '', 'yes', {}, []];
const label = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));
const deniedWith = (code) => (e) => e?.rootPolicyDenied === true && e.decisionCode === code;
const call = (o) => () => enforceCloudAi({ provider: 'gemini', messages: msgs, ...o });

before(() => {
  signedBefore = SIGNED.map(sha);
  initRootPolicy({ policyDir: POLICY, trustAnchors: TRUST_ANCHORS });
});

test('the signed policy loads and verifies (unchanged document, valid signature)', () => {
  const s = getRootPolicyStatus();
  assert.equal(s.state, 'VALID', JSON.stringify(s));
  assert.equal(s.integrity, 'VERIFIED');
  assert.deepEqual(SIGNED.map(sha), signedBefore, 'signed files untouched');
});

test('explicit cloudEnabled === true (Strict Local off) is allowed', () => {
  const d = call({ strictLocal: false, cloudEnabled: true })();
  assert.equal(d.decision, 'ALLOW');
});

test('absent, null, false, string, numeric and object values are refused (cloud not enabled)', () => {
  for (const v of NOT_TRUE) {
    assert.throws(call({ strictLocal: false, cloudEnabled: v }), deniedWith('DENY_CLOUD_NOT_ENABLED'), `cloudEnabled=${label(v)}`);
  }
  assert.throws(() => enforceCloudAi({ provider: 'gemini', messages: msgs, strictLocal: false }), deniedWith('DENY_CLOUD_NOT_ENABLED'), 'field omitted');
});

test('Strict Local still wins, whatever cloudEnabled says', () => {
  for (const v of [true, ...NOT_TRUE]) assert.throws(call({ strictLocal: true, cloudEnabled: v }), deniedWith('DENY_STRICT_LOCAL'), `cloudEnabled=${label(v)}`);
});

test('secret exposure is still refused with an explicit opt-in', () => {
  const secret = [{ role: 'user', content: `cle sk-ant-${'x'.repeat(30)}` }];
  assert.throws(() => enforceCloudAi({ provider: 'gemini', messages: secret, strictLocal: false, cloudEnabled: true }), deniedWith('DENY_SECRET_EXPOSURE'));
});

test('existing callers keep their decisions: privacy guard and Whisper pass === true, image router passes true', () => {
  const read = (p) => fs.readFileSync(path.join(HERE, 'src', 'lib', p), 'utf8');
  assert.match(read('privacy-guard.js'), /cloudEnabled: settings\?\.cloud_enabled === true/);
  assert.match(read('whisper-groq.js'), /cloudEnabled: settings\?\.cloud_enabled === true/);
  assert.match(read('image-router.js'), /enforceCloudAi\(\{.*cloudEnabled: true \}\);/);
  assert.match(read('root-policy/index.js'), /cloudEnabled: cloudEnabled === true/);
});
