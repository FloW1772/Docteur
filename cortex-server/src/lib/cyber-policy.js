/**
 * Docteur-owned security policy for the Cyber Audit Agent (SENTINEL V1:
 * authorized, external, non-destructive web audit — TLS/headers/cookies/
 * CORS observation only, GET/HEAD/OPTIONS only, no exploitation).
 *
 * This module is the single deny-by-default gate every Cyber Audit code
 * path must go through before ever touching the network:
 *   - a mission cannot start without explicit authorization confirmation
 *     (authorizationConfirmed === true), mirroring MetaGPT's
 *     approve-before-apply idiom but for network destinations instead of
 *     code diffs.
 *   - a scope defines exactly which hosts/ports/protocols/paths a mission
 *     may touch; wildcards are rejected, subdomains are denied unless
 *     explicitly listed.
 *   - every outbound request is validated against the resolved IP (not
 *     just the hostname string) on the initial request AND on every
 *     redirect hop, following the SSRF-safe pattern already proven in
 *     sherlock-policy.js's publicAddress/resolvePublic/publicRequest —
 *     NOT the weaker assertSafeUrl (url-security.js), which only checks
 *     the literal hostname string and never re-validates redirects.
 *   - only GET/HEAD/OPTIONS are ever permitted; every other method is
 *     explicitly named and rejected (not merely "not in the allowlist"),
 *     the same explicit-forbidden-list idiom as investment-policy.js.
 */

import net from 'node:net';
import dns from 'node:dns/promises';

export class CyberAuditPolicyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function denied(code) {
  return new CyberAuditPolicyError(code);
}

// ---------------------------------------------------------------------
// Server-side limits — the frontend can never request values beyond these.
// ---------------------------------------------------------------------

export const LIMITS = Object.freeze({
  maxRequests: 200,
  maxConcurrentRequests: 4,
  requestsPerSecond: 2,
  maxResponseBytes: 512 * 1024,
  requestTimeoutMs: 10_000,
  missionTimeoutMs: 15 * 60_000,
  redirects: 3,
  maxScopeHosts: 10,
  maxExclusions: 50,
  maxDepth: 3,
  maxPathLength: 200,
});

// ---------------------------------------------------------------------
// HTTP method allowlist — non-destructive, read-only observation only.
// ---------------------------------------------------------------------

export const ALLOWED_METHODS = Object.freeze(new Set(['GET', 'HEAD', 'OPTIONS']));

// Named explicitly, not merely "anything not in ALLOWED_METHODS" — so a
// review or test can see exactly which state-changing verbs this policy
// was built to refuse, mirroring investment-policy.js's
// EXPLICITLY_FORBIDDEN_ACTIONS idiom.
const EXPLICITLY_FORBIDDEN_METHODS = Object.freeze(new Set([
  'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE',
]));

export function authorizeMethod(method) {
  if (typeof method !== 'string') throw denied('method_invalid');
  const upper = method.trim().toUpperCase();
  if (EXPLICITLY_FORBIDDEN_METHODS.has(upper)) throw denied('exploitation_method_denied');
  if (!ALLOWED_METHODS.has(upper)) throw denied('method_denied');
  return upper;
}

// ---------------------------------------------------------------------
// Private/reserved network detection — same allowlist-of-public-ranges
// shape as sherlock-policy.js's publicAddress (CGNAT, benchmarking,
// documentation ranges included, not just RFC1918 + loopback).
// ---------------------------------------------------------------------

export function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local + 169.254.169.254 cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (net.isIP(address) === 6) {
    const h = address.toLowerCase();
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return false;
    // Permit only ordinary global unicast; reject IPv4-mapped, 6to4,
    // NAT64, and documentation space, not merely the loopback address.
    return /^[23][0-9a-f]{3}:/.test(h) && !h.startsWith('2001:') && !h.startsWith('2002:') && !h.startsWith('3fff:');
  }
  return false;
}

const DENIED_SCHEMES = Object.freeze(new Set(['file:', 'ftp:', 'gopher:', 'data:', 'javascript:', 'vbscript:', 'blob:']));

/**
 * Validates a raw URL string against the mission's declared scope, purely
 * syntactically (protocol/hostname/port/path shape) — does NOT resolve
 * DNS. Call `resolveInScope` for the DNS+IP check before ever connecting.
 */
export function validateUrlSyntax(raw) {
  let url;
  try { url = new URL(raw); } catch { throw denied('url_invalid'); }
  const scheme = url.protocol;
  if (DENIED_SCHEMES.has(scheme)) throw denied('scheme_denied');
  if (!['http:', 'https:'].includes(scheme)) throw denied('scheme_denied');
  if (url.username || url.password) throw denied('url_credentials_denied');
  return url;
}

