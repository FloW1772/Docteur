// Document Toolbox PDF V1 — every operation on generated fixtures (pdf-lib + canvas), hostile
// inputs (corrupt, encrypted, page bombs, hostile names), non-destructive guarantee, route.
// No network, no disk writes by the toolbox, no real database.
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  LIMITS, inspectPdf, extractText, renderPage, merge, split, extractPages, reorder, rotate, deletePages, duplicatePages,
  writeMetadata, watermark, imagesToPdf, compress, sanitizeFileName, sniffImage, isPdfSignature, parseRanges, createDocumentStore,
} from './src/lib/document-toolbox.js';
import { createDocumentToolboxRoute } from './src/routes/document-toolbox.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');

async function makePdf(pages = 3, { prefix = 'Page', size = [300, 400], title = 'Source' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage(size);
    page.drawText(`${prefix} ${i}`, { x: 30, y: size[1] / 2, size: 24, font });
  }
  doc.setTitle(title);
  doc.setAuthor('Auteur source');
  return Buffer.from(await doc.save());
}
const pageTexts = async (bytes) => (await extractText(bytes)).pages.map(p => p.text.replace(/\s+/g, ' ').trim());
function image(type, w = 40, h = 20) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3366cc'; ctx.fillRect(0, 0, w, h);
  return canvas.toBuffer(type === 'jpeg' ? 'image/jpeg' : `image/${type}`);
}
// Hand-built PDF declaring an /Encrypt dictionary in its trailer.
function encryptedPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── Read side (existing pdf-parse / pdfjs) ────────────────────────────────────

test('inspect + text extraction + page render (existing pdf-parse/pdfjs/canvas)', async () => {
  const src = await makePdf(3);
  const info = await inspectPdf(src);
  assert.equal(info.pageCount, 3);
  assert.deepEqual(info.pages[0], { page: 1, width: 300, height: 400, rotation: 0 });
  assert.equal(info.metadata.title, 'Source');
  assert.equal(info.metadata.author, 'Auteur source');
  assert.deepEqual(await pageTexts(src), ['Page 1', 'Page 2', 'Page 3']);
  const partial = await extractText(src, { pages: [2] });
  assert.equal(partial.pages.length, 1);
  const shot = await renderPage(src, 2, { scale: 0.5 });
  assert.ok(shot.png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'PNG');
  assert.equal(shot.width, 150);
  assert.equal(shot.height, 200);
  const empty = await extractText(await makePdf(1, { prefix: '' }));
  assert.equal(typeof empty.empty, 'boolean');
});

// ── Write side (pdf-lib), always a new document ───────────────────────────────

