/**
 * MEDIA EGRESS — Root Policy + network engine for every `yt-dlp` process.
 *
 * Before this module, yt-dlp was protected only by a STATIC URL check: yt-dlp then resolved DNS and followed redirects by itself, so a public
 * page redirecting to an internal address was fetched (measured: the internal target received 2 connections). yt-dlp is NOT disabled and no
 * site/format is removed. Instead:
 *
 *   1. ROOT POLICY decides whether this semantic action may be attempted (MEDIA_INSPECT / MEDIA_DOWNLOAD, module `media`, public network);
 *   2. the process is started with `--proxy` pointing at a loopback-only forwarding proxy that validates every destination and every
 *      redirect hop with the Web Egress Guard and connects to a validated, pinned address (DNS, HTTPS/TLS end-to-end via CONNECT, HLS,
 *      DASH, fragments and CDN hops all work: yt-dlp re-requests each hop through the proxy; ffmpeg receives the proxy from yt-dlp).
 *
 * The proxy needs no credentials: it is bound to 127.0.0.1, accepts only absolute-URI / CONNECT requests and forwards only to public
 * destinations, so a local process gains nothing it does not already have, and no secret ever appears on a command line or in yt-dlp's
 * verbose output.
 */
import { startBrowserEgressProxy } from './web-egress-guard.js';
import { enforceMedia } from './root-policy/index.js';

let proxyPromise = null;
let proxyUrl = null;

/** Called once at server boot (before the server accepts requests). Idempotent. */
export async function startMediaEgress() {
  proxyPromise ??= startBrowserEgressProxy({ purpose: 'media', requireAuth: false }).then((p) => { proxyUrl = p.url; return p; }).catch((error) => { proxyPromise = null; throw error; });
  return proxyPromise;
}

export async function stopMediaEgress() {
  const pending = proxyPromise; proxyPromise = null; proxyUrl = null;
  if (pending) await (await pending.catch(() => null))?.close();
}

export function mediaEgressReady() { return proxyUrl !== null; }

/**
 * @param {{ action?: 'MEDIA_INSPECT'|'MEDIA_DOWNLOAD', credentialSource?: 'none'|'user-browser-session', spawnInjected?: boolean }} options
 *   `spawnInjected`: the caller was handed a fake `spawn` (unit-test seam, never set in production code paths): no real process is started.
 * @returns {string[]} extra yt-dlp arguments (`--proxy <url>`).
 * @throws RootPolicyDeniedError when Root Policy refuses; MEDIA_EGRESS_NOT_READY when the proxy is not running outside test mode (fail closed).
 */
export function prepareYtDlp({ action = 'MEDIA_DOWNLOAD', credentialSource = 'none', spawnInjected = false } = {}) {
  enforceMedia({ action, credentialSource });
  if (proxyUrl) return ['--proxy', proxyUrl];
  // Unit tests inject a fake `spawn` and never start a real process (same convention as the CLI providers' EXTERNAL_CALL_BLOCKED_IN_TEST).
  // Root Policy has ALREADY been consulted above: the injection only waives the proxy requirement, never the policy decision.
  if (spawnInjected || process.env.DOCTEUR_TEST_MODE === '1') return [];
  throw Object.assign(new Error('Moteur réseau média indisponible (proxy de sortie non démarré)'), { code: 'MEDIA_EGRESS_NOT_READY' });
}
