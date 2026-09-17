// Sherlock OSINT integration (Phase 7, MASTER mission) — local, optional
// username-existence checker, wired to the official upstream project:
// https://github.com/sherlock-project/sherlock (MIT license, PyPI package
// `sherlock-project`). Verified before integration: Sherlock performs only
// unauthenticated HTTP GET/HEAD requests per target site to check whether a
// username's profile page exists — no login, no password, no cookie theft,
// no account takeover of any kind.
//
// SECURITY (mission requirements, all enforced here):
//   - shell:false everywhere — every spawn/execFile call in this file passes
//     shell:false explicitly. No string is ever built into a shell command
//     line; every argument reaches the child process as its own argv entry.
//   - Never auto-installed. install()/uninstall()/testInstall() only ever
//     run in response to an explicit POST from routes/sherlock.js, itself
//     only reachable from a user clicking a button in Settings — nothing in
//     this file runs at server startup or on a timer.
//   - Public username search only. No cookie/session parameter exists
//     anywhere in this module's API surface, by design — there is nothing
//     here to plumb one through even if a caller tried.
//   - Timeout + cancel + concurrency limit enforced by THIS wrapper — the
//     upstream sherlock CLI has no built-in global rate limiter (verified:
//     only a per-request --timeout flag), so politeness/limits are this
//     module's responsibility, not something to assume Sherlock provides.

import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getMeta, setMeta } from './sqlite.js';
import { registerJob, updateJob, finishJob } from '../routes/jobs.js';

const META_KEY = 'sherlock_install';
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_TIMEOUT_S = 15; // Sherlock's own --timeout, per request
const MAX_SEARCH_WALL_CLOCK_MS = 120_000; // hard ceiling on one search job
const MAX_CONCURRENT_SEARCHES = 1; // never run two Sherlock invocations at once

const INSTALL_DEFAULTS = {
  status: 'not_installed', // 'not_installed' | 'installed' | 'error'
  version: null,
  installedAt: null,
  lastError: null,
};

// Username-only — deliberately excludes spaces, path separators, and shell
// metacharacters, independent of the shell:false guarantee (defense in
// depth): a Sherlock invocation should only ever carry a plausible username.
const USERNAME_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

export function getInstallState() {
  return { ...INSTALL_DEFAULTS, ...getMeta(META_KEY, {}) };
}

function setInstallState(updates) {
  const current = getInstallState();
  const next = { ...current, ...updates };
  setMeta(META_KEY, next);
  return next;
}

export function validateUsername(username) {
  const u = String(username ?? '').trim();
  if (!USERNAME_RE.test(u)) {
    throw new Error('Nom d\'utilisateur invalide — lettres, chiffres, "_", "." et "-" uniquement (1 à 64 caractères).');
  }
  return u;
}

// Resolves the sherlock executable via PATH lookup only — never a
// caller-supplied path, never shell:true. execFile with a bare command name
// (no path separators) lets Node/Windows resolve PATHEXT (.exe/.cmd/.bat)
// safely without invoking a shell.
function probeSherlockVersion() {
  return new Promise((resolve) => {
    execFile('sherlock', ['--version'], { timeout: PROBE_TIMEOUT_MS, shell: false }, (error, stdout, stderr) => {
      if (error) { resolve(null); return; }
      const output = `${stdout}${stderr}`.trim();
      resolve(output || 'unknown');
    });
  });
}

export async function testInstall() {
  const version = await probeSherlockVersion();
  if (!version) {
    setInstallState({ status: 'not_installed', version: null, lastError: null });
    return { ok: false, installed: false };
  }
  setInstallState({ status: 'installed', version, lastError: null });
  return { ok: true, installed: true, version };
}

