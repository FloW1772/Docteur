// Document Toolbox PDF V1 — REAL DocumentToolboxModal against the REAL toolbox route in-process
// (pdf-parse/pdfjs + pdf-lib), real local OCR (public/tesseract assets), external network aborted.
// Usage: node scripts/test-document-toolbox-browser.mjs
import '../cortex-server/test-setup.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createDocumentToolboxRoute } from '../cortex-server/src/routes/document-toolbox.js';
import { extractText, inspectPdf } from '../cortex-server/src/lib/document-toolbox.js';

const requireCs = createRequire(new URL('../cortex-server/package.json', import.meta.url));
const { PDFDocument, StandardFonts } = requireCs('pdf-lib');
const { createCanvas } = requireCs('@napi-rs/canvas');

let assertions = 0;
const ok = (v, m) => { assert.ok(v, m); assertions += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); assertions += 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(60); } return false; }

async function makePdf(pages, prefix, size = 24) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i += 1) doc.addPage([420, 300]).drawText(`${prefix} ${i}`, { x: 30, y: 140, size, font });
  doc.setTitle(`${prefix} titre`);
  return Buffer.from(await doc.save());
}
// Hand-built PDF declaring an /Encrypt dictionary in its trailer.
function encryptedPdf() {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>', '<< /Filter /Standard /V 1 /R 2 /O <' + '00'.repeat(32) + '> /U <' + '00'.repeat(32) + '> /P -4 >>'];
  const NL = String.fromCharCode(10);
  let out = '%PDF-1.4' + NL;
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += (i + 1) + ' 0 obj' + NL + o + NL + 'endobj' + NL; });
  const xref = out.length;
  out += 'xref' + NL + '0 ' + (objs.length + 1) + NL + '0000000000 65535 f ' + NL + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n ' + NL).join('');
  out += 'trailer' + NL + '<< /Size ' + (objs.length + 1) + ' /Root 1 0 R /Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>' + NL + 'startxref' + NL + xref + NL + '%%EOF' + NL;
  return Buffer.from(out, 'latin1');
}
const png = () => { const c = createCanvas(60, 40); const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 60, 40); return c.toBuffer('image/png'); };

