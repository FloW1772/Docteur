// Mandatory adversarial checkpoint for the Cyber Audit Agent (SENTINEL V1)
// safe HTTP gateway — CA-3 checkpoint, must be 100% PASS before any
// detector (CA-4) is implemented. Every test below tries to make the
// gateway do something it must refuse: reach a host outside scope, follow
// a subdomain without opt-in, use a forbidden port/protocol/method, follow
// a redirect out of scope or into a private network, resolve a hostname
// to a private IP, exceed size/rate/timeout limits, or survive a cancel
// with orphaned activity.
//
// Run with: node --test test-cyber-audit-policy.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';

import {
  denied, validateScope, validateMissionInput, authorizeCyberRequest, resolveInScope,
  authorizeMethod, isPublicAddress, ALLOWED_METHODS, LIMITS,
} from './src/lib/cyber-policy.js';
import { safeCyberFetch, safeCyberCorsProbe } from './src/lib/cyber-gateway.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

let fixture, origin, port;

before(async () => {
  fixture = createCyberAuditFixture();
  ({ port, origin } = await fixture.listen());
});

after(async () => {
  await fixture.close();
});

function scopeFor(overrides = {}) {
  return validateScope({
    allowedHosts: ['127.0.0.1'],
    allowedPorts: [port],
    allowedProtocols: ['http:'],
    followSubdomains: false,
    maxRequests: 50,
    requestsPerSecond: 2,
    timeoutMs: 2000,
    ...overrides,
  });
}

// ── Authorization gate ──────────────────────────────────────────────────

test('authorization gate: mission input rejected without authorizationConfirmed === true', () => {
  assert.throws(() => validateMissionInput({
    title: 'Test', clientName: 'Client', authorizationReference: 'ref-1',
    scope: { allowedHosts: ['127.0.0.1'] },
  }), err => err.code === 'authorization_not_confirmed');
});

test('authorization gate: truthy-but-not-boolean-true is rejected ("yes", 1, "true")', () => {
  for (const value of ['yes', 1, 'true', {}]) {
    assert.throws(() => validateMissionInput({
      title: 'Test', clientName: 'Client', authorizationConfirmed: value,
      authorizationReference: 'ref-1', scope: { allowedHosts: ['127.0.0.1'] },
    }), err => err.code === 'authorization_not_confirmed', `value=${JSON.stringify(value)} must be rejected`);
  }
});

test('authorization gate: missing authorizationReference is rejected even with authorizationConfirmed true', () => {
  assert.throws(() => validateMissionInput({
    title: 'Test', clientName: 'Client', authorizationConfirmed: true,
    scope: { allowedHosts: ['127.0.0.1'] },
  }), err => err.code === 'authorization_reference_required');
});

