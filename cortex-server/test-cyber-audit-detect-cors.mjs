// CORS policy detector tests (CA-4, priority 4).
// Run with: node --test test-cyber-audit-detect-cors.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { detectCors } from './src/lib/cyber-detect-cors.js';
import { validateScope } from './src/lib/cyber-policy.js';
import { safeCyberCorsProbe } from './src/lib/cyber-gateway.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

let fixture, origin, port;

before(async () => { fixture = createCyberAuditFixture(); ({ port, origin } = await fixture.listen()); });
after(async () => { await fixture.close(); });

function scope() {
  return validateScope({ allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'] });
}

// ── Positive fixture: no CORS headers at all ────────────────────────────

test('positive fixture: no Access-Control-Allow-Origin header at all produces zero findings', async () => {
  const result = await safeCyberCorsProbe({ url: `${origin}/ok`, scope: scope(), allowPrivateFixture: true });
  const findings = detectCors({ headers: result.headers, probeOrigin: result.probeOrigin, asset: '127.0.0.1' });
  assert.deepEqual(findings, []);
});

// ── Negative fixtures ─────────────────────────────────────────────────────

test('negative fixture: reflected origin + credentials is the most severe CORS finding (HIGH/HIGH)', async () => {
  const result = await safeCyberCorsProbe({ url: `${origin}/reflected-cors`, scope: scope(), allowPrivateFixture: true });
  const findings = detectCors({ headers: result.headers, probeOrigin: result.probeOrigin, asset: '127.0.0.1' });
  const f = findings.find(x => x.id === 'cors-reflected-origin-with-credentials');
  assert.ok(f);
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.confidence, 'HIGH');
  assert.ok(f.observed.includes(result.probeOrigin));
});

test('negative fixture: bare wildcard + credentials header is a lower-severity misconfiguration finding (browsers reject the combo)', async () => {
  // The fixture's /broad-cors always sends "*" (never reflects), so this
  // exercises the wildcard+credentials branch specifically.
  const result = await safeCyberCorsProbe({ url: `${origin}/broad-cors`, scope: scope(), allowPrivateFixture: true });
  const findings = detectCors({ headers: result.headers, probeOrigin: result.probeOrigin, asset: '127.0.0.1' });
  const f = findings.find(x => x.id === 'cors-wildcard-with-credentials-header');
  assert.ok(f);
  assert.equal(f.severity, 'LOW');
});

test('negative fixture: bare wildcard without credentials is INFO only', () => {
  const findings = detectCors({ headers: { 'access-control-allow-origin': '*' }, probeOrigin: 'https://probe.invalid', asset: 'a' });
  const f = findings.find(x => x.id === 'cors-wildcard-origin');
  assert.ok(f);
  assert.equal(f.severity, 'INFO');
});

test('negative fixture: reflected origin without credentials is MEDIUM, not HIGH', () => {
  const probeOrigin = 'https://probe.invalid';
  const findings = detectCors({ headers: { 'access-control-allow-origin': probeOrigin }, probeOrigin, asset: 'a' });
  const f = findings.find(x => x.id === 'cors-reflected-origin');
  assert.ok(f);
  assert.equal(f.severity, 'MEDIUM');
});

// ── Edge cases ────────────────────────────────────────────────────────────

test('edge case: allow-credentials as a non-"true" string (e.g. "True", "1") is NOT treated as enabled except exact case-insensitive "true"', () => {
  const findingsTrue = detectCors({ headers: { 'access-control-allow-origin': 'https://probe.invalid', 'access-control-allow-credentials': 'True' }, probeOrigin: 'https://probe.invalid', asset: 'a' });
  assert.ok(findingsTrue.some(f => f.id === 'cors-reflected-origin-with-credentials'));
  const findingsOne = detectCors({ headers: { 'access-control-allow-origin': 'https://probe.invalid', 'access-control-allow-credentials': '1' }, probeOrigin: 'https://probe.invalid', asset: 'a' });
  assert.ok(!findingsOne.some(f => f.id === 'cors-reflected-origin-with-credentials'));
  assert.ok(findingsOne.some(f => f.id === 'cors-reflected-origin')); // still flagged, just not the credentials variant
});

test('edge case: null/undefined headers does not throw and returns no findings', () => {
  assert.deepEqual(detectCors({ headers: null, probeOrigin: 'https://probe.invalid', asset: 'a' }), []);
  assert.deepEqual(detectCors({ headers: undefined, probeOrigin: 'https://probe.invalid', asset: 'a' }), []);
});

test('edge case: allow-origin equal to a THIRD-PARTY origin (neither "*" nor the probe origin) produces no finding — not our probe being reflected', () => {
  const findings = detectCors({ headers: { 'access-control-allow-origin': 'https://some-other-allowed-origin.example' }, probeOrigin: 'https://probe.invalid', asset: 'a' });
  assert.deepEqual(findings, []);
});

test('never asserts exploitation — CORS findings describe an observed header combination, hedged interpretation only', async () => {
  const result = await safeCyberCorsProbe({ url: `${origin}/reflected-cors`, scope: scope(), allowPrivateFixture: true });
  const findings = detectCors({ headers: result.headers, probeOrigin: result.probeOrigin, asset: '127.0.0.1' });
  for (const f of findings) {
    assert.ok(/pourrait|peut|potentiellement|à confirmer|suggère/i.test(f.interpretation), `interpretation must be hedged: "${f.interpretation}"`);
  }
});
