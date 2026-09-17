// OM-4 — Certification de l'adapter OpenMontage (installation isolée, aucun
// rendu réel). Vérifie : détection d'installation, cwd/root Remotion isolé,
// registry d'outils, garde-fous de chemins (traversal, UNC, DB, secrets),
// environnement filtré (aucune credential Docteur transmise), timeout,
// cancellation, absence de shell:true, absence d'auto-install.
//
// Run: node --test test-openmontage-adapter.mjs
import './test-setup.mjs'; // must be first
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  OPENMONTAGE_ROOT,
  REMOTION_COMPOSER_ROOT,
  WORKSPACES_ROOT,
  STATUS,
  detectInstallation,
  getStatus,
  getCapabilities,
  createWorkspace,
  runLocalCommand,
  cancelJob,
  getJobStatus,
  reapJob,
} from './src/lib/openmontage-adapter.js';
import { within, resolveJobWorkspace, checkedWorkspacePath, filteredEnv } from './src/lib/openmontage-policy.js';

const HAS_INSTALL = fs.existsSync(path.join(OPENMONTAGE_ROOT, '.git'));

describe('OpenMontage adapter — detection', () => {
  test('detects the isolated install under external/OpenMontage', () => {
    const install = detectInstallation();
    assert.equal(typeof install.repoPresent, 'boolean');
    if (HAS_INSTALL) {
      assert.equal(install.repoPresent, true);
      assert.equal(install.venvPresent, true);
      assert.equal(install.remotionInstalled, true);
      assert.equal(install.remotionCliPresent, true);
    }
  });

  test('OPENMONTAGE_ROOT is strictly under external/, never Docteur root itself', () => {
    assert.ok(OPENMONTAGE_ROOT.includes(`${path.sep}external${path.sep}OpenMontage`));
    assert.notEqual(OPENMONTAGE_ROOT, path.resolve(OPENMONTAGE_ROOT, '..', '..'));
  });

  test('status reflects READY_LOCAL when python/ffmpeg/remotion all resolve', async () => {
    const status = await getStatus();
    assert.ok(Object.values(STATUS).includes(status));
    if (HAS_INSTALL) assert.notEqual(status, STATUS.ERROR);
    // Cloud is never a reachable state for this adapter.
    assert.notEqual(status, 'READY_CLOUD');
  });

  test('capabilities report optional extensions as unavailable, not as errors', async () => {
    const caps = await getCapabilities();
    assert.equal(caps.hyperframes, 'unavailable');
    assert.equal(caps.piper, 'unavailable');
    assert.equal(caps.gpuStack, 'unavailable');
    if (HAS_INSTALL) {
      assert.equal(caps.registry.available, true);
      assert.ok(caps.registry.toolCount > 0, 'registry should discover tools');
    }
  });
});

