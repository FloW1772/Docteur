// Document Toolbox PDF V1 — HTTP layer over lib/document-toolbox.js.
// Uploads are raw bodies (no multipart, no path): the type is decided by the
// file signature, never by the declared name. Every operation returns NEW
// documents; downloads use a sanitized name.
import { Hono } from 'hono';
import {
  LIMITS, ToolboxError, createDocumentStore, isPdfSignature, sniffImage, sanitizeFileName,
  inspectPdf, extractText, renderPage, merge, split, extractPages, reorder, rotate, deletePages,
  duplicatePages, writeMetadata, watermark, imagesToPdf, compress,
} from '../lib/document-toolbox.js';

export function createDocumentToolboxRoute({ store = createDocumentStore(), logger = null } = {}) {
  const route = new Hono();

  const fail = (c, err) => {
    if (err instanceof ToolboxError) return c.json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
    logger?.error?.({ err: err?.message }, 'document toolbox error');
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne de l’atelier PDF.' } }, 500);
  };
  const handle = (fn) => async (c) => { try { return await fn(c); } catch (err) { return fail(c, err); } };
  const pdfDoc = (id) => {
    const d = store.get(id);
    if (d.kind !== 'pdf') throw new ToolboxError('NOT_A_PDF', 'Ce document n’est pas un PDF.');
    return d;
  };
  const stem = (name) => sanitizeFileName(name);
  async function putPdf(bytes, name, origin) {
    const info = await inspectPdf(bytes);
    return { ...store.put({ name, kind: 'pdf', bytes, pageCount: info.pageCount, origin }), info };
  }

  route.post('/document-toolbox/files', handle(async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > LIMITS.maxFileBytes) throw new ToolboxError('FILE_TOO_LARGE', `Fichier trop volumineux (maximum ${LIMITS.maxFileBytes / 1024 / 1024} Mo).`, 413);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length === 0) throw new ToolboxError('EMPTY_FILE', 'Fichier vide.');
    if (bytes.length > LIMITS.maxFileBytes) throw new ToolboxError('FILE_TOO_LARGE', `Fichier trop volumineux (maximum ${LIMITS.maxFileBytes / 1024 / 1024} Mo).`, 413);
    let name = 'document';
    try { name = decodeURIComponent(c.req.header('x-file-name') ?? 'document'); } catch { name = 'document'; }
    if (isPdfSignature(bytes)) return c.json({ ok: true, doc: await putPdf(bytes, name, { op: 'upload' }) });
    const image = sniffImage(bytes);
    if (!image) throw new ToolboxError('UNSUPPORTED_FILE', 'Type non pris en charge : PDF, PNG, JPEG, WebP ou GIF (vérifié sur le contenu, pas sur le nom).', 415);
    if (bytes.length > LIMITS.maxImageBytes) throw new ToolboxError('FILE_TOO_LARGE', `Image trop volumineuse (maximum ${LIMITS.maxImageBytes / 1024 / 1024} Mo).`, 413);
    return c.json({ ok: true, doc: store.put({ name, kind: image, bytes, origin: { op: 'upload' } }) });
  }));

  route.get('/document-toolbox/files', handle((c) => c.json({ ok: true, docs: store.list(), limits: LIMITS })));

  route.get('/document-toolbox/files/:id', handle(async (c) => {
    const d = store.get(c.req.param('id'));
    return c.json({ ok: true, doc: { ...store.summary(d), ...(d.kind === 'pdf' ? { info: await inspectPdf(d.bytes) } : {}) } });
  }));

  route.delete('/document-toolbox/files/:id', handle((c) => c.json({ ok: true, removed: store.remove(c.req.param('id')) })));

  route.get('/document-toolbox/files/:id/download', handle((c) => {
    const d = store.get(c.req.param('id'));
    const type = d.kind === 'pdf' ? 'application/pdf' : `image/${d.kind}`;
    return new Response(d.bytes, {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${d.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }));

  route.get('/document-toolbox/files/:id/pages/:page/image', handle(async (c) => {
    const d = pdfDoc(c.req.param('id'));
    const { png } = await renderPage(d.bytes, Number(c.req.param('page')), { scale: Number(c.req.query('scale') ?? 0.3) });
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }));

  route.get('/document-toolbox/files/:id/text', handle(async (c) => c.json({ ok: true, ...(await extractText(pdfDoc(c.req.param('id')).bytes)) })));

  route.post('/document-toolbox/operations', handle(async (c) => {
    let b;
    try { b = await c.req.json(); } catch { throw new ToolboxError('INVALID_REQUEST', 'Requête invalide.'); }
    const op = String(b?.op ?? '');
    const outputs = [];
    const add = async (bytes, name, origin) => outputs.push(await putPdf(bytes, name, origin));
    switch (op) {
      case 'merge': {
        const docs = (Array.isArray(b.docIds) ? b.docIds : []).map(pdfDoc);
        await add(await merge(docs), `${stem(docs[0]?.name ?? 'fusion')}-fusion`, { op, sources: docs.map(d => d.id) });
        break;
      }
      case 'split': {
        const d = pdfDoc(b.docId);
        for (const part of await split(d.bytes, { ranges: b.ranges ?? null, every: b.every ?? null })) {
          await add(part.bytes, `${stem(d.name)}-p${part.pages[0]}-${part.pages.at(-1)}`, { op, sources: [d.id], pages: part.pages });
        }
        break;
      }
      case 'extract': { const d = pdfDoc(b.docId); await add(await extractPages(d.bytes, b.pages), `${stem(d.name)}-extrait`, { op, sources: [d.id], pages: b.pages }); break; }
      case 'reorder': { const d = pdfDoc(b.docId); await add(await reorder(d.bytes, b.order), `${stem(d.name)}-reordonne`, { op, sources: [d.id] }); break; }
      case 'rotate': { const d = pdfDoc(b.docId); await add(await rotate(d.bytes, b.pages, b.angle), `${stem(d.name)}-rotation`, { op, sources: [d.id], pages: b.pages }); break; }
      case 'delete': { const d = pdfDoc(b.docId); await add(await deletePages(d.bytes, b.pages), `${stem(d.name)}-pages-supprimees`, { op, sources: [d.id], pages: b.pages }); break; }
      case 'duplicate': { const d = pdfDoc(b.docId); await add(await duplicatePages(d.bytes, b.pages), `${stem(d.name)}-pages-dupliquees`, { op, sources: [d.id], pages: b.pages }); break; }
      case 'metadata': { const d = pdfDoc(b.docId); await add(await writeMetadata(d.bytes, b.metadata ?? {}), `${stem(d.name)}-metadonnees`, { op, sources: [d.id] }); break; }
      case 'watermark': { const d = pdfDoc(b.docId); await add(await watermark(d.bytes, b.watermark ?? {}), `${stem(d.name)}-filigrane`, { op, sources: [d.id] }); break; }
      case 'images_to_pdf': {
        const imgs = (Array.isArray(b.docIds) ? b.docIds : []).map(id => store.get(id));
        if (imgs.some(i => i.kind === 'pdf')) throw new ToolboxError('NOT_AN_IMAGE', 'Seules des images peuvent être converties en PDF.');
        await add(await imagesToPdf(imgs, { fit: b.fit === 'a4' ? 'a4' : 'image' }), `${stem(imgs[0]?.name ?? 'images')}-images`, { op, sources: imgs.map(i => i.id) });
        break;
      }
      case 'pdf_to_images': {
        const d = pdfDoc(b.docId);
        const pages = Array.isArray(b.pages) && b.pages.length ? b.pages : Array.from({ length: d.pageCount }, (_, i) => i + 1);
        if (pages.length > 100) throw new ToolboxError('TOO_MANY_OUTPUTS', 'Au maximum 100 pages converties à la fois.');
        for (const n of pages) {
          const { png } = await renderPage(d.bytes, n, { scale: b.scale ?? 2 });
          outputs.push(store.put({ name: `${stem(d.name)}-page-${n}`, kind: 'png', bytes: png, origin: { op, sources: [d.id], pages: [n] } }));
        }
        break;
      }
      case 'compress': {
        const d = pdfDoc(b.docId);
        const r = await compress(d.bytes);
        const out = await putPdf(r.bytes, `${stem(d.name)}-optimise`, { op, sources: [d.id], before: r.before, after: r.after, status: r.status });
        outputs.push(out);
        return c.json({ ok: true, outputs, compression: { status: r.status, before: r.before, after: r.after, smaller: r.smaller } });
      }
      default:
        throw new ToolboxError('UNKNOWN_OPERATION', `Opération inconnue : ${op || '(vide)'}.`);
    }
    return c.json({ ok: true, outputs });
  }));

  return route;
}