const api = createDocumentToolboxRoute();
const PORT = 5255;
const html = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/document-toolbox-harness.jsx");mount();</script>';
const server = await createServer({ configFile: false, cacheDir: '.tmp/vite-document-toolbox', plugins: [react()], optimizeDeps: { entries: ['scripts/document-toolbox-harness.jsx'] }, server: { watch: null, host: '127.0.0.1', port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const net = { errors: [], external: [] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-allow-private-network': 'true', 'access-control-expose-headers': '*' };

async function openPage(viewport = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.route(u => !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname), r => { net.external.push(r.request().url()); return r.abort(); });
  await ctx.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => ['content-type', 'x-file-name', 'content-length'].includes(k)));
    const body = req.postDataBuffer();
    const res = await api.request(`${u.pathname.replace(/^\/api/, '')}${u.search}`, { method: req.method(), headers, ...(body ? { body } : {}) });
    const outHeaders = { ...cors };
    for (const k of ['content-type', 'content-disposition']) if (res.headers.get(k)) outHeaders[k] = res.headers.get(k);
    return route.fulfill({ status: res.status, headers: outHeaders, body: Buffer.from(await res.arrayBuffer()) });
  });
  await ctx.route('**/__tb', r => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => net.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__tb`);
  await page.getByRole('dialog', { name: 'Atelier PDF' }).waitFor({ timeout: 30_000 });
  return { ctx, page };
}
const fileInput = (page) => page.getByLabel('Fichiers à ajouter');
const docItem = (page, name) => page.locator(`[data-doc="${name}"]`);
async function backendDoc(name) { const r = await api.request('/document-toolbox/files'); return (await r.json()).docs.filter(d => d.name === name).at(-1); }
async function backendBytes(id) { return Buffer.from(await (await api.request(`/document-toolbox/files/${id}/download`)).arrayBuffer()); }
const texts = async (id) => (await extractText(await backendBytes(id))).pages.map(p => p.text.replace(/\s+/g, ' ').trim());
async function act(page, name) { await page.getByRole('button', { name, exact: true }).click(); }
async function waitNotice(page) { return until(async () => (await page.locator('.tb-notice').innerText().catch(() => '')).includes('nouveau(x) document(s)')); }

let failed = null;
try {
  const { ctx, page } = await openPage();
  ok(await page.getByText('Ajoutez un PDF').isVisible(), 'empty state');
  const srcA = await makePdf(3, 'Alpha');
  await fileInput(page).setInputFiles({ name: '../../secret/evil.pdf', mimeType: 'application/pdf', buffer: srcA });
  await docItem(page, 'evil.pdf').waitFor();
  ok(true, 'hostile path stripped from the name');
  ok(await until(async () => (await page.locator('.tb-page').count()) === 3), '3 pages listed');
  ok(await until(() => page.locator('.tb-page img').first().evaluate(img => img.complete && img.naturalWidth > 0)), 'thumbnail rendered locally');
  const src = await backendDoc('evil.pdf');

  // Extract pages 1 and 3 → new document, source untouched.
  await page.getByLabel('Sélectionner la page 1').check();
  await page.getByLabel('Sélectionner la page 3').check();
  await act(page, 'Extraire');
  ok(await waitNotice(page), 'extract produced a new document');
  const extracted = await backendDoc('evil-extrait.pdf');
  eq(JSON.stringify(await texts(extracted.id)), JSON.stringify(['Alpha 1', 'Alpha 3']));
  ok((await docItem(page, 'evil-extrait.pdf').innerText()).includes('nouveau'), 'output flagged as new');
  ok((await backendBytes(src.id)).equals(srcA), 'source byte-identical');

  // Back to the source; reorder with the keyboard (move page 1 down) then apply.
  await docItem(page, 'evil.pdf').locator('.tb-doc-main').click();
  ok(await until(async () => (await page.locator('.tb-page').count()) === 3));
  const down = page.getByRole('button', { name: 'Descendre la page 1' });
  await down.focus();
  await page.keyboard.press('Enter');
  ok(await page.getByRole('button', { name: 'Appliquer le nouvel ordre' }).isEnabled(), 'reorder pending');
  await act(page, 'Appliquer le nouvel ordre');
  ok(await waitNotice(page));
  eq(JSON.stringify(await texts((await backendDoc('evil-reordonne.pdf')).id)), JSON.stringify(['Alpha 2', 'Alpha 1', 'Alpha 3']));

  // Rotate, delete, duplicate on the source.
  for (const [button, outName, expected] of [
    ['90°', 'evil-rotation.pdf', null],
    ['Supprimer', 'evil-pages-supprimees.pdf', ['Alpha 1', 'Alpha 3']],
    ['Dupliquer', 'evil-pages-dupliquees.pdf', ['Alpha 1', 'Alpha 2', 'Alpha 2', 'Alpha 3']],
  ]) {
    await docItem(page, 'evil.pdf').locator('.tb-doc-main').click();
    ok(await until(async () => (await page.locator('.tb-head h3').innerText()) === 'evil.pdf'));
    await page.getByLabel('Sélectionner la page 2').check();
    await page.getByRole('button', { name: button }).click();
    ok(await waitNotice(page), button);
    const out = await backendDoc(outName);
    if (expected) eq(JSON.stringify(await texts(out.id)), JSON.stringify(expected), button);
    else {
      eq((await inspectPdf(await backendBytes(out.id))).pages[1].rotation, 90, 'rotation applied');
      ok(await until(async () => (await page.locator('.tb-page[data-page="2"] .tb-page-num').innerText().catch(() => '')).includes('90°')), 'rotation shown on the new document');
    }
  }

  // Split by ranges, metadata, watermark, text, PDF → images, optimisation (limited).
  await docItem(page, 'evil.pdf').locator('.tb-doc-main').click();
  await page.getByRole('button', { name: 'Séparer…' }).click();
  await page.getByLabel('Plages de pages').fill('1-2, 3');
  await act(page, 'Séparer selon les plages');
  ok(await until(async () => Boolean(await backendDoc('evil-p3-3.pdf'))), 'split outputs');
  eq((await backendDoc('evil-p1-2.pdf')).pageCount, 2);
  await docItem(page, 'evil.pdf').locator('.tb-doc-main').click();
  await page.getByRole('button', { name: 'Métadonnées…' }).click();
  await page.getByLabel('Titre').fill('Titre modifié');
  await page.getByLabel('Auteur').fill('Docteur');
  await act(page, 'Créer une copie avec ces métadonnées');
  ok(await waitNotice(page));
  const meta = (await inspectPdf(await backendBytes((await backendDoc('evil-metadonnees.pdf')).id))).metadata;
  eq(meta.title, 'Titre modifié'); eq(meta.author, 'Docteur');
  await docItem(page, 'evil.pdf').locator('.tb-doc-main').click();
  await page.getByRole('button', { name: 'Filigrane…' }).click();
  await page.getByLabel('Texte du filigrane').fill('BROUILLON');
  await page.getByRole('button', { name: /^Appliquer à toutes les pages/ }).click();
  ok(await waitNotice(page));
  ok((await texts((await backendDoc('evil-filigrane.pdf')).id)).every(t => t.includes('BROUILLON')), 'watermark on every page');
  await docItem(page, 'evil.pdf').locator('.tb-doc-main').click();
  await act(page, 'Texte');
  ok(await until(async () => (await page.getByRole('region', { name: 'Texte du document' }).innerText().catch(() => '')).includes('Alpha 2')), 'text displayed');
  await page.getByLabel('Sélectionner la page 2').check();
  await act(page, 'En images');
  ok(await waitNotice(page));
  ok(await until(async () => Boolean(await backendDoc('evil-page-2.png'))), 'PDF → image');
  await act(page, 'Optimiser (limité)');
  ok(await until(async () => (await page.locator('.tb-notice').innerText().catch(() => '')).includes('COMPRESSION_LIMITED')), 'compression honestly limited');

  // Merge two PDFs and images → PDF (picked in the list).
  await fileInput(page).setInputFiles([
    { name: 'beta.pdf', mimeType: 'application/pdf', buffer: await makePdf(2, 'Beta') },
    { name: 'photo.png', mimeType: 'image/png', buffer: png() },
  ]);
  await docItem(page, 'photo.png').waitFor();
  await page.getByLabel('Sélectionner evil.pdf').check();
  await page.getByLabel('Sélectionner beta.pdf').check();
  await page.getByRole('button', { name: 'Fusionner (2)' }).click();
  ok(await waitNotice(page));
  eq(JSON.stringify(await texts((await backendDoc('evil-fusion.pdf')).id)), JSON.stringify(['Alpha 1', 'Alpha 2', 'Alpha 3', 'Beta 1', 'Beta 2']));
  await page.getByLabel('Sélectionner photo.png').check();
  await page.getByRole('button', { name: 'Images → PDF (1)' }).click();
  ok(await waitNotice(page));
  eq((await backendDoc('photo-images.pdf')).pageCount, 1);

  // Download: the browser gets exactly the source bytes under the safe name.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Télécharger evil.pdf' }).click()]);
  eq(download.suggestedFilename(), 'evil.pdf');
  ok(Buffer.from(await (await import('node:fs')).promises.readFile(await download.path())).equals(srcA), 'downloaded source unchanged');

  // Local OCR on a page rendered by the server (tesseract assets from /tesseract, no CDN).
  await fileInput(page).setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: await makePdf(1, 'DOCTEUR', 56) });
  ok(await until(async () => (await page.locator('.tb-head h3').innerText().catch(() => '')) === 'scan.pdf'));
  await page.getByLabel('Sélectionner la page 1').check();
  await act(page, 'OCR (local)');
  ok(await until(async () => /DOCTEUR/i.test(await page.getByRole('region', { name: 'Texte du document' }).innerText().catch(() => '')), 90_000), 'OCR read the page locally');

  // Hostile uploads: corrupt and encrypted PDFs are explained, with Retry.
  await fileInput(page).setInputFiles({ name: 'casse.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3_000, 0x41)]) });
  ok(await until(async () => (await page.getByRole('alert').innerText().catch(() => '')).includes('PDF illisible ou corrompu')), 'corrupt PDF explained');
  ok(await page.getByRole('button', { name: 'Réessayer' }).isVisible(), 'retry offered');
  await fileInput(page).setInputFiles({ name: 'chiffre.pdf', mimeType: 'application/pdf', buffer: encryptedPdf() });
  ok(await until(async () => (await page.getByRole('alert').innerText().catch(() => '')).includes('PDF chiffré')), 'encrypted PDF explained, never decrypted');
  await fileInput(page).setInputFiles({ name: 'note.txt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pas un pdf') });
  ok(await until(async () => (await page.getByRole('alert').innerText().catch(() => '')).includes('Type non pris en charge')), 'type decided by content');
  await ctx.close();

  // Mobile width.
  const mobile = await openPage({ width: 375, height: 800 });
  const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, `no horizontal scroll at 375 px (${overflow})`);
  await mobile.ctx.close();

  eq(net.errors.length, 0, `no page errors: ${net.errors.join(' | ')}`);
  eq(net.external.length, 0, `no external request: ${net.external.join(', ')}`);
} catch (error) {
  failed = error;
} finally {
  await browser.close();
  await server.close();
}
if (failed) throw failed;
console.log(`DOCUMENT_TOOLBOX_BROWSER_PASS assertions=${assertions}`);
