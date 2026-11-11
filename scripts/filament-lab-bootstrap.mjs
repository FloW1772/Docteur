// [ARCADE-SAFETY V3 2026-10-23] Filament lab bootstrap — the ONLY file the supervised launcher starts.
//
// It runs nothing of the approved script until the launcher has measured THIS process's memory. Sequence:
//   1. checks its invocation (IPC channel present, target name shape, session nonce shape) and arms a start deadline
//   2. tells the launcher it is listening: { type: 'FILAMENT_BOOTSTRAP_READY', v: 1, pid }
//   3. waits, event-driven (no polling, no busy loop), for exactly one start signal from the launcher:
//      { type: 'FILAMENT_START', v: 1, pid: <this pid>, sessionHash: sha256(this run's nonce), measuredAt, startupRssKB }
//      sent only after the launcher obtained a valid tasklist measurement of this PID
//   4. on a valid signal: stops listening, closes the IPC channel (the approved script gets no channel to the
//      launcher), then imports the approved script, whose module evaluation registers and runs its tests
// Fail-closed, before any import of the target: invalid / stale signal → exit 20; no signal within START_WAIT_MS →
// exit 21; channel closed or launcher gone before the start → exit 22; bad invocation → exit 23. A repeated start
// signal cannot start anything twice (the channel is closed after the first one).
// Imports: node:crypto, node:path, node:url only. No file access, no network, no process creation. The launcher pins
// this file by SHA-256 (BOOTSTRAP_SHA256 in scripts/filament-safe-run.mjs) and refuses to run a modified copy.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const START_WAIT_MS = 6000;
export const MAX_SIGNAL_AGE_MS = 3000;
const CODE = Object.freeze({ INVALID_START: 20, START_EXPIRED: 21, PARENT_GONE_BEFORE_START: 22, BAD_INVOCATION: 23 });
const START_KEYS = 'measuredAt,pid,sessionHash,startupRssKB,type,v';

const say = (event, details = {}) => process.stderr.write(`${JSON.stringify({ bootstrap: 'filament-lab', event, ...details })}\n`);
const abort = (code, event, details) => { say(event, details); process.exit(code); };

const target = process.argv[2];
const nonce = process.env.FILAMENT_LAB_SESSION;
if (typeof process.send !== 'function' || !process.channel) abort(CODE.BAD_INVOCATION, 'NO_IPC_CHANNEL');
if (typeof target !== 'string' || !/^scripts\/[a-z0-9]+(?:-[a-z0-9]+)*\.mjs$/.test(target)) abort(CODE.BAD_INVOCATION, 'BAD_TARGET');
if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) abort(CODE.BAD_INVOCATION, 'NO_SESSION');
const expectedHash = crypto.createHash('sha256').update(nonce).digest('hex');

let started = false;
const expiry = setTimeout(() => abort(CODE.START_EXPIRED, 'START_WAIT_EXPIRED', { waitedMs: START_WAIT_MS }), START_WAIT_MS);

function onDisconnect() {
  if (!started) abort(CODE.PARENT_GONE_BEFORE_START, 'CHANNEL_CLOSED_BEFORE_START');
}

function onMessage(message) {
  if (started) return; // unreachable once the channel is closed below; never starts twice
  const plain = message !== null && typeof message === 'object' && !Array.isArray(message);
  const keys = plain ? Object.keys(message).sort().join(',') : '';
  if (keys !== START_KEYS || message.type !== 'FILAMENT_START' || message.v !== 1 || message.pid !== process.pid
    || message.sessionHash !== expectedHash || !Number.isSafeInteger(message.measuredAt)
    || !Number.isSafeInteger(message.startupRssKB) || message.startupRssKB <= 0) {
    abort(CODE.INVALID_START, 'INVALID_START_SIGNAL');
  }
  const ageMs = Date.now() - message.measuredAt;
  if (ageMs < -1000 || ageMs > MAX_SIGNAL_AGE_MS) abort(CODE.INVALID_START, 'STALE_START_SIGNAL', { ageMs });
  started = true;
  clearTimeout(expiry);
  process.off('message', onMessage);
  process.off('disconnect', onDisconnect);
  process.disconnect(); // the approved script runs with no channel to the launcher
  say('START_ACCEPTED', { pid: process.pid, startupRssKB: message.startupRssKB });
  import(pathToFileURL(path.join(ROOT, target)).href).catch((error) => {
    say('TARGET_FAILED', { message: String(error?.message ?? error).slice(0, 200) });
    process.exitCode = 1;
  });
}

process.on('disconnect', onDisconnect);
process.on('message', onMessage);
process.send({ type: 'FILAMENT_BOOTSTRAP_READY', v: 1, pid: process.pid });
