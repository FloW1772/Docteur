/**
 * SSRF protection — STATIC pre-check kept for its ~36 existing callers.
 *
 * Since WEB EGRESS GUARD V1 this is a thin wrapper over the central guard
 * (web-egress-guard.js): same parser (WHATWG URL only), same byte-level address
 * classification (IPv4, IPv6, IPv4-mapped IPv6, NAT64, 6to4…), same scheme / userinfo / port policy.
 * The previous string-prefix implementation let `http://[::ffff:127.0.0.1]/`, `http://[::]/`,
 * `http://100.64.0.1/`, multicast, `localhost.` and userinfo URLs through (and wrongly
 * blocked every hostname starting with "fd", e.g. fdic.gov).
 *
 * This function is SYNCHRONOUS and does NOT resolve DNS: a hostname that resolves to an
 * internal address passes it. It is only a fast, early refusal. The authoritative check —
 * DNS validation of every address, a pinned connection and per-hop redirect revalidation —
 * happens inside `safeFetch` (web-egress-guard.js); every code path that actually fetches
 * a user-influenced URL must go through it.
 */
import { validateOutboundUrl, reportEgressBlock } from './web-egress-guard.js';

/**
 * Throws an EgressDeniedError (an Error whose `.message` is the legacy user-facing text and whose
 * `.code` is a structured BLOCKED_* reason) if the URL is not an acceptable public Web target.
 */
export function assertSafeUrl(url) {
  try { validateOutboundUrl(url); } catch (error) { reportEgressBlock(error, 'static-check'); throw error; }
}
