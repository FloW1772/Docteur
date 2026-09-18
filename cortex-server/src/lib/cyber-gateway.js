/**
 * Docteur-owned safe HTTP/TLS gateway for the Cyber Audit Agent (SENTINEL
 * V1). This is the ONLY module allowed to open a socket toward an audited
 * target — no other Cyber Audit module may call fetch/http/https/tls
 * directly against a mission's target. Every caller must go through:
 *
 *   authorizeCyberRequest({ missionId, url, method, scope })   // cyber-policy.js
 *   safeCyberFetch({ url, method, scope, signal, ... })         // this file
 *
 * Modeled directly on sherlock-policy.js's proven publicRequest — DNS is
 * resolved and re-validated on EVERY redirect hop (not just the first
 * request), the resolved IP is pinned into the actual socket connection
 * (defeats TOCTOU DNS rebinding between check-time and connect-time), and
 * every response is size-capped while streaming. Uses raw
 * http.request/https.request/tls.connect rather than fetch(), because
 * fetch() cannot intercept redirects for per-hop re-validation and cannot
 * expose TLS certificate/cipher/protocol details at all — both are
 * required for this feature (see reports/CYBER_AUDIT_AGENT_V1_2026-09.md,
 * CA-1 audit).
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { URL } from 'node:url';
import { LIMITS, denied, resolveInScope } from './cyber-policy.js';
import { acquireRateLimitSlot } from './cyber-rate-limiter.js';

const USER_AGENT = 'Docteur-SENTINEL-Audit/1.0 (+authorized-non-destructive-scan)';

/**
 * Performs one safe, scope-checked, size-capped HTTP request, following
 * redirects up to LIMITS.redirects hops, re-validating scope+DNS on every
 * hop. Returns { status, headers, location, contentType, body (base64),
 * url, redirectChain }.
 */
export async function safeCyberFetch({ url, method = 'GET', scope, signal, lookup, allowPrivateFixture = false }) {
  let target = url;
  const redirectChain = [];
  // A mission's scope may declare a tighter per-request timeout than the
  // global cap (validateScope already enforces 1000ms <= timeoutMs <=
  // LIMITS.requestTimeoutMs) — honor it here so a mission-declared budget
  // actually takes effect instead of silently defaulting to the global
  // 10s cap regardless of what the scope says.
  const requestTimeoutMs = scope?.timeoutMs ?? LIMITS.requestTimeoutMs;
  for (let hop = 0; hop <= LIMITS.redirects; hop++) {
    if (signal?.aborted) throw denied('request_cancelled');
    const { url: resolved, addresses } = await resolveInScope({ url: target, method, scope, lookup, allowPrivateFixture });
    const address = addresses[0];

    // Every hop is its own real wire request (a redirect target is a
    // brand-new socket to a brand-new resolved address) and therefore
    // its own rate-limit slot — CA-7.1's contract: "chaque requête HTTP
    // réellement envoyée compte", not just the first request of a chain.
    await acquireRateLimitSlot(scope, signal);

    const response = await new Promise((resolvePromise, reject) => {
      const cleanup = () => { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); request.destroy(denied('request_cancelled')); };
      const transport = resolved.protocol === 'https:' ? https.request : http.request;
      const request = transport(resolved, {
        method,
        agent: false,
        timeout: requestTimeoutMs,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Encoding': 'identity', // no compression — avoids decompression-bomb surface
          Connection: 'close',
        },
        // Pin the already-validated resolved address into the actual
        // socket connection, so nothing can swap the destination between
        // the DNS check above and the real connect() below.
        lookup: (_host, opts, callback) => (opts?.all ? callback(null, [address]) : callback(null, address.address, address.family)),
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > LIMITS.maxResponseBytes) {
            res.destroy(denied('response_too_large'));
            request.destroy(denied('response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          cleanup();
          resolvePromise({
            status: res.statusCode,
            headers: res.headers,
            location: res.headers.location,
            contentType: res.headers['content-type'] || '',
            body: Buffer.concat(chunks).toString('base64'),
            tls: request.socket?.encrypted
              ? {
                protocol: request.socket.getProtocol?.() ?? null,
                cipher: request.socket.getCipher?.() ?? null,
                authorized: request.socket.authorized ?? null,
                authorizationError: request.socket.authorizationError?.message ?? null,
              }
              : null,
          });
        });
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      const deadline = setTimeout(() => request.destroy(denied('request_timeout')), requestTimeoutMs);
      request.once('close', () => clearTimeout(deadline));
      request.on('timeout', () => request.destroy(denied('request_timeout')));
      request.on('error', err => { cleanup(); reject(err); });
      request.end();
    });

    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      if (hop === LIMITS.redirects) throw denied('redirect_limit');
      const nextUrl = new URL(response.location, resolved).href;
      redirectChain.push({ from: resolved.href, to: nextUrl, status: response.status });
      target = nextUrl;
      continue;
    }
    return { ...response, url: resolved.href, redirectChain };
  }
  throw denied('redirect_limit');
}