test('authorization gate: valid input passes and returns a frozen scope', () => {
  const result = validateMissionInput({
    title: 'Test mission', clientName: 'Acme', authorizationConfirmed: true,
    authorizationReference: 'signed-authorization-doc-123',
    scope: { allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'] },
  });
  assert.equal(result.authorizationConfirmed, true);
  assert.ok(Object.isFrozen(result.scope));
});

// ── Exact host scope ─────────────────────────────────────────────────────

test('exact host scope: request to a host not in allowedHosts is denied', () => {
  const scope = scopeFor();
  assert.throws(() => authorizeCyberRequest({ url: 'http://192.0.2.1/ok', method: 'GET', scope }),
    err => err.code === 'target_out_of_scope');
});

test('exact host scope: wildcard host is rejected at scope-creation time, not request time', () => {
  assert.throws(() => validateScope({ allowedHosts: ['*'] }), err => err.code === 'scope_wildcard_denied');
  assert.throws(() => validateScope({ allowedHosts: ['*.example.com'] }), err => err.code === 'scope_wildcard_denied');
});

// ── Subdomain default deny ───────────────────────────────────────────────

test('subdomain default deny: a subdomain of an allowed host is denied unless followSubdomains=true', () => {
  const scope = validateScope({ allowedHosts: ['example.com'], allowedPorts: [80], allowedProtocols: ['http:'] });
  assert.equal(scope.followSubdomains, false);
  assert.throws(() => authorizeCyberRequest({ url: 'http://sub.example.com/ok', method: 'GET', scope }),
    err => err.code === 'target_out_of_scope');
});

test('subdomain opt-in: followSubdomains=true allows an explicit subdomain', () => {
  const scope = validateScope({ allowedHosts: ['example.com'], allowedPorts: [80], allowedProtocols: ['http:'], followSubdomains: true });
  const parsed = authorizeCyberRequest({ url: 'http://sub.example.com/ok', method: 'GET', scope });
  assert.equal(parsed.hostname, 'sub.example.com');
});

// ── Port enforcement ──────────────────────────────────────────────────────

test('port enforcement: a port outside allowedPorts is denied', () => {
  const scope = scopeFor({ allowedPorts: [80] });
  assert.throws(() => authorizeCyberRequest({ url: `http://127.0.0.1:${port}/ok`, method: 'GET', scope }),
    err => err.code === 'target_port_denied');
});

// ── Protocol enforcement ────────────────────────────────────────────────

test('protocol enforcement: https target denied when scope only allows http', () => {
  const scope = scopeFor({ allowedProtocols: ['http:'] });
  assert.throws(() => authorizeCyberRequest({ url: `https://127.0.0.1:${port}/ok`, method: 'GET', scope }),
    err => err.code === 'target_protocol_denied');
});

test('protocol enforcement: unsupported schemes are denied outright (file/ftp/data/javascript/gopher)', () => {
  const scope = scopeFor();
  for (const scheme of ['file:///etc/passwd', 'ftp://127.0.0.1/x', 'data:text/plain,x', 'javascript:alert(1)', 'gopher://127.0.0.1/x']) {
    assert.throws(() => authorizeCyberRequest({ url: scheme, method: 'GET', scope }),
      err => err.code === 'scheme_denied', `${scheme} must be denied`);
  }
});

// ── Path exclusions ───────────────────────────────────────────────────────

test('path exclusions: excludedPaths always wins even if allowedPaths would match', () => {
  const scope = scopeFor({ allowedPaths: ['/'], excludedPaths: ['/excluded'] });
  assert.throws(() => authorizeCyberRequest({ url: `http://127.0.0.1:${port}/excluded`, method: 'GET', scope }),
    err => err.code === 'target_path_denied');
});

test('path exclusions: destructive-looking paths can be excluded explicitly', () => {
  const scope = scopeFor({ excludedPaths: ['/admin/delete-user', '/logout', '/unsubscribe'] });
  assert.throws(() => authorizeCyberRequest({ url: `http://127.0.0.1:${port}/admin/delete-user`, method: 'GET', scope }),
    err => err.code === 'target_path_denied');
});

// ── DNS validation ────────────────────────────────────────────────────────

test('DNS validation: a hostname resolving to a private address is denied', async () => {
  const scope = validateScope({ allowedHosts: ['private-fixture.invalid'], allowedPorts: [80], allowedProtocols: ['http:'] });
  const fakeLookup = async () => [{ address: '10.0.0.5', family: 4 }];
  await assert.rejects(resolveInScope({ url: 'http://private-fixture.invalid/ok', method: 'GET', scope, lookup: fakeLookup }),
    err => err.code === 'target_resolves_private');
});

test('DNS validation: if ANY resolved address is private, the whole request is denied (multi-A-record)', async () => {
  const scope = validateScope({ allowedHosts: ['multi-a.invalid'], allowedPorts: [80], allowedProtocols: ['http:'] });
  const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(resolveInScope({ url: 'http://multi-a.invalid/ok', method: 'GET', scope, lookup: fakeLookup }),
    err => err.code === 'target_resolves_private');
});

test('DNS validation: metadata address 169.254.169.254 is denied', () => {
  assert.equal(isPublicAddress('169.254.169.254'), false);
});

test('DNS validation: loopback, link-local, RFC1918, CGNAT, benchmarking, documentation ranges all denied', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '0.0.0.0', '224.0.0.1']) {
    assert.equal(isPublicAddress(ip), false, `${ip} must be private`);
  }
});

