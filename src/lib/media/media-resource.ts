// Media Reader V1 — the ONE place that decides what a resource is and how Docteur may show it.
//
//   classifyMediaResource(input)   URL (+ reliable MIME / Docteur metadata when known) → MediaDescriptor
//   readerReducer(state, event)    OPENING → LOADING → READY | ERROR | UNSUPPORTED (late events after a terminal state are ignored)
//   fetchTextResource(url, opts)   bounded, abortable, time-limited text read (no HTML is ever interpreted)
//
// Safety (DENY UNSAFE ACTION, NOT USEFUL FEATURE): only http(s); no credentials in URLs; loopback / private / link-local
// hosts are refused EXCEPT Docteur's own API origin (its local media routes). Nothing here talks to the server: the reader
// adds no new egress path (remote media is loaded by the browser exactly like the existing link / YouTube embed).

export type MediaKind = 'youtube' | 'video' | 'audio' | 'image' | 'pdf' | 'text' | 'web' | 'unknown';
export type MediaBlockReason = 'invalid_url' | 'dangerous_scheme' | 'credentials_in_url' | 'private_network';

export interface MediaResourceInput {
  url: string;
  title?: string | null;
  /** only when it comes from a reliable source (Docteur file metadata, HTTP Content-Type known by Docteur) */
  mimeType?: string | null;
}

export interface MediaDescriptor {
  /** stable identity: same resource ⇒ same id (used to reset the reader when the media changes) */
  id: string;
  url: string;
  kind: MediaKind;
  title: string;
  host: string;
  mimeType: string | null;
  extension: string | null;
  /** served by Docteur's own API (local file routes) */
  docteurLocal: boolean;
  /** mov / mkv: Chromium may or may not decode them — tried, with an explicit fallback */
  nativeSupport: 'yes' | 'uncertain';
  markdown: boolean;
  youtube: { videoId: string | null; playlistId: string | null; isShort: boolean; embedUrl: string } | null;
  blocked: { reason: MediaBlockReason; message: string } | null;
}

export const KIND_LABEL: Record<MediaKind, string> = {
  youtube: 'Vidéo YouTube', video: 'Vidéo', audio: 'Audio', image: 'Image', pdf: 'PDF', text: 'Texte', web: 'Page web', unknown: 'Fichier',
};

const BLOCK_MESSAGE: Record<MediaBlockReason, string> = {
  invalid_url: 'Adresse invalide',
  dangerous_scheme: 'Type de lien non autorisé dans le lecteur Docteur (seuls http et https le sont)',
  credentials_in_url: 'Lien contenant des identifiants : non ouvert dans le lecteur',
  private_network: 'Adresse locale ou réseau privé : non ouverte par le lecteur Docteur',
};

const MAX_URL_LENGTH = 4096;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST = /^[A-Za-z0-9_-]{2,80}$/;

const EXT_KIND: Record<string, MediaKind> = {
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', svg: 'image', avif: 'image', bmp: 'image', ico: 'image',
  pdf: 'pdf',
  txt: 'text', md: 'text', markdown: 'text', csv: 'text', log: 'text', json: 'text',
  html: 'web', htm: 'web', php: 'web', asp: 'web', aspx: 'web',
};
const UNCERTAIN_EXT = new Set(['mov', 'mkv']);
const MARKDOWN_EXT = new Set(['md', 'markdown']);

export function kindFromMime(mime: string | null | undefined): MediaKind | null {
  const m = String(mime ?? '').toLowerCase().split(';')[0].trim();
  if (!m) return null;
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  if (m === 'text/html' || m === 'application/xhtml+xml') return 'web';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/x-ndjson') return 'text';
  return null;
}

function extensionOf(pathname: string): string | null {
  let last = pathname.split(/[/\\]/).pop() ?? '';
  try { last = decodeURIComponent(last); } catch { /* keep raw */ }
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return null;
  const ext = last.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
}

