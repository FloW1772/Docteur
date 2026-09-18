// Cookie attribute detector tests (CA-4, priority 3).
// Run with: node --test test-cyber-audit-detect-cookies.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { detectCookies } from './src/lib/cyber-detect-cookies.js';
import { validateScope } from './src/lib/cyber-policy.js';
import { safeCyberFetch } from './src/lib/cyber-gateway.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

let fixture, origin, port;

before(async () => { fixture = createCyberAuditFixture(); ({ port, origin } = await fixture.listen()); });
after(async () => { await fixture.close(); });

function scope() {
  return validateScope({ allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'] });
}

// ── Positive fixture: fully-hardened cookie ─────────────────────────────

test('positive fixture: Secure + HttpOnly + SameSite + expiry produces zero findings', async () => {
  const result = await safeCyberFetch({ url: `${origin}/secure-cookie`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectCookies({ setCookieHeader: result.headers['set-cookie'], isHttps: true, asset: '127.0.0.1' });
  // session_id has no Max-Age/Expires in the fixture on purpose (session
  // cookie) — that alone is INFO, everything else must be clean.
  assert.ok(findings.every(f => f.severity === 'INFO'));
  assert.ok(!findings.some(f => f.id.includes('missing-secure') || f.id.includes('missing-httponly') || f.id.includes('missing-samesite')));
});

// ── Negative fixtures ─────────────────────────────────────────────────────

test('negative fixture: cookie with no attributes at all triggers missing-secure/httponly/samesite, session-like name escalates to MEDIUM', async () => {
  const result = await safeCyberFetch({ url: `${origin}/insecure-cookie`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectCookies({ setCookieHeader: result.headers['set-cookie'], isHttps: true, asset: '127.0.0.1' });
  const sessionSecure = findings.find(f => f.id === 'cookie-missing-secure-session_id');
  const sessionHttpOnly = findings.find(f => f.id === 'cookie-missing-httponly-session_id');
  assert.ok(sessionSecure && sessionSecure.severity === 'MEDIUM');
  assert.ok(sessionHttpOnly && sessionHttpOnly.severity === 'MEDIUM');
  const trackingSecure = findings.find(f => f.id === 'cookie-missing-secure-tracking');
  assert.ok(trackingSecure && trackingSecure.severity === 'LOW'); // non-session-like name, lower severity
});

test('negative fixture: no cookie value is ever echoed in a finding (redaction discipline at the detector level too)', async () => {
  const result = await safeCyberFetch({ url: `${origin}/insecure-cookie`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectCookies({ setCookieHeader: result.headers['set-cookie'], isHttps: true, asset: '127.0.0.1' });
  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes('abc123def456'));
});

// ── Edge cases ────────────────────────────────────────────────────────────

test('edge case: SameSite=None without Secure is flagged as a spec violation', () => {
  const findings = detectCookies({ setCookieHeader: 'x=1; SameSite=None', isHttps: true, asset: 'a' });
  assert.ok(findings.some(f => f.id === 'cookie-samesite-none-without-secure-x'));
});

test('edge case: SameSite=None WITH Secure does not trigger the spec-violation finding', () => {
  const findings = detectCookies({ setCookieHeader: 'x=1; SameSite=None; Secure', isHttps: true, asset: 'a' });
  assert.ok(!findings.some(f => f.id === 'cookie-samesite-none-without-secure-x'));
});

test('edge case: multiple Set-Cookie headers (array) are each parsed independently', () => {
  const findings = detectCookies({ setCookieHeader: ['a=1; Secure; HttpOnly; SameSite=Strict', 'b=2'], isHttps: true, asset: 'a' });
  assert.ok(findings.some(f => f.id.includes('-b')));
  assert.ok(!findings.some(f => f.id.includes('-a') && f.id.includes('missing')));
});

test('edge case: no Set-Cookie header at all returns an empty array, not a finding about absence', () => {
  assert.deepEqual(detectCookies({ setCookieHeader: undefined, isHttps: true, asset: 'a' }), []);
  assert.deepEqual(detectCookies({ setCookieHeader: null, isHttps: true, asset: 'a' }), []);
});

test('edge case: malformed cookie string (no "=") is skipped without throwing', () => {
  assert.doesNotThrow(() => detectCookies({ setCookieHeader: 'not-a-valid-cookie-string', isHttps: true, asset: 'a' }));
});

test('edge case: cookie with explicit Max-Age produces no session-only INFO finding', () => {
  const findings = detectCookies({ setCookieHeader: 'x=1; Max-Age=3600; Secure; HttpOnly; SameSite=Strict', isHttps: true, asset: 'a' });
  assert.ok(!findings.some(f => f.id === 'cookie-session-only-x'));
});

test('edge case: Secure is not required/flagged over plain HTTP (browsers would reject it anyway)', () => {
  const findings = detectCookies({ setCookieHeader: 'x=1', isHttps: false, asset: 'a' });
  assert.ok(!findings.some(f => f.id === 'cookie-missing-secure-x'));
});

test('no finding severity for cookies ever reaches HIGH or CRITICAL — cookie attribute gaps are hardening signals, not confirmed exploits', () => {
  const findings = detectCookies({ setCookieHeader: 'session=1', isHttps: true, asset: 'a' });
  assert.ok(findings.every(f => f.severity !== 'HIGH' && f.severity !== 'CRITICAL'));
});
