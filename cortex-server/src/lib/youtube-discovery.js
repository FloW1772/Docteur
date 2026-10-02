// YouTube Smart Discovery V2 — the URL decides what is discovered. No manual 25/50/100/ALL choice, no artificial cap.
//
//   classifyDiscoveryInput(raw)  URL (or explicit-workflow @handle) → mode + sources, pure and deterministic
//   discoverYouTube(input, ...)  runs one yt-dlp --flat-playlist per source (sequentially), dedups by videoId (Map, O(n)),
//                                and emits typed events: start, mode, phase_start, progress, items_batch, phase_done,
//                                done | cancelled | error
//
// Watchdog policy (replaces the 60 s "no new entry" rule that killed healthy ALL crawls): yt-dlp is spawned with -v so it
// writes one stderr line per API page while it crawls silently. ANY stdout/stderr activity is a heartbeat; only a real
// silence of STALL_MS aborts the process (TimeoutError code DISCOVERY_STALLED). A separate, much larger MAX_RUNTIME_MS is the
// hard ceiling (TimeoutError code DISCOVERY_MAX_RUNTIME). Abort / timeout kill the whole process tree (see process-tree.js).
import { spawn } from 'node:child_process';
import { YTDLP_BIN, normalizePlaylistEntry, optionalString, optionalNumber, friendlyError } from './ytdlp.js';
import { prepareYtDlp } from './media-egress.js';
import { killProcessTree } from './process-tree.js';

export const DISCOVERY_MODES = Object.freeze({
  ALL_MEDIA: 'CHANNEL_ALL_MEDIA',
  VIDEOS_ONLY: 'CHANNEL_VIDEOS_ONLY',
  SHORTS_ONLY: 'CHANNEL_SHORTS_ONLY',
  STREAMS_ONLY: 'CHANNEL_STREAMS_ONLY',
  PLAYLIST_ONLY: 'PLAYLIST_ONLY',
  SINGLE_VIDEO: 'SINGLE_VIDEO',
  SINGLE_SHORT: 'SINGLE_SHORT',
  CHANNEL_LIVE: 'CHANNEL_LIVE',
});

export const DEFAULT_STALL_MS = 90_000;          // no stdout AND no stderr byte for this long = real hang
export const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000; // hard ceiling per source (a 2 573-Short channel takes 40–150 s)
export const DEFAULT_BATCH_SIZE = 100;            // technical batch for events; NOT a user limit
export const DEFAULT_KILL_SETTLE_MS = 5_000;

const TAB_MEDIA = Object.freeze({ videos: 'VIDEO', shorts: 'SHORT', streams: 'STREAM', playlist: 'VIDEO' });
const MEDIA_RANK = Object.freeze({ VIDEO: 1, SHORT: 2, STREAM: 2 });
const ROOT_LIKE_TABS = new Set(['featured', 'about', 'home']);
const SUPPORTED_TABS = new Set(['videos', 'shorts', 'streams']);
const ROOT_ALL_TABS = ['videos', 'shorts', 'streams'];
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,80}$/;
const HANDLE_NAME_RE = /^[\p{L}\p{N}\p{M}._-]{1,100}$/u;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const LEGACY_NAME_RE = /^[\p{L}\p{N}\p{M}._-]{1,100}$/u;

function isYoutubeHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'youtube.com' || host.endsWith('.youtube.com');
}

function safeDecode(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}

function channelSources(base, tabs) {
  return tabs.map(tab => ({ tab, mediaType: TAB_MEDIA[tab], url: `${base}/${tab}` }));
}

function fail(reason) { return { ok: false, reason }; }

