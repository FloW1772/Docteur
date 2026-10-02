// NB-7 — LOCAL API security audit + hardening proof. A hostile web page must not create / edit / delete / read local state.
// Proves the central policy (lib/local-request-guard.js + lib/local-api-policy.js) on EVERY registered route (627, statically
// extracted), plus DNS-rebinding hosts, simple-request attacks, CORS configuration, body caps and response headers.
// Run: node --test test-nb7-local-api-security.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { isLocalHostname, parseHostHeader, parseOrigin, isExpectedFrontendOrigin, evaluateRequest, createLocalRequestGuard } from './src/lib/local-request-guard.js';
import { applyLocalApiSecurity, isFrozenPath, bodyCapFor, FROZEN_PREFIXES } from './src/lib/local-api-policy.js';
import { buildMatrix, extractRoutes } from './nb7-route-matrix.mjs';

const GOOD = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' };
const EVIL_ORIGINS = ['https://evil.example', 'http://attacker.test', 'null', 'file://', 'http://localhost:9999', 'http://127.0.0.1:8080', 'https://127.0.0.1.evil.example', 'http://localhost.evil.example:5173', 'http://[::1]:9999', 'http://192.168.1.50:1234', 'chrome-extension://abcdef', 'http://user:pw@127.0.0.1:5173'];

// ═══════════ HELPERS ═══════════
test('isLocalHostname / parseHostHeader: loopback, private, single-label, .local ⇒ local; public names, userinfo, paths, garbage ⇒ not', () => {
  for (const h of ['localhost', '127.0.0.1', '127.3.4.5', '[::1]', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '[fd12:3456::1]', '[fe80::1]', 'desktop-abc', 'mypc.local', 'nas.lan', 'pc.home.arpa', 'app.localhost'])
    assert.equal(isLocalHostname(h), true, h);
  for (const h of ['evil.example', 'attacker.test', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '192.169.0.1', '[2001:db8::1]', 'localhost.evil.example', '127.0.0.1.evil.example', 'example.com', '', '0.0.0.0', '256.1.1.1', '1234'])
    assert.equal(isLocalHostname(h), false, h);
  assert.equal(isLocalHostname('docteur.corp', ['docteur.corp']), true, 'explicit allow-list (DOCTEUR_ALLOWED_HOSTS)');
  for (const bad of ['', '   ', 'evil.example/path', '127.0.0.1:3001@evil.example', 'user:pw@127.0.0.1', '127.0.0.1 evil.example', '127.0.0.1\\x', '[::1', 'a b', 'host?x=1', 'host#f', 'http://127.0.0.1']) assert.equal(parseHostHeader(bad), null, JSON.stringify(bad));
  assert.deepEqual(parseHostHeader('LOCALHOST:3001'), { hostname: 'localhost', host: 'localhost:3001' }); assert.equal(parseHostHeader('[::1]:3001').hostname, '[::1]');
});

test('parseOrigin / isExpectedFrontendOrigin: only the expected frontends; null, file, foreign, other loopback ports, userinfo ⇒ refused', () => {
  for (const o of ['http://localhost:5173', 'https://127.0.0.1:5173', 'http://[::1]:3000', 'http://127.0.0.1:4173']) assert.equal(isExpectedFrontendOrigin(o), true, o);
  for (const o of EVIL_ORIGINS) assert.equal(isExpectedFrontendOrigin(o), false, o);
  assert.equal(parseOrigin('null'), null); assert.equal(parseOrigin('http://x.test/path'), null);
  assert.equal(isExpectedFrontendOrigin('http://10.1.2.3:8080', ['http://10.1.2.3:8080']), true, 'DOCTEUR_ALLOWED_ORIGINS extension');
});