/**
 * Scope shape:
 *   allowedHosts: string[] (exact hostnames, no wildcards)
 *   allowedPorts: number[] (defaults to [80, 443] if omitted)
 *   allowedProtocols: string[] (subset of ['http:', 'https:'])
 *   allowedPaths: string[] | undefined (path prefixes; undefined = all paths allowed)
 *   excludedPaths: string[] (path prefixes always denied, even if allowedPaths would match)
 *   followSubdomains: boolean (default false — subdomains DENIED by default)
 *   maxDepth: number
 *   maxRequests: number
 *   requestsPerSecond: number
 *   timeoutMs: number
 */
export function validateScope(scope) {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) throw denied('scope_invalid');

  const allowedHosts = scope.allowedHosts;
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.length > LIMITS.maxScopeHosts) {
    throw denied('scope_hosts_invalid');
  }
  // No wildcard host permitted, ever — "*" or a leading "*." entry is
  // rejected outright rather than silently interpreted as "all hosts."
  const hosts = allowedHosts.map(h => {
    if (typeof h !== 'string' || !h.trim()) throw denied('scope_hosts_invalid');
    const trimmed = h.trim().toLowerCase();
    if (trimmed === '*' || trimmed.includes('*')) throw denied('scope_wildcard_denied');
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(trimmed) && !net.isIP(trimmed)) {
      throw denied('scope_hosts_invalid');
    }
    return trimmed;
  });
  if (new Set(hosts).size !== hosts.length) throw denied('scope_hosts_duplicate');

  const allowedPorts = scope.allowedPorts === undefined ? [80, 443] : scope.allowedPorts;
  if (!Array.isArray(allowedPorts) || allowedPorts.length === 0 ||
    allowedPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw denied('scope_ports_invalid');
  }

  const allowedProtocols = scope.allowedProtocols === undefined ? ['https:', 'http:'] : scope.allowedProtocols;
  if (!Array.isArray(allowedProtocols) || allowedProtocols.length === 0 ||
    allowedProtocols.some(p => !['http:', 'https:'].includes(p))) {
    throw denied('scope_protocols_invalid');
  }

  const allowedPaths = scope.allowedPaths === undefined ? null : scope.allowedPaths;
  if (allowedPaths !== null && (!Array.isArray(allowedPaths) || allowedPaths.some(p => typeof p !== 'string'))) {
    throw denied('scope_paths_invalid');
  }

  const excludedPaths = scope.excludedPaths === undefined ? [] : scope.excludedPaths;
  if (!Array.isArray(excludedPaths) || excludedPaths.length > LIMITS.maxExclusions ||
    excludedPaths.some(p => typeof p !== 'string')) {
    throw denied('scope_exclusions_invalid');
  }

  // Subdomains DENIED by default — must be explicitly opted into.
  const followSubdomains = scope.followSubdomains === true;

  const maxDepth = scope.maxDepth === undefined ? 1 : scope.maxDepth;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > LIMITS.maxDepth) throw denied('scope_depth_invalid');

  const maxRequests = scope.maxRequests === undefined ? 50 : scope.maxRequests;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > LIMITS.maxRequests) throw denied('scope_max_requests_invalid');

  const requestsPerSecond = scope.requestsPerSecond === undefined ? 1 : scope.requestsPerSecond;
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || requestsPerSecond > LIMITS.requestsPerSecond) {
    throw denied('scope_rate_invalid');
  }

  const timeoutMs = scope.timeoutMs === undefined ? LIMITS.requestTimeoutMs : scope.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > LIMITS.requestTimeoutMs) throw denied('scope_timeout_invalid');

  return Object.freeze({
    allowedHosts: hosts,
    allowedPorts: [...allowedPorts],
    allowedProtocols: [...allowedProtocols],
    allowedPaths: allowedPaths ? [...allowedPaths] : null,
    excludedPaths: [...excludedPaths],
    followSubdomains,
    maxDepth,
    maxRequests,
    requestsPerSecond,
    timeoutMs,
  });
}

/**
 * Returns true if `hostname` is within the scope's allowed host set,
 * honoring followSubdomains (default false — exact match only).
 */
function hostInScope(hostname, scope) {
  const host = hostname.toLowerCase();
  if (scope.allowedHosts.includes(host)) return true;
  if (!scope.followSubdomains) return false;
  return scope.allowedHosts.some(allowed => host.endsWith(`.${allowed}`));
}

function pathInScope(pathname, scope) {
  if (scope.excludedPaths.some(prefix => pathname.startsWith(prefix))) return false;
  if (scope.allowedPaths === null) return true;
  return scope.allowedPaths.some(prefix => pathname.startsWith(prefix));
}