// raw: a URL, or (only when allowBareHandle — an explicit YouTube workflow) "@handle" / "/@handle[/tab]".
export function classifyDiscoveryInput(raw, { allowBareHandle = false } = {}) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input || input.length > 2048 || /[\s\u0000-\u001f]/.test(input)) return fail('invalid_input');

  let url;
  const bare = /^\/?@/.test(input) && !/^https?:\/\//i.test(input);
  if (bare) {
    if (!allowBareHandle) return fail('bare_handle_not_allowed');
    try { url = new URL(`https://www.youtube.com${input.startsWith('/') ? '' : '/'}${input}`); } catch { return fail('invalid_input'); }
  } else {
    try { url = new URL(input); } catch { return fail('invalid_input'); }
    if (!['http:', 'https:'].includes(url.protocol)) return fail('invalid_input');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = safeDecode(url.pathname.split('/').filter(Boolean)[0] ?? '');
    return id && VIDEO_ID_RE.test(id)
      ? { ok: true, mode: DISCOVERY_MODES.SINGLE_VIDEO, kind: 'video', videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, sources: [] }
      : fail('invalid_video_id');
  }
  if (!isYoutubeHost(host)) return fail('not_youtube');

  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0] ?? '';

  if (first === 'watch') {
    const id = url.searchParams.get('v') ?? '';
    return VIDEO_ID_RE.test(id)
      ? { ok: true, mode: DISCOVERY_MODES.SINGLE_VIDEO, kind: 'video', videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, sources: [] }
      : fail('invalid_video_id');
  }
  if ((first === 'live' || first === 'embed') && segments.length === 2) {
    const id = safeDecode(segments[1]);
    return id && VIDEO_ID_RE.test(id)
      ? { ok: true, mode: DISCOVERY_MODES.SINGLE_VIDEO, kind: 'video', videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, sources: [] }
      : fail('invalid_video_id');
  }
  if (first === 'shorts' && segments.length === 2) {
    const id = safeDecode(segments[1]);
    return id && VIDEO_ID_RE.test(id)
      ? { ok: true, mode: DISCOVERY_MODES.SINGLE_SHORT, kind: 'short', videoId: id, canonicalUrl: `https://www.youtube.com/shorts/${id}`, sources: [] }
      : fail('invalid_video_id');
  }
  if (first === 'playlist' && segments.length === 1) {
    const id = url.searchParams.get('list') ?? '';
    return PLAYLIST_ID_RE.test(id)
      ? {
        ok: true, mode: DISCOVERY_MODES.PLAYLIST_ONLY, kind: 'playlist', playlistId: id,
        canonicalUrl: `https://www.youtube.com/playlist?list=${id}`,
        sources: [{ tab: 'playlist', mediaType: 'VIDEO', url: `https://www.youtube.com/playlist?list=${id}` }],
      }
      : fail('invalid_playlist_id');
  }

  // channel: /@handle | /channel/UC… | /c/name | /user/name, then at most one tab segment
  let base;
  let handle = null;
  let consumed;
  if (first.startsWith('@')) {
    const name = safeDecode(first.slice(1));
    if (!name || !HANDLE_NAME_RE.test(name)) return fail('invalid_handle');
    handle = `@${name}`;
    base = `https://www.youtube.com/@${encodeURIComponent(name)}`;
    consumed = 1;
  } else if (first === 'channel' || first === 'c' || first === 'user') {
    const name = safeDecode(segments[1] ?? '');
    const ok = name && (first === 'channel' ? CHANNEL_ID_RE.test(name) : LEGACY_NAME_RE.test(name));
    if (!ok) return fail('invalid_channel');
    base = `https://www.youtube.com/${first}/${encodeURIComponent(name)}`;
    consumed = 2;
  } else {
    return fail('unsupported_path');
  }

  const rest = segments.slice(consumed);
  if (rest.length > 1) return fail('unsupported_path');
  const tab = rest[0] ? rest[0].toLowerCase() : null;
  const common = { ok: true, kind: 'channel', handle, canonicalUrl: base, channelPath: new URL(base).pathname };

  if (tab === null || ROOT_LIKE_TABS.has(tab)) {
    return { ...common, mode: DISCOVERY_MODES.ALL_MEDIA, tab: null, sources: channelSources(base, ROOT_ALL_TABS) };
  }
  if (tab === 'live') return { ...common, mode: DISCOVERY_MODES.CHANNEL_LIVE, kind: 'live', tab, canonicalUrl: `${base}/live`, sources: [] };
  if (!SUPPORTED_TABS.has(tab)) return fail('unsupported_tab');
  const mode = tab === 'videos' ? DISCOVERY_MODES.VIDEOS_ONLY : tab === 'shorts' ? DISCOVERY_MODES.SHORTS_ONLY : DISCOVERY_MODES.STREAMS_ONLY;
  return { ...common, mode, tab, canonicalUrl: `${base}/${tab}`, sources: channelSources(base, [tab]) };
}

