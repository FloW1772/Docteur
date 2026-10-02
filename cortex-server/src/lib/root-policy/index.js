/**
 * ROOT POLICY V1 — runtime: boot, integrity watch, decisions, audit, actor context, HTTP gate, hooks.
 *
 * Public surface for the rest of Docteur (semantic API — callers never pass commands, only actions + typed context):
 *   initRootPolicy(opts)            boot: load → verify format/version/integrity/signature → READY | INVALID (never throws)
 *   decide(request)                 deterministic decision (ALLOW / DENY / REQUIRE_APPROVAL / NOT_APPLICABLE + stable code)
 *   enforce(request)                decide + audit + throw RootPolicyDeniedError unless ALLOW / NOT_APPLICABLE
 *   getRootPolicyStatus()           read-only status for the UI / health
 *   getPolicyView()                 read-only view of the active policy
 *   runWithActor(ctx, fn)           attributes the current async work (HTTP request / scheduled job / AI turn) to an actor
 *   createRootPolicyMiddleware()    Hono middleware: semantic gate for the certified, frozen device routes (no change to those modules)
 *
 * There is NO function in this module (or anywhere in the server) that writes, replaces or reloads the policy from a request: the policy
 * changes only through the offline human tool; the server merely notices a changed, VALID, higher-version file.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudit } from './audit.js';
import { DECISION, containsSecretShape, createApprovalRegistry, createEngine } from './engine.js';
import { filesChanged, loadAndVerify, readRollbackState, writeRollbackState } from './loader.js';
import { classifyRoute } from './route-map.js';
import { TRUST_ANCHORS } from './trust-anchors.js';

export { DECISION, containsSecretShape };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POLICY_DIR = path.resolve(HERE, '../../../policy');

const als = new AsyncLocalStorage();
export function runWithActor(ctx, fn) { return als.run({ ...ctx }, fn); }
export function currentActorContext() { return als.getStore() ?? null; }

const runtime = {
  status: 'UNINITIALIZED', policy: null, version: 0, sha256: null, keyId: null, files: null, errorCode: null, tamper: false, detail: null,
  policyDir: DEFAULT_POLICY_DIR, dataDir: null, trustAnchors: TRUST_ANCHORS, loadedAt: null, lastCheckAt: 0, highestVersionSeen: 0,
};
let audit = createAudit({});
const approvals = createApprovalRegistry();
const engine = createEngine({ getPolicy: () => ({ valid: runtime.status === 'VALID', policy: runtime.policy, version: runtime.version }), approvals });
const STAT_INTERVAL_MS = 1000;
const INVALID_RECHECK_MS = 2000;

export class RootPolicyDeniedError extends Error {
  constructor(decision) {
    super(`Action refusée par la Root Policy (${decision.code})`);
    this.name = 'RootPolicyDeniedError';
    this.code = 'ROOT_POLICY_DENIED';
    this.decision = decision.decision;
    this.decisionCode = decision.code;
    this.policyVersion = decision.policyVersion;
    this.action = decision.action;
    this.rootPolicyDenied = true;
  }
}

function load(reason) {
  const result = loadAndVerify({ policyDir: runtime.policyDir, trustAnchors: runtime.trustAnchors, highestVersionSeen: runtime.highestVersionSeen });
  runtime.lastCheckAt = Date.now();
  if (result.ok) {
    const wasValid = runtime.status === 'VALID' && runtime.sha256 === result.sha256;
    Object.assign(runtime, { status: 'VALID', policy: result.policy, version: result.version, sha256: result.sha256, keyId: result.keyId, files: result.files, errorCode: null, tamper: false, detail: null, loadedAt: Date.now() });
    if (result.version > runtime.highestVersionSeen) {
      runtime.highestVersionSeen = result.version;
      if (runtime.dataDir) writeRollbackState(runtime.dataDir, { highestVersionSeen: result.version, lastSha256: result.sha256 });
    }
    if (!wasValid) audit.record('POLICY_LOADED', { code: 'POLICY_LOADED', policyVersion: result.version, detail: reason });
    return true;
  }
  const changedKind = runtime.status !== 'INVALID' || runtime.errorCode !== result.code;
  Object.assign(runtime, { status: 'INVALID', policy: null, version: 0, sha256: null, keyId: null, files: null, errorCode: result.code, tamper: result.tamper, detail: result.detail ?? null });
  if (changedKind) audit.record(result.tamper ? 'POLICY_TAMPER_DETECTED' : 'POLICY_INVALID', { code: result.code, detail: reason });
  return false;
}

/** Boot. Never throws: an invalid policy leaves Docteur running (it can show the error) with protected operations failing closed. */
export function initRootPolicy({ policyDir, dataDir, trustAnchors, logger, now } = {}) {
  runtime.policyDir = policyDir ?? DEFAULT_POLICY_DIR;
  runtime.dataDir = dataDir ?? null;
  runtime.trustAnchors = trustAnchors ?? TRUST_ANCHORS;
  runtime.highestVersionSeen = dataDir ? readRollbackState(dataDir).highestVersionSeen : 0;
  audit = createAudit({ dir: dataDir ?? undefined, logger, now });
  load('boot');
  return getRootPolicyStatus();
}

/** Hot-path integrity check: two `stat` calls at most once per second; a changed file is fully re-verified. */
function ensureFresh() {
  const t = Date.now();
  if (runtime.status === 'VALID') {
    if (t - runtime.lastCheckAt < STAT_INTERVAL_MS) return;
    runtime.lastCheckAt = t;
    if (filesChanged(runtime.policyDir, runtime.files)) load('files-changed');
  } else if (runtime.status === 'INVALID' && t - runtime.lastCheckAt >= INVALID_RECHECK_MS) {
    load('recheck');
  }
}