/** loopback, private, link-local, CGNAT, unspecified, and local-only names. The URL parser has already normalised
 *  decimal / hex / short IPv4 forms (http://2130706433 → 127.0.0.1). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    return v6 === '::' || v6 === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6) || v6.startsWith('::ffff:');
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function youtubeOf(url: URL): MediaDescriptor['youtube'] {
  const host = url.hostname.toLowerCase();
  const nocookie = (videoId: string | null, playlistId: string | null, isShort: boolean) => ({
    videoId, playlistId, isShort,
    // identical to the historical player (App.tsx activeVideo overlay)
    embedUrl: videoId ? `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1` : `https://www.youtube-nocookie.com/embed/videoseries?list=${playlistId}&autoplay=1`,
  });
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return YT_ID.test(id) ? nocookie(id, null, false) : null;
  }
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'watch') { const id = url.searchParams.get('v') ?? ''; return YT_ID.test(id) ? nocookie(id, null, false) : null; }
  if (['shorts', 'live', 'embed'].includes(segments[0] ?? '') && segments.length === 2 && YT_ID.test(segments[1])) return nocookie(segments[1], null, segments[0] === 'shorts');
  if (segments[0] === 'playlist' && segments.length === 1) { const list = url.searchParams.get('list') ?? ''; return YT_LIST.test(list) ? nocookie(null, list, false) : null; }
  return null; // channels, search, home…: a web page, not something embeddable
}

function hostLabel(url: URL | null): string { return url ? url.hostname.replace(/^www\./, '') : ''; }

/**
 * @param apiOrigin Docteur API origin (e.g. http://127.0.0.1:3001): its local media routes are allowed even though loopback.
 */
