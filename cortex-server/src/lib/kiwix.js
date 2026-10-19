// [KWX-1] Kiwix lifecycle — hardened (2026-10-19).
//
// Ownership: this module is the ONLY owner of the kiwix-serve process it launches. Everything that stops or signals a
// process goes through the exact ChildProcess handle it spawned, never through an executable name, a port, or a PID
// coming from a request or from stored state. An exit observed for an older instance can never touch a newer one.
//
// Start: fixed basename `kiwix-serve.exe` (validated real file, no link, no UNC/device path), typed argv in the exact
// shape of the Root Policy V2 candidate template `kiwix-serve-loopback` (`--port=N --address=127.0.0.1 --blockexternal
// <abs .zim>…`, cwd = the executable's own folder), `shell: false`, minimal environment, stdio ignored. An occupied
// port is refused (never "freed"). Concurrent starts share one operation.
//
// Health ≠ PID: STARTING becomes HEALTHY only when the process is alive, kiwix-serve answers on 127.0.0.1 AND the OS
// listener table shows ONLY loopback listeners owned by OUR PID. A wide / LAN listener or a foreign owner stops OUR
// instance and fails closed; an undeterminable table never counts as verified (DEGRADED / binding_unverified).
//
// Stop: STOPPING → terminate our handle → wait for the REAL 'exit' → (if needed) tree-kill of our live handle → wait →
// port released → STOPPED. A process that does not exit is never reported stopped (stop_timeout, DEGRADED).
//
// Root Policy: the active signed policy (v1) has no `kiwix` module (PROCESS_START / PROCESS_STOP ⇒ DENY_UNKNOWN_MODULE).
// The existing USER start / stop routes therefore keep their current, ungated behaviour (KWX_ROOT_POLICY_REQUIRES_
// SEPARATE_POLICY_MISSION). The FUTURE Runtime Supervisor restart path is a separate, typed port
// (createKiwixLifecyclePort) that can only act after a Root Policy SERVICE_RESTART decision of ALLOW — under the sealed
// v1 policy that decision is REQUIRE_APPROVAL, so the port fails closed. It is not wired anywhere.

import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getKiwixSettings } from './sqlite.js';
import { runNetstatListing, parseNetstatListeners } from './port-preflight.js';
import { killProcessTree } from './process-tree.js';
import { decide as rootPolicyDecide } from './root-policy/index.js';

export const KIWIX_TOOLS_URL = 'https://download.kiwix.org/release/kiwix-tools/';

// kiwix-serve's own --help (v3.7.0, empirically confirmed 2026-09-22): without --address it binds to ALL interfaces
// (netstat showed 0.0.0.0:<port> LISTENING). Docteur always passes this loopback address; it is never configurable.
const LOOPBACK_ADDRESS = '127.0.0.1';
const LOOPBACK_LISTENERS = new Set(['127.0.0.1', '::1']);
export const KIWIX_SERVICE_ID = 'kiwix-serve';
export const KIWIX_BINARY_NAME = 'kiwix-serve.exe';
export const KIWIX_STATES = Object.freeze(['STOPPED', 'STARTING', 'HEALTHY', 'DEGRADED', 'STOPPING', 'CRASHED']);
/** The only legal lifecycle transitions. Anything else is a bug and throws. */
export const KIWIX_TRANSITIONS = Object.freeze({
  STOPPED: Object.freeze(['STARTING']),
  CRASHED: Object.freeze(['STARTING', 'STOPPED']),
  STARTING: Object.freeze(['HEALTHY', 'DEGRADED', 'CRASHED', 'STOPPING']),
  HEALTHY: Object.freeze(['DEGRADED', 'CRASHED', 'STOPPING']),
  DEGRADED: Object.freeze(['HEALTHY', 'CRASHED', 'STOPPING']),
  STOPPING: Object.freeze(['STOPPED', 'DEGRADED', 'CRASHED']),
});
export const KIWIX_LIMITS = Object.freeze({
  minPort: 1024, maxPort: 65_535, maxArchives: 256, maxPathChars: 1024,
  healthAttempts: 16, healthIntervalMs: 500, // ~8 s inside the request (large ZIMs open slowly)
  verifyWindowMs: 30_000, // then background verification until this window closes → DEGRADED / start_timeout
  stopGraceMs: 3_000, forceWaitMs: 3_000, portReleaseMs: 1_500, // < the UI's 8 s stop request timeout
});
const RESERVED_PORTS = new Set([3001, 5173, 11_434, 8188, Number(process.env.PORT) || 3001]);
const CHILD_ENV_KEYS = Object.freeze(['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']);
const RESTART_REASONS = Object.freeze(['USER_REQUESTED', 'SUPERVISOR']);
const RESTART_FIELDS = Object.freeze(['reason', 'expectedDefinitionDigest', 'expectedGeneration']);
const DEFINITION_ADAPTER = 'kiwix-lifecycle@1';

