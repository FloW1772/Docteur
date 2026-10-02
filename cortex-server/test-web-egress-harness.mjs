// WEB EGRESS GUARD V1 — real local harness (loopback only, nothing is exposed on a public interface).
// Run: node --test --test-timeout=180000 test-web-egress-harness.mjs
//
// A counting HTTP(S) target is started on 127.0.0.2 (the "internal service the attacker wants to reach") and a fixture origin on
// 127.0.0.1. The PUBLIC_EGRESS paths are then pointed at the target directly, via IPv4-mapped IPv6, via redirects and from page
// scripts / sub-resources of a REAL Chromium. Expected: BLOCKED BEFORE CONNECTION — connections_received = 0.
// Positive controls (the same navigations with an un-proxied Chromium) prove the target is reachable and the counters are real.
import './test-setup.mjs';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createEgressClient, installBrowserEgressGuard, startBrowserEgressProxy, setEgressLogger, safeFetch } from './src/lib/web-egress-guard.js';
import { downloadImageFromUrl } from './src/lib/image.js';
import { extractWithPlaywright, closeDeepCaptureBrowserForTests } from './src/lib/deep-capture.js';
import { buildCaptureResult } from './src/lib/capture.js';
import { generatePdf } from './src/lib/pdf.js';

async function listen(handler, host, tls = null) {
  const sockets = new Set(); const state = { connections: 0, requests: [] };
  const wrap = (req, res) => { state.requests.push(req.url); handler(req, res); };
  const server = tls ? https.createServer(tls, wrap) : http.createServer(wrap);
  server.on('connection', s => { state.connections++; sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.listen(0, host); await once(server, 'listening');
  return { port: server.address().port, state, close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); }) };
}

const ARTICLE = `<!doctype html><title>t</title><main><article><h1>Fixture</h1><p>${'Contenu de test. '.repeat(80)}</p></article></main>`;
const BLOCKED_RE = /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|blocked|net::/i;

