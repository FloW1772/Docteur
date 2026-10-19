// Runtime Supervisor V1 — bounded LOCAL health probe (the supervisor's only network primitive).
//
// Loopback only: the target is built from a fixed host literal (127.0.0.1 / ::1) and a port number; `localhost` is mapped
// to 127.0.0.1 without any name lookup. No redirect is followed (plain http.request), the response body is capped, every
// call has a hard timeout. GET for health, POST only for a registered graceful-stop path. Nothing user-, model- or
// document-controlled reaches this module: callers pass a parsed registry/configuration endpoint.

import http from 'node:http';

export const PROBE_LIMITS = Object.freeze({ minTimeoutMs: 100, maxTimeoutMs: 5_000, defaultTimeoutMs: 1_500, maxBodyBytes: 4_096 });
const LOOPBACK_HOSTS = Object.freeze({ '127.0.0.1': '127.0.0.1', localhost: '127.0.0.1', '::1': '::1', '[::1]': '::1' });
const PATH_RE = /^\/[A-Za-z0-9._~\-/]{0,120}$/;

/** Parses a configured base URL into a loopback target, or null when it is not plain-http loopback. */
export function loopbackTarget(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl ?? '')); } catch { return null; }
  if (url.protocol !== 'http:' || url.username || url.password) return null;
  const host = LOOPBACK_HOSTS[url.hostname.toLowerCase()];
  const port = Number(url.port || 80);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return Object.freeze({ host, port });
}

/**
 * One bounded local request. Never throws: { reachable, status, headers, body, code, durationMs }.
 * code: OK | HTTP_ERROR | REFUSED (nothing listening) | TIMEOUT | ERROR | NOT_LOOPBACK | INVALID
 */
export function probeLoopback({ host, port, path = '/', method = 'GET', timeoutMs = PROBE_LIMITS.defaultTimeoutMs } = {}) {
  const started = Date.now();
  const done = (r) => Object.freeze({ reachable: false, status: null, headers: {}, body: '', ...r, durationMs: Date.now() - started });
  if (!Object.values(LOOPBACK_HOSTS).includes(host)) return Promise.resolve(done({ code: 'NOT_LOOPBACK' }));
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !PATH_RE.test(path) || !['GET', 'POST'].includes(method)) return Promise.resolve(done({ code: 'INVALID' }));
  const timeout = Math.min(PROBE_LIMITS.maxTimeoutMs, Math.max(PROBE_LIMITS.minTimeoutMs, Number(timeoutMs) || PROBE_LIMITS.defaultTimeoutMs));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(done(r)); } };
    const req = http.request({ host, port, path, method, family: host === '::1' ? 6 : 4, headers: { connection: 'close', 'content-length': 0 }, agent: false }, (res) => {
      let size = 0; const chunks = [];
      res.on('data', (c) => { size += c.length; if (size <= PROBE_LIMITS.maxBodyBytes) chunks.push(c); else res.destroy(); });
      res.on('close', () => finish({
        reachable: true, status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8').slice(0, PROBE_LIMITS.maxBodyBytes),
        code: res.statusCode >= 200 && res.statusCode < 400 ? 'OK' : 'HTTP_ERROR',
      }));
    });
    const timer = setTimeout(() => { req.destroy(); finish({ code: 'TIMEOUT' }); }, timeout);
    req.on('error', (e) => finish({ code: e?.code === 'ECONNREFUSED' ? 'REFUSED' : 'ERROR' }));
    req.end();
  });
}
