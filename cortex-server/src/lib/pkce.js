// PKCE (RFC 7636) helpers for the Connector Center OAuth flows (Batch D).
//
// Only S256 is ever offered — 'plain' is intentionally not implemented,
// since every provider this app talks to (Google, Microsoft) supports S256
// and it is the only variant that actually protects the authorization code
// if it leaks (a 'plain' challenge is just the verifier itself).

import crypto from 'node:crypto';

export const PKCE_METHOD = 'S256';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 7636 recommends a verifier of 43-128 characters from the unreserved
// URL character set; 32 random bytes base64url-encoded yields 43 chars.
export function generateCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}

export function deriveCodeChallenge(codeVerifier) {
  return base64url(crypto.createHash('sha256').update(codeVerifier).digest());
}
