import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { registerJob, finishJob } from '../routes/jobs.js';
import { RUNTIME_ROOT, WORKSPACES_ROOT, SHERLOCK_SHA, LIMITS, checkedPath, childEnvironment, validateUsername, publicUrl, publicRequest, loadSites, verifySource, denied } from './sherlock-policy.js';
export { validateUsername } from './sherlock-policy.js';
const python = path.join(RUNTIME_ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const runner = fileURLToPath(new URL('./sherlock_runner.py', import.meta.url));
export function getInstallState() {
  let ready = false;
  try { verifySource(); ready = fs.existsSync(python) && fs.existsSync(path.join(RUNTIME_ROOT, 'dependency-lock.json')); } catch { /* Fail closed. */ }
  return { status: ready ? 'installed' : 'not_installed', version: ready ? '0.16.2' : null, installedAt: null, lastError: null, pinnedSha: SHERLOCK_SHA };
}
export async function testInstall() { const state = getInstallState(); return { ok: state.status === 'installed', installed: state.status === 'installed', version: state.version }; }
export function startInstall() { throw denied('installation_requires_operator_setup'); }
export function startUninstall() { throw denied('uninstall_requires_operator_action'); }

export function createSherlockGateway({ network = publicRequest, limits = LIMITS, clock = Date.now, spawnProcess = spawn } = {}) {
  const jobs = new Map(), starts = [];
  let active = null;
  function getJob(id) {
    const job = jobs.get(id); if (!job) return null;
    return { id: job.id, operation: 'Recherche de pseudonyme', username: job.username, status: job.status, startedAt: job.startedAt,
      duration: (job.finishedAt || clock()) - job.startedAt, current: job.results.length, total: job.siteCount,
      summary: { results: job.results, error: job.error || null, found: job.results.filter(r => r.status === 'found').length, absent: job.results.filter(r => r.status === 'absent').length, errors: job.results.filter(r => r.status === 'error').length } };
  }
  function stop(job, reason) {
    if (job.status !== 'running' || job.stopReason) return;
    job.stopReason = reason; job.controller.abort();
    if (job.child.pid) {
      if (process.platform === 'win32') {
        const kill = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(job.child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: childEnvironment(job.workspace) });
        kill.once('error', () => job.child.kill('SIGKILL'));
      } else job.child.kill('SIGKILL');
    }
  }
  function searchUsername({ username, timeoutMs = limits.timeoutMs, siteFilter } = {}) {
    const name = validateUsername(username);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > limits.timeoutMs) throw denied('timeout_invalid');
    if (active) throw denied('search_concurrency_limit');
    while (starts.length && starts[0] <= clock() - limits.rateWindowMs) starts.shift();
    if (starts.length >= limits.rateCount) throw denied('search_rate_limited');
    if (getInstallState().status !== 'installed') throw denied('sherlock_not_installed');
    const sites = loadSites(siteFilter), urls = new Map(), probes = new Set();
    for (const [site, data] of Object.entries(sites)) {
      urls.set(site, publicUrl(data.url.replaceAll('{}', encodeURIComponent(name))).href);
      probes.add(publicUrl((data.urlProbe || data.url).replaceAll('{}', name)).href);
    }
    const id = randomUUID(), workspace = checkedPath(WORKSPACES_ROOT, id);
    fs.mkdirSync(workspace, { recursive: true });
    const env = childEnvironment(workspace);
    const job = { id, username: name, workspace, status: 'running', startedAt: clock(), results: [], siteCount: urls.size, controller: new AbortController(), stopReason: null, received: false, bytes: 0 };
    const child = job.child = spawnProcess(python, ['-I', '-B', runner, workspace], { cwd: workspace, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    jobs.set(id, job); active = id; starts.push(clock());
    if (jobs.size > 100) for (const [key, old] of jobs) { if (old.status !== 'running') { jobs.delete(key); break; } }
    registerJob(id, 'Recherche de pseudonyme', job.siteCount);
    const timer = setTimeout(() => stop(job, 'timeout'), timeoutMs);
    let buffer = '', queue = Promise.resolve(), requests = 0;
    const decoder = new StringDecoder('utf8');
    const seen = new Set();
    const settle = code => {
      if (job.status !== 'running') return;
      clearTimeout(timer); job.controller.abort(); job.finishedAt = clock(); active = null;
      job.status = job.stopReason === 'cancelled' ? 'cancelled' : job.stopReason || code !== 0 || !job.received ? 'error' : 'done';
      job.error = job.stopReason || (job.status === 'error' ? 'sherlock_runner_failed' : null);
      finishJob(id, job.status, getJob(id).summary);
    };
    const reply = data => { if (!child.stdin.destroyed && job.status === 'running') child.stdin.write(JSON.stringify(data) + '\n'); };
    async function line(raw) {
      if (job.stopReason || job.status !== 'running') return;
      let message; try { message = JSON.parse(raw); } catch { stop(job, 'invalid_runner_output'); return; }
      if (message.kind === 'http') {
        if (++requests > job.siteCount || typeof message.id !== 'number' || !['GET', 'HEAD'].includes(message.method)) { stop(job, 'request_limit'); return; }
        try {
          const url = publicUrl(message.url).href;
          if (!probes.has(url) || seen.has(url)) throw denied('request_not_in_site_database');
          seen.add(url);
          if (requests > 1) await new Promise(resolve => { const t = setTimeout(resolve, limits.intervalMs); job.controller.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
          const response = await network(url, { method: message.method, redirects: message.redirects === true, signal: job.controller.signal });
          reply({ id: message.id, ok: true, response });
        } catch { reply({ id: message.id, ok: false, error: 'network_request_denied_or_failed' }); }
      } else if (message.kind === 'result') {
        if (job.received || !Array.isArray(message.results) || message.results.length !== job.siteCount) { stop(job, 'invalid_runner_output'); return; }
        const names = new Set();
        for (const result of message.results) {
          if (!urls.has(result.site) || names.has(result.site) || !['found', 'absent', 'invalid', 'error'].includes(result.status)) { stop(job, 'invalid_runner_output'); return; }
          names.add(result.site);
          job.results.push({ site: result.site, username: name, profileUrl: urls.get(result.site), url: urls.get(result.site), status: result.status,
            responseTime: Number.isFinite(result.responseTime) && result.responseTime >= 0 ? result.responseTime : null, metadata: { source: 'sherlock', untrusted: true, pinnedSha: SHERLOCK_SHA } });
        }
        job.received = true;
      } else stop(job, 'sherlock_runner_failed');
    }
    child.stdout.on('data', data => {
      job.bytes += data.length;
      if (job.bytes > limits.outputBytes) { stop(job, 'output_limit'); return; }
      buffer += decoder.write(data); let end;
      while ((end = buffer.indexOf('\n')) >= 0) { const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1); queue = queue.then(() => line(raw)).catch(() => stop(job, 'invalid_runner_output')); }
    });
    child.stderr.on('data', data => { job.bytes += data.length; if (job.bytes > limits.outputBytes) stop(job, 'output_limit'); });
    child.stdin.on('error', () => {});
    child.once('error', () => settle(1));
    child.once('close', code => settle(code));
    child.stdin.write(JSON.stringify({ username: name, sites: Object.keys(sites) }) + '\n');
    return { jobId: id, username: name };
  }
  return { searchUsername, getJob, cancelSearch(id) { const job = jobs.get(id); if (!job || job.status !== 'running') return { cancelled: false }; stop(job, 'cancelled'); return { cancelled: true }; }, shutdown() {
    if (!active) return Promise.resolve();
    const job = jobs.get(active);
    const closed = new Promise(resolve => job.child.once('close', resolve));
    stop(job, 'cancelled'); return closed;
  } };
}
const gateway = createSherlockGateway();
export const searchUsername = options => gateway.searchUsername(options);
export const startSearch = (username, { timeoutSeconds, ...options } = {}) => searchUsername({ username, ...options, ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }) });
export const cancelSearch = id => gateway.cancelSearch(id);
export const getSherlockJob = id => gateway.getJob(id);
export const shutdownSherlock = () => gateway.shutdown();
export function parseSherlockOutput(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > LIMITS.outputBytes) throw denied('output_limit');
  return stdout.split('\n').flatMap(line => { const m = /^\[\+\]\s*([^:]{1,100}):\s*(\S+)\s*$/.exec(line); if (!m) return []; try { return [{ site: m[1], url: publicUrl(m[2]).href, status: 'found' }]; } catch { return []; } }).slice(0, LIMITS.sites);
}