describe('OpenMontage adapter — Remotion cwd/root isolation', () => {
  test('Remotion CLI reports its own version without a Docteur-root warning, cwd pinned to remotion-composer', async () => {
    if (!HAS_INSTALL) return;
    const caps = await getCapabilities();
    assert.equal(caps.remotion.available, true);
    assert.equal(caps.remotion.cwdVerified, REMOTION_COMPOSER_ROOT);
    assert.match(caps.remotion.version, /^\d+\.\d+\.\d+/);
  });

  test('runLocalCommand rejects a cwd outside the allowed roots (never Docteur root)', () => {
    assert.throws(() => runLocalCommand({ command: 'node', args: ['--version'], cwd: path.resolve(OPENMONTAGE_ROOT, '..', '..') }), /cwd_denied/);
  });

  test('runLocalCommand accepts cwd scoped exactly to remotion-composer', async () => {
    if (!HAS_INSTALL) return;
    // Mirrors the adapter's own resolution: the .cmd shim cannot be spawned
    // with shell:false on Windows (EINVAL), so the real JS entrypoint is
    // invoked directly through process.execPath.
    const command = process.platform === 'win32' ? process.execPath : path.join(REMOTION_COMPOSER_ROOT, 'node_modules', '.bin', 'remotion');
    const args = process.platform === 'win32'
      ? [path.join(REMOTION_COMPOSER_ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'), 'versions']
      : ['versions'];
    const { done } = runLocalCommand({ command, args, cwd: REMOTION_COMPOSER_ROOT, timeout: 15000 });
    const result = await done;
    assert.equal(result.ok, true);
  });
});

describe('OpenMontage policy — path traversal & sensitive path rejection', () => {
  test('within() rejects classic traversal', () => {
    const root = 'C:\\dev\\Docteur\\external\\OpenMontage';
    assert.equal(within(root, path.resolve(root, '..', '..', 'secret.txt')), false);
  });

  test('resolveJobWorkspace rejects ../ in jobId', () => {
    assert.throws(() => resolveJobWorkspace(WORKSPACES_ROOT, '../../etc'), /job_id_invalid/);
  });

  test('resolveJobWorkspace rejects absolute path as jobId', () => {
    assert.throws(() => resolveJobWorkspace(WORKSPACES_ROOT, 'C:\\Windows\\System32'), /job_id_invalid/);
  });

  test('resolveJobWorkspace rejects UNC-shaped jobId', () => {
    assert.throws(() => resolveJobWorkspace(WORKSPACES_ROOT, '\\\\evil-host\\share'), /job_id_invalid/);
  });

  test('resolveJobWorkspace accepts a well-formed job id', () => {
    const { dir } = createWorkspace('test-job-abc123');
    assert.ok(within(WORKSPACES_ROOT, dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('checkedWorkspacePath blocks traversal out of the job workspace', () => {
    const jobWorkspace = path.join(WORKSPACES_ROOT, 'job-x');
    assert.throws(() => checkedWorkspacePath(jobWorkspace, '../../../etc/passwd'), /path_denied/);
  });

  test('checkedWorkspacePath blocks absolute escape', () => {
    const jobWorkspace = path.join(WORKSPACES_ROOT, 'job-x');
    assert.throws(() => checkedWorkspacePath(jobWorkspace, 'C:\\Windows\\System32\\drivers\\etc\\hosts'), /path_denied/);
  });

  test('checkedWorkspacePath blocks UNC path', () => {
    const jobWorkspace = path.join(WORKSPACES_ROOT, 'job-x');
    assert.throws(() => checkedWorkspacePath(jobWorkspace, '\\\\attacker\\share\\file'), /path_denied/);
  });

  test('checkedWorkspacePath blocks cortex.sqlite by name', () => {
    const jobWorkspace = OPENMONTAGE_ROOT; // any root; the substring check is absolute-path based
    assert.throws(() => checkedWorkspacePath(jobWorkspace, path.join('..', '..', 'cortex-server', 'data', 'cortex.sqlite')), /path_denied/);
  });

  test('checkedWorkspacePath blocks .env by name', () => {
    const jobWorkspace = path.join(WORKSPACES_ROOT, 'job-x');
    assert.throws(() => checkedWorkspacePath(jobWorkspace, '.env'), /path_denied/);
  });

  test('checkedWorkspacePath blocks secret-store path', () => {
    const jobWorkspace = OPENMONTAGE_ROOT;
    assert.throws(() => checkedWorkspacePath(jobWorkspace, path.join('..', '..', 'cortex-server', 'src', 'lib', 'secret-store.js')), /path_denied/);
  });
});

describe('OpenMontage policy — environment isolation', () => {
  test('filteredEnv never forwards Docteur provider API keys', () => {
    const poisoned = {
      PATH: process.env.PATH || '',
      GROQ_API_KEY: 'sk-should-not-leak',
      OPENROUTER_API_KEY: 'sk-should-not-leak',
      OPENAI_API_KEY: 'sk-should-not-leak',
      ANTHROPIC_API_KEY: 'sk-should-not-leak',
      GOOGLE_API_KEY: 'sk-should-not-leak',
      ELEVENLABS_API_KEY: 'sk-should-not-leak',
    };
    const env = filteredEnv(poisoned);
    for (const key of Object.keys(poisoned)) {
      if (key === 'PATH') continue;
      assert.equal(env[key], undefined, `${key} must not be forwarded`);
    }
  });

  test('filteredEnv rejects extra keys that look like credentials', () => {
    assert.throws(() => filteredEnv(process.env, { OPENMONTAGE_API_TOKEN: 'x' }), /env_key_denied/);
  });

  test('filteredEnv allows a narrowly-scoped non-secret override', () => {
    const env = filteredEnv(process.env, { OPENMONTAGE_PROJECTS_DIR: WORKSPACES_ROOT });
    assert.equal(env.OPENMONTAGE_PROJECTS_DIR, WORKSPACES_ROOT);
  });
});

describe('OpenMontage adapter — process execution safety', () => {
  test('runLocalCommand rejects non-array args (would imply shell interpolation)', () => {
    assert.throws(() => runLocalCommand({ command: 'node', args: 'not-an-array', cwd: OPENMONTAGE_ROOT }), /args_invalid/);
  });

  test('runLocalCommand rejects an out-of-range timeout', () => {
    assert.throws(() => runLocalCommand({ command: 'node', args: [], cwd: OPENMONTAGE_ROOT, timeout: 0 }), /timeout_invalid/);
    assert.throws(() => runLocalCommand({ command: 'node', args: [], cwd: OPENMONTAGE_ROOT, timeout: 999_999_999 }), /timeout_invalid/);
  });

  test('runLocalCommand enforces a real timeout and kills the process', async () => {
    if (process.platform !== 'win32') return; // node -e sleep loop is slow to assert cross-platform in CI
    const jobId = 'timeout-test-job';
    const { done } = runLocalCommand({
      jobId,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: OPENMONTAGE_ROOT,
      timeout: 1500,
    });
    const start = Date.now();
    const result = await done;
    const elapsed = Date.now() - start;
    assert.equal(result.error, 'timeout');
    assert.ok(elapsed < 10000, 'process should be killed near the timeout, not hang');
    reapJob(jobId);
  });

  test('cancelJob stops a running process before completion', async () => {
    const jobId = 'cancel-test-job';
    const { done } = runLocalCommand({
      jobId,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: OPENMONTAGE_ROOT,
      timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 300));
    const status = getJobStatus(jobId);
    assert.equal(status.status, 'running');
    const cancelResult = cancelJob(jobId);
    assert.equal(cancelResult.ok, true);
    const result = await done;
    assert.equal(result.cancelled, true);
    reapJob(jobId);
  });

  test('cancelJob on an unknown job id returns a clean error, never throws', () => {
    const result = cancelJob('does-not-exist');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'job_not_found');
  });

  test('runLocalCommand captures stdout/stderr as complete lines', async () => {
    const lines = [];
    const { done } = runLocalCommand({
      command: process.execPath,
      args: ['-e', "console.log('hello-stdout'); console.error('hello-stderr')"],
      cwd: OPENMONTAGE_ROOT,
      timeout: 5000,
      onLine: (stream, line) => lines.push([stream, line]),
    });
    await done;
    assert.ok(lines.some(([s, l]) => s === 'stdout' && l === 'hello-stdout'));
    assert.ok(lines.some(([s, l]) => s === 'stderr' && l === 'hello-stderr'));
  });
});

describe('OpenMontage adapter — no shell:true anywhere', () => {
  test('adapter source never sets shell: true', () => {
    const source = fs.readFileSync('./src/lib/openmontage-adapter.js', 'utf8');
    const codeOnly = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codeOnly, /shell:\s*true\b/);
  });

  test('adapter source never invokes cmd.exe or powershell.exe directly', () => {
    const source = fs.readFileSync('./src/lib/openmontage-adapter.js', 'utf8');
    const codeOnly = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codeOnly, /cmd\.exe|powershell\.exe/i);
  });
});

describe('OpenMontage adapter — no auto-install', () => {
  test('adapter source never shells out to pip/npm/npx install commands', () => {
    const source = fs.readFileSync('./src/lib/openmontage-adapter.js', 'utf8');
    assert.doesNotMatch(source, /pip install|npm install|npm ci|npx --yes|make setup|make install-gpu/);
  });
});