// ─── yt-dlp one-source runner ──────────────────────────────────────────────────────────────────────────

const PAGE_RE = /page (\d+): Downloading/;
const TAB_MISSING_RE = /does not have a .*tab|no (?:videos|shorts|streams) (?:tab|found)|tab.*does not exist/i;

function abortError() { const e = new Error('Annulé'); e.name = 'AbortError'; return e; }
function timeoutError(code, message) { const e = new Error(message); e.name = 'TimeoutError'; e.code = code; return e; }

function ytdlpErrorText(stderrTail) {
  const lines = stderrTail.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const errors = lines.filter(l => /^ERROR:/i.test(l));
  const useful = errors.length ? errors : lines.filter(l => !l.startsWith('[') && !/^WARNING/i.test(l)).slice(-3);
  return useful.join('\n');
}

export function runYtDlpSource({
  url, signal, onEntry, onPage, onActivity,
  stallMs = DEFAULT_STALL_MS, maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS, killSettleMs = DEFAULT_KILL_SETTLE_MS, spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    // -v: one stderr line per API page = the heartbeat of the otherwise silent crawl. argv is structured; the URL is a single element.
    const args = [url, '--flat-playlist', '--dump-json', '--no-warnings', '--no-playlist-reverse', '-v'];
    try { args.push(...prepareYtDlp({ action: 'MEDIA_INSPECT', spawnInjected: spawnImpl !== spawn })); } catch (err) { return reject(err); } // ROOT POLICY + egress proxy
    let proc;
    try { proc = spawnImpl(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (err) { return reject(err); }

    const startedAt = Date.now();
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stderrTail = '';
    let pages = 0;
    let entries = 0;
    let failure = null;
    let settled = false;
    let stallTimer = null;
    let maxTimer = null;
    let settleTimer = null;
    const meta = { title: '', uploader: '', playlistId: '', channelId: '', declaredCount: undefined };

    const cleanup = () => {
      clearTimeout(stallTimer); clearTimeout(maxTimer); clearTimeout(settleTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };

    const terminate = err => {
      if (failure || settled) return;
      failure = err;
      void killProcessTree(proc);
      // The tree kill closes the pipes immediately. If something still keeps them open, do not hang forever.
      settleTimer = setTimeout(() => {
        try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch { /* ignore */ }
        settle(reject, failure);
      }, Math.max(1, killSettleMs));
    };
    function onAbort() { terminate(abortError()); }

    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => terminate(timeoutError('DISCOVERY_STALLED',
        `yt-dlp ne répond plus (aucune activité depuis ${Math.round(stallMs / 1000)} s)`)), Math.max(1, stallMs));
    };
    const activity = () => { armStall(); onActivity?.({ pages, entries, elapsedMs: Date.now() - startedAt }); };

    maxTimer = setTimeout(() => terminate(timeoutError('DISCOVERY_MAX_RUNTIME',
      `Durée maximale de découverte dépassée (${Math.round(maxRuntimeMs / 60_000)} min)`)), Math.max(1, maxRuntimeMs));
    armStall();
    signal?.addEventListener('abort', onAbort, { once: true });

    const consumeStdout = flush => {
      const lines = stdoutBuffer.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      if (flush && remainder.trim()) lines.push(remainder);
      stdoutBuffer = flush ? '' : remainder;
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; } // malformed extractor line
        if (!meta.title) meta.title = optionalString(entry?.playlist_title) ?? optionalString(entry?.playlist) ?? '';
        if (!meta.uploader) meta.uploader = optionalString(entry?.playlist_uploader) ?? optionalString(entry?.playlist_channel) ?? optionalString(entry?.channel) ?? optionalString(entry?.uploader) ?? '';
        if (!meta.playlistId) meta.playlistId = optionalString(entry?.playlist_id) ?? '';
        if (!meta.channelId) meta.channelId = optionalString(entry?.playlist_channel_id) ?? optionalString(entry?.channel_id) ?? '';
        const count = optionalNumber(entry?.playlist_count) ?? optionalNumber(entry?.n_entries);
        if (count !== undefined) meta.declaredCount = count;
        entries += 1;
        onEntry?.(entry, meta);
      }
    };

    proc.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      activity();
      consumeStdout(false);
    });
    proc.stderr.on('data', chunk => {
      activity();
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const page = line.match(PAGE_RE);
        if (page) { pages = Math.max(pages, Number(page[1])); onPage?.({ pages, entries, elapsedMs: Date.now() - startedAt }); }
      }
      stderrTail = (stderrTail + chunk.toString()).slice(-16_384);
    });

    proc.on('error', err => {
      if (err.code === 'ENOENT') settle(reject, new Error('yt-dlp introuvable. Lance : winget install yt-dlp'));
      else settle(reject, err);
    });

    proc.on('close', code => {
      if (failure) return settle(reject, failure);
      if (signal?.aborted) return settle(reject, abortError());
      consumeStdout(true);
      if (code !== 0) {
        const text = ytdlpErrorText(stderrTail);
        if (entries === 0 && TAB_MISSING_RE.test(text)) return settle(resolve, { ...meta, entries, pages, available: false });
        const err = new Error(friendlyError(text));
        err.code = 'YTDLP_ERROR';
        return settle(reject, err);
      }
      settle(resolve, { ...meta, entries, pages, available: true });
    });
  });
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────────────────────────────

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function singleItem(classified) {
  const isShort = classified.mode === DISCOVERY_MODES.SINGLE_SHORT;
  return {
    id: classified.videoId, title: '', url: classified.canonicalUrl,
    sourceChannel: '', sourceTab: isShort ? 'shorts' : 'videos', mediaType: isShort ? 'SHORT' : 'VIDEO',
  };
}