test('merge / split / extract / reorder: correct pages, sources untouched', async () => {
  const a = await makePdf(3, { prefix: 'A' });
  const b = await makePdf(2, { prefix: 'B' });
  const aCopy = Buffer.from(a); const bCopy = Buffer.from(b);
  const merged = await merge([{ bytes: a }, { bytes: b }]);
  assert.deepEqual(await pageTexts(merged), ['A 1', 'A 2', 'A 3', 'B 1', 'B 2']);
  assert.ok(a.equals(aCopy) && b.equals(bCopy), 'sources byte-identical');
  await assert.rejects(merge([{ bytes: a }]), (e) => e.code === 'MERGE_NEEDS_TWO');

  const parts = await split(merged, { ranges: '1-2, 5' });
  assert.deepEqual(parts.map(p => p.pages), [[1, 2], [5]]);
  assert.deepEqual(await pageTexts(parts[1].bytes), ['B 2']);
  assert.deepEqual((await split(merged, { every: 2 })).map(p => p.pages), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(parseRanges('3-4,1', 5), [[3, 4], [1]]);
  for (const bad of ['0-2', '4-2', '1-9', 'a', '']) assert.throws(() => parseRanges(bad, 5), (e) => e.code === 'INVALID_RANGES', bad);

  assert.deepEqual(await pageTexts(await extractPages(merged, [5, 1])), ['B 2', 'A 1']);
  await assert.rejects(extractPages(merged, [6]), (e) => e.code === 'PAGE_OUT_OF_RANGE');
  await assert.rejects(extractPages(merged, []), (e) => e.code === 'PAGES_REQUIRED');

  assert.deepEqual(await pageTexts(await reorder(a, [3, 1, 2])), ['A 3', 'A 1', 'A 2']);
  await assert.rejects(reorder(a, [1, 1, 2]), (e) => e.code === 'INVALID_ORDER');
  await assert.rejects(reorder(a, [1, 2]), (e) => e.code === 'INVALID_ORDER');
});

test('rotate / delete / duplicate pages', async () => {
  const src = await makePdf(3);
  const rotated = await rotate(src, [1, 3], 90);
  assert.deepEqual((await inspectPdf(rotated)).pages.map(p => p.rotation), [90, 0, 90]);
  const twice = await rotate(rotated, [1], 270);
  assert.equal((await inspectPdf(twice)).pages[0].rotation, 0, 'rotations accumulate modulo 360');
  await assert.rejects(rotate(src, [1], 45), (e) => e.code === 'INVALID_ANGLE');
  assert.deepEqual(await pageTexts(await deletePages(src, [2])), ['Page 1', 'Page 3']);
  await assert.rejects(deletePages(src, [1, 2, 3]), (e) => e.code === 'CANNOT_DELETE_ALL');
  assert.deepEqual(await pageTexts(await duplicatePages(src, [2])), ['Page 1', 'Page 2', 'Page 2', 'Page 3']);
});

test('metadata write (new document), watermark, compression honestly LIMITED', async () => {
  const src = await makePdf(2);
  const out = await writeMetadata(src, { title: 'Nouveau titre', author: 'Docteur', subject: 'Test', keywords: 'pdf, local' });
  const meta = (await inspectPdf(out)).metadata;
  assert.equal(meta.title, 'Nouveau titre');
  assert.equal(meta.author, 'Docteur');
  assert.equal(meta.keywords, 'pdf local');
  assert.equal((await inspectPdf(src)).metadata.title, 'Source', 'source metadata unchanged');

  const wm = await watermark(src, { text: 'CONFIDENTIEL — brouillon é', opacity: 0.3 });
  assert.ok((await pageTexts(wm)).every(t => t.includes('CONFIDENTIEL')), 'watermark on every page');
  const onlyOne = await watermark(src, { text: 'COPIE', pages: [2] });
  const texts = await pageTexts(onlyOne);
  assert.ok(!texts[0].includes('COPIE') && texts[1].includes('COPIE'));
  await assert.rejects(watermark(src, { text: '' }), (e) => e.code === 'WATERMARK_TEXT_REQUIRED');
  await assert.rejects(watermark(src, { text: '漢字' }), (e) => e.code === 'WATERMARK_UNSUPPORTED_CHARACTERS');

  const c = await compress(src);
  assert.equal(c.status, 'COMPRESSION_LIMITED');
  assert.equal(c.before, src.length);
  assert.equal(c.after, c.bytes.length);
  assert.equal((await inspectPdf(c.bytes)).pageCount, 2, 'content preserved');
});

test('images → PDF (PNG, JPEG, WebP via local decoding) and PDF → images', async () => {
  const png = image('png', 80, 40); const jpg = image('jpeg', 60, 60); const webp = image('webp', 30, 90);
  assert.deepEqual([sniffImage(png), sniffImage(jpg), sniffImage(webp), sniffImage(Buffer.from('hello'))], ['png', 'jpeg', 'webp', null]);
  const pdf = await imagesToPdf([{ bytes: png, name: 'a.png' }, { bytes: jpg, name: 'b.jpg' }, { bytes: webp, name: 'c.webp' }]);
  const info = await inspectPdf(pdf);
  assert.equal(info.pageCount, 3);
  assert.deepEqual(info.pages.map(p => [p.width, p.height]), [[60, 30], [45, 45], [22.5, 67.5]], '1 px = 0.75 pt');
  const a4 = await inspectPdf(await imagesToPdf([{ bytes: png }], { fit: 'a4' }));
  assert.deepEqual([a4.pages[0].width, a4.pages[0].height], [595.28, 841.89]);
  await assert.rejects(imagesToPdf([{ bytes: Buffer.from('nope'), name: 'x' }]), (e) => e.code === 'UNSUPPORTED_IMAGE');
  await assert.rejects(imagesToPdf([{ bytes: Buffer.concat([png.subarray(0, 8), Buffer.alloc(30)]), name: 'broken.png' }]), (e) => e.code === 'CORRUPT_IMAGE');
  const shot = await renderPage(pdf, 1, { scale: 2 });
  assert.equal(shot.width, 120);
});

// ── Hostile inputs ────────────────────────────────────────────────────────────

test('corrupt / not a PDF / encrypted / page bombs / render bomb are refused clearly', async () => {
  await assert.rejects(inspectPdf(Buffer.from('bonjour')), (e) => e.code === 'NOT_A_PDF');
  await assert.rejects(inspectPdf(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2_000, 0x41)])), (e) => e.code === 'CORRUPT_PDF');
  const truncated = (await makePdf(2)).subarray(0, 120);
  await assert.rejects(inspectPdf(truncated), (e) => ['CORRUPT_PDF'].includes(e.code));
  await assert.rejects(inspectPdf(encryptedPdf()), (e) => e.code === 'ENCRYPTED_PDF' && /ne le déverrouille pas/.test(e.message));
  await assert.rejects(merge([{ bytes: await makePdf(1) }, { bytes: encryptedPdf() }]), (e) => e.code === 'ENCRYPTED_PDF');

  const huge = await PDFDocument.create();
  huge.addPage([20_000, 20_000]);
  await assert.rejects(inspectPdf(Buffer.from(await huge.save())), (e) => e.code === 'PAGE_TOO_LARGE');
  const many = await PDFDocument.create();
  for (let i = 0; i < LIMITS.maxPages + 1; i += 1) many.addPage([10, 10]);
  await assert.rejects(inspectPdf(Buffer.from(await many.save())), (e) => e.code === 'TOO_MANY_PAGES' && e.status === 413);

  // Largest allowed page at the maximum scale: the bitmap stays bounded.
  const big = await PDFDocument.create();
  big.addPage([14_000, 14_000]);
  const shot = await renderPage(Buffer.from(await big.save()), 1, { scale: 3 });
  assert.ok(shot.width * shot.height <= LIMITS.maxRenderPixels * 1.01, `${shot.width}x${shot.height}`);
  assert.ok(isPdfSignature(Buffer.from('xx%PDF-1.4')) && !isPdfSignature(Buffer.from('PDF')));
});

