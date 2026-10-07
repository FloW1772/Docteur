// [Media Studio V1] Media Reader → Media Studio bridge: reads a media the browser already has access to
// (bounded, abortable, no cookies, no referrer), then the studio uploads it in chunks. The server decides the
// real type from the bytes (an HTML page renamed .mp4 is refused). No server-side download: no new egress path.

export const BRIDGE_MAX_BYTES = 1024 * 1024 * 1024;

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'BridgeError'; }
}

/** File name for the studio's asset list: last path segment (decoded) or the reader title. */
export function bridgeFileName(url: string, title?: string | null): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').trim();
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last.slice(0, 120);
  } catch { /* falls back to the title */ }
  return (title ?? '').trim().slice(0, 120) || 'média';
}

export async function fetchMediaBlob(url: string, { signal, fetchImpl = fetch, maxBytes = BRIDGE_MAX_BYTES, onProgress }: {
  signal?: AbortSignal; fetchImpl?: typeof fetch; maxBytes?: number; onProgress?: (received: number, total: number | null) => void;
} = {}): Promise<Blob> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal, credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new BridgeError('SOURCE_NOT_READABLE', 'Le site source n’autorise pas Docteur à récupérer ce média. Téléchargez-le, puis importez le fichier dans le Media Studio.');
  }
  if (!res.ok) throw new BridgeError('SOURCE_HTTP_ERROR', `Média inaccessible (HTTP ${res.status}).`);
  const declared = Number(res.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total !== null && total > maxBytes) throw new BridgeError('FILE_TOO_LARGE', 'Média trop volumineux pour le Media Studio (1 Go maximum).');
  const type = res.headers.get('content-type') ?? '';
  if (!res.body) {
    const blob = await res.blob();
    if (blob.size > maxBytes) throw new BridgeError('FILE_TOO_LARGE', 'Média trop volumineux pour le Media Studio (1 Go maximum).');
    onProgress?.(blob.size, total);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) { void reader.cancel(); throw new BridgeError('FILE_TOO_LARGE', 'Média trop volumineux pour le Media Studio (1 Go maximum).'); }
    chunks.push(value as Uint8Array<ArrayBuffer>);
    onProgress?.(received, total);
  }
  if (received === 0) throw new BridgeError('EMPTY_SOURCE', 'Le média récupéré est vide.');
  return new Blob(chunks, { type });
}
