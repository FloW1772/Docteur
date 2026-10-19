// Native Recorder — RECORDER-1 contracts (pure: no fs, no DB, no network, no process).
//
// One source of truth for a recording: the Recorder catalogue (recorder-store.js). A recording is identified by a
// server-generated recordingId (rec_<32 hex>); the client never names a path, an extension or an id. The file is the
// ORIGINAL MediaRecorder output (no transcode); its type is decided by its first bytes (Media Studio sniffMedia),
// and must agree with the MIME the browser declared — never ".mp4" for a WebM.

export class RecorderError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message); this.name = 'RecorderError'; this.code = code; this.status = status;
    if (details !== undefined) this.details = details;
  }
}
export const fail = (code, message, status = 400, details) => { throw new RecorderError(code, message, status, details); };

/** V1 sources. Microphone is an option of the source, not a second recording. */
export const RECORDING_TYPES = Object.freeze(['SCREEN', 'CAMERA', 'SCREEN_WITH_MIC', 'CAMERA_WITH_MIC']);
export const RECORDING_STATUS = Object.freeze(Object.fromEntries(['PREPARING', 'RECORDING', 'FINALIZING', 'READY', 'FAILED', 'CANCELLED', 'DELETING', 'MISSING'].map(s => [s, s])));
export const ACTIVE_STATUSES = Object.freeze(['PREPARING', 'RECORDING', 'FINALIZING']);
/** Allowed transitions (anything else is refused). READY is reached only from FINALIZING. */
export const TRANSITIONS = Object.freeze({
  PREPARING: ['RECORDING', 'FAILED', 'CANCELLED'],
  RECORDING: ['FINALIZING', 'FAILED', 'CANCELLED'],
  FINALIZING: ['READY', 'FAILED'],
  READY: ['DELETING', 'MISSING'],
  FAILED: ['DELETING'],
  CANCELLED: ['DELETING'],
  MISSING: ['DELETING', 'READY'],
  DELETING: ['DELETING'],
});
export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/**
 * Containers MediaRecorder can produce that Docteur accepts, by sniffed container. A declared MIME must be one of
 * these (codecs parameter allowed); the stored mimeType is the declared one when it agrees with the sniffed container.
 */
export const CONTAINERS = Object.freeze({
  webm: Object.freeze({ ext: 'webm', baseMime: 'video/webm', sniff: 'webm' }),
  mp4: Object.freeze({ ext: 'mp4', baseMime: 'video/mp4', sniff: 'mp4' }),
});
// plain spaces only (never \s: the stored MIME becomes the download Content-Type, so CR / LF / tabs must be impossible)
const MIME_RE = /^video\/(webm|mp4)(; ?codecs="?[A-Za-z0-9., ]{1,80}"?)?$/i;
/** A MIME the browser declared → its container, or null. Only video/webm and video/mp4 (with optional codecs). */
export function containerOfMime(mime) {
  if (typeof mime !== 'string' || mime.length > 120 || /\p{Cc}/u.test(mime)) return null; // no control char at all, even trailing
  const m = MIME_RE.exec(mime.trim());
  return m ? CONTAINERS[m[1].toLowerCase()] : null;
}

/** Bounds. All PROVISIONAL (no measured Docteur recording usage yet); each has its basis. */
export const RECORDER_LIMITS = Object.freeze({
  maxChunkBytes: Object.freeze({ value: 8 * 1024 * 1024, status: 'PROVISIONAL', basis: 'same chunk size as Media Studio uploads; far under the 64 MB default local API body cap' }),
  maxRecordingBytes: Object.freeze({ value: 2 * 1024 * 1024 * 1024, status: 'PROVISIONAL', basis: 'the declared-uploads cap of the local API (2 GB)' }),
  maxDurationMs: Object.freeze({ value: 2 * 3600_000, status: 'PROVISIONAL', basis: 'a long meeting / tutorial; longer captures are split' }),
  maxActiveRecordings: Object.freeze({ value: 1, status: 'PROVISIONAL', basis: 'one capture at a time: no races between sessions' }),
  sessionIdleMs: Object.freeze({ value: 120_000, status: 'PROVISIONAL', basis: 'a capture sends a chunk every ~1 s; 2 min of silence = the tab is gone' }),
  minFreeBytes: Object.freeze({ value: 512 * 1024 * 1024, status: 'PROVISIONAL', basis: 'never fill the disk: stop before the last 512 MB' }),
  listLimit: Object.freeze({ value: 100, status: 'PROVISIONAL', basis: 'one page of recordings' }),
  titleChars: Object.freeze({ value: 120, status: 'PROVISIONAL', basis: 'a file-name-sized label' }),
  maxDimension: Object.freeze({ value: 16384, status: 'PROVISIONAL', basis: 'larger than any capture surface' }),
});
export const limitOf = (name) => RECORDER_LIMITS[name].value;

export const RECORDING_ID_RE = /^rec_[0-9a-f]{32}$/;
export const isRecordingId = (v) => typeof v === 'string' && RECORDING_ID_RE.test(v);
export function assertRecordingId(v) { if (!isRecordingId(v)) fail('INVALID_RECORDING_ID', 'Identifiant d’enregistrement invalide.'); return v; }

/** Title: bounded NFC text, no control characters (no CRLF), no path separators; default by type. */
export function cleanTitle(v, type) {
  if (v === undefined || v === null || v === '') return defaultTitle(type);
  if (typeof v !== 'string') fail('INVALID_TITLE', 'Titre invalide.');
  const s = v.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(s)) fail('INVALID_TITLE', 'Le titre contient des caractères de contrôle.');
  if (s.length > limitOf('titleChars')) fail('INVALID_TITLE', `Titre trop long (${limitOf('titleChars')} caractères maximum).`);
  const t = s.replace(/[\\/<>:"|?*]/g, ' ').replace(/\s+/g, ' ').trim();
  return t || defaultTitle(type);
}
export const defaultTitle = (type) => (String(type).startsWith('SCREEN') ? 'Enregistrement écran' : 'Enregistrement caméra');

/** Client-reported metadata (from MediaStreamTrack settings / the recorder clock): bounded, never trusted for safety. */
export function cleanClientMetadata({ durationMs = null, width = null, height = null } = {}) {
  const int = (v, max, what) => {
    if (v === null || v === undefined) return null;
    if (!Number.isSafeInteger(v) || v < 0 || v > max) fail('INVALID_METADATA', `${what} invalide.`);
    return v;
  };
  return { durationMs: int(durationMs, limitOf('maxDurationMs') + 60_000, 'durationMs'), width: int(width, limitOf('maxDimension'), 'width'), height: int(height, limitOf('maxDimension'), 'height') };
}
