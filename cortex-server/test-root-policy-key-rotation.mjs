// Root Policy — signing-key rotation / trust-anchor migration harness.
//
// Three separate concerns, never mixed:
//   A. HISTORICAL   the signed V1 fixture + the legacy V1 PUBLIC key (fixtures/root-policy-history.mjs), verified in isolation —
//                   independent of the production trust anchors, so it survives the PHASE C retirement of the legacy anchor.
//   B. PRODUCTION   the shipped V2 in policy/ (signed 2026-10-20 by the rotation key) against the production TRUST_ANCHORS (read-only).
//   C. TRANSITION   the rotation rehearsed with THROW-AWAY FIXTURE keys in temp directories:
//     PHASE 0  anchors = [OLD]          V1(OLD) active
//     PHASE A  anchors = [OLD, NEW]     V1(OLD) still VALID, V2(NEW) verifiable          (reviewed trust-anchors.js change + Docteur restart)
//     PHASE B  V2(NEW) signed + active  highestVersionSeen = 2, V1 replay refused         (human `sign` ceremony — done 2026-10-20)
//     PHASE C  anchors = [NEW]          V2(NEW) VALID, anything signed by OLD UNTRUSTED   (reviewed trust-anchors.js change + Docteur restart)
// The real policy/ directory, the real anti-rollback state and the real signing keys are never written, decrypted or used to sign.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCandidateText } from './root-policy-v2-candidate.mjs';
import { buildDefaultPolicy } from './src/lib/root-policy/default-policy.js';
import { POLICY_FILE, SIGNATURE_FILE, loadAndVerify, readRollbackState } from './src/lib/root-policy/loader.js';
import { __testing, getRootPolicyStatus, initRootPolicy } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';
import { keyIdOf, signPolicy } from './root-policy-tool.mjs';
import { HISTORICAL_V1, HISTORICAL_V1_ANCHORS, HISTORICAL_V1_DIR, SHIPPED_POLICY, loadHistoricalV1 } from './fixtures/root-policy-history.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2_CANDIDATE_SHA256 = SHIPPED_POLICY.sha256;
const REAL_OLD_KEY_ID = HISTORICAL_V1.keyId;
const REAL_NEW_KEY_ID = SHIPPED_POLICY.keyId;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-rp-rotation-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(scratch, `d${++n}`);

const keyPair = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
const anchorOf = (key) => ({ keyId: keyIdOf(key.publicPem), alg: 'ed25519', publicKeyPem: key.publicPem });
const FIXTURE_OLD = keyPair();
const FIXTURE_NEW = keyPair();
const PHASE_0 = Object.freeze([anchorOf(FIXTURE_OLD)]);
const PHASE_A = Object.freeze([anchorOf(FIXTURE_OLD), anchorOf(FIXTURE_NEW)]);
const PHASE_C = Object.freeze([anchorOf(FIXTURE_NEW)]);

const V1_POLICY = () => buildDefaultPolicy({ version: 1, issuedAt: '2026-10-01T00:00:00.000Z' });
const V2_POLICY = () => JSON.parse(buildCandidateText({ issuedAt: '2026-10-19T00:00:00.000Z' }));
const signInto = (dir, policy, key) => signPolicy({ policy, privateKeyPem: key.privatePem, publicKeyPem: key.publicPem, policyDir: dir }).sig;
const verify = (dir, trustAnchors, highestVersionSeen = 0) => loadAndVerify({ policyDir: dir, trustAnchors, highestVersionSeen });
const pairIn = (policy, key) => { const dir = freshDir(); signInto(dir, policy, key); return dir; };

test('fixture keys are distinct from each other and from the real (retiring) V1 anchor', () => {
  const ids = [anchorOf(FIXTURE_OLD).keyId, anchorOf(FIXTURE_NEW).keyId];
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.ok(!TRUST_ANCHORS.some(a => a.keyId === id), 'a fixture key must never be a real trust anchor');
  assert.ok(!ids.includes(REAL_OLD_KEY_ID));
});

