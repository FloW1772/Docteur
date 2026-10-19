// [EETF V1] EETF-8 — browser suite of the product integrations: the REAL ImageGeneratorModal (EETF tabs + integration
// panel), Media Reader, Media Studio and Neurone image block in Chromium; the REAL EETF route and the REAL Media Studio
// route + service in-process (temporary stores, in-memory SQLite, real FFmpeg, real Root Policy decisions); a temporary
// Neurone image store (same id / MIME rules as lib/image.js, never cortex-server/data/images). External requests are
// aborted and counted. Usage: node scripts/test-eetf8-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { initSqlite } from '../cortex-server/src/lib/sqlite.js';
import { EetfStore } from '../cortex-server/src/lib/eetf-store.js';
import { hashFile } from '../cortex-server/src/lib/eetf-asset-store.js';
import { createEetfRoute, createEetfServices } from '../cortex-server/src/routes/eetf.js';
import { createComfyUiProvider } from '../cortex-server/src/lib/eetf-comfyui-provider.js';
import { enforce } from '../cortex-server/src/lib/root-policy/index.js';
import { createMediaStudioService } from '../cortex-server/src/lib/media-studio.js';
import { createMediaStudioStore } from '../cortex-server/src/lib/media-studio-store.js';
import { createMediaStudioRoute } from '../cortex-server/src/routes/media-studio.js';
import { FORBIDDEN_CLAIMS } from '../src/lib/eetf/ui-model.ts';

initSqlite(':memory:');
let assertions = 0;
const log = [];
const ok = (v, m) => { assert.ok(v, m); assertions += 1; log.push(m); };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; log.push(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(60); } return false; }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const REAL_DB = ['cortex.sqlite', 'cortex.sqlite-wal', 'cortex.sqlite-shm'].map(f => path.resolve('cortex-server', 'data', f));
const REAL_IMAGES = path.resolve('cortex-server', 'data', 'images');
const realDbBefore = REAL_DB.map(p => (fs.existsSync(p) ? hashFile(p) : 'absent'));
const realImagesBefore = fs.existsSync(REAL_IMAGES) ? fs.readdirSync(REAL_IMAGES).length : -1;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eetf8-browser-'));

// ── fixtures ──
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); }
function png(w, h, f) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = f(x, y); for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = p[c]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function noisePng(w, h) { const raw = crypto.randomBytes((w * 3 + 1) * h); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]); }
const T = Math.PI * 2;
const periodic = (w, h, k = 0) => (x, y) => [128 + Math.round(90 * Math.sin(T * x / w)), 128 + Math.round(90 * Math.cos(T * y / h)), 120 + k];
const sky = (w, h) => (x, y) => { const l = Math.sin(Math.PI * (y + 0.5) / h); return [128 + Math.round(100 * Math.sin(T * x / w) * l), 50 + Math.round(150 * y / h), 128 + Math.round(60 * Math.cos(T * x / w) * l)]; };
const HOSTILE = '<img src=x onerror="window.__xss=1">pierre';

// ── EETF (enabled) ──
const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const closedPort = closed.address().port; await new Promise(r => closed.close(r));
const IMAGES = path.join(TMP, 'images'); fs.mkdirSync(IMAGES);
const IMAGE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif)$/i;
const resolveNeuronImage = (id) => (IMAGE_RE.test(id) ? path.join(IMAGES, id) : null);
const store = EetfStore.open({ dbPath: path.join(TMP, 'eetf', 'eetf.sqlite'), assetRoot: path.join(TMP, 'eetf', 'root') });
const services = createEetfServices({ store, enforce, resolveNeuronImage, providers: [createComfyUiProvider({ endpoint: `http://127.0.0.1:${closedPort}`, enforce, probeTimeoutMs: 800 })] });
const reg = (buf, name) => store.registerAsset({ buffer: buf, declaredMime: 'image/png', role: 'SOURCE', displayName: name }).asset;
const texture = reg(png(128, 128, periodic(128, 128)), `${HOSTILE}.png`);
const pano = reg(png(512, 256, sky(512, 256)), 'ciel-panorama.png');
const big = reg(noisePng(1400, 1400), 'gros-bruit.png');
const exr = store.getAsset((await services.derive.run(services.derive.submit({ sourceAssetId: pano.id, operation: 'CONVERT', format: 'EXR' }).id)).outputAssetIds[0]);
const tiff = store.getAsset((await services.derive.run(services.derive.submit({ sourceAssetId: texture.id, operation: 'CONVERT', format: 'TIFF' }).id)).outputAssetIds[0]);
eq(exr.actualFormat, 'EXR', 'fixture: EXR derived (LDR content)'); eq(tiff.actualFormat, 'TIFF', 'fixture: TIFF derived');
ok(big.sizeBytes > 5 * 1024 * 1024, 'fixture: > 5 MB PNG for the Neurone limit');
const eetfApi = createEetfRoute(services);
const disabledApi = createEetfRoute(null);
let api = eetfApi;
const assetPath = (a) => store.files.resolveAssetPath(a.storagePath);
const sourceHashes = () => [texture, pano, exr, tiff].map(a => hashFile(assetPath(a)));
const sourcesBefore = sourceHashes();

