// Media Studio V1 — HTTP layer over lib/media-studio.js. Every rule (timeline
// validation, Root Policy MEDIA_TRANSCODE, process safety) lives in the service.
// Uploads are chunked (each request stays under the NB-7 body cap).
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { StudioError } from '../lib/media-studio.js';

const MIME = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** Node stream → web stream: a file removed between stat and open errors the response, never the process. */
const body = (file, opts) => Readable.toWeb(fs.createReadStream(file, opts));

/** Serves a Docteur-internal file with byte ranges (needed by <video>/<audio> to seek). */
function serveFile(c, file, type, downloadName = null) {
  const { size } = fs.statSync(file);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(body(file, { start, end }), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(body(file), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

export function createMediaStudioRoute({ service, logger = null }) {
  const route = new Hono();
  const fail = (c, err) => {
    if (err instanceof StudioError) return c.json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
    if (err?.name === 'RootPolicyDeniedError') return c.json({ ok: false, error: { code: 'ROOT_POLICY_DENIED', message: err.message } }, 403);
    logger?.error?.({ err: err?.message }, 'media studio error');
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne du Media Studio.' } }, 500);
  };
  const handle = (fn) => async (c) => { try { return await fn(c); } catch (err) { return fail(c, err); } };
  const json = async (c) => { try { return await c.req.json(); } catch { return {}; } };

  route.get('/media-studio/projects', handle((c) => c.json({ ok: true, projects: service.listProjects(), limits: service.LIMITS })));
  route.post('/media-studio/projects', handle(async (c) => c.json({ ok: true, ...service.createProject(await json(c)) })));
  route.get('/media-studio/projects/:id', handle((c) => c.json({ ok: true, ...service.getProject(c.req.param('id')) })));
  route.post('/media-studio/projects/:id/edits', handle(async (c) => c.json({ ok: true, ...service.edit(c.req.param('id'), await json(c)) })));

  route.post('/media-studio/projects/:id/uploads', handle(async (c) => c.json({ ok: true, ...service.startUpload(c.req.param('id'), await json(c)) })));
  route.put('/media-studio/uploads/:uploadId', handle(async (c) => {
    const bytes = Buffer.from(await c.req.arrayBuffer());
    return c.json({ ok: true, ...service.appendChunk(c.req.param('uploadId'), Number(c.req.query('offset')), bytes) });
  }));
  route.post('/media-studio/uploads/:uploadId/complete', handle(async (c) => c.json({ ok: true, ...(await service.completeUpload(c.req.param('uploadId'), await json(c))) })));
  route.delete('/media-studio/uploads/:uploadId', handle((c) => c.json({ ok: true, ...service.cancelUpload(c.req.param('uploadId')) })));
  route.post('/media-studio/projects/:id/import-image', handle(async (c) => c.json({ ok: true, ...(await service.importDocteurImage(c.req.param('id'), (await json(c)).imageId)) })));

  route.get('/media-studio/projects/:id/assets/:assetId/file', handle((c) => {
    const { file, asset } = service.assetFile(c.req.param('id'), c.req.param('assetId'));
    return serveFile(c, file, MIME[asset.file.split('.').pop()] ?? 'application/octet-stream');
  }));
  route.delete('/media-studio/projects/:id/assets/:assetId', handle((c) => c.json({ ok: true, ...service.removeAsset(c.req.param('id'), c.req.param('assetId')) })));

  route.post('/media-studio/projects/:id/exports', handle((c) => c.json({ ok: true, job: service.requestExport(c.req.param('id')) })));
  route.get('/media-studio/exports/:jobId', handle((c) => c.json({ ok: true, job: service.getJob(c.req.param('jobId')) })));
  route.post('/media-studio/exports/:jobId/cancel', handle(async (c) => c.json({ ok: true, job: await service.cancelExport(c.req.param('jobId')) })));
  route.get('/media-studio/exports/:jobId/file', handle((c) => {
    const { file, job } = service.exportFile(c.req.param('jobId'));
    return serveFile(c, file, 'video/mp4', c.req.query('download') === '1' ? `export-${job.id.slice(0, 8)}.mp4` : null);
  }));
  return route;
}
