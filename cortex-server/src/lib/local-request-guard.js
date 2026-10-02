// NB-7 — ONE central request guard for the local Docteur API (replaces the NB-6 memory-only guard; do not copy it per route).
//
// Threat model. The API listens on loopback (or the LAN when LOCAL_NETWORK=true) and has no per-user authentication: a process
// under the same Windows account is trusted. What must be refused is a WEB PAGE (any site open in the user's browser):
//   • CSRF — a cross-origin "simple" request (text/plain, form-urlencoded, multipart) is PROCESSED even though CORS then hides the
//     response, so writes must be refused by the server, not only hidden;
//   • DNS rebinding — attacker.example resolved to 127.0.0.1 makes the page same-origin with the API (no Origin header on a GET),
//     so the Host header is the only signal: it must be a local name;
//   • other-port origins — any page served from another loopback port is still a foreign page.
//
// Policy (fail closed):
//   1. Host must be local: loopback name / loopback IP, private / link-local / CGNAT / ULA IP, a single-label or *.local / *.lan /
//      *.internal / *.home.arpa name, or an entry of DOCTEUR_ALLOWED_HOSTS. Malformed Host (userinfo, path, spaces, empty) ⇒ 403.
//   2. An Origin header, when present, must be an EXPECTED FRONTEND ORIGIN (the same allow-list CORS uses: dev / LAN frontends +
//      DOCTEUR_ALLOWED_ORIGINS) or SAME-ORIGIN (its host[:port] equals the request Host). `null`, file://, foreign and other-loopback-port
//      origins ⇒ 403. NB-7 decision (was « any loopback origin » in NB-6): REQUIRE EXPECTED FRONTEND ORIGIN — the app itself can only
//      read API responses from an origin that CORS already allows, so this adds no new failure for a working setup.
//   3. Requests without Origin (curl, workers, tests — non-browser local clients) stay allowed: same trust model as the rest of the app.
//   4. Optional enforceJson: a write with a body must be application/json (a cross-origin JSON write needs a preflight CORS denies).
//   5. A browser that says Sec-Fetch-Site: cross-site on a non-safe method is refused even if Origin handling were bypassed.
// OPTIONS (CORS preflight) is left to the CORS middleware: it has no side effect.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const DEFAULT_FRONTEND_PORTS = Object.freeze([5173, 3000, 4173]);
export const DEFAULT_FRONTEND_ORIGINS = Object.freeze(DEFAULT_FRONTEND_PORTS.flatMap(p => ['http', 'https'].flatMap(s => ['localhost', '127.0.0.1', '[::1]'].map(h => `${s}://${h}:${p}`))));

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const V4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const envList = (name) => String(process.env[name] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export function isLocalHostname(hostname, extraHosts = envList('DOCTEUR_ALLOWED_HOSTS')) {
  const h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (extraHosts.includes(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (V4.test(h)) return h.split('.').every(n => Number(n) <= 255) && PRIVATE_V4.some(re => re.test(h));
  if (h.startsWith('[')) { const v6 = h.slice(1, -1); return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6); }
  if (!h.includes('.')) return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(h) && !/^\d+$/.test(h);
  return /\.(?:local|lan|internal)$/.test(h) || h.endsWith('.home.arpa');
}

// Parses a Host header strictly. Returns { hostname, host } or null when malformed.
export function parseHostHeader(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\s/\\?#@]/.test(raw)) return null;
  try { const u = new URL(`http://${raw}`); if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null; return { hostname: u.hostname, host: u.host }; } catch { return null; }
}

export function parseOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'null') return null;
  try { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null; return { origin: u.origin, host: u.host, hostname: u.hostname }; } catch { return null; }
}

export function isExpectedFrontendOrigin(origin, extraOrigins = envList('DOCTEUR_ALLOWED_ORIGINS')) {
  const o = parseOrigin(origin); if (!o) return false;
  return DEFAULT_FRONTEND_ORIGINS.includes(o.origin) || extraOrigins.includes(o.origin);
}

// Returns { ok, status?, code?, error? } — pure, so the policy is unit-testable without a server.
export function evaluateRequest({ method, host, origin, contentType, contentLength, transferEncoding, secFetchSite }, { isAllowedOrigin = isExpectedFrontendOrigin, enforceJson = false, extraHosts } = {}) {
  const parsedHost = parseHostHeader(host);
  if (!parsedHost || !isLocalHostname(parsedHost.hostname, extraHosts)) return { ok: false, status: 403, code: 'FORBIDDEN_HOST', error: 'Hôte non autorisé' };
  if (origin !== undefined && origin !== null) {
    const o = parseOrigin(origin);
    const same = !!o && o.host.toLowerCase() === parsedHost.host.toLowerCase();
    if (!o || !(same || isAllowedOrigin(o.origin))) return { ok: false, status: 403, code: 'FORBIDDEN_ORIGIN', error: 'Origine non autorisée' };
  }
  const m = String(method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(m)) {
    if (String(secFetchSite ?? '').toLowerCase() === 'cross-site' && (origin === undefined || origin === null)) return { ok: false, status: 403, code: 'FORBIDDEN_ORIGIN', error: 'Requête inter-sites refusée' };
    if (enforceJson) {
      const ct = String(contentType ?? '').toLowerCase(); const len = Number(contentLength ?? 0);
      if (ct ? !ct.startsWith('application/json') : (len > 0 || transferEncoding !== undefined)) return { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Content-Type application/json requis' };
    }
  }
  return { ok: true };
}

// Hono middleware factory. `skip(c)` lets the caller exempt paths (e.g. frozen modules) without copying the policy.
export function createLocalRequestGuard({ isAllowedOrigin = isExpectedFrontendOrigin, enforceJson = false, extraHosts, skip = () => false, onReject } = {}) {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || skip(c)) return next();
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const verdict = evaluateRequest({ method: c.req.method, host, origin: c.req.header('origin'), contentType: c.req.header('content-type'), contentLength: c.req.header('content-length'), transferEncoding: c.req.header('transfer-encoding'), secFetchSite: c.req.header('sec-fetch-site') }, { isAllowedOrigin, enforceJson, extraHosts });
    if (!verdict.ok) { try { onReject?.({ code: verdict.code, method: c.req.method, path: new URL(c.req.url).pathname }); } catch { /* logging only */ } return c.json({ error: verdict.error, code: verdict.code }, verdict.status); }
    return next();
  };
}