export function getRootPolicyStatus() {
  const valid = runtime.status === 'VALID';
  return {
    state: runtime.status === 'UNINITIALIZED' ? 'UNINITIALIZED' : valid ? 'VALID' : 'INVALID',
    version: runtime.version,
    integrity: valid ? 'VERIFIED' : runtime.status === 'UNINITIALIZED' ? 'UNKNOWN' : 'FAILED',
    source: 'LOCAL',
    aiModification: 'FORBIDDEN',
    protectedOperations: valid ? 'ENABLED' : 'FAIL_CLOSED',
    errorCode: runtime.errorCode,
    tamperDetected: runtime.tamper,
    sha256: runtime.sha256 ? runtime.sha256.slice(0, 16) : null,
    keyId: runtime.keyId ? runtime.keyId.slice(0, 16) : null,
    loadedAt: runtime.loadedAt ? new Date(runtime.loadedAt).toISOString() : null,
  };
}

export function getPolicyView() {
  return { status: getRootPolicyStatus(), policy: runtime.status === 'VALID' ? runtime.policy : null, readOnly: true };
}

export function decide(request) {
  const input = request && typeof request === 'object' ? request : {};
  // A process that never ran the server boot (scripts, tests) gets the SAME verification lazily — there is no "uninitialised ⇒ allowed" state.
  if (runtime.status === 'UNINITIALIZED') load('lazy');
  ensureFresh();
  const ctx = currentActorContext();
  const resolved = {
    ...input,
    actor: input.actor ?? { kind: ctx?.kind ?? 'MODULE' },
    userInitiated: input.userInitiated ?? ctx?.userInitiated ?? false,
  };
  return engine.decide(resolved);
}

export function enforce(request) {
  const decision = decide(request);
  if (decision.decision === DECISION.ALLOW || decision.decision === DECISION.NOT_APPLICABLE) return decision;
  audit.record(decision.decision === DECISION.REQUIRE_APPROVAL ? 'ACTION_REQUIRES_APPROVAL' : 'ACTION_DENIED', {
    code: decision.code, action: decision.action, module: request?.module, actor: request?.actor?.kind ?? currentActorContext()?.kind ?? 'MODULE', domain: request?.trustDomain, policyVersion: decision.policyVersion,
  });
  throw new RootPolicyDeniedError(decision);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Semantic helpers for the call sites wired in V1 (typed context only — no free text, no command line)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** AI_CLOUD_REQUEST — called by the single cloud choke point (privacy-guard.guardCloudCall) before any provider request. */
export function enforceCloudAi({ provider, messages, strictLocal, cloudEnabled }) {
  let containsSecret = false;
  try { containsSecret = containsSecretShape(JSON.stringify(messages)); } catch { containsSecret = false; }
  return enforce({
    action: 'AI_CLOUD_REQUEST', module: 'ai', trustDomain: 'AI',
    context: { provider: String(provider ?? ''), strictLocal: strictLocal === true, cloudEnabled: cloudEnabled !== false, providerConfigured: true, containsSecret, localEquivalentAvailable: true, userChoseCloud: true },
  });
}

/** MEDIA_INSPECT / MEDIA_DOWNLOAD — called right before a yt-dlp process is started. */
export function enforceMedia({ action, accessMode = 'public', credentialSource = 'none' }) {
  return enforce({
    action, module: 'media', trustDomain: 'MEDIA',
    context: { networkClass: 'public', accessMode, credentialSource, engine: 'egress-proxy' },
  });
}

/** WEB_FETCH — the Web Egress Guard asks "may this action be attempted?" before it asks "is this destination safe?". */
export function webFetchHook({ surface }) {
  const d = decide({ action: 'WEB_FETCH', module: 'web', trustDomain: 'WEB', context: { networkClass: 'public', surface } });
  if (d.decision === DECISION.ALLOW || d.decision === DECISION.NOT_APPLICABLE) return null;
  audit.record('ACTION_DENIED', { code: d.code, action: 'WEB_FETCH', module: 'web', actor: currentActorContext()?.kind ?? 'MODULE', domain: 'WEB', policyVersion: d.policyVersion });
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// HTTP gate for the certified device routes (frozen modules are not modified)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function createRootPolicyMiddleware() {
  return async function rootPolicyGate(c, next) {
    const pathname = new URL(c.req.url).pathname;
    const route = classifyRoute(c.req.method, pathname);
    const actorCtx = route?.peer ? { kind: 'MODULE', userInitiated: false, via: 'peer' } : { kind: 'USER', userInitiated: true, via: 'http' };
    if (route) {
      const d = decide({ action: route.action, module: route.module, trustDomain: route.trustDomain, actor: { kind: actorCtx.kind }, userInitiated: actorCtx.userInitiated, certifiedBoundary: true });
      if (d.decision !== DECISION.ALLOW && d.decision !== DECISION.NOT_APPLICABLE) {
        audit.record(d.decision === DECISION.REQUIRE_APPROVAL ? 'ACTION_REQUIRES_APPROVAL' : 'ACTION_DENIED', { code: d.code, action: route.action, module: route.module, actor: actorCtx.kind, domain: route.trustDomain, policyVersion: d.policyVersion });
        return c.json({ error: 'ROOT_POLICY_DENIED', code: d.code, policyVersion: d.policyVersion }, d.code === 'DENY_POLICY_INVALID' ? 503 : 403);
      }
    }
    return als.run(actorCtx, () => next());
  };
}

/** Test seam only (static audit: never imported by production code). */
export const __testing = Object.freeze({ approvals, runtime, reload: () => load('test'), setAudit: (a) => { audit = a; }, engine });