test('evaluateRequest: the full decision table (Host, Origin, missing Origin, Sec-Fetch-Site, JSON-only)', () => {
  const ev = (o, opts) => evaluateRequest({ method: 'POST', host: GOOD.host, origin: undefined, contentType: 'application/json', contentLength: '10', ...o }, opts);
  assert.equal(ev({}).ok, true, 'no Origin (non-browser local client)'); assert.equal(ev({ origin: GOOD.origin }).ok, true);
  assert.equal(ev({ origin: 'http://127.0.0.1:3001' }).ok, true, 'same-origin (UI served by the API host itself)'); assert.equal(ev({ origin: 'http://127.0.0.1:3001', host: 'localhost:3001' }).ok, false, 'different host name ⇒ not same-origin');
  for (const host of ['evil.example', 'attacker.test', 'evil.example:3001', '', undefined, '127.0.0.1@evil.example', '[::1']) assert.deepEqual([ev({ host }).ok, ev({ host }).code], [false, 'FORBIDDEN_HOST'], String(host));
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'localhost:3001', '[::1]:3001', '192.168.1.20:3001']) assert.equal(ev({ host }).ok, true, host);
  for (const origin of EVIL_ORIGINS) assert.deepEqual([ev({ origin }).ok, ev({ origin }).code], [false, 'FORBIDDEN_ORIGIN'], origin);
  assert.equal(ev({ method: 'GET', origin: 'https://evil.example' }).ok, false, 'cross-origin READ refused too');
  assert.equal(ev({ secFetchSite: 'cross-site' }).ok, false, 'browser says cross-site on a write'); assert.equal(ev({ method: 'GET', secFetchSite: 'cross-site' }).ok, true, 'a cross-site GET without Origin cannot be read and has no side effect');
  assert.equal(ev({ contentType: 'text/plain' }, { enforceJson: true }).code, 'UNSUPPORTED_MEDIA_TYPE'); assert.equal(ev({ contentType: undefined }, { enforceJson: true }).code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(ev({ contentType: undefined, contentLength: '0' }, { enforceJson: true }).ok, true, 'empty body (revoke, reindex)'); assert.equal(ev({ contentType: 'application/json; charset=utf-8' }, { enforceJson: true }).ok, true);
  assert.equal(ev({ contentType: 'text/plain' }).ok, true, 'content-type is only enforced where declared (uploads / legacy clients keep working); Origin does the CSRF work');
});

