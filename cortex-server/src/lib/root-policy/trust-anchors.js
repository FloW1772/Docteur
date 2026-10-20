/**
 * ROOT POLICY V1 — trust anchors (public keys allowed to sign the policy).
 *
 * These are CODE, not data: replacing or adding an anchor is a reviewed source change made by the machine owner (see ROOT POLICY RECOVERY in
 * reports/ROOT_POLICY_V1_2026-10.md). The matching private key is NOT in this repository nor in Docteur's data directory: it lives in an
 * offline, passphrase-encrypted file used only by root-policy-tool.mjs.
 *
 * KEY ROTATION 2026-10 — PHASE C (final): the legacy V1 signing key 7b6352d8… is RETIRED and no longer trusted by production. It signed
 * only the historical V1 (its passphrase is unrecoverable); V1 is superseded by the signed V2 and refused by anti-rollback anyway. Historical
 * V1 compatibility tests verify against their own isolated public fixture (fixtures/root-policy-history.mjs), never against this list.
 *   d856e91e…  current rotation signing key — generated and passphrase-protected by the machine owner; signs V2 onwards.
 * Every entry is static: keyId = SHA-256 of the DER SPKI of publicKeyPem, unique in this list (checked by test-root-policy-key-rotation.mjs).
 */
export const TRUST_ANCHORS = Object.freeze([
  // current rotation signing key (2026-10)
  { keyId: 'd856e91e37a72ec39f1b087f8e3bea13f9995110c552feb0bb5dad0880b10054', alg: 'ed25519', publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOpQuEki8iQ7bvgy5SI8FF4T72IVJlRriSahGVe74B7U=
-----END PUBLIC KEY-----` },
]);
