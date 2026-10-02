/**
 * WEB EGRESS GUARD V1 — the single, central network-boundary guard for every
 * outbound Web request whose destination is (directly or indirectly) influenced
 * by a user, a document, an AI or any external source (class PUBLIC_EGRESS).
 *
 *   INPUT → URL PARSE → NORMALIZATION → SCHEME/POLICY → HOST VALIDATION
 *         → DNS / ADDRESS VALIDATION → CONNECTION (pinned) → REDIRECT
 *         → REVALIDATION → RESPONSE (bounded)
 *
 * What it is NOT: it is not for trusted local services (Ollama, kiwix-serve,
 * ComfyUI, PAIR, Docteur's own API) nor for the certified device protocols
 * (OMEGA / RASSILON / Device Fabric). Those keep their own typed trust paths and
 * must never be routed through a rule that says "loopback is forbidden".
 *
 * Design decisions (see reports/WEB_EGRESS_GUARD_V1_2026-10.md):
 *  - The URL is parsed ONLY by the WHATWG parser (no regex parsing); every
 *    decision is taken on the canonical form.
 *  - Addresses are classified by BYTES (IPv4 and IPv6), never by string prefix.
 *    An IPv4 embedded in an IPv6 (mapped / compatible / NAT64 / 6to4) is judged by
 *    the IPv4 rules. For IPv6 the policy is an ALLOW-list (global unicast 2000::/3
 *    minus special-use blocks); for IPv4 it is the IANA special-purpose list.
 *  - Hostnames are resolved here, EVERY resolved address is validated, and the
 *    socket is then forced to connect to a validated address through a pinned
 *    `lookup` — Host header, SNI and certificate verification keep using the
 *    hostname (the URL is passed to https.request unchanged), so TLS stays correct.
 *  - Redirects are never followed by the runtime: each hop is parsed, resolved,
 *    validated and connected to individually (bounded, loop-checked).
 *  - Everything fails closed: DNS error, unknown address class, malformed URL,
 *    malformed Location, internal error ⇒ the request is refused.
 *
 * `createEgressClient()` exists so tests can inject a resolver / transport / a
 * fixture address policy. Production code must only use the default exports; a
 * static test (test-web-egress-guard.mjs) fails if any other source file calls
 * `createEgressClient` or passes `addressPolicy`.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { Readable, Transform, pipeline } from 'node:stream';

// ─────────────────────────────────────────────────────────────────────────────
// Reasons / errors
// ─────────────────────────────────────────────────────────────────────────────

export const EGRESS_REASONS = Object.freeze({
  INVALID_URL: 'BLOCKED_INVALID_URL',
  SCHEME: 'BLOCKED_SCHEME',
  USERINFO: 'BLOCKED_USERINFO',
  PORT: 'BLOCKED_PORT',
  LOCAL_NAME: 'BLOCKED_LOCAL_NAME',
  LOOPBACK: 'BLOCKED_LOOPBACK',
  PRIVATE: 'BLOCKED_PRIVATE',
  LINK_LOCAL: 'BLOCKED_LINK_LOCAL',
  METADATA: 'BLOCKED_METADATA',
  UNSPECIFIED: 'BLOCKED_UNSPECIFIED',
  MULTICAST: 'BLOCKED_MULTICAST',
  RESERVED: 'BLOCKED_RESERVED',
  DNS_PRIVATE: 'BLOCKED_DNS_PRIVATE',
  DNS_FAILURE: 'BLOCKED_DNS_FAILURE',
  REDIRECT: 'BLOCKED_REDIRECT',
  REDIRECT_DOWNGRADE: 'BLOCKED_REDIRECT_DOWNGRADE',
  TOO_MANY_REDIRECTS: 'BLOCKED_TOO_MANY_REDIRECTS',
  REDIRECT_LOOP: 'BLOCKED_REDIRECT_LOOP',
  METHOD: 'BLOCKED_METHOD',
  RESPONSE_TOO_LARGE: 'BLOCKED_RESPONSE_TOO_LARGE',
  ENCODING: 'BLOCKED_ENCODING',
  HOST_NOT_TRUSTED: 'BLOCKED_HOST_NOT_TRUSTED',
  ROOT_POLICY: 'BLOCKED_ROOT_POLICY',
  INTERNAL: 'BLOCKED_INTERNAL_ERROR',
});

const CATEGORY_TO_REASON = Object.freeze({
  LOOPBACK: EGRESS_REASONS.LOOPBACK,
  PRIVATE: EGRESS_REASONS.PRIVATE,
  LINK_LOCAL: EGRESS_REASONS.LINK_LOCAL,
  METADATA: EGRESS_REASONS.METADATA,
  UNSPECIFIED: EGRESS_REASONS.UNSPECIFIED,
  MULTICAST: EGRESS_REASONS.MULTICAST,
  RESERVED: EGRESS_REASONS.RESERVED,
});

// User-facing messages stay deliberately generic (no resolved addresses, no policy detail).
const GENERIC_MESSAGE = 'URL bloquée : les adresses internes ne sont pas autorisées';
const MESSAGES = Object.freeze({
  [EGRESS_REASONS.INVALID_URL]: 'URL invalide',
  [EGRESS_REASONS.SCHEME]: 'Protocole non autorisé (http/https uniquement)',
  [EGRESS_REASONS.USERINFO]: 'URL bloquée : identifiants dans l’URL non autorisés',
  [EGRESS_REASONS.PORT]: 'URL bloquée : port non autorisé',
  [EGRESS_REASONS.REDIRECT]: 'Redirection bloquée',
  [EGRESS_REASONS.REDIRECT_DOWNGRADE]: 'Redirection bloquée',
  [EGRESS_REASONS.TOO_MANY_REDIRECTS]: 'Trop de redirections',
  [EGRESS_REASONS.REDIRECT_LOOP]: 'Redirection en boucle',
  [EGRESS_REASONS.METHOD]: 'Méthode non autorisée',
  [EGRESS_REASONS.RESPONSE_TOO_LARGE]: 'Réponse trop volumineuse',
  [EGRESS_REASONS.ENCODING]: 'Encodage de réponse non pris en charge',
  [EGRESS_REASONS.DNS_FAILURE]: 'Résolution DNS impossible',
  [EGRESS_REASONS.HOST_NOT_TRUSTED]: 'URL bloquée : hôte non autorisé',
  [EGRESS_REASONS.ROOT_POLICY]: 'Action refusée par la Root Policy',
  [EGRESS_REASONS.INTERNAL]: 'Validation réseau impossible',
});

export class EgressDeniedError extends Error {
  constructor(reason, { category = null, hop = 0, host = null } = {}) {
    super(MESSAGES[reason] ?? GENERIC_MESSAGE);
    this.name = 'EgressDeniedError';
    this.code = reason;
    this.reason = reason;
    this.category = category;
    this.hop = hop;
    this.host = host;
    this.egressBlocked = true;
  }
}

export class EgressTimeoutError extends Error {
  constructor(phase) {
    super(`Délai dépassé (${phase})`);
    this.name = 'TimeoutError';
    this.code = 'EGRESS_TIMEOUT';
    this.phase = phase;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured, secret-free logging (hostname only — never userinfo/path/query/headers)
// ─────────────────────────────────────────────────────────────────────────────

let egressLogger = null;
export function setEgressLogger(logger) { egressLogger = logger ?? null; }

// ROOT POLICY seam: "may this WEB_FETCH be attempted at all?" is asked BEFORE "is this destination safe?". The hook is set once at server boot
// (Root Policy runtime) and is fail-closed: a hook that throws refuses the request. Two separate responsibilities, deliberately.
let egressPolicyHook = null;
export function setEgressPolicyHook(fn) { egressPolicyHook = typeof fn === 'function' ? fn : null; }
function checkRootPolicy(surface, purpose) {
  if (!egressPolicyHook) return;
  let refused;
  try { refused = egressPolicyHook({ surface, purpose }); } catch { refused = true; }
  if (refused) throw new EgressDeniedError(EGRESS_REASONS.ROOT_POLICY);
}

/** Public hook for the static pre-check wrapper (url-security.js): same structured, secret-free event. */
export function reportEgressBlock(error, purpose) { if (error?.egressBlocked) logBlocked(error, purpose); }

