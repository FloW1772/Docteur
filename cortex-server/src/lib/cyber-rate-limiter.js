/**
 * Per-mission outbound rate limiter for the Cyber Audit Agent (SENTINEL
 * V1, CA-7.1). Enforces scope.requestsPerSecond as an actual ceiling on
 * real wire traffic — closes the gap where the value was validated and
 * persisted (cyber-policy.js's validateScope) but never applied to
 * outbound requests.
 *
 * Single chokepoint: cyber-gateway.js is the ONLY module that ever opens
 * a real socket toward a mission's target (safeCyberFetch,
 * safeCyberTlsInspect, safeCyberCorsProbe), and each of those three call
 * sites — including EVERY redirect hop inside safeCyberFetch's own loop,
 * not just the first request of a chain — calls acquireRateLimitSlot()
 * immediately before opening its socket. This is deliberately the only
 * rate limiter in the codebase for this feature: the crawler and
 * orchestrator never rate-limit on their own, so there is exactly one
 * place that can ever be wrong, and no risk of two limiters disagreeing.
 *
 * Design: a token bucket, one per mission scope (keyed by the scope
 * object's own identity via a WeakMap — scope objects are frozen and
 * created exactly once per mission in cyber-policy.js/validateScope, so
 * this needs no explicit missionId threading through the gateway's
 * existing signatures, and old buckets are garbage-collected for free
 * once a mission's scope is no longer referenced, with no separate
 * cleanup pass required).
 *
 * capacity is deliberately 1 (no burst beyond the steady-state rate) —
 * the mission calls for a deterministic ceiling, not a bucket that lets
 * a caller spend up a backlog of saved-up tokens in a burst. Each granted
 * slot immediately starts the refill clock for the next one.
 *
 * No busy-wait: waiting callers are queued and resolved by a SINGLE
 * setTimeout scheduled for exactly the next refill instant (recomputed
 * whenever the queue changes), never a polling loop. No orphan timers:
 * every timer this module creates is either fired, or explicitly cleared
 * on cancellation/release.
 */

const buckets = new WeakMap(); // scope -> bucket

function nowMs() {
  return Date.now();
}

function getOrCreateBucket(scope) {
  let bucket = buckets.get(scope);
  if (bucket) return bucket;
  const intervalMs = 1000 / scope.requestsPerSecond;
  bucket = {
    intervalMs,
    nextAvailableAt: nowMs(), // the first request is always granted immediately
    waiters: [], // FIFO queue of { resolve, reject, onAbort, signal }
    timer: null,
  };
  buckets.set(scope, bucket);
  return bucket;
}

function clearBucketTimer(bucket) {
  if (bucket.timer) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }
}

function scheduleDrain(bucket) {
  clearBucketTimer(bucket);
  if (bucket.waiters.length === 0) return;
  const delay = Math.max(0, bucket.nextAvailableAt - nowMs());
  bucket.timer = setTimeout(() => drain(bucket), delay);
}

function drain(bucket) {
  bucket.timer = null;
  while (bucket.waiters.length > 0 && nowMs() >= bucket.nextAvailableAt) {
    const waiter = bucket.waiters.shift();
    bucket.nextAvailableAt = nowMs() + bucket.intervalMs;
    waiter.settle();
  }
  scheduleDrain(bucket);
}

/**
 * Resolves once a token is available for `scope`, honoring `signal` —
 * if the signal aborts while waiting, the wait is rejected immediately
 * (denied('request_cancelled')) and the caller is removed from the
 * queue; no token is consumed and no request is made. Resolves
 * synchronously (no timer at all) when a token is already available.
 */
export function acquireRateLimitSlot(scope, signal) {
  if (signal?.aborted) {
    const err = new Error('request_cancelled');
    err.code = 'request_cancelled';
    return Promise.reject(err);
  }

  const bucket = getOrCreateBucket(scope);
  const now = nowMs();

  if (bucket.waiters.length === 0 && now >= bucket.nextAvailableAt) {
    bucket.nextAvailableAt = now + bucket.intervalMs;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      settle: () => { cleanup(); resolve(); },
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      const idx = bucket.waiters.indexOf(waiter);
      if (idx !== -1) bucket.waiters.splice(idx, 1);
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('request_cancelled');
      err.code = 'request_cancelled';
      reject(err);
      scheduleDrain(bucket); // a removed waiter can change the next timer target
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    bucket.waiters.push(waiter);
    scheduleDrain(bucket);
  });
}

// Exposed for tests only — lets a test assert no orphan timer remains
// for a scope once its mission is done, without depending on GC timing.
export const __testing = {
  hasPendingTimer(scope) {
    const bucket = buckets.get(scope);
    return !!bucket?.timer;
  },
  waiterCount(scope) {
    const bucket = buckets.get(scope);
    return bucket?.waiters.length ?? 0;
  },
  forceClearForTests(scope) {
    const bucket = buckets.get(scope);
    if (bucket) clearBucketTimer(bucket);
  },
};
