/**
 * ROOT POLICY V1 — trust anchors (public keys allowed to sign the policy).
 *
 * These are CODE, not data: replacing or adding an anchor is a reviewed source change made by the machine owner (see ROOT POLICY RECOVERY in
 * reports/ROOT_POLICY_V1_2026-10.md). The matching private key is NOT in this repository nor in Docteur's data directory: it lives in an
 * offline, passphrase-encrypted file used only by root-policy-tool.mjs.
 *
 * KEY ROTATION 2026-10 — PHASE A (transition set; see reports/DOCTEUR_ROOT_POLICY_KEY_ROTATION_2026-10.md):
 *   7b6352d8…  legacy V1 signing key — signs the active V1 only; its passphrase is unrecoverable. PENDING RETIREMENT: remove this entry
 *              (PHASE C) once V2 signed by the rotation key is active and highestVersionSeen = 2.
 *   d856e91e…  current rotation signing key — generated and passphrase-protected by the machine owner; signs V2 onwards.
 * Every entry is static: keyId = SHA-256 of the DER SPKI of publicKeyPem, unique in this list (checked by test-root-policy-key-rotation.mjs).
 */
export const TRUST_ANCHORS = Object.freeze([
  // legacy V1 signing key — pending retirement after successful V2 activation
  { keyId: '7b6352d8f75a0dc99e7478f9be2a43f2385e8b238d1c7c564e1e3a40b36887ac', alg: 'ed25519', publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA83INjC4p0HsPeJfe0+/O2fEAN9kzLbKljQ/JOwFR8rg=
-----END PUBLIC KEY-----` },
  // current rotation signing key (2026-10)
  { keyId: 'd856e91e37a72ec39f1b087f8e3bea13f9995110c552feb0bb5dad0880b10054', alg: 'ed25519', publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOpQuEki8iQ7bvgy5SI8FF4T72IVJlRriSahGVe74B7U=
-----END PUBLIC KEY-----` },
]);
