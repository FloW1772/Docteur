// [EETF V1] EETF-7 — browser suite: the REAL ImageGeneratorModal in Chromium, the REAL EETF route in-process
// (temporary stores, real FFmpeg, real Root Policy decisions), a FAKE in-process provider for the generation
// path, legacy endpoints answered by fixtures. External requests are aborted and counted.
// Usage: node scripts/test-eetf-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { EetfStore } from '../cortex-server/src/lib/eetf-store.js';
import { hashFile } from '../cortex-server/src/lib/eetf-asset-store.js';
import { createEetfRoute, createEetfServices } from '../cortex-server/src/routes/eetf.js';
import { createComfyUiProvider } from '../cortex-server/src/lib/eetf-comfyui-provider.js';
import { enforce } from '../cortex-server/src/lib/root-policy/index.js';
import { FORBIDDEN_CLAIMS } from '../src/lib/eetf/ui-model.ts';

let assertions = 0;
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }

const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.resolve('cortex-server', 'data', f));
const realDbBefore = REAL_DB.map(p => (fs.existsSync(p) ? hashFile(p) : 'absent'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf7-browser-'));

// ── fixtures ──
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); }
function png(w, h, f, { alpha = false } = {}) {
  const ch = alpha ? 4 : 3; const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); for (let c = 0; c < ch; c++) raw[y * (w * ch + 1) + 1 + x * ch + c] = p[c]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const T = Math.PI * 2;
const periodic = (w, h) => (x, y) => [128 + Math.round(90 * Math.sin(T * x / w)), 128 + Math.round(90 * Math.cos(T * y / h)), 120];
const sky = (w, h) => (x, y) => { const l = Math.sin(Math.PI * (y + 0.5) / h); return [128 + Math.round(100 * Math.sin(T * x / w) * l), 50 + Math.round(150 * y / h), 128 + Math.round(60 * Math.cos(T * x / w) * l)]; };
const HOSTILE = '<img src=x onerror="window.__xss=1">pierre<b>gras<b>';

function fixtures(store) {
  const reg = (buf, name, mime = 'image/png') => store.registerAsset({ buffer: buf, declaredMime: mime, role: 'SOURCE', displayName: name }).asset;
  return {
    texture: reg(png(128, 128, periodic(128, 128)), 'pierre-opaque.png'),
    alpha: reg(png(64, 64, (x, y) => [200, 120, 40, 10 + ((x * 7 + y * 3) % 240)], { alpha: true }), 'feuille-alpha.png'),
    opaqueAlpha: reg(png(64, 64, (x, y) => [x * 4, y * 4, 90, 255], { alpha: true }), 'alpha-pleine.png'),
    hostile: reg(png(32, 32, periodic(32, 32)), HOSTILE),
    pano: reg(png(512, 256, sky(512, 256)), 'ciel-panorama.png'),
    near: reg(png(512, 257, sky(512, 257)), 'ciel-presque.png'),
    square: reg(png(256, 256, sky(256, 256)), 'carre.png'),
  };
}

// ── services ──
const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const closedPort = closed.address().port; await new Promise(r => closed.close(r));
const storeA = EetfStore.open({ dbPath: path.join(TMP, 'a', 'eetf.sqlite'), assetRoot: path.join(TMP, 'a', 'root') });
const fxA = fixtures(storeA);
const servicesA = createEetfServices({ store: storeA, enforce, providers: [createComfyUiProvider({ endpoint: `http://127.0.0.1:${closedPort}`, enforce, probeTimeoutMs: 800 })] });
const exrJob = await servicesA.derive.run(servicesA.derive.submit({ sourceAssetId: fxA.pano.id, operation: 'CONVERT', format: 'EXR' }).id);
eq(exrJob.status, 'COMPLETED', 'EXR panorama fixture');
const apiUnavailable = createEetfRoute(servicesA);