// ── Media Studio (real service + route, in-memory SQLite, temp folder) ──
const studioRoot = path.join(TMP, 'studio');
const studio = createMediaStudioService({ rootDir: studioRoot, store: createMediaStudioStore(), enforce, resolveDocteurImage: resolveNeuronImage });
const studioApi = createMediaStudioRoute({ service: studio });
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
ff('-f', 'lavfi', '-i', 'testsrc=size=160x120', '-frames:v', '1', path.join(TMP, 'anim.gif'));
async function studioUpload(projectId, buf, name) {
  const { uploadId } = studio.startUpload(projectId, { name, size: buf.length });
  studio.appendChunk(uploadId, 0, buf);
  return studio.completeUpload(uploadId, {});
}
const studioProject = studio.createProject({ name: 'Studio test' }).project;
const studioPng = png(640, 320, sky(640, 320));
const studioPngAsset = (await studioUpload(studioProject.id, studioPng, 'photo-studio.png')).asset;
const studioGifAsset = (await studioUpload(studioProject.id, fs.readFileSync(path.join(TMP, 'anim.gif')), 'anim.gif')).asset;
eq(studioGifAsset.kind, 'image', 'fixture: GIF image in the studio');
const studioFile = (projectId, a) => path.join(studioRoot, 'projects', projectId, 'assets', a.file);
const studioPngHash = hashFile(studioFile(studioProject.id, studioPngAsset));

// ── Neurone image store (temporary; same rules as lib/image.js: MIME allow-list, 5 MB) ──
const NEURON_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
async function imageApi(req, u) {
  if (req.method() === 'POST' && u.pathname === '/api/image') {
    const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers()['content-type'] }, body: req.postDataBuffer() }).formData();
    const file = fd.get('file');
    const ext = NEURON_MIME[(file?.type ?? '').toLowerCase()];
    if (!ext) return { status: 415, json: { error: 'Type non supporté' } };
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return { status: 413, json: { error: 'Image trop grande (max 5 Mo)' } };
    const id = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(IMAGES, id), buf);
    return { status: 200, json: { id } };
  }
  const m = /^\/api\/image\/([^/]+)$/.exec(u.pathname);
  if (req.method() === 'GET' && m && IMAGE_RE.test(m[1]) && fs.existsSync(path.join(IMAGES, m[1]))) {
    const ext = m[1].split('.').pop();
    return { status: 200, body: fs.readFileSync(path.join(IMAGES, m[1])), type: ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[ext] };
  }
  return { status: 404, json: { error: 'Image introuvable' } };
}
const neuronBytes = png(96, 96, periodic(96, 96, 40));
const neuronImageId = `${crypto.randomUUID()}.png`;
fs.writeFileSync(path.join(IMAGES, neuronImageId), neuronBytes);

// ── browser plumbing ──
const PORT = 5264;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/eetf8-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-eetf8', plugins: [react()], optimizeDeps: { entries: ['scripts/eetf8-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [], eetf: [], unknown: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true' };
const legacy = {
  '/api/image-generation/providers/status': { ok: true, strictLocal: false, providers: { comfyui: { available: false, endpoint: 'http://127.0.0.1:8188', isLocal: true, classification: 'local', error: 'provider_unavailable' }, cloudflare: { configured: false, classification: 'free_tier', capabilities: {} }, huggingface: { configured: false, classification: 'free_tier', capabilities: {} }, pollinations: { configured: false, classification: 'free_tier', capabilities: {} } } },
  '/api/image-generation/history': { ok: true, generations: [] },
};

async function openPage(query, { viewport = { width: 1400, height: 950 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', async r => {
    const req = r.request(); const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const forward = async (app, p) => {
      const headers = {}; for (const k of ['content-type', 'range']) { const v = req.headers()[k]; if (v) headers[k] = v; }
      const body = req.postDataBuffer();
      const res = await app.request(`${p}${u.search}`, { method: req.method(), headers, ...(body ? { body } : {}) });
      const out = { ...cors, 'content-type': res.headers.get('content-type') ?? 'application/json' };
      for (const k of ['content-range', 'accept-ranges', 'x-content-type-options']) if (res.headers.get(k)) out[k] = res.headers.get(k);
      return r.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    };
    if (u.pathname.startsWith('/api/image-generation/eetf')) { const p = u.pathname.replace('/api/image-generation/eetf', '') || '/'; net.eetf.push({ m: req.method(), p, api: api === disabledApi ? 'off' : 'on' }); return forward(api, p); }
    if (u.pathname.startsWith('/api/media-studio/')) return forward(studioApi, u.pathname.replace(/^\/api/, ''));
    if (u.pathname === '/api/image' || u.pathname.startsWith('/api/image/')) {
      const res = await imageApi(req, u);
      return res.json ? r.fulfill({ status: res.status, headers: cors, contentType: 'application/json', body: JSON.stringify(res.json) }) : r.fulfill({ status: res.status, headers: { ...cors, 'content-type': res.type }, body: res.body });
    }
    if (legacy[u.pathname]) return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(legacy[u.pathname]) });
    net.unknown.push(u.pathname);
    return r.fulfill({ status: 404, headers: cors, body: '{}' });
  });
  await ctx.route(u => new URL(u).pathname === '/__eetf8', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__eetf8?${new URLSearchParams(query).toString()}`);
  return { ctx, page };
}
const assetUrl = (id) => `http://127.0.0.1:3001/api/image-generation/eetf/assets/${id}/file`;
const imageUrl = (id) => `http://127.0.0.1:3001/api/image/${id}`;
const genDialog = (page) => page.getByRole('dialog', { name: 'Générateur d\'images' });
const reader = (page) => page.locator('[data-testid="media-reader"]');
async function noHScroll(page, where) { const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); ok(r.sw <= r.iw + 1, `${where}: no horizontal page scroll (${r.sw} ≤ ${r.iw})`); }
async function noForbidden(page, where) { const t = await page.locator('body').innerText(); for (const w of FORBIDDEN_CLAIMS) ok(!t.includes(w), `${where}: no "${w}"`); ok(!/\bTRUE HDR\b|HDRI disponible|cubemap certifiée/.test(t), `${where}: no HDR claim`); }
async function openTexturesWith(page, assetId) {
  await genDialog(page).waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
  await page.locator(`[data-testid="eetf-textures"] .eetf-asset[data-asset-id="${assetId}"]`).click();
  await page.locator('[data-testid="eetf-integrations"]').waitFor();
}