/**
 * Opens a raw TLS connection to inspect the certificate chain, negotiated
 * protocol, and cipher — WITHOUT sending any HTTP request. Read-only,
 * observation-only: this only performs the TLS handshake, nothing more.
 * Same scope+DNS validation as safeCyberFetch, applied to a synthetic
 * https:// URL so the existing resolveInScope logic is reused unchanged.
 */
export async function safeCyberTlsInspect({ hostname, port = 443, scope, signal, lookup, allowPrivateFixture = false }) {
  const syntheticUrl = `https://${hostname}:${port}/`;
  const { url: resolved, addresses } = await resolveInScope({ url: syntheticUrl, method: 'GET', scope, lookup, allowPrivateFixture });
  const address = addresses[0];

  await acquireRateLimitSlot(scope, signal);

  return new Promise((resolvePromise, reject) => {
    const cleanup = () => { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); socket.destroy(); };
    const onAbort = () => { cleanup(); reject(denied('request_cancelled')); };
    const socket = tls.connect({
      host: address.address,
      servername: resolved.hostname, // SNI must use the hostname, not the pinned IP
      port,
      timeout: LIMITS.requestTimeoutMs,
      rejectUnauthorized: false, // we want to OBSERVE invalid certs, not refuse the connection
    }, () => {
      const cert = socket.getPeerCertificate(true);
      const result = {
        hostname: resolved.hostname,
        port,
        protocol: socket.getProtocol(),
        cipher: socket.getCipher(),
        authorized: socket.authorized,
        authorizationError: socket.authorizationError?.message ?? null,
        certificate: cert && Object.keys(cert).length
          ? {
            subject: cert.subject ?? null,
            issuer: cert.issuer ?? null,
            validFrom: cert.valid_from ?? null,
            validTo: cert.valid_to ?? null,
            subjectAltNames: cert.subjectaltname ?? null,
            fingerprint256: cert.fingerprint256 ?? null,
            serialNumber: cert.serialNumber ?? null,
          }
          : null,
      };
      cleanup();
      resolvePromise(result);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => { socket.destroy(); reject(denied('request_timeout')); }, LIMITS.requestTimeoutMs);
    socket.on('error', err => { cleanup(); reject(err); });
    socket.on('timeout', () => { cleanup(); reject(denied('request_timeout')); });
  });
}

/**
 * Sends a CORS preflight-style probe: an OPTIONS request with a synthetic
 * cross-origin Origin header, purely to observe the target's
 * Access-Control-* response headers. Never sends a real state-changing
 * request — OPTIONS is in the allowed-method set (cyber-policy.js).
 */
export async function safeCyberCorsProbe({ url, scope, signal, lookup, allowPrivateFixture = false, probeOrigin = 'https://sentinel-audit-probe.invalid' }) {
  const { url: resolved, addresses } = await resolveInScope({ url, method: 'OPTIONS', scope, lookup, allowPrivateFixture });
  const address = addresses[0];

  await acquireRateLimitSlot(scope, signal);

  return new Promise((resolvePromise, reject) => {
    const cleanup = () => { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); request.destroy(denied('request_cancelled')); };
    const transport = resolved.protocol === 'https:' ? https.request : http.request;
    const request = transport(resolved, {
      method: 'OPTIONS',
      agent: false,
      timeout: LIMITS.requestTimeoutMs,
      headers: {
        'User-Agent': USER_AGENT,
        Origin: probeOrigin,
        'Access-Control-Request-Method': 'GET',
        'Accept-Encoding': 'identity',
      },
      lookup: (_host, opts, callback) => (opts?.all ? callback(null, [address]) : callback(null, address.address, address.family)),
    }, res => {
      res.resume(); // discard body — only headers matter for a CORS probe
      res.on('end', () => {
        cleanup();
        resolvePromise({
          status: res.statusCode,
          headers: res.headers,
          probeOrigin,
        });
      });
      res.on('error', reject);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => request.destroy(denied('request_timeout')), LIMITS.requestTimeoutMs);
    request.once('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy(denied('request_timeout')));
    request.on('error', err => { cleanup(); reject(err); });
    request.end();
  });
}
