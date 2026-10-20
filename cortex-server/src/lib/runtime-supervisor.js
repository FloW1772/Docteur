// Runtime Supervisor V1 — closed service registry, explicit state machine, ownership-proven restart.
//
// What this module guarantees:
//   • CLOSED REGISTRY: services are code-defined, validated and deep-frozen at construction. A request names a serviceId
//     only; no executable, argument, working directory, shell or PID ever comes from a request, a model or a document.
//   • NO GENERIC LAUNCHER: this module imports no process or network primitive. Launching a registered SPAWN service uses an
//     INJECTED spawn function (the product wiring injects none in V1), always `shell: false` with the registered argv.
//     Killing uses an INJECTED tree-killer that only ever receives the ChildProcess handle this supervisor spawned itself.
//   • OWNERSHIP: only DOCTEUR_OWNED + SPAWN services are restartable. Stop/kill act on our own handle and never after its
//     'exit' event (while the handle is open the OS cannot reuse the PID). An occupied port is reported, never "freed".
//   • HEALTH, NOT PID: HEALTHY comes from the registered local health check; a per-launch instance token echoed by the
//     service proves the listener is ours (port hijack → DEGRADED / IDENTITY_MISMATCH).
//   • ROOT POLICY: every restart is decided by Root Policy action SERVICE_RESTART (module runtime-supervisor) before any
//     effect. Under the sealed V1 policy that action requires a local approval no product path can issue: the product
//     restart therefore fails closed (ROOT_POLICY_APPROVAL_REQUIRED) until a policy boundary is designed and signed.
//   • BOUNDED FAILURE: manual restart only (auto-restart OFF), exponential backoff after crashes, BLOCKED after a crash
//     loop (manual reset required), one operation per service at a time.
//   • AUDIT: every transition is recorded (ids, codes, counts) — never an environment, command line, token or output.
//   • DELEGATED (RS-KIWIX-RESTART): a service whose process OWNER is another module (Kiwix). The supervisor holds no handle,
//     executable, argument, cwd or PID for it: only a closed delegate { status(), restartOwnedInstance(authorization) }. Its
//     state is a PROJECTION of the owner's lifecycle (the owner stays the single source of truth; no second state machine).
//     A restart goes only through the local ceremony: createRestartChallenge → confirmRestart, both decided by the injected
//     restart authority (challenge consumed ⇒ Root Policy ⇒ opaque single-use authorization redeemed by the owner).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decide as rootPolicyDecide } from './root-policy/index.js';
import { probeLoopback } from './runtime-supervisor-probe.js';

export const RUNTIME_STATES = Object.freeze(['STOPPED', 'STARTING', 'HEALTHY', 'DEGRADED', 'CRASHED', 'STOPPING', 'RESTARTING', 'BACKOFF', 'BLOCKED']);
export const OWNERSHIP_CLASSES = Object.freeze(['DOCTEUR_OWNED', 'DOCTEUR_MANAGED_OPTIONAL', 'EXTERNAL_OBSERVED', 'UNKNOWN']);
export const SERVICE_KINDS = Object.freeze(['SELF', 'OBSERVED', 'SPAWN', 'DELEGATED']);
/** What a delegated restart interrupts / leaves alone — closed codes, rendered as fixed text by the UI. */
export const RESTART_EFFECTS = Object.freeze(['IN_FLIGHT_REQUESTS_INTERRUPTED', 'LOCAL_ARCHIVES_UNCHANGED']);
const DELEGATE_KEYS = 'restartOwnedInstance,status';
const DELEGATED_STATES = Object.freeze(['STOPPED', 'STARTING', 'HEALTHY', 'DEGRADED', 'STOPPING', 'CRASHED']);
export const HEALTH_STATUSES = Object.freeze(['HEALTHY', 'DEGRADED', 'UNREACHABLE', 'NOT_PROBED']);

/** The only legal lifecycle transitions of a supervised (SPAWN) service. Anything else is a bug and throws. */
export const TRANSITIONS = Object.freeze({
  STOPPED: Object.freeze(['RESTARTING']),
  RESTARTING: Object.freeze(['STARTING', 'CRASHED', 'BLOCKED']),
  STARTING: Object.freeze(['HEALTHY', 'DEGRADED', 'CRASHED', 'BLOCKED', 'STOPPING']),
  HEALTHY: Object.freeze(['DEGRADED', 'CRASHED', 'STOPPING', 'RESTARTING']),
  DEGRADED: Object.freeze(['HEALTHY', 'CRASHED', 'STOPPING', 'RESTARTING']),
  CRASHED: Object.freeze(['RESTARTING', 'BACKOFF', 'BLOCKED']),
  BACKOFF: Object.freeze(['RESTARTING', 'BLOCKED']),
  BLOCKED: Object.freeze(['RESTARTING']),
  STOPPING: Object.freeze(['STOPPED', 'CRASHED', 'BLOCKED']),
});
export const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));

export const SUPERVISOR_LIMITS = Object.freeze({
  startTimeoutMs: { min: 500, max: 60_000, default: 15_000 },
  gracefulStopTimeoutMs: { min: 100, max: 30_000, default: 5_000 },
  killWaitMs: 5_000,
  portReleaseTimeoutMs: 5_000,
  healthPollMs: 200,
  observeCacheMs: 2_000,
  crashWindowMs: 10 * 60_000,
  maxCrashesInWindow: 3,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  auditRing: 500,
  auditFileMaxBytes: 1024 * 1024,
});

