// Native Recorder — RECORDER-1 UI contracts (pure: no React, no network, no wiring).
// The browser captures with standard APIs (getDisplayMedia / getUserMedia / MediaRecorder); the server owns the
// recordingId, the storage and the real type of the bytes. The UI never sends a path, an extension or an id it made up.

export type RecordingSource = 'SCREEN' | 'CAMERA';
export type RecordingType = 'SCREEN' | 'CAMERA' | 'SCREEN_WITH_MIC' | 'CAMERA_WITH_MIC';
export type CaptureState = 'IDLE' | 'ACQUIRING' | 'STARTING' | 'RECORDING' | 'PAUSED' | 'STOPPING' | 'FINALIZING' | 'READY' | 'FAILED' | 'CANCELLED';

export interface RecorderSessionDto { recordingId: string; sessionToken: string; status: string; maxChunkBytes: number; maxRecordingBytes: number; maxDurationMs: number }
export interface RecordingDto {
  recordingId: string; type: RecordingType; source: RecordingSource; status: string; title: string; createdAt: string; startedAt: string | null; stoppedAt: string | null;
  durationMs: number | null; mimeType: string | null; sizeBytes: number; width: number | null; height: number | null; hasAudio: boolean; metadataSource: string;
  checksumSha256: string | null; filename: string | null; error: string | null; recoverable: boolean; chunkCount: number;
}
export interface FinalizeResultDto { status: 'READY' | 'FAILED'; error?: string; recording: RecordingDto }
export class RecorderUiError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RecorderUiError'; this.code = code; }
}
/** The UI's only door to the Recorder (COMP-style port; the HTTP implementation is http-port.ts). */
export interface RecorderPort {
  createSession(input: { type: RecordingType; title?: string; mimeType: string }): Promise<RecorderSessionDto>;
  markStarted(recordingId: string, sessionToken: string): Promise<RecordingDto>;
  appendChunk(recordingId: string, sessionToken: string, seq: number, chunk: Blob): Promise<{ seq: number; duplicate: boolean; received: number }>;
  finalize(recordingId: string, sessionToken: string, meta: { durationMs?: number; width?: number; height?: number }): Promise<FinalizeResultDto>;
  cancel(recordingId: string, sessionToken: string): Promise<RecordingDto>;
  listRecordings(opts?: { limit?: number; offset?: number }): Promise<{ items: RecordingDto[]; total: number }>;
  getRecording(recordingId: string): Promise<RecordingDto>;
  /** [MASTER WS2] Deletes ONE recording (metadata + file) by its id — the backend DELETE route; no new semantics. */
  deleteRecording(recordingId: string): Promise<{ status: string; recordingId: string }>;
  /** [REC-DL-1] URL of the download of ONE recording, built from its id only (throws INVALID_RECORDING_ID otherwise). */
  downloadUrl(recordingId: string): string;
  /** [REC-DL-1] Server-side validation of the real file (HEAD: READY, present, unchanged) — no body is read. */
  checkDownload(recordingId: string): Promise<void>;
}

// ── [REC-DL-1] download ──
export const RECORDING_ID_RE = /^rec_[0-9a-f]{32}$/;
export const isRecordingId = (v: unknown): v is string => typeof v === 'string' && RECORDING_ID_RE.test(v);
export type DownloadState = 'IDLE' | 'CHECKING' | 'STARTED' | 'UNAVAILABLE' | 'MISSING' | 'ERROR';
export const DOWNLOAD_LABEL: Record<DownloadState, string> = {
  IDLE: 'Télécharger', CHECKING: 'Téléchargement…', STARTED: 'Téléchargement lancé', UNAVAILABLE: 'Indisponible', MISSING: 'Fichier manquant', ERROR: 'Erreur',
};
/** A download is offered ONLY for a READY recording with a real id. */
export function canDownload(r: Pick<RecordingDto, 'recordingId' | 'status'> | null | undefined): boolean {
  return Boolean(r && r.status === 'READY' && isRecordingId(r.recordingId));
}
/** Server refusal → what the person sees. Unknown codes are an error, never a success. */
export function downloadStateForError(code: unknown): DownloadState {
  if (code === 'RECORDING_FILE_MISSING') return 'MISSING';
  if (code === 'RECORDING_NOT_READY' || code === 'RECORDING_NOT_FOUND') return 'UNAVAILABLE';
  return 'ERROR';
}

