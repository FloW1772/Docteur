// Native Recorder — RECORDER-1 service: typed capture protocol over the Recorder catalogue.
//
//   createSession({ type, title, mimeType })   → { recordingId, sessionToken }   (PREPARING; exclusive <id>.partial)
//   markStarted({ recordingId, sessionToken })                                     (RECORDING)
//   appendChunk({ recordingId, sessionToken, seq, bytes })                         (seq 0,1,2… exactly)
//   finalize({ recordingId, sessionToken, durationMs?, width?, height? })          (FINALIZING → READY | FAILED)
//   cancel({ recordingId, sessionToken })                                          (CANCELLED, partial removed)
//   getRecording / listRecordings / deleteRecording / openRecording / recoverAfterRestart / shutdown
// Rules: the server generates the recordingId and every storage key; the client never sends a path or an extension.
// A chunk needs the session token (only its SHA-256 is kept). The container is decided by the first bytes
// (Media Studio sniffMedia) and must agree with the MIME the browser declared. Writes are positional into the
// exclusively-created partial file; the full recording is never held in memory. READY only after fsync, a streamed
// SHA-256 (read back through the same descriptor) and an atomic rename partial → files (same directory tree, same
// volume). FFmpeg is not used: no transcode, the original MediaRecorder output is what is stored.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { sniffMedia, safeDisplayName } from './media-studio.js';
import {
  RecorderError, fail, RECORDING_TYPES, ACTIVE_STATUSES, RECORDER_LIMITS, containerOfMime, assertRecordingId, isRecordingId, cleanTitle, cleanClientMetadata, defaultTitle,
} from './recorder-contracts.js';
import { RecorderStore } from './recorder-store.js';

const defaultIo = Object.freeze({
  open: (p, flags) => fs.openSync(p, flags), close: (fd) => fs.closeSync(fd), fstat: (fd) => fs.fstatSync(fd, { bigint: true }),
  lstat: (p) => fs.lstatSync(p, { bigint: true }), write: (fd, buf, off, len, pos) => fs.writeSync(fd, buf, off, len, pos), fsync: (fd) => fs.fsyncSync(fd),
  read: (fd, buf, off, len, pos) => new Promise((res, rej) => fs.read(fd, buf, off, len, pos, (e, n) => (e ? rej(e) : res(n)))),
  rename: (a, b) => fs.renameSync(a, b), unlink: (p) => fs.unlinkSync(p), statfs: (p) => fs.statfsSync(p),
});
const RO_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0); // O_NOFOLLOW does not exist on Windows (see safe-open notes)
const HASH_BUF = 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest();

/** Download name for REC-DL-1: sanitized title + the real extension. No separators, no control chars, no reserved names. */
export function downloadFilename(title, ext) {
  const base = safeDisplayName(String(title ?? '').replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')).replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${base && base !== 'média' ? base : 'enregistrement'}.${ext}`;
}
/** [REC-DL-1] Untitled recording (the default title of its type) → deterministic recording-<UTC date>-<short id>.<ext>. */
export function downloadFilenameFor(row) {
  if (!row?.ext) return null;
  if (row.title === defaultTitle(row.type)) {
    const stamp = String(row.created_at ?? '').replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '-').replace(/[^0-9_-]/g, '');
    return `recording-${stamp || 'undated'}-${String(row.recording_id).slice(4, 12)}.${row.ext}`;
  }
  return downloadFilename(row.title, row.ext);
}
/**
 * [REC-DL-1] RFC 6266 attachment header. ASCII fallback: accents folded, any other non-printable / non-ASCII → "_",
 * and " \ ' % ; neutralised; filename* = RFC 5987 UTF-8 percent-encoding (' ( ) * encoded too). The input is already a
 * sanitized download name (no CR / LF / separators); the result can never contain a CR or LF.
 */
