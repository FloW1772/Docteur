/**
 * OMEGA 4.1 persistent local indicator manager.
 *
 * A separate, visible WinForms window lives exactly as long as an active
 * OMEGA session. The child is started with an absolute PowerShell path,
 * shell:false, fixed enum arguments and a per-session lease file. The lease
 * makes a crashed/restarted Cortex unable to leave a permanent stale window:
 * the indicator exits when heartbeats stop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT_PATH = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'omega-indicator.ps1');

export const OMEGA_INDICATOR_MODES = Object.freeze({ VIEW: 'view', INTERACTIVE: 'interactive', ADMIN: 'admin' });
export const INDICATOR_HEARTBEAT_MS = 1_000;
export const INDICATOR_LEASE_TIMEOUT_MS = 5_000;

const activeIndicators = new Map(); // sessionId:mode -> { sessionId, mode, deviceId, child, interval, expiryTimer, watcher, dir, leaseFile }
let processFactory = ({ args }) => spawn(POWERSHELL_EXE, args, {
  shell: false,
  windowsHide: true,
  stdio: 'ignore',
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateMode(mode) {
  if (!Object.values(OMEGA_INDICATOR_MODES).includes(mode)) fail('indicator_mode_invalid');
}

function writeLease(leaseFile) {
  try { fs.writeFileSync(leaseFile, String(Date.now()), { encoding: 'utf8' }); } catch { /* child will exit when its lease becomes unreadable */ }
}

function removeIndicatorFiles(record) {
  try { fs.rmSync(record.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function recordKey(sessionId, mode) {
  return `${sessionId}:${mode}`;
}

function releaseRecord(key, { kill = false } = {}) {
  const record = activeIndicators.get(key);
  if (!record) return false;
  activeIndicators.delete(key);
  clearInterval(record.interval);
  if (record.expiryTimer) clearTimeout(record.expiryTimer);
  try { record.watcher?.close(); } catch { /* already closed */ }
  if (kill) {
    try { record.child.kill(); } catch { /* already exited */ }
  }
  removeIndicatorFiles(record);
  return true;
}

export function _setIndicatorProcessFactoryForTests(factory) {
  processFactory = factory;
}

export function _resetIndicatorProcessFactoryForTests() {
  processFactory = ({ args }) => spawn(POWERSHELL_EXE, args, {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
}

export function _resetIndicatorsForTests() {
  for (const key of [...activeIndicators.keys()]) releaseRecord(key, { kill: true });
}

/** Starts or replaces the persistent indicator for one session/capability. */
export function startPersistentIndicator({ sessionId, deviceId, mode, expiresAt, onLocalStop } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) fail('indicator_session_required');
  validateMode(mode);
  const key = recordKey(sessionId, mode);
  releaseRecord(key, { kill: true });

  if (process.platform !== 'win32') return { ok: false, persistent: false, reason: 'not_windows' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-omega-indicator-'));
  const leaseFile = path.join(dir, 'lease.txt');
  const stopFile = path.join(dir, 'stop.txt');
  const modeArg = mode;
  writeLease(leaseFile);

  let child;
  try {
    child = processFactory({
      args: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', SCRIPT_PATH,
        '-Mode', modeArg,
        '-LeaseFile', leaseFile,
        '-StopFile', stopFile,
        '-LeaseTimeoutMs', String(INDICATOR_LEASE_TIMEOUT_MS),
      ],
    });
  } catch (error) {
    removeIndicatorFiles({ dir });
    return { ok: false, persistent: false, reason: 'indicator_spawn_failed', detail: error?.message };
  }

  const interval = setInterval(() => writeLease(leaseFile), INDICATOR_HEARTBEAT_MS);
  interval.unref?.();
  const record = { sessionId, mode, deviceId: deviceId ?? null, child, interval, expiryTimer: null, watcher: null, dir, leaseFile, stopFile, localStopRequested: false };
  activeIndicators.set(key, record);

  try {
    record.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (String(filename) !== path.basename(stopFile) || record.localStopRequested) return;
      record.localStopRequested = true;
      Promise.resolve(onLocalStop?.()).catch(() => {});
    });
  } catch { /* the lease/remote STOP path remains authoritative */ }

  child.once?.('error', () => releaseRecord(key));
  child.once?.('exit', () => releaseRecord(key));

  if (expiresAt) {
    const expiryMs = new Date(expiresAt).getTime();
    if (Number.isFinite(expiryMs)) {
      const delay = Math.max(0, expiryMs - Date.now());
      record.expiryTimer = setTimeout(() => releaseRecord(key, { kill: true }), delay);
      record.expiryTimer.unref?.();
    }
  }

  return { ok: true, persistent: true, pid: child.pid ?? null };
}

/** Stops only the process owned by this exact OMEGA session/capability. */
export function stopPersistentIndicator(sessionId, mode = null) {
  let stopped = false;
  for (const [key, record] of activeIndicators) {
    if (record.sessionId !== sessionId || (mode && record.mode !== mode)) continue;
    stopped = releaseRecord(key, { kill: true }) || stopped;
  }
  return stopped;
}

export function stopPersistentIndicatorsForDevice(deviceId) {
  let stopped = 0;
  for (const [key, record] of activeIndicators) {
    if (record.deviceId === deviceId && releaseRecord(key, { kill: true })) stopped += 1;
  }
  return stopped;
}

export function getPersistentIndicatorState(sessionId, mode = null) {
  for (const record of activeIndicators.values()) {
    if (record.sessionId !== sessionId || (mode && record.mode !== mode)) continue;
    return { sessionId, mode: record.mode, deviceId: record.deviceId, pid: record.child.pid ?? null, persistent: true };
  }
  return null;
}

export { INDICATOR_LEASE_TIMEOUT_MS as OMEGA_INDICATOR_LEASE_TIMEOUT_MS, SCRIPT_PATH as INDICATOR_SCRIPT_PATH };