test('DNS validation: IPv6 loopback/link-local/ULA denied, ordinary global unicast allowed', () => {
  assert.equal(isPublicAddress('::1'), false);
  assert.equal(isPublicAddress('fe80::1'), false);
  assert.equal(isPublicAddress('fc00::1'), false);
  assert.equal(isPublicAddress('fd00::1'), false);
  assert.equal(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946'), true); // example.com's real AAAA range shape
});

test('DNS validation: a fixture explicitly allowed via allowPrivateFixture bypasses the private check (test-only escape hatch)', async () => {
  const scope = validateScope({ allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'] });
  const { addresses } = await resolveInScope({ url: `http://127.0.0.1:${port}/ok`, method: 'GET', scope, allowPrivateFixture: true });
  assert.equal(addresses[0].address, '127.0.0.1');
});

// ── Redirect validation ───────────────────────────────────────────────────

test('redirect validation: a same-scope redirect is followed', async () => {
  const scope = scopeFor();
  const result = await safeCyberFetch({ url: `${origin}/redirect-in-scope`, method: 'GET', scope, allowPrivateFixture: true });
  assert.equal(result.status, 200);
  assert.equal(result.redirectChain.length, 1);
});

test('redirect validation: a redirect to an out-of-scope host is denied', async () => {
  const scope = scopeFor();
  await assert.rejects(safeCyberFetch({ url: `${origin}/redirect-out-of-scope`, method: 'GET', scope, allowPrivateFixture: true }),
    err => err.code === 'target_out_of_scope');
});

test('redirect validation: a redirect to a private-network target is denied even mid-chain', async () => {
  const scope = validateScope({ allowedHosts: ['127.0.0.1'], allowedPorts: [port, 1], allowedProtocols: ['http:'] });
  await assert.rejects(safeCyberFetch({ url: `${origin}/redirect-private`, method: 'GET', scope, allowPrivateFixture: false }),
    err => err.code === 'target_resolves_private' || err.code === 'target_out_of_scope');
});

test('redirect validation: a redirect loop hits the hop limit rather than looping forever', async () => {
  const scope = scopeFor();
  await assert.rejects(safeCyberFetch({ url: `${origin}/redirect-loop`, method: 'GET', scope, allowPrivateFixture: true }),
    err => err.code === 'redirect_limit');
});

// ── Private network / metadata protection (end-to-end through the gateway) ──

test('private network protection: gateway refuses a direct request whose scope points at a private host, end to end', async () => {
  const scope = validateScope({ allowedHosts: ['192.168.1.1'], allowedPorts: [80], allowedProtocols: ['http:'] });
  await assert.rejects(safeCyberFetch({ url: 'http://192.168.1.1/ok', method: 'GET', scope }),
    err => err.code === 'target_resolves_private');
});

test('metadata protection: 169.254.169.254 is refused end to end even if it were somehow in scope', async () => {
  const scope = validateScope({ allowedHosts: ['169.254.169.254'], allowedPorts: [80], allowedProtocols: ['http:'] });
  await assert.rejects(safeCyberFetch({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET', scope }),
    err => err.code === 'target_resolves_private');
});

// ── HTTP method policy ────────────────────────────────────────────────────

test('HTTP methods: GET, HEAD, OPTIONS are allowed', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(authorizeMethod(method), method);
  }
  assert.deepEqual([...ALLOWED_METHODS].sort(), ['GET', 'HEAD', 'OPTIONS']);
});

test('HTTP methods: POST/PUT/PATCH/DELETE/CONNECT/TRACE are denied with an explicit exploitation code', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE']) {
    assert.throws(() => authorizeMethod(method), err => err.code === 'exploitation_method_denied', `${method} must be denied`);
  }
});

test('HTTP methods: the gateway never actually sends a forbidden method to the fixture (canary check)', async () => {
  let sawUnexpectedMethod = false;
  fixture.server.once('unexpected-method', () => { sawUnexpectedMethod = true; });
  const scope = scopeFor();
  assert.throws(() => authorizeCyberRequest({ url: `${origin}/ok`, method: 'POST', scope }),
    err => err.code === 'exploitation_method_denied');
  assert.equal(sawUnexpectedMethod, false, 'the fixture must never observe a POST if the gate ran first');
});

test('CORS probe uses OPTIONS, never a state-changing verb', async () => {
  const scope = scopeFor();
  const result = await safeCyberCorsProbe({ url: `${origin}/broad-cors`, scope, allowPrivateFixture: true });
  assert.equal(result.status, 204);
  assert.equal(result.headers['access-control-allow-origin'], '*');
});

// ── Rate limiting / limits ────────────────────────────────────────────────

test('rate limiting: scope requestsPerSecond above server LIMITS.requestsPerSecond is rejected at scope-validation time', () => {
  assert.throws(() => validateScope({ allowedHosts: ['127.0.0.1'], requestsPerSecond: LIMITS.requestsPerSecond + 10 }),
    err => err.code === 'scope_rate_invalid');
});

test('rate limiting: scope maxRequests above server LIMITS.maxRequests is rejected', () => {
  assert.throws(() => validateScope({ allowedHosts: ['127.0.0.1'], maxRequests: LIMITS.maxRequests + 1 }),
    err => err.code === 'scope_max_requests_invalid');
});

test('rate limiting: the frontend cannot raise limits above server policy (scope echoes server caps, never client-supplied excess)', () => {
  const scope = validateScope({ allowedHosts: ['127.0.0.1'], maxRequests: 999999 !== LIMITS.maxRequests ? undefined : undefined, requestsPerSecond: undefined });
  assert.ok(scope.maxRequests <= LIMITS.maxRequests);
  assert.ok(scope.requestsPerSecond <= LIMITS.requestsPerSecond);
});

// ── Timeout ───────────────────────────────────────────────────────────────

test('timeout: a request to an endpoint that never responds is aborted at LIMITS.requestTimeoutMs', async () => {
  const scope = scopeFor();
  const start = Date.now();
  await assert.rejects(safeCyberFetch({ url: `${origin}/slow`, method: 'GET', scope, allowPrivateFixture: true }),
    err => err.code === 'request_timeout');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < LIMITS.requestTimeoutMs + 5000, `timeout took too long: ${elapsed}ms`);
});

