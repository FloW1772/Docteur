import { setTimeout as delay } from 'node:timers/promises';
import { downloadWithSizeLimit } from './download-limits.js';

// Only retry throttling and transient server failures. Permission-denied
// 403s must not be confused with the two Drive quota reasons.
export async function fetchWithDriveRetry(url, options = {}, {
  maxRetries = 3, sleep = (ms, signal) => delay(ms, undefined, { signal }),
  random = Math.random, now = Date.now,
} = {}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('Nombre de tentatives invalide');
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const res = await fetch(url, options);
    let retryable = res.status === 429 || [500, 502, 503, 504].includes(res.status);
    if (res.status === 403) {
      // Read a bounded error body; never clone/tee a potentially unlimited stream.
      let body;
      try {
        const bytes = await downloadWithSizeLimit(url, {
          maxBytes: 64 * 1024, ErrorClass: Error, fetchOptions: options,
          fetchImpl: async () => ({ ok: true, headers: res.headers, body: res.body }),
        });
        body = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch { body = {}; }
      retryable = body?.error?.errors?.some(e => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason)) === true;
      if (!retryable || attempt >= maxRetries) return new Response(null, { status: 403 });
    }
    if (!retryable || attempt >= maxRetries) return res;
    void res.body?.cancel().catch(() => {});
    const retryAfter = res.headers.get('retry-after');
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
    const backoff = 1000 * 2 ** attempt + Math.floor(random() * 1000);
    await sleep(Math.min(30_000, Math.max(backoff, Number.isFinite(requested) ? requested : 0)), options.signal);
  }
}