test('the ceremony signs exactly the reviewed V2 candidate bytes (sha256 a8e4f7b5…) when given that file', () => {
  const sig = signInto(freshDir(), V2_POLICY(), FIXTURE_NEW);
  assert.equal(sig.version, 2);
  assert.equal(sig.sha256, V2_CANDIDATE_SHA256);
  // Without --policy the tool rebuilds the default policy with a NEW issuedAt: the signed bytes would no longer be the reviewed candidate.
  const rebuilt = signInto(freshDir(), buildDefaultPolicy({ version: 2, issuedAt: '2026-10-21T00:00:00.000Z' }), FIXTURE_NEW);
  assert.notEqual(rebuilt.sha256, V2_CANDIDATE_SHA256);
});

test('C. PHASE 0: V1 signed by OLD is VALID; V2 signed by NEW is not yet trusted', () => {
  assert.equal(verify(pairIn(V1_POLICY(), FIXTURE_OLD), PHASE_0).ok, true);
  const r = verify(pairIn(V2_POLICY(), FIXTURE_NEW), PHASE_0);
  assert.deepEqual([r.ok, r.code], [false, 'TRUST_ANCHOR_UNKNOWN']);
});

test('PHASE A (transition set): V1(OLD) stays VALID and V2(NEW) verifies', () => {
  const v1 = verify(pairIn(V1_POLICY(), FIXTURE_OLD), PHASE_A, 1);
  assert.deepEqual([v1.ok, v1.version, v1.keyId], [true, 1, anchorOf(FIXTURE_OLD).keyId]);
  const v2 = verify(pairIn(V2_POLICY(), FIXTURE_NEW), PHASE_A, 1);
  assert.deepEqual([v2.ok, v2.version, v2.keyId, v2.sha256], [true, 2, anchorOf(FIXTURE_NEW).keyId, V2_CANDIDATE_SHA256]);
});

test('PHASE A window: the transition set still accepts a NEW version signed by OLD (why PHASE C must follow quickly)', () => {
  // Anchors are a flat set: any trusted key may sign any version. The real OLD key's passphrase is unrecoverable, so this is a residual,
  // not an expected path — but it is exactly what PHASE C closes.
  const r = verify(pairIn(buildDefaultPolicy({ version: 3, issuedAt: '2026-10-22T00:00:00.000Z' }), FIXTURE_OLD), PHASE_A, 2);
  assert.equal(r.ok, true);
});

test('ordering hazard: a running server still holding PHASE 0 anchors goes INVALID (fail-closed) if V2(NEW) lands before the restart', () => {
  const dir = freshDir(); const data = freshDir();
  signInto(dir, V1_POLICY(), FIXTURE_OLD);
  assert.equal(initRootPolicy({ policyDir: dir, dataDir: data, trustAnchors: PHASE_0 }).state, 'VALID');
  signInto(dir, V2_POLICY(), FIXTURE_NEW);
  __testing.reload();
  const s = getRootPolicyStatus();
  assert.deepEqual([s.state, s.errorCode, s.protectedOperations], ['INVALID', 'TRUST_ANCHOR_UNKNOWN', 'FAIL_CLOSED']);
  assert.equal(readRollbackState(data).highestVersionSeen, 1, 'anti-rollback not advanced by an untrusted file');
});