try {
  // ═══ A. EETF asset → Media Reader (native PNG, hostile name, metadata, keyboard) ═══
  {
    const { ctx, page } = await openPage({ view: 'imggen' });
    await openTexturesWith(page, texture.id);
    await until(async () => (await page.locator('[data-testid="eetf-reader-meta"]').count()) > 0);
    eq(await page.locator('[data-testid="eetf-integrations"] [data-testid="eetf-reader-role"]').innerText(), 'SOURCE', 'panel: provenance role shown');
    const open = page.locator('[data-testid="eetf-open-reader"]');
    eq(await open.getAttribute('aria-describedby'), null, 'reader button enabled without a disabled reason');
    await open.focus(); await page.keyboard.press('Enter');
    await reader(page).waitFor();
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'READY'), 'EETF → Media Reader: READY');
    eq(await reader(page).getAttribute('data-kind'), 'image', 'reader kind image');
    eq(await page.locator('[data-testid="eetf-reader-viewer"]').getAttribute('data-native'), 'yes', 'PNG shown natively');
    eq(await page.locator('[data-testid="eetf-reader-image"]').getAttribute('data-shown-asset'), texture.id, 'the asset itself is shown');
    ok(await page.evaluate(() => { const i = document.querySelector('[data-testid="eetf-reader-image"]'); return i.complete && i.naturalWidth === 128; }), 'image decoded by the browser (128 px)');
    ok((await page.locator('[data-testid="media-reader"] [data-testid="eetf-reader-dimensions"]').innerText()).includes('128 × 128'), 'metadata: dimensions');
    ok((await page.locator('[data-testid="media-reader"] [data-testid="eetf-reader-format"]').innerText()).startsWith('PNG'), 'metadata: format');
    eq(await page.locator('[data-testid="media-reader"] [data-testid="eetf-reader-dynamic-range"]').innerText(), 'LDR', 'metadata: dynamic range LDR');
    ok((await page.locator('[data-testid="media-reader"] [data-testid="eetf-reader-provenance"]').innerText()).includes('IMPORT'), 'metadata: provenance');
    const readerText = await reader(page).innerText();
    ok(!/[A-Za-z]:\\|\/Users\/|eetf8-browser-|assets\/[0-9a-f]{2}\/|SELECT /.test(readerText), 'no internal path / SQL in the reader');
    eq(await page.evaluate(() => window.__xss), undefined, 'hostile display name never executed');
    ok(await page.locator('[data-testid="media-reader-send-studio"]').isVisible(), 'native EETF image may be sent to the studio from the reader');
    eq(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'media-reader-close', 'focus moved into the reader');
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="eetf-reader-host"]'))), 'Tab stays inside the reader');
    await page.keyboard.press('Escape');
    ok(await until(async () => (await reader(page).count()) === 0), 'Escape closes the reader');
    ok(await genDialog(page).isVisible(), '…but not the generator dialog');
    eq(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'eetf-open-reader', 'focus restored to the trigger');
    await noForbidden(page, 'A');
    await ctx.close();
  }

  // ═══ B. EXR / TIFF → Media Reader: no native claim, PNG preview through the EETF job system, source unchanged ═══
  {
    const { ctx, page } = await openPage({ view: 'imggen' });
    await openTexturesWith(page, exr.id);
    await until(async () => (await page.locator('[data-testid="eetf-integrations"] [data-testid="eetf-reader-meta"]').count()) > 0);
    ok((await page.locator('[data-testid="eetf-studio-reason"]').innerText()).includes('EXR'), 'EXR → studio refused with a reason (FORMAT_UNSUPPORTED)');
    ok(await page.locator('[data-testid="eetf-send-studio"]').isDisabled(), 'studio button disabled for EXR');
    eq(await page.locator('[data-testid="eetf-send-studio"]').getAttribute('aria-describedby'), 'eetf-int-studio-reason', 'disabled reason linked');
    ok((await page.locator('[data-testid="eetf-neuron-hint"]').innerText()).includes('n’est pas utilisable tel quel'), 'EXR → Neurone: incompatibility explained');
    await page.locator('[data-testid="eetf-open-reader"]').click();
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'READY'), 'EXR reader READY (explains, never spins)');
    eq(await page.locator('[data-testid="eetf-reader-viewer"]').getAttribute('data-native'), 'no', 'EXR not shown natively');
    eq(await page.locator('[data-testid="eetf-reader-image"]').count(), 0, 'no fake <img> of the EXR');
    ok((await page.locator('[data-testid="eetf-reader-preview-note"]').innerText()).includes('n’est pas affiché nativement'), 'honest "not native" note');
    eq(await page.locator('[data-testid="media-reader-send-studio"]').count(), 0, 'reader does not offer EXR to the studio');
    const range = await page.locator('[data-testid="media-reader"] [data-testid="eetf-reader-dynamic-range"]').innerText();
    ok(range.includes('LDR_CONTENT_IN_HDR_CONTAINER') && range.includes('pas un HDRI'), 'EXR labelled LDR content in an HDR container');
    const jobsBefore = store.listJobs({ limit: 200 }).length;
    await page.locator('[data-testid="eetf-reader-create-preview"]').click();
    ok(await until(async () => (await page.locator('[data-testid="eetf-reader-image"]').count()) > 0, 40_000), 'PNG preview produced and shown');
    const shown = await page.locator('[data-testid="eetf-reader-image"]').getAttribute('data-shown-asset');
    ok(shown && shown !== exr.id && store.getAsset(shown).actualFormat === 'PNG' && store.getAsset(shown).role === 'DERIVED', 'preview = a NEW derived PNG asset');
    eq(store.listJobs({ limit: 200 }).length, jobsBefore + 1, 'one DERIVE job of the existing EETF job system');
    ok(store.listVariants(exr.id).some(v => v.variantAssetId === shown && v.operation === 'CONVERT'), 'variant recorded (provenance)');
    ok((await page.locator('[data-testid="eetf-reader-preview-note"]').innerText()).includes('aperçu PNG 8 bits dérivé'), 'preview labelled as a derived 8-bit preview');
    await page.keyboard.press('Escape');
    await page.locator(`[data-testid="eetf-textures"] .eetf-asset[data-asset-id="${tiff.id}"]`).click();
    await until(async () => (await page.locator('[data-testid="eetf-create-preview"]').count()) > 0);
    ok(await page.locator('[data-testid="eetf-create-preview"]').isVisible(), 'TIFF: preview action offered (Chromium cannot show TIFF)');
    await page.locator('[data-testid="eetf-open-reader"]').click();
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'READY'), 'TIFF reader READY');
    eq(await page.locator('[data-testid="eetf-reader-viewer"]').getAttribute('data-native'), 'no', 'TIFF not claimed native');
    await page.keyboard.press('Escape');
    ok(JSON.stringify(sourceHashes()) === JSON.stringify(sourcesBefore), 'B: EETF sources byte-identical');
    await noForbidden(page, 'B');
    await ctx.close();
  }

  // ═══ C. EETF → Media Studio (panel): copy with provenance, dedup by SHA-256, export link ═══
  {
    const { ctx, page } = await openPage({ view: 'imggen' });
    await openTexturesWith(page, pano.id);
    await page.locator('#eetf-int-project').selectOption(studioProject.id);
    await page.locator('[data-testid="eetf-send-studio"]').click();
    ok(await until(async () => /Copié dans le projet « Studio test »/.test(await page.locator('[data-testid="eetf-integration-status"]').innerText())), 'EETF → Media Studio: copied, project named');
    let p = studio.getProject(studioProject.id).project;
    const copied = p.assets.find(a => a.sha256 === pano.sha256);
    ok(copied && copied.source.type === 'eetf' && copied.source.assetId === pano.id && copied.source.role === 'SOURCE', 'studio asset keeps the EETF provenance');
    eq(hashFile(studioFile(studioProject.id, copied)), pano.sha256, 'studio copy byte-identical (asset identity)');
    const n = p.assets.length;
    await page.locator('[data-testid="eetf-send-studio"]').click();
    ok(await until(async () => /Déjà présent dans le projet/.test(await page.locator('[data-testid="eetf-integration-status"]').innerText())), 'second send: already present');
    p = studio.getProject(studioProject.id).project;
    eq(p.assets.length, n, 'dedup: no second studio copy');
    eq(fs.readdirSync(path.join(studioRoot, 'projects', studioProject.id, 'assets')).length, n, 'dedup: no second file on disk');
    const links = store.listAssetLinks(pano.id).filter(l => l.direction === 'EXPORT' && l.system === 'MEDIA_STUDIO');
    eq(links.length, 1, 'one export link (idempotent)');
    eq(links[0].ref.mediaAssetId, copied.id, 'export link names the studio asset');
    ok((await page.locator('[data-testid="eetf-integrations"] [data-testid="eetf-reader-links"]').innerText()).includes('Copié vers Media Studio'), 'panel shows the exchange');
    await ctx.close();
  }

  // ═══ D. Media Studio → EETF + reader→studio with an EETF URL ═══
  {
    const { ctx, page } = await openPage({ view: 'studio' });
    await page.locator('[data-testid="media-studio"]').waitFor({ timeout: 60_000 });
    const pngRow = page.locator('li.ms-asset[data-asset="photo-studio.png"]');
    await pngRow.waitFor();
    const send = pngRow.locator('[data-testid="ms-send-eetf"]');
    ok(await until(async () => !(await send.isDisabled())), 'studio: EETF action enabled (EETF on, PNG)');
    ok((await send.getAttribute('aria-label')).includes('Envoyer photo-studio.png vers EETF'), 'studio: EETF action labelled');
    const gifSend = page.locator('li.ms-asset[data-asset="anim.gif"] [data-testid="ms-send-eetf"]');
    ok(await gifSend.isDisabled(), 'GIF: EETF action disabled');
    const gifReason = await gifSend.getAttribute('aria-describedby');
    ok(gifReason && (await page.locator(`[id="${gifReason}"]`).innerText()).includes('GIF'), 'GIF: reason linked');
    await send.click();
    ok(await until(async () => /a été ajouté à EETF comme source/.test(await page.locator('.tb-notice').innerText().catch(() => ''))), 'Media Studio → EETF: added');
    const imported = store.getAssetBySha(sha(studioPng));
    ok(imported && imported.role === 'SOURCE', 'EETF asset created from the studio bytes');
    const link = store.listAssetLinks(imported.id).find(l => l.direction === 'IMPORT' && l.system === 'MEDIA_STUDIO');
    ok(link && link.ref.projectId === studioProject.id && link.ref.mediaAssetId === studioPngAsset.id && link.verification === 'CONTENT_SHA256_MATCH', 'import link: project + studio asset + hash check');
    await send.click();
    ok(await until(async () => /est déjà dans EETF/.test(await page.locator('.tb-notice').innerText().catch(() => ''))), 'second send: already in EETF (dedup)');
    eq(store.listAssets({ limit: 200 }).filter(a => a.sha256 === sha(studioPng)).length, 1, 'one EETF asset for the content');
    eq(hashFile(studioFile(studioProject.id, studioPngAsset)), studioPngHash, 'studio source unchanged');
    ok((await page.locator('li.ms-asset [data-testid="ms-asset-source"]').allInnerTexts()).includes('EETF SOURCE'), 'studio lists the EETF provenance');
    await ctx.close();
  }
  {
    // reader → studio with an EETF asset URL (the App path): EETF provenance, not a plain "media-reader" link
    const { ctx, page } = await openPage({ view: 'reader', url: assetUrl(texture.id), title: 'texture' });
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'READY'), 'reader on an EETF URL (App path) READY');
    await page.locator('[data-testid="media-reader-send-studio"]').click();
    await page.locator('[data-testid="media-studio"]').waitFor({ timeout: 30_000 });
    ok(await until(() => studio.listProjects().some(pr => studio.getProject(pr.id).project.assets.some(a => a.sha256 === texture.sha256 && a.source.type === 'eetf'))), 'reader → studio: EETF provenance kept');
    ok(await until(() => store.listAssetLinks(texture.id).some(l => l.direction === 'EXPORT' && l.system === 'MEDIA_STUDIO')), 'reader → studio: export link recorded');
    await ctx.close();
  }

  // ═══ E. EETF → Neurone (image block « Depuis EETF »), then Neurone image → reader → EETF ═══
  {
    const { ctx, page } = await openPage({ view: 'neuron' });
    await page.locator('[data-testid="image-block-from-eetf"]').click();
    const picker = page.locator('[data-testid="eetf-neuron-picker"]');
    await picker.waitFor();
    ok(await until(async () => (await picker.locator(`[data-asset-id="${texture.id}"]`).count()) > 0), 'picker lists EETF assets');
    ok(await picker.locator(`[data-asset-id="${exr.id}"]`).isDisabled(), 'EXR not insertable into a neuron');
    ok((await picker.locator(`[id="eetf-np-reason-${exr.id}"]`).innerText()).includes('aperçu PNG'), 'EXR: reason shown');
    ok(await picker.locator(`[data-asset-id="${big.id}"]`).isDisabled(), '> 5 MB: not insertable');
    ok((await picker.locator(`[id="eetf-np-reason-${big.id}"]`).innerText()).includes('5 Mo'), '> 5 MB: reason shown');
    const before = fs.readdirSync(IMAGES).length;
    await picker.locator(`[data-asset-id="${texture.id}"]`).click();
    ok(await until(async () => (await page.evaluate(() => window.__eetf8.blocks[0].content)) !== ''), 'EETF → Neurone: image block filled');
    const imageId = await page.evaluate(() => window.__eetf8.blocks[0].content);
    ok(/^[0-9a-f-]{36}\.png$/.test(imageId), 'block content = a Neurone image id (contract unchanged)');
    eq(fs.readdirSync(IMAGES).length, before + 1, 'one copy in the Neurone image store');
    eq(hashFile(path.join(IMAGES, imageId)), texture.sha256, 'Neurone copy byte-identical (asset identity)');
    ok(await until(() => store.listAssetLinks(texture.id).some(l => l.direction === 'EXPORT' && l.system === 'NEURON_IMAGE' && l.ref.imageId === imageId && l.verification === 'SERVER_RESOLVED')), 'export link verified by the server');
    ok(await page.locator(`img[src="${imageUrl(imageId)}"]`).first().isVisible(), 'neuron shows the image');
    // Neurone image → Media Reader: provenance + "use as EETF source"
    await page.locator('[data-testid="image-block-open-reader"]').click();
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'READY'), 'Neurone image opened in the reader');
    const strip = page.locator('[data-testid="eetf-neuron-strip"]');
    await strip.waitFor();
    ok(await until(async () => (await page.locator('[data-testid="eetf-neuron-provenance"]').count()) > 0), 'reader shows the EETF provenance of the Neurone image');
    ok((await page.locator('[data-testid="eetf-neuron-provenance"]').innerText()).includes(texture.id.slice(0, 8)), 'provenance names the EETF asset');
    await page.locator('[data-testid="eetf-neuron-send"]').click();
    ok(await until(async () => /déjà présente dans EETF/.test(await page.locator('[data-testid="eetf-neuron-status"]').innerText())), 'same bytes back to EETF: existing asset (dedup)');
    await page.keyboard.press('Escape');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage({ view: 'neuron', image: neuronImageId });
    await page.locator('[data-testid="image-block-open-reader"]').click();
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'READY'), 'second Neurone image in the reader');
    ok(await until(async () => !(await page.locator('[data-testid="eetf-neuron-send"]').isDisabled())), 'Neurone → EETF action enabled');
    await page.locator('[data-testid="eetf-neuron-send"]').click();
    ok(await until(async () => /ajoutée à EETF comme source/.test(await page.locator('[data-testid="eetf-neuron-status"]').innerText())), 'Neurone → EETF: new source asset');
    eq(hashFile(path.join(IMAGES, neuronImageId)), sha(neuronBytes), 'Neurone source unchanged');
    await ctx.close();
  }

  // ═══ F. texture / environment source selection with integrated assets (V1 rules unchanged) ═══
  {
    const fromNeuron = store.getAssetBySha(sha(neuronBytes));
    ok(fromNeuron && store.listAssetLinks(fromNeuron.id).some(l => l.direction === 'IMPORT' && l.system === 'NEURON_IMAGE' && l.verification === 'SERVER_RESOLVED'), 'Neurone import link (server-resolved)');
    const { ctx, page } = await openPage({ view: 'imggen' });
    await openTexturesWith(page, fromNeuron.id);
    await page.getByRole('button', { name: 'Créer le matériau' }).click();
    await page.locator('[data-testid="eetf-material"]').waitFor({ timeout: 40_000 });
    for (const role of ['NORMAL', 'HEIGHT', 'AMBIENT_OCCLUSION', 'EMISSIVE']) eq(await page.locator(`[data-testid="eetf-material"] tr[data-map="${role}"]`).getAttribute('data-status'), 'UNSUPPORTED', `texture source from a neuron: ${role} stays UNSUPPORTED`);
    eq(await page.locator('[data-testid="eetf-material"] tr[data-map="BASE_COLOR"]').getAttribute('data-status'), 'DERIVED', 'base color DERIVED (normalised copy)');
    ok(await until(async () => (await page.locator('[data-testid="eetf-integrations"] [data-testid="eetf-reader-classification"]').innerText().catch(() => '')).length > 0), 'classification rendered');
    await page.locator(`[data-testid="eetf-textures"] .eetf-asset[data-asset-id="${pano.id}"]`).click();
    await page.locator(`[data-testid="eetf-textures"] .eetf-asset[data-asset-id="${fromNeuron.id}"]`).click();
    ok(await until(async () => (await page.locator('[data-testid="eetf-integrations"] [data-testid="eetf-reader-classification"]').innerText()).includes('Texture — Base Color')), 'classification: Texture — Base Color');
    // environment source selection: the studio-imported 2:1 image stays a non-certified panorama reference
    const fromStudio = store.getAssetBySha(sha(studioPng));
    await page.getByRole('tab', { name: 'Environnements' }).click();
    const panoBtn = page.locator(`.eetf-asset[data-asset-id="${pano.id}"]`).first();
    await panoBtn.waitFor();
    await panoBtn.click();
    ok(await page.locator('[data-testid="eetf-integrations"]').isVisible(), 'integration panel on the Environments tab');
    const envTypes = await page.locator('select').evaluateAll(sels => sels.flatMap(s => [...s.options].map(o => o.value)));
    for (const t of ['HDRI', 'CUBEMAP', '3D_SCENE', 'CERTIFIED_EQUIRECTANGULAR']) ok(!envTypes.includes(t), `environment types never offer ${t}`);
    ok(fromStudio.width === 640 && fromStudio.height === 320, 'studio-imported asset is a 2:1 image');
    const small = reg(png(320, 160, sky(320, 160)), 'petit-panorama.png');
    await services.environments.create('PANORAMA_REFERENCE', small.id).then(() => ok(false, 'small panorama must be refused'), (e) => eq(e.code, 'EETF_PANORAMA_TOO_SMALL', 'V1 panorama minimum width not relaxed'));
    const env = await services.environments.create('PANORAMA_REFERENCE', fromStudio.id);
    const envView = services.environments.getEnvironment(env.id);
    ok(envView.projection === 'PANORAMA_2_1_REFERENCE' && !envView.labels.includes('CERTIFIED_EQUIRECTANGULAR'), 'studio 2:1 image → reference only, never certified');
    ok((envView.report?.warnings ?? envView.labels).includes('NOT_CERTIFIED_EQUIRECTANGULAR') || envView.labels.includes('NOT_CERTIFIED_EQUIRECTANGULAR'), 'NOT_CERTIFIED_EQUIRECTANGULAR kept');
    await noForbidden(page, 'F');
    await ctx.close();
  }

  // ═══ G. missing asset / deleted source / unsafe URLs ═══
  {
    const { ctx, page } = await openPage({ view: 'reader', url: assetUrl(crypto.randomUUID()) });
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'ERROR'), 'missing EETF asset → ERROR');
    eq(await page.locator('[data-testid="media-reader-message"]').innerText(), 'Asset introuvable.', 'missing asset: clear message (ASSET_NOT_FOUND)');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage({ view: 'reader', url: `${assetUrl(texture.id)}?x=1` });
    ok(await until(async () => ['UNSUPPORTED', 'ERROR'].includes(await reader(page).getAttribute('data-phase'))), 'EETF route with a query string is not an EETF asset');
    eq(await page.locator('[data-testid="eetf-reader-viewer"]').count(), 0, 'no EETF viewer for a decorated URL');
    await ctx.close();
  }
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:image/png;base64,iVBORw0KGgo=', 'http://127.0.0.1:8188/view?filename=x.png', 'https://evil.example/x.png']) {
    const { ctx, page } = await openPage({ view: 'reader', url: bad });
    await reader(page).waitFor();
    const phase = await reader(page).getAttribute('data-phase');
    if (bad.startsWith('https://')) {
      ok(await until(async () => ['ERROR', 'UNSUPPORTED'].includes(await reader(page).getAttribute('data-phase')) || (await page.locator('[data-testid="eetf-reader-viewer"]').count()) === 0), `${bad}: never an EETF viewer`);
      eq(await page.locator('[data-testid="eetf-neuron-strip"]').count(), 0, `${bad}: no EETF action on a remote image`);
    } else {
      eq(phase, 'ERROR', `${bad.slice(0, 24)}: refused by the reader`);
    }
    await ctx.close();
  }
  {
    // deleted source: the studio file disappears before the user sends it to EETF
    const victim = (await studioUpload(studioProject.id, png(64, 32, periodic(64, 32, 7)), 'supprimee.png')).asset;
    fs.rmSync(studioFile(studioProject.id, victim));
    const { ctx, page } = await openPage({ view: 'studio' });
    const row = page.locator('li.ms-asset[data-asset="supprimee.png"]');
    await row.waitFor({ timeout: 60_000 });
    const n = store.listAssets({ limit: 200 }).length;
    await until(async () => !(await row.locator('[data-testid="ms-send-eetf"]').isDisabled()));
    await row.locator('[data-testid="ms-send-eetf"]').click();
    ok(await until(async () => /Source indisponible/.test(await page.locator('.tb-error').innerText().catch(() => ''))), 'deleted source → SOURCE_UNAVAILABLE message');
    eq(store.listAssets({ limit: 200 }).length, n, 'nothing stored for a deleted source');
    await ctx.close();
  }

  // ═══ H. EETF disabled: every surface says why, no bypass ═══
  api = disabledApi;
  const disabledStart = net.eetf.length;
  {
    const { ctx, page } = await openPage({ view: 'imggen' });
    await genDialog(page).waitFor({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
    ok(await until(async () => /EETF désactivé/.test(await genDialog(page).innerText())), 'generator: EETF disabled shown');
    eq(await page.locator('[data-testid="eetf-integrations"]').count(), 0, 'no integration action without an asset (disabled)');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage({ view: 'studio' });
    await page.locator('[data-testid="media-studio"]').waitFor({ timeout: 60_000 });
    await page.locator('[data-testid="ms-eetf-disabled"]').waitFor();
    const send = page.locator('li.ms-asset[data-asset="photo-studio.png"] [data-testid="ms-send-eetf"]');
    ok(await send.isDisabled(), 'studio: EETF action disabled');
    eq(await send.getAttribute('aria-describedby'), 'ms-eetf-disabled', 'studio: disabled reason linked');
    ok((await page.locator('#ms-eetf-disabled').innerText()).includes('certification'), 'studio: reason readable');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage({ view: 'neuron' });
    await page.locator('[data-testid="image-block-from-eetf"]').click();
    await page.locator('[data-testid="eetf-neuron-picker-disabled"]').waitFor();
    ok((await page.locator('[data-testid="eetf-neuron-picker-disabled"]').innerText()).includes('désactivé'), 'neuron picker: disabled explained');
    await page.locator('[data-testid="eetf-neuron-picker"] button').first().focus();
    await page.keyboard.press('Escape');
    ok(await until(async () => (await page.locator('[data-testid="eetf-neuron-picker"]').count()) === 0), 'neuron picker: Escape closes it');
    eq(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'image-block-from-eetf', 'neuron picker: focus back on its toggle');
    eq(await page.locator('[data-testid="eetf-neuron-picker"] .eetf-asset').count(), 0, 'neuron picker: nothing to insert');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage({ view: 'reader', url: assetUrl(texture.id) });
    ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'UNSUPPORTED'), 'reader on an EETF asset while disabled → UNSUPPORTED');
    ok((await page.locator('[data-testid="media-reader-message"]').innerText()).includes('EETF est désactivé'), 'reader: EETF_DISABLED message');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage({ view: 'reader', url: imageUrl(neuronImageId) });
    ok(await until(async () => (await page.locator('[data-testid="eetf-neuron-strip"]').getAttribute('data-enabled').catch(() => null)) === 'false'), 'Neurone image strip: EETF disabled');
    ok(await page.locator('[data-testid="eetf-neuron-send"]').isDisabled(), 'Neurone → EETF disabled');
    eq(await page.locator('[data-testid="eetf-neuron-send"]').getAttribute('aria-describedby'), 'eetf-neuron-reason', 'reason linked');
    await ctx.close();
  }
  const disabledCalls = net.eetf.slice(disabledStart);
  eq(disabledCalls.filter(c => c.api !== 'off').length, 0, 'disabled phase: every EETF call hit the closed route');
  eq(disabledCalls.filter(c => c.m !== 'GET').length, 0, 'disabled phase: no mutating EETF call attempted (no gate bypass)');
  api = eetfApi;

  // ═══ I. responsive 390 / 768 / 1400 ═══
  for (const width of [390, 768, 1400]) {
    const viewport = { width, height: 900 };
    {
      const { ctx, page } = await openPage({ view: 'imggen' }, { viewport });
      await openTexturesWith(page, texture.id);
      await noHScroll(page, `imggen ${width}`);
      const box = await page.locator('[data-testid="eetf-integrations"]').boundingBox();
      ok(box && box.x >= 0 && box.x + box.width <= width + 1, `integration panel inside the viewport at ${width}`);
      await page.locator('[data-testid="eetf-open-reader"]').click();
      ok(await until(async () => (await reader(page).getAttribute('data-phase')) === 'READY'), `reader READY at ${width}`);
      await noHScroll(page, `reader ${width}`);
      const meta = await page.locator('[data-testid="media-reader"] [data-testid="eetf-reader-meta"]').boundingBox();
      ok(meta && meta.x >= 0 && meta.x + meta.width <= width + 1, `metadata inside the viewport at ${width}`);
      await ctx.close();
    }
    {
      const { ctx, page } = await openPage({ view: 'neuron' }, { viewport });
      await page.locator('[data-testid="image-block-from-eetf"]').click();
      await page.locator('[data-testid="eetf-neuron-picker"] .eetf-asset').first().waitFor();
      await noHScroll(page, `neuron picker ${width}`);
      await ctx.close();
    }
    {
      const { ctx, page } = await openPage({ view: 'studio' }, { viewport });
      await page.locator('li.ms-asset[data-asset="photo-studio.png"] [data-testid="ms-send-eetf"]').waitFor({ timeout: 60_000 });
      await noHScroll(page, `studio ${width}`);
      await ctx.close();
    }
  }

  // ═══ K. [EETF-CERT] truncated upload through the picker; skybox open / close cycles release everything ═══
  {
    const { ctx, page } = await openPage({ view: 'imggen' });
    await genDialog(page).waitFor({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Textures & matériaux' }).click();
    const n0 = store.listAssets({ limit: 500 }).length;
    const truncatedPng = png(64, 64, periodic(64, 64)).subarray(0, 80);
    await page.locator('[data-testid="eetf-textures"] input[type="file"]').setInputFiles({ name: 'tronque.png', mimeType: 'image/png', buffer: truncatedPng });
    ok(await until(async () => (await page.locator('[data-testid="eetf-textures"] .eetf-error[role="alert"]').allInnerTexts()).some(t => t.includes('corrompue'))), 'CERT: truncated PNG upload → « Image corrompue ou illisible »');
    eq(store.listAssets({ limit: 500 }).length, n0, 'CERT: no asset for a truncated upload');
    eq(fs.readdirSync(path.join(TMP, 'eetf', 'root', 'tmp')).length, 0, 'CERT: no check file left in tmp/');
    await page.getByRole('tab', { name: 'Environnements' }).click();
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (cycle > 1) { await page.locator('#open-imggen').click(); await genDialog(page).waitFor(); await page.getByRole('tab', { name: 'Environnements' }).click(); }
      await page.locator(`.eetf-asset[data-asset-id="${pano.id}"]`).first().click();
      await genDialog(page).getByRole('button', { name: 'Analyser et créer' }).click();
      const canvas = page.getByTestId('eetf-skybox').locator('.eetf-canvas');
      ok(await until(async () => ['ready', 'unavailable'].includes(await canvas.getAttribute('data-state').catch(() => null)), 40_000), `CERT cycle ${cycle}: skybox viewer settles`);
      await page.keyboard.press('Escape');
      ok(await until(async () => (await genDialog(page).count()) === 0), `CERT cycle ${cycle}: dialog closed`);
      eq(await page.locator('canvas').count(), 0, `CERT cycle ${cycle}: no canvas left`);
      const st = await page.evaluate(() => window.__eetfSkybox ?? { created: 0, disposed: 0 });
      eq(st.created, st.disposed, `CERT cycle ${cycle}: every WebGL viewer disposed (${st.created})`);
    }
    await ctx.close();
  }

  // ═══ J. global checks ═══
  ok(JSON.stringify(sourceHashes()) === JSON.stringify(sourcesBefore), 'EETF sources byte-identical after every integration');
  eq(hashFile(studioFile(studioProject.id, studioPngAsset)), studioPngHash, 'studio source byte-identical');
  // the only external attempt allowed is the remote image the security case opens ON PURPOSE in the Media Reader (aborted)
  eq(net.external.filter(u => u !== 'https://evil.example/x.png').length, 0, `no external request from EETF-8 (${net.external.join(', ')})`);
  ok(!net.eetf.some(c => /evil.example/.test(c.p)), 'a remote URL never reaches EETF');
  eq(net.errors.length, 0, `no page error (${net.errors.join(' | ')})`);
  ok(REAL_DB.map(p => (fs.existsSync(p) ? hashFile(p) : 'absent')).every((h, i) => h === realDbBefore[i]), 'real user DB untouched');
  eq(fs.existsSync(REAL_IMAGES) ? fs.readdirSync(REAL_IMAGES).length : -1, realImagesBefore, 'real Neurone image folder untouched');
  ok(!fs.existsSync(path.resolve('cortex-server', 'data', 'eetf')), 'no EETF folder in the user data directory');
  console.log(`EETF-8 browser: ${assertions} assertions PASS`);
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  store.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
  if (net.unknown.length) console.log('unknown API paths (404):', [...new Set(net.unknown)].join(', '));
}
