// Security-header detector tests (CA-4, priority 2). Uses the local
// HTTP-only fixture server via safeCyberFetch for realistic response
// shapes, plus hand-built header objects for edge cases.
// Run with: node --test test-cyber-audit-detect-headers.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { detectHeaders } from './src/lib/cyber-detect-headers.js';
import { validateScope } from './src/lib/cyber-policy.js';
import { safeCyberFetch } from './src/lib/cyber-gateway.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

let fixture, origin, port;

before(async () => { fixture = createCyberAuditFixture(); ({ port, origin } = await fixture.listen()); });
after(async () => { await fixture.close(); });

function scope() {
  return validateScope({ allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'] });
}

// ── Positive fixture: a fully-hardened response ─────────────────────────

test('positive fixture: all recommended headers present produces zero findings', () => {
  const findings = detectHeaders({
    isHttps: true,
    asset: '127.0.0.1',
    headers: {
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'content-security-policy': "default-src 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'geolocation=()',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
  assert.deepEqual(findings, []);
});

// ── Negative fixtures: real target responses via the fixture server ─────

test('negative fixture: missing HSTS over HTTPS is reported (real fetch through the fixture, isHttps forced true for this test)', async () => {
  const result = await safeCyberFetch({ url: `${origin}/missing-hsts`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectHeaders({ headers: result.headers, isHttps: true, asset: '127.0.0.1' });
  assert.ok(findings.some(f => f.id === 'header-missing-hsts'));
});

test('negative fixture: HSTS is NOT expected/flagged over plain HTTP', async () => {
  const result = await safeCyberFetch({ url: `${origin}/missing-hsts`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectHeaders({ headers: result.headers, isHttps: false, asset: '127.0.0.1' });
  assert.ok(!findings.some(f => f.id.startsWith('header-missing-hsts')) && !findings.some(f => f.id.startsWith('header-hsts')));
});

test('negative fixture: weak/wildcard CSP is reported', async () => {
  const result = await safeCyberFetch({ url: `${origin}/weak-csp`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectHeaders({ headers: result.headers, isHttps: true, asset: '127.0.0.1' });
  const f = findings.find(x => x.id === 'header-weak-csp');
  assert.ok(f);
  assert.equal(f.severity, 'LOW');
});

test('negative fixture: fully bare response (fixture /ok) reports every missing-header finding, none escalated above MEDIUM', async () => {
  const result = await safeCyberFetch({ url: `${origin}/ok`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectHeaders({ headers: result.headers, isHttps: true, asset: '127.0.0.1' });
  assert.ok(findings.length >= 6); // hsts, csp, xcto, referrer-policy, permissions-policy, frame-protection, coop, corp
  assert.ok(findings.every(f => f.severity !== 'HIGH' && f.severity !== 'CRITICAL'));
});

// ── Edge cases ────────────────────────────────────────────────────────────

test('edge case: malformed HSTS (no max-age) is flagged distinctly from "missing"', () => {
  const findings = detectHeaders({ headers: { 'strict-transport-security': 'includeSubDomains' }, isHttps: true, asset: 'a' });
  assert.ok(findings.some(f => f.id === 'header-hsts-malformed'));
  assert.ok(!findings.some(f => f.id === 'header-missing-hsts'));
});

test('edge case: short HSTS max-age (< 180 days) flagged LOW, long max-age produces no HSTS finding', () => {
  const short = detectHeaders({ headers: { 'strict-transport-security': 'max-age=3600' }, isHttps: true, asset: 'a' });
  assert.ok(short.some(f => f.id === 'header-hsts-short-max-age'));
  const long = detectHeaders({ headers: { 'strict-transport-security': 'max-age=31536000' }, isHttps: true, asset: 'a' });
  assert.ok(!long.some(f => f.id.startsWith('header-hsts') || f.id === 'header-missing-hsts'));
});

test('edge case: CSP with frame-ancestors satisfies clickjacking protection even without X-Frame-Options', () => {
  const findings = detectHeaders({ headers: { 'content-security-policy': "frame-ancestors 'self'" }, isHttps: false, asset: 'a' });
  assert.ok(!findings.some(f => f.id === 'header-missing-frame-protection'));
});

test('edge case: header values as arrays (Node can return string[] for repeated headers) are handled without throwing', () => {
  assert.doesNotThrow(() => detectHeaders({ headers: { 'x-content-type-options': ['nosniff', 'nosniff'] }, isHttps: false, asset: 'a' }));
});

test('edge case: empty headers object produces the full set of missing-header findings, none HIGH/CRITICAL', () => {
  const findings = detectHeaders({ headers: {}, isHttps: false, asset: 'a' });
  assert.ok(findings.length > 0);
  assert.ok(findings.every(f => f.severity !== 'HIGH' && f.severity !== 'CRITICAL'));
});

test('edge case: null/undefined headers does not throw', () => {
  assert.doesNotThrow(() => detectHeaders({ headers: null, isHttps: false, asset: 'a' }));
  assert.doesNotThrow(() => detectHeaders({ headers: undefined, isHttps: false, asset: 'a' }));
});

test('no finding is ever labeled "vulnerable" — only observed/interpretation/recommendation language', () => {
  const findings = detectHeaders({ headers: {}, isHttps: true, asset: 'a' });
  for (const f of findings) {
    assert.ok(!/vulnérable|vulnerable/i.test(f.title));
    assert.ok(!/vulnérable|vulnerable/i.test(f.observed));
  }
});