export function defaultArchivesFolder() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'kiwix-desktop');
}

// ── Binary / port / archives validation ──────────────────────────────────────────────────────────────────────────────

/** A real regular file named exactly kiwix-serve.exe (also after resolving links); never a UNC / device path. */
export function validateKiwixBinary(candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.length > KIWIX_LIMITS.maxPathChars || candidate.includes('\0')) return { ok: false, code: 'binary_not_found' };
  if (!path.isAbsolute(candidate) || /^[\\/]{2}/.test(candidate)) return { ok: false, code: 'binary_invalid' };
  if (path.basename(candidate).toLowerCase() !== KIWIX_BINARY_NAME) return { ok: false, code: 'binary_invalid' };
  let st;
  try { st = fs.lstatSync(candidate); } catch { return { ok: false, code: 'binary_not_found' }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: 'binary_invalid' };
  let real;
  try { real = fs.realpathSync.native(candidate); } catch { return { ok: false, code: 'binary_not_found' }; }
  if (path.basename(real).toLowerCase() !== KIWIX_BINARY_NAME || /^[\\/]{2}/.test(real)) return { ok: false, code: 'binary_invalid' };
  return { ok: true, path: real, size: st.size, mtimeMs: st.mtimeMs };
}

function resolveBinaryFromSettings(settings) {
  const configured = settings?.kiwixServePath;
  if (!configured || typeof configured !== 'string') return { ok: false, code: 'binary_not_found' };
  const candidate = configured.toLowerCase().endsWith('.exe') ? configured : path.join(configured, KIWIX_BINARY_NAME);
  return validateKiwixBinary(candidate);
}

/** Kept for existing callers: the validated kiwix-serve.exe path, or null. */
export function resolveKiwixServeBinary() {
  const r = resolveBinaryFromSettings(getKiwixSettings());
  return r.ok ? r.path : null;
}

/** An integer port in [1024, 65535] that is not one of Docteur's own service ports, or null. */
export function validateKiwixPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < KIWIX_LIMITS.minPort || port > KIWIX_LIMITS.maxPort || RESERVED_PORTS.has(port)) return null;
  return port;
}

function validateArchives(archives) {
  if (!Array.isArray(archives) || archives.length === 0) return { ok: false, code: 'no_archives' };
  if (archives.length > KIWIX_LIMITS.maxArchives) return { ok: false, code: 'archive_invalid' };
  for (const a of archives) {
    const p = a?.path;
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0') || p.length > KIWIX_LIMITS.maxPathChars || /^[\\/]{2}/.test(p) || !p.toLowerCase().endsWith('.zim')) return { ok: false, code: 'archive_invalid' };
    let st;
    try { st = fs.lstatSync(p); } catch { return { ok: false, code: 'archive_invalid' }; }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: 'archive_invalid' };
  }
  return { ok: true };
}

// ── Scan des archives .zim ────────────────────────────────────────────────────

export function scanArchives(folder) {
  const target = folder || getKiwixSettings().archivesFolder || defaultArchivesFolder();
  if (!fs.existsSync(target)) return { folder: target, archives: [] };

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { folder: target, archives: [] };
  }

  const archives = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.zim'))
    .map(e => {
      const fullPath = path.join(target, e.name);
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch { /* ignore */ }
      return {
        name: path.basename(e.name, path.extname(e.name)),
        fileName: e.name,
        path: fullPath,
        sizeBytes: size,
      };
    });

  return { folder: target, archives };
}

// ── Vérification port libre ────────────────────────────────────────────────────

export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

// ── Health check (127.0.0.1 only, no redirect followed) ──────────────────────

