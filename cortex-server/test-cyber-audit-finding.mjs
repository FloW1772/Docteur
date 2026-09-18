// Unit tests for the shared finding shape + redaction helpers (CA-4
// foundation, used by every detector).
// Run with: node --test test-cyber-audit-finding.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { finding, sortFindings, SEVERITY, CONFIDENCE } from './src/lib/cyber-finding.js';
import { redactCookieHeaderValue, redactHeaders, redactBodyExcerpt, deepRedactEvidence } from './src/lib/cyber-redact.js';

// ── finding() shape and invariants ──────────────────────────────────────

test('finding: builds a well-formed finding with all fields', () => {
  const f = finding({
    id: 'x-1', title: 'Test finding', category: 'headers', severity: 'LOW', confidence: 'HIGH',
    asset: 'example.com', observed: 'observed fact', interpretation: 'interp', recommendation: 'reco',
    evidence: [{ id: 'ev-1' }], references: ['https://example.com/doc'],
  });
  assert.equal(f.id, 'x-1');
  assert.equal(f.status, 'OPEN');
  assert.deepEqual(f.evidenceIds, ['ev-1']);
  assert.deepEqual(f.references, ['https://example.com/doc']);
});

test('finding: severity and confidence are separate axes — every combination except CRITICAL+non-HIGH is valid', () => {
  for (const severity of SEVERITY) {
    for (const confidence of CONFIDENCE) {
      if (severity === 'CRITICAL' && confidence !== 'HIGH') continue;
      assert.doesNotThrow(() => finding({
        id: `s-${severity}-${confidence}`, title: 't', category: 'c', severity, confidence,
        asset: 'a', observed: 'o',
      }));
    }
  }
});

test('finding: CRITICAL severity requires HIGH confidence — never reachable otherwise', () => {
  for (const confidence of ['LOW', 'MEDIUM']) {
    assert.throws(() => finding({
      id: 'crit-1', title: 't', category: 'c', severity: 'CRITICAL', confidence, asset: 'a', observed: 'o',
    }), /critical_requires_high_confidence/);
  }
});

test('finding: an unknown severity/confidence value throws rather than silently coercing', () => {
  assert.throws(() => finding({ id: 'x', title: 't', category: 'c', severity: 'VULNERABLE', confidence: 'HIGH', asset: 'a', observed: 'o' }));
  assert.throws(() => finding({ id: 'x', title: 't', category: 'c', severity: 'LOW', confidence: 'CERTAIN', asset: 'a', observed: 'o' }));
});

test('finding: required string fields cannot be empty/missing', () => {
  const base = { id: 'x', title: 't', category: 'c', severity: 'LOW', confidence: 'LOW', asset: 'a', observed: 'o' };
  for (const key of ['id', 'title', 'category', 'asset', 'observed']) {
    assert.throws(() => finding({ ...base, [key]: '' }), new RegExp(`${key.replace('id', 'id')}`), `${key} must be required`);
  }
});

test('sortFindings: orders CRITICAL > HIGH > MEDIUM > LOW > INFO, ties broken alphabetically', () => {
  const findings = [
    finding({ id: '1', title: 'B', category: 'c', severity: 'LOW', confidence: 'LOW', asset: 'a', observed: 'o' }),
    finding({ id: '2', title: 'A', category: 'c', severity: 'CRITICAL', confidence: 'HIGH', asset: 'a', observed: 'o' }),
    finding({ id: '3', title: 'A', category: 'c', severity: 'LOW', confidence: 'LOW', asset: 'a', observed: 'o' }),
  ];
  const sorted = sortFindings(findings);
  assert.deepEqual(sorted.map(f => f.id), ['2', '3', '1']);
});

// ── Redaction ────────────────────────────────────────────────────────────

test('redactCookieHeaderValue: redacts the value, keeps the name and all attributes', () => {
  const raw = 'session_id=abc123def456; Path=/; Secure; HttpOnly; SameSite=Strict';
  const redacted = redactCookieHeaderValue(raw);
  assert.ok(redacted.startsWith('session_id=[REDACTED];'));
  assert.ok(redacted.includes('Path=/'));
  assert.ok(redacted.includes('Secure'));
  assert.ok(redacted.includes('HttpOnly'));
  assert.ok(redacted.includes('SameSite=Strict'));
  assert.ok(!redacted.includes('abc123def456'));
});

test('redactCookieHeaderValue: malformed cookie (no "=") falls back to generic scrub without throwing', () => {
  assert.doesNotThrow(() => redactCookieHeaderValue('malformed-cookie-no-equals'));
});

test('redactHeaders: Authorization/Cookie/Set-Cookie/API-key-shaped headers fully or partially redacted', () => {
  const result = redactHeaders({
    authorization: 'Bearer sk-abcdefghijklmno1234567890',
    cookie: 'session=abc123',
    'set-cookie': ['session_id=abc123; Path=/; Secure'],
    'x-api-key': 'super-secret-key-value-1234567890',
    'content-type': 'text/html',
  });
  assert.equal(result.authorization, '[REDACTED]');
  assert.equal(result.cookie, '[REDACTED]');
  assert.ok(result['set-cookie'][0].startsWith('session_id=[REDACTED];'));
  assert.equal(result['x-api-key'], '[REDACTED]');
  assert.equal(result['content-type'], 'text/html'); // non-sensitive header untouched
});

test('redactHeaders: an array Set-Cookie with multiple cookies redacts each independently', () => {
  const result = redactHeaders({ 'set-cookie': ['a=111; Path=/', 'b=222; Path=/; Secure'] });
  assert.equal(result['set-cookie'].length, 2);
  assert.ok(result['set-cookie'][0].startsWith('a=[REDACTED]'));
  assert.ok(result['set-cookie'][1].startsWith('b=[REDACTED]'));
});

test('redactHeaders: handles null/non-object input without throwing', () => {
  assert.deepEqual(redactHeaders(null), {});
  assert.deepEqual(redactHeaders(undefined), {});
});

test('redactBodyExcerpt: redacts an embedded JWT-shaped token', () => {
  const body = 'error: token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U leaked in response';
  const redacted = redactBodyExcerpt(body);
  assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(redacted.includes('[REDACTED_JWT]'));
});

test('redactBodyExcerpt: redacts a known API-key shape via the shared logger.js patterns', () => {
  const body = 'Leaked key: sk-abcdefghijklmnopqrstuvwxyz1234567890';
  const redacted = redactBodyExcerpt(body);
  assert.ok(!redacted.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'));
});

test('deepRedactEvidence: recursively redacts nested headers objects and strings, depth-bounded', () => {
  const evidence = {
    request: { url: 'http://example.com', headers: { authorization: 'Bearer sk-abcdefghijklmno1234567890' } },
    note: 'contains sk-abcdefghijklmno1234567890 embedded',
  };
  const result = deepRedactEvidence(evidence);
  assert.equal(result.request.headers.authorization, '[REDACTED]');
  assert.ok(!result.note.includes('sk-abcdefghijklmno1234567890'));
});