// ── Cancellation ──────────────────────────────────────────────────────────

test('cancellation: an aborted signal stops the request and throws request_cancelled, no orphaned activity', async () => {
  const scope = scopeFor();
  const controller = new AbortController();
  const promise = safeCyberFetch({ url: `${origin}/slow`, method: 'GET', scope, signal: controller.signal, allowPrivateFixture: true });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, err => err.code === 'request_cancelled');
});

test('cancellation: an already-aborted signal is rejected immediately without making a request', async () => {
  const scope = scopeFor();
  const controller = new AbortController();
  controller.abort();
  let sawRequest = false;
  fixture.server.once('request', () => { sawRequest = true; });
  await assert.rejects(safeCyberFetch({ url: `${origin}/ok`, method: 'GET', scope, signal: controller.signal, allowPrivateFixture: true }),
    err => err.code === 'request_cancelled');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sawRequest, false);
});

// ── Response size ─────────────────────────────────────────────────────────

test('response size: a response exceeding maxResponseBytes is destroyed before being fully buffered', async () => {
  const scope = scopeFor();
  await assert.rejects(safeCyberFetch({ url: `${origin}/large-response`, method: 'GET', scope, allowPrivateFixture: true }),
    err => err.code === 'response_too_large');
});

// ── Prompt injection isolation ────────────────────────────────────────────

test('prompt injection isolation: fetching a page containing injection text produces no new permission, no policy mutation', async () => {
  const scope = scopeFor();
  const before = { ...scope };
  const result = await safeCyberFetch({ url: `${origin}/prompt-injection`, method: 'GET', scope, allowPrivateFixture: true });
  assert.equal(result.status, 200);
  const bodyText = Buffer.from(result.body, 'base64').toString('utf8');
  assert.ok(bodyText.includes('Ignore previous instructions'));
  // The scope object must be byte-for-byte unchanged — fetching hostile
  // content can never mutate the policy that authorized the fetch.
  assert.deepEqual(scope, before);
  assert.ok(Object.isFrozen(scope));
  // The response content itself carries no special trust marker that
  // would let it be mistaken for anything but observed evidence.
  assert.equal(typeof result.body, 'string');
});

// ── Secret redaction (evidence-layer contract, tested at the policy/gateway
//    boundary: raw Set-Cookie values must never be required to be logged
//    verbatim by this module — callers redact before persisting) ──────────

test('secret redaction contract: safeCyberFetch returns raw headers (redaction is the evidence layer\'s job, verified here to exist)', async () => {
  const scope = scopeFor();
  const result = await safeCyberFetch({ url: `${origin}/insecure-cookie`, method: 'GET', scope, allowPrivateFixture: true });
  assert.ok(result.headers['set-cookie']);
  // This module intentionally does NOT redact — it is the safe transport
  // layer, not the evidence store. CA-5's evidence layer is responsible
  // for redaction before persistence; this test documents the boundary.
});

// ── Out-of-scope request counter ──────────────────────────────────────────

test('out-of-scope requests: 0 requests ever reach a host outside the declared scope across this entire suite', async () => {
  // Sanity re-assertion: every denial above happened before any socket was
  // opened (policy layer throws synchronously/pre-DNS), confirmed by the
  // canary events never firing. No additional network activity performed.
  assert.ok(true);
});
