// Root Policy test history — three DISTINCT notions that tests must never mix:
//
//   1. HISTORICAL V1   the signed V1 pair that was active from 2026-10-01 to 2026-10-20, kept as a PUBLIC test fixture
//                      (fixtures/root-policy-v1-signed/) and verified against its OWN historical public anchor. It does not
//                      depend on the production TRUST_ANCHORS, so V1-compatibility tests keep working after the legacy anchor
//                      is retired from production (PHASE C), while production correctly rejects old-key policies.
//   2. SHIPPED POLICY  the reviewed policy currently shipped in policy/ (V2, signed 2026-10-20 by the rotation key). Tests that
//                      are explicitly about "the live policy" pin these exact values; a different file is a failure, not drift.
//   3. ACTIVE BYTES    version-neutral snapshot of the live pair + signing log, for "this test never mutates the real policy".
//
// Public material only: canonical policy, its signature, a public key. No private key, key path or passphrase.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndVerify } from '../src/lib/root-policy/loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const HISTORICAL_V1_DIR = path.join(HERE, 'root-policy-v1-signed');
export const HISTORICAL_V1 = Object.freeze({
  version: 1,
  sha256: '77706b420e6020bcddd4523abcd99d7a26c613381c0f072d61ee5e0dad049ee8',
  signatureFileSha256: '6a17338f8f9a1c6ccafc75b18316c71abb3cbea58842cfca048f1e3ee161af29',
  keyId: '7b6352d8f75a0dc99e7478f9be2a43f2385e8b238d1c7c564e1e3a40b36887ac',
  issuedAt: '2026-10-01T13:33:43.298Z',
});
/** The legacy V1 PUBLIC key, frozen here for historical verification only (never a production trust anchor source). */
export const HISTORICAL_V1_ANCHORS = Object.freeze([Object.freeze({
  keyId: HISTORICAL_V1.keyId, alg: 'ed25519', publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA83INjC4p0HsPeJfe0+/O2fEAN9kzLbKljQ/JOwFR8rg=
-----END PUBLIC KEY-----`,
})]);

/** Reads and VERIFIES the historical signed V1 (exact bytes, signature, isolated anchor). Throws on any mismatch. */
export function loadHistoricalV1() {
  const text = fs.readFileSync(path.join(HISTORICAL_V1_DIR, 'root-policy.json'), 'utf8');
  const sig = fs.readFileSync(path.join(HISTORICAL_V1_DIR, 'root-policy.sig.json'));
  if (sha256(Buffer.from(text, 'utf8')) !== HISTORICAL_V1.sha256) throw new Error('historical V1 fixture: policy bytes changed');
  if (sha256(sig) !== HISTORICAL_V1.signatureFileSha256) throw new Error('historical V1 fixture: signature bytes changed');
  const r = loadAndVerify({ policyDir: HISTORICAL_V1_DIR, trustAnchors: HISTORICAL_V1_ANCHORS, highestVersionSeen: 0 });
  if (!r.ok || r.version !== 1 || r.keyId !== HISTORICAL_V1.keyId) throw new Error(`historical V1 fixture does not verify: ${r.code ?? 'unexpected identity'}`);
  return Object.freeze({ text, policy: JSON.parse(text), verification: r });
}

export const SHIPPED_POLICY = Object.freeze({
  version: 2,
  sha256: 'a8e4f7b5f30b6000daa872d5e087bc180a59d92e082a6626c115f51d5ceb9bf9',
  keyId: 'd856e91e37a72ec39f1b087f8e3bea13f9995110c552feb0bb5dad0880b10054',
  issuedAt: '2026-10-19T00:00:00.000Z',
});

export const ACTIVE_POLICY_DIR = path.resolve(HERE, '..', 'policy');
const ACTIVE_FILES = Object.freeze(['root-policy.json', 'root-policy.sig.json', 'signing-log.jsonl']);
/** Version-neutral fingerprint of the live pair + signing log (absent file ⇒ 'absent'). Compare before/after a test. */
export function snapshotActivePolicy(dir = ACTIVE_POLICY_DIR) {
  return Object.fromEntries(ACTIVE_FILES.map(f => {
    const p = path.join(dir, f);
    return [f, fs.existsSync(p) ? sha256(fs.readFileSync(p)) : 'absent'];
  }));
}
