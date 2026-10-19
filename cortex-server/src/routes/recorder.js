// Native Recorder — RECORDER-1 HTTP layer, mounted by server.js through this route factory.
// Every rule lives in lib/recorder-service.js. The session token travels in a header (never in the
// URL, so never in logs / history); a chunk body is refused before it is read when it exceeds maxChunkBytes.
// [REC-DL-1] The download route streams from service.openRecording(recordingId) — see below.
import { Hono } from 'hono';
import { RecorderError } from '../lib/recorder-contracts.js';
import { contentDisposition } from '../lib/recorder-service.js';

export const RECORDER_SESSION_HEADER = 'x-docteur-recorder-session';
/** [REC-DL-1] Structured error code on download responses (a HEAD response has no body). */
export const RECORDER_ERROR_HEADER = 'x-docteur-recorder-error';
/** [REC-DL-1] One positional read per pull (PROVISIONAL: same 64 KiB as Node file streams). */
export const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

export function createRecorderRoute({ service, logger = null }) {
  const route = new Hono();
  const fail = (c, err) => {
    if (err instanceof RecorderError) return c.json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
    logger?.error?.({ err: err?.message }, 'recorder error'); // never a path or a stack to the client
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne du Recorder.' } }, 500);
  };
  const handle = (fn) => async (c) => { try { return await fn(c); } catch (err) { return fail(c, err); } };
  const json = async (c) => { try { const v = await c.req.json(); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
  const token = (c) => c.req.header(RECORDER_SESSION_HEADER) ?? null;
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

  route.post('/recorder/sessions', handle(async (c) => c.json({ ok: true, session: service.createSession(pick(await json(c), ['type', 'title', 'mimeType'])) })));
  route.post('/recorder/sessions/:id/start', handle((c) => c.json({ ok: true, recording: service.markStarted({ recordingId: c.req.param('id'), sessionToken: token(c) }) })));
  route.put('/recorder/sessions/:id/chunks/:seq', handle(async (c) => {
    const declared = Number(c.req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > service.limits.maxChunkBytes) throw new RecorderError('CHUNK_TOO_LARGE', 'Morceau trop volumineux.', 413);
    const seq = /^\d{1,9}$/.test(c.req.param('seq')) ? Number(c.req.param('seq')) : -1;
    const bytes = Buffer.from(await c.req.arrayBuffer());
    return c.json({ ok: true, ack: service.appendChunk({ recordingId: c.req.param('id'), sessionToken: token(c), seq, bytes }) });
  }));
  route.post('/recorder/sessions/:id/finalize', handle(async (c) => c.json({ ok: true, ...(await service.finalize({ recordingId: c.req.param('id'), sessionToken: token(c), ...pick(await json(c), ['durationMs', 'width', 'height']) })) })));
  route.post('/recorder/sessions/:id/cancel', handle((c) => c.json({ ok: true, recording: service.cancel({ recordingId: c.req.param('id'), sessionToken: token(c) }) })));
  route.get('/recorder/recordings', handle((c) => {
    const int = (v, d) => (v === undefined ? d : /^\d{1,6}$/.test(v) ? Number(v) : -1);
    return c.json({ ok: true, ...service.listRecordings({ limit: int(c.req.query('limit'), 50), offset: int(c.req.query('offset'), 0), status: c.req.query('status') ?? null }) });
  }));
  route.get('/recorder/recordings/:id', handle((c) => c.json({ ok: true, recording: service.getRecording(c.req.param('id')) })));

  // [REC-DL-1] Download of a READY recording, by recordingId only. Everything goes through service.openRecording():
  // READY check, confined key, lstat, open, fstat on the DESCRIPTOR (same dev+ino, catalogue size). The body is a
  // pull-only stream of THAT descriptor (never a second path-based open, never a full buffer); Content-Length is the
  // size seen on the open file. HEAD (Hono runs GET handlers for HEAD and drops the body) validates the same way, then closes the
  // descriptor at once — a HEAD never leaves a file open. A client abort cancels the web stream, which closes the
  // descriptor. ?verify=1 re-hashes through the descriptor first (opt-in: it
  // reads the file twice).
  route.get('/recorder/recordings/:id/download', async (c) => {
    const head = c.req.method === 'HEAD';
    let handle = null;
    try {
      handle = await service.openRecording(c.req.param('id'), { verifyChecksum: c.req.query('verify') === '1' });
      const headers = {
        'Content-Type': handle.mimeType, 'Content-Length': String(handle.sizeBytes), 'Content-Disposition': contentDisposition(handle.filename),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      };
      logger?.info?.({ recordingId: handle.recordingId, sizeBytes: handle.sizeBytes, mimeType: handle.mimeType, method: head ? 'HEAD' : 'GET' }, 'recorder download started');
      if (head) { handle.close(); return new Response(null, { status: 200, headers }); }
      // pull-only stream of the validated descriptor (Readable.toWeb was measured without real backpressure here)
      return new Response(handle.webStream({ chunkBytes: DOWNLOAD_CHUNK_BYTES }), { status: 200, headers });
    } catch (err) {
      handle?.close();
      const code = err instanceof RecorderError ? err.code : 'INTERNAL_ERROR';
      logger?.warn?.({ recordingId: /^rec_[0-9a-f]{32}$/.test(c.req.param('id')) ? c.req.param('id') : null, code }, 'recorder download refused');
      if (head) return new Response(null, { status: err instanceof RecorderError ? err.status : 500, headers: { [RECORDER_ERROR_HEADER]: code } });
      const res = fail(c, err);
      res.headers.set(RECORDER_ERROR_HEADER, code);
      return res;
    }
  });
  route.delete('/recorder/recordings/:id', handle((c) => c.json({ ok: true, result: service.deleteRecording(c.req.param('id')) })));
  return route;
}