export function contentDisposition(filename) {
  const name = String(filename ?? 'enregistrement').replace(/\p{Cc}/gu, '');
  const ascii = name.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/gu, '_').replace(/["\\'%;]/g, '_') || 'enregistrement';
  const star = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

export function createRecorderService({ store, io = defaultIo, limits = {} } = {}) {
  if (!(store instanceof RecorderStore)) fail('INTERNAL', 'a RecorderStore is required', 500);
  const L = Object.fromEntries(Object.entries(RECORDER_LIMITS).map(([k, v]) => [k, v.value]));
  for (const [k, v] of Object.entries(limits)) {
    if (!(k in L) || !Number.isSafeInteger(v) || v < 0 || (k !== 'minFreeBytes' && (v < 1 || v > L[k]))) fail('INTERNAL', `invalid limit override ${k}`, 500);
    L[k] = v; // tests may tighten a bound, never widen it (minFreeBytes may be lowered for small test volumes)
  }
  const sessions = new Map(); // recordingId → { tokenHash, fd, partialAbs, expectedSeq, lastChunkSha, bytes, startedAtMs, container }

  const freeBytes = () => { try { const s = io.statfs(store.root); return Number(s.bavail) * Number(s.bsize); } catch { return null; } };
  const ioCode = (e) => (e?.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED');
  const closeQuietly = (fd) => { try { io.close(fd); } catch { /* already closed */ } };
  const unlinkQuietly = (abs) => { try { io.unlink(abs); return true; } catch (e) { return e?.code === 'ENOENT'; } };

  function publicView(r) {
    if (!r) return null;
    return Object.freeze({
      recordingId: r.recording_id, type: r.type, source: r.type.startsWith('SCREEN') ? 'SCREEN' : 'CAMERA', status: r.status, title: r.title,
      createdAt: r.created_at, startedAt: r.started_at, stoppedAt: r.stopped_at, durationMs: r.duration_ms, mimeType: r.mime_type, sizeBytes: r.size_bytes,
      width: r.width, height: r.height, hasAudio: r.has_audio === 1, metadataSource: r.metadata_source, checksumSha256: r.checksum_sha256,
      filename: downloadFilenameFor(r), error: r.error_code, recoverable: r.recoverable === 1, chunkCount: r.chunk_count,
    });
  }
  function sessionFor(recordingId, sessionToken) {
    assertRecordingId(recordingId);
    const s = sessions.get(recordingId);
    if (!s) fail('SESSION_NOT_FOUND', 'Aucune session d’enregistrement active pour cet identifiant.', 404);
    const given = typeof sessionToken === 'string' ? sha(sessionToken) : Buffer.alloc(32);
    if (!crypto.timingSafeEqual(given, s.tokenHash)) fail('SESSION_TOKEN_INVALID', 'Jeton de session invalide.', 403);
    s.lastActivityMs = store.nowMs();
    return s;
  }
  /** An active capture fails: the descriptor is closed, the bytes already written are KEPT (classified, never READY). */
  function failActive(recordingId, s, code, message, status) {
    sessions.delete(recordingId);
    closeQuietly(s.fd);
    let recoverable = s.bytes > 0 ? 1 : 0;
    if (!recoverable) unlinkQuietly(s.partialAbs);
    store.transition(recordingId, ACTIVE_STATUSES, 'FAILED', { error_code: code, recoverable, stopped_at: store.at(), ...(recoverable ? {} : { partial_key: null }) });
    store.audit('RECORDING_FAILED', recordingId, { code, sizeBytes: s.bytes, recoverable: recoverable === 1 });
    throw new RecorderError(code, message, status);
  }
  /** A session whose client went silent (tab closed, crash) is failed — bytes kept and classified, never READY. */
  function sweepIdle() {
    for (const [id, s] of [...sessions]) {
      if (store.nowMs() - s.lastActivityMs <= L.sessionIdleMs) continue;
      try { failActive(id, s, 'SESSION_ABANDONED', 'Session abandonnée.', 408); } catch { /* recorded as FAILED */ }
    }
  }
  async function hashFd(fd, size) {
    const h = crypto.createHash('sha256'); const buf = Buffer.allocUnsafe(HASH_BUF);
    let pos = 0;
    while (pos < size) { const n = await io.read(fd, buf, 0, Math.min(HASH_BUF, size - pos), pos); if (n <= 0) break; h.update(buf.subarray(0, n)); pos += n; }
    if (pos !== size) fail('SIZE_MISMATCH', 'Taille lue différente de la taille attendue.', 409);
    return h.digest('hex');
  }

  return Object.freeze({
    limits: Object.freeze({ ...L }),

    createSession({ type, title = null, mimeType } = {}) {
      if (!RECORDING_TYPES.includes(type)) fail('INVALID_TYPE', 'Source d’enregistrement inconnue (SCREEN, CAMERA, SCREEN_WITH_MIC, CAMERA_WITH_MIC).');
      const container = containerOfMime(mimeType);
      if (!container) fail('UNSUPPORTED_MIME', 'Format non pris en charge (video/webm ou video/mp4 produit par MediaRecorder).', 415);
      sweepIdle();
      if (Math.max(sessions.size, store.countActive(ACTIVE_STATUSES)) >= L.maxActiveRecordings) fail('RECORDER_BUSY', 'Un enregistrement est déjà en cours.', 409);
      const free = freeBytes();
      if (free !== null && free < L.minFreeBytes) fail('DISK_FULL', 'Espace disque insuffisant pour enregistrer.', 507);
      const recordingId = `rec_${crypto.randomBytes(16).toString('hex')}`;
      const partialKey = RecorderStore.keyFor('partial', recordingId);
      const partialAbs = store.resolveKey(partialKey);
      let fd;
      try { fd = io.open(partialAbs, 'wx+'); } catch (e) { fail(e?.code === 'EEXIST' ? 'PARTIAL_EXISTS' : ioCode(e), 'Impossible de créer le fichier d’enregistrement.', 500); }
      try {
        if (!io.fstat(fd).isFile()) fail('NOT_REGULAR_FILE', 'Fichier d’enregistrement invalide.', 500);
        store.insert({ recordingId, type, title: cleanTitle(title, type), declaredMime: mimeType.trim(), at: store.at(), hasAudio: type.endsWith('_WITH_MIC'), partialKey });
      } catch (e) { closeQuietly(fd); unlinkQuietly(partialAbs); throw e; }
      store.audit('RECORDING_CREATED', recordingId, { type, container: container.ext });
      const sessionToken = crypto.randomBytes(32).toString('base64url');
      sessions.set(recordingId, { tokenHash: sha(sessionToken), fd, partialAbs, expectedSeq: 0, lastChunkSha: null, bytes: 0, startedAtMs: null, container, lastActivityMs: store.nowMs() });
      return Object.freeze({ recordingId, sessionToken, status: 'PREPARING', maxChunkBytes: L.maxChunkBytes, maxRecordingBytes: L.maxRecordingBytes, maxDurationMs: L.maxDurationMs });
    },

    markStarted({ recordingId, sessionToken } = {}) {
      const s = sessionFor(recordingId, sessionToken);
      if (!store.transition(recordingId, ['PREPARING'], 'RECORDING', { started_at: store.at() })) fail('ILLEGAL_TRANSITION', 'Cet enregistrement n’est plus en préparation.', 409);
      s.startedAtMs = store.nowMs();
      store.audit('RECORDING_STARTED', recordingId, {});
      return publicView(store.row(recordingId));
    },

    appendChunk({ recordingId, sessionToken, seq, bytes } = {}) {
      const s = sessionFor(recordingId, sessionToken);
      const row = store.row(recordingId);
      if (row?.status !== 'RECORDING') fail('RECORDING_NOT_ACTIVE', 'Cet enregistrement n’accepte pas de données.', 409);
      if (!Number.isSafeInteger(seq) || seq < 0) fail('INVALID_SEQUENCE', 'Numéro de morceau invalide.');
      const buf = Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
      if (!buf || buf.length === 0) fail('INVALID_CHUNK', 'Morceau vide ou invalide.');
      if (buf.length > L.maxChunkBytes) fail('CHUNK_TOO_LARGE', `Morceau trop volumineux (${L.maxChunkBytes} octets maximum).`, 413);
      if (seq < s.expectedSeq) {
        // deterministic duplicate rule: the exact repeat of the LAST chunk is acknowledged without writing; anything else is refused
        if (seq === s.expectedSeq - 1 && s.lastChunkSha && sha(buf).equals(s.lastChunkSha)) return Object.freeze({ seq, duplicate: true, received: s.bytes });
        fail('CHUNK_OUT_OF_ORDER', `Morceau ${seq} déjà reçu ou hors ordre (attendu ${s.expectedSeq}).`, 409);
      }
      if (seq > s.expectedSeq) fail('CHUNK_GAP', `Morceau manquant : attendu ${s.expectedSeq}, reçu ${seq}.`, 409);
      if (s.startedAtMs !== null && store.nowMs() - s.startedAtMs > L.maxDurationMs) failActive(recordingId, s, 'RECORDING_TOO_LONG', 'Durée maximale atteinte.', 413);
      if (s.bytes + buf.length > L.maxRecordingBytes) failActive(recordingId, s, 'RECORDING_TOO_LARGE', 'Taille maximale d’enregistrement atteinte.', 413);
      if (seq === 0) {
        const sniffed = sniffMedia(buf.subarray(0, 64));
        if (!sniffed || sniffed.kind !== 'video' || sniffed.ext !== s.container.sniff) failActive(recordingId, s, 'MIME_MISMATCH', 'Le contenu reçu ne correspond pas au format annoncé.', 415);
      }
      const free = freeBytes();
      if (free !== null && free - buf.length < L.minFreeBytes) failActive(recordingId, s, 'DISK_FULL', 'Espace disque insuffisant : enregistrement arrêté.', 507);
      try {
        let off = 0;
        while (off < buf.length) { const n = io.write(s.fd, buf, off, buf.length - off, s.bytes + off); if (n <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' }); off += n; }
      } catch (e) { failActive(recordingId, s, ioCode(e), ioCode(e) === 'DISK_FULL' ? 'Disque plein : enregistrement arrêté.' : 'Écriture impossible : enregistrement arrêté.', 507); }
      s.bytes += buf.length; s.expectedSeq += 1; s.lastChunkSha = sha(buf);
      store.update(recordingId, { size_bytes: s.bytes, chunk_count: s.expectedSeq });
      return Object.freeze({ seq, duplicate: false, received: s.bytes });
    },

    async finalize({ recordingId, sessionToken, durationMs = null, width = null, height = null } = {}) {
      const s = sessionFor(recordingId, sessionToken);
      const meta = cleanClientMetadata({ durationMs, width, height });
      if (!store.transition(recordingId, ['RECORDING', 'PREPARING'], 'FINALIZING', { stopped_at: store.at() })) fail('ILLEGAL_TRANSITION', 'Cet enregistrement ne peut pas être finalisé.', 409);
      sessions.delete(recordingId);
      const failed = (code, keep) => {
        closeQuietly(s.fd);
        if (!keep) unlinkQuietly(s.partialAbs);
        store.transition(recordingId, ['FINALIZING'], 'FAILED', { error_code: code, recoverable: keep ? 1 : 0, ...(keep ? {} : { partial_key: null }) });
        store.audit('RECORDING_FAILED', recordingId, { code, sizeBytes: s.bytes, recoverable: keep });
        return Object.freeze({ status: 'FAILED', error: code, recording: publicView(store.row(recordingId)) });
      };
      if (s.bytes === 0) return failed('EMPTY_RECORDING', false); // never a READY empty recording
      let checksum;
      try {
        io.fsync(s.fd);
        if (Number(io.fstat(s.fd).size) !== s.bytes) return failed('SIZE_MISMATCH', true);
        checksum = await hashFd(s.fd, s.bytes);
      } catch { return failed('FINALIZE_FAILED', true); }
      const ext = s.container.ext;
      const storageKey = RecorderStore.keyFor('files', recordingId, ext);
      let finalAbs;
      try { finalAbs = store.resolveKey(storageKey); } catch { return failed('ROOT_ESCAPE', true); }
      try { io.lstat(finalAbs); return failed('FINALIZE_TARGET_EXISTS', true); } catch (e) { if (e?.code !== 'ENOENT') return failed('FINALIZE_FAILED', true); }
      const row = store.row(recordingId);
      const mime = containerOfMime(row.declared_mime)?.ext === ext ? row.declared_mime : s.container.baseMime;
      // persisted BEFORE the rename: a crash between rename and READY is recoverable by checksum (recoverAfterRestart)
      store.update(recordingId, { checksum_sha256: checksum, size_bytes: s.bytes, ext, mime_type: mime, storage_key: storageKey, duration_ms: meta.durationMs, width: meta.width, height: meta.height });
      closeQuietly(s.fd);
      try { io.rename(s.partialAbs, finalAbs); } catch { return failed('FINALIZE_FAILED', true); }
      try {
        const st = io.lstat(finalAbs);
        if (st.isSymbolicLink() || !st.isFile() || Number(st.size) !== s.bytes) return failed('FINALIZE_FAILED', true);
      } catch { return failed('FINALIZE_FAILED', true); }
      if (!store.transition(recordingId, ['FINALIZING'], 'READY', { partial_key: null })) fail('ILLEGAL_TRANSITION', 'Finalisation concurrente.', 409);
      store.audit('RECORDING_FINALIZED', recordingId, { sizeBytes: s.bytes, container: ext, chunks: s.expectedSeq });
      return Object.freeze({ status: 'READY', recording: publicView(store.row(recordingId)) });
    },

    cancel({ recordingId, sessionToken } = {}) {
      const s = sessionFor(recordingId, sessionToken);
      sessions.delete(recordingId);
      closeQuietly(s.fd);
      const removed = unlinkQuietly(s.partialAbs);
      store.transition(recordingId, ['PREPARING', 'RECORDING'], 'CANCELLED', { stopped_at: store.at(), size_bytes: 0, partial_key: removed ? null : store.row(recordingId)?.partial_key ?? null, error_code: removed ? null : 'CANCEL_PARTIAL_NOT_REMOVED' });
      store.audit('RECORDING_CANCELLED', recordingId, { partialRemoved: removed });
      return publicView(store.row(recordingId));
    },

    getRecording(recordingId) {
      assertRecordingId(recordingId);
      return publicView(store.row(recordingId)) ?? fail('RECORDING_NOT_FOUND', 'Enregistrement introuvable.', 404);
    },
    listRecordings({ limit = 50, offset = 0, status = null } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > L.listLimit) fail('INVALID_LIMIT', `limit est 1..${L.listLimit}.`);
      if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_OFFSET', 'offset invalide.');
      if (status !== null && !['PREPARING', 'RECORDING', 'FINALIZING', 'READY', 'FAILED', 'CANCELLED', 'DELETING', 'MISSING'].includes(status)) fail('INVALID_STATUS', 'Statut inconnu.');
      const { rows, total } = store.list({ limit, offset, status });
      return Object.freeze({ items: rows.map(publicView), total, limit, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null });
    },

    /** Deletes metadata AND files by recordingId. Honest: DELETED, or DELETE_INCOMPLETE with what remains (retryable). */
    deleteRecording(recordingId) {
      assertRecordingId(recordingId);
      const row = store.row(recordingId) ?? fail('RECORDING_NOT_FOUND', 'Enregistrement introuvable.', 404);
      if (ACTIVE_STATUSES.includes(row.status)) fail('RECORDING_ACTIVE', 'Arrêtez ou annulez l’enregistrement avant de le supprimer.', 409);
      if (!store.transition(recordingId, ['READY', 'FAILED', 'CANCELLED', 'MISSING', 'DELETING'], 'DELETING')) fail('ILLEGAL_TRANSITION', 'Suppression impossible dans cet état.', 409);
      const remaining = [];
      for (const key of [row.storage_key, row.partial_key].filter(Boolean)) {
        let abs;
        try { abs = store.resolveKey(key); } catch { remaining.push({ store: key.split('/')[0], reason: 'ROOT_ESCAPE' }); continue; }
        let st = null;
        try { st = io.lstat(abs); } catch (e) { if (e?.code !== 'ENOENT') remaining.push({ store: key.split('/')[0], reason: 'STAT_FAILED' }); continue; }
        if (st.isSymbolicLink() || !st.isFile()) { remaining.push({ store: key.split('/')[0], reason: 'UNEXPECTED_FILE_TYPE' }); continue; } // never follows / deletes a redirected target
        try { io.unlink(abs); } catch (e) { if (e?.code !== 'ENOENT') remaining.push({ store: key.split('/')[0], reason: String(e?.code ?? 'UNLINK_FAILED').slice(0, 24) }); }
      }
      if (remaining.length) {
        store.update(recordingId, { error_code: 'DELETE_INCOMPLETE' });
        store.audit('RECORDING_DELETE_INCOMPLETE', recordingId, { remaining });
        return Object.freeze({ status: 'DELETE_INCOMPLETE', recordingId, remaining, retryable: true });
      }
      store.remove(recordingId);
      store.audit('RECORDING_DELETED', recordingId, { previousStatus: row.status });
      return Object.freeze({ status: 'DELETED', recordingId });
    },

    /**
     * REC-DL-1 primitive. recordingId → READY row → confined key → lstat (regular, not a link) → open read-only →
     * fstat on the DESCRIPTOR: same dev+ino as the lstat (a swap between check and open is detected) and the catalogue
     * size; optional streamed checksum through the descriptor. The caller streams from the returned descriptor, never
     * re-opens by path. Never accepts a path.
     */
    async openRecording(recordingId, { verifyChecksum = false } = {}) {
      assertRecordingId(recordingId);
      const row = store.row(recordingId) ?? fail('RECORDING_NOT_FOUND', 'Enregistrement introuvable.', 404);
      if (row.status === 'MISSING') fail('RECORDING_FILE_MISSING', 'Le fichier de cet enregistrement est introuvable.', 404);
      if (row.status !== 'READY') fail('RECORDING_NOT_READY', 'Cet enregistrement n’est pas prêt.', 409);
      const abs = store.resolveKey(row.storage_key);
      let st;
      try { st = io.lstat(abs); } catch (e) {
        if (e?.code === 'ENOENT') { store.transition(recordingId, ['READY'], 'MISSING', { error_code: 'FILE_MISSING' }); store.audit('RECORDING_MARKED_MISSING', recordingId, {}); fail('RECORDING_FILE_MISSING', 'Le fichier de cet enregistrement est introuvable.', 404); }
        fail('RECORDING_OPEN_FAILED', 'Ouverture impossible.', 500);
      }
      if (st.isSymbolicLink()) fail('LINK_REFUSED', 'Le fichier est un lien : refusé.', 403);
      if (!st.isFile()) fail('NOT_REGULAR_FILE', 'Le fichier n’est pas un fichier régulier : refusé.', 409);
      let fd;
      try { fd = io.open(abs, RO_FLAGS); } catch (e) { fail(e?.code === 'ENOENT' ? 'RECORDING_FILE_MISSING' : 'RECORDING_OPEN_FAILED', 'Ouverture impossible.', e?.code === 'ENOENT' ? 404 : 500); }
      let fst;
      try {
        fst = io.fstat(fd);
        if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) fail('FILE_CHANGED', 'Le fichier a changé pendant l’ouverture : refusé.', 409);
        if (Number(fst.size) !== row.size_bytes) fail('SIZE_MISMATCH', 'Taille différente du catalogue : refusé.', 409);
        if (verifyChecksum && (await hashFd(fd, row.size_bytes)) !== row.checksum_sha256) fail('CHECKSUM_MISMATCH', 'Empreinte SHA-256 différente : fichier altéré.', 409);
      } catch (e) { closeQuietly(fd); throw e; }
      let closed = false;
      const close = () => { if (!closed) { closed = true; closeQuietly(fd); } };
      return Object.freeze({
        recordingId, mimeType: row.mime_type, sizeBytes: Number(fst.size), filename: downloadFilenameFor(row), checksumSha256: row.checksum_sha256, fd,
        /** One stream per handle; it owns the descriptor (closed when the stream ends, errors or is destroyed). */
        stream({ start = 0, end = row.size_bytes - 1 } = {}) { closed = true; return fs.createReadStream(null, { fd, start, end, autoClose: true, highWaterMark: 64 * 1024 }); },
        /**
         * [REC-DL-1] Pull-only web stream over the SAME descriptor: a positional read happens only when the consumer
         * asks (real backpressure — Readable.toWeb measured 23 MiB retained for 64 MiB, this ~7 MiB). It owns the
         * descriptor: closed at the end, on cancel (client abort) and on error. A file that shrinks while it is read
         * errors the stream (never a short "success").
         */
        webStream({ chunkBytes = 64 * 1024 } = {}) {
          closed = true;
          let pos = 0;
          const total = row.size_bytes;
          const done = () => closeQuietly(fd);
          return new ReadableStream({
            type: 'bytes',
            async pull(controller) {
              try {
                const len = Math.min(chunkBytes, total - pos);
                if (len <= 0) { done(); controller.close(); return; }
                // a dedicated buffer per chunk: a byte stream TRANSFERS (detaches) what is enqueued, so it must never be
                // a slice of Node's shared Buffer pool (Buffer.allocUnsafe uses it for small sizes)
                const u8 = new Uint8Array(len);
                const n = await io.read(fd, u8, 0, len, pos);
                if (n <= 0) { done(); controller.error(new RecorderError('SIZE_MISMATCH', 'Le fichier a raccourci pendant la lecture.', 409)); return; }
                pos += n;
                controller.enqueue(n === len ? u8 : u8.subarray(0, n));
              } catch (e) { done(); controller.error(e); }
            },
            cancel() { done(); },
          }, { highWaterMark: 0 });
        },
        close,
      });
    },

    /** Boot: nothing interrupted becomes READY unless its pre-rename checksum proves the final file complete. */
    async recoverAfterRestart() {
      const out = { flagged: 0, recovered: 0, missing: 0, emptyRemoved: 0, orphanFiles: 0, deleting: 0 };
      for (const r of store.byStatus(ACTIVE_STATUSES)) {
        if (sessions.has(r.recording_id)) continue;
        if (r.status === 'FINALIZING' && r.storage_key && r.checksum_sha256) {
          try {
            const abs = store.resolveKey(r.storage_key);
            const st = io.lstat(abs);
            if (st.isFile() && !st.isSymbolicLink() && Number(st.size) === r.size_bytes) {
              const fd = io.open(abs, RO_FLAGS);
              let ok = false;
              try { ok = (await hashFd(fd, r.size_bytes)) === r.checksum_sha256; } finally { closeQuietly(fd); }
              if (ok && store.transition(r.recording_id, ['FINALIZING'], 'READY', { partial_key: null })) { store.audit('RECORDING_RECOVERED', r.recording_id, { by: 'CHECKSUM' }); out.recovered++; continue; }
            }
          } catch { /* classified below */ }
        }
        let partialSize = 0;
        if (r.partial_key) { try { const st = io.lstat(store.resolveKey(r.partial_key)); partialSize = st.isFile() ? Number(st.size) : 0; } catch { partialSize = 0; } }
        if (partialSize === 0 && r.partial_key) { try { unlinkQuietly(store.resolveKey(r.partial_key)); } catch { /* confined */ } out.emptyRemoved++; }
        const recoverable = partialSize > 0 ? 1 : 0;
        store.transition(r.recording_id, ACTIVE_STATUSES, 'FAILED', { error_code: recoverable ? 'INTERRUPTED_RECOVERY_REQUIRED' : 'INTERRUPTED_EMPTY', recoverable, size_bytes: partialSize, ...(recoverable ? {} : { partial_key: null }) });
        store.audit('RECORDING_RECOVERY_FLAGGED', r.recording_id, { previousStatus: r.status, partialSizeBytes: partialSize, recoverable: recoverable === 1 });
        out.flagged++;
      }
      for (const r of store.byStatus(['READY'])) {
        let present = false;
        try { const st = io.lstat(store.resolveKey(r.storage_key)); present = st.isFile() && !st.isSymbolicLink(); } catch { present = false; }
        if (!present) { store.transition(r.recording_id, ['READY'], 'MISSING', { error_code: 'FILE_MISSING' }); store.audit('RECORDING_MARKED_MISSING', r.recording_id, {}); out.missing++; }
      }
      out.deleting = store.byStatus(['DELETING']).length; // a user-requested delete left incomplete: reported, retried only by the user
      const known = new Set(store.db.prepare('SELECT storage_key, partial_key FROM recorder_recordings').all().flatMap(r => [r.storage_key, r.partial_key]).filter(Boolean));
      for (const dir of ['files', 'partial']) for (const f of fs.readdirSync(`${store.root}/${dir}`)) if (!known.has(`${dir}/${f}`)) out.orphanFiles++; // reported, never deleted silently
      return Object.freeze(out);
    },

    /** Server stop: active captures become FAILED (bytes kept, recoverable) — never READY. */
    shutdown() {
      for (const [id, s] of [...sessions]) {
        sessions.delete(id); closeQuietly(s.fd);
        const keep = s.bytes > 0;
        if (!keep) unlinkQuietly(s.partialAbs);
        store.transition(id, ACTIVE_STATUSES, 'FAILED', { error_code: keep ? 'INTERRUPTED_RECOVERY_REQUIRED' : 'INTERRUPTED_EMPTY', recoverable: keep ? 1 : 0, ...(keep ? {} : { partial_key: null }) });
        store.audit('RECORDING_FAILED', id, { code: 'INTERRUPTED_BY_SHUTDOWN', sizeBytes: s.bytes, recoverable: keep });
      }
    },
    activeSessions: () => sessions.size,
    sweepIdle,
    isRecordingId,
  });
}
