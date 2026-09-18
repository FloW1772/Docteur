// Information-disclosure detector tests (CA-4, priority 5).
// Run with: node --test test-cyber-audit-detect-info-disclosure.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { detectInfoDisclosure } from './src/lib/cyber-detect-info-disclosure.js';
import { validateScope } from './src/lib/cyber-policy.js';
import { safeCyberFetch } from './src/lib/cyber-gateway.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

let fixture, origin, port;

before(async () => { fixture = createCyberAuditFixture(); ({ port, origin } = await fixture.listen()); });
after(async () => { await fixture.close(); });

function scope() {
  return validateScope({ allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'] });
}

// ── Positive fixture: no disclosure signals ─────────────────────────────

test('positive fixture: no Server/X-Powered-By/generator meta produces zero findings', async () => {
  const result = await safeCyberFetch({ url: `${origin}/ok`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const bodyExcerpt = Buffer.from(result.body, 'base64').toString('utf8');
  const findings = detectInfoDisclosure({ headers: result.headers, bodyExcerpt, asset: '127.0.0.1' });
  assert.deepEqual(findings, []);
});

// ── Negative fixtures ─────────────────────────────────────────────────────

test('negative fixture: Server header with version + X-Powered-By + generator meta all reported', async () => {
  const result = await safeCyberFetch({ url: `${origin}/info-disclosure`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const bodyExcerpt = Buffer.from(result.body, 'base64').toString('utf8');
  const findings = detectInfoDisclosure({ headers: result.headers, bodyExcerpt, asset: '127.0.0.1' });
  assert.ok(findings.some(f => f.id === 'info-disclosure-server-header-version'));
  assert.ok(findings.some(f => f.id === 'info-disclosure-x-powered-by'));
  assert.ok(findings.some(f => f.id === 'info-disclosure-generator-meta'));
  // All are LOW confidence-in-severity terms but real facts — never HIGH/CRITICAL for passive fingerprinting alone.
  assert.ok(findings.every(f => f.severity === 'LOW' || f.severity === 'INFO'));
});

test('negative fixture: Server header WITHOUT a version number is INFO, not LOW', () => {
  const findings = detectInfoDisclosure({ headers: { server: 'nginx' }, bodyExcerpt: '', asset: 'a' });
  const f = findings.find(x => x.id === 'info-disclosure-server-header');
  assert.ok(f);
  assert.equal(f.severity, 'INFO');
});

// ── Edge cases ────────────────────────────────────────────────────────────

test('edge case: X-Powered-By without a version number is INFO', () => {
  const findings = detectInfoDisclosure({ headers: { 'x-powered-by': 'Express' }, bodyExcerpt: '', asset: 'a' });
  const f = findings.find(x => x.id === 'info-disclosure-x-powered-by');
  assert.equal(f.severity, 'INFO');
});

test('edge case: generator meta with a version number escalates to LOW', () => {
  const findings = detectInfoDisclosure({ headers: {}, bodyExcerpt: '<meta name="generator" content="WordPress 5.8">', asset: 'a' });
  const f = findings.find(x => x.id === 'info-disclosure-generator-meta');
  assert.equal(f.severity, 'LOW');
});

test('edge case: no headers, no body excerpt at all produces zero findings without throwing', () => {
  assert.deepEqual(detectInfoDisclosure({ headers: {}, bodyExcerpt: '', asset: 'a' }), []);
  assert.doesNotThrow(() => detectInfoDisclosure({ headers: null, bodyExcerpt: null, asset: 'a' }));
});

test('edge case: malformed/partial generator meta tag (missing content attribute) is not matched, no crash', () => {
  assert.doesNotThrow(() => detectInfoDisclosure({ headers: {}, bodyExcerpt: '<meta name="generator">', asset: 'a' }));
  const findings = detectInfoDisclosure({ headers: {}, bodyExcerpt: '<meta name="generator">', asset: 'a' });
  assert.ok(!findings.some(f => f.id === 'info-disclosure-generator-meta'));
});

test('edge case: this detector never performs active fingerprinting — it only reads the single response/body passed in, no additional requests', async () => {
  let requestCount = 0;
  fixture.server.on('request', () => { requestCount++; });
  const result = await safeCyberFetch({ url: `${origin}/info-disclosure`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const before = requestCount;
  detectInfoDisclosure({ headers: result.headers, bodyExcerpt: Buffer.from(result.body, 'base64').toString('utf8'), asset: '127.0.0.1' });
  assert.equal(requestCount, before, 'the detector itself must never trigger a new network request');
});

test('no CVE/version claim is ever framed as confirmed — only "observé" language, no exploit assertion', async () => {
  const result = await safeCyberFetch({ url: `${origin}/info-disclosure`, method: 'GET', scope: scope(), allowPrivateFixture: true });
  const findings = detectInfoDisclosure({ headers: result.headers, bodyExcerpt: Buffer.from(result.body, 'base64').toString('utf8'), asset: '127.0.0.1' });
  for (const f of findings) {
    assert.ok(!/CVE-|vulnérable|exploitable/i.test(f.observed + f.interpretation));
  }
});