export const SERVICE_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const SHELL_LIKE = /(^|[\\/])(cmd|powershell|pwsh|bash|sh|wsl|wscript|cscript|mshta|rundll32|regsvr32|taskkill|sc|reg|schtasks)(\.exe)?$/i;
const INSTANCE_HEADER = 'x-docteur-rs-instance';
const HEALTH_PATH_RE = /^\/[A-Za-z0-9._~\-/]{0,120}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const BASE_ENV_KEYS = Object.freeze(['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT']);

export class RuntimeSupervisorError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'RuntimeSupervisorError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new RuntimeSupervisorError(code, message, details); };
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); return Object.freeze(o); };
const bounded = (v, { min, max, default: d }) => (v === undefined ? d : Number.isSafeInteger(v) && v >= min && v <= max ? v : fail('RS_DEFINITION_INVALID', 'timeout out of bounds'));

/** Validates one code-defined service definition and returns a frozen copy. Throws RS_DEFINITION_INVALID. */
export function validateServiceDefinition(def) {
  const bad = (reason) => fail('RS_DEFINITION_INVALID', `invalid service definition: ${reason}`, { reason });
  if (!def || typeof def !== 'object') bad('NOT_AN_OBJECT');
  if (typeof def.serviceId !== 'string' || !SERVICE_ID_RE.test(def.serviceId)) bad('SERVICE_ID');
  if (typeof def.displayName !== 'string' || !def.displayName.trim() || def.displayName.length > 80) bad('DISPLAY_NAME');
  if (!OWNERSHIP_CLASSES.includes(def.ownershipClass)) bad('OWNERSHIP_CLASS');
  if (!SERVICE_KINDS.includes(def.kind)) bad('KIND');
  const deps = def.dependencies ?? [];
  if (!Array.isArray(deps) || deps.some(d => typeof d !== 'string' || !SERVICE_ID_RE.test(d))) bad('DEPENDENCIES');
  const out = { serviceId: def.serviceId, displayName: def.displayName, ownershipClass: def.ownershipClass, kind: def.kind, optional: def.optional === true, dependencies: [...deps], note: typeof def.note === 'string' ? def.note.slice(0, 200) : null };
  if (def.kind === 'SELF' || def.kind === 'OBSERVED') {
    if (typeof def.observe !== 'function') bad('OBSERVE');
    return deepFreeze({ ...out, observe: def.observe, restartable: false });
  }
  if (def.kind === 'DELEGATED') {
    // the owner module keeps the process: no launch definition may be attached, only the closed two-method delegate
    if (def.ownershipClass !== 'DOCTEUR_MANAGED_OPTIONAL') bad('DELEGATED_REQUIRES_MANAGED_OPTIONAL');
    if (def.launch !== undefined || def.healthCheck !== undefined || def.gracefulStop !== undefined) bad('DELEGATED_HAS_NO_LAUNCH');
    const dg = def.delegate;
    if (!dg || typeof dg !== 'object' || Object.keys(dg).sort().join(',') !== DELEGATE_KEYS || typeof dg.status !== 'function' || typeof dg.restartOwnedInstance !== 'function') bad('DELEGATE');
    const effects = def.restartEffects ?? [];
    if (!Array.isArray(effects) || effects.some(e => !RESTART_EFFECTS.includes(e))) bad('RESTART_EFFECTS');
    if ((def.restartPolicy ?? 'MANUAL') !== 'MANUAL') bad('RESTART_POLICY');
    return deepFreeze({ ...out, delegate: Object.freeze({ status: dg.status, restartOwnedInstance: dg.restartOwnedInstance }), restartEffects: [...new Set(effects)], restartPolicy: 'MANUAL', restartable: true });
  }
  // SPAWN: a Docteur-owned process this supervisor launches itself from a fixed, audited definition
  if (def.ownershipClass !== 'DOCTEUR_OWNED') bad('SPAWN_REQUIRES_DOCTEUR_OWNED');
  const l = def.launch;
  if (!l || typeof l.executable !== 'string' || !path.isAbsolute(l.executable) || SHELL_LIKE.test(l.executable)) bad('EXECUTABLE');
  if (!Array.isArray(l.args) || l.args.length > 32 || l.args.some(a => typeof a !== 'string' || a.length > 1024 || a.includes('\0'))) bad('ARGS');
  if (typeof l.cwd !== 'string' || !path.isAbsolute(l.cwd)) bad('CWD');
  const env = l.env ?? {};
  if (typeof env !== 'object' || Object.entries(env).some(([k, v]) => !ENV_KEY_RE.test(k) || typeof v !== 'string' || v.length > 256)) bad('ENV');
  const h = def.healthCheck;
  if (!h || h.host !== '127.0.0.1' || !Number.isInteger(h.port) || h.port < 1 || h.port > 65_535 || !HEALTH_PATH_RE.test(h.path ?? '/')) bad('HEALTH_CHECK');
  const g = def.gracefulStop ?? { kind: 'NONE' };
  if (!(g.kind === 'NONE' || (g.kind === 'HTTP_POST' && HEALTH_PATH_RE.test(g.path ?? '')))) bad('GRACEFUL_STOP');
  if ((def.restartPolicy ?? 'MANUAL') !== 'MANUAL') bad('RESTART_POLICY'); // V1: automatic restart is OFF
  return deepFreeze({
    ...out,
    launch: { executable: l.executable, args: [...l.args], cwd: l.cwd, env: { ...env } },
    healthCheck: { host: '127.0.0.1', port: h.port, path: h.path ?? '/', timeoutMs: Math.min(5_000, Math.max(100, h.timeoutMs ?? 1_000)), identity: h.identity === true },
    gracefulStop: g.kind === 'HTTP_POST' ? { kind: 'HTTP_POST', path: g.path } : { kind: 'NONE' },
    gracefulStopTimeoutMs: bounded(def.gracefulStopTimeoutMs, SUPERVISOR_LIMITS.gracefulStopTimeoutMs),
    startTimeoutMs: bounded(def.startTimeoutMs, SUPERVISOR_LIMITS.startTimeoutMs),
    restartPolicy: 'MANUAL',
    restartable: true,
  });
}

