// [STARTUP-2] One launch sequence at a time per Windows user. The lock is advisory — it only decides whether THIS launch
// may proceed and is never evidence for terminating anything.
//   - atomic create: the full JSON is written to a private temp file, then hard-linked to the lock name (link fails if the
//     lock exists), so a reader never sees a half-written lock;
//   - owner = { pid, created } of the launching node process (creation time from the process snapshot), so a recycled
//     PID never keeps a dead launch's lock alive;
//   - stale (owner gone / PID reused / unreadable and older than STALE_UNREADABLE_MS) → reclaimed by an atomic rename;
//   - release removes the lock only if it is still ours.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const STALE_UNREADABLE_MS = 2 * 60_000;

export function defaultLockDir(env = process.env) {
  return path.join(env.LOCALAPPDATA || os.tmpdir(), 'Docteur', 'launcher');
}

function readLock(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    if (!data || !Number.isInteger(data.pid) || !/^\d+$/.test(String(data.created ?? ''))) return { readable: false };
    return { readable: true, data };
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { readable: false };
  }
}

const lockKey = r => (r.readable ? JSON.stringify([r.data.pid, String(r.data.created), r.data.session ?? null, r.data.startedAt ?? null]) : 'unreadable');

function writeAtomically(file, data) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data), { flag: 'wx' });
  try { fs.linkSync(temp, file); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; } finally { fs.rmSync(temp, { force: true }); }
}

/**
 * isOwnerAlive({ pid, created }) → true only when that exact process (same PID AND same creation time) still exists.
 * Returns { acquired: true, lock } · { acquired: false, reason: 'ACTIVE', owner } · { acquired: false, reason: 'LOCK_ERROR' }.
 */
export function acquireLock({ owner, isOwnerAlive, dir = defaultLockDir(), now = Date.now } = {}) {
  if (!owner || !Number.isInteger(owner.pid) || !/^\d+$/.test(String(owner.created ?? ''))) return { acquired: false, reason: 'LOCK_ERROR', detail: 'OWNER_UNKNOWN' };
  const file = path.join(dir, 'launch.lock');
  const lock = { pid: owner.pid, created: String(owner.created), session: crypto.randomUUID(), startedAt: new Date(now()).toISOString() };
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      if (writeAtomically(file, lock)) return { acquired: true, lock, file };
      const current = readLock(file);
      if (current.missing) continue;
      let stale;
      if (current.readable) {
        const same = current.data.pid === owner.pid && String(current.data.created) === lock.created;
        stale = same || !isOwnerAlive({ pid: current.data.pid, created: String(current.data.created) });
        if (!stale) return { acquired: false, reason: 'ACTIVE', owner: { pid: current.data.pid, startedAt: current.data.startedAt ?? null } };
      } else {
        let age = 0;
        try { age = now() - fs.statSync(file).mtimeMs; } catch { continue; }
        stale = age > STALE_UNREADABLE_MS;
        if (!stale) return { acquired: false, reason: 'ACTIVE', owner: null };
      }
      // reclaim: only one contender can rename the stale file away (the loser sees ENOENT and retries the create). If what
      // was moved is not the lock judged stale (another launch re-created it meanwhile), it is put back untouched.
      const aside = `${file}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try { fs.renameSync(file, aside); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const moved = readLock(aside);
      if (lockKey(moved) !== lockKey(current)) {
        try { fs.linkSync(aside, file); } catch { /* yet another launch created one: it stays authoritative */ }
        fs.rmSync(aside, { force: true });
        return { acquired: false, reason: 'ACTIVE', owner: moved.readable ? { pid: moved.data.pid, startedAt: moved.data.startedAt ?? null } : null };
      }
      fs.rmSync(aside, { force: true });
    }
    return { acquired: false, reason: 'ACTIVE', owner: null };
  } catch (error) {
    return { acquired: false, reason: 'LOCK_ERROR', detail: error.code ?? 'ERROR' };
  }
}

/** Removes the lock only if it is still the one we created. */
export function releaseLock(held) {
  if (!held?.acquired) return false;
  const current = readLock(held.file);
  if (!current.readable || current.data.session !== held.lock.session) return false;
  try { fs.rmSync(held.file); return true; } catch { return false; }
}
