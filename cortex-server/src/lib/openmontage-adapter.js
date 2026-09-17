import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { resolveJobWorkspace, checkedWorkspacePath, filteredEnv, policyError } from './openmontage-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORTEX_ROOT = path.resolve(__dirname, '../..');
const DOCTEUR_ROOT = path.resolve(CORTEX_ROOT, '..');

// OpenMontage lives entirely under external/ — never inside the Docteur
// source tree proper. This adapter only ever reads/spawns within this
// subtree (plus the isolated job workspaces below).
export const OPENMONTAGE_ROOT = path.join(DOCTEUR_ROOT, 'external', 'OpenMontage');
export const REMOTION_COMPOSER_ROOT = path.join(OPENMONTAGE_ROOT, 'remotion-composer');
export const OPENMONTAGE_VENV = path.join(OPENMONTAGE_ROOT, '.venv');
export const WORKSPACES_ROOT = path.join(CORTEX_ROOT, 'data', 'openmontage-workspaces');

export const STATUS = Object.freeze({
  NOT_INSTALLED: 'NOT_INSTALLED',
  PARTIAL: 'PARTIAL',
  READY_LOCAL: 'READY_LOCAL',
  BUSY: 'BUSY',
  ERROR: 'ERROR',
});

function venvPythonPath() {
  return process.platform === 'win32'
    ? path.join(OPENMONTAGE_VENV, 'Scripts', 'python.exe')
    : path.join(OPENMONTAGE_VENV, 'bin', 'python');
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Resolve the local Remotion CLI directly — never via `npx`, which
// re-derives its own cwd/project-root heuristics (this is what produced the
// "root directory is C:\dev\Docteur" warning when invoked carelessly).
//
// On Windows, node_modules/.bin/remotion.cmd is a batch-file shim that
// requires cmd.exe to interpret (spawn() with shell:false throws EINVAL on
// a .cmd target — Node cannot exec a batch script as a native binary). The
// shim itself simply forwards to the real JS entrypoint below, so we call
// that entrypoint directly through process.execPath, which needs no shell
// and cannot be redirected by PATH/PATHEXT tricks.
function remotionCliPath() {
  if (process.platform === 'win32') {
    return path.join(REMOTION_COMPOSER_ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
  }
  return path.join(REMOTION_COMPOSER_ROOT, 'node_modules', '.bin', 'remotion');
}

function remotionInvocation() {
  const target = remotionCliPath();
  return process.platform === 'win32'
    ? { command: process.execPath, prefixArgs: [target] }
    : { command: target, prefixArgs: [] };
}

function run(command, args, { cwd, env, timeout = 15000 }) {
  return new Promise(resolve => {
    let out = '', err = '', settled = false;
    let child;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, code: null, stdout: out, stderr: err, timedOut: true });
    }, timeout);
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.once('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: out, stderr: String(e), timedOut: false });
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err, timedOut: false });
    });
  });
}

// ---------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------

export function detectInstallation() {
  const repoPresent = dirExists(OPENMONTAGE_ROOT) && dirExists(path.join(OPENMONTAGE_ROOT, '.git'));
  const venvPresent = fileExists(venvPythonPath());
  const remotionInstalled = dirExists(path.join(REMOTION_COMPOSER_ROOT, 'node_modules', 'remotion'));
  const remotionCliPresent = fileExists(remotionCliPath());
  return { repoPresent, venvPresent, remotionInstalled, remotionCliPresent };
}

async function detectFfmpeg(env) {
  const result = await run('ffmpeg', ['-version'], { cwd: DOCTEUR_ROOT, env, timeout: 5000 });
  return result.ok;
}

async function detectPython(env) {
  if (!fileExists(venvPythonPath())) return { available: false, version: null };
  const result = await run(venvPythonPath(), ['--version'], { cwd: OPENMONTAGE_ROOT, env, timeout: 5000 });
  return { available: result.ok, version: result.ok ? (result.stdout || result.stderr).trim() : null };
}

