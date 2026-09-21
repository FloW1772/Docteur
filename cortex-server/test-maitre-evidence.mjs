// Unit tests for maitre-evidence.js — redaction wrapper + integrity
// hashing. No DB, no system access.
// Run with: node --test test-maitre-evidence.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactMaitreEvidenceMetadata, computeEvidenceIntegrityHash } from './src/lib/maitre-evidence.js';

test('redactMaitreEvidenceMetadata: redacts a top-level password field', () => {
  const redacted = redactMaitreEvidenceMetadata({ processName: 'app.exe', password: 'hunter2' });
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.processName, 'app.exe');
});

test('redactMaitreEvidenceMetadata: redacts token/secret/credential/apiKey/sessionId variants', () => {
  const redacted = redactMaitreEvidenceMetadata({
    accessToken: 'abc', clientSecret: 'def', credential: 'ghi', apiKey: 'jkl', sessionId: 'mno', api_key: 'pqr',
  });
  for (const key of ['accessToken', 'clientSecret', 'credential', 'apiKey', 'sessionId', 'api_key']) {
    assert.equal(redacted[key], '[REDACTED]', `${key} must be redacted`);
  }
});

test('redactMaitreEvidenceMetadata: redacts Authorization/Cookie header values via cyber-redact.js', () => {
  const redacted = redactMaitreEvidenceMetadata({
    headers: { authorization: 'Bearer abc123', 'set-cookie': 'session=xyz; Path=/', 'content-type': 'text/html' },
  });
  assert.notEqual(redacted.headers.authorization, 'Bearer abc123');
  assert.doesNotMatch(JSON.stringify(redacted.headers), /abc123|xyz/);
  assert.equal(redacted.headers['content-type'], 'text/html', 'non-sensitive headers must pass through');
});

test('redactMaitreEvidenceMetadata: redacts nested objects at depth', () => {
  const redacted = redactMaitreEvidenceMetadata({
    process: { env: { DB_PASSWORD: 'hunter2' }, meta: { nested: { token: 'deep-secret' } } },
  });
  assert.equal(redacted.process.env.DB_PASSWORD, '[REDACTED]');
  assert.equal(redacted.process.meta.nested.token, '[REDACTED]');
});

test('redactMaitreEvidenceMetadata: redacts within arrays', () => {
  const redacted = redactMaitreEvidenceMetadata({
    entries: [{ name: 'a', password: 'x' }, { name: 'b', token: 'y' }],
  });
  assert.equal(redacted.entries[0].password, '[REDACTED]');
  assert.equal(redacted.entries[1].token, '[REDACTED]');
  assert.equal(redacted.entries[0].name, 'a');
});

test('redactMaitreEvidenceMetadata: null/undefined input returns an empty object, never throws', () => {
  assert.deepEqual(redactMaitreEvidenceMetadata(null), {});
  assert.deepEqual(redactMaitreEvidenceMetadata(undefined), {});
});

test('redactMaitreEvidenceMetadata: leaves genuinely non-sensitive metadata untouched', () => {
  const redacted = redactMaitreEvidenceMetadata({ pid: 1234, processName: 'notepad.exe', cpuPercent: 0.5 });
  assert.deepEqual(redacted, { pid: 1234, processName: 'notepad.exe', cpuPercent: 0.5 });
});

test('redactMaitreEvidenceMetadata: JWT-shaped string values are redacted (via cyber-redact.js JWT_PATTERN)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ';
  const redacted = redactMaitreEvidenceMetadata({ note: `token seen: ${jwt}` });
  assert.doesNotMatch(redacted.note, /eyJhbGciOiJIUzI1NiJ9/);
});

// ── CLI-flag-style secret redaction (MA-4: command lines/registry
// values/task actions can carry secrets not shaped like an HTTP header
// or a known API-key prefix) ──────────────────────────────────────────

test('redactMaitreEvidenceMetadata: redacts --token=... embedded in a command-line-shaped string', () => {
  const redacted = redactMaitreEvidenceMetadata({ target: 'app.exe --token=plainvalue-not-sk-shaped' });
  assert.doesNotMatch(redacted.target, /plainvalue-not-sk-shaped/);
  assert.match(redacted.target, /\[REDACTED\]/);
});

test('redactMaitreEvidenceMetadata: redacts --password=... embedded in a command-line-shaped string', () => {
  const redacted = redactMaitreEvidenceMetadata({ target: 'app.exe --password=hunter2' });
  assert.doesNotMatch(redacted.target, /hunter2/);
});

test('redactMaitreEvidenceMetadata: redacts api_key=... in a free-text value', () => {
  const redacted = redactMaitreEvidenceMetadata({ target: 'run --api_key=sk-abc-123-plain' });
  assert.doesNotMatch(redacted.target, /sk-abc-123-plain/);
});

test('redactMaitreEvidenceMetadata: redacts cookie=... in a free-text value', () => {
  const redacted = redactMaitreEvidenceMetadata({ target: 'sessionId=abc123xyz' });
  assert.doesNotMatch(redacted.target, /abc123xyz/);
});

test('redactMaitreEvidenceMetadata: redacts secret=... in a free-text value', () => {
  const redacted = redactMaitreEvidenceMetadata({ target: 'client_secret=deadbeef1234' });
  assert.doesNotMatch(redacted.target, /deadbeef1234/);
});

test('redactMaitreEvidenceMetadata: leaves a benign command line with no secrets untouched', () => {
  const redacted = redactMaitreEvidenceMetadata({ target: 'C:\\Program Files\\App\\app.exe --minimized --silent' });
  assert.equal(redacted.target, 'C:\\Program Files\\App\\app.exe --minimized --silent');
});

// ── Integrity hashing ─────────────────────────────────────────────────────

test('computeEvidenceIntegrityHash: deterministic SHA-256 of serialized metadata', () => {
  const hash1 = computeEvidenceIntegrityHash({ a: 1, b: 2 });
  const hash2 = computeEvidenceIntegrityHash({ a: 1, b: 2 });
  assert.equal(hash1, hash2);
  assert.match(hash1, /^[a-f0-9]{64}$/);
});

test('computeEvidenceIntegrityHash: different content produces a different hash', () => {
  const hash1 = computeEvidenceIntegrityHash({ a: 1 });
  const hash2 = computeEvidenceIntegrityHash({ a: 2 });
  assert.notEqual(hash1, hash2);
});

test('computeEvidenceIntegrityHash: null/undefined metadata does not throw', () => {
  assert.doesNotThrow(() => computeEvidenceIntegrityHash(null));
  assert.doesNotThrow(() => computeEvidenceIntegrityHash(undefined));
});