export async function discoverYouTube(input, {
  signal,
  onEvent = () => {},
  allowBareHandle = false,
  spawnImpl = spawn,
  stallMs = envNumber('DOCTEUR_YTDLP_STALL_MS', DEFAULT_STALL_MS),
  maxRuntimeMs = envNumber('DOCTEUR_YTDLP_MAX_RUNTIME_MS', DEFAULT_MAX_RUNTIME_MS),
  batchSize = DEFAULT_BATCH_SIZE,
  killSettleMs = DEFAULT_KILL_SETTLE_MS,
} = {}) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const classified = classifyDiscoveryInput(input, { allowBareHandle });
  if (!classified.ok) {
    onEvent({ type: 'error', name: 'Error', code: 'INVALID_INPUT', reason: classified.reason, message: 'URL YouTube non supportée' });
    return { status: 'error', code: 'INVALID_INPUT', items: [] };
  }
  onEvent({ type: 'start', input: String(input).trim(), at: startedAt });
  const channel = { handle: classified.handle ?? null, url: classified.canonicalUrl, title: '', uploader: '', id: classified.playlistId ?? '' };
  onEvent({
    type: 'mode', mode: classified.mode, kind: classified.kind, handle: classified.handle ?? null,
    canonicalUrl: classified.canonicalUrl, sources: classified.sources.map(s => s.tab),
  });

  const counts = { videos: 0, shorts: 0, streams: 0, playlist: 0 };
  const index = new Map();
  const merged = new Set();
  let duplicates = 0;
  const finish = (status, extra = {}) => {
    const items = [...index.values()];
    const summary = { status, mode: classified.mode, total: items.length, counts, duplicates, durationMs: elapsed(), channel, items };
    onEvent({ type: status, mode: classified.mode, total: items.length, counts, duplicates, durationMs: elapsed(), channel, ...(status === 'done' ? { merged: [...merged].map(id => {
      const it = index.get(id);
      return { id, mediaType: it.mediaType, url: it.url, sourceTab: it.sourceTab, sourceTabs: it.sourceTabs };
    }) } : {}), ...extra });
    return { ...summary, ...extra };
  };

  if (classified.mode === DISCOVERY_MODES.CHANNEL_LIVE) {
    onEvent({ type: 'error', name: 'Error', code: 'UNSUPPORTED_MODE', message: 'Une URL /live désigne un direct précis, pas une liste de chaîne' });
    return { status: 'error', code: 'UNSUPPORTED_MODE', items: [] };
  }
  if (classified.sources.length === 0) { // single video / single short: never a channel listing
    const item = singleItem(classified);
    index.set(item.id, item);
    counts[item.sourceTab] += 1;
    onEvent({ type: 'items_batch', tab: item.sourceTab, items: [item], total: 1 });
    return finish('done');
  }

  const rank = media => MEDIA_RANK[media] ?? 0;
  const addEntry = (entry, source, meta, pending) => {
    const base = normalizePlaylistEntry(entry, source.tab === 'shorts');
    if (!base) return;
    const mediaType = source.tab === 'playlist' ? (/\/shorts\//.test(base.url) ? 'SHORT' : 'VIDEO') : source.mediaType;
    const previous = index.get(base.id);
    if (!previous) {
      const item = { ...base, sourceChannel: base.channel ?? meta.uploader ?? '', sourceTab: source.tab, mediaType };
      index.set(item.id, item);
      counts[source.tab] += 1;
      pending.push(item);
      return;
    }
    duplicates += 1;
    const tabs = previous.sourceTabs ?? [previous.sourceTab];
    if (!tabs.includes(source.tab)) {
      previous.sourceTabs = [...tabs, source.tab];
      counts[source.tab] += 1; // present in this tab too (documented: tab counts may overlap, total is unique)
      merged.add(previous.id);
    }
    if (rank(mediaType) > rank(previous.mediaType)) {
      previous.mediaType = mediaType;
      previous.sourceTab = source.tab;
      previous.url = source.tab === 'shorts' ? `https://www.youtube.com/shorts/${previous.id}` : `https://www.youtube.com/watch?v=${previous.id}`;
      merged.add(previous.id);
    }
  };

  try {
    for (let i = 0; i < classified.sources.length; i++) {
      const source = classified.sources[i];
      if (signal?.aborted) throw abortError();
      const phaseStart = Date.now();
      onEvent({ type: 'phase_start', tab: source.tab, index: i, total: classified.sources.length });
      const pending = [];
      let lastProgress = 0;
      let pagesSeen = 0;
      const flush = () => {
        while (pending.length > 0) onEvent({ type: 'items_batch', tab: source.tab, items: pending.splice(0, batchSize), total: index.size });
      };
      const emitProgress = (state, force = false) => {
        const now = Date.now();
        if (!force && now - lastProgress < 200) return;
        lastProgress = now;
        onEvent({ type: 'progress', tab: source.tab, pages: state.pages, count: counts[source.tab], total: index.size, elapsedMs: elapsed() });
      };
      const result = await runYtDlpSource({
        url: source.url, signal, stallMs, maxRuntimeMs, killSettleMs, spawnImpl,
        onEntry: (entry, meta) => {
          addEntry(entry, source, meta, pending);
          if (pending.length >= batchSize) flush();
          emitProgress({ pages: pagesSeen });
        },
        onPage: state => { pagesSeen = state.pages; emitProgress(state, true); },
      });
      flush();
      if (!channel.title) channel.title = result.title;
      if (!channel.uploader) channel.uploader = result.uploader;
      if (!channel.id) channel.id = result.channelId || result.playlistId;
      onEvent({ type: 'phase_done', tab: source.tab, count: counts[source.tab], available: result.available, pages: result.pages, durationMs: Date.now() - phaseStart, total: index.size });
    }
    return finish('done');
  } catch (err) {
    if (err?.name === 'AbortError') return finish('cancelled');
    onEvent({ type: 'error', name: err?.name ?? 'Error', code: err?.code ?? 'YTDLP_ERROR', message: err?.message ?? 'Échec de la découverte YouTube', total: index.size, counts });
    return { status: 'error', code: err?.code ?? 'YTDLP_ERROR', message: err?.message, items: [...index.values()], counts };
  }
}
