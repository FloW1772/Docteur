import './test-setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from './src/lib/sqlite.js';
import { createKiwixLifecycle, isPortFree, defaultArchivesFolder } from './src/lib/kiwix.js';

db.initSqlite(':memory:');

// A scratch folder with one real (empty, just needs to exist + .zim extension)
// archive file so scanArchives() finds something — startKiwixServe() refuses
// to spawn with zero archives, which would short-circuit before we ever
// reach the args-construction code this suite is testing.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-kiwix-test-'));
const fakeZimPath = path.join(scratchDir, 'fake.zim');
fs.writeFileSync(fakeZimPath, 'not a real zim, just needs to exist');

// Fake kiwix-serve.exe path — resolveKiwixServeBinary() only checks
// fs.existsSync + .exe suffix, so any existing file works as the "binary".
const fakeBinaryPath = path.join(scratchDir, 'kiwix-serve.exe');
fs.writeFileSync(fakeBinaryPath, 'fake binary');

beforeEach(async () => {
  db.setKiwixSettings({
    kiwixServePath: fakeBinaryPath,
    archivesFolder: scratchDir,
    port: 18199, // dedicated test port, distinct from any real dev usage
  });
});

const lifecycle = (spawnFn) => createKiwixLifecycle({
  spawnFn,
  health: async () => false,
  portFree: async () => true,
  limits: { healthAttempts: 0, healthIntervalMs: 1, verifyWindowMs: 20, stopGraceMs: 20, forceWaitMs: 20, portReleaseMs: 20 },
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 99999;
    this.stderr = new EventEmitter();
  }
  kill() { this.emit('exit', 0); }
}

test('startKiwixServe passes --address=127.0.0.1 to the spawned process (loopback enforcement)', async () => {
  let capturedArgs = null;
  const spawnFn = (binary, args) => { capturedArgs = args; return new FakeChild(); };

  // healthCheck() will never succeed against a fake process (nothing is
  // actually listening), so this returns before the ~8s poll timeout in a
  // production run — but node --test's default timeout and the harness's
  // --test-timeout=20000 comfortably cover the ~8s worst case.
  const result = await lifecycle(spawnFn).start();

  assert.ok(result.ok, 'startKiwixServe should report ok:true once the child process spawned cleanly');
  assert.ok(capturedArgs.includes('--address=127.0.0.1'), `expected --address=127.0.0.1 in args, got: ${JSON.stringify(capturedArgs)}`);
});

test('startKiwixServe passes --blockexternal to the spawned process', async () => {
  let capturedArgs = null;
  const spawnFn = (binary, args) => { capturedArgs = args; return new FakeChild(); };
  await lifecycle(spawnFn).start();
  assert.ok(capturedArgs.includes('--blockexternal'));
});

test('startKiwixServe never passes shell:true to child_process.spawn', async () => {
  let capturedOpts = null;
  const spawnFn = (binary, args, opts) => { capturedOpts = opts; return new FakeChild(); };
  await lifecycle(spawnFn).start();
  assert.equal(capturedOpts.shell, false);
});

test('startKiwixServe includes the port flag matching configured settings', async () => {
  let capturedArgs = null;
  const spawnFn = (binary, args) => { capturedArgs = args; return new FakeChild(); };
  await lifecycle(spawnFn).start();
  assert.ok(capturedArgs.includes('--port=18199'));
});

test('startKiwixServe refuses to start with zero archives, never calls spawnFn', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-kiwix-empty-'));
  db.setKiwixSettings({ archivesFolder: emptyDir });
  let spawnCalled = false;
  const spawnFn = () => { spawnCalled = true; return new FakeChild(); };
  const result = await lifecycle(spawnFn).start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_archives');
  assert.equal(spawnCalled, false);
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

test('startKiwixServe refuses to start when binary is not configured/found', async () => {
  db.setKiwixSettings({ kiwixServePath: null });
  let spawnCalled = false;
  const spawnFn = () => { spawnCalled = true; return new FakeChild(); };
  const result = await lifecycle(spawnFn).start();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'binary_not_found');
  assert.equal(spawnCalled, false);
});

test('double-start is idempotent: second call returns alreadyRunning without spawning again', async () => {
  let spawnCount = 0;
  const spawnFn = () => { spawnCount++; return new FakeChild(); };
  const lc = lifecycle(spawnFn);
  await lc.start();
  const second = await lc.start();
  assert.equal(second.alreadyRunning, true);
  assert.equal(spawnCount, 1, 'spawnFn must not be called a second time while already running');
});

test('stopKiwixServe on an already-stopped instance is a harmless no-op (wasRunning:false)', async () => {
  // [KWX-1] stop is asynchronous: it resolves only once the owned process has really exited
  const result = await lifecycle(() => new FakeChild()).stop();
  assert.equal(result.ok, true);
  assert.equal(result.wasRunning, false);
});

test('a spawned-then-exited child resets status to not-running (crash detection)', async () => {
  let child;
  const spawnFn = () => { child = new FakeChild(); return child; };
  const lc = lifecycle(spawnFn);
  await lc.start();
  assert.equal(lc.status().running, true);
  child.emit('exit', 1); // simulate the spawned process crashing
  assert.equal(lc.status().running, false);
});

// ── Port ownership: never kill an unknown process on a busy port ────────

test('isPortFree correctly reports a port occupied by an unrelated listener as not free', async () => {
  const net = await import('node:net');
  const server = net.default.createServer();
  await new Promise((resolve) => server.listen(18198, '127.0.0.1', resolve));
  try {
    const free = await isPortFree(18198);
    assert.equal(free, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('isPortFree reports an actually-free port as free', async () => {
  const free = await isPortFree(18197);
  assert.equal(free, true);
});

test('defaultArchivesFolder resolves under the current user profile, never a bare drive root', () => {
  const folder = defaultArchivesFolder();
  assert.ok(folder.includes('kiwix-desktop'));
  assert.notEqual(folder, 'C:\\');
});