const fake = { mode: 'hold', gates: [] };
const fakeProvider = {
  providerId: 'fake-local', displayName: '<b>Fake</b><script>window.__xss=3</script> local', locality: 'IN_PROCESS',
  probe: async () => ({ providerId: 'fake-local', displayName: '<b>Fake</b><script>window.__xss=3</script> local', locality: 'IN_PROCESS', status: 'AVAILABLE', capabilities: ['TXT2IMG', 'SEED', 'NEGATIVE_PROMPT'], models: ['fake-model'], samplers: ['euler'], schedulers: ['normal'], vramTotalMb: 8151, engineVersion: 'fake-1' }),
  generate: async (req, { signal } = {}) => {
    if (fake.mode === 'hold') await new Promise((resolve, reject) => { fake.gates.push(resolve); signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true }); });
    const w = fake.mode === 'bad' ? req.width / 2 : req.width;
    return { promptId: 'p', images: [png(w, req.height, periodic(w, req.height))] };
  },
  interrupt: async () => ({ queueDeleteAccepted: true, interruptAccepted: true }),
};
const storeB = EetfStore.open({ dbPath: path.join(TMP, 'b', 'eetf.sqlite'), assetRoot: path.join(TMP, 'b', 'root') });
fixtures(storeB);
const apiFake = createEetfRoute(createEetfServices({ store: storeB, enforce, providers: [fakeProvider] }));
const apiDisabled = createEetfRoute(null);
let api = apiUnavailable;
const sourceHashes = [fxA.texture, fxA.pano, fxA.alpha].map(a => hashFile(storeA.files.resolveAssetPath(a.storagePath)));

// ── browser plumbing ──
const PORT = 5263;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/eetf-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-eetf7', plugins: [react()], optimizeDeps: { entries: ['scripts/eetf-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [], legacy: [], eetf: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };
const legacy = {
  '/api/image-generation/providers/status': { ok: true, strictLocal: false, providers: { comfyui: { available: false, endpoint: 'http://127.0.0.1:8188', isLocal: true, classification: 'local', error: 'provider_unavailable' }, cloudflare: { configured: false, classification: 'free_tier', capabilities: {} }, huggingface: { configured: false, classification: 'free_tier', capabilities: {} }, pollinations: { configured: false, classification: 'free_tier', capabilities: {} } } },
  '/api/image-generation/history': { ok: true, generations: [] },
};