test('file names: no path, no traversal, no reserved or control characters', () => {
  assert.equal(sanitizeFileName('../../etc/passwd.pdf', 'pdf'), 'passwd.pdf');
  assert.equal(sanitizeFileName('..\\..\\Windows\\System32\\cmd.pdf', 'pdf'), 'cmd.pdf');
  assert.equal(sanitizeFileName('CON.pdf', 'pdf'), 'document.pdf');
  assert.equal(sanitizeFileName('rapport\u0000<script>:*?.pdf', 'pdf'), 'rapportscript.pdf');
  assert.equal(sanitizeFileName('...', 'pdf'), 'document.pdf');
  assert.equal(sanitizeFileName('a'.repeat(300), 'pdf').length, 104);
  assert.equal(sanitizeFileName('Résumé été.pdf', 'pdf'), 'Résumé été.pdf');
});

// ── Workspace + route ─────────────────────────────────────────────────────────

test('workspace: bounded, TTL, ids validated', () => {
  let t = 0;
  const store = createDocumentStore({ now: () => t });
  const d = store.put({ name: 'x.pdf', kind: 'pdf', bytes: Buffer.alloc(10) });
  assert.throws(() => store.get('../x'), (e) => e.code === 'INVALID_ID');
  assert.equal(store.get(d.id).id, d.id);
  t += LIMITS.ttlMs + 1;
  assert.throws(() => store.get(d.id), (e) => e.code === 'DOC_NOT_FOUND', 'expired');
  for (let i = 0; i < LIMITS.maxDocs + 5; i += 1) store.put({ name: `d${i}`, kind: 'pdf', bytes: Buffer.alloc(1) });
  assert.equal(store.size, LIMITS.maxDocs, 'LRU bound');
});

