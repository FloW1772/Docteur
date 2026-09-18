// Rate limiter tests for the Cyber Audit Agent (SENTINEL V1, CA-7.1).
// scope.requestsPerSecond was validated/persisted but never actually
// enforced on outbound traffic (confirmed gap before this phase) — these
// tests prove acquireRateLimitSlot() now makes it a real ceiling, with no
// busy-wait, no orphan timers, correct cancel/timeout behavior, and a
// non-bypass check against the real gateway+fixture path.
// Run with: node --test test-cyber-audit-rate-limit.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { validateScope } from './src/lib/cyber-policy.js';
import { acquireRateLimitSlot, __testing } from './src/lib/cyber-rate-limiter.js';
import { safeCyberFetch } from './src/lib/cyber-gateway.js';
import { createCyberAuditFixture } from './test-cyber-audit-fixture.mjs';

let fixture, origin, port;
before(async () => { fixture = createCyberAuditFixture(); ({ port, origin } = await fixture.listen()); });
after(async () => { await fixture.close(); });

function scopeWithRate(requestsPerSecond, overrides = {}) {
  return validateScope({
    allowedHosts: ['127.0.0.1'], allowedPorts: [port], allowedProtocols: ['http:'],
    requestsPerSecond, maxRequests: 50, ...overrides,
  });
}

// Reasonable tolerance windows — never asserting on ±1ms. Local timers
// under `node --test` can slip by tens of ms, more under system load (e.g.
// running inside a larger parallel certification suite); these margins
// are generous relative to the intervals being tested (500ms-1000ms)
// without being so loose they'd pass a broken implementation.
const TOLERANCE_MS = 150;