export async function healthCheck(port) {
  const target = port || getKiwixSettings().port || 8090;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    const res = await fetch(`http://127.0.0.1:${target}/`, { signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(timer);
    return (res.status >= 200 && res.status < 400) || res.status === 404; // kiwix-serve répond même sans lib configurée
  } catch {
    return false;
  }
}

// ── OS listener table (who really listens on the port) ───────────────────────

/** Listeners of one TCP port from netstat -ano (fixed exe, typed argv, shell:false — port-preflight.js). */
export async function listPortListeners(port, { runNetstat = runNetstatListing } = {}) {
  let r;
  try { r = await runNetstat(); } catch { r = null; }
  if (!r?.ok) return { ok: false, reason: r?.reason ?? 'probe_failed' };
  const { listeners } = parseNetstatListeners(r.stdout);
  return { ok: true, listeners: listeners.filter(l => l.port === port) };
}

/**
 * Fail-closed binding verification. LOOPBACK_ONLY only when the table is readable, every listener on the port is a
 * loopback address and (when expectedPid is given) every listener is owned by that PID.
 * Statuses: LOOPBACK_ONLY | NOT_LOOPBACK | FOREIGN_LISTENER | NOT_LISTENING | UNDETERMINED.
 */
export async function verifyLoopbackBinding(port, { expectedPid = null, listListeners = listPortListeners } = {}) {
  let table;
  try { table = await listListeners(port); } catch { table = null; }
  if (!table?.ok || !Array.isArray(table.listeners)) return { status: 'UNDETERMINED', loopbackOnly: false, reason: table?.reason ?? 'probe_failed' };
  const listeners = table.listeners;
  if (listeners.length === 0) return { status: 'NOT_LISTENING', loopbackOnly: false };
  if (listeners.some(l => !LOOPBACK_LISTENERS.has(String(l.address)))) return { status: 'NOT_LOOPBACK', loopbackOnly: false };
  if (listeners.some(l => !Number.isInteger(l.pid) || l.pid <= 0)) return { status: 'UNDETERMINED', loopbackOnly: false, reason: 'owner_unknown' };
  if (expectedPid !== null && listeners.some(l => l.pid !== expectedPid)) return { status: 'FOREIGN_LISTENER', loopbackOnly: false };
  return { status: 'LOOPBACK_ONLY', loopbackOnly: true };
}

// ── Service definition digest (binds future approvals to what would really run) ───────────────────────────────────

const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function kiwixDefinitionDigest({ binary, args, cwd, port }) {
  return sha256(canonical({
    v: 1, serviceId: KIWIX_SERVICE_ID, adapter: DEFINITION_ADAPTER, ownership: 'MODULE_OWNED_CHILD',
    executable: { basename: path.basename(binary.path).toLowerCase(), path: binary.path, size: binary.size, mtimeMs: binary.mtimeMs },
    args: sha256(JSON.stringify(args)), cwd, port,
    healthCheck: { host: LOOPBACK_ADDRESS, port, path: '/' }, stop: { kind: 'TERMINATE_OWN_HANDLE', graceMs: KIWIX_LIMITS.stopGraceMs }, restart: 'MANUAL',
  }));
}

// ── Lifecycle (one owned instance at a time) ─────────────────────────────────

const MESSAGES = Object.freeze({
  binary_not_found: `kiwix-serve.exe introuvable. Télécharge kiwix-tools_win-i686.zip depuis ${KIWIX_TOOLS_URL}, extrais-le, puis renseigne le dossier dans Réglages.`,
  binary_invalid: 'Le chemin configuré ne désigne pas un fichier kiwix-serve.exe valide.',
  invalid_port: 'Port Kiwix invalide (1024–65535, hors ports réservés de Docteur).',
  no_archives: 'Aucune archive .zim trouvée dans le dossier configuré.',
  archive_invalid: 'Une archive .zim du dossier configuré est invalide.',
  port_in_use: 'Le port configuré est déjà utilisé par un autre processus (non démarré par Docteur) : il n’est jamais arrêté.',
  operation_in_progress: 'Une opération Kiwix est déjà en cours.',
  spawn_failed: 'Impossible de démarrer kiwix-serve.',
  start_crashed: 'kiwix-serve s’est arrêté pendant son démarrage.',
  start_cancelled: 'Démarrage annulé par un arrêt.',
  binding_not_loopback: 'kiwix-serve ne s’est pas lié en local uniquement — arrêté par sécurité.',
  identity_mismatch: 'Un autre processus répond sur ce port — l’instance lancée par Docteur a été arrêtée.',
  binding_unverified: 'kiwix-serve répond, mais sa liaison locale n’a pas pu être vérifiée.',
  stop_timeout: 'kiwix-serve ne s’est pas arrêté : il est toujours en cours d’exécution.',
  port_not_released: 'kiwix-serve est arrêté, mais le port reste occupé par un autre processus.',
  request_invalid: 'Requête de relance invalide.',
  definition_changed: 'La configuration Kiwix a changé depuis la demande.',
  instance_changed: 'L’instance Kiwix a changé depuis la demande.',
  restart_not_authorized: 'La Root Policy n’autorise pas cette relance.',
  restart_stop_failed: 'Relance interrompue : l’arrêt de l’instance en cours a échoué.',
});
const failure = (code, extra = {}) => ({ ok: false, error: code, message: MESSAGES[code] ?? 'Erreur Kiwix.', ...extra });

/**
 * @param {object} deps — injected only by tests; the product uses the defaults.
 *   spawnFn, getSettings, scan, portFree, health, listListeners, terminate(child), forceKill(child), logger, limits
 */
export function createKiwixLifecycle({
  spawnFn = spawn, getSettings = getKiwixSettings, scan = scanArchives, portFree = isPortFree, health = healthCheck,
  listListeners = listPortListeners, terminate = (child) => child.kill(), forceKill = killProcessTree, logger = null, limits = {},
} = {}) {
  const L = { ...KIWIX_LIMITS, ...limits };
  const S = { state: 'STOPPED', instance: null, generation: 0, lastError: null, lastExitCode: null, startPromise: null, stopPromise: null };
  const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
  const log = (event, fields = {}, lg = logger) => { try { lg?.info?.({ event, serviceId: KIWIX_SERVICE_ID, ...fields }, 'kiwix lifecycle'); } catch { /* logging never breaks the lifecycle */ } };
  const setState = (to, code = null, lg) => {
    const from = S.state;
    if (from === to) return;
    if (!KIWIX_TRANSITIONS[from]?.includes(to)) throw new Error(`illegal kiwix transition ${from} → ${to}`);
    S.state = to;
    log('transition', { from, to, code, port: S.instance?.port ?? null, pid: S.instance?.pid ?? null }, lg);
  };
  const isCurrent = (inst) => S.instance === inst && !inst.exited && !inst.stopping;

  function finalizeExit(inst, code, source) {
    if (inst.exited) { log('duplicate_exit_event', { generation: inst.generation }); return; }
    inst.exited = true; inst.exitCode = Number.isInteger(code) ? code : null;
    clearTimeout(inst.verifyTimer);
    inst.resolveExit();
    if (S.instance !== inst) { log('stale_instance_event', { generation: inst.generation }); return; } // an older instance never touches a newer one
    if (inst.stopping) return; // the stop flow finishes the transition
    S.instance = null; S.lastExitCode = inst.exitCode; S.lastError = source === 'error' ? 'process_error' : 'process_exited';
    log('unexpected_exit', { pid: inst.pid, exitCode: inst.exitCode, code: S.lastError });
    try { setState('CRASHED', S.lastError); } catch { /* exit handlers never throw into the server */ }
  }

  function resolveDefinition() {
    const settings = getSettings() ?? {};
    const binary = resolveBinaryFromSettings(settings);
    if (!binary.ok) return { ok: false, code: binary.code };
    const port = validateKiwixPort(settings.port ?? 8090);
    if (port === null) return { ok: false, code: 'invalid_port' };
    const { archives } = scan(settings.archivesFolder || defaultArchivesFolder());
    const arch = validateArchives(archives);
    if (!arch.ok) return { ok: false, code: arch.code };
    const args = [`--port=${port}`, `--address=${LOOPBACK_ADDRESS}`, '--blockexternal', ...archives.map(a => a.path)];
    const cwd = path.dirname(binary.path);
    return { ok: true, binary, port, archives, args, cwd, digest: kiwixDefinitionDigest({ binary, args, cwd, port }) };
  }

  function childEnv() {
    const env = {};
    for (const k of CHILD_ENV_KEYS) if (typeof process.env[k] === 'string') env[k] = process.env[k];
    return env;
  }

  /** One verification step: 'pending' | 'healthy' | 'degraded' | 'unsafe' | 'gone'. */
  async function verifyOnce(inst, lg) {
    if (!isCurrent(inst)) return 'gone';
    const up = await health(inst.port);
    if (!isCurrent(inst)) return 'gone';
    if (!up) return 'pending';
    const binding = await verifyLoopbackBinding(inst.port, { expectedPid: inst.pid, listListeners });
    if (!isCurrent(inst)) return 'gone';
    inst.binding = binding.status;
    if (binding.status === 'LOOPBACK_ONLY') { S.lastError = null; setState('HEALTHY', 'HEALTH_AND_BINDING_VERIFIED', lg); return 'healthy'; }
    if (binding.status === 'NOT_LISTENING') return 'pending';
    if (binding.status === 'NOT_LOOPBACK' || binding.status === 'FOREIGN_LISTENER') {
      const code = binding.status === 'NOT_LOOPBACK' ? 'binding_not_loopback' : 'identity_mismatch';
      log('unsafe_listener_stopping_own_instance', { pid: inst.pid, port: inst.port, code }, lg);
      await stopInstance(inst, { reason: code, finalState: 'CRASHED', lg });
      S.lastError = code;
      return 'unsafe';
    }
    S.lastError = 'binding_unverified';
    if (S.state === 'STARTING') setState('DEGRADED', 'BINDING_UNVERIFIED', lg);
    return 'degraded';
  }

  function scheduleBackgroundVerify(inst, interval, lg) {
    const tick = async () => {
      if (!isCurrent(inst) || S.state !== 'STARTING') return;
      if (Date.now() - inst.startedAt >= L.verifyWindowMs) {
        S.lastError = 'start_timeout';
        try { setState('DEGRADED', 'START_TIMEOUT', lg); } catch { /* state moved meanwhile */ }
        return;
      }
      let r = 'gone';
      try { r = await verifyOnce(inst, lg); } catch { r = 'gone'; }
      if (r === 'pending') { inst.verifyTimer = setTimeout(tick, Math.max(interval, 100)); inst.verifyTimer.unref?.(); }
    };
    inst.verifyTimer = setTimeout(tick, Math.max(interval, 100));
    inst.verifyTimer.unref?.();
  }

  async function waitExit(inst, ms) { await Promise.race([inst.exitPromise, sleep(ms)]); return inst.exited; }

  async function waitPortReleased(port) {
    const deadline = Date.now() + L.portReleaseMs;
    for (;;) {
      if ((await portFree(port)) && !(await health(port))) return true;
      if (Date.now() >= deadline) return false;
      await sleep(100);
    }
  }

  /** Stops OUR instance only: terminate our handle → real exit → (tree-kill our live handle) → port released. One stop per instance. */
  function stopInstance(inst, opts = {}) {
    if (!inst.stopPromise) inst.stopPromise = runStop(inst, opts).finally(() => { inst.stopPromise = null; });
    return inst.stopPromise;
  }
  async function runStop(inst, { reason = 'USER_STOP', finalState = 'STOPPED', lg } = {}) {
    inst.stopping = true;
    clearTimeout(inst.verifyTimer);
    setState('STOPPING', reason, lg);
    if (!inst.exited) { try { terminate(inst.child); } catch { /* handled by the waits below */ } }
    let forced = false;
    if (!(await waitExit(inst, L.stopGraceMs))) {
      // Tree-kill ONLY a genuine, still-running ChildProcess we spawned (never a PID from state or request).
      if (!inst.exited && inst.child instanceof ChildProcess && inst.child.exitCode === null && inst.child.signalCode === null) {
        forced = true;
        log('forced_termination', { pid: inst.pid }, lg);
        try { await forceKill(inst.child); } catch { /* verified below */ }
      }
      await waitExit(inst, L.forceWaitMs);
    }
    if (!inst.exited) {
      inst.stopping = false; // still running and still ours
      S.lastError = 'stop_timeout';
      setState('DEGRADED', 'STOP_TIMEOUT', lg);
      return failure('stop_timeout', { state: S.state, forced, processExited: false });
    }
    if (S.instance === inst) S.instance = null;
    S.lastExitCode = inst.exitCode;
    const released = await waitPortReleased(inst.port);
    setState(finalState, reason, lg);
    if (!released) { S.lastError = 'port_not_released'; return failure('port_not_released', { state: S.state, forced, processExited: true }); }
    if (finalState === 'STOPPED') S.lastError = null;
    return { ok: true, wasRunning: true, stopped: true, forced, exitCode: inst.exitCode, state: S.state };
  }

  function status() {
    const inst = S.instance && !S.instance.exited ? S.instance : null;
    return {
      serviceId: KIWIX_SERVICE_ID, state: S.state, running: Boolean(inst), healthy: S.state === 'HEALTHY',
      port: inst?.port ?? null, archives: inst?.archives ?? [], lastError: S.lastError, lastExitCode: S.lastExitCode,
      pid: inst?.pid ?? null, startedAt: inst ? new Date(inst.startedAt).toISOString() : null, generation: S.generation, binding: inst?.binding ?? null,
    };
  }

  async function doStart({ spawnFn: spawnOverride, logger: lg = logger, healthCheckAttempts = L.healthAttempts, healthCheckIntervalMs = L.healthIntervalMs } = {}) {
    const def = resolveDefinition();
    if (S.instance && !S.instance.exited) return { ok: true, alreadyRunning: true, ...status() }; // our own instance is never a foreign occupant
    if (!def.ok) { S.lastError = def.code; return failure(def.code); }
    if (!(await portFree(def.port)) || (await health(def.port))) { S.lastError = 'port_in_use'; return failure('port_in_use', { port: def.port }); }
    setState('STARTING', 'USER_START', lg);
    S.generation += 1;
    let resolveExit;
    const exitPromise = new Promise(r => { resolveExit = r; });
    const inst = { generation: S.generation, child: null, pid: null, startedAt: Date.now(), port: def.port, archives: def.archives, exited: false, exitCode: null, stopping: false, exitPromise, resolveExit, verifyTimer: null, binding: null, stopPromise: null };
    let child;
    try {
      child = (spawnOverride ?? spawnFn)(def.binary.path, def.args, { cwd: def.cwd, env: childEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      S.lastError = 'spawn_failed';
      setState('CRASHED', 'SPAWN_FAILED', lg);
      return failure('spawn_failed');
    }
    inst.child = child; inst.pid = Number.isInteger(child?.pid) ? child.pid : null;
    S.instance = inst;
    child.once('exit', (code) => finalizeExit(inst, code, 'exit'));
    child.once('error', () => finalizeExit(inst, null, 'error'));
    log('launched', { pid: inst.pid, port: inst.port, generation: inst.generation }, lg);
    for (let i = 0; i < healthCheckAttempts; i++) {
      await sleep(healthCheckIntervalMs);
      if (!isCurrent(inst)) break;
      const r = await verifyOnce(inst, lg);
      if (r === 'healthy') return { ok: true, ...status(), bindingVerified: true, message: `kiwix-serve démarré avec ${def.archives.length} archive(s).` };
      if (r === 'degraded') return { ok: true, ...status(), bindingVerified: false, code: 'binding_unverified', message: MESSAGES.binding_unverified };
      if (r === 'unsafe') return failure(S.lastError, { state: S.state });
      if (r === 'gone') break;
    }
    if (inst.stopping) return failure('start_cancelled', { state: S.state }); // a stop took over: not a crash
    if (inst.exited) return failure('start_crashed', { exitCode: inst.exitCode, state: S.state });
    if (S.instance !== inst) return failure('start_cancelled', { state: S.state });
    scheduleBackgroundVerify(inst, healthCheckIntervalMs, lg);
    return { ok: true, ...status(), bindingVerified: false, message: `kiwix-serve démarré avec ${def.archives.length} archive(s) — vérification en cours.` };
  }

  return Object.freeze({
    /** User start (existing route): idempotent for a running owned instance; one start at a time; refused while stopping. */
    start(opts = {}) {
      if (S.stopPromise || S.state === 'STOPPING') return Promise.resolve(failure('operation_in_progress', { state: S.state }));
      if (S.startPromise) return S.startPromise;
      if (S.instance && !S.instance.exited) return Promise.resolve({ ok: true, alreadyRunning: true, ...status() });
      S.startPromise = doStart(opts).finally(() => { S.startPromise = null; });
      return S.startPromise;
    },
    /** User stop (existing route): stops only our instance, waits for the real exit; a second call joins the first. */
    stop(opts = {}) {
      if (S.stopPromise) return S.stopPromise;
      const inst = S.instance;
      if (!inst || inst.exited) {
        if (S.state === 'CRASHED') setState('STOPPED', 'ACKNOWLEDGED', opts.logger);
        return Promise.resolve({ ok: true, wasRunning: false, state: S.state });
      }
      S.stopPromise = stopInstance(inst, { reason: 'USER_STOP', lg: opts.logger }).finally(() => { S.stopPromise = null; });
      return S.stopPromise;
    },
    status,
    /** The digest of what a start would run right now (paths stay inside this module). */
    describe() { const d = resolveDefinition(); return d.ok ? { ok: true, serviceId: KIWIX_SERVICE_ID, definitionDigest: d.digest, port: d.port } : { ok: false, code: d.code }; },
    /** process.on('exit') hook: synchronous best effort on OUR live handle only. */
    shutdownSync(lg) {
      const inst = S.instance;
      if (!inst || inst.exited) return;
      inst.stopping = true;
      log('shutdown_stop', { pid: inst.pid }, lg);
      try { inst.child.kill(); } catch { /* process exit */ }
    },
  });
}

// ── Product instance + the existing API (route / server / runtime observer) ──

const productLifecycle = createKiwixLifecycle();

export function startKiwixServe(opts = {}) { return productLifecycle.start(opts); }
export function stopKiwixServe(opts = {}) { return productLifecycle.stop(opts); }
export function getStatus() { return productLifecycle.status(); }
export function registerShutdownHook(logger) {
  process.on('exit', () => productLifecycle.shutdownSync(logger));
}

// ── FUTURE Runtime Supervisor delegation contract (V1B) — NOT WIRED ──────────
// Typed, Kiwix-specific, closed: it accepts NO executable, argument, working directory, PID or command — the
// definition stays fixed inside this module. Every restart first needs a Root Policy SERVICE_RESTART decision of ALLOW
// bound to this service and to the digest of what would really run (target = serviceId, payloadHash = digest). Under
// the sealed v1 policy that decision is REQUIRE_APPROVAL: the port fails closed and touches nothing.

const defaultAuthorizeRestart = ({ serviceId, definitionDigest }) => rootPolicyDecide({
  action: 'SERVICE_RESTART', module: 'runtime-supervisor', trustDomain: 'RUNTIME', actor: { kind: 'USER' }, userInitiated: true,
  context: { serviceId, target: serviceId, payloadHash: definitionDigest },
});

export function createKiwixLifecyclePort({ lifecycle = productLifecycle, authorizeRestart = defaultAuthorizeRestart } = {}) {
  if (typeof authorizeRestart !== 'function' || typeof lifecycle?.start !== 'function') throw new Error('KIWIX_PORT_INVALID');
  return Object.freeze({
    serviceId: KIWIX_SERVICE_ID,
    getLifecycleStatus() {
      const s = lifecycle.status(); const d = lifecycle.describe();
      return Object.freeze({ serviceId: KIWIX_SERVICE_ID, state: s.state, owned: s.running, pid: s.pid, port: s.port, startedAt: s.startedAt, generation: s.generation, lastError: s.lastError, definitionDigest: d.ok ? d.definitionDigest : null });
    },
    async restartOwnedKiwix(request = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) return failure('request_invalid', { reason: 'NOT_AN_OBJECT' });
      for (const k of Object.keys(request)) if (!RESTART_FIELDS.includes(k)) return failure('request_invalid', { reason: 'UNKNOWN_FIELD' });
      if (!RESTART_REASONS.includes(request.reason)) return failure('request_invalid', { reason: 'REASON' });
      const d = lifecycle.describe();
      if (!d.ok) return failure(d.code);
      if (request.expectedDefinitionDigest !== undefined && request.expectedDefinitionDigest !== d.definitionDigest) return failure('definition_changed');
      if (request.expectedGeneration !== undefined && request.expectedGeneration !== lifecycle.status().generation) return failure('instance_changed');
      let verdict = null;
      try { verdict = await authorizeRestart({ serviceId: KIWIX_SERVICE_ID, operation: 'RESTART', definitionDigest: d.definitionDigest }); } catch { verdict = null; }
      if (verdict?.decision !== 'ALLOW') return failure('restart_not_authorized', { policyCode: String(verdict?.code ?? 'UNKNOWN').slice(0, 60) });
      if (lifecycle.status().running) {
        const stopped = await lifecycle.stop();
        if (!stopped.ok) return failure('restart_stop_failed', { stop: stopped.error });
      }
      return lifecycle.start();
    },
  });
}
