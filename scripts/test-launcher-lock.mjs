// [STARTUP-2] Launch lock: isolated temp directories only (never the real %LOCALAPPDATA%\Docteur\launcher).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, releaseLock, STALE_UNREADABLE_MS } from './launcher-lock.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-lock-test-'));
const A = { pid: 1111, created: '134371000000000001' };
const B = { pid: 2222, created: '134371000000000002' };
const alive = (...owners) => o => owners.some(x => x.pid === o.pid && x.created === o.created);

test('first launch acquires, a concurrent one is refused while the owner lives, release frees it', () => {
  const dir = tempDir();
  try {
    const a = acquireLock({ owner: A, isOwnerAlive: alive(A), dir });
    assert.equal(a.acquired, true);
    const b = acquireLock({ owner: B, isOwnerAlive: alive(A, B), dir });
    assert.deepEqual([b.acquired, b.reason, b.owner.pid], [false, 'ACTIVE', 1111]);
    assert.equal(releaseLock(a), true);
    assert.equal(fs.existsSync(path.join(dir, 'launch.lock')), false);
    assert.equal(acquireLock({ owner: B, isOwnerAlive: alive(B), dir }).acquired, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stale lock (owner gone, or its PID now names another process) is reclaimed; same owner re-enters', () => {
  const dir = tempDir();
  try {
    assert.equal(acquireLock({ owner: A, isOwnerAlive: alive(A), dir }).acquired, true); // A crashes without releasing
    assert.equal(acquireLock({ owner: B, isOwnerAlive: alive(B), dir }).acquired, true, 'owner dead → reclaimed');
    const reusedPid = { pid: 2222, created: '134371000000000999' }; // B's PID recycled by an unrelated process
    assert.equal(acquireLock({ owner: A, isOwnerAlive: alive(A, reusedPid), dir }).acquired, true, 'same PID, other creation time → stale');
    const again = acquireLock({ owner: A, isOwnerAlive: alive(A), dir });
    assert.equal(again.acquired, true, 'the same launch process may re-acquire its own lock');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unreadable lock: fresh = another launch is writing it (refused), old = reclaimed', () => {
  const dir = tempDir();
  const file = path.join(dir, 'launch.lock');
  try {
    fs.writeFileSync(file, '{"pid":');
    assert.equal(acquireLock({ owner: A, isOwnerAlive: () => false, dir }).acquired, false);
    const old = new Date(Date.now() - STALE_UNREADABLE_MS - 5_000);
    fs.utimesSync(file, old, old);
    assert.equal(acquireLock({ owner: A, isOwnerAlive: () => false, dir }).acquired, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('release only removes our own lock; a missing owner identity never acquires', () => {
  const dir = tempDir();
  try {
    const a = acquireLock({ owner: A, isOwnerAlive: alive(A), dir });
    const b = acquireLock({ owner: B, isOwnerAlive: alive(B), dir }); // A considered dead → B reclaims
    assert.equal(b.acquired, true);
    assert.equal(releaseLock(a), false, 'A must not delete B\'s lock');
    assert.equal(fs.existsSync(b.file), true);
    assert.equal(releaseLock({ acquired: false }), false);
    for (const owner of [null, { pid: 'x', created: '1' }, { pid: 1 }, { pid: 1, created: 'abc' }]) {
      assert.deepEqual(acquireLock({ owner, isOwnerAlive: () => false, dir }).reason, 'LOCK_ERROR');
    }
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp') || f.includes('.stale-')).length, 0, 'no temp / stale files left');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock directory errors fail closed (LOCK_ERROR), never "acquired"', () => {
  const dir = tempDir();
  const blocker = path.join(dir, 'not-a-dir');
  try {
    fs.writeFileSync(blocker, 'x');
    const r = acquireLock({ owner: A, isOwnerAlive: () => false, dir: path.join(blocker, 'launcher') });
    assert.deepEqual([r.acquired, r.reason], [false, 'LOCK_ERROR']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// real processes racing on the same directory (simultaneous double-click), repeated 10 times
const RACER = `
import { acquireLock } from ${JSON.stringify(new URL('./launcher-lock.mjs', import.meta.url).href)};
const [dir, pid, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const r = acquireLock({ owner: { pid: Number(pid), created: '1' + pid }, isOwnerAlive: () => true, dir });
process.stdout.write(r.acquired ? 'WON' : r.reason);
`;
test('simultaneous launches: exactly one wins, every time (10 rounds × 6 racers)', async () => {
  const root = tempDir();
  const racer = path.join(root, 'racer.mjs');
  fs.writeFileSync(racer, RACER);
  try {
    for (let round = 0; round < 10; round++) {
      const dir = path.join(root, `round-${round}`);
      const startAt = Date.now() + 700;
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise(resolve => {
        const child = spawn(process.execPath, [racer, dir, String(3000 + i), String(startAt)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.on('exit', () => resolve(out));
      })));
      assert.equal(results.filter(r => r === 'WON').length, 1, `round ${round}: ${results.join(',')}`);
      assert.ok(results.every(r => r === 'WON' || r === 'ACTIVE'), results.join(','));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