/**
 * Deterministic preference, checked with MediaRecorder.isTypeSupported at run time. WebM first: open codecs and a
 * streamed container that stays readable when a capture is cut; MP4 only where the browser cannot record WebM
 * (e.g. Safari). The server re-checks the real bytes; this list never decides the stored type by itself.
 */
export const RECORDER_MIME_PREFERENCE: readonly string[] = Object.freeze([
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
]);
export function pickRecorderMime(isTypeSupported: ((mime: string) => boolean) | null | undefined): string | null {
  if (typeof isTypeSupported !== 'function') return null;
  for (const m of RECORDER_MIME_PREFERENCE) { try { if (isTypeSupported(m)) return m; } catch { /* unsupported */ } }
  return null;
}
export const containerLabel = (mime: string | null | undefined): string => (!mime ? '—' : mime.startsWith('video/webm') ? 'WebM' : mime.startsWith('video/mp4') ? 'MP4' : 'inconnu');
export const recordingType = (source: RecordingSource, withMic: boolean): RecordingType => (`${source}${withMic ? '_WITH_MIC' : ''}` as RecordingType);
export const SOURCE_LABEL: Record<RecordingSource, string> = { SCREEN: 'Écran', CAMERA: 'Caméra' };

export const STATE_LABEL: Record<CaptureState, string> = {
  IDLE: 'Prêt', ACQUIRING: 'Autorisation de capture…', STARTING: 'Démarrage…', RECORDING: 'ENREGISTREMENT EN COURS', PAUSED: 'EN PAUSE (enregistrement ouvert)',
  STOPPING: 'Arrêt…', FINALIZING: 'Finalisation…', READY: 'Enregistré', FAILED: 'Échec', CANCELLED: 'Annulé',
};
export const ACTIVE_STATES: readonly CaptureState[] = Object.freeze(['ACQUIRING', 'STARTING', 'RECORDING', 'PAUSED', 'STOPPING', 'FINALIZING']);
export const isActive = (s: CaptureState): boolean => ACTIVE_STATES.includes(s);

const ERRORS: Record<string, string> = {
  PERMISSION_DENIED: 'Autorisation refusée : rien n’a été enregistré.', DEVICE_NOT_FOUND: 'Aucun périphérique de capture disponible.',
  CAPTURE_FAILED: 'La capture n’a pas pu démarrer.', UNSUPPORTED_FORMAT: 'Ce navigateur ne sait pas enregistrer de vidéo WebM ou MP4.',
  ALREADY_RECORDING: 'Un enregistrement est déjà en cours.', RECORDER_BUSY: 'Un enregistrement est déjà en cours.', BACKPRESSURE: 'Le stockage ne suit pas : enregistrement arrêté pour ne pas saturer la mémoire.',
  UPLOAD_FAILED: 'L’envoi vers Docteur a échoué : enregistrement arrêté.', EMPTY_RECORDING: 'Aucune donnée vidéo reçue : rien n’a été enregistré.',
  DISK_FULL: 'Disque plein : enregistrement arrêté.', RECORDING_TOO_LARGE: 'Taille maximale atteinte.', RECORDING_TOO_LONG: 'Durée maximale atteinte.',
  MIME_MISMATCH: 'Le format produit ne correspond pas au format annoncé.', FINALIZE_FAILED: 'La finalisation a échoué (les données capturées sont conservées pour récupération).',
  RECORDER_ERROR: 'L’enregistreur du navigateur a signalé une erreur.', SESSION_NOT_FOUND: 'La session d’enregistrement a expiré.',
};
export function recorderErrorText(code: unknown): string {
  return typeof code === 'string' && ERRORS[code] ? ERRORS[code] : 'Erreur d’enregistrement inconnue.';
}
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} Mo`;
  return `${(n / 1073741824).toFixed(2)} Go`;
}
/** Maps a getUserMedia / getDisplayMedia rejection to a stable code. */
export function captureErrorCode(err: unknown): string {
  const name = (err as { name?: unknown })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'PERMISSION_DENIED';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'DEVICE_NOT_FOUND';
  return 'CAPTURE_FAILED';
}