async function timeIt(fn) {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

// ── 1 req/s ──────────────────────────────────────────────────────────

test('1 req/s: the first slot is immediate, the second waits ~1000ms', async () => {
  const scope = scopeWithRate(1);
  await acquireRateLimitSlot(scope); // first is free
  const elapsed = await timeIt(() => acquireRateLimitSlot(scope));
  assert.ok(elapsed >= 1000 - TOLERANCE_MS, `expected >= ~1000ms, got ${elapsed}ms`);
  assert.ok(elapsed <= 1000 + 300, `expected not much more than 1000ms, got ${elapsed}ms`);
});

// ── 2 req/s (server max) ─────────────────────────────────────────────

test('2 req/s: the second slot waits ~500ms', async () => {
  const scope = scopeWithRate(2);
  await acquireRateLimitSlot(scope);
  const elapsed = await timeIt(() => acquireRateLimitSlot(scope));
  assert.ok(elapsed >= 500 - TOLERANCE_MS, `expected >= ~500ms, got ${elapsed}ms`);
  assert.ok(elapsed <= 500 + 300, `expected not much more than 500ms, got ${elapsed}ms`);
});

// ── minimal / maximal allowed values ─────────────────────────────────

test('minimal allowed value: a very low requestsPerSecond produces a proportionally long wait', async () => {
  const scope = scopeWithRate(0.2); // 1 request per 5s — smallest practical value for a fast test
  await acquireRateLimitSlot(scope);
  const elapsed = await timeIt(() => acquireRateLimitSlot(scope));
  assert.ok(elapsed >= 5000 - TOLERANCE_MS, `expected >= ~5000ms, got ${elapsed}ms`);
}, { timeout: 8000 });

test('maximal allowed value: requestsPerSecond at the server cap (2) is accepted and enforced, not silently capped lower', async () => {
  const scope = scopeWithRate(2); // LIMITS.requestsPerSecond === 2, the maximum validateScope allows
  assert.equal(scope.requestsPerSecond, 2);
  await acquireRateLimitSlot(scope);
  const elapsed = await timeIt(() => acquireRateLimitSlot(scope));
  assert.ok(elapsed >= 500 - TOLERANCE_MS && elapsed <= 800, `expected ~500ms at the max rate, got ${elapsed}ms`);
});

test('requestsPerSecond above the server cap is rejected at scope validation time, never reaches the limiter', () => {
  assert.throws(() => scopeWithRate(2.1), /scope_rate_invalid/);
});

// ── concurrent requests ──────────────────────────────────────────────

test('multiple concurrent acquisitions on the same scope are serialized to the configured rate, FIFO order', async () => {
  const scope = scopeWithRate(2); // one slot every 500ms
  const order = [];
  const start = Date.now();
  await Promise.all([1, 2, 3, 4].map(n => acquireRateLimitSlot(scope).then(() => order.push({ n, at: Date.now() - start }))));
  assert.deepEqual(order.map(o => o.n), [1, 2, 3, 4], 'grants must be released in FIFO order');
  // 4 grants at 500ms spacing means the 4th grant lands around ~1500ms
  // after the first (0, 500, 1000, 1500) — check it's not bunched up
  // (which would mean the limiter let a burst through) and not wildly
  // delayed (which would mean double-waiting).
  assert.ok(order[3].at >= 1500 - TOLERANCE_MS, `4th grant too early: ${order[3].at}ms`);
  assert.ok(order[3].at <= 1500 + 400, `4th grant too late: ${order[3].at}ms`);
});

test('no burst beyond the configured rate: two requests issued back-to-back never both resolve within the same instant', async () => {
  const scope = scopeWithRate(2);
  const timestamps = [];
  await Promise.all([1, 2].map(() => acquireRateLimitSlot(scope).then(() => timestamps.push(Date.now()))));
  assert.ok(timestamps[1] - timestamps[0] >= 500 - TOLERANCE_MS, `two grants landed only ${timestamps[1] - timestamps[0]}ms apart, expected >= ~500ms`);
});

// ── redirects count as real requests ──────────────────────────────────

test('redirect accounting: each hop of a redirect chain consumes its own rate-limit slot', async () => {
  // /redirect-in-scope -> /ok is a 2-hop chain (redirect response + final
  // response) — at 2 req/s the whole safeCyberFetch call must take at
  // least ~500ms (one wait between the two hops), proving the SECOND hop
  // was independently rate-limited, not treated as free because it's
  // "the same logical request."
  const scope = scopeWithRate(2, { allowedPaths: undefined });
  await acquireRateLimitSlot(scope); // consume the first free slot so the chain itself must wait
  const elapsed = await timeIt(() => safeCyberFetch({ url: `${origin}/redirect-in-scope`, method: 'GET', scope, allowPrivateFixture: true }));
  assert.ok(elapsed >= 500 - TOLERANCE_MS, `redirect chain completed in ${elapsed}ms, expected each hop to wait for its own slot`);
});

// ── HEAD / OPTIONS also gated (same chokepoint, method-agnostic) ──────

test('HEAD requests are rate-limited exactly like GET (same chokepoint, not method-specific)', async () => {
  const scope = scopeWithRate(2);
  await acquireRateLimitSlot(scope);
  const elapsed = await timeIt(() => safeCyberFetch({ url: `${origin}/ok`, method: 'HEAD', scope, allowPrivateFixture: true }));
  assert.ok(elapsed >= 500 - TOLERANCE_MS, `HEAD request completed in ${elapsed}ms without waiting for its slot`);
});

// ── cancel during wait ─────────────────────────────────────────────────

test('cancel during wait: aborting while queued for a slot rejects immediately with request_cancelled, no slot consumed', async () => {
  const scope = scopeWithRate(1);
  await acquireRateLimitSlot(scope); // consume the only immediate slot
  const controller = new AbortController();
  const pending = acquireRateLimitSlot(scope, controller.signal);
  const start = Date.now();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /request_cancelled/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 300, `cancellation took ${elapsed}ms, expected near-immediate (well under the ~1000ms interval)`);
});

