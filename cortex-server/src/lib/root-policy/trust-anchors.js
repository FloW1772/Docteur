/**
 * ROOT POLICY V1 — trust anchors (public keys allowed to sign the policy).
 *
 * These are CODE, not data: replacing or adding an anchor is a reviewed source change made by the machine owner (see ROOT POLICY RECOVERY in
 * reports/ROOT_POLICY_V1_2026-10.md). The matching private key is NOT in this repository nor in Docteur's data directory: it lives in an
 * offline, passphrase-encrypted file used only by root-policy-tool.mjs.
 */
export const TRUST_ANCHORS = Object.freeze([
  { keyId: '7b6352d8f75a0dc99e7478f9be2a43f2385e8b238d1c7c564e1e3a40b36887ac', alg: 'ed25519', publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA83INjC4p0HsPeJfe0+/O2fEAN9kzLbKljQ/JOwFR8rg=
-----END PUBLIC KEY-----` },
]);