test('route: upload by signature, hostile names, operations produce new documents, download headers', async () => {
  const app = createDocumentToolboxRoute();
  const upload = async (bytes, name, type = 'application/octet-stream') => app.request('/document-toolbox/files', { method: 'POST', headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) }, body: bytes });
  const op = async (body) => app.request('/document-toolbox/operations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const srcBytes = await makePdf(3);
  const up = await (await upload(srcBytes, '../../secret/../Rapport final.pdf', 'image/png')).json();
  assert.equal(up.doc.kind, 'pdf', 'type from the signature, not the declared type');
  assert.equal(up.doc.name, 'Rapport final.pdf');
  assert.equal(up.doc.info.pageCount, 3);
  const other = (await (await upload(await makePdf(2, { prefix: 'Z' }), 'z.pdf')).json()).doc;

  const txt = await upload(Buffer.from('juste du texte'), 'note.pdf');
  assert.equal(txt.status, 415);
  assert.equal((await upload(Buffer.alloc(0), 'vide.pdf')).status, 400);
  const tooBig = await app.request('/document-toolbox/files', { method: 'POST', headers: { 'content-length': String(LIMITS.maxFileBytes + 1), 'x-file-name': 'gros.pdf' }, body: Buffer.alloc(16) });
  assert.equal(tooBig.status, 413);
  const enc = await upload(encryptedPdf(), 'chiffre.pdf');
  assert.equal(enc.status, 400);
  assert.equal((await enc.json()).error.code, 'ENCRYPTED_PDF');

  const merged = await (await op({ op: 'merge', docIds: [up.doc.id, other.id] })).json();
  assert.equal(merged.outputs[0].pageCount, 5);
  assert.notEqual(merged.outputs[0].id, up.doc.id, 'a NEW document');
  const split = await (await op({ op: 'split', docId: merged.outputs[0].id, ranges: '1-3,4-5' })).json();
  assert.deepEqual(split.outputs.map(o => o.pageCount), [3, 2]);
  for (const [name, body, pages] of [
    ['extract', { op: 'extract', docId: up.doc.id, pages: [2] }, 1],
    ['reorder', { op: 'reorder', docId: up.doc.id, order: [3, 2, 1] }, 3],
    ['rotate', { op: 'rotate', docId: up.doc.id, pages: [1], angle: 180 }, 3],
    ['delete', { op: 'delete', docId: up.doc.id, pages: [1] }, 2],
    ['duplicate', { op: 'duplicate', docId: up.doc.id, pages: [1, 3] }, 5],
    ['metadata', { op: 'metadata', docId: up.doc.id, metadata: { title: 'T' } }, 3],
    ['watermark', { op: 'watermark', docId: up.doc.id, watermark: { text: 'DOCTEUR' } }, 3],
  ]) {
    const res = await (await op(body)).json();
    assert.equal(res.ok, true, name);
    assert.equal(res.outputs[0].pageCount, pages, name);
  }
  const imgs = await (await op({ op: 'pdf_to_images', docId: up.doc.id, pages: [1, 2], scale: 0.5 })).json();
  assert.deepEqual(imgs.outputs.map(o => o.kind), ['png', 'png']);
  const back = await (await op({ op: 'images_to_pdf', docIds: imgs.outputs.map(o => o.id) })).json();
  assert.equal(back.outputs[0].pageCount, 2);
  const comp = await (await op({ op: 'compress', docId: up.doc.id })).json();
  assert.equal(comp.compression.status, 'COMPRESSION_LIMITED');
  assert.equal((await op({ op: 'images_to_pdf', docIds: [up.doc.id] })).status, 400, 'a PDF is not an image');
  assert.equal((await op({ op: 'format_disk' })).status, 400);
  assert.equal((await op({ op: 'extract', docId: '../../etc', pages: [1] })).status, 400);
  assert.equal((await op({ op: 'extract', docId: '00000000-0000-4000-8000-000000000000', pages: [1] })).status, 404);

  // The uploaded source is byte-identical after every operation.
  const dl = await app.request(`/document-toolbox/files/${up.doc.id}/download`);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(srcBytes), 'source never modified');
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="Rapport final\.pdf"; filename\*=UTF-8''Rapport%20final\.pdf$/);
  const thumb = await app.request(`/document-toolbox/files/${up.doc.id}/pages/1/image?scale=0.2`);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  const text = await (await app.request(`/document-toolbox/files/${up.doc.id}/text`)).json();
  assert.equal(text.pages.length, 3);
  const list = await (await app.request('/document-toolbox/files')).json();
  assert.ok(list.docs.length >= 10);
});

// ── Static audit ──────────────────────────────────────────────────────────────

test('static audit: local only (no network/process/fs), pdf-lib pinned exactly and integrity-locked', () => {
  for (const file of ['src/lib/document-toolbox.js', 'src/routes/document-toolbox.js']) {
    const src = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.doesNotMatch(src, /child_process|\bspawn\(|\bexec\(|\bfetch\(|require\(['"](?:node:)?(?:fs|http|https|net)['"]\)|from ['"](?:node:)?(?:fs|http|https|net)['"]/, file);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['pdf-lib'], '1.17.1', 'exact version, no ^ or ~');
  const lock = JSON.parse(fs.readFileSync(path.join(HERE, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/pdf-lib'].version, '1.17.1');
  assert.equal(lock.packages['node_modules/pdf-lib'].integrity, 'sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==');
  assert.equal(lock.packages['node_modules/pdf-lib'].hasInstallScript, undefined);
});
