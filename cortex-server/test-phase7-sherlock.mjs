// SH-15 supersedes Phase 7's assumptions that pipx/Sherlock are absent.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Hono } from 'hono';
import { createSherlockGateway, getInstallState, startInstall, startUninstall, parseSherlockOutput } from './src/lib/sherlock.js';
import { createSherlockRoute } from './src/routes/sherlock.js';
import { validateSite } from './src/lib/sherlock-policy.js';
import { validateUsername, publicAddress, publicUrl, resolvePublic, publicRequest, checkedPath, childEnvironment, WORKSPACES_ROOT, LIMITS, loadSites } from './src/lib/sherlock-policy.js';

const owned = [];
test('compromised site database entry cannot target private networks or file URLs', () => {
  for (const url of ['http://127.0.0.1/{}', 'http://192.168.1.2/{}', 'http://169.254.169.254/{}', 'file:///C:/{}']) {
    assert.throws(() => validateSite({ url }));
    assert.throws(() => validateSite({ url: 'https://example.com/{}', urlProbe: url }));
  }
});
test('cancel also releases a pending DNS operation without any connection', async () => {
  const controller = new AbortController(); let connects = 0;
  const pending = publicRequest('https://example.com', { signal: controller.signal, lookup: () => new Promise(() => {}), transport: () => { connects++; } });
  controller.abort(); await assert.rejects(pending, /request_cancelled/); assert.equal(connects, 0);
});
const success = async url => ({ status: 200, url, body: Buffer.from('public fixture').toString('base64') });
async function wait(gateway, id) {
  for (let i = 0; i < 150; i++) { const job = gateway.getJob(id); if (job.status !== 'running') return job; await new Promise(r => setTimeout(r, 50)); }
  gateway.cancelSearch(id); throw Error('test deadline');
}
function launch(gateway, options = {}) { const result = gateway.searchUsername({ username: 'docteur-fixture', siteFilter: ['GitHub'], ...options }); owned.push(result.jobId); return result.jobId; }
after(() => { for (const id of owned) { const dir = checkedPath(WORKSPACES_ROOT, id); assert.equal(path.dirname(dir), WORKSPACES_ROOT); fs.rmSync(dir, { recursive: true, force: true }); } });