describe('real loopback harness', () => {
  let target; let secureTarget; let secureOrigin; let origin; let guarded; let control; let proxy; let fixture; let loopbackAvailable = true; let tlsDir = null;
  const events = [];

  before(async () => {
    try { target = await listen((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>INTERNAL</h1>'); }, '127.0.0.2'); } catch { loopbackAvailable = false; }
    if (!loopbackAvailable) return;
    try {
      tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-egress-harness-'));
      const cnf = path.join(tlsDir, 'o.cnf'); fs.writeFileSync(cnf, '[req]\ndistinguished_name=dn\n[dn]\n');
      execFileSync('openssl', ['req', '-config', cnf, '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=127.0.0.2', '-addext', 'subjectAltName=IP:127.0.0.2,IP:127.0.0.1', '-keyout', path.join(tlsDir, 'k.pem'), '-out', path.join(tlsDir, 'c.pem')], { stdio: 'ignore', windowsHide: true });
      secureTarget = await listen((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>SECURE-INTERNAL</h1>'); }, '127.0.0.2', { key: fs.readFileSync(path.join(tlsDir, 'k.pem')), cert: fs.readFileSync(path.join(tlsDir, 'c.pem')) });
      secureOrigin = await listen((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>SECURE-PUBLIC-OK</h1>'); }, '127.0.0.1', { key: fs.readFileSync(path.join(tlsDir, 'k.pem')), cert: fs.readFileSync(path.join(tlsDir, 'c.pem')) });
    } catch { secureTarget = null; secureOrigin = null; }
    origin = await listen((req, res) => {
      const u = new URL(req.url, 'http://x');
      const html = (b) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); };
      if (u.pathname === '/ok') return html('<h1>PUBLIC-OK</h1>');
      if (u.pathname === '/to-internal') { res.writeHead(302, { location: `http://127.0.0.2:${target.port}/secret` }); return res.end(); }
      if (u.pathname === '/to-internal-chain') { res.writeHead(302, { location: '/to-internal' }); return res.end(); }
      if (u.pathname === '/to-secure-internal') { res.writeHead(302, { location: `https://127.0.0.2:${secureTarget?.port}/secret` }); return res.end(); }
      if (u.pathname === '/script-fetch') return html(`<h1>S</h1><script>fetch('http://127.0.0.2:${target.port}/xhr').then(()=>document.title='LEAK',()=>document.title='BLOCKED')</script>`);
      if (u.pathname === '/subresource') return html(`<h1>I</h1><img src="http://127.0.0.2:${target.port}/img.png"><iframe src="http://127.0.0.2:${target.port}/frame"></iframe>`);
      if (u.pathname === '/article') return html(ARTICLE);
      res.writeHead(404); res.end();
    }, '127.0.0.1');
    // Fixture client: ONLY 127.0.0.1 is treated as "public" (the fixture origin); everything else keeps the production rules.
    fixture = createEgressClient({ ports: [origin.port, target.port, secureTarget?.port, secureOrigin?.port].filter(Boolean), addressPolicy: info => info.address === '127.0.0.1' || info.public });
    proxy = await startBrowserEgressProxy({ client: fixture });
    guarded = await chromium.launch({ headless: true, ...proxy.launchOptions() });
    control = await chromium.launch({ headless: true });
    setEgressLogger({ warn: (obj) => events.push(obj) });
  });

  after(async () => {
    setEgressLogger(null);
    await guarded?.close(); await control?.close(); await proxy?.close();
    await closeDeepCaptureBrowserForTests();
    await origin?.close(); await target?.close(); await secureTarget?.close(); await secureOrigin?.close();
    if (tlsDir) fs.rmSync(tlsDir, { recursive: true, force: true });
  });

  async function navigate(browser, url, opts = {}) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await ctx.newPage();
    try { const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000, ...opts }); return { page, ctx, response, error: null }; }
    catch (error) { return { page, ctx, response: null, error }; }
  }
  const blockedOutcome = (r) => (r.error ? BLOCKED_RE.test(String(r.error.message)) : r.response?.status() === 403 && r.response.headers()['x-egress-blocked']);

  test('POSITIVE CONTROL: an un-proxied Chromium reaches the internal target, directly and through a redirect (counter + reachability are real)', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    const before_ = target.state.connections;
    let r = await navigate(control, `http://127.0.0.2:${target.port}/control`);
    assert.match(await r.page.content(), /INTERNAL/); await r.ctx.close();
    assert.ok(target.state.connections > before_);
    r = await navigate(control, `http://127.0.0.1:${origin.port}/to-internal`);
    assert.match(await r.page.content(), /INTERNAL/, 'an un-proxied browser follows the redirect to the internal target'); await r.ctx.close();
    assert.ok(target.state.requests.includes('/secret'));
    if (secureTarget) {
      const m = secureTarget.state.connections;
      r = await navigate(control, `https://127.0.0.2:${secureTarget.port}/control`);
      assert.match(await r.page.content(), /SECURE-INTERNAL/); await r.ctx.close();
      assert.ok(secureTarget.state.connections > m);
    }
    target.state.requests.length = 0; target.state.connections = 0; if (secureTarget) { secureTarget.state.requests.length = 0; secureTarget.state.connections = 0; }
  });

  test('egress proxy: public fixture page loads; the proxy requires its credentials', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    const r = await navigate(guarded, `http://127.0.0.1:${origin.port}/ok`);
    assert.equal(r.response?.status(), 200); assert.match(await r.page.content(), /PUBLIC-OK/); await r.ctx.close();
    const noAuth = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${origin.port}/ok`, method: 'GET', headers: { host: `127.0.0.1:${origin.port}` } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(noAuth, 407);
    const upgrade = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${origin.port}/ws`, headers: { connection: 'Upgrade', upgrade: 'websocket', 'proxy-authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') } });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); }); req.on('response', res => { res.resume(); resolve(res.statusCode); }); req.on('error', () => resolve('error')); req.end();
    });
    assert.ok([501, 'error'].includes(upgrade), `WebSocket upgrade must be refused (got ${upgrade})`);
  });

  test('HTTPS through the proxy WORKS for an allowed destination (CONNECT + proxy auth challenge + end-to-end TLS)', async (t) => {
    if (!loopbackAvailable || !secureOrigin) return t.skip('127.0.0.2 / openssl not available');
    const m = secureOrigin.state.connections;
    const r = await navigate(guarded, `https://127.0.0.1:${secureOrigin.port}/ok`);
    assert.equal(r.error, null, `legit https navigation failed: ${r.error?.message}`);
    assert.equal(r.response.status(), 200); assert.match(await r.page.content(), /SECURE-PUBLIC-OK/);
    assert.ok(secureOrigin.state.connections > m, 'the tunnel reached the allowed origin');
    await r.ctx.close();
  });

  test('REDIRECT BYPASS (found by this harness): a public page redirecting to the internal target is blocked by the proxy, with or without a route() filter', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    const mark = target.state.connections; const marks = target.state.requests.length;
    for (const withRouteFilter of [false, true]) {
      for (const p of ['/to-internal', '/to-internal-chain']) {
        const ctx = await guarded.newContext(); if (withRouteFilter) await installBrowserEgressGuard(ctx, { client: fixture, resolve: false });
        const page = await ctx.newPage();
        const response = await page.goto(`http://127.0.0.1:${origin.port}${p}`, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(e => e);
        const body = response?.status ? await page.content() : '';
        assert.ok(!/INTERNAL/.test(body), `internal content leaked via ${p} (route filter: ${withRouteFilter})`);
        assert.ok(response instanceof Error ? BLOCKED_RE.test(response.message) : response.status() === 403, `${p} must be refused`);
        await ctx.close();
      }
    }
    assert.equal(target.state.connections, mark, 'a redirect reached the internal target');
    assert.equal(target.state.requests.length, marks);
  });

  test('HTTPS (CONNECT) to an internal target is refused before any connection; redirect to it too', async (t) => {
    if (!loopbackAvailable || !secureTarget) return t.skip('127.0.0.2 / openssl not available');
    const mark = secureTarget.state.connections;
    let r = await navigate(guarded, `https://127.0.0.2:${secureTarget.port}/direct`);
    assert.ok(blockedOutcome(r), `direct https must be refused: ${r.error?.message}`); await r.ctx.close();
    r = await navigate(guarded, `http://127.0.0.1:${origin.port}/to-secure-internal`);
    assert.ok(blockedOutcome(r) || !/SECURE-INTERNAL/.test(await r.page.content().catch(() => '')), 'redirect to https internal target must be refused'); await r.ctx.close();
    assert.equal(secureTarget.state.connections, mark, 'the internal HTTPS target received a connection');
  });

  test('page scripts and sub-resources (fetch, <img>, <iframe>) cannot reach the internal target', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    const mark = target.state.connections;
    let r = await navigate(guarded, `http://127.0.0.1:${origin.port}/script-fetch`, { waitUntil: 'load' });
    await r.page.waitForFunction(() => document.title === 'BLOCKED' || document.title === 'LEAK', null, { timeout: 5000 });
    assert.equal(await r.page.title(), 'BLOCKED'); await r.ctx.close();
    r = await navigate(guarded, `http://127.0.0.1:${origin.port}/subresource`, { waitUntil: 'load' });
    await r.page.waitForTimeout(300); await r.ctx.close();
    assert.equal(target.state.connections, mark, 'a sub-resource reached the internal target');
  });

  test('IPv4-mapped IPv6 loopback and localhost navigations are refused; the fixture origin sees no connection', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    const mark = origin.state.connections; const tmark = target.state.connections;
    for (const url of [`http://[::ffff:127.0.0.1]:${origin.port}/ok`, `http://[::ffff:7f00:1]:${origin.port}/ok`, `http://localhost:${origin.port}/ok`, `http://127.0.0.2:${target.port}/direct`]) {
      const r = await navigate(guarded, url); assert.ok(blockedOutcome(r), `${url} must be refused (${r.error?.message ?? r.response?.status()})`); await r.ctx.close();
    }
    assert.equal(origin.state.connections, mark, 'mapped / localhost forms must not connect to the fixture origin');
    assert.equal(target.state.connections, tmark);
  });

  test('PRODUCTION WIRING: deep-capture extractWithPlaywright (strict default guard + proxy) never touches any loopback target', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    events.length = 0;
    const m1 = target.state.connections; const m2 = origin.state.connections;
    const result = await extractWithPlaywright(`http://127.0.0.2:${target.port}/direct`).catch(() => null);
    const result2 = await extractWithPlaywright(`http://127.0.0.1:${origin.port}/article`).catch(() => null);
    const result3 = await extractWithPlaywright(`http://[::ffff:127.0.0.1]:${origin.port}/article`).catch(() => null);
    assert.equal(result, null); assert.equal(result2, null); assert.equal(result3, null);
    assert.equal(target.state.connections, m1); assert.equal(origin.state.connections, m2, 'strict default guard blocks every loopback navigation');
    assert.ok(events.some(e => e.event === 'EGRESS_BLOCKED' && e.purpose === 'browser'), 'the browser guard must log a structured BLOCKED_* event');
    assert.ok(events.every(e => !JSON.stringify(e).includes('/direct') && !JSON.stringify(e).includes('/article')), 'no path in logs');
  });

  test('PRODUCTION WIRING: image download / capture / safeFetch refuse loopback and mapped loopback with 0 connections', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    const m1 = target.state.connections; const m2 = origin.state.connections;
    for (const url of [`http://127.0.0.2:${target.port}/a.png`, `http://[::ffff:127.0.0.1]:${origin.port}/a.png`, `http://127.0.0.1:${origin.port}/a.png`]) {
      await assert.rejects(() => downloadImageFromUrl(url), (e) => e.egressBlocked === true && /^BLOCKED_/.test(e.code), url);
      await assert.rejects(() => safeFetch(url), (e) => e.egressBlocked === true, url);
    }
    const capture = await buildCaptureResult(`http://[::ffff:127.0.0.1]:${origin.port}/article`).then(() => 'resolved', e => `rejected:${e.code ?? e.message}`);
    assert.match(capture, /rejected:BLOCKED_LOOPBACK/);
    assert.equal(target.state.connections, m1); assert.equal(origin.state.connections, m2);
  });

  test('PRODUCTION WIRING: PDF export (document-controlled HTML rendered by Chromium) cannot reach internal targets through <img>/<link>/<iframe>', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    const m1 = target.state.connections; const m2 = origin.state.connections;
    const hostile = `<!doctype html><html><body><h1>Export</h1>
      <img src="http://127.0.0.2:${target.port}/pdf-img.png"><img src="http://[::ffff:127.0.0.1]:${origin.port}/pdf-img2.png">
      <iframe src="http://127.0.0.2:${target.port}/pdf-frame"></iframe><link rel="stylesheet" href="http://127.0.0.2:${target.port}/pdf.css"></body></html>`;
    // Positive control: the SAME hostile HTML rendered by an un-proxied Chromium (what pdf.js did before) does reach the target.
    const controlPage = await control.newPage();
    await controlPage.setContent(hostile, { waitUntil: 'load' }).catch(() => {});
    await controlPage.waitForTimeout(300); await controlPage.close();
    assert.ok(target.state.connections > m1, 'control: an un-proxied renderer reaches the internal target');
    target.state.requests.length = 0; target.state.connections = 0; origin.state.connections = m2;
    const pdf = await generatePdf(hostile, { mode: 'basic' });
    assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF', 'the export itself still works');
    assert.equal(target.state.connections, 0, 'PDF renderer reached the internal target');
    assert.equal(origin.state.connections, m2);
  });

  test('forbidden_connections_received_by_target = 0 (summary)', async (t) => {
    if (!loopbackAvailable) return t.skip('127.0.0.2 not bindable');
    // Everything the targets saw came ONLY from the positive controls, which ran first and were reset afterwards.
    assert.deepEqual(target.state.requests, [], `unexpected requests reached the target: ${JSON.stringify(target.state.requests)}`);
    assert.equal(target.state.connections, 0);
    if (secureTarget) assert.equal(secureTarget.state.connections, 0);
  });
});
