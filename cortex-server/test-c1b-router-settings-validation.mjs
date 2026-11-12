// C1b — POST /api/router/settings stores the privacy / cost switches only as real booleans.
// cloud_enabled, strict_local_mode and paying_apis_enabled: a present value that is not the boolean true or false is
// refused with HTTP 400 and nothing is stored (no partial write). An absent field keeps its current value (partial
// update, unchanged contract). A body that is not a JSON object is refused with HTTP 400.
// Run: node --test test-c1b-router-settings-validation.mjs
//
// Isolation: temporary databases only (never the real one), the route mounted on a bare Hono app (no server
// started), no provider is called.
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { initSqlite, getDatabase, getRouterSettings, setMeta } from './src/lib/sqlite.js';
import { createRouterRoute } from './src/routes/router.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-c1b-'));
const GUARDED = ['cloud_enabled', 'strict_local_mode', 'paying_apis_enabled'];
const NOT_BOOL = ['true', 'false', 1, 0, null, '', 'yes', {}, [], [true]];
const SAFE = Object.freeze({ cloud_enabled: false, strict_local_mode: true, paying_apis_enabled: false });
const label = (v) => JSON.stringify(v);

function app() {
  const a = new Hono();
  a.route('/api', createRouterRoute({ services: {} }));
  return a;
}
const post = (body, raw = false) => app().request('/api/router/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body),
});
const stored = () => JSON.stringify(getRouterSettings());

before(() => { initSqlite(path.join(scratch, 'c1b.db')); });
after(() => {
  try { getDatabase()?.close(); } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { setMeta('router_settings', { ...SAFE }); });

test('real booleans are accepted and stored as booleans (both directions, all three switches)', async () => {
  for (const field of GUARDED) {
    for (const v of [true, false]) {
      const res = await post({ [field]: v });
      assert.equal(res.status, 200, `${field}=${v}`);
      assert.equal((await res.json()).settings[field], v);
      assert.equal(getRouterSettings()[field], v);
    }
  }
});

test('non-boolean values are refused with 400 and nothing is stored', async () => {
  for (const field of GUARDED) {
    for (const v of NOT_BOOL) {
      const before = stored();
      const res = await post({ [field]: v });
      assert.equal(res.status, 400, `${field}=${label(v)}`);
      const body = await res.json();
      assert.equal(body.code, 'ROUTER_SETTINGS_INVALID');
      assert.equal(body.field, field);
      assert.equal(stored(), before, `${field}=${label(v)} must not change the store`);
    }
  }
  assert.equal(getRouterSettings().cloud_enabled, false);
  assert.equal(getRouterSettings().strict_local_mode, true);
});

test('one invalid switch rejects the whole update (no partial write of the other fields)', async () => {
  const before = stored();
  const res = await post({ fallback_model: 'c1b-synthetic-model', strict_local_mode: false, cloud_enabled: 'true' });
  assert.equal(res.status, 400);
  assert.equal(stored(), before);
  assert.notEqual(getRouterSettings().fallback_model, 'c1b-synthetic-model');
});

test('absent switches keep their current value on a partial update', async () => {
  const res = await post({ fallback_model: 'c1b-synthetic-model' });
  assert.equal(res.status, 200);
  const s = getRouterSettings();
  assert.equal(s.fallback_model, 'c1b-synthetic-model');
  assert.equal(s.cloud_enabled, false);
  assert.equal(s.strict_local_mode, true);
  assert.equal(s.paying_apis_enabled, false);
});

test('a body that is not a JSON object is refused with 400 and nothing is stored', async () => {
  const before = stored();
  for (const body of [[], [{ cloud_enabled: true }], null, 'cloud_enabled', 1, true]) {
    const res = await post(body);
    assert.equal(res.status, 400, `body=${label(body)}`);
    assert.equal((await res.json()).code, 'ROUTER_SETTINGS_INVALID');
  }
  const bad = await post('{"cloud_enabled": tru', true);
  assert.equal(bad.status, 400, 'malformed JSON');
  assert.equal(stored(), before);
});

test('the Settings UI requests keep working (boolean toggles and non-switch fields)', async () => {
  for (const body of [{ strict_local_mode: false }, { strict_local_mode: true }, { paying_apis_enabled: true },
    { paying_apis_enabled: false }, { router_enabled: false }, { claude_mode: 'api' }, { cloud_preference: 'balanced' },
    { freellmapi: { enabled: false, baseUrl: '' } }, { always_show_all_free_apis: true }]) {
    assert.equal((await post(body)).status, 200, label(body));
  }
});

test('production defaults (no DOCTEUR_TEST_MODE) stay safe, and a string cannot flip them', () => {
  const url = (p) => JSON.stringify(pathToFileURL(path.join(HERE, p)).href);
  const code = `
    import { Hono } from 'hono';
    import { initSqlite, getRouterSettings, getDatabase } from ${url('src/lib/sqlite.js')};
    import { createRouterRoute } from ${url('src/routes/router.js')};
    initSqlite(${JSON.stringify(path.join(scratch, 'prod.db'))});
    const a = new Hono(); a.route('/api', createRouterRoute({ services: {} }));
    const res = await a.request('/api/router/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strict_local_mode: 'false', cloud_enabled: 'true' }) });
    const s = getRouterSettings();
    getDatabase().close();
    console.log(JSON.stringify({ testMode: process.env.DOCTEUR_TEST_MODE ?? null, status: res.status, cloud: s.cloud_enabled, strict: s.strict_local_mode, paying: s.paying_apis_enabled }));`;
  const env = { ...process.env };
  delete env.DOCTEUR_TEST_MODE;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: HERE, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()),
    { testMode: null, status: 400, cloud: false, strict: true, paying: false });
});

test('DOCTEUR_TEST_MODE compatibility: the simulated cloud baseline is unchanged and still settable', async () => {
  assert.equal(process.env.DOCTEUR_TEST_MODE, '1');
  setMeta('router_settings', {});
  const s = getRouterSettings();
  assert.equal(s.cloud_enabled, true);
  assert.equal(s.strict_local_mode, false);
  assert.equal((await post({ cloud_enabled: false })).status, 200);
  assert.equal(getRouterSettings().cloud_enabled, false);
});
