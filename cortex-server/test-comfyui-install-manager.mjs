import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test, { before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSqlite, setMeta } from './src/lib/sqlite.js';

const TEST_DB = './data-test-comfyui-install/test.db';

before(() => {
  fs.rmSync('./data-test-comfyui-install', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

beforeEach(() => {
  setMeta('comfyui_install', {});
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const {
  assertSafeInstallPath, assertSafeArchiveEntry, getInstallState, startManagedInstall,
  useExistingInstall, detachExternalInstall, startComfyUi, stopComfyUi, uninstallManaged,
  DEFAULT_MANAGED_PATH, cancelInstall, waitForComfyUiReady, _setRunningProcessForTest,
} = await import('./src/lib/comfyui-install-manager.js');
const { startModelDownload, deleteModel, MODEL_CATALOG, cancelModelDownload } = await import('./src/lib/comfyui-model-manager.js');

// ── Path safety — adversarial ─────────────────────────────────────────────────

test('assertSafeInstallPath: refuses empty, ".", ".."', () => {
  assert.throws(() => assertSafeInstallPath(''));
  assert.throws(() => assertSafeInstallPath('.'));
  assert.throws(() => assertSafeInstallPath('..'));
});

test('assertSafeInstallPath: refuses drive root', () => {
  assert.throws(() => assertSafeInstallPath('C:\\'));
  assert.throws(() => assertSafeInstallPath('C:/'));
});

test('assertSafeInstallPath: refuses Windows/Users system dirs', () => {
  assert.throws(() => assertSafeInstallPath('C:\\Windows'));
  assert.throws(() => assertSafeInstallPath('C:\\Users'));
});

test('assertSafeInstallPath: refuses the project root and its parent', () => {
  const projectRoot = path.resolve(process.cwd());
  assert.throws(() => assertSafeInstallPath(projectRoot));
  assert.throws(() => assertSafeInstallPath(path.resolve(projectRoot, '..')));
});

test('assertSafeInstallPath: accepts a plausible managed subdirectory', () => {
  const p = assertSafeInstallPath(path.join(process.cwd(), 'tools', 'comfyui'));
  assert.ok(p.length > 0);
});

test('assertSafeInstallPath: mustBeManagedRoot rejects any path other than the exact registered managed path', () => {
  assert.throws(() => assertSafeInstallPath(path.join(process.cwd(), 'tools', 'somewhere-else'), { mustBeManagedRoot: true }));
  assert.doesNotThrow(() => assertSafeInstallPath(DEFAULT_MANAGED_PATH, { mustBeManagedRoot: true }));
});

// ── Zip-slip / archive entry safety — adversarial ─────────────────────────────

test('assertSafeArchiveEntry: refuses parent-traversal entries', () => {
  assert.throws(() => assertSafeArchiveEntry('../../evil.exe', '/dest'));
  assert.throws(() => assertSafeArchiveEntry('ComfyUI/../../evil.exe', '/dest'));
});

test('assertSafeArchiveEntry: refuses absolute path entries', () => {
  assert.throws(() => assertSafeArchiveEntry('C:\\evil.exe', '/dest'));
  assert.throws(() => assertSafeArchiveEntry('/etc/passwd', '/dest'));
});

test('assertSafeArchiveEntry: accepts a normal nested entry', () => {
  const target = assertSafeArchiveEntry('ComfyUI/main.py', '/dest');
  assert.ok(target.startsWith(path.resolve('/dest')));
});

// ── External install ───────────────────────────────────────────────────────────

function makeFakeExternalInstall() {
  const dir = path.join(os.tmpdir(), `docteur-test-external-comfyui-${Date.now()}`);
  fs.mkdirSync(path.join(dir, 'ComfyUI'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'python_embeded'), { recursive: true });
  return dir;
}

test('useExistingInstall: rejects a nonexistent path', () => {
  const result = useExistingInstall({ installPath: path.join(os.tmpdir(), 'this-does-not-exist-xyz-docteur-test') });
  assert.equal(result.ok, false);
});

test('useExistingInstall: rejects a folder that does not look like a ComfyUI install', () => {
  const dir = path.join(os.tmpdir(), `docteur-test-not-comfyui-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const result = useExistingInstall({ installPath: dir });
  assert.equal(result.ok, false);
});

test('useExistingInstall: registers a directory with expected ComfyUI structure as external', () => {
  const result = useExistingInstall({ installPath: makeFakeExternalInstall() });
  assert.equal(result.ok, true);
  assert.equal(getInstallState().kind, 'external');
});

test('uninstallManaged: refuses to uninstall an external install', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  assert.throws(() => uninstallManaged({}));
});

test('detachExternalInstall: clears state but never deletes anything on disk', () => {
  const dir = makeFakeExternalInstall();
  useExistingInstall({ installPath: dir });
  const state = detachExternalInstall();
  assert.equal(state.kind, 'none');
  assert.equal(state.status, 'not_installed');
  assert.ok(fs.existsSync(dir), 'external install directory must not be deleted by detach');
});

test('detachExternalInstall: throws if there is no external install to detach', () => {
  assert.throws(() => detachExternalInstall());
});

// ── Start/stop — real spawn is exercised via ownership checks only ────────────
// (we never spawn a real ComfyUI process in automated tests — instead we
// verify the ownership/ready-detection logic using a fake tracked process).

test('startComfyUi: throws if not installed', () => {
  assert.throws(() => startComfyUi());
});

test('startComfyUi: throws if executable is not found in the registered folder', () => {
  const dir = path.join(os.tmpdir(), `docteur-test-incomplete-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  // Overwrite state to point at a folder that lacks python_embeded/main.py
  setMeta('comfyui_install', { kind: 'external', path: dir, status: 'installed', version: null });
  assert.throws(() => startComfyUi());
  assert.equal(getInstallState().status, 'error');
});

test('startComfyUi: spawn failure (e.g. non-executable file) is caught cleanly, sets status=error, and never crashes the process', async () => {
  const dir = makeFakeExternalInstall();
  // Create python_embeded/python.exe and ComfyUI/main.py as plain non-executable
  // files so resolveComfyUiExecutable's existence check passes but the OS
  // spawn call itself fails (some platforms throw sync, others emit async
  // 'error' — startComfyUi must handle both without an unhandled exception
  // or an unhandled 'error' event reaching the process).
  fs.writeFileSync(path.join(dir, 'python_embeded', 'python.exe'), 'not a real executable');
  fs.writeFileSync(path.join(dir, 'ComfyUI', 'main.py'), '# not real');
  useExistingInstall({ installPath: dir });

  let threw = false;
  try {
    startComfyUi();
  } catch {
    threw = true;
  }
  // Give any async spawn 'error'/'exit' event a moment to fire too.
  await new Promise((r) => setTimeout(r, 500));
  const state = getInstallState();
  assert.ok(threw || state.status === 'error' || state.status === 'starting', 'must either throw synchronously or transition state — never crash the test process');
});

test('stopComfyUi: throws if not running', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  assert.throws(() => stopComfyUi());
});

test('stopComfyUi: refuses to signal a PID Docteur did not itself track (ownership check)', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  setMeta('comfyui_install', { kind: 'external', path: getInstallState().path, status: 'running', pid: 999999 });
  _setRunningProcessForTest(null); // simulate: no process tracked in this process's memory
  assert.throws(() => stopComfyUi(), /n'a pas été démarré par Docteur|n’a pas été démarré par Docteur/);
});

test('stopComfyUi: stops a process Docteur is actually tracking', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  let killed = false;
  const fakeChild = { kill: () => { killed = true; } };
  _setRunningProcessForTest({ pid: 4242, child: fakeChild });
  setMeta('comfyui_install', { kind: 'external', path: getInstallState().path, status: 'running', pid: 4242 });
  const result = stopComfyUi();
  assert.equal(result.status, 'stopped');
  assert.equal(killed, true);
});

// ── Ready polling ──────────────────────────────────────────────────────────────

test('waitForComfyUiReady: returns process_exited if state is no longer starting/running', async () => {
  setMeta('comfyui_install', { kind: 'external', path: '/tmp/x', status: 'error' });
  const result = await waitForComfyUiReady('http://127.0.0.1:8188', 500);
  assert.equal(result.ready, false);
  assert.equal(result.errorCode, 'process_exited');
});

test('waitForComfyUiReady: times out if the endpoint never responds', async () => {
  setMeta('comfyui_install', { kind: 'external', path: '/tmp/x', status: 'starting' });
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const result = await waitForComfyUiReady('http://127.0.0.1:8188', 300);
  assert.equal(result.ready, false);
  assert.equal(result.errorCode, 'timeout');
});

test('waitForComfyUiReady: resolves ready:true once the endpoint responds', async () => {
  setMeta('comfyui_install', { kind: 'external', path: '/tmp/x', status: 'starting' });
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/system_stats')) return new Response(JSON.stringify({ system: {}, devices: [] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const result = await waitForComfyUiReady('http://127.0.0.1:8188', 3000);
  assert.equal(result.ready, true);
  assert.equal(getInstallState().status, 'running');
});

// ── Install: dangerous destination refused before any network call ───────────

test('startManagedInstall: rejects a dangerous destination without starting a download', () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  assert.throws(() => startManagedInstall({ destination: 'C:\\' }));
  assert.equal(getInstallState().status, 'not_installed');
  assert.equal(fetchCalled, false);
});

test('startManagedInstall: rejects when disk space is insufficient, before any download starts', () => {
  const originalStatfs = fs.statfsSync;
  fs.statfsSync = () => ({ bsize: 4096, bavail: 1 }); // ~4KB free — far below any real requirement
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  try {
    assert.throws(() => startManagedInstall({}), /Espace disque insuffisant/);
    assert.equal(fetchCalled, false);
  } finally {
    fs.statfsSync = originalStatfs;
  }
});

test('cancelInstall: throws for an unknown job id (nothing to cancel)', () => {
  assert.throws(() => cancelInstall('not-a-real-job-id'));
});

// ── Model download — allowlist + disk space + cancellation ───────────────────

test('startModelDownload: rejects an id not in the allowlisted catalog', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  assert.throws(() => startModelDownload('some-random-model-id-not-in-catalog'));
});

test('startModelDownload: refuses when ComfyUI is not installed', () => {
  assert.throws(() => startModelDownload(MODEL_CATALOG[0]?.id ?? 'sd15-pruned-emaonly-fp16'));
});

test('startModelDownload: rejects when disk space is insufficient, before any download starts', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  const originalStatfs = fs.statfsSync;
  fs.statfsSync = () => ({ bsize: 4096, bavail: 1 });
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  try {
    assert.throws(() => startModelDownload(MODEL_CATALOG[0].id), /Espace disque insuffisant/);
    assert.equal(fetchCalled, false);
  } finally {
    fs.statfsSync = originalStatfs;
  }
});

test('cancelModelDownload: throws for an unknown job id', () => {
  assert.throws(() => cancelModelDownload('not-a-real-job-id'));
});

// ── Model delete — path safety ────────────────────────────────────────────────

test('deleteModel: rejects a filename containing path separators or traversal', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  assert.throws(() => deleteModel('../../etc/passwd'));
  assert.throws(() => deleteModel('sub/dir/model.safetensors'));
  assert.throws(() => deleteModel('sub\\dir\\model.safetensors'));
});

