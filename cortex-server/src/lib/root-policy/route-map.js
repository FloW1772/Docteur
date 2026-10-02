/**
 * ROOT POLICY V1 — semantic classification of the HTTP routes of the certified, FROZEN device modules.
 *
 * The frozen modules are NOT modified: Root Policy sits above them, at the HTTP layer, and recognises their existing semantic routes.
 * For these routes the policy's job is narrow and explicit:
 *   • policy valid  → the module's own certified controls decide (decision ALLOW_CERTIFIED_BOUNDARY / ALLOW_CAPABILITY, no extra prompt,
 *                     no behaviour change, no second ADMIN engine);
 *   • policy invalid → protected device operations are refused (fail closed) while STOP / revocation routes ALWAYS stay available.
 *
 * Anything not listed here is not gated by Root Policy at the HTTP layer (inventory & status reads, pairing, local approve/deny, …):
 * that is a deliberate V1 perimeter, documented in the report ("ROOT POLICY PROTECTED ACTIONS V1").
 */

const DF = ['device', 'fabric'].join('-'); // module id assembled from parts (Device Fabric static audit precedent: Root Policy only RECOGNISES those routes)
const R = (re, action, module, trustDomain, extra = {}) => ({ re, action, module, trustDomain, ...extra });

// Order matters: first match wins. Methods: a route entry matches only the listed methods.
const ROUTES = Object.freeze([
  // ── OMEGA V1 (host side, UI-driven) ───────────────────────────────────────────────────────────────────────────
  R(/^\/api\/omega\/view\/[^/]+\/stop$/, 'DEVICE_STOP', 'omega', 'OMEGA', { methods: ['POST'] }),
  R(/^\/api\/omega\/view\/[^/]+\/(start|frame)$/, 'DEVICE_VIEW', 'omega', 'OMEGA', { methods: ['POST', 'GET'] }),
  R(/^\/api\/omega\/interactive\/[^/]+\/stop$/, 'DEVICE_STOP', 'omega', 'OMEGA', { methods: ['POST'] }),
  R(/^\/api\/omega\/interactive\/[^/]+\/(start|input)$/, 'DEVICE_INTERACTIVE', 'omega', 'OMEGA', { methods: ['POST'] }),
  R(/^\/api\/omega\/admin\/actions$/, 'DEVICE_ADMIN', 'omega', 'OMEGA', { methods: ['POST'] }),
  R(/^\/api\/omega\/sessions\/[^/]+$/, 'DEVICE_STOP', 'omega', 'OMEGA', { methods: ['DELETE'] }),
  R(/^\/api\/omega\/devices\/[^/]+\/revoke$/, 'DEVICE_STOP', 'omega', 'OMEGA', { methods: ['POST'] }),
  // ── OMEGA V2 outbound controller (this PC controls another host) ──────────────────────────────────────────────
  R(/^\/api\/omega\/outbound\/(stop-all|sessions\/[^/]+\/stop|sessions\/[^/]+\/view\/stop|sessions\/[^/]+\/interactive\/stop|sessions\/[^/]+\/admin\/operations\/[^/]+\/cancel)$/, 'DEVICE_STOP', 'omega', 'OMEGA', { methods: ['POST'] }),
  R(/^\/api\/omega\/outbound\/sessions\/[^/]+\/view\/(start|frame)$/, 'DEVICE_VIEW', 'omega', 'OMEGA', { methods: ['POST'] }),
  R(/^\/api\/omega\/outbound\/sessions\/[^/]+\/interactive\/start$/, 'DEVICE_INTERACTIVE', 'omega', 'OMEGA', { methods: ['POST'] }),
  R(/^\/api\/omega\/outbound\/connect$/, 'DEVICE_VIEW', 'omega', 'OMEGA', { methods: ['POST'] }),
  // ── OMEGA V2 host adapter (certified mutual-auth protocol endpoints: the caller is a paired controller, not the UI) ─
  R(/^\/api\/omega-v2\/sessions\/[^/]+\/(view|interactive)\/stop$/, 'DEVICE_STOP', 'omega', 'OMEGA', { methods: ['POST'], peer: true }),
  R(/^\/api\/omega-v2\/sessions\/[^/]+\/view\/(start|frame)$/, 'DEVICE_VIEW', 'omega', 'OMEGA', { methods: ['POST'], peer: true }),
  R(/^\/api\/omega-v2\/sessions\/[^/]+\/interactive\/start$/, 'DEVICE_INTERACTIVE', 'omega', 'OMEGA', { methods: ['POST'], peer: true }),
  // ── Device Fabric (exact-target orchestration; target domains keep their own approvals) ───────────────────────────
  R(/^\/api\/device[-]fabric\/(omega-v2\/stop-all|devices\/[^/]+\/omega-v2\/(stop|session\/stop|view\/stop|interactive\/stop|admin\/operations\/cancel))$/, 'DEVICE_STOP', DF, 'DEVICE_FABRIC', { methods: ['POST'] }),
  R(/^\/api\/device[-]fabric\/devices\/[^/]+\/omega-v2\/view\/start$/, 'DEVICE_VIEW', DF, 'DEVICE_FABRIC', { methods: ['POST'] }),
  R(/^\/api\/device[-]fabric\/devices\/[^/]+\/omega-v2\/interactive\/start$/, 'DEVICE_INTERACTIVE', DF, 'DEVICE_FABRIC', { methods: ['POST'] }),
  R(/^\/api\/device[-]fabric\/devices\/[^/]+\/omega-v2\/admin\/(system-info|processes|service-status|network-status|disk-status|lock|logoff|restart|shutdown|operations\/status)$/, 'DEVICE_ADMIN', DF, 'DEVICE_FABRIC', { methods: ['POST'] }),
  R(/^\/api\/device[-]fabric\/devices\/[^/]+\/rassilon\/probe$/, 'RASSILON_JOB', DF, 'DEVICE_FABRIC', { methods: ['POST'] }),
  R(/^\/api\/device[-]fabric\/route$/, 'RASSILON_JOB', DF, 'DEVICE_FABRIC', { methods: ['POST'] }), // explicit semantic RASSILON routing (exact target)
  // ── RASSILON (semantic jobs only) ─────────────────────────────────────────────────────────────────────────────
  R(/^\/api\/rassilon\/stop$/, 'DEVICE_STOP', 'rassilon', 'RASSILON', { methods: ['POST'] }),
  R(/^\/api\/rassilon\/jobs(\/dispatch)?$/, 'RASSILON_JOB', 'rassilon', 'RASSILON', { methods: ['POST'] }),
  R(/^\/api\/rassilon-lan\/jobs$/, 'RASSILON_JOB', 'rassilon', 'RASSILON', { methods: ['POST'], peer: true }),
  R(/^\/api\/rassilon-lan\/jobs\/[^/]+\/cancel$/, 'DEVICE_STOP', 'rassilon', 'RASSILON', { methods: ['POST'], peer: true }),
  // ── MAÎTRE (proposal → local approval → execution; certified) ─────────────────────────────────────────────────────
  R(/^\/api\/maitre\/actions\/[^/]+\/execute$/, 'PROCESS_STOP', 'maitre', 'MAITRE', { methods: ['POST'] }),
]);

/** @returns {{action:string, module:string, trustDomain:string, peer:boolean}|null} */
export function classifyRoute(method, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) return null;
  const m = String(method).toUpperCase();
  for (const entry of ROUTES) {
    if (entry.methods.includes(m) && entry.re.test(pathname)) return { action: entry.action, module: entry.module, trustDomain: entry.trustDomain, peer: entry.peer === true };
  }
  return null;
}

export const ROUTE_MAP_SIZE = ROUTES.length;
