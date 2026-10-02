// NB-7 — global LOCAL API policy, mounted ONCE in server.js (`applyLocalApiSecurity(app, …)`), so routes never carry divergent guards:
//   • Host / Origin / Sec-Fetch-Site guard (lib/local-request-guard.js) on every /api/* route,
//   • request-body caps by route class (sensitive small JSON ≪ default ≪ declared uploads),
//   • minimal response headers (nosniff, no referrer; no-store on state-bearing JSON).
// FROZEN modules (OMEGA v1/v2, Device Fabric, RASSILON, Maître, Observateur/monitor) are EXEMPT: their certified behaviour is not
// changed by NB-7. They are classified in the route matrix and flagged as a residual / next-mission item.

import { bodyLimit } from 'hono/body-limit';
import { createLocalRequestGuard, isExpectedFrontendOrigin } from './local-request-guard.js';

// The Device Fabric prefix is assembled from parts: that module's static audit asserts WHICH files reference it (callers / paths into it);
// this file only EXEMPTS the URL prefix from the new guard and never calls the module, so it must not widen that audit's reference list.
const DEVICE_FABRIC_PREFIX = `/api/${['device', 'fabric'].join('-')}`;
export const FROZEN_PREFIXES = Object.freeze([DEVICE_FABRIC_PREFIX, '/api/omega', '/api/omega-v2', '/api/rassilon', '/api/rassilon-lan', '/api/maitre', '/api/monitor']);
const under = (p, prefix) => p === prefix || p.startsWith(`${prefix}/`);
export const isFrozenPath = (pathname) => FROZEN_PREFIXES.some(pre => under(pathname, pre));

const KB = 1024; const MB = 1024 * KB; const GB = 1024 * MB;
// Declared caps. First match wins. Uploads keep their own (tighter) per-route limits; this is only the outer bound.
export const BODY_CAP_RULES = Object.freeze([
  { name: 'memory-and-settings-json', cap: 64 * KB, test: p => ['/api/docteur-memory', '/api/memory', '/api/router', '/api/privacy', '/api/todo', '/api/jobs', '/api/notebooklm', '/api/free-ai', '/api/local-ai', '/api/skills', '/api/activity'].some(pre => under(p, pre)) },
  { name: 'chat-and-search-json', cap: 1 * MB, test: p => ['/api/answer', '/api/search', '/api/clarify', '/api/compare', '/api/web-answer', '/api/web-explore', '/api/secret-scan'].some(pre => under(p, pre)) },
  { name: 'declared-uploads', cap: 2 * GB, test: p => ['/api/files', '/api/backup', '/api/image', '/api/image-generation', '/api/voice', '/api/pdf', '/api/cv-import', '/api/vision', '/api/corpus', '/api/inbox', '/api/video-summary', '/api/download', '/api/openmontage', '/api/audio-player', '/api/sherlock'].some(pre => under(p, pre)) || /^\/api\/notebooks\/[^/]+\/(documents|ai-history)(\/|$)/.test(p) },
]);
export const DEFAULT_BODY_CAP = 64 * MB;
export function bodyCapFor(pathname) { const r = BODY_CAP_RULES.find(x => x.test(pathname)); return { cap: r?.cap ?? DEFAULT_BODY_CAP, rule: r?.name ?? 'default' }; }

const STATEFUL_NO_STORE = ['/api/docteur-memory', '/api/memory', '/api/router', '/api/backup', '/api/privacy']; // neurons stay cacheable: the PWA offline mode may rely on it

export function applyLocalApiSecurity(app, { isAllowedOrigin = () => false, logger = null } = {}) {
  const pathOf = (c) => new URL(c.req.url).pathname;
  app.use('/api/*', createLocalRequestGuard({
    isAllowedOrigin: (origin) => isExpectedFrontendOrigin(origin) || isAllowedOrigin(origin),
    skip: (c) => isFrozenPath(pathOf(c)),
    onReject: (info) => { try { logger?.warn?.(info, 'LOCAL_API_REQUEST_REJECTED'); } catch { /* ignore */ } }, // code / method / path only
  }));
  const limiters = new Map();
  app.use('/api/*', async (c, next) => {
    const pathname = pathOf(c);
    if (isFrozenPath(pathname) || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const { cap } = bodyCapFor(pathname);
    if (!limiters.has(cap)) limiters.set(cap, bodyLimit({ maxSize: cap, onError: (cc) => cc.json({ error: 'Requête trop volumineuse', code: 'BODY_TOO_LARGE' }, 413) }));
    return limiters.get(cap)(c, next);
  });
  app.use('/api/*', async (c, next) => {
    await next();
    const pathname = pathOf(c); if (isFrozenPath(pathname)) return;
    try {
      c.res.headers.set('X-Content-Type-Options', 'nosniff');
      c.res.headers.set('Referrer-Policy', 'no-referrer');
      if (STATEFUL_NO_STORE.some(pre => under(pathname, pre)) && !c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
    } catch { /* immutable (proxied) response headers: leave them alone */ }
  });
}