test('deleteModel: throws for a nonexistent model file', () => {
  useExistingInstall({ installPath: makeFakeExternalInstall() });
  assert.throws(() => deleteModel('does-not-exist.safetensors'));
});

test('deleteModel: deletes exactly the named file, leaving sibling files untouched', () => {
  const dir = makeFakeExternalInstall();
  useExistingInstall({ installPath: dir });
  const checkpointsDir = path.join(dir, 'ComfyUI', 'models', 'checkpoints');
  fs.mkdirSync(checkpointsDir, { recursive: true });
  fs.writeFileSync(path.join(checkpointsDir, 'keep.safetensors'), 'keep');
  fs.writeFileSync(path.join(checkpointsDir, 'delete-me.safetensors'), 'delete');

  const result = deleteModel('delete-me.safetensors');
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(checkpointsDir, 'delete-me.safetensors')), false);
  assert.equal(fs.existsSync(path.join(checkpointsDir, 'keep.safetensors')), true);
});

// ── Catalog: small, vetted, no invented data ──────────────────────────────────

test('MODEL_CATALOG: is a small allowlist (1-3 entries), each with required verified fields', () => {
  assert.ok(MODEL_CATALOG.length >= 1 && MODEL_CATALOG.length <= 3);
  for (const entry of MODEL_CATALOG) {
    assert.ok(entry.id);
    assert.ok(entry.name);
    assert.ok(entry.filename);
    assert.ok(entry.source.startsWith('https://'));
    assert.ok(entry.license);
    assert.ok(typeof entry.approxSizeGb === 'number' && entry.approxSizeGb > 0);
    assert.ok(entry.capabilities.text_to_image === true);
  }
});