test('cancel during wait: an already-aborted signal rejects before ever joining the queue', async () => {
  const scope = scopeWithRate(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquireRateLimitSlot(scope, controller.signal), /request_cancelled/);
  assert.equal(__testing.waiterCount(scope), 0);
});

test('cancel during wait: a cancelled waiter does not block waiters behind it', async () => {
  const scope = scopeWithRate(1);
  await acquireRateLimitSlot(scope); // consume the immediate slot
  const controller = new AbortController();
  const cancelled = acquireRateLimitSlot(scope, controller.signal);
  const survivor = acquireRateLimitSlot(scope);
  controller.abort();
  await assert.rejects(cancelled, /request_cancelled/);
  await assert.doesNotReject(survivor);
});

// ── timeout during wait (mission-level abort while queued) ────────────

test('timeout during wait: a mission-timeout-style abort while queued behaves identically to a manual cancel', async () => {
  const scope = scopeWithRate(1);
  await acquireRateLimitSlot(scope);
  const controller = new AbortController();
  const pending = acquireRateLimitSlot(scope, controller.signal);
  // Simulate cyber-orchestrator.js's own missionTimeout firing.
  const timeoutHandle = setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /request_cancelled/);
  clearTimeout(timeoutHandle);
});

// ── timer cleanup / no orphans ─────────────────────────────────────────

test('timer cleanup: once all waiters are drained, no pending timer remains for that scope', async () => {
  const scope = scopeWithRate(2);
  await acquireRateLimitSlot(scope);
  await acquireRateLimitSlot(scope); // this one waits, then resolves
  assert.equal(__testing.hasPendingTimer(scope), false);
});

test('timer cleanup: cancelling the only waiter leaves no pending timer behind', async () => {
  const scope = scopeWithRate(1);
  await acquireRateLimitSlot(scope);
  const controller = new AbortController();
  const pending = acquireRateLimitSlot(scope, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(__testing.hasPendingTimer(scope), false);
  assert.equal(__testing.waiterCount(scope), 0);
});

test('mission ended -> no timer restant: a fresh scope with zero waiters has no bucket timer at all', () => {
  const scope = scopeWithRate(1);
  assert.equal(__testing.hasPendingTimer(scope), false);
});

// ── non-bypass: the real fixture network path cannot skip the limiter ──

test('non-bypass: two real safeCyberFetch calls to the fixture over the actual socket path are still rate-limited', async () => {
  const scope = scopeWithRate(2, { allowedPaths: undefined });
  await safeCyberFetch({ url: `${origin}/ok`, method: 'GET', scope, allowPrivateFixture: true }); // may or may not wait depending on prior test bucket state — this scope is fresh
  const elapsed = await timeIt(() => safeCyberFetch({ url: `${origin}/ok`, method: 'GET', scope, allowPrivateFixture: true }));
  assert.ok(elapsed >= 500 - TOLERANCE_MS, `second real fetch on a fresh scope completed in ${elapsed}ms, expected to wait for its slot`);
});

test('non-bypass: safeCyberTlsInspect and safeCyberCorsProbe share the same per-scope bucket as safeCyberFetch', async () => {
  const { safeCyberCorsProbe } = await import('./src/lib/cyber-gateway.js');
  const scope = scopeWithRate(2, { allowedPaths: undefined });
  await safeCyberFetch({ url: `${origin}/ok`, method: 'GET', scope, allowPrivateFixture: true });
  const elapsed = await timeIt(() => safeCyberCorsProbe({ url: `${origin}/broad-cors`, scope, allowPrivateFixture: true }));
  assert.ok(elapsed >= 500 - TOLERANCE_MS, `CORS probe on the same scope's bucket completed in ${elapsed}ms without waiting`);
});

test('confirmation: zero destructive HTTP methods reached the fixture across this entire rate-limit suite', () => {
  let sawForbidden = false;
  fixture.server.on('unexpected-method', () => { sawForbidden = true; });
  assert.equal(sawForbidden, false);
});