test('PHASE A → B on a running server: never a moment without a VALID trusted policy; anti-rollback advances to 2', () => {
  const dir = freshDir(); const data = freshDir();
  signInto(dir, V1_POLICY(), FIXTURE_OLD);
  // Docteur restarted on the PHASE A code: V1 is still the active, VALID policy.
  let s = initRootPolicy({ policyDir: dir, dataDir: data, trustAnchors: PHASE_A });
  assert.deepEqual([s.state, s.version, s.keyId], ['VALID', 1, anchorOf(FIXTURE_OLD).keyId.slice(0, 16)]);
  assert.equal(readRollbackState(data).highestVersionSeen, 1);
  // Ceremony: V2 signed by NEW replaces the pair in place.
  signInto(dir, V2_POLICY(), FIXTURE_NEW);
  __testing.reload();
  s = getRootPolicyStatus();
  assert.deepEqual([s.state, s.version, s.keyId, s.sha256], ['VALID', 2, anchorOf(FIXTURE_NEW).keyId.slice(0, 16), V2_CANDIDATE_SHA256.slice(0, 16)]);
  assert.equal(readRollbackState(data).highestVersionSeen, 2);
  // The tool kept V1(OLD) as the recovery copy; replaying it is now refused as a rollback even though OLD is still trusted.
  const recovery = verify(path.join(dir, 'recovery'), PHASE_A, 2);
  assert.deepEqual([recovery.ok, recovery.code], [false, 'ROLLBACK_DETECTED']);
});

test('PHASE C (retirement): V2(NEW) VALID after restart; V1(OLD) and any future OLD signature UNTRUSTED', () => {
  const dir = freshDir(); const data = freshDir();
  signInto(dir, V1_POLICY(), FIXTURE_OLD);
  signInto(dir, V2_POLICY(), FIXTURE_NEW);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ highestVersionSeen: 2 }));
  const s = initRootPolicy({ policyDir: dir, dataDir: data, trustAnchors: PHASE_C });
  assert.deepEqual([s.state, s.version, s.keyId], ['VALID', 2, anchorOf(FIXTURE_NEW).keyId.slice(0, 16)]);
  for (const [label, policy] of [['V1 replay', V1_POLICY()], ['future V3', buildDefaultPolicy({ version: 3, issuedAt: '2026-10-22T00:00:00.000Z' })]]) {
    const r = verify(pairIn(policy, FIXTURE_OLD), PHASE_C, 2);
    assert.deepEqual([r.ok, r.code], [false, 'TRUST_ANCHOR_UNKNOWN'], label);
  }
  assert.equal(verify(path.join(dir, 'recovery'), PHASE_C, 0).code, 'TRUST_ANCHOR_UNKNOWN', 'V1 recovery copy is dead after retirement');
  assert.equal(verify(pairIn(buildDefaultPolicy({ version: 3, issuedAt: '2026-10-22T00:00:00.000Z' }), FIXTURE_NEW), PHASE_C, 2).ok, true, 'NEW keeps signing');
});

test('a signature cannot be re-attributed: OLD signature relabelled with the NEW keyId is refused', () => {
  const dir = pairIn(V2_POLICY(), FIXTURE_OLD);
  const sigPath = path.join(dir, SIGNATURE_FILE);
  const sig = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
  fs.writeFileSync(sigPath, JSON.stringify({ ...sig, keyId: anchorOf(FIXTURE_NEW).keyId }));
  assert.deepEqual([verify(dir, PHASE_C).ok, verify(dir, PHASE_C).code], [false, 'SIGNATURE_INVALID']);
  assert.ok(fs.existsSync(path.join(dir, POLICY_FILE)));
});

// ── A. HISTORICAL (isolated from the production trust anchors) ─────────────────────────────────────────────────────────

test('A. HISTORICAL: the signed V1 fixture verifies with its own historical public anchor only', () => {
  const { verification: r } = loadHistoricalV1();
  assert.deepEqual([r.ok, r.version, r.sha256, r.keyId], [true, 1, HISTORICAL_V1.sha256, REAL_OLD_KEY_ID]);
  assert.equal(keyIdOf(HISTORICAL_V1_ANCHORS[0].publicKeyPem), REAL_OLD_KEY_ID, 'the historical anchor is self-consistent');
  assert.deepEqual(HISTORICAL_V1_ANCHORS.map(a => a.keyId), [REAL_OLD_KEY_ID], 'exactly the legacy public key, nothing else');
});

