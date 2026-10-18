// SEC-REMED-1 / SEC-3 — the Docteur API listens on loopback only until LAN authentication exists (future LAN-AUTH-1).
//
// SEC-CERT-1 finding: with LOCAL_NETWORK=true the API bound 0.0.0.0 while the central request guard (built against web
// pages: CSRF, DNS rebinding) admits any client that sends no Origin header — so every LAN device could read and change
// memories, notebooks, backups, Companion state, and reach /api/browser/open. Origin / CORS / IP checks are not
// authentication, so the mode fails closed instead: a non-loopback bind refuses to start, before any store is opened.

export const LAN_API_DISABLED = 'LAN_API_DISABLED_PENDING_AUTHENTICATION';

const LOOPBACK_V4 = /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || (LOOPBACK_V4.test(h) && h.split('.').every(n => Number(n) <= 255));
}

/**
 * Returns the host the API may bind to (default 127.0.0.1). Throws LAN_API_DISABLED_PENDING_AUTHENTICATION when the
 * configuration asks for LAN exposure (LOCAL_NETWORK=true, or HOST set to a non-loopback address such as 0.0.0.0 / ::).
 */
export function resolveApiBindHost({ localNetwork = false, host } = {}) {
  const fail = (why) => {
    const error = new Error(`${LAN_API_DISABLED}: ${why} would expose the unauthenticated Docteur API on the network; refused until LAN authentication exists (LAN-AUTH-1). Use the default loopback mode.`);
    error.code = LAN_API_DISABLED;
    throw error;
  };
  if (localNetwork) fail('LOCAL_NETWORK=true');
  if (host === undefined || host === null || String(host).trim() === '') return '127.0.0.1';
  if (!isLoopbackHost(host)) fail(`HOST=${String(host).slice(0, 64)}`);
  return String(host).trim();
}