function logBlocked(error, purpose) {
  try {
    egressLogger?.warn?.({ event: 'EGRESS_BLOCKED', reason: error.reason, category: error.category ?? undefined, host: error.host ?? undefined, hop: error.hop, purpose: purpose ?? undefined }, 'EGRESS_BLOCKED');
  } catch { /* logging must never alter the security decision */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Address classification (IPv4 + IPv6, by bytes)
// ─────────────────────────────────────────────────────────────────────────────

/** Strict dotted-quad → bytes. The WHATWG parser already canonicalises URL hosts; dns results are canonical too. */
export function parseIPv4(text) {
  if (typeof text !== 'string' || !net.isIPv4(text)) return null;
  const parts = text.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** IPv6 text (no brackets, no zone) → 16 bytes, handling `::` and an embedded dotted IPv4 tail. */
export function parseIPv6(text) {
  if (typeof text !== 'string' || text.includes('%') || !net.isIPv6(text)) return null;
  let s = text;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const value = parseInt(groups[i], 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

// IANA IPv4 Special-Purpose Address Registry (RFC 6890 and updates) + well-known cloud metadata endpoints.
// First match wins; metadata /32 entries precede the ranges that contain them so they report METADATA.
const V4_METADATA = Object.freeze([
  [[169, 254, 169, 254], 'AWS/GCP/Azure/OpenStack IMDS'],
  [[169, 254, 170, 2], 'AWS ECS task metadata'],
  [[100, 100, 100, 200], 'Alibaba Cloud metadata'],
  [[192, 0, 0, 192], 'Oracle Cloud metadata'],
  [[168, 63, 129, 16], 'Azure WireServer'],
]);
const V4_RANGES = Object.freeze([
  [[0, 0, 0, 0], 8, 'RESERVED'],            // 0.0.0.0/8 "this network" (0.0.0.0 itself → UNSPECIFIED below)
  [[10, 0, 0, 0], 8, 'PRIVATE'],            // RFC 1918
  [[100, 64, 0, 0], 10, 'PRIVATE'],         // RFC 6598 shared address space (CGNAT)
  [[127, 0, 0, 0], 8, 'LOOPBACK'],          // RFC 1122
  [[169, 254, 0, 0], 16, 'LINK_LOCAL'],     // RFC 3927
  [[172, 16, 0, 0], 12, 'PRIVATE'],         // RFC 1918
  [[192, 0, 0, 0], 24, 'RESERVED'],         // IETF protocol assignments
  [[192, 0, 2, 0], 24, 'RESERVED'],         // TEST-NET-1
  [[192, 88, 99, 0], 24, 'RESERVED'],       // 6to4 relay anycast (deprecated)
  [[192, 168, 0, 0], 16, 'PRIVATE'],        // RFC 1918
  [[198, 18, 0, 0], 15, 'RESERVED'],        // benchmarking
  [[198, 51, 100, 0], 24, 'RESERVED'],      // TEST-NET-2
  [[203, 0, 113, 0], 24, 'RESERVED'],       // TEST-NET-3
  [[224, 0, 0, 0], 4, 'MULTICAST'],         // 224.0.0.0/4
  [[240, 0, 0, 0], 4, 'RESERVED'],          // 240.0.0.0/4 incl. limited broadcast 255.255.255.255
]);

function v4ToInt(b) { return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }
function v4InRange(b, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((v4ToInt(b) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

function classifyV4Bytes(b) {
  if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0) return 'UNSPECIFIED';
  for (const [addr] of V4_METADATA) if (addr.every((n, i) => n === b[i])) return 'METADATA';
  for (const [base, prefix, category] of V4_RANGES) if (v4InRange(b, base, prefix)) return category;
  return 'PUBLIC';
}

function hasPrefix(bytes, prefix, bits) {
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (bytes[i] !== prefix[i]) return false;
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[full] & mask) === (prefix[full] & mask);
}

const V6_METADATA = Object.freeze([parseIPv6('fd00:ec2::254')]); // AWS IMDS over IPv6

function classifyV6Bytes(b) {
  if (b.every(x => x === 0)) return { category: 'UNSPECIFIED' };
  if (b.slice(0, 15).every(x => x === 0) && b[15] === 1) return { category: 'LOOPBACK' };
  for (const m of V6_METADATA) if (m.every((x, i) => x === b[i])) return { category: 'METADATA' };
  const embedded = (offset) => classifyV4Bytes([b[offset], b[offset + 1], b[offset + 2], b[offset + 3]]);
  // ::ffff:0:0/96 IPv4-mapped — judged by the IPv4 rules of the embedded address.
  // A mapped form of a NON-public IPv4 keeps the precise IPv4 category (loopback, private, metadata…). A mapped form of a
  // public IPv4 is still refused (RESERVED): it has no legitimate use for Web egress and every certified Docteur classifier
  // (Sherlock, Cyber Audit) already refuses mapped forms, so no caller can rely on it.
  if (b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    const c = embedded(12);
    return { category: c === 'PUBLIC' ? 'RESERVED' : c, mapped: true };
  }
  // ::/96 IPv4-compatible (deprecated) — never public; report the embedded class when it is already non-public.
  if (b.slice(0, 12).every(x => x === 0)) { const c = embedded(12); return { category: c === 'PUBLIC' ? 'RESERVED' : c, embeddedV4: true }; }
  // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local-use NAT64 — never needed; non-public embedded class wins.
  if (hasPrefix(b, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) { const c = embedded(12); return { category: c === 'PUBLIC' ? 'RESERVED' : c, embeddedV4: true }; }
  if (hasPrefix(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return { category: 'RESERVED' };
  // 2002::/16 6to4 embeds an IPv4 in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) { const c = embedded(2); return { category: c === 'PUBLIC' ? 'RESERVED' : c, embeddedV4: true }; }
  if (hasPrefix(b, [0xfe, 0x80], 10)) return { category: 'LINK_LOCAL' };      // fe80::/10
  if (hasPrefix(b, [0xfe, 0xc0], 10)) return { category: 'PRIVATE' };         // fec0::/10 site-local (deprecated)
  if (hasPrefix(b, [0xfc], 7)) return { category: 'PRIVATE' };                // fc00::/7 ULA
  if (b[0] === 0xff) return { category: 'MULTICAST' };                        // ff00::/8
  // Allow-list: global unicast 2000::/3 minus special-use blocks.
  if (!hasPrefix(b, [0x20], 3)) return { category: 'RESERVED' };
  if (hasPrefix(b, [0x20, 0x01, 0x00, 0x00], 23)) return { category: 'RESERVED' };                         // 2001::/23 IETF protocol (Teredo, ORCHID…)
  if (hasPrefix(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return { category: 'RESERVED' };                         // 2001:db8::/32 documentation
  if (hasPrefix(b, [0x3f, 0xff, 0x00, 0x00], 20)) return { category: 'RESERVED' };                         // 3fff::/20 documentation
  return { category: 'PUBLIC' };
}

/**
 * Classifies an IP literal (IPv4, IPv6, IPv4-mapped IPv6, optionally bracketed).
 * Unparseable / unknown ⇒ { public:false, category:'RESERVED', unknown:true } (fail closed).
 */
export function classifyAddress(address) {
  const text = String(address ?? '').replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(text);
  if (v4) { const category = classifyV4Bytes(v4); return { address: text, family: 4, category, public: category === 'PUBLIC' }; }
  const v6 = parseIPv6(text);
  if (v6) { const r = classifyV6Bytes(v6); return { address: text, family: 6, category: r.category, public: r.category === 'PUBLIC', mapped: !!r.mapped }; }
  return { address: text, family: 0, category: 'RESERVED', public: false, unknown: true };
}

export function isPublicAddress(address) { return classifyAddress(address).public; }

// ─────────────────────────────────────────────────────────────────────────────
// Static URL validation
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_SUFFIXES = Object.freeze(['localhost', 'local', 'localdomain', 'internal', 'lan', 'home.arpa', 'intranet']);
const MAX_URL_LENGTH = 8192;

export const DEFAULT_POLICY = Object.freeze({
  schemes: Object.freeze(['https:', 'http:']),
  ports: Object.freeze([80, 443]),
  maxRedirects: 5,
  allowHttpDowngrade: false,
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function effectivePort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function normalizedHost(url) {
  let host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** `lookup` option for a socket: answers ONLY with already-validated addresses, whatever name is asked. */
export function pinnedLookup(addresses) {
  return (_host, opts, callback) => {
    const wanted = opts && typeof opts === 'object' ? opts.family : opts;
    const list = addresses.filter(a => !wanted || wanted === 0 || a.family === Number(wanted));
    if (list.length === 0) return callback(Object.assign(new Error('no validated address for requested family'), { code: 'ENOTFOUND' }));
    if (opts && typeof opts === 'object' && opts.all) return callback(null, list.map(a => ({ address: a.address, family: a.family })));
    return callback(null, list[0].address, list[0].family);
  };
}

function tagNetworkError(error) {
  if (error && typeof error === 'object') { try { error.egressNetwork = true; } catch { /* frozen error */ } }
  throw error;
}

function createEgressClientInternal(config) {
  const cfg = {
    lookup: config.lookup ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true })),
    // Test seam ONLY (see header): decides whether a classified address may be connected to.
    addressPolicy: config.addressPolicy ?? (info => info.public === true),
    ports: config.ports ?? DEFAULT_POLICY.ports,
    schemes: config.schemes ?? DEFAULT_POLICY.schemes,
    maxRedirects: config.maxRedirects ?? DEFAULT_POLICY.maxRedirects,
    allowHttpDowngrade: config.allowHttpDowngrade ?? DEFAULT_POLICY.allowHttpDowngrade,
    dnsTimeoutMs: config.dnsTimeoutMs ?? 5000,
    transport: config.transport ?? null,
    fetchImpl: config.fetchImpl ?? null,
    tls: config.tls ?? null, // test seam: extra https.request options (e.g. a fixture `ca`); never used in production
  };
  const policyPorts = new Set(cfg.ports.map(Number));

  function deny(reason, extra) { return new EgressDeniedError(reason, extra); }

  /**
   * Static validation: parse → scheme → userinfo → host (literal address / local names) → port.
   * Never touches the network. Returns { url, host, literal } or throws EgressDeniedError.
   */
  function validateOutboundUrl(raw, { hop = 0, allowHttp = true } = {}) {
    if (typeof raw !== 'string' && !(raw instanceof URL)) throw deny(EGRESS_REASONS.INVALID_URL, { hop });
    const text = raw instanceof URL ? raw.href : raw;
    if (!text || text.length > MAX_URL_LENGTH) throw deny(EGRESS_REASONS.INVALID_URL, { hop });
    let url;
    try { url = new URL(text); } catch { throw deny(EGRESS_REASONS.INVALID_URL, { hop }); }
    if (!cfg.schemes.includes(url.protocol) || (url.protocol === 'http:' && !allowHttp)) throw deny(EGRESS_REASONS.SCHEME, { hop });
    if (url.username || url.password) throw deny(EGRESS_REASONS.USERINFO, { hop });
    const host = normalizedHost(url);
    if (!host || host.includes('..') || host.startsWith('.') || host.endsWith('.')) throw deny(EGRESS_REASONS.INVALID_URL, { hop });

    const literal = net.isIP(host) !== 0;
    if (literal) {
      const info = classifyAddress(host);
      if (!cfg.addressPolicy(info)) throw deny(CATEGORY_TO_REASON[info.category] ?? EGRESS_REASONS.RESERVED, { hop, category: info.category, host });
    } else {
      if (!host.includes('.')) throw deny(EGRESS_REASONS.LOCAL_NAME, { hop, host });
      if (LOCAL_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`))) throw deny(EGRESS_REASONS.LOCAL_NAME, { hop, host });
    }
    if (!policyPorts.has(effectivePort(url))) throw deny(EGRESS_REASONS.PORT, { hop, host });
    return { url, host, literal };
  }

  /** Resolves a validated URL's host and validates EVERY address (never "first good one"). */
  async function resolveOutboundTarget(validated, { hop = 0 } = {}) {
    const { host, literal } = validated;
    let records;
    if (literal) {
      records = [{ address: host, family: net.isIP(host) }];
    } else {
      let timer;
      try {
        records = await Promise.race([
          Promise.resolve().then(() => cfg.lookup(host)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('dns_timeout')), cfg.dnsTimeoutMs); }),
        ]);
      } catch {
        throw deny(EGRESS_REASONS.DNS_FAILURE, { hop, host });
      } finally { clearTimeout(timer); }
    }
    if (!Array.isArray(records) || records.length === 0) throw deny(EGRESS_REASONS.DNS_FAILURE, { hop, host });
    const addresses = [];
    for (const record of records) {
      const info = classifyAddress(record?.address);
      if (!cfg.addressPolicy(info)) {
        throw deny(literal ? (CATEGORY_TO_REASON[info.category] ?? EGRESS_REASONS.RESERVED) : EGRESS_REASONS.DNS_PRIVATE, { hop, category: info.category, host });
      }
      addresses.push({ address: info.address, family: info.family });
    }
    return { ...validated, addresses };
  }

  /** Static + DNS validation without connecting (for external processes that resolve on their own: PARTIAL by nature). */
  async function assertPublicDestination(raw, options = {}) {
    try {
      checkRootPolicy('external-check', options.purpose);
      const target = await resolveOutboundTarget(validateOutboundUrl(raw, options), options);
      return { host: target.host, addresses: target.addresses.length };
    } catch (error) {
      const wrapped = error?.egressBlocked ? error : deny(EGRESS_REASONS.INTERNAL, {});
      logBlocked(wrapped, options.purpose);
      throw wrapped;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pinned connection (one hop)
  // ───────────────────────────────────────────────────────────────────────────

  function abortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
  }

  function pinnedHop({ url, addresses, method, headers, signal, timeoutMs, idleTimeoutMs, totalDeadline, maxBytes }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const lib = url.protocol === 'https:' ? https : http;
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const requestOptions = {
        protocol: url.protocol,
        host,
        port: effectivePort(url),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent: false,
        timeout: idleTimeoutMs,
        lookup: pinnedLookup(addresses),
        ...(url.protocol === 'https:' && cfg.tls ? cfg.tls : {}),
      };
      let settled = false;
      let activeRes = null;
      let headerTimer = null;
      let totalTimer = null;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(headerTimer); signal?.removeEventListener('abort', onAbort); fn(value); };
      const onAbort = () => { const err = abortError(signal); request.destroy(err); finish(reject, err); };
      const request = (cfg.transport ?? lib.request)(requestOptions, res => {
        clearTimeout(headerTimer);
        resolve_(res);
      });
      const resolve_ = (res) => {
        activeRes = res;
        const declared = Number(res.headers['content-length']);
        if (method !== 'HEAD' && Number.isFinite(declared) && declared > maxBytes && !REDIRECT_STATUSES.has(res.statusCode)) {
          res.destroy();
          request.destroy();
          return finish(reject, deny(EGRESS_REASONS.RESPONSE_TOO_LARGE, {}));
        }
        if (totalDeadline) {
          const remaining = Math.max(1, totalDeadline - Date.now());
          totalTimer = setTimeout(() => { const err = new EgressTimeoutError('total'); res.destroy(err); request.destroy(err); }, remaining);
          res.once('close', () => clearTimeout(totalTimer));
        }
        // From here on an abort must tear the BODY stream down (the headers phase is over).
        const onBodyAbort = () => { const err = abortError(signal); res.destroy(err); request.destroy(err); };
        signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onBodyAbort, { once: true });
        res.once('close', () => signal?.removeEventListener('abort', onBodyAbort));
        finish(resolve, res);
      };
      headerTimer = setTimeout(() => { const err = new EgressTimeoutError('response-headers'); request.destroy(err); finish(reject, err); }, timeoutMs);
      request.on('timeout', () => { const err = new EgressTimeoutError('idle'); if (activeRes) activeRes.destroy(err); request.destroy(err); finish(reject, err); });
      request.on('error', err => finish(reject, err));
      signal?.addEventListener('abort', onAbort, { once: true });
      request.end();
    });
  }

  function decodeBody(res, maxBytes) {
    const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
    let source = res;
    if (encoding && encoding !== 'identity') {
      let decoder;
      if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip();
      else if (encoding === 'deflate') decoder = zlib.createInflate();
      else if (encoding === 'br') decoder = zlib.createBrotliDecompress();
      else { res.destroy(); throw deny(EGRESS_REASONS.ENCODING, {}); }
      source = pipeline(res, decoder, () => {});
    }
    let total = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length;
        if (total > maxBytes) return cb(deny(EGRESS_REASONS.RESPONSE_TOO_LARGE, {}));
        return cb(null, chunk);
      },
    });
    const out = pipeline(source, limiter, () => {});
    return out;
  }

  function buildResponse(res, finalUrl, redirected, maxBytes, method) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (Array.isArray(value)) value.forEach(v => headers.append(key, v)); else if (value !== undefined) headers.set(key, String(value));
    }
    const encoded = headers.has('content-encoding') && headers.get('content-encoding').toLowerCase() !== 'identity';
    if (encoded) { headers.delete('content-encoding'); headers.delete('content-length'); }
    const status = res.statusCode;
    const bodyless = method === 'HEAD' || status === 204 || status === 205 || status === 304;
    let body = null;
    if (bodyless) { res.resume(); } else { body = Readable.toWeb(decodeBody(res, maxBytes)); }
    const response = new Response(body, { status, statusText: res.statusMessage ?? '', headers });
    Object.defineProperty(response, 'url', { value: finalUrl });
    Object.defineProperty(response, 'redirected', { value: redirected });
    return response;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // safeFetch — the only entry point for PUBLIC_EGRESS requests
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param {string|URL} input
   * @param {object} [options]
   *   method        GET | HEAD (default GET) — no request bodies through this path.
   *   headers       plain object. Authorization/Cookie/Proxy-Authorization are dropped on a cross-origin redirect.
   *   signal        AbortSignal
   *   timeoutMs     max wait for response headers, per hop (default 15 000)
   *   idleTimeoutMs max socket inactivity (default 30 000)
   *   totalTimeoutMs optional overall deadline including body (omit for large downloads)
   *   maxBytes      decoded body cap (default 5 MiB) — Content-Length pre-check + streaming cap
   *   maxRedirects  default 5 (0 = any redirect is refused)
   *   allowHttp     default true
   *   trustedHosts  FIXED_EXTERNAL_PROVIDER only: exact hostnames whose FIRST hop may use the runtime `fetch`
   *                 (https only). Every redirect hop is still fully validated and pinned.
   *   purpose       short label for logs
   */
  async function safeFetch(input, options = {}) {
    const {
      method = 'GET', headers = {}, signal, timeoutMs = 15_000, idleTimeoutMs = 30_000, totalTimeoutMs = null,
      maxBytes = 5 * 1024 * 1024, maxRedirects = cfg.maxRedirects, allowHttp = true, trustedHosts = null, purpose,
    } = options;
    const trusted = trustedHosts ? new Set(trustedHosts.map(h => String(h).toLowerCase())) : null;
    try {
      if (!['GET', 'HEAD'].includes(method)) throw deny(EGRESS_REASONS.METHOD, {});
      checkRootPolicy('safeFetch', purpose);
      const totalDeadline = totalTimeoutMs ? Date.now() + totalTimeoutMs : null;
      const visited = new Set();
      let current = input;
      let previous = null;
      let reqHeaders = { ...headers };
      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (signal?.aborted) throw abortError(signal);
        const validated = validateOutboundUrl(current, { hop, allowHttp });
        const key = validated.url.href.split('#')[0];
        if (visited.has(key)) throw deny(EGRESS_REASONS.REDIRECT_LOOP, { hop, host: validated.host });
        visited.add(key);
        if (previous && previous.protocol === 'https:' && validated.url.protocol === 'http:' && !cfg.allowHttpDowngrade) {
          throw deny(EGRESS_REASONS.REDIRECT_DOWNGRADE, { hop, host: validated.host });
        }
        if (previous && previous.origin !== validated.url.origin) {
          reqHeaders = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => !['authorization', 'cookie', 'proxy-authorization'].includes(k.toLowerCase())));
        }
        const hopHeaders = { 'user-agent': 'Docteur/1.0', accept: '*/*', 'accept-encoding': 'gzip, deflate, br', ...Object.fromEntries(Object.entries(reqHeaders).map(([k, v]) => [k.toLowerCase(), v])) };

        let status; let location; let finalResponse;
        const isTrustedFirstHop = hop === 0 && trusted && trusted.has(validated.host) && validated.url.protocol === 'https:' && !validated.literal;
        if (isTrustedFirstHop) {
          const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
          const res = await Promise.resolve(fetchImpl(validated.url.href, { method, headers: { ...reqHeaders }, signal, redirect: 'manual' })).catch(tagNetworkError);
          status = Number(res?.status);
          location = typeof res?.headers?.get === 'function' ? res.headers.get('location') : null;
          finalResponse = res;
          if (!REDIRECT_STATUSES.has(status) || !location) return finalResponse;
          try { await res.body?.cancel?.(); } catch { /* ignore */ }
        } else {
          if (trusted && hop === 0 && !trusted.has(validated.host)) throw deny(EGRESS_REASONS.HOST_NOT_TRUSTED, { hop, host: validated.host });
          const target = await resolveOutboundTarget(validated, { hop });
          const res = await pinnedHop({ url: validated.url, addresses: target.addresses, method, headers: hopHeaders, signal, timeoutMs, idleTimeoutMs, totalDeadline, maxBytes }).catch(tagNetworkError);
          status = res.statusCode;
          location = res.headers.location;
          if (!REDIRECT_STATUSES.has(status) || !location) {
            return buildResponse(res, validated.url.href, hop > 0, maxBytes, method);
          }
          res.resume();
        }
        // Redirect: resolve the Location against the previous URL; the next loop iteration revalidates EVERYTHING.
        if (hop === maxRedirects) throw deny(EGRESS_REASONS.TOO_MANY_REDIRECTS, { hop, host: validated.host });
        let next;
        try { next = new URL(location, validated.url); } catch { throw deny(EGRESS_REASONS.REDIRECT, { hop: hop + 1, host: validated.host }); }
        previous = validated.url;
        current = next.href;
      }
      throw deny(EGRESS_REASONS.TOO_MANY_REDIRECTS, {});
    } catch (error) {
      if (error?.egressBlocked) { logBlocked(error, purpose); throw error; }
      // Errors produced by the connection itself (ECONNREFUSED, TLS verification failures, aborts, timeouts…) are
      // reported as they are; ANYTHING else raised inside the guard is an internal failure ⇒ refused (fail closed).
      if (error?.egressNetwork === true || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      const wrapped = deny(EGRESS_REASONS.INTERNAL, {});
      logBlocked(wrapped, purpose);
      throw wrapped;
    }
  }

  return { validateOutboundUrl, resolveOutboundTarget, assertPublicDestination, safeFetch, _config: cfg };
}

/** TEST SEAM — production code must use the default exports below. */
export function createEgressClient(config = {}) { return createEgressClientInternal(config); }

const defaultClient = createEgressClientInternal({});
export const validateOutboundUrl = defaultClient.validateOutboundUrl;
export const resolveOutboundTarget = defaultClient.resolveOutboundTarget;
export const assertPublicDestination = defaultClient.assertPublicDestination;
export const safeFetch = defaultClient.safeFetch;

// ─────────────────────────────────────────────────────────────────────────────
// Browser (Playwright / Chromium) egress
// ─────────────────────────────────────────────────────────────────────────────
//
// A headless browser follows redirects, loads sub-resources and runs page scripts BY ITSELF. Measured with the real harness
// (test-web-egress-harness.mjs): a Playwright `context.route()` filter sees the first request of a navigation but NOT the
// redirect hops Chromium follows internally — a public page that 302-redirects to an internal address still reached it.
// A request filter is therefore NOT a network boundary. The boundary is a local forwarding proxy that Chromium is forced
// through (`startBrowserEgressProxy`): every connection of every request, redirect hop, sub-resource, XHR/fetch and iframe is
// validated by the same guard and then connected to a VALIDATED, PINNED address (so Chromium's own DNS is never used for
// proxied traffic, which also closes the DNS-rebinding window for the browser path).

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function proxyAuthorized(req, expected) {
  const given = Buffer.from(String(req.headers['proxy-authorization'] ?? ''));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

function stripHopByHop(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())));
}

/**
 * Starts a loopback-only forwarding proxy (random port + per-start random credentials) that only forwards to destinations
 * accepted by the egress guard. Plain HTTP requests are forwarded WITHOUT following redirects (the browser re-requests each
 * hop through the proxy, so each hop is validated); HTTPS uses CONNECT tunnels to a validated, pinned address (TLS stays
 * end-to-end between the browser and the site — no interception). WebSocket/upgrade requests are refused.
 */
export async function startBrowserEgressProxy({ client = defaultClient, purpose = 'browser', maxResponseBytes = 256 * 1024 * 1024, idleTimeoutMs = 120_000, requireAuth = true } = {}) {
  const username = 'docteur-egress';
  const password = randomBytes(24).toString('base64url');
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

  const refuse = (error) => {
    const wrapped = error?.egressBlocked ? error : new EgressDeniedError(EGRESS_REASONS.INTERNAL, {});
    logBlocked(wrapped, purpose);
    return wrapped;
  };
  const bareHost = (url) => url.hostname.replace(/^\[|\]$/g, '');

  server.on('request', async (req, res) => {
    if (requireAuth && !proxyAuthorized(req, expected)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="docteur-egress"', connection: 'close' });
      return res.end();
    }
    let target;
    try {
      checkRootPolicy('proxy', purpose);
      if (!/^http:\/\//i.test(req.url ?? '')) throw new EgressDeniedError(EGRESS_REASONS.INVALID_URL, {});
      target = await client.resolveOutboundTarget(client.validateOutboundUrl(req.url));
    } catch (error) {
      const wrapped = refuse(error);
      res.writeHead(403, { 'x-egress-blocked': wrapped.reason, connection: 'close' });
      return res.end();
    }
    const upstream = http.request({
      host: bareHost(target.url), port: target.url.port ? Number(target.url.port) : 80,
      path: `${target.url.pathname}${target.url.search}`, method: req.method, headers: stripHopByHop(req.headers),
      agent: false, timeout: idleTimeoutMs, lookup: pinnedLookup(target.addresses),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, stripHopByHop(upstreamRes.headers));
      let total = 0;
      upstreamRes.on('data', chunk => { total += chunk.length; if (total > maxResponseBytes) { upstreamRes.destroy(); res.destroy(); } });
      upstreamRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new EgressTimeoutError('idle')));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { connection: 'close' }); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', async (req, clientSocket, head) => {
    // The 407 MUST carry the Basic challenge: Chromium only sends credentials after a challenge (found by the real-internet smoke:
    // without it every HTTPS navigation failed with ERR_PROXY_AUTH_UNSUPPORTED).
    const fail = (status, reasonCode) => {
      const challenge = status.startsWith('407') ? 'Proxy-Authenticate: Basic realm="docteur-egress"\r\n' : '';
      try { clientSocket.end(`HTTP/1.1 ${status}\r\n${challenge}${reasonCode ? `X-Egress-Blocked: ${reasonCode}\r\n` : ''}Connection: close\r\n\r\n`); } catch { clientSocket.destroy(); }
    };
    clientSocket.on('error', () => {});
    if (requireAuth && !proxyAuthorized(req, expected)) return fail('407 Proxy Authentication Required');
    let target;
    try { checkRootPolicy('proxy', purpose); target = await client.resolveOutboundTarget(client.validateOutboundUrl(`https://${req.url}/`)); } catch (error) { return fail('403 Forbidden', refuse(error).reason); }
    const upstream = net.connect({ host: bareHost(target.url), port: target.url.port ? Number(target.url.port) : 443, lookup: pinnedLookup(target.addresses) });
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
    upstream.on('error', () => { if (!clientSocket.destroyed) fail('502 Bad Gateway'); });
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      clientSocket.on('close', () => upstream.destroy());
      upstream.on('close', () => clientSocket.destroy());
    });
  });

  server.on('upgrade', (_req, socket) => {
    try { socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'); } catch { socket.destroy(); }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`, username, password, port,
    /** Playwright launch options forcing EVERY request through this proxy (loopback names included) and stopping WebRTC UDP from bypassing it. */
    launchOptions: () => ({
      proxy: { server: `http://127.0.0.1:${port}`, username, password, bypass: '<-loopback>' },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    }),
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

let sharedProxy = null;
/** One proxy per process, shared by every headless-browser launch (deep-capture, PDF export). */
export function getSharedBrowserEgressProxy() {
  sharedProxy ??= startBrowserEgressProxy({ purpose: 'browser' }).catch((error) => { sharedProxy = null; throw error; });
  return sharedProxy;
}
export async function closeSharedBrowserEgressProxy() {
  const pending = sharedProxy; sharedProxy = null;
  if (pending) await (await pending.catch(() => null))?.close();
}

/**
 * Early request filter for a Playwright BrowserContext: refuses forbidden schemes / ports / literal addresses / local names
 * up front (and, with `resolve: true`, hostnames resolving to non-public addresses) and logs them. NOT a network boundary
 * (see above) — always combine with `startBrowserEgressProxy`. data:/blob:/about: are local and pass.
 */
export async function installBrowserEgressGuard(context, { client = defaultClient, cacheMs = 30_000, onBlocked, resolve = true } = {}) {
  const cache = new Map();
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    let parsed;
    try { parsed = new URL(requestUrl); } catch { return route.abort('blockedbyclient'); }
    if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return route.continue();
    try {
      if (resolve) {
        const key = `${parsed.protocol}//${parsed.host}`;
        const hit = cache.get(key);
        if (!(hit && hit > Date.now())) {
          await client.assertPublicDestination(requestUrl, { purpose: 'browser' });
          cache.set(key, Date.now() + cacheMs);
        }
      } else {
        client.validateOutboundUrl(requestUrl);
      }
      return route.continue();
    } catch (error) {
      if (!resolve && error?.egressBlocked) logBlocked(error, 'browser');
      try { onBlocked?.(error); } catch { /* ignore */ }
      return route.abort('blockedbyclient');
    }
  });
}
