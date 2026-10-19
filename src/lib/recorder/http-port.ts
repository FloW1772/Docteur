// Native Recorder — RECORDER-1 HTTP RecorderPort over the isolated route factory (cortex-server/src/routes/recorder.js).
// App.tsx configures this port with the same backend-origin convention as the rest of Docteur.
// The session token travels in a header, never in the URL. A chunk is sent as its raw Blob (no base64, no copy of
// the whole recording).
import { RecorderUiError, isRecordingId, type FinalizeResultDto, type RecorderPort, type RecorderSessionDto, type RecordingDto } from './recorder-contracts.ts';

export const RECORDER_SESSION_HEADER = 'x-docteur-recorder-session';
export const RECORDER_ERROR_HEADER = 'x-docteur-recorder-error';

export function createHttpRecorderPort({ baseUrl, fetchImpl = fetch }: { baseUrl: string; fetchImpl?: typeof fetch }): RecorderPort {
  const api = `${baseUrl.replace(/\/+$/, '')}/api/recorder`;
  async function call<T>(method: string, url: string, { json, body, token }: { json?: unknown; body?: Blob; token?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (body) headers['content-type'] = 'application/octet-stream';
    if (token) headers[RECORDER_SESSION_HEADER] = token;
    let res: Response;
    try { res = await fetchImpl(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : body }); } catch { throw new RecorderUiError('UPLOAD_FAILED', 'Docteur est injoignable.'); }
    let data: { ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || data.ok === false) throw new RecorderUiError(data.error?.code ?? `HTTP_${res.status}`, data.error?.message ?? 'Requête refusée.');
    return data as T;
  }
  const id = (v: string) => encodeURIComponent(v);
  /** [REC-DL-1] Only a well-formed recordingId ever reaches a URL: no path, no storage key, no file name. */
  const downloadUrl = (recordingId: string) => {
    if (!isRecordingId(recordingId)) throw new RecorderUiError('INVALID_RECORDING_ID', 'Identifiant d’enregistrement invalide.');
    return `${api}/recordings/${recordingId}/download`;
  };
  return Object.freeze({
    downloadUrl,
    /** HEAD: the server opens and checks the real file, then closes it; the body (the video) is never fetched here. */
    async checkDownload(recordingId) {
      const url = downloadUrl(recordingId);
      let res: Response;
      try { res = await fetchImpl(url, { method: 'HEAD' }); } catch { throw new RecorderUiError('UPLOAD_FAILED', 'Docteur est injoignable.'); }
      if (!res.ok) throw new RecorderUiError(res.headers.get(RECORDER_ERROR_HEADER) ?? `HTTP_${res.status}`, 'Téléchargement refusé.');
    },
    async createSession(input) { return (await call<{ session: RecorderSessionDto }>('POST', `${api}/sessions`, { json: input })).session; },
    async markStarted(recordingId, token) { return (await call<{ recording: RecordingDto }>('POST', `${api}/sessions/${id(recordingId)}/start`, { token })).recording; },
    async appendChunk(recordingId, token, seq, chunk) { return (await call<{ ack: { seq: number; duplicate: boolean; received: number } }>('PUT', `${api}/sessions/${id(recordingId)}/chunks/${seq}`, { body: chunk, token })).ack; },
    async finalize(recordingId, token, meta) { return call<FinalizeResultDto>('POST', `${api}/sessions/${id(recordingId)}/finalize`, { json: meta, token }); },
    async cancel(recordingId, token) { return (await call<{ recording: RecordingDto }>('POST', `${api}/sessions/${id(recordingId)}/cancel`, { token })).recording; },
    async listRecordings({ limit = 50, offset = 0 } = {}) { return call<{ items: RecordingDto[]; total: number }>('GET', `${api}/recordings?limit=${limit}&offset=${offset}`); },
    async getRecording(recordingId) { return (await call<{ recording: RecordingDto }>('GET', `${api}/recordings/${id(recordingId)}`)).recording; },
    /** [MASTER WS2] DELETE one recording by id. The id is validated client-side before it ever reaches the URL. */
    async deleteRecording(recordingId) {
      if (!isRecordingId(recordingId)) throw new RecorderUiError('INVALID_RECORDING_ID', 'Identifiant d’enregistrement invalide.');
      return (await call<{ result: { status: string; recordingId: string } }>('DELETE', `${api}/recordings/${id(recordingId)}`)).result;
    },
  } satisfies RecorderPort);
}