/** Local structured audit: in-memory ring + optional JSONL file (dedicated, rotated). Only ids / codes / numbers. */
export function createRuntimeAuditLog({ file = null, ring = SUPERVISOR_LIMITS.auditRing, now = Date.now } = {}) {
  const entries = [];
  const FIELDS = ['serviceId', 'from', 'to', 'reason', 'pid', 'exitCode', 'health', 'actor', 'event'];
  return Object.freeze({
    record(e) {
      const row = { at: new Date(now()).toISOString() };
      for (const k of FIELDS) {
        const v = e?.[k];
        if (v === undefined || v === null) continue;
        row[k] = typeof v === 'number' ? v : String(v).slice(0, 80);
      }
      entries.push(row); while (entries.length > ring) entries.shift();
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (fs.existsSync(file) && fs.statSync(file).size > SUPERVISOR_LIMITS.auditFileMaxBytes) fs.renameSync(file, `${file}.1`);
          fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
        } catch { /* audit file is best effort; the in-memory ring keeps the event */ }
      }
      return row;
    },
    recent(serviceId = null, limit = 20) { return entries.filter(r => !serviceId || r.serviceId === serviceId).slice(-limit).map(r => ({ ...r })); },
  });
}

/**
 * @param {object} deps
 *   services      array of code-defined service definitions (closed registry)
 *   spawnImpl     (executable, args, options) => ChildProcess — injected; null ⇒ no service can be launched
 *   killTree      (childProcess) => Promise — injected; receives ONLY a handle this supervisor spawned
 *   probe         bounded local probe (default: loopback-only probeLoopback)
 *   policyDecide  Root Policy decide (default: the real one) — injected by tests only
 *   audit         createRuntimeAuditLog(...)
 *   restartAuthority  createRestartAuthority(...) — the ONLY way a DELEGATED service is restarted (null ⇒ never)
 */