test('username preserves normal and Unicode data', () => {
  for (const value of ['docteur-fixture', 'user.name', 'élève42', 'user_1']) assert.equal(validateUsername(value), value);
});
for (const value of ['--help', '-o', '../escape', '..', ' user ', 'two words', 'a\nb', 'a\0b', 'a;whoami', 'a/b', 'x'.repeat(65), 42, null]) test(`username rejects ${JSON.stringify(value)}`, () => assert.throws(() => validateUsername(value), /username_invalid/));
for (const ip of ['127.0.0.1', '127.3.4.5', '10.0.0.1', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.100.100.200', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '2002:7f00:1::', '64:ff9b::7f00:1']) test(`private/reserved address blocked ${ip}`, () => assert.equal(publicAddress(ip), false));
test('public IP literals and URLs allowed without credentials', () => {
  assert.ok(publicAddress('8.8.8.8')); assert.ok(publicAddress('2606:4700:4700::1111'));
  assert.equal(publicUrl('https://github.com/example').hostname, 'github.com');
});
for (const url of ['file:///etc/passwd', 'ftp://example.com', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://metadata.google.internal', 'https://user:pass@example.com', 'http://example.com:8080']) test(`URL denied ${url}`, () => assert.throws(() => publicUrl(url)));
test('DNS private answers and mixed public/private answers denied', async () => {
  await assert.rejects(resolvePublic('https://example.com', async () => [{ address: '10.0.0.2', family: 4 }]));
  await assert.rejects(resolvePublic('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]));
});
function transportFor(handler) {
  return (url, options, callback) => {
    const req = new EventEmitter(); req.destroy = error => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => queueMicrotask(() => handler(url, options, callback, req)); return req;
  };
}
test('redirect to localhost blocked before second request; DNS pinned to socket', async () => {
  let connections = 0;
  const transport = transportFor((url, options, callback, req) => {
    connections++; options.lookup(url.hostname, {}, (error, ip) => assert.equal(ip, '8.8.8.8'));
    const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'http://127.0.0.1/private' };
    callback(res); res.end(); req.emit('close');
  });
  await assert.rejects(publicRequest('https://example.com', { lookup: async () => [{ address: '8.8.8.8', family: 4 }], transport }), /network_destination_denied/);
  assert.equal(connections, 1);
});
test('massive HTTP response aborted', async () => {
  const transport = transportFor((_url, _opts, callback, req) => { const res = new PassThrough(); res.statusCode = 200; res.headers = {}; callback(res); res.end(Buffer.alloc(LIMITS.responseBytes + 1)); req.emit('close'); });
  await assert.rejects(publicRequest('https://example.com', { lookup: async () => [{ address: '8.8.8.8', family: 4 }], transport }), /response_too_large/);
});
test('explicit environment excludes credentials, proxy and real HOME', () => {
  const id = 'env-fixture'; owned.push(id); const root = checkedPath(WORKSPACES_ROOT, id); fs.mkdirSync(root, { recursive: true });
  const env = childEnvironment(root, { OPENAI_API_KEY: 'secret', SSH_AUTH_SOCK: 'secret', HTTPS_PROXY: 'http://secret', HOME: 'C:\\Users\\real', USERPROFILE: 'C:\\Users\\real' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined); assert.equal(env.HTTPS_PROXY, undefined);
  for (const key of ['HOME', 'USERPROFILE', 'TEMP', 'TMP']) assert.ok(env[key].startsWith(root));
});
test('traversal and junction escape blocked', () => {
  assert.throws(() => checkedPath(WORKSPACES_ROOT, '../escape'));
  assert.throws(() => checkedPath(WORKSPACES_ROOT, 'C:\\Windows'));
  assert.throws(() => checkedPath(WORKSPACES_ROOT, '\\\\host\\share'));
  const id = 'junction-fixture'; owned.push(id); const root = checkedPath(WORKSPACES_ROOT, id); fs.mkdirSync(root, { recursive: true });
  const link = path.join(root, 'escape'); fs.symlinkSync(path.resolve('..'), link, 'junction');
  assert.throws(() => checkedPath(root, 'escape/package.json'), /symlink_denied/); fs.unlinkSync(link);
});
test('site names only; pinned database rejects unknown selection', () => {
  assert.ok(loadSites(['GitHub']).GitHub);
  assert.throws(() => loadSites(['http://localhost'])); assert.throws(() => loadSites(['GitHub', 'GitHub']));
});
test('installation state verifies pinned source without executing CLI; no pipx API', () => {
  assert.equal(getInstallState().status, 'installed'); assert.throws(startInstall, /operator_setup/); assert.throws(startUninstall, /operator_action/);
});
test('real Sherlock receives HTTP fixture through gateway; structured results only', async () => {
  let calls = 0, child;
  const gateway = createSherlockGateway({ network: async url => { calls++; return success(url); }, spawnProcess(binary, args, opts) {
    assert.ok(binary.includes('Sherlock-runtime')); assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
    assert.ok(args.includes('-I')); assert.ok(!args.includes('docteur-fixture')); assert.equal(opts.env.OPENAI_API_KEY, undefined);
    child = spawn(binary, args, opts); return child;
  } });
  const job = await wait(gateway, launch(gateway));
  assert.equal(job.status, 'done', JSON.stringify(job)); assert.equal(calls, 1); assert.equal(job.summary.results[0].status, 'found');
  assert.equal(job.summary.results[0].metadata.untrusted, true); assert.equal(job.summary.results[0].response_text, undefined);
  assert.throws(() => process.kill(child.pid, 0));
});
test('network failure normalized as data without internal error or secret', async () => {
  const gateway = createSherlockGateway({ network: async () => { throw Error('SENSITIVE_INTERNAL_ERROR'); } });
  const job = await wait(gateway, launch(gateway));
  assert.equal(job.summary.results[0].status, 'error'); assert.ok(!JSON.stringify(job).includes('SENSITIVE_INTERNAL_ERROR'));
});
for (const mode of ['cancel', 'timeout']) test(`real ${mode} terminates child, no orphan`, async () => {
  let child;
  const gateway = createSherlockGateway({ network: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); }), spawnProcess: (...args) => (child = spawn(...args)) });
  const start = Date.now(), id = launch(gateway, { timeoutMs: mode === 'timeout' ? 150 : 10000 });
  assert.throws(() => launch(gateway), /concurrency_limit/);
  if (mode === 'cancel') gateway.cancelSearch(id);
  const job = await wait(gateway, id);
  assert.equal(job.status, mode === 'cancel' ? 'cancelled' : 'error'); assert.equal(job.summary.error, mode === 'cancel' ? 'cancelled' : 'timeout');
  assert.ok(Date.now() - start < 5000); assert.throws(() => process.kill(child.pid, 0));
});
test('massive child stdout killed', async () => {
  const gateway = createSherlockGateway({ limits: { ...LIMITS, outputBytes: 32 }, network: success });
  const job = await wait(gateway, launch(gateway)); assert.equal(job.status, 'error'); assert.equal(job.summary.error, 'output_limit');
});
test('rate limit remains after completed search', async () => {
  const gateway = createSherlockGateway({ limits: { ...LIMITS, rateCount: 1 }, network: success });
  await wait(gateway, launch(gateway)); assert.throws(() => launch(gateway), /rate_limited/);
});
test('legacy output never accepts script URLs or huge output', () => {
  assert.deepEqual(parseSherlockOutput('[+] Evil: javascript:alert(1)'), []);
  assert.throws(() => parseSherlockOutput('x'.repeat(LIMITS.outputBytes + 1)));
});
test('routes enforce loopback, host, origin, JSON, body size and semantic schema', async () => {
  let starts = 0;
  const service = { searchUsername() { starts++; return { jobId: 'fixture' }; }, getJob() { return null; }, cancelSearch() {} };
  const app = new Hono().route('/api', createSherlockRoute({ isLocal: () => true, gateway: service }));
  const blocked = new Hono().route('/api', createSherlockRoute({ isLocal: () => false }));
  assert.equal((await blocked.request('http://localhost/api/sherlock/status')).status, 403);
  assert.equal((await app.request('http://evil.example/api/sherlock/status')).status, 403);
  assert.equal((await app.request('http://localhost/api/sherlock/status', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await app.request('http://localhost/api/sherlock/search', { method: 'POST' })).status, 415);
  for (const body of [{ username: 'valid', args: ['--browse'] }, { username: 'valid', url: 'http://localhost' }, null, []]) {
    assert.equal((await app.request('http://localhost/api/sherlock/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await app.request('http://localhost/api/sherlock/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'x'.repeat(5000) }) })).status, 413);
  assert.equal(starts, 0);
  assert.equal((await app.request('http://localhost/api/sherlock/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'valid' }) })).status, 202);
  assert.equal(starts, 1);
  assert.equal((await app.request('http://localhost/api/sherlock/jobs/unknown')).status, 404);
  assert.equal((await app.request('http://localhost/api/sherlock/save-as-neuron', { method: 'POST' })).status, 410);
});