test('A. HISTORICAL: once V2 has been accepted (highestVersionSeen = 2) the historical V1 is a rollback — whatever the anchor set', () => {
  const isolated = loadAndVerify({ policyDir: HISTORICAL_V1_DIR, trustAnchors: HISTORICAL_V1_ANCHORS, highestVersionSeen: 2 });
  assert.deepEqual([isolated.ok, isolated.code], [false, 'ROLLBACK_DETECTED']);
  // Production: ROLLBACK_DETECTED while the legacy anchor is still listed (PHASE A), TRUST_ANCHOR_UNKNOWN after PHASE C — refused either way.
  const production = loadAndVerify({ policyDir: HISTORICAL_V1_DIR, trustAnchors: TRUST_ANCHORS, highestVersionSeen: 2 });
  assert.equal(production.ok, false);
  assert.ok(['ROLLBACK_DETECTED', 'TRUST_ANCHOR_UNKNOWN'].includes(production.code), production.code);
});

// ── REAL PHASE A trust set (public material only; the new private key is never read) ───────────────────────────────────

test('REAL PHASE A: exactly the legacy V1 anchor then the rotation anchor, each static, self-consistent and unique', () => {
  assert.deepEqual(TRUST_ANCHORS.map(a => a.keyId), [REAL_OLD_KEY_ID, REAL_NEW_KEY_ID]);
  assert.ok(Object.isFrozen(TRUST_ANCHORS));
  assert.equal(new Set(TRUST_ANCHORS.map(a => a.keyId)).size, TRUST_ANCHORS.length, 'no duplicate keyId');
  for (const a of TRUST_ANCHORS) {
    assert.deepEqual(Object.keys(a).sort(), ['alg', 'keyId', 'publicKeyPem']);
    assert.equal(a.alg, 'ed25519');
    assert.match(a.keyId, /^[0-9a-f]{64}$/);
    assert.equal(crypto.createPublicKey(a.publicKeyPem).asymmetricKeyType, 'ed25519');
    assert.equal(keyIdOf(a.publicKeyPem), a.keyId, 'keyId is bound to the public key (a same-keyId, different-key duplicate is impossible)');
  }
});

