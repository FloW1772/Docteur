// PHASE 7 — Sherlock OSINT integration (MASTER mission). Certifies:
// shell:false everywhere, input validation (injection resistance), no
// auto-install, install/search lifecycle via the shared job registry, and
// graceful handling when sherlock/pipx are not installed (the actual state
// of this test environment — no mocking needed for those paths, they
// exercise the real ENOENT behavior of spawn()).
// Run: node --test test-phase7-sherlock.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';

import { initSqlite, setMeta } from './src/lib/sqlite.js';
import {
  getInstallState, validateUsername, parseSherlockOutput,
  testInstall, startInstall, startUninstall, startSearch, cancelSearch,
} from './src/lib/sherlock.js';
import { getJob } from './src/routes/jobs.js';
import { createSherlockRoute } from './src/routes/sherlock.js';

const TEST_DB = './data-test-sherlock/test.db';

before(() => {
  fs.rmSync('./data-test-sherlock', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

after(() => {
  try { fs.rmSync('./data-test-sherlock', { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  // Reset persisted install state between tests — startInstall/startUninstall
  // write real state via setMeta(), and tests must not leak into each other.
  setMeta('sherlock_install', { status: 'not_installed', version: null, installedAt: null, lastError: null });
});

function buildApp(services = {}) {
  const app = new Hono();
  app.route('/api', createSherlockRoute({ services, logger: { info() {}, warn() {} } }));
  return app;
}

async function waitForJob(jobId, { timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(jobId);
    if (job && job.status !== 'running') return job;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

// ── Username validation — injection resistance ──────────────────────────

test('validateUsername: accepts plausible usernames', () => {
  assert.equal(validateUsername('john_doe'), 'john_doe');
  assert.equal(validateUsername('user.name-123'), 'user.name-123');
  assert.equal(validateUsername('  spaced  '), 'spaced');
});

test('validateUsername: rejects shell metacharacters, spaces, and command-injection attempts', () => {
  for (const bad of [
    'user; rm -rf /',
    'user && whoami',
    'user`whoami`',
    'user$(whoami)',
    'user | cat /etc/passwd',
    'user"quote',
    "user'quote",
    'user with spaces',
    '../../../etc/passwd',
    '',
    'x'.repeat(65),
  ]) {
    assert.throws(() => validateUsername(bad), /invalide/, `must reject: ${bad}`);
  }
});

// ── Output parsing — never fabricates a result ──────────────────────────

test('parseSherlockOutput: extracts only [+] found lines, ignores [-] not-found and noise', () => {
  const stdout = [
    '[*] Checking username john on:',
    '[+] GitHub: https://github.com/john',
    '[-] Twitter: Not Found!',
    '[+] Reddit: https://reddit.com/user/john',
    'Some unrelated log line',
  ].join('\n');
  const results = parseSherlockOutput(stdout);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { site: 'GitHub', url: 'https://github.com/john', status: 'found' });
  assert.deepEqual(results[1], { site: 'Reddit', url: 'https://reddit.com/user/john', status: 'found' });
});

test('parseSherlockOutput: empty/garbage stdout produces zero results, never a fabricated hit', () => {
  assert.deepEqual(parseSherlockOutput(''), []);
  assert.deepEqual(parseSherlockOutput('random garbage\nno matches here'), []);
});

// ── Install lifecycle — never automatic, always via explicit job ────────

test('getInstallState defaults to not_installed', () => {
  const state = getInstallState();
  assert.equal(state.status, 'not_installed');
});

test('testInstall: correctly reports not installed when sherlock is absent (real ENOENT path, no mocking)', async () => {
  const result = await testInstall();
  assert.equal(result.installed, false);
  assert.equal(getInstallState().status, 'not_installed');
});

test('startInstall: registers a job and completes with a clear pipx-not-found error when pipx is absent (real environment state)', async () => {
  const { jobId } = startInstall();
  assert.ok(jobId);
  const job = await waitForJob(jobId);
  assert.equal(job.status, 'error');
  assert.ok(job.summary?.error, 'a clear error message must be present, not a silent failure');
});

test('startUninstall: registers a job and handles pipx absence gracefully', async () => {
  const { jobId } = startUninstall();
  const job = await waitForJob(jobId);
  assert.ok(['error', 'done'].includes(job.status));
});

// ── Search — shell:false, validation, concurrency limit ──────────────────

test('startSearch: rejects an invalid username BEFORE ever spawning a process', () => {
  assert.throws(() => startSearch('bad username; rm -rf /'), /invalide/);
});

test('startSearch: registers a job and reports sherlock-not-installed clearly (real ENOENT path)', async () => {
  const { jobId, username } = startSearch('__PHASE7_TEST_USERNAME__');
  assert.equal(username, '__PHASE7_TEST_USERNAME__');
  const job = await waitForJob(jobId);
  assert.equal(job.status, 'error');
  assert.match(job.summary.error, /n'est pas installé/);
});

test('cancelSearch: cancelling an unknown/already-finished job id returns cancelled:false, never throws', () => {
  const result = cancelSearch('nonexistent-job-id-xyz');
  assert.equal(result.cancelled, false);
});

// ── Route integration ────────────────────────────────────────────────────

test('GET /api/sherlock/status returns the real install state', async () => {
  const app = buildApp();
  const res = await app.request('/api/sherlock/status');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'not_installed');
});

test('POST /api/sherlock/search rejects an invalid username with 400, never spawns', async () => {
  const app = buildApp();
  const res = await app.request('/api/sherlock/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bad; whoami' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/sherlock/search with a valid username returns 202 + jobId, job eventually reports not-installed', async () => {
  const app = buildApp();
  const res = await app.request('/api/sherlock/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test_user_phase7' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.ok(body.jobId);
  const job = await waitForJob(body.jobId);
  assert.equal(job.status, 'error');
});

test('GET /api/sherlock/search/:jobId returns 404 for an unknown job', async () => {
  const app = buildApp();
  const res = await app.request('/api/sherlock/search/does-not-exist');
  assert.equal(res.status, 404);
});

// ── save-as-neuron — always private/local_only by default ──────────────

test('POST /api/sherlock/save-as-neuron creates a neuron tagged private + local_only, never cloud-eligible by default', async () => {
  const indexed = [];
  const savedPages = [];
  const services = {
    indexNeuron: async (payload) => { indexed.push(payload); return { ok: true }; },
  };
  // savePageToStore is imported directly from sqlite.js inside routes/sherlock.js,
  // not injected — verify via the real (isolated test) DB instead.
  const app = buildApp(services);
  const res = await app.request('/api/sherlock/save-as-neuron', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_user', site: 'GitHub', url: 'https://github.com/test_user' }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].metadata.egress_policy, 'local_only');
  assert.equal(indexed[0].metadata.source, 'osint_sherlock');

  const { getPageFromStore } = await import('./src/lib/sqlite.js');
  const page = getPageFromStore(body.id);
  assert.equal(page.private, true, 'OSINT-derived neurons must be private by default');
});

test('POST /api/sherlock/save-as-neuron requires username, site, and url', async () => {
  const app = buildApp({ indexNeuron: async () => ({ ok: true }) });
  const res = await app.request('/api/sherlock/save-as-neuron', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x' }),
  });
  assert.equal(res.status, 400);
});

// ── Static security checks ───────────────────────────────────────────────

test('static check: every actual spawn()/execFile() call line in lib/sherlock.js explicitly sets shell:false, and none sets shell:true', () => {
  const source = fs.readFileSync('./src/lib/sherlock.js', 'utf8');
  // Line-based check (every real call in this file is single-line) — avoids
  // matching prose in comments that happen to mention "shell:true" while
  // explaining why it must never be used.
  const callLines = source.split('\n').filter(line => /^\s*(const \w+ = )?(spawn|execFile)\(/.test(line));
  assert.ok(callLines.length >= 3, `expected to find at least 3 spawn/execFile call lines, found ${callLines.length}`);
  for (const line of callLines) {
    assert.ok(!/shell:\s*true/.test(line), `no spawn/execFile call may set shell:true: ${line.trim()}`);
    assert.ok(/shell:\s*false/.test(line), `every spawn/execFile call must set shell:false explicitly: ${line.trim()}`);
  }
});