export function classifyMediaResource(input: MediaResourceInput, { apiOrigin = null }: { apiOrigin?: string | null } = {}): MediaDescriptor {
  const raw = typeof input?.url === 'string' ? input.url.trim() : '';
  const base = (kind: MediaKind, url: URL | null, extra: Partial<MediaDescriptor> = {}): MediaDescriptor => ({
    id: `${kind}|${url ? url.href : raw}`, url: url ? url.href : raw, kind,
    title: (input?.title ?? '').trim() || (url ? `${hostLabel(url)}${url.pathname === '/' ? '' : url.pathname}` : raw),
    host: hostLabel(url), mimeType: input?.mimeType ? String(input.mimeType).toLowerCase() : null, extension: null,
    docteurLocal: false, nativeSupport: 'yes', markdown: false, youtube: null, blocked: null, ...extra,
  });
  const block = (reason: MediaBlockReason, url: URL | null = null) => base('unknown', url, { blocked: { reason, message: BLOCK_MESSAGE[reason] } });

  if (!raw || raw.length > MAX_URL_LENGTH) return block('invalid_url');
  let url: URL;
  try { url = new URL(raw); } catch { return block('invalid_url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return block('dangerous_scheme');
  if (url.username || url.password) return block('credentials_in_url');
  const docteurLocal = Boolean(apiOrigin) && url.origin === apiOrigin;
  if (!docteurLocal && isPrivateHost(url.hostname)) return block('private_network', url);

  const yt = youtubeOf(url);
  if (yt) return base('youtube', url, { youtube: yt });

  // Docteur's own local routes: the extension lives in a query parameter or is implied by the route
  let ext = extensionOf(url.pathname);
  if (docteurLocal && url.pathname === '/api/audio-player/file') ext = extensionOf(url.searchParams.get('path') ?? '') ?? ext;
  const mimeKind = kindFromMime(input?.mimeType);
  let kind: MediaKind | null = mimeKind;                        // 1. a reliable MIME wins over the extension
  if (!kind && docteurLocal && /^\/api\/image\/[^/]+$/.test(url.pathname)) kind = 'image';
  if (!kind && ext) kind = EXT_KIND[ext] ?? null;               // 2. extension
  if (!kind) kind = docteurLocal ? 'unknown' : 'web';           // 3. any other remote http(s) URL is a page

  const markdown = kind === 'text' && ((ext !== null && MARKDOWN_EXT.has(ext)) || /markdown/.test(input?.mimeType ?? ''));
  const nativeSupport = (kind === 'video' || kind === 'audio') && ext !== null && UNCERTAIN_EXT.has(ext) && !mimeKind ? 'uncertain' : 'yes';
  return base(kind, url, { extension: ext, docteurLocal, markdown, nativeSupport });
}

/** Kind for the inline "open in Docteur" button (icon / label only; the reader re-classifies with the full policy). */
export function linkMediaKind(href: string, apiOrigin: string | null = null): MediaKind { return classifyMediaResource({ url: href }, { apiOrigin }).kind; }

// ── reader state machine ────────────────────────────────────────────────────────────────────────────────────────────

export type ReaderPhase = 'OPENING' | 'LOADING' | 'READY' | 'ERROR' | 'UNSUPPORTED';
export interface ReaderState { phase: ReaderPhase; slow: boolean; message: string | null }
export type ReaderEvent =
  | { type: 'start' } | { type: 'slow' } | { type: 'ready' }
  | { type: 'error'; message: string } | { type: 'unsupported'; message?: string } | { type: 'timeout' };

export const LOAD_TIMEOUT_MS = 20_000;
export const SLOW_AFTER_MS = 4_000;
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const PDF_MAX_BYTES = 150 * 1024 * 1024;
export const UNSUPPORTED_MESSAGE = 'Ce format ne peut pas être prévisualisé directement dans Docteur.';

const TERMINAL: ReadonlySet<ReaderPhase> = new Set(['READY', 'ERROR', 'UNSUPPORTED']);

export function initialReaderState(d: MediaDescriptor): ReaderState {
  if (d.blocked) return { phase: 'ERROR', slow: false, message: d.blocked.message };
  if (d.kind === 'unknown') return { phase: 'UNSUPPORTED', slow: false, message: UNSUPPORTED_MESSAGE };
  if (d.kind === 'web') return { phase: 'READY', slow: false, message: null }; // a card: nothing is loaded
  return { phase: 'OPENING', slow: false, message: null };
}

export function readerReducer(state: ReaderState, event: ReaderEvent): ReaderState {
  if (event.type === 'start') return { phase: 'LOADING', slow: false, message: null };
  if (TERMINAL.has(state.phase)) return state; // a late "ready" / "error" after a timeout or a close never flips the screen
  switch (event.type) {
    case 'slow': return { ...state, slow: true };
    case 'ready': return { phase: 'READY', slow: false, message: null };
    case 'error': return { phase: 'ERROR', slow: false, message: event.message };
    case 'unsupported': return { phase: 'UNSUPPORTED', slow: false, message: event.message ?? UNSUPPORTED_MESSAGE };
    case 'timeout': return { phase: 'ERROR', slow: false, message: 'Le média met trop de temps à se charger (délai dépassé).' };
  }
}

/** HTMLMediaElement error code → reader event (1 aborted, 2 network, 3 decode, 4 source not supported). */
export function mediaErrorEvent(code: number | null | undefined): ReaderEvent {
  if (code === 3 || code === 4) return { type: 'unsupported' };
  if (code === 2) return { type: 'error', message: 'Erreur réseau : le média est inaccessible.' };
  return { type: 'error', message: 'Le média n’a pas pu être chargé.' };
}

// ── bounded reads (text, PDF bytes) ─────────────────────────────────────────────────────────────────────────────────

const TEXTUAL_TYPE = /^(text\/|application\/(json|x-ndjson|xml|markdown)|$)/;

async function readBounded(res: Response, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean }> {
  if (!res.body) { const buf = new Uint8Array(await res.arrayBuffer()); return { bytes: buf.slice(0, maxBytes), truncated: buf.length > maxBytes }; }
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Annulé', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      if (value.length > room) { chunks.push(value.slice(0, room)); size += room; truncated = true; break; }
      chunks.push(value); size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return { bytes: out, truncated };
}

export async function fetchTextResource(url: string, { signal, fetchImpl = fetch, maxBytes = TEXT_MAX_BYTES }: { signal: AbortSignal; fetchImpl?: typeof fetch; maxBytes?: number }): Promise<{ text: string; truncated: boolean }> {
  const res = await fetchImpl(url, { signal, credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`Contenu inaccessible (HTTP ${res.status})`);
  const type = (res.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (!TEXTUAL_TYPE.test(type)) throw Object.assign(new Error(UNSUPPORTED_MESSAGE), { unsupported: true });
  const { bytes, truncated } = await readBounded(res, maxBytes, signal);
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated };
}

/** PDF bytes, verified by their %PDF signature (never an HTML page pretending to be a PDF). */
export async function fetchPdfBytes(url: string, { signal, fetchImpl = fetch, maxBytes = PDF_MAX_BYTES }: { signal: AbortSignal; fetchImpl?: typeof fetch; maxBytes?: number }): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchImpl(url, { signal, credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`PDF inaccessible (HTTP ${res.status})`);
  const { bytes, truncated } = await readBounded(res, maxBytes + 1, signal);
  if (truncated || bytes.length > maxBytes) throw Object.assign(new Error('PDF trop volumineux pour l’aperçu intégré'), { unsupported: true });
  const signature = String.fromCharCode(...bytes.slice(0, 5));
  if (signature !== '%PDF-') throw Object.assign(new Error('Ce fichier n’est pas un PDF valide'), { unsupported: true });
  return bytes;
}
