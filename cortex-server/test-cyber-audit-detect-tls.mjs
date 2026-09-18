// TLS detector tests (CA-4, priority 1). Per mission instruction: stay on
// controlled mock objects shaped exactly like safeCyberTlsInspect()'s real
// return value — no local certificate generation, no OpenSSL dependency,
// no live TLS handshake in this file.
// Run with: node --test test-cyber-audit-detect-tls.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectTls } from './src/lib/cyber-detect-tls.js';

const NOW = new Date('2026-09-18T00:00:00Z');
const ASSET = 'example.invalid:443';

function findingIds(findings) { return findings.map(f => f.id); }

// ── Positive fixture: a healthy, modern TLS configuration ──────────────

test('positive fixture: modern TLS 1.3 + strong cipher + valid cert produces zero findings', () => {
  const result = {
    hostname: 'example.invalid', port: 443,
    protocol: 'TLSv1.3',
    cipher: { name: 'TLS_AES_256_GCM_SHA384' },
    authorized: true,
    authorizationError: null,
    certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' },
  };
  const findings = detectTls(result, ASSET, NOW);
  assert.deepEqual(findings, []);
});

// ── Negative fixtures: each known weakness reported ──────────────────────

test('negative fixture: expired certificate is HIGH severity, HIGH confidence', () => {
  const result = {
    protocol: 'TLSv1.3', cipher: { name: 'TLS_AES_256_GCM_SHA384' }, authorized: true,
    certificate: { validFrom: '2025-01-01T00:00:00Z', validTo: '2026-01-01T00:00:00Z' }, // expired well before NOW
  };
  const findings = detectTls(result, ASSET, NOW);
  const f = findings.find(x => x.id === 'tls-cert-expired');
  assert.ok(f);
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.confidence, 'HIGH');
  assert.ok(!/vulnérable/i.test(f.title) && !/vulnérable/i.test(f.observed));
});

test('negative fixture: certificate expiring within 14 days is flagged MEDIUM', () => {
  const result = {
    protocol: 'TLSv1.3', cipher: { name: 'TLS_AES_256_GCM_SHA384' }, authorized: true,
    certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: '2026-09-25T00:00:00Z' }, // 7 days after NOW
  };
  const findings = detectTls(result, ASSET, NOW);
  const f = findings.find(x => x.id === 'tls-cert-expiring-soon');
  assert.ok(f);
  assert.equal(f.severity, 'MEDIUM');
});

test('negative fixture: not-yet-valid certificate flagged', () => {
  const result = {
    protocol: 'TLSv1.3', cipher: { name: 'TLS_AES_256_GCM_SHA384' }, authorized: true,
    certificate: { validFrom: '2027-01-01T00:00:00Z', validTo: '2028-01-01T00:00:00Z' },
  };
  const findings = detectTls(result, ASSET, NOW);
  assert.ok(findings.some(f => f.id === 'tls-cert-not-yet-valid'));
});

test('negative fixture: authorized=false (self-signed/mismatched) is HIGH severity but only MEDIUM confidence', () => {
  const result = {
    protocol: 'TLSv1.3', cipher: { name: 'TLS_AES_256_GCM_SHA384' },
    authorized: false, authorizationError: 'unable to verify the first certificate',
    certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' },
  };
  const findings = detectTls(result, ASSET, NOW);
  const f = findings.find(x => x.id === 'tls-not-authorized');
  assert.ok(f);
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.confidence, 'MEDIUM'); // never asserted as certainly malicious — could be an internal self-signed cert by design
});

test('negative fixture: weak protocol TLSv1.0 flagged MEDIUM, SSLv3 flagged HIGH', () => {
  const base = { cipher: { name: 'TLS_AES_256_GCM_SHA384' }, authorized: true, certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' } };
  const tls10 = detectTls({ ...base, protocol: 'TLSv1' }, ASSET, NOW);
  const ssl3 = detectTls({ ...base, protocol: 'SSLv3' }, ASSET, NOW);
  assert.equal(tls10.find(f => f.id === 'tls-weak-protocol').severity, 'MEDIUM');
  assert.equal(ssl3.find(f => f.id === 'tls-weak-protocol').severity, 'HIGH');
});

test('negative fixture: weak cipher (RC4) flagged MEDIUM', () => {
  const result = {
    protocol: 'TLSv1.2', cipher: { name: 'ECDHE-RSA-RC4-SHA' }, authorized: true,
    certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' },
  };
  const findings = detectTls(result, ASSET, NOW);
  const f = findings.find(x => x.id === 'tls-weak-cipher');
  assert.ok(f);
  assert.equal(f.severity, 'MEDIUM');
});

// ── Edge cases ────────────────────────────────────────────────────────────

test('edge case: null tlsResult (handshake failed entirely) returns an INFO finding, not a crash', () => {
  const findings = detectTls(null, ASSET, NOW);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'tls-unreachable');
  assert.equal(findings[0].severity, 'INFO');
});

test('edge case: missing certificate object entirely (e.g. non-TLS or handshake partial) does not throw', () => {
  const findings = detectTls({ protocol: 'TLSv1.3', cipher: { name: 'TLS_AES_256_GCM_SHA384' }, authorized: true, certificate: null }, ASSET, NOW);
  assert.doesNotThrow(() => findings);
});

test('edge case: malformed validTo date string does not throw and does not fabricate a finding', () => {
  const findings = detectTls({
    protocol: 'TLSv1.3', cipher: { name: 'TLS_AES_256_GCM_SHA384' }, authorized: true,
    certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: 'not-a-date' },
  }, ASSET, NOW);
  assert.ok(!findings.some(f => f.id.startsWith('tls-cert-expir')));
});

test('edge case: unknown/unexpected protocol string is LOW severity, LOW confidence — never fabricated as a known weakness', () => {
  const findings = detectTls({
    protocol: 'QUIC-experimental', cipher: { name: 'TLS_AES_256_GCM_SHA384' }, authorized: true,
    certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' },
  }, ASSET, NOW);
  const f = findings.find(x => x.id === 'tls-unknown-protocol');
  assert.ok(f);
  assert.equal(f.severity, 'LOW');
  assert.equal(f.confidence, 'LOW');
});

test('edge case: missing cipher object does not throw and produces no weak-cipher finding', () => {
  const findings = detectTls({
    protocol: 'TLSv1.3', cipher: null, authorized: true,
    certificate: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' },
  }, ASSET, NOW);
  assert.ok(!findings.some(f => f.id === 'tls-weak-cipher'));
});

test('every TLS finding severity/confidence pair respects the CRITICAL-requires-HIGH-confidence rule (enforced by finding())', () => {
  // Exercise every branch and confirm none throws (finding() itself would
  // throw on an invalid CRITICAL/non-HIGH combination).
  const scenarios = [
    null,
    { protocol: 'SSLv3', cipher: { name: 'RC4' }, authorized: false, authorizationError: 'x', certificate: { validFrom: '2020-01-01T00:00:00Z', validTo: '2020-06-01T00:00:00Z' } },
  ];
  for (const s of scenarios) assert.doesNotThrow(() => detectTls(s, ASSET, NOW));
});