// Installs the official PyPI package via pipx — never bundled, never
// auto-triggered. pipx is itself expected to be present (documented
// prerequisite, same posture as requiring Python for other optional
// integrations) — this function does not attempt to install pipx itself,
// it reports a clear error if pipx is missing rather than reaching for a
// riskier fallback (e.g. system-wide pip install).
export function startInstall() {
  const jobId = randomUUID();
  registerJob(jobId, 'Installation Sherlock OSINT', 1);

  const child = spawn('pipx', ['install', 'sherlock-project'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  child.on('error', (err) => {
    setInstallState({ status: 'error', lastError: err.code === 'ENOENT' ? 'pipx introuvable — installe pipx au préalable (python -m pip install --user pipx).' : err.message });
    finishJob(jobId, 'error', { error: err.message });
  });

  child.on('exit', async (code) => {
    if (code === 0) {
      const result = await testInstall();
      finishJob(jobId, 'done', { installed: result.installed, version: result.version });
    } else {
      const errorText = stderr.trim() || stdout.trim() || `pipx a échoué (code ${code})`;
      setInstallState({ status: 'error', lastError: errorText });
      finishJob(jobId, 'error', { error: errorText });
    }
  });

  return { jobId };
}

export function startUninstall() {
  const jobId = randomUUID();
  registerJob(jobId, 'Désinstallation Sherlock OSINT', 1);

  const child = spawn('pipx', ['uninstall', 'sherlock-project'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  child.on('error', (err) => {
    finishJob(jobId, 'error', { error: err.message });
  });

  child.on('exit', (code) => {
    setInstallState({ status: 'not_installed', version: null, lastError: null });
    finishJob(jobId, code === 0 ? 'done' : 'error', code === 0 ? { uninstalled: true } : { error: stderr.trim() });
  });

  return { jobId };
}

// ── Search ───────────────────────────────────────────────────────────────

let activeSearchCount = 0;
const activeChildren = new Map(); // jobId -> ChildProcess, for cancel()

// Parses Sherlock's plain-text stdout (no native JSON export — verified
// upstream: --json loads an alternate site-definition file, it is not a
// results format). Sherlock's --print-found output is one line per hit:
// "[+] SiteName: https://site.example/username"
export function parseSherlockOutput(stdout) {
  const results = [];
  const lineRe = /^\[\+\]\s*([^:]+):\s*(\S+)\s*$/;
  for (const line of stdout.split('\n')) {
    const match = lineRe.exec(line.trim());
    if (match) results.push({ site: match[1].trim(), url: match[2].trim(), status: 'found' });
  }
  return results;
}

export function startSearch(username, { timeoutSeconds = DEFAULT_SEARCH_TIMEOUT_S } = {}) {
  const safeUsername = validateUsername(username);
  if (activeSearchCount >= MAX_CONCURRENT_SEARCHES) {
    throw new Error('Une recherche Sherlock est déjà en cours — attends qu\'elle se termine avant d\'en lancer une nouvelle.');
  }

  const jobId = randomUUID();
  registerJob(jobId, `Recherche OSINT : ${safeUsername}`, 1);
  activeSearchCount++;

  // Every argument is its own argv entry — shell:false, no string
  // concatenation. safeUsername already passed validateUsername() above.
  const args = [safeUsername, '--print-found', '--timeout', String(Math.max(1, Math.min(60, Number(timeoutSeconds) || DEFAULT_SEARCH_TIMEOUT_S)))];
  const child = spawn('sherlock', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChildren.set(jobId, child);

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const wallClockTimer = setTimeout(() => {
    if (activeChildren.has(jobId)) child.kill();
  }, MAX_SEARCH_WALL_CLOCK_MS);

  child.on('error', (err) => {
    clearTimeout(wallClockTimer);
    activeChildren.delete(jobId);
    activeSearchCount--;
    const message = err.code === 'ENOENT' ? 'Sherlock n\'est pas installé — installe-le depuis Paramètres → Sherlock OSINT.' : err.message;
    finishJob(jobId, 'error', { error: message });
  });

  child.on('exit', (code, signal) => {
    clearTimeout(wallClockTimer);
    activeChildren.delete(jobId);
    activeSearchCount--;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      finishJob(jobId, 'cancelled', { results: parseSherlockOutput(stdout) });
      return;
    }
    // Sherlock's own exit code is not a reliable found/not-found signal
    // (verified: it reflects internal errors, not per-site results) — the
    // real signal is the parsed stdout, always attempted regardless of code.
    const results = parseSherlockOutput(stdout);
    finishJob(jobId, 'done', { results, exitCode: code, stderrTail: code !== 0 ? stderr.slice(-500) : null });
  });

  return { jobId, username: safeUsername };
}

export function cancelSearch(jobId) {
  const child = activeChildren.get(jobId);
  if (!child) return { cancelled: false, reason: 'not_found_or_already_finished' };
  child.kill();
  return { cancelled: true };
}