async function detectRemotion(env) {
  const cli = remotionCliPath();
  if (!fileExists(cli)) return { available: false, version: null, cwdVerified: false };
  const { command, prefixArgs } = remotionInvocation();
  // `versions` is the real subcommand (confirmed against the CLI's own
  // command list); `--version` is accepted by the npx/.cmd shim but is NOT
  // a recognized flag of the underlying remotion-cli.js entrypoint we call
  // directly — passing it falls through to the help text and exit code 1.
  //
  // cwd is pinned to remotion-composer/ exactly — never a parent directory —
  // which is what keeps Remotion's own root-detection from wandering up
  // into the Docteur repo root.
  const result = await run(command, [...prefixArgs, 'versions'], { cwd: REMOTION_COMPOSER_ROOT, env, timeout: 15000 });
  const text = (result.stdout || '').trim();
  const match = text.match(/On version:\s*(\S+)/);
  return {
    available: result.ok && Boolean(match),
    version: match ? match[1] : null,
    cwdVerified: REMOTION_COMPOSER_ROOT,
  };
}

async function detectToolRegistry(env) {
  if (!fileExists(venvPythonPath())) return { available: false, toolCount: 0 };
  const script = [
    'import sys, json',
    "sys.path.insert(0, '.')",
    'from tools.tool_registry import ToolRegistry',
    'registry = ToolRegistry()',
    'registry.discover()',
    "print(json.dumps({'count': len(getattr(registry, '_tools', {}))}))",
  ].join('\n');
  const result = await run(venvPythonPath(), ['-c', script], { cwd: OPENMONTAGE_ROOT, env, timeout: 30000 });
  if (!result.ok) return { available: false, toolCount: 0 };
  try {
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    return { available: true, toolCount: parsed.count };
  } catch {
    return { available: false, toolCount: 0 };
  }
}

// ---------------------------------------------------------------------
// Status / capabilities
// ---------------------------------------------------------------------

const runtime = { jobs: new Map() }; // jobId -> { controller, child, status }

export async function getStatus() {
  if (runtime.jobs.size > 0) {
    for (const job of runtime.jobs.values()) if (job.status === 'running') return STATUS.BUSY;
  }
  const install = detectInstallation();
  if (!install.repoPresent) return STATUS.NOT_INSTALLED;
  const env = filteredEnv();
  const [ffmpegOk, python, remotion] = await Promise.all([
    detectFfmpeg(env),
    detectPython(env),
    detectRemotion(env),
  ]);
  if (python.available && remotion.available && ffmpegOk) return STATUS.READY_LOCAL;
  if (install.venvPresent || install.remotionInstalled) return STATUS.PARTIAL;
  return STATUS.NOT_INSTALLED;
}

export async function getCapabilities() {
  const install = detectInstallation();
  if (!install.repoPresent) {
    return {
      status: STATUS.NOT_INSTALLED,
      python: { available: false },
      ffmpeg: { available: false },
      remotion: { available: false },
      registry: { available: false, toolCount: 0 },
      hyperframes: 'unavailable',
      piper: 'unavailable',
      gpuStack: 'unavailable',
    };
  }
  const env = filteredEnv();
  const [ffmpegOk, python, remotion, registry] = await Promise.all([
    detectFfmpeg(env),
    detectPython(env),
    detectRemotion(env),
    detectToolRegistry(env),
  ]);
  const status = python.available && remotion.available && ffmpegOk ? STATUS.READY_LOCAL : STATUS.PARTIAL;
  return {
    status,
    python,
    ffmpeg: { available: ffmpegOk },
    remotion,
    registry,
    // These are deliberately-optional extensions, not failures — never
    // surfaced as an error state. See OM-2D/2E decisions.
    hyperframes: 'unavailable',
    piper: 'unavailable',
    gpuStack: 'unavailable',
  };
}

// ---------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------