/**
 * Syntactic (no DNS) scope check — protocol/host/port/path all validated
 * against the mission's frozen scope. Called before every request AND
 * again on every redirect hop's Location target.
 */
export function authorizeCyberRequest({ url, method, scope }) {
  authorizeMethod(method);
  const parsed = validateUrlSyntax(url);
  if (!scope.allowedProtocols.includes(parsed.protocol)) throw denied('target_protocol_denied');
  if (!hostInScope(parsed.hostname, scope)) throw denied('target_out_of_scope');
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (!scope.allowedPorts.includes(port)) throw denied('target_port_denied');
  if (!pathInScope(parsed.pathname, scope)) throw denied('target_path_denied');
  return parsed;
}

/**
 * DNS-resolving, redirect-safe scope+SSRF check. Resolves every address a
 * hostname maps to (not just the first) and rejects if ANY resolved
 * address is private/reserved — the same defense against DNS rebinding as
 * sherlock-policy.js's resolvePublic, but additionally gated by the
 * mission's scope (not merely "is this any public address").
 *
 * `allowPrivateFixture` exists ONLY for the local adversarial test fixture
 * (CA's own test-target server) and must never be reachable from a real
 * mission — see cyber-audit-fixture usage in tests.
 */
export async function resolveInScope({ url, method, scope, lookup = dns.lookup, allowPrivateFixture = false }) {
  const parsed = authorizeCyberRequest({ url, method, scope });
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw denied('dns_resolution_failed');
  if (!allowPrivateFixture && addresses.some(a => !isPublicAddress(a.address))) {
    throw denied('target_resolves_private');
  }
  return { url: parsed, addresses };
}

// ---------------------------------------------------------------------
// Mission model — a mission cannot start without explicit authorization.
// ---------------------------------------------------------------------

export const MISSION_STATES = Object.freeze({
  DRAFT: 'DRAFT',
  SCOPED: 'SCOPED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const TERMINAL_MISSION_STATES = new Set([
  MISSION_STATES.COMPLETED, MISSION_STATES.FAILED, MISSION_STATES.CANCELLED,
]);

const MISSION_FORWARD_EDGES = {
  [MISSION_STATES.DRAFT]: [MISSION_STATES.SCOPED],
  [MISSION_STATES.SCOPED]: [MISSION_STATES.RUNNING],
  [MISSION_STATES.RUNNING]: [MISSION_STATES.COMPLETED],
};

const MISSION_ERROR_ESCAPES = new Set([MISSION_STATES.FAILED, MISSION_STATES.CANCELLED]);

export function isValidMissionTransition(fromState, toState) {
  if (!Object.values(MISSION_STATES).includes(fromState)) return false;
  if (!Object.values(MISSION_STATES).includes(toState)) return false;
  if (TERMINAL_MISSION_STATES.has(fromState)) return false;
  if (MISSION_ERROR_ESCAPES.has(toState)) return true;
  return (MISSION_FORWARD_EDGES[fromState] || []).includes(toState);
}

const MAX_TITLE_LENGTH = 200;
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_AUTH_REFERENCE_LENGTH = 500;

/**
 * Validates the mission-creation payload. `authorizationConfirmed` must be
 * the literal boolean `true` — no truthy string, no "yes", no omission.
 * This is the load-bearing control equivalent to MetaGPT's approval-hash
 * binding: nothing downstream may run before this passes.
 */
export function validateMissionInput(body) {
  if (typeof body !== 'object' || body === null) throw denied('mission_input_invalid');
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > MAX_TITLE_LENGTH) {
    throw denied('mission_title_invalid');
  }
  if (typeof body.clientName !== 'string' || !body.clientName.trim() || body.clientName.length > MAX_CLIENT_NAME_LENGTH) {
    throw denied('mission_client_name_invalid');
  }
  if (body.authorizationConfirmed !== true) throw denied('authorization_not_confirmed');
  if (typeof body.authorizationReference !== 'string' || !body.authorizationReference.trim() ||
    body.authorizationReference.length > MAX_AUTH_REFERENCE_LENGTH) {
    throw denied('authorization_reference_required');
  }
  const scope = validateScope(body.scope);
  const mode = body.mode === undefined ? 'PASSIVE_AUDIT' : body.mode;
  if (mode !== 'PASSIVE_AUDIT') throw denied('mission_mode_denied'); // only mode in V1
  return {
    title: body.title.trim(),
    clientName: body.clientName.trim(),
    authorizationConfirmed: true,
    authorizationReference: body.authorizationReference.trim(),
    scope,
    mode,
  };
}
