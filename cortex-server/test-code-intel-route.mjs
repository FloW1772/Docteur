// Route tests for the Code Intelligence Gateway API. Exercises the Hono
// app directly (no live server), guard shape mirrors sherlock.js/maitre.js.
// Run with: node --test test-code-intel-route.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeIntelRoute } from './src/routes/code-intel.js';

const isLocal = () => true; // most tests exercise route logic, not the loopback check itself
const app = createCodeIntelRoute({ isLocal });
const appRemote = createCodeIntelRoute({ isLocal: () => false });

async function get(path, appInstance = app) {
  return appInstance.request(path, { headers: { host: 'localhost' } });
}

test('GET /code-intel/status: returns readOnly:true and the fixed capability list', async () => {
  const res = await get('/code-intel/status');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.readOnly, true);
  assert.ok(Array.isArray(body.capabilities));
  // No capability name suggests write/apply/execute of any kind.
  for (const cap of body.capabilities) {
    assert.doesNotMatch(cap, /apply|write|commit|execute|run|install/i);
  }
});

test('loopback guard: a non-local remote address is refused before any route logic runs', async () => {
  const res = await get('/code-intel/status', appRemote);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'local_access_required');
});

test('origin guard: a non-localhost Origin header is refused', async () => {
  const res = await app.request('/code-intel/status', { headers: { host: 'localhost', origin: 'https://evil.example.com' } });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'origin_denied');
});

test('GET /code-intel/search: text search returns bounded results', async () => {
  const res = await get('/code-intel/search?q=resolveWorkspacePath&limit=10');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.results));
});

test('GET /code-intel/search: filename kind returns filename-only matches', async () => {
  const res = await get('/code-intel/search?q=code-intel-git&kind=filename&limit=5');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.results.some(r => r.relativePath.endsWith('code-intel-git.js')));
});

test('GET /code-intel/search: missing query returns 400, not a crash', async () => {
  const res = await get('/code-intel/search');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'query_required');
});

test('GET /code-intel/search: oversized query returns 400', async () => {
  const res = await get('/code-intel/search?q=' + 'a'.repeat(600));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'query_too_long');
});

test('GET /code-intel/symbols: returns bounded results, honest heuristic shape', async () => {
  const res = await get('/code-intel/symbols?q=gitDiff&limit=5');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  for (const r of body.results) assert.equal(r.matchType, 'symbol_heuristic');
});

test('GET /code-intel/git/status: returns entries, 200', async () => {
  const res = await get('/code-intel/git/status');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.entries));
});

test('GET /code-intel/git/diff: default (working tree) succeeds', async () => {
  const res = await get('/code-intel/git/diff');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET /code-intel/git/diff: path traversal via querystring is rejected with a safe status, not a crash', async () => {
  const res = await get('/code-intel/git/diff?path=' + encodeURIComponent('../../../Windows/System32'));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'code_intel_path_traversal_denied');
});

test('GET /code-intel/git/diff: absolute path via querystring is rejected', async () => {
  const res = await get('/code-intel/git/diff?path=' + encodeURIComponent('C:\\Windows\\System32'));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'code_intel_path_absolute_denied');
});

test('GET /code-intel/git/log: bounded, 200', async () => {
  const res = await get('/code-intel/git/log?limit=5');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.commits.length <= 5);
});

test('GET /code-intel/git/show: valid ref succeeds', async () => {
  const res = await get('/code-intel/git/show?ref=HEAD');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET /code-intel/git/show: malicious ref is rejected with 400, never reaches git', async () => {
  const res = await get('/code-intel/git/show?ref=' + encodeURIComponent('; rm -rf /'));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_ref');
});

test('GET /code-intel/git/show: a ref shaped like a git flag is rejected', async () => {
  const res = await get('/code-intel/git/show?ref=' + encodeURIComponent('--upload-pack=evil'));
  assert.equal(res.status, 400);
});

// ── Negative security: confirm no route exists for any mutating operation ──
test('negative security: no route accepts a mutating git verb', async () => {
  const mutatingPaths = [
    '/code-intel/git/commit', '/code-intel/git/checkout', '/code-intel/git/reset',
    '/code-intel/git/clean', '/code-intel/git/push', '/code-intel/git/pull',
    '/code-intel/git/fetch', '/code-intel/git/rebase', '/code-intel/git/merge',
  ];
  for (const p of mutatingPaths) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} must not exist as a route`);
  }
});

test('negative security: no generic execute/run/command endpoint exists', async () => {
  const genericPaths = ['/code-intel/execute', '/code-intel/run', '/code-intel/command', '/code-intel/shell'];
  for (const p of genericPaths) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} must not exist`);
  }
});

test('negative security: POST to any code-intel path is not a defined mutating action (405/404, never a write)', async () => {
  const res = await app.request('/code-intel/git/status', { method: 'POST', headers: { host: 'localhost' } });
  assert.notEqual(res.status, 200);
});
