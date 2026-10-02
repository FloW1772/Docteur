// ROOT POLICY V1 — HTTP gate over the certified device routes (frozen modules are NOT modified).
// Valid policy ⇒ the modules' own certified controls decide (nothing changes). Invalid policy ⇒ protected device operations fail closed,
// STOP / revocation routes always pass. Attribution of the caller (USER vs certified peer) reaches downstream code through the actor context.
// Run: node --test test-root-policy-gate.mjs
import './test-setup.mjs';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { createRootPolicyMiddleware, currentActorContext, getRootPolicyStatus, initRootPolicy } from './src/lib/root-policy/index.js';
import { classifyRoute } from './src/lib/root-policy/route-map.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REAL = path.join(HERE, 'policy');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-rp-gate-'));
after(() => { initRootPolicy({ policyDir: REAL, trustAnchors: TRUST_ANCHORS }); fs.rmSync(scratch, { recursive: true, force: true }); });

function appWithAllRealRoutes() {
  const app = new Hono();
  app.use('*', createRootPolicyMiddleware());
  const seen = [];
  for (const f of ['omega.js', 'omega-view.js', 'omega-interactive.js', 'omega-admin.js', 'omega-outbound.js', 'rassilon.js', 'rassilon-lan.js', 'device-fabric.js', 'maitre.js']) {
    const text = fs.readFileSync(path.join(HERE, 'src', 'routes', f), 'utf8');
    for (const m of text.matchAll(/(?:route|app)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      const pattern = `/api${m[2]}`;
      app.on(m[1].toUpperCase(), pattern, (c) => c.json({ handledBy: 'MODULE', actor: currentActorContext() }));
      seen.push({ method: m[1].toUpperCase(), path: pattern.replace(/:[A-Za-z]+/g, 'x') });
    }
  }
  app.post('/api/capture', (c) => c.json({ handledBy: 'MODULE' }));
  return { app, seen };
}
const call = (app, method, p) => app.request(p, { method });

describe('policy VALID — no behaviour change for the certified modules', () => {
  test('every real route of OMEGA / RASSILON / Device Fabric / MAÎTRE reaches its module; ungated routes too', async () => {
    initRootPolicy({ policyDir: REAL, dataDir: path.join(scratch, 'd1'), trustAnchors: TRUST_ANCHORS });
    assert.equal(getRootPolicyStatus().state, 'VALID');
    const { app, seen } = appWithAllRealRoutes();
    let gated = 0;
    for (const r of seen) {
      const res = await call(app, r.method, r.path);
      assert.equal(res.status, 200, `${r.method} ${r.path} must reach its module`);
      assert.equal((await res.json()).handledBy, 'MODULE');
      if (classifyRoute(r.method, r.path)) gated++;
    }
    assert.ok(gated >= 30, `${gated} gated routes exercised`);
  });

  test('the caller is attributed: UI routes ⇒ USER (user-initiated), certified peer protocol routes ⇒ MODULE (not user-initiated)', async () => {
    initRootPolicy({ policyDir: REAL, dataDir: path.join(scratch, 'd2'), trustAnchors: TRUST_ANCHORS });
    const { app } = appWithAllRealRoutes();
    const ui = await (await call(app, 'POST', '/api/omega/admin/actions')).json();
    assert.deepEqual([ui.actor.kind, ui.actor.userInitiated], ['USER', true]);
    const peer = await (await call(app, 'POST', '/api/omega-v2/sessions/x/view/start')).json();
    assert.deepEqual([peer.actor.kind, peer.actor.userInitiated], ['MODULE', false]);
    const other = await (await call(app, 'POST', '/api/capture')).json();
    assert.equal(other.handledBy, 'MODULE');
  });
});

describe('policy INVALID — protected device operations fail closed; STOP / revocation and unrelated routes keep working', () => {
  for (const [label, dir] of [['missing', 'nothing-here'], ['corrupted', null]]) {
    test(`policy ${label}`, async () => {
      let policyDir = path.join(scratch, 'nothing-here');
      if (!dir) { policyDir = path.join(scratch, 'corrupt'); fs.cpSync(REAL, policyDir, { recursive: true }); fs.writeFileSync(path.join(policyDir, 'root-policy.json'), fs.readFileSync(path.join(policyDir, 'root-policy.json'), 'utf8').replace('"LOW"', '"HIGH"')); }
      initRootPolicy({ policyDir, dataDir: path.join(scratch, `inv-${label}`), trustAnchors: TRUST_ANCHORS });
      assert.equal(getRootPolicyStatus().state, 'INVALID');
      const { app, seen } = appWithAllRealRoutes();
      let denied = 0; let stopped = 0; let passed = 0;
      for (const r of seen) {
        const cls = classifyRoute(r.method, r.path);
        const res = await call(app, r.method, r.path);
        if (!cls) { assert.equal(res.status, 200, `${r.method} ${r.path} (not gated) must keep working`); passed++; continue; }
        if (cls.action === 'DEVICE_STOP') { assert.equal(res.status, 200, `STOP must ALWAYS pass: ${r.method} ${r.path}`); stopped++; continue; }
        assert.equal(res.status, 503, `${r.method} ${r.path} (${cls.action}) must fail closed`);
        assert.deepEqual([(await res.json()).code], ['DENY_POLICY_INVALID']);
        denied++;
      }
      assert.ok(denied >= 15 && stopped >= 10 && passed >= 40, `denied ${denied} / stop ${stopped} / ungated ${passed}`);
      const ok = await call(app, 'POST', '/api/capture'); assert.equal(ok.status, 200, 'unrelated Docteur features are untouched by an invalid policy');
    });
  }

  test('live corruption flips the gate within ~1 s; restoring the signed pair re-opens it', async () => {
    const dir = path.join(scratch, 'live'); fs.cpSync(REAL, dir, { recursive: true });
    initRootPolicy({ policyDir: dir, dataDir: path.join(scratch, 'live-data'), trustAnchors: TRUST_ANCHORS });
    const { app } = appWithAllRealRoutes();
    assert.equal((await call(app, 'POST', '/api/omega/admin/actions')).status, 200);
    const good = fs.readFileSync(path.join(dir, 'root-policy.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'root-policy.json'), good.replace('"LOW"', '"HIGH"'));
    await new Promise(r => setTimeout(r, 1200));
    assert.equal((await call(app, 'POST', '/api/omega/admin/actions')).status, 503);
    assert.equal((await call(app, 'POST', '/api/omega/outbound/stop-all')).status, 200, 'STOP wins');
    fs.writeFileSync(path.join(dir, 'root-policy.json'), good);
    await new Promise(r => setTimeout(r, 2200));
    assert.equal((await call(app, 'POST', '/api/omega/admin/actions')).status, 200);
  });
});