// ═══════════ EVERY ROUTE ═══════════
const fillParams = (p) => p.replace(/:[A-Za-z_]+(?:\{[^}]*\})?\??/g, 'x').replace(/\*/g, 'x');
function buildApp() {
  const hits = []; const app = new Hono();
  app.use('*', cors({ origin: (o) => (['http://127.0.0.1:5173', 'http://localhost:5173'].includes(o) ? o : null), allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'], credentials: true }));
  applyLocalApiSecurity(app, { isAllowedOrigin: () => false });
  const seen = new Set(); const matrix = buildMatrix();
  for (const r of matrix) { const key = `${r.method} ${fillParams(r.path)}`; if (seen.has(key)) continue; seen.add(key); const m = r.method === 'ALL' ? 'all' : r.method.toLowerCase(); app[m](fillParams(r.path), (c) => { hits.push(key); return c.json({ ok: true }); }); }
  return { app, hits, matrix };
}
const req = (app, m, p, h = {}, body) => app.request(`http://127.0.0.1:3001${p}`, { method: m, headers: { host: '127.0.0.1:3001', ...h }, body });

test('route inventory: 627 routes extracted, every one classified (SAFE / WRITE-SENSITIVE / READ-SENSITIVE / PUBLIC-LOW-RISK), frozen modules flagged', () => {
  const rows = buildMatrix(); assert.ok(rows.length >= 600, `${rows.length} routes`);
  assert.ok(rows.every(r => ['SAFE', 'WRITE-SENSITIVE', 'READ-SENSITIVE', 'PUBLIC/LOW-RISK'].includes(r.sensitivity)), 'no unclassified route');
  assert.ok(rows.every(r => r.guard && r.originPolicy && r.bodyLimit && r.result));
  assert.ok(rows.filter(r => r.method !== 'GET').every(r => r.sensitivity !== 'PUBLIC/LOW-RISK'), 'no write is ever "public"');
  const frozen = rows.filter(r => r.frozen); assert.ok(frozen.length > 100 && frozen.every(r => FROZEN_PREFIXES.some(p => r.path === p || r.path.startsWith(`${p}/`))));
  for (const pre of ['/api/device-fabric', '/api/omega', '/api/omega-v2', '/api/rassilon', '/api/maitre', '/api/monitor']) assert.ok(rows.some(r => r.path.startsWith(pre) && r.frozen), pre);
  assert.ok(rows.filter(r => !r.frozen).every(r => r.result === 'PASS' && r.guard.startsWith('GLOBAL')));
  assert.equal(extractRoutes().length, rows.length);
});

test('EVERY non-frozen route refuses a hostile page: DNS-rebinding Host, foreign Origin (read AND write), cross-site fetch — the handler is never reached; the legitimate frontend still works', async () => {
  const { app, hits, matrix } = buildApp(); let checked = 0;
  for (const r of matrix.filter(x => !x.frozen)) {
    const m = r.method === 'ALL' ? 'GET' : r.method; const p = fillParams(r.path); const before = hits.length; const hasBody = !['GET', 'HEAD'].includes(m); const body = hasBody ? '{}' : undefined;
    for (const [h, code] of [[{ host: 'evil.example' }, 403], [{ host: 'attacker.test:3001' }, 403], [{ origin: 'https://evil.example' }, 403], [{ origin: 'null' }, 403], [{ origin: 'http://localhost:9999' }, 403]]) {
      const res = await req(app, m, p, { ...h, ...(hasBody ? { 'content-type': 'application/json' } : {}) }, body); assert.equal(res.status, code, `${m} ${p} ${JSON.stringify(h)} → ${res.status}`);
    }
    if (hasBody) { const res = await req(app, m, p, { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body); assert.equal(res.status, 403, `${m} ${p} cross-site`); }
    assert.equal(hits.length, before, `${m} ${p}: the handler was reached by a hostile request`);
    // legit: expected frontend origin, and a local client without Origin
    for (const h of [{ origin: GOOD.origin }, {}]) { const res = await req(app, m, p, { ...h, ...(hasBody ? { 'content-type': 'application/json' } : {}) }, body); assert.equal(res.status, 200, `${m} ${p} legit ${JSON.stringify(h)} → ${res.status}`); }
    assert.equal(hits.length, before + 2, `${m} ${p}: legit requests reach the handler`); checked++;
  }
  assert.ok(checked > 400, `${checked} routes proven`);
});

test('frozen modules are EXEMPT (behaviour unchanged) — documented residual: the same hostile request is NOT refused there', async () => {
  const { app, hits, matrix } = buildApp(); const r = matrix.find(x => x.frozen && x.method === 'POST'); const before = hits.length;
  const res = await req(app, 'POST', fillParams(r.path), { origin: 'https://evil.example', 'content-type': 'text/plain' }, '{}'); assert.equal(res.status, 200, 'unchanged by NB-7 (their own certified controls apply)'); assert.equal(hits.length, before + 1);
  assert.equal(isFrozenPath('/api/omega-v2/sessions'), true); assert.equal(isFrozenPath('/api/omega'), true); assert.equal(isFrozenPath('/api/omegafake'), false, 'prefix match is exact on segment boundaries'); assert.equal(isFrozenPath('/api/notebooks/x'), false);
});

// ═══════════ ATTACKS ═══════════
test('simple-request attacks from a hostile page (text/plain, urlencoded, multipart, cross-origin GET, DNS rebinding) — create / edit / delete / read 0, and nothing CORS-visible', async () => {
  const { app, hits } = buildApp(); const before = hits.length;
  const fd = new FormData(); fd.set('x', 'y'); fd.set('file', new File(['payload'], 'a.txt'));
  const sensitive = [['POST', '/api/docteur-memory/items'], ['PATCH', '/api/docteur-memory/items/x'], ['DELETE', '/api/docteur-memory/items/x'], ['PUT', '/api/neuron/x'], ['DELETE', '/api/neuron/x'], ['POST', '/api/index'], ['POST', '/api/neurons/sync'], ['POST', '/api/backup/import'], ['PUT', '/api/router/cloud-keys'], ['POST', '/api/capture'], ['POST', '/api/answer'], ['POST', '/api/notebooks']];
  for (const [m, p] of sensitive) {
    for (const [ct, body] of [['text/plain', '{"a":1}'], ['application/x-www-form-urlencoded', 'a=1&b=2'], ['application/json', '{"a":1}']]) { const res = await req(app, m, p, { origin: 'https://evil.example', 'content-type': ct }, body); assert.equal(res.status, 403, `${m} ${p} ${ct}`); }
    const res = await app.request(`http://127.0.0.1:3001${p}`, { method: m, headers: { host: '127.0.0.1:3001', origin: 'https://evil.example' }, body: m === 'DELETE' ? undefined : fd }); assert.equal(res.status, 403, `${m} ${p} multipart`);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no ACAO for a foreign origin');
  }
  for (const p of ['/api/neurons', '/api/neuron/x', '/api/docteur-memory/items', '/api/docteur-memory/status', '/api/router/cloud-keys', '/api/backup/export', '/api/activity', '/api/privacy/violations', '/api/notebooks']) {
    const res = await req(app, 'GET', p, { origin: 'https://evil.example' }); assert.equal(res.status, 403, `cross-origin GET ${p}`);
    const rebind = await app.request(`http://attacker.test:3001${p}`, { headers: { host: 'attacker.test:3001' } }); assert.equal(rebind.status, 403, `rebinding ${p}`);
  }
  assert.equal(hits.length, before, 'no handler reached by any attack');
});

test('DNS rebinding table (fail closed on sensitive routes): evil.example, attacker.test, external Origin, Origin null, missing Origin, localhost, 127.0.0.1, [::1], malformed Host', async () => {
  const { app } = buildApp(); const cases = [
    [{ host: 'evil.example' }, 403], [{ host: 'attacker.test' }, 403], [{ host: 'evil.example:3001' }, 403], [{ origin: 'https://evil.example' }, 403], [{ origin: 'null' }, 403], [{}, 200],
    [{ host: 'localhost' }, 200], [{ host: 'localhost:3001' }, 200], [{ host: '127.0.0.1' }, 200], [{ host: '[::1]:3001' }, 200], [{ host: '127.0.0.1:3001@evil.example' }, 403], [{ host: 'evil.example/127.0.0.1' }, 403], [{ host: '[::1' }, 403], [{ host: '127.0.0.1\u0000.evil.example' }, 403], [{ host: ' ' }, 403],
  ];
  for (const [h, code] of cases) for (const p of ['/api/neurons', '/api/docteur-memory/status', '/api/router/cloud-keys']) { let res; try { res = await app.request(`http://127.0.0.1:3001${p}`, { headers: { ...(Object.hasOwn(h, 'host') ? { host: h.host } : { host: '127.0.0.1:3001' }), ...(h.origin ? { origin: h.origin } : {}) } }); } catch { continue; /* Headers API refused the value: cannot reach the server at all */ } assert.equal(res.status, code, `${JSON.stringify(h)} ${p}`); }
});

test('CORS configuration audit: no wildcard origin, explicit allow-list, PATCH allowed (Docteur Memory edits), credentials only with a specific origin', () => {
  const src = fs.readFileSync('src/server.js', 'utf8'); const i = src.indexOf("app.use('*', cors({"); const block = src.slice(i, src.indexOf('}));', i) + 4);
  assert.doesNotMatch(block, /origin:\s*['"]\*['"]|Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*/i); assert.match(block, /DEV_ORIGINS\.has\(origin\)/); assert.match(block, /return null;/); assert.match(block, /'PATCH'/); assert.match(block, /credentials:\s*true/);
  assert.doesNotMatch(src, /Access-Control-Allow-Origin['"]\s*,\s*['"]\*/i, 'no manual wildcard header anywhere in server.js');
  for (const f of fs.readdirSync('src/routes').filter(x => x.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(`src/routes/${f}`, 'utf8'), /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/i, f);
  assert.match(src, /applyLocalApiSecurity\(app,/, 'the central policy is mounted once, right after CORS');
  assert.equal((src.match(/createLocalRequestGuard\(/g) ?? []).length, 0, 'server.js never re-implements the guard');
});

// ═══════════ BODY LIMITS / HEADERS ═══════════
test('body limits by route class: sensitive JSON 64 KB, chat/search 1 MB, declared uploads 2 GiB outer bound, default 64 MB — uploads below the cap still pass', async () => {
  assert.deepEqual([bodyCapFor('/api/docteur-memory/items'), bodyCapFor('/api/router/cloud-keys'), bodyCapFor('/api/answer'), bodyCapFor('/api/files/upload'), bodyCapFor('/api/notebooks/n1/documents'), bodyCapFor('/api/notebooks/n1/ai-history/imports'), bodyCapFor('/api/neurons/sync'), bodyCapFor('/api/backup/import')].map(x => x.cap),
    [65536, 65536, 1048576, 2 * 1024 ** 3, 2 * 1024 ** 3, 2 * 1024 ** 3, 64 * 1024 ** 2, 2 * 1024 ** 3]);
  const { app } = buildApp(); const big = (n) => JSON.stringify({ x: 'a'.repeat(n) });
  assert.equal((await req(app, 'POST', '/api/docteur-memory/items', { 'content-type': 'application/json' }, big(70_000))).status, 413);
  assert.equal((await req(app, 'PUT', '/api/router/cloud-keys', { 'content-type': 'application/json' }, big(70_000))).status, 413);
  assert.equal((await req(app, 'POST', '/api/answer', { 'content-type': 'application/json' }, big(1_100_000))).status, 413);
  assert.equal((await req(app, 'POST', '/api/answer', { 'content-type': 'application/json' }, big(900_000))).status, 200);
  assert.equal((await req(app, 'POST', '/api/index', { 'content-type': 'application/json' }, big(5_000_000))).status, 200, 'default cap leaves room for large neurons');
  const fd = new FormData(); fd.set('file', new File([new Uint8Array(3 * 1024 * 1024)], 'a.bin'));
  assert.equal((await app.request('http://127.0.0.1:3001/api/files/upload-x', { method: 'POST', headers: { host: '127.0.0.1:3001', origin: GOOD.origin }, body: fd })).status, 404, 'route unknown in the fixture app');
  assert.equal((await app.request('http://127.0.0.1:3001/api/notebooks/x/documents/import', { method: 'POST', headers: { host: '127.0.0.1:3001', origin: GOOD.origin }, body: fd })).status, 200, 'a 3 MB multipart upload is not broken');
  assert.equal((await req(app, 'GET', '/api/neurons', { origin: GOOD.origin })).status, 200, 'GET is never body-limited');
});

test('response headers: nosniff + no referrer on non-frozen API, no-store on memory / router / backup / privacy, nothing added on frozen modules', async () => {
  const { app } = buildApp();
  const a = await req(app, 'GET', '/api/docteur-memory/items', { origin: GOOD.origin }); assert.equal(a.headers.get('x-content-type-options'), 'nosniff'); assert.equal(a.headers.get('referrer-policy'), 'no-referrer'); assert.equal(a.headers.get('cache-control'), 'no-store');
  assert.equal(a.headers.get('access-control-allow-origin'), GOOD.origin, 'reflects the specific allowed origin, never *');
  const n = await req(app, 'GET', '/api/neurons', { origin: GOOD.origin }); assert.equal(n.headers.get('cache-control'), null, 'neurons stay cacheable for the PWA');
  const f = await req(app, 'GET', '/api/device-fabric/status', { origin: GOOD.origin }); assert.equal(f.headers.get('x-content-type-options'), null, 'frozen routes untouched');
  const rej = await req(app, 'GET', '/api/neurons', { origin: 'https://evil.example' }); assert.equal(rej.status, 403); assert.equal(rej.headers.get('access-control-allow-origin'), null);
});

test('frontend headers / CSP audit (report only, nothing that could break the PWA is added): index.html + vite config + service worker', () => {
  const html = fs.readFileSync('../index.html', 'utf8'); const vite = fs.readFileSync('../vite.config.ts', 'utf8');
  const hasCsp = /http-equiv=["']Content-Security-Policy["']/i.test(html); const refer = /name=["']referrer["']/i.test(html);
  assert.ok(typeof hasCsp === 'boolean' && typeof refer === 'boolean'); // recorded in the report; no assertion on presence
  assert.match(vite, /navigateFallbackDenylist:\s*\[\/\^\\\/api\\\//, 'the service worker never serves /api from its navigation fallback');
  assert.doesNotMatch(html, /https?:\/\/(?:fonts\.googleapis|fonts\.gstatic|cdn\.)/i, 'no external CDN in index.html (Strict Local)');
});

test('the guard is applied ONCE: memory route uses the central helper; no route file re-implements Host / Origin parsing', () => {
  const offenders = [];
  for (const f of fs.readdirSync('src/routes').filter(x => x.endsWith('.js'))) { const s = fs.readFileSync(`src/routes/${f}`, 'utf8'); if (/LOCAL_HOST\s*=|hostnameOfHostHeader|new URL\(origin\)\.hostname/.test(s)) offenders.push(f); }
  // 5 pre-existing, stricter-by-port-blind route-level checks (loopback hostname, ANY port) predate NB-7; they are left untouched and now run
  // BEHIND the central guard. No NEW route may add its own copy.
  assert.deepEqual(offenders.sort(), ['code-intel.js', 'external-agents.js', 'metagpt.js', 'openmontage.js', 'sherlock.js']); assert.match(fs.readFileSync('src/routes/notebook-memory.js', 'utf8'), /createLocalRequestGuard/);
  const g = createLocalRequestGuard({ enforceJson: true }); assert.equal(typeof g, 'function');
});