test('REAL PHASE A: anchors are code — no file, env or directory based loading in trust-anchors.js', () => {
  const source = fs.readFileSync(path.join(HERE, 'src', 'lib', 'root-policy', 'trust-anchors.js'), 'utf8');
  assert.doesNotMatch(source, /\bimport\b|\brequire\s*\(|process\.env|readFileSync|readdir|fetch\s*\(/);
  assert.doesNotMatch(source, /PRIVATE KEY|signing-key\.enc\.json|ROOT_POLICY_PASSPHRASE/, 'no private material, key path or passphrase hook in source');
});

// ── B. PRODUCTION (read-only: the shipped policy in policy/ against the production anchors) ─────────────────────────────

test('B. PRODUCTION: the shipped policy is exactly the reviewed V2 signed by the rotation key, and stays valid at highestVersionSeen = 2', () => {
  const r = loadAndVerify({ policyDir: path.join(HERE, 'policy'), trustAnchors: TRUST_ANCHORS, highestVersionSeen: 2 });
  assert.deepEqual([r.ok, r.version, r.sha256, r.keyId], [true, SHIPPED_POLICY.version, SHIPPED_POLICY.sha256, REAL_NEW_KEY_ID]);
  assert.equal(r.canonical, buildCandidateText({ issuedAt: SHIPPED_POLICY.issuedAt }), 'the shipped bytes are the reviewed candidate rebuilt from code');
});

test('B. PRODUCTION: the shipped V2 depends on the rotation anchor only (never on the legacy key)', () => {
  const dir = path.join(HERE, 'policy');
  const rotationOnly = TRUST_ANCHORS.filter(a => a.keyId === REAL_NEW_KEY_ID);
  assert.equal(rotationOnly.length, 1, 'root-policy-tool sign precondition: the rotation key is a trust anchor');
  assert.equal(loadAndVerify({ policyDir: dir, trustAnchors: rotationOnly, highestVersionSeen: 2 }).ok, true);
  assert.equal(loadAndVerify({ policyDir: dir, trustAnchors: HISTORICAL_V1_ANCHORS, highestVersionSeen: 2 }).code, 'TRUST_ANCHOR_UNKNOWN', 'the legacy key did not sign it');
});

// ── trust-set contract with FIXTURE keys ──────────────────────────────────────────────────────────────────────────────

test('transition set accepts a signature from either listed key and rejects an unknown key', () => {
  for (const key of [FIXTURE_OLD, FIXTURE_NEW]) assert.equal(verify(pairIn(V2_POLICY(), key), PHASE_A, 1).ok, true);
  const r = verify(pairIn(V2_POLICY(), keyPair()), PHASE_A, 1);
  assert.deepEqual([r.ok, r.code, r.tamper], [false, 'TRUST_ANCHOR_UNKNOWN', true]);
});

test('duplicate keyId bound to a different public key cannot widen trust: first match is used and the forgery fails closed', () => {
  const ATTACKER = keyPair();
  const forged = [{ ...anchorOf(FIXTURE_NEW), publicKeyPem: ATTACKER.publicPem }, anchorOf(FIXTURE_NEW)];
  // A signature by the attacker relabelled as NEW never verifies against NEW, and the genuine NEW signature fails against the bogus entry.
  const attackerDir = pairIn(V2_POLICY(), ATTACKER);
  const sigPath = path.join(attackerDir, SIGNATURE_FILE);
  fs.writeFileSync(sigPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(sigPath, 'utf8')), keyId: anchorOf(FIXTURE_NEW).keyId }));
  assert.equal(verify(attackerDir, PHASE_A).code, 'SIGNATURE_INVALID');
  assert.equal(verify(pairIn(V2_POLICY(), FIXTURE_NEW), forged).code, 'SIGNATURE_INVALID');
  assert.notEqual(keyIdOf(forged[0].publicKeyPem), forged[0].keyId, 'the contract check above would reject such an entry in the real list');
});

test('malformed anchors fail closed (never throw, never verify)', () => {
  const dir = pairIn(V2_POLICY(), FIXTURE_NEW);
  const id = anchorOf(FIXTURE_NEW).keyId;
  const rsaPem = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  for (const [label, anchor] of [
    ['garbage PEM', { keyId: id, alg: 'ed25519', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----' }],
    ['empty PEM', { keyId: id, alg: 'ed25519', publicKeyPem: '' }],
    ['missing PEM', { keyId: id, alg: 'ed25519' }],
    ['wrong key type (RSA)', { keyId: id, alg: 'ed25519', publicKeyPem: rsaPem }],
    ['private key in place of public', { keyId: id, alg: 'ed25519', publicKeyPem: FIXTURE_OLD.privatePem }],
  ]) {
    let r; assert.doesNotThrow(() => { r = verify(dir, [anchor]); }, label);
    assert.deepEqual([r.ok, r.code], [false, 'SIGNATURE_INVALID'], label);
  }
  for (const [label, anchor] of [['wildcard keyId', { ...anchorOf(FIXTURE_NEW), keyId: '*' }], ['truncated keyId', { ...anchorOf(FIXTURE_NEW), keyId: id.slice(0, 16) }], ['upper-case keyId', { ...anchorOf(FIXTURE_NEW), keyId: id.toUpperCase() }]]) {
    assert.equal(verify(dir, [anchor]).code, 'TRUST_ANCHOR_UNKNOWN', `${label}: keyIds match exactly, never by pattern or prefix`);
  }
});