export function createRuntimeSupervisor({ services, spawnImpl = null, killTree = null, probe = probeLoopback, policyDecide = rootPolicyDecide, audit = createRuntimeAuditLog(), now = Date.now, limits = {}, restartAuthority = null } = {}) {
  if (!Array.isArray(services) || services.length === 0 || services.length > 32) fail('RS_DEFINITION_INVALID', 'a closed, non-empty service registry is required');
  const L = { ...SUPERVISOR_LIMITS, ...limits };
  const registry = new Map();
  for (const raw of services) {
    const def = validateServiceDefinition(raw);
    if (registry.has(def.serviceId)) fail('RS_DEFINITION_INVALID', 'duplicate serviceId', { reason: 'DUPLICATE' });
    registry.set(def.serviceId, def);
  }
  for (const def of registry.values()) for (const d of def.dependencies) if (!registry.has(d)) fail('RS_DEFINITION_INVALID', 'unknown dependency', { reason: 'DEPENDENCY' });
  const records = new Map([...registry.values()].map(def => [def.serviceId, {
    state: 'STOPPED', instance: null, op: null, crashTimes: [], restartCount: 0, lastExitCode: null, lastError: null,
    lastRestartAt: null, retryAt: null, health: { status: 'NOT_PROBED', code: 'NOT_STARTED' }, observed: null, observedAt: 0,
  }]));

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const resolveDef = (serviceId) => {
    if (typeof serviceId !== 'string' || !SERVICE_ID_RE.test(serviceId) || !registry.has(serviceId)) fail('RS_UNKNOWN_SERVICE', 'unknown service', { reason: 'UNKNOWN_SERVICE' });
    return registry.get(serviceId);
  };
  function setState(def, to, { reason = null, actor = 'SUPERVISOR', pid = null, exitCode = null } = {}) {
    const rec = records.get(def.serviceId);
    const from = rec.state;
    if (from === to) return;
    if (!canTransition(from, to)) throw new Error(`illegal transition ${from} → ${to}`);
    rec.state = to;
    audit.record({ event: 'TRANSITION', serviceId: def.serviceId, from, to, reason, actor, pid, exitCode, health: rec.health?.status });
  }
  const crashesInWindow = (rec) => { const t = now(); rec.crashTimes = rec.crashTimes.filter(x => t - x < L.crashWindowMs); return rec.crashTimes.length; };
  const backoffDelay = (n) => Math.min(L.backoffMaxMs, L.backoffBaseMs * 2 ** Math.max(0, n - 1));
  /** Epoch ms until which a manual restart is refused (CRASHED within its backoff window, or BACKOFF), else null. */
  const backoffUntil = (rec) => {
    if (rec.state === 'BACKOFF' && rec.retryAt) { const t = Date.parse(rec.retryAt); return t > now() ? t : null; }
    if (rec.state !== 'CRASHED') return null;
    const n = crashesInWindow(rec);
    const t = (rec.crashTimes.at(-1) ?? 0) + backoffDelay(n);
    return n > 0 && t > now() ? t : null;
  };

  function policyGate(serviceId) {
    let d;
    try { d = policyDecide({ action: 'SERVICE_RESTART', module: 'runtime-supervisor', trustDomain: 'RUNTIME', actor: { kind: 'USER' }, userInitiated: true, context: { serviceId } }); }
    catch { return { ok: false, code: 'ROOT_POLICY_DENIED' }; }
    if (d?.decision === 'ALLOW') return { ok: true, code: 'ALLOW' };
    return { ok: false, code: d?.decision === 'REQUIRE_APPROVAL' ? 'ROOT_POLICY_APPROVAL_REQUIRED' : 'ROOT_POLICY_DENIED', policyCode: String(d?.code ?? 'UNKNOWN').slice(0, 60) };
  }

  async function healthOf(def, instance) {
    const h = def.healthCheck;
    const r = await probe({ host: h.host, port: h.port, path: h.path, method: 'GET', timeoutMs: h.timeoutMs });
    if (r.code === 'REFUSED') return { status: 'UNREACHABLE', code: 'PORT_NOT_LISTENING', listening: false };
    if (r.code !== 'OK') return { status: 'DEGRADED', code: r.code === 'TIMEOUT' ? 'HEALTH_TIMEOUT' : 'HEALTH_HTTP_ERROR', listening: true };
    if (h.identity && (!instance || r.headers?.[INSTANCE_HEADER] !== instance.token)) return { status: 'DEGRADED', code: 'IDENTITY_MISMATCH', listening: true };
    return { status: 'HEALTHY', code: 'OK', listening: true };
  }

  function childEnv(def, token) {
    const env = {};
    for (const k of BASE_ENV_KEYS) if (typeof process.env[k] === 'string') env[k] = process.env[k];
    return { ...env, ...def.launch.env, DOCTEUR_RS_INSTANCE: token };
  }

  function onExit(def, instance, code) {
    if (instance.exited) return;
    instance.exited = true; instance.exitCode = code;
    instance.resolveExit();
    const rec = records.get(def.serviceId);
    if (rec.instance !== instance) return;
    rec.lastExitCode = Number.isInteger(code) ? code : null;
    if (instance.stopping) return; // an exit we asked for
    rec.crashTimes.push(now());
    rec.lastError = 'PROCESS_EXITED';
    rec.health = { status: 'UNREACHABLE', code: 'PROCESS_EXITED' };
    audit.record({ event: 'EXIT', serviceId: def.serviceId, pid: instance.pid, exitCode: rec.lastExitCode, reason: 'UNEXPECTED_EXIT' });
    // runs inside a child-process event: it must never throw into the server
    try {
      if (['HEALTHY', 'DEGRADED', 'STARTING'].includes(rec.state)) {
        setState(def, 'CRASHED', { reason: 'UNEXPECTED_EXIT', pid: instance.pid, exitCode: rec.lastExitCode });
        if (crashesInWindow(rec) >= L.maxCrashesInWindow) setState(def, 'BLOCKED', { reason: 'CRASH_LOOP' });
      }
    } catch { audit.record({ event: 'INTERNAL', serviceId: def.serviceId, reason: 'EXIT_TRANSITION_FAILED' }); }
  }

  function launch(def) {
    const token = crypto.randomBytes(16).toString('hex');
    let resolveExit;
    const exitPromise = new Promise(r => { resolveExit = r; });
    const instance = { id: crypto.randomUUID(), token, child: null, pid: null, startedAt: now(), exited: false, exitCode: null, stopping: false, exitPromise, resolveExit };
    let child;
    try {
      child = spawnImpl(def.launch.executable, [...def.launch.args], {
        cwd: def.launch.cwd, env: childEnv(def, token), shell: false, windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch { return { instance: null, code: 'SPAWN_FAILED' }; }
    instance.child = child; instance.pid = Number.isInteger(child?.pid) ? child.pid : null;
    child.once('error', () => onExit(def, instance, null));
    child.once('exit', (code) => onExit(def, instance, code));
    return { instance, code: instance.pid ? 'OK' : 'SPAWN_FAILED' };
  }

  /** Stops OUR instance only: graceful request → bounded wait → tree kill of our own handle → bounded wait. */
  async function stopInstance(def, instance) {
    if (!instance || instance.exited) return { stopped: true, forced: false };
    instance.stopping = true;
    if (def.gracefulStop.kind === 'HTTP_POST') {
      await probe({ host: def.healthCheck.host, port: def.healthCheck.port, path: def.gracefulStop.path, method: 'POST', timeoutMs: 1_000 });
    }
    const graceful = await Promise.race([instance.exitPromise.then(() => true), sleep(def.gracefulStopTimeoutMs).then(() => false)]);
    if (graceful) return { stopped: true, forced: false };
    if (instance.exited) return { stopped: true, forced: false };
    if (typeof killTree === 'function' && instance.child && !instance.exited) {
      audit.record({ event: 'FORCED_TERMINATION', serviceId: def.serviceId, pid: instance.pid, reason: 'GRACEFUL_STOP_TIMEOUT' });
      await killTree(instance.child);
    }
    const killed = await Promise.race([instance.exitPromise.then(() => true), sleep(L.killWaitMs).then(() => false)]);
    return { stopped: killed, forced: true };
  }

  async function waitPortReleased(def) {
    const deadline = now() + L.portReleaseTimeoutMs;
    for (;;) {
      const r = await probe({ host: def.healthCheck.host, port: def.healthCheck.port, path: def.healthCheck.path, method: 'GET', timeoutMs: 500 });
      if (r.code === 'REFUSED') return true;
      if (now() >= deadline) return false;
      await sleep(L.healthPollMs);
    }
  }

  async function runRestart(def, actor) {
    const rec = records.get(def.serviceId);
    const old = rec.instance;
    if (old && !old.exited) {
      const s = await stopInstance(def, old);
      if (!s.stopped) { rec.lastError = 'STOP_FAILED'; setState(def, 'BLOCKED', { reason: 'STOP_FAILED', pid: old.pid, actor }); return; }
    }
    if (!(await waitPortReleased(def))) { rec.lastError = 'PORT_IN_USE'; rec.health = { status: 'DEGRADED', code: 'PORT_IN_USE' }; setState(def, 'BLOCKED', { reason: 'PORT_IN_USE', actor }); return; }
    const { instance, code } = launch(def);
    if (!instance || code !== 'OK') { rec.lastError = 'SPAWN_FAILED'; rec.crashTimes.push(now()); setState(def, 'CRASHED', { reason: 'SPAWN_FAILED', actor }); return; }
    rec.instance = instance;
    setState(def, 'STARTING', { reason: 'LAUNCHED', pid: instance.pid, actor });
    const deadline = now() + def.startTimeoutMs;
    let last = { status: 'UNREACHABLE', code: 'PORT_NOT_LISTENING' };
    while (!instance.exited) {
      last = await healthOf(def, instance);
      if (instance.exited) break;
      if (last.status === 'HEALTHY') {
        rec.health = last; rec.restartCount += 1; rec.lastRestartAt = new Date(now()).toISOString(); rec.lastError = null; rec.retryAt = null;
        setState(def, 'HEALTHY', { reason: 'HEALTH_OK', pid: instance.pid, actor });
        return;
      }
      if (last.code === 'IDENTITY_MISMATCH' || now() >= deadline) break;
      await sleep(L.healthPollMs);
    }
    if (instance.exited) return; // onExit already moved STARTING → CRASHED (→ BLOCKED)
    rec.health = last.status === 'UNREACHABLE' ? { status: 'DEGRADED', code: 'START_TIMEOUT' } : last;
    rec.lastError = rec.health.code;
    setState(def, 'DEGRADED', { reason: rec.health.code, pid: instance.pid, actor });
  }

  async function observe(def) {
    const rec = records.get(def.serviceId);
    if (rec.observed && now() - rec.observedAt < L.observeCacheMs) return rec.observed;
    let o;
    try { o = await def.observe({ probe }); } catch { o = { state: 'DEGRADED', health: { status: 'DEGRADED', code: 'OBSERVE_FAILED' } }; }
    const state = RUNTIME_STATES.includes(o?.state) ? o.state : 'DEGRADED';
    const health = { status: HEALTH_STATUSES.includes(o?.health?.status) ? o.health.status : 'NOT_PROBED', code: String(o?.health?.code ?? 'UNKNOWN').slice(0, 60) };
    const next = { state, health, pid: Number.isInteger(o?.pid) ? o.pid : null, uptimeMs: Number.isFinite(o?.uptimeMs) ? Math.max(0, Math.round(o.uptimeMs)) : null,
      processRunning: typeof o?.processRunning === 'boolean' ? o.processRunning : null, portListening: typeof o?.portListening === 'boolean' ? o.portListening : null,
      lastError: typeof o?.lastError === 'string' ? o.lastError.slice(0, 60) : null };
    if (rec.observed && rec.observed.state !== next.state) audit.record({ event: 'OBSERVED_CHANGE', serviceId: def.serviceId, from: rec.observed.state, to: next.state, health: next.health.code });
    rec.observed = next; rec.observedAt = now();
    return next;
  }

  async function refreshOwned(def) {
    const rec = records.get(def.serviceId);
    if (rec.op || !rec.instance || rec.instance.exited || !['HEALTHY', 'DEGRADED'].includes(rec.state)) return;
    const h = await healthOf(def, rec.instance);
    if (rec.op || rec.instance.exited || !['HEALTHY', 'DEGRADED'].includes(rec.state)) return;
    rec.health = h;
    if (h.status === 'HEALTHY' && rec.state === 'DEGRADED') { rec.lastError = null; setState(def, 'HEALTHY', { reason: 'HEALTH_OK', pid: rec.instance.pid }); }
    if (h.status !== 'HEALTHY' && rec.state === 'HEALTHY') { rec.lastError = h.code; setState(def, 'DEGRADED', { reason: h.code, pid: rec.instance.pid }); }
  }

  // ── DELEGATED: projection of the owner's lifecycle (never a second state machine) ───────────────────────────────
  /** The owner's own status, read-only. A throwing / malformed delegate projects as DEGRADED, never as HEALTHY. */
  function delegatedStatus(def) {
    let s = null;
    try { s = def.delegate.status(); } catch { s = null; }
    if (!s || typeof s !== 'object' || s.serviceId !== def.serviceId || !DELEGATED_STATES.includes(s.state)) return null;
    return s;
  }
  const DELEGATED_HEALTH = Object.freeze({
    HEALTHY: { status: 'HEALTHY', code: 'OK' }, DEGRADED: { status: 'DEGRADED', code: 'HEALTH_FAILED' }, STOPPED: { status: 'NOT_PROBED', code: 'NOT_RUNNING' },
    STARTING: { status: 'NOT_PROBED', code: 'NOT_STARTED' }, STOPPING: { status: 'NOT_PROBED', code: 'NOT_RUNNING' }, CRASHED: { status: 'UNREACHABLE', code: 'PROCESS_EXITED' },
  });
  function projectDelegated(def) {
    const rec = records.get(def.serviceId);
    const s = delegatedStatus(def);
    const state = s ? s.state : 'DEGRADED';
    if (rec.observed && rec.observed.state !== state) audit.record({ event: 'OBSERVED_CHANGE', serviceId: def.serviceId, from: rec.observed.state, to: state });
    rec.observed = { state };
    return { s, state, health: s ? { ...DELEGATED_HEALTH[state] } : { status: 'DEGRADED', code: 'OBSERVE_FAILED' } };
  }
  function delegatedEligibility(def) {
    const rec = records.get(def.serviceId);
    if (!restartAuthority) return { allowed: false, code: 'RESTART_AUTHORITY_UNAVAILABLE' };
    if (rec.op) return { allowed: false, code: 'OPERATION_IN_PROGRESS' };
    const boundary = restartAuthority.boundaryStatus();
    if (!boundary.available) return { allowed: false, code: boundary.code };
    const s = delegatedStatus(def);
    if (s && ['STARTING', 'STOPPING'].includes(s.state)) return { allowed: false, code: 'OPERATION_IN_PROGRESS' };
    if (!s || s.owned !== true || !['HEALTHY', 'DEGRADED'].includes(s.state)) return { allowed: false, code: 'NOT_RUNNING' };
    return { allowed: true, code: 'CHALLENGE_REQUIRED' };
  }
  const CEREMONY_ERRORS = Object.freeze({
    ACTOR_NOT_PERMITTED: 'RS_ACTOR_NOT_PERMITTED', SERVICE_NOT_DELEGATED: 'RS_RESTART_NOT_ALLOWED', ROOT_POLICY_APPROVAL_REQUIRED: 'RS_POLICY_APPROVAL_REQUIRED',
    ROOT_POLICY_DENIED: 'RS_POLICY_DENIED', NOT_RUNNING: 'RS_NOT_RUNNING', CHALLENGE_INVALID: 'RS_CHALLENGE_INVALID', CHALLENGE_UNKNOWN: 'RS_CHALLENGE_INVALID',
    CHALLENGE_EXPIRED: 'RS_CHALLENGE_EXPIRED', CHALLENGE_REPLAYED: 'RS_CHALLENGE_REPLAYED', CHALLENGE_WRONG_SERVICE: 'RS_CHALLENGE_MISMATCH',
    CHALLENGE_ORIGIN_MISMATCH: 'RS_CHALLENGE_MISMATCH', DEFINITION_CHANGED: 'RS_CHALLENGE_STALE', INSTANCE_CHANGED: 'RS_CHALLENGE_STALE', STATE_CHANGED: 'RS_CHALLENGE_STALE',
    GESTURE_INVALID: 'RS_REQUEST_INVALID',
  });
  const CEREMONY_AUDIT = Object.freeze({ CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED', CHALLENGE_REPLAYED: 'CHALLENGE_REPLAY_REJECTED', ROOT_POLICY_APPROVAL_REQUIRED: 'RESTART_POLICY_DENIED', ROOT_POLICY_DENIED: 'RESTART_POLICY_DENIED' });
  const ceremonyFail = (def, r, actor) => {
    audit.record({ event: CEREMONY_AUDIT[r.code] ?? 'CHALLENGE_REJECTED', serviceId: def.serviceId, reason: r.policyCode ? `${r.code}:${r.policyCode}` : r.code, actor });
    fail(CEREMONY_ERRORS[r.code] ?? 'RS_RESTART_NOT_ALLOWED', 'restart ceremony refused', { reason: r.code });
  };
  const delegatedDef = (serviceId) => {
    const def = resolveDef(serviceId);
    if (def.kind !== 'DELEGATED') fail('RS_RESTART_NOT_ALLOWED', 'this service has no local restart ceremony', { reason: def.restartable ? 'CEREMONY_NOT_APPLICABLE' : notRestartableReason(def) });
    if (!restartAuthority) fail('RS_RESTART_NOT_ALLOWED', 'no restart authority is available', { reason: 'RESTART_AUTHORITY_UNAVAILABLE' });
    return def;
  };

  /** Step 1 of the ceremony. Returns only what the UI needs: an opaque id, its expiry and the state it was issued for. */
  function createRestartChallenge(serviceId, { origin = null, actor = 'USER' } = {}) {
    const def = delegatedDef(serviceId);
    const rec = records.get(def.serviceId);
    if (rec.op) fail('RS_OPERATION_IN_PROGRESS', 'an operation is already in progress', { reason: 'OPERATION_IN_PROGRESS' });
    const r = restartAuthority.issueChallenge({ serviceId: def.serviceId, status: delegatedStatus(def), origin, actor });
    if (!r.ok) ceremonyFail(def, r, actor);
    audit.record({ event: 'CHALLENGE_CREATED', serviceId: def.serviceId, actor });
    return deepFreeze({ serviceId: def.serviceId, challengeId: r.challengeId, expiresAt: r.expiresAt, state: r.state, operation: 'RESTART', effects: [...def.restartEffects] });
  }

  /** Step 2. Synchronous until the operation is registered: a second confirmation sees it (or a burnt challenge). */
  function confirmRestart(serviceId, { challengeId, gesture, origin = null, actor = 'USER' } = {}) {
    const def = delegatedDef(serviceId);
    const rec = records.get(def.serviceId);
    if (rec.op) fail('RS_OPERATION_IN_PROGRESS', 'an operation is already in progress', { reason: 'OPERATION_IN_PROGRESS' });
    const r = restartAuthority.confirmChallenge({ serviceId: def.serviceId, challengeId, gesture, origin, actor, status: delegatedStatus(def) });
    if (!r.ok) ceremonyFail(def, r, actor);
    const before = delegatedStatus(def);
    audit.record({ event: 'CHALLENGE_CONFIRMED', serviceId: def.serviceId, actor, reason: r.policyCode });
    audit.record({ event: 'RESTART_STARTED', serviceId: def.serviceId, actor, from: before?.state, pid: before?.pid ?? null });
    rec.op = Promise.resolve()
      .then(() => def.delegate.restartOwnedInstance(r.authorization))
      .then((res) => {
        const after = delegatedStatus(def);
        if (res?.ok === true && after?.state === 'HEALTHY') {
          rec.restartCount += 1; rec.lastRestartAt = new Date(now()).toISOString(); rec.lastError = null;
          audit.record({ event: 'RESTART_SUCCEEDED', serviceId: def.serviceId, actor, to: after.state, pid: after.pid ?? null });
        } else {
          rec.lastError = res?.ok === true ? 'RESTART_NOT_HEALTHY' : delegatedFailure(res?.error);
          audit.record({ event: 'RESTART_FAILED', serviceId: def.serviceId, actor, reason: rec.lastError, to: after?.state ?? null });
        }
      })
      .catch(() => { rec.lastError = 'INTERNAL'; audit.record({ event: 'RESTART_FAILED', serviceId: def.serviceId, actor, reason: 'INTERNAL' }); })
      .finally(() => { rec.op = null; });
    return deepFreeze({ accepted: true, serviceId: def.serviceId, state: before?.state ?? 'DEGRADED' });
  }
  /** The owner's failure code → a closed supervisor code (never the owner's message). */
  const DELEGATED_FAILURES = Object.freeze({
    restart_not_authorized: 'RESTART_NOT_AUTHORIZED', restart_stop_failed: 'STOP_FAILED', definition_changed: 'DEFINITION_CHANGED', instance_changed: 'INSTANCE_CHANGED',
    port_in_use: 'PORT_IN_USE', spawn_failed: 'SPAWN_FAILED', start_crashed: 'PROCESS_EXITED', start_cancelled: 'START_CANCELLED', binding_not_loopback: 'BINDING_NOT_LOOPBACK',
    identity_mismatch: 'IDENTITY_MISMATCH', operation_in_progress: 'OPERATION_IN_PROGRESS', binary_not_found: 'DEFINITION_INVALID', binary_invalid: 'DEFINITION_INVALID',
    invalid_port: 'DEFINITION_INVALID', no_archives: 'DEFINITION_INVALID', archive_invalid: 'DEFINITION_INVALID',
  });
  const delegatedFailure = (code) => DELEGATED_FAILURES[code] ?? 'RESTART_FAILED';

  /** Why a non-restartable service cannot be restarted here (a code, never free text). */
  const notRestartableReason = (def) => (def.kind === 'SELF' ? 'SELF_RESTART_UNSUPPORTED' : def.ownershipClass === 'DOCTEUR_MANAGED_OPTIONAL' ? 'MANAGED_BY_OWN_MODULE' : 'NOT_DOCTEUR_OWNED');
  function restartEligibility(def) {
    const rec = records.get(def.serviceId);
    if (def.kind === 'DELEGATED') return delegatedEligibility(def);
    if (!def.restartable) return { allowed: false, code: notRestartableReason(def) };
    if (typeof spawnImpl !== 'function') return { allowed: false, code: 'LAUNCHER_UNAVAILABLE' };
    if (rec.op || ['STARTING', 'STOPPING', 'RESTARTING'].includes(rec.state)) return { allowed: false, code: 'OPERATION_IN_PROGRESS' };
    const p = policyGate(def.serviceId);
    if (!p.ok) return { allowed: false, code: p.code };
    if (rec.state === 'BLOCKED') return { allowed: true, code: 'RESET_REQUIRED' };
    if (backoffUntil(rec) !== null) return { allowed: false, code: 'RESTART_BACKOFF' };
    return { allowed: true, code: ['HEALTHY', 'DEGRADED'].includes(rec.state) ? 'CONFIRMATION_REQUIRED' : 'OK' };
  }

  async function view(def) {
    const rec = records.get(def.serviceId);
    if (def.kind === 'DELEGATED') {
      const { s, state, health } = projectDelegated(def);
      const running = s?.owned === true;
      const started = running && typeof s.startedAt === 'string' ? Date.parse(s.startedAt) : NaN;
      return deepFreeze({
        serviceId: def.serviceId, displayName: def.displayName, ownershipClass: def.ownershipClass, kind: def.kind, optional: def.optional, dependencies: [...def.dependencies], note: def.note,
        state, health, processRunning: s ? running : null, portListening: state === 'HEALTHY' ? true : null, pid: running && Number.isInteger(s.pid) ? s.pid : null,
        uptimeMs: Number.isFinite(started) ? Math.max(0, now() - started) : null, lastExitCode: null,
        lastError: rec.lastError ?? (s?.lastError ? 'KIWIX_REPORTED_ERROR' : null), lastRestartAt: rec.lastRestartAt, restartCount: rec.restartCount, crashCount: 0, retryAt: null,
        operationInProgress: Boolean(rec.op), restart: delegatedEligibility(def), restartEffects: [...def.restartEffects],
      });
    }
    if (def.kind !== 'SPAWN') {
      const o = await observe(def);
      return deepFreeze({
        serviceId: def.serviceId, displayName: def.displayName, ownershipClass: def.ownershipClass, kind: def.kind, optional: def.optional, dependencies: [...def.dependencies], note: def.note,
        state: o.state, health: o.health, processRunning: o.processRunning, portListening: o.portListening, pid: o.pid, uptimeMs: o.uptimeMs,
        lastExitCode: null, lastError: o.lastError, lastRestartAt: null, restartCount: 0, crashCount: 0, retryAt: null, operationInProgress: false,
        restart: restartEligibility(def),
      });
    }
    await refreshOwned(def);
    const inst = rec.instance && !rec.instance.exited ? rec.instance : null;
    return deepFreeze({
      serviceId: def.serviceId, displayName: def.displayName, ownershipClass: def.ownershipClass, kind: def.kind, optional: def.optional, dependencies: [...def.dependencies], note: def.note,
      state: rec.state, health: { ...rec.health }, processRunning: Boolean(inst), portListening: rec.health.listening ?? null, pid: inst?.pid ?? null,
      uptimeMs: inst ? Math.max(0, now() - inst.startedAt) : null, lastExitCode: rec.lastExitCode, lastError: rec.lastError, lastRestartAt: rec.lastRestartAt,
      restartCount: rec.restartCount, crashCount: crashesInWindow(rec), retryAt: (() => { const t = backoffUntil(rec); return t === null ? null : new Date(t).toISOString(); })(), operationInProgress: Boolean(rec.op),
      restart: restartEligibility(def),
    });
  }

  async function restart(serviceId, { confirmInterrupt = false, resetBlocked = false, actor = 'USER' } = {}) {
    const def = resolveDef(serviceId);
    const rec = records.get(def.serviceId);
    // a delegated service is never restarted by the boolean confirmation path: only the local ceremony applies
    if (def.kind === 'DELEGATED') fail('RS_CHALLENGE_REQUIRED', 'this restart requires the local confirmation ceremony', { reason: 'CHALLENGE_REQUIRED' });
    if (!def.restartable) fail('RS_RESTART_NOT_ALLOWED', 'this service cannot be restarted by Docteur', { reason: notRestartableReason(def) });
    if (typeof spawnImpl !== 'function') fail('RS_RESTART_NOT_ALLOWED', 'no launcher is available for this service', { reason: 'LAUNCHER_UNAVAILABLE' });
    if (rec.op || ['STARTING', 'STOPPING', 'RESTARTING'].includes(rec.state)) fail('RS_OPERATION_IN_PROGRESS', 'an operation is already in progress', { reason: 'OPERATION_IN_PROGRESS' });
    const p = policyGate(def.serviceId);
    if (!p.ok) {
      audit.record({ event: 'RESTART_REFUSED', serviceId: def.serviceId, reason: p.code, actor });
      fail(p.code === 'ROOT_POLICY_APPROVAL_REQUIRED' ? 'RS_POLICY_APPROVAL_REQUIRED' : 'RS_POLICY_DENIED', 'Root Policy did not allow this restart', { reason: p.code });
    }
    if (rec.state === 'BLOCKED' && resetBlocked !== true) fail('RS_BLOCKED', 'the service is blocked: an explicit reset is required', { reason: 'RESET_REQUIRED' });
    if (['HEALTHY', 'DEGRADED'].includes(rec.state) && confirmInterrupt !== true) fail('RS_CONFIRMATION_REQUIRED', 'restarting may interrupt active work', { reason: 'CONFIRMATION_REQUIRED' });
    const until = backoffUntil(rec);
    if (until !== null) {
      rec.retryAt = new Date(until).toISOString();
      if (rec.state === 'CRASHED') setState(def, 'BACKOFF', { reason: 'CRASH_BACKOFF', actor });
      fail('RS_BACKOFF', 'restart is in backoff', { reason: 'RESTART_BACKOFF', retryAt: rec.retryAt });
    }
    if (rec.state === 'BLOCKED') { rec.crashTimes = []; audit.record({ event: 'BLOCK_RESET', serviceId: def.serviceId, actor }); }
    setState(def, 'RESTARTING', { reason: 'MANUAL_RESTART', actor });
    rec.retryAt = null;
    rec.op = runRestart(def, actor).catch(() => {
      if (['RESTARTING', 'STARTING'].includes(rec.state)) { rec.lastError = 'INTERNAL'; setState(def, rec.state === 'STARTING' ? 'CRASHED' : 'BLOCKED', { reason: 'INTERNAL' }); }
    }).finally(() => { rec.op = null; });
    return deepFreeze({ accepted: true, serviceId: def.serviceId, state: rec.state });
  }

  return Object.freeze({
    serviceIds: () => [...registry.keys()],
    async list() { return Promise.all([...registry.values()].map(view)); },
    async get(serviceId) { return view(resolveDef(serviceId)); },
    restart,
    createRestartChallenge,
    confirmRestart,
    events(serviceId, limit = 20) { resolveDef(serviceId); return audit.recent(serviceId, Math.min(50, Math.max(1, limit))); },
    async whenIdle(serviceId) { const rec = records.get(resolveDef(serviceId).serviceId); while (rec.op) await rec.op; },
    /** Server shutdown: stop every instance this supervisor launched (our handles only). */
    async shutdown() {
      for (const def of registry.values()) {
        const rec = records.get(def.serviceId);
        if (rec.op) await rec.op.catch(() => {});
        if (def.kind === 'SPAWN' && rec.instance && !rec.instance.exited) {
          if (['HEALTHY', 'DEGRADED', 'STARTING'].includes(rec.state)) setState(def, 'STOPPING', { reason: 'SHUTDOWN' });
          const s = await stopInstance(def, rec.instance);
          if (rec.state === 'STOPPING') setState(def, s.stopped ? 'STOPPED' : 'BLOCKED', { reason: s.stopped ? 'SHUTDOWN' : 'STOP_FAILED' });
        }
      }
    },
  });
}