export function createWorkspace(jobId = crypto.randomUUID()) {
  const dir = resolveJobWorkspace(WORKSPACES_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return { jobId, dir };
}

// Minimal local render: invokes the already-installed Remotion CLI against
// one of remotion-composer's own built-in compositions (HeroTitle — plain
// text, no external asset, no network, no cloud provider). Output is forced
// into the job's own workspace; any attempt to point outside it is rejected
// by checkedWorkspacePath before the process is ever spawned. This does NOT
// go through OpenMontage's Python edit_decisions/asset_manifest pipeline —
// it is a direct, minimal proof that Docteur can drive a real Remotion
// render through this adapter.
export function startRender({ jobId, workspaceDir, outputRelativePath, title, subtitle, durationInFrames = 180, fps = 30, timeout = 300000, onLine = () => {} }) {
  const outputPath = checkedWorkspacePath(workspaceDir, outputRelativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const entryPoint = path.join(REMOTION_COMPOSER_ROOT, 'src', 'index.tsx');
  const { command, prefixArgs } = remotionInvocation();
  const propsJson = JSON.stringify({ title, subtitle });

  const args = [
    ...prefixArgs,
    'render',
    entryPoint,
    'HeroTitle',
    outputPath,
    `--props=${propsJson}`,
    `--frames=0-${durationInFrames - 1}`,
  ];

  const handle = runLocalCommand({
    jobId,
    command,
    args,
    cwd: REMOTION_COMPOSER_ROOT,
    timeout,
    onLine,
  });
  return { ...handle, outputPath };
}

// ---------------------------------------------------------------------
// Process execution — spawn/execFile only, never shell:true.
// ---------------------------------------------------------------------

// Complete-line stdout/stderr sink with an overall byte cap, mirroring the
// external-agent-process.js convention so output can't grow unbounded.
function lineSink(emit, maxBytes = 1_000_000) {
  const decoder = new StringDecoder('utf8');
  let pending = '', total = 0, truncated = false;
  function consume(text) {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const end = part.endsWith('\n');
      if (!truncated) {
        pending += part;
        total += part.length;
        if (total > maxBytes) { truncated = true; emit('[OUTPUT TRUNCATED: size limit reached]'); }
      }
      if (end) {
        if (!truncated) emit(pending.trimEnd());
        pending = '';
      }
    }
  }
  return {
    write: chunk => consume(decoder.write(chunk)),
    end() { consume(decoder.end()); if (pending && !truncated) emit(pending); pending = ''; },
  };
}

// Runs a command strictly scoped to a job workspace (or the OpenMontage
// root itself for read-only introspection). No shell:true anywhere; args
// are always passed as an array. Enforces a hard timeout and exposes
// cancellation via AbortController semantics.
export function runLocalCommand({ jobId, command, args = [], cwd, timeout = 300000, onLine = () => {}, envExtra = {} }) {
  if (typeof command !== 'string' || command.length === 0) throw policyError('command_invalid');
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw policyError('args_invalid');
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 1800000) throw policyError('timeout_invalid');

  const workingDir = cwd || OPENMONTAGE_ROOT;
  // Every invocation must be scoped under either the OpenMontage repo root
  // (read-only introspection: doctor/--version/--help) or the caller's own
  // job workspace. Never Docteur root, never an arbitrary path.
  const allowedRoots = [OPENMONTAGE_ROOT, REMOTION_COMPOSER_ROOT, WORKSPACES_ROOT];
  const resolved = path.resolve(workingDir);
  const isAllowed = allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
  if (!isAllowed) throw policyError('cwd_denied');

  const env = filteredEnv(process.env, envExtra);
  const out = lineSink(line => onLine('stdout', line));
  const err = lineSink(line => onLine('stderr', line));

  let child, settled = false, stopReason = null;
  const done = new Promise(resolve => {
    try {
      child = spawn(command, args, { cwd: resolved, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: null, error: String(e), cancelled: false });
      return;
    }
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.stdout.on('data', d => out.write(d));
    child.stderr.on('data', d => err.write(d));
    child.once('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.end(); err.end();
      resolve({ ok: false, code: null, error: String(e), cancelled: stopReason === 'cancelled' });
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.end(); err.end();
      resolve({ ok: code === 0, code, error: stopReason, cancelled: stopReason === 'cancelled' });
    });
    function stop(reason) {
      if (settled || stopReason) return;
      stopReason = reason;
      if (process.platform === 'win32') {
        try {
          const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
          spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        } catch { try { child.kill(); } catch {} }
      } else {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      }
    }
    if (jobId) runtime.jobs.set(jobId, { child, status: 'running', stop, startedAt: Date.now() });
  });
  return { pid: () => child?.pid, done };
}

export function cancelJob(jobId) {
  const job = runtime.jobs.get(jobId);
  if (!job) return { ok: false, error: 'job_not_found' };
  job.status = 'cancelling';
  job.stop('cancelled');
  return { ok: true };
}

export function getJobStatus(jobId) {
  const job = runtime.jobs.get(jobId);
  if (!job) return { status: 'not_found' };
  return { status: job.status, pid: job.child?.pid, startedAt: job.startedAt };
}

// Called by the process's close/error handler owner once done() resolves,
// so completed/cancelled jobs don't leak in the runtime map forever.
export function reapJob(jobId) {
  runtime.jobs.delete(jobId);
}