async function openPage({ viewport = { width: 1400, height: 950 }, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', async r => {
    const req = r.request(); const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (u.pathname.startsWith('/api/image-generation/eetf')) {
      net.eetf.push(`${req.method()} ${u.pathname}`);
      const res = await api.request(`${u.pathname.replace('/api/image-generation/eetf', '') || '/'}${u.search}`, { method: req.method(), headers: { 'content-type': req.headers()['content-type'] ?? 'application/json' }, ...(req.postDataBuffer() ? { body: req.postDataBuffer() } : {}) });
      return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': res.headers.get('content-type') ?? 'application/json' }, body: Buffer.from(await res.arrayBuffer()) });
    }
    if (legacy[u.pathname]) { net.legacy.push(u.pathname); return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(legacy[u.pathname]) }); }
    return r.fulfill({ status: 404, headers: cors, body: '{}' });
  });
  await ctx.route('**/__eetf', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__eetf`);
  await page.getByRole('dialog', { name: 'Générateur d\'images' }).waitFor({ timeout: 60_000 });
  return { ctx, page };
}
const dialog = (page) => page.getByRole('dialog', { name: 'Générateur d\'images' });
const dialogText = (page) => dialog(page).innerText();
async function noFalseClaims(page, where) {
  const t = await dialogText(page);
  for (const w of FORBIDDEN_CLAIMS) ok(!t.includes(w), `${where}: no "${w}"`);
  ok(!/\bPBR\b/.test(t.replace('aucun badge « PBR » n’est affiché', '')), `${where}: no PBR badge`);
}
async function selectAsset(page, id) { await dialog(page).locator(`[data-asset-id="${id}"]`).click(); }
async function noOverflow(page, label) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dw: document.querySelector('[role="dialog"]').getBoundingClientRect().right }));
  ok(m.sw <= m.iw + 1 && m.dw <= m.iw + 1, `${label}: no horizontal overflow (${JSON.stringify(m)})`);
}

try {
  // ── 1. open, legacy tab intact, tabs, provider unavailable, generation disabled with reason ──
  {
    const { ctx, page } = await openPage();
    ok(await until(() => net.legacy.length >= 2), 'legacy Image tab loads its own endpoints');
    eq(await page.getByRole('tab').count(), 3, 'three tabs');
    eq(await page.getByRole('tab', { name: 'Image' }).getAttribute('aria-selected'), 'true', 'Image tab is the default');
    ok(await dialog(page).getByRole('button', { name: 'Générer', exact: true }).isVisible(), 'legacy generate button present');
    eq(net.eetf.length, 0, 'the Image tab never calls EETF');
    await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
    await page.getByTestId('eetf-textures').waitFor();
    eq(await page.getByTestId('eetf-provider-state').innerText(), 'UNAVAILABLE', 'provider state UNAVAILABLE (not ERROR)');
    ok((await page.getByTestId('eetf-provider-status').innerText()).includes('ComfyUI local non disponible'), 'clear unavailable text');
    const gen = dialog(page).getByRole('button', { name: 'Générer (IA locale)' });
    await dialog(page).getByLabel('Prompt').fill('pavés');
    ok(await gen.isDisabled(), 'AI generation disabled without a local provider');
    ok((await page.getByTestId('eetf-tex-gen-blocked').innerText()).includes('LOCAL_PROVIDER_UNAVAILABLE'), 'reason shown');
    eq(await gen.getAttribute('aria-describedby'), 'eetf-tex-gen-reason', 'reason linked for assistive tech');
    await noFalseClaims(page, 'textures (no material)');
    await page.getByRole('tab', { name: 'Image' }).click();
    ok(await dialog(page).getByText('Prompt', { exact: true }).first().isVisible(), 'back to the legacy tab');
    await ctx.close();
  }

  // ── 2. textures / materials without provider: local operations usable, honest maps, seam, tiling, provenance ──
  {
    const { ctx, page } = await openPage();
    await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
    await selectAsset(page, fxA.texture.id);
    ok(await dialog(page).getByRole('button', { name: 'Créer le matériau' }).isEnabled(), 'local material creation usable without ComfyUI');
    const rough = dialog(page).getByLabel('Roughness (constante 0 à 1)');
    await rough.focus(); const r0 = Number(await rough.inputValue()); await page.keyboard.press('ArrowRight');
    ok(Number(await rough.inputValue()) > r0, 'roughness slider works from the keyboard');
    await dialog(page).getByLabel('Metallic valeur numérique').fill('7');
    eq(await dialog(page).getByLabel('Metallic valeur numérique').inputValue(), '1', 'metallic clamped to [0, 1]');
    ok(await dialog(page).getByRole('checkbox', { name: /Opacité depuis le canal alpha/ }).isDisabled(), 'opacity unavailable without an alpha channel');
    await dialog(page).getByRole('button', { name: 'Créer le matériau' }).click();
    await page.getByTestId('eetf-material').waitFor({ timeout: 30_000 });
    const status = async (role) => page.locator(`[data-map="${role}"]`).getAttribute('data-status');
    eq(await status('BASE_COLOR'), 'DERIVED', 'imported image → DERIVED base colour');
    for (const r of ['NORMAL', 'HEIGHT', 'AMBIENT_OCCLUSION', 'EMISSIVE', 'OPACITY']) eq(await status(r), 'UNSUPPORTED', `${r} UNSUPPORTED`);
    eq(await status('ROUGHNESS'), 'USER_CONSTANT', 'roughness USER_CONSTANT'); eq(await status('METALLIC'), 'USER_CONSTANT', 'metallic USER_CONSTANT');
    ok((await page.locator('[data-map="ROUGHNESS"]').innerText()).includes('pas une carte générée'), 'constant explained');
    eq(await page.getByTestId('eetf-material-status').innerText(), 'Matériau partiel', 'honest material status');
    const seam = await page.getByTestId('eetf-seam').innerText();
    ok(seam.includes('LOW_SEAM') && seam.includes('EETF-SEAM') && seam.includes('pas une garantie'), 'seam score, method and caveat');
    const imgs = page.getByTestId('eetf-tiling').locator('img');
    eq(await imgs.count(), 2, 'source vs tiled preview');
    ok(await until(async () => (await imgs.evaluateAll(list => list.every(i => i.complete && i.naturalWidth > 0)))), 'both images load from Docteur URLs');
    const widths = await imgs.evaluateAll(list => list.map(i => i.naturalWidth));
    eq(widths[1], widths[0] * 2, '2 × 2 preview');
    ok((await imgs.evaluateAll(list => list.map(i => i.src))).every(s => /^http:\/\/127\.0\.0\.1:3001\/api\/image-generation\/eetf\/assets\/[0-9a-f-]{36}\/file$/.test(s)), 'only controlled asset URLs');
    const prov = await page.getByTestId('eetf-provenance').innerText();
    ok(prov.includes('ffmpeg') && prov.includes('CONVERT') && prov.includes('128×128'), 'provenance shown');
    await noFalseClaims(page, 'material');
    // opacity from a real alpha; an alpha channel full of 255 is refused with a clear message
    await selectAsset(page, fxA.alpha.id);
    await dialog(page).getByRole('checkbox', { name: /Opacité depuis le canal alpha/ }).check();
    await dialog(page).getByRole('button', { name: 'Créer le matériau' }).click();
    ok(await until(async () => (await page.locator('[data-map="OPACITY"]').getAttribute('data-status')) === 'FROM_SOURCE_ALPHA'), 'opacity FROM_SOURCE_ALPHA for a real alpha');
    await selectAsset(page, fxA.opaqueAlpha.id);
    await dialog(page).getByRole('checkbox', { name: /Opacité depuis le canal alpha/ }).check();
    await dialog(page).getByRole('button', { name: 'Créer le matériau' }).click();
    ok(await until(async () => (await dialog(page).getByRole('alert').allInnerTexts()).some(t => t.includes('pas de transparence réelle'))), 'opaque alpha refused with a useful message');
    // a local derivation job completes
    await selectAsset(page, fxA.texture.id);
    await dialog(page).getByRole('button', { name: 'Miniature (tâche)' }).click();
    const thumbDone = page.locator('[data-job-status="COMPLETED"]', { hasText: 'Miniature' });
    const reached = await until(async () => (await thumbDone.count()) > 0);
    ok(reached, `thumbnail job reaches COMPLETED (jobs: ${reached ? '' : (await page.getByTestId('eetf-jobs').innerText()).replace(/\s+/g, ' ').slice(0, 400)} | alerts: ${reached ? '' : (await dialog(page).getByRole('alert').allInnerTexts()).join(' / ')})`);
    // hostile asset names and upload
    await page.evaluate(() => { window.__xss = undefined; });
    ok((await dialog(page).locator(`[data-asset-id="${fxA.hostile.id}"]`).innerText()).includes('pierre'), 'hostile name shown as text');
    const file = { name: '<svg onload=alert(1)>.png', mimeType: 'image/png', buffer: png(48, 48, periodic(48, 48)) };
    await dialog(page).locator('input[type="file"]').setInputFiles(file);
    ok(await until(async () => (await dialog(page).locator('.eetf-asset[aria-pressed="true"]').count()) === 1), 'uploaded image selected');
    eq(await page.evaluate(() => window.__xss ?? null), null, 'no injected script ran');
    eq(await page.locator('img[src="x"], [onerror], [onload], script[src]').count(), 0, 'no injected element / handler');
    await ctx.close();
  }

  // ── 3. environments: types, panorama analysis, warnings, refusals, LDR container, skybox + cleanup ──
  {
    const { ctx, page } = await openPage();
    await page.getByRole('tab', { name: 'Environnements' }).click();
    await page.getByTestId('eetf-environments').waitFor();
    const unsupported = await page.getByTestId('eetf-env-unsupported').innerText();
    for (const t of ['HDRI', 'CERTIFIED_EQUIRECTANGULAR', 'CUBEMAP', '3D_SCENE']) ok(unsupported.includes(t), `${t} listed as unsupported`);
    await selectAsset(page, fxA.pano.id);
    await dialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
    const res = page.getByTestId('eetf-env-result');
    await res.waitFor({ timeout: 30_000 });
    const t = await res.innerText();
    ok(t.includes('512×256') && t.includes('2 (écart au 2:1 : 0 %)'), 'dimensions + ratio + deviation');
    ok(t.includes('LOW_SEAM') && t.includes('EETF-SEAM'), 'horizontal seam');
    ok(/haut \d/.test(t) && /bas \d/.test(t), 'pole index');
    ok((await page.getByTestId('eetf-env-warnings').innerText()).includes('NOT_CERTIFIED_EQUIRECTANGULAR'), 'never certified');
    // skybox: bounds, keyboard, cleanup
    const fov = dialog(page).getByLabel('Champ (fov) valeur');
    await fov.fill('500'); eq(await fov.inputValue(), '120', 'fov clamped to 120');
    await fov.fill('5'); eq(await fov.inputValue(), '30', 'fov clamped to 30');
    const viewer = page.getByTestId('eetf-skybox');
    await viewer.waitFor();
    ok((await viewer.innerText()).includes('PREVIEW ONLY') && (await viewer.innerText()).includes('ni une caméra de scène'), 'preview-only wording');
    const canvas = viewer.locator('.eetf-canvas');
    ok(await until(async () => ['ready', 'unavailable'].includes(await canvas.getAttribute('data-state'))), 'viewer settles');
    const webgl = (await canvas.getAttribute('data-state')) === 'ready';
    const yaw = dialog(page).getByLabel('Lacet (yaw) valeur');
    const y0 = Number(await yaw.inputValue());
    await canvas.focus(); await page.keyboard.press('ArrowRight');
    eq(Number(await yaw.inputValue()), y0 + 5, 'arrow key turns the view');
    await dialog(page).getByRole('button', { name: 'Rendu serveur (PREVIEW ONLY)' }).click();
    await page.getByTestId('eetf-sky-view').waitFor({ timeout: 30_000 });
    ok((await page.getByTestId('eetf-sky-view').innerText()).includes('PREVIEW_ONLY'), 'server view labelled');
    // near 2:1 / bad ratio / LDR in EXR / background
    await selectAsset(page, fxA.near.id); await dialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
    ok(await until(async () => (await res.innerText()).includes('NOT_EXACT_2_TO_1')), 'near-2:1 flagged');
    await selectAsset(page, fxA.square.id); await dialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
    ok(await until(async () => (await dialog(page).getByRole('alert').allInnerTexts()).some(x => x.includes('proche du 2:1'))), 'bad ratio refused with a message');
    const exrId = exrJob.outputAssetIds[0];
    await selectAsset(page, exrId); await dialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
    ok(await until(async () => (await res.innerText()).includes('LDR_CONTENT_IN_HDR_CONTAINER')), 'LDR in EXR container shown');
    ok((await dialogText(page)).includes('Aperçu interactif indisponible pour un conteneur EXR'), 'EXR goes through the server render');
    await dialog(page).getByRole('radio', { name: /Arrière-plan/ }).check();
    await selectAsset(page, fxA.texture.id); await dialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
    ok(await until(async () => (await res.innerText()).includes('pas une scène 3D')), 'background is an image, not a 3D scene');
    await noFalseClaims(page, 'environments');
    // close / reopen: every viewer released, focus restored
    const statsBefore = await page.evaluate(() => window.__eetfSkybox ?? { created: 0, disposed: 0 });
    await page.keyboard.press('Escape');
    ok(await until(async () => (await page.getByRole('dialog').count()) === 0), 'Escape closes the dialog');
    const statsAfter = await page.evaluate(() => window.__eetfSkybox ?? { created: 0, disposed: 0 });
    console.log(`# skybox: webgl=${webgl} viewers created=${statsAfter.created} disposed=${statsAfter.disposed}`);
    if (webgl) { ok(statsBefore.created >= 1, 'a WebGL viewer was created'); eq(statsAfter.created, statsAfter.disposed, 'every viewer disposed (no leak)'); }
    else ok(true, 'WebGL unavailable in this browser: fallback text shown (cleanup not applicable)');
    eq(await page.locator('canvas').count(), 0, 'no canvas left after close');
    // the first dialog was mounted at page load (nothing to restore); open it from the button, close it: focus returns there
    await page.locator('#open-imggen').click();
    await dialog(page).waitFor();
    eq(await page.getByRole('tab', { name: 'Image' }).getAttribute('aria-selected'), 'true', 'reopens on the Image tab');
    ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), 'focus moves into the reopened dialog');
    await page.keyboard.press('Escape');
    ok(await until(async () => (await page.getByRole('dialog').count()) === 0), 'closed again');
    eq(await page.evaluate(() => document.activeElement?.id), 'open-imggen', 'focus restored to the opener');
    await ctx.close();
  }

  // ── 4. jobs with the fake provider: QUEUED, RUNNING, cancel (GPU caveat), COMPLETED, FAILED, live region ──
  {
    api = apiFake; fake.mode = 'hold'; fake.gates = [];
    const { ctx, page } = await openPage();
    await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
    await page.getByTestId('eetf-textures').waitFor();
    ok((await page.getByTestId('eetf-provider-status').innerText()).includes('<script>window.__xss=3</script>'), 'hostile provider name rendered as text');
    eq(await page.evaluate(() => window.__xss ?? null), null, 'no script from a provider name');
    const gen = dialog(page).getByRole('button', { name: 'Générer (IA locale)' });
    await dialog(page).getByLabel('Prompt').fill('<b>mousse</b> <img src=x onerror=alert(1)>');
    ok(await gen.isEnabled(), 'generation enabled with a local provider');
    await gen.click();
    ok(await until(async () => (await page.locator('[data-job-status="RUNNING"]').count()) === 1), 'job RUNNING');
    const running = page.locator('[data-job-status="RUNNING"] [role="progressbar"]');
    ok(['true'].includes(await running.getAttribute('aria-busy')), 'aria-busy while running');
    await gen.click();
    ok(await until(async () => (await page.locator('[data-job-status="QUEUED"]').count()) === 1), 'second job QUEUED');
    ok((await page.locator('[data-job-status="QUEUED"]').innerText()).includes('En file d’attente'), 'queued wording');
    await page.locator('[data-job-status="QUEUED"]').getByRole('button', { name: /Annuler/ }).click();
    ok(await until(async () => (await page.locator('[data-job-status="CANCELLED"]').count()) === 1), 'queued job CANCELLED');
    await page.locator('[data-job-status="RUNNING"]').getByRole('button', { name: /Annuler/ }).click();
    ok(await until(async () => (await page.getByTestId('eetf-jobs').innerText()).includes('l’arrêt du GPU n’est pas garanti')), 'GPU stop not guaranteed is said');
    ok(await until(async () => (await page.locator('[data-job-status="CANCELLED"]').count()) === 2), 'running job CANCELLED');
    ok(await until(async () => (await page.getByTestId('eetf-jobs-live').innerText()).length > 0), 'aria-live announcement');
    fake.mode = 'ok';
    await gen.click();
    ok(await until(async () => (await page.locator('[data-job-status="COMPLETED"]').count()) >= 1), 'job COMPLETED');
    fake.mode = 'bad';
    await gen.click();
    ok(await until(async () => (await page.locator('[data-job-status="FAILED"]').count()) === 1), 'job FAILED');
    ok((await page.locator('[data-job-status="FAILED"]').innerText()).includes('Le résultat produit est invalide'), 'error mapped to a useful message');
    const jobsText = await page.getByTestId('eetf-jobs').innerText();
    ok(!/at .*\.js:\d+|[A-Za-z]:\\|SELECT |stack/i.test(jobsText), 'no stack / path / SQL in the UI');
    eq(await page.locator('img[src="x"], [onerror]').count(), 0, 'prompt HTML is never rendered');
    await ctx.close();
    api = apiUnavailable;
  }

  // ── 5. disabled EETF, keyboard / focus trap, responsive, reduced motion ──
  {
    api = apiDisabled;
    const { ctx, page } = await openPage();
    await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
    ok(await until(async () => (await page.getByTestId('eetf-provider-status').innerText()).includes('EETF désactivé')), 'disabled state explained');
    ok(await dialog(page).getByRole('button', { name: 'Générer (IA locale)' }).isDisabled(), 'nothing runnable when disabled');
    await ctx.close();
    api = apiUnavailable;
  }
  {
    const { ctx, page } = await openPage();
    const tabs = page.getByRole('tab');
    await tabs.first().focus(); await page.keyboard.press('ArrowRight');
    eq(await page.getByRole('tab', { name: 'Textures & matériaux' }).getAttribute('aria-selected'), 'true', 'arrow keys move between tabs');
    await page.keyboard.press('End');
    eq(await page.getByRole('tab', { name: 'Environnements' }).getAttribute('aria-selected'), 'true', 'End → last tab');
    let inside = true;
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); inside = inside && await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))); }
    ok(inside, 'focus stays inside the dialog (trap)');
    await ctx.close();
  }
  for (const width of [390, 768, 1400]) {
    const { ctx, page } = await openPage({ viewport: { width, height: 900 } });
    await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
    await selectAsset(page, fxA.texture.id);
    await dialog(page).getByRole('button', { name: 'Créer le matériau' }).click();
    await page.getByTestId('eetf-material').waitFor({ timeout: 30_000 });
    await noOverflow(page, `textures ${width}px`);
    await page.getByRole('tab', { name: 'Environnements' }).click();
    await selectAsset(page, fxA.pano.id);
    await dialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
    await page.getByTestId('eetf-skybox').waitFor({ timeout: 30_000 });
    await noOverflow(page, `environments ${width}px`);
    const box = await page.getByTestId('eetf-skybox').locator('.eetf-canvas').boundingBox();
    ok(box && box.width > 150 && box.width <= width, `skybox usable at ${width}px (${box?.width})`);
    await ctx.close();
  }
  {
    api = apiFake; fake.mode = 'hold'; fake.gates = [];
    const { ctx, page } = await openPage({ reducedMotion: 'reduce' });
    await page.getByRole('tab', { name: 'Environnements' }).click();
    const assets = storeB.listAssets({ limit: 200 });
    await selectAsset(page, assets.find(a => a.width === 512 && a.height === 256).id);
    await dialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
    eq(await page.getByTestId('eetf-skybox').getAttribute('data-reduced-motion'), 'reduce', 'reduced motion detected (no automatic camera motion)');
    await dialog(page).getByLabel('Prompt').fill('ciel');
    await dialog(page).getByRole('button', { name: 'Générer (IA locale)' }).click();
    const bar = page.locator('[data-job-status="RUNNING"] .eetf-progress');
    ok(await until(async () => (await bar.count()) === 1), 'running job visible');
    await dialog(page).getByRole('button', { name: 'Générer (IA locale)' }).click();
    ok(await until(async () => (await page.locator('.eetf-progress.indeterminate > span').count()) >= 1), 'a queued job shows an indeterminate bar');
    const anim = await page.locator('.eetf-progress.indeterminate > span').evaluateAll(list => list.map(e => getComputedStyle(e).animationName));
    ok(anim.every(a => a === 'none'), `no progress animation under reduced motion (${anim})`);
    for (const g of fake.gates) g();
    await ctx.close();
    api = apiUnavailable;
  }

  eq(net.external.length, 0, `no external request (${net.external.join(', ')})`);
  eq(net.errors.length, 0, `no page error (${net.errors.join(' | ')})`);
  eq(JSON.stringify([fxA.texture, fxA.pano, fxA.alpha].map(a => hashFile(storeA.files.resolveAssetPath(a.storagePath)))), JSON.stringify(sourceHashes), 'source assets untouched');
  eq(JSON.stringify(REAL_DB.map(p => (fs.existsSync(p) ? hashFile(p) : 'absent'))), JSON.stringify(realDbBefore), 'user database untouched');
  console.log(`PASS ${assertions} assertions`);
} finally {
  await browser.close();
  await server.close();
  storeA.close(); storeB.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
}
