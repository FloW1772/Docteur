import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from './process-tree.js';
import { prepareYtDlp } from './media-egress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LOCAL_BIN = path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function findBin() {
  if (fs.existsSync(LOCAL_BIN)) return LOCAL_BIN;
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

export const YTDLP_BIN = findBin();
export const DEFAULT_DISCOVERY_LIMIT = 100;
export const SUPPORTED_DISCOVERY_LIMITS = Object.freeze([25, 50, 100]);
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;

export async function checkYtDlp() {
  return new Promise(resolve => {
    const proc = spawn(YTDLP_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout?.on('data', d => { out += d.toString(); });
    proc.on('close', code => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });
}

// Parse yt-dlp progress line, e.g.:
// [download]  45.3% of 128.34MiB at  1.23MiB/s ETA 01:23
const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+([\d.~]+\s*\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/;

export function downloadVideo(url, folder, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(folder, { recursive: true }); } catch { /* ignore */ }

    const outputTemplate = path.join(folder, '%(title)s.%(ext)s');
    const args = [
      url,
      '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--newline',
      '-o', outputTemplate,
      '--no-warnings',
    ];

    // ROOT POLICY (MEDIA_DOWNLOAD) + media egress proxy: DNS / redirects / CDN hops are validated and pinned (yt-dlp is not disabled).
    try { args.push(...prepareYtDlp({ action: 'MEDIA_DOWNLOAD' })); } catch (error) { reject(error); return; }
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let finalPath = '';
    let title = '';
    let lastStderr = '';

    if (signal) {
      const onAbort = () => { try { proc.kill(); } catch { /* ignore */ } };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    proc.stdout.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        const mProg = line.match(PROGRESS_RE);
        if (mProg) {
          onProgress?.({ type: 'progress', percent: parseFloat(mProg[1]), total: mProg[2].trim(), speed: mProg[3], eta: mProg[4] });
          continue;
        }
        // Capture destination path
        const destMatch = line.match(/\[(?:download|Merger)\]\s+(?:Destination:|Merging formats into "(.+)")/)
          || line.match(/\[download\] (.+\.mp4|.+\.mkv|.+\.webm)$/);
        if (destMatch) {
          const p = (destMatch[1] || '').replace(/^"|"$/g, '').trim();
          if (p && p.includes(path.sep || '/')) {
            finalPath = p;
            if (!title) title = path.basename(p, path.extname(p));
          }
        }
        // Also catch "has already been downloaded"
        const alreadyMatch = line.match(/has already been downloaded(?: and merged)?\s*$/);
        if (alreadyMatch && !finalPath) {
          const m2 = line.match(/\[download\] (.+) has already/);
          if (m2) { finalPath = m2[1].trim(); title = path.basename(finalPath, path.extname(finalPath)); }
        }
      }
    });

    proc.stderr.on('data', chunk => { lastStderr = chunk.toString().trim(); });

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp introuvable. Lance : winget install yt-dlp  — ou place yt-dlp.exe dans cortex-server/bin/'));
      } else {
        reject(err);
      }
    });

    proc.on('close', code => {
      if (signal?.aborted) {
        const e = new Error('Téléchargement annulé');
        e.name = 'AbortError';
        return reject(e);
      }
      if (code !== 0) return reject(new Error(friendlyError(lastStderr)));

      // Fallback: scan folder for most recent mp4/mkv/webm if path not captured
      if (!finalPath) {
        try {
          const files = fs.readdirSync(folder)
            .filter(f => /\.(mp4|mkv|webm|avi|mov)$/i.test(f))
            .map(f => ({ f, mt: fs.statSync(path.join(folder, f)).mtimeMs }))
            .sort((a, b) => b.mt - a.mt);
          if (files[0]) {
            finalPath = path.join(folder, files[0].f);
            title = path.basename(finalPath, path.extname(finalPath));
          }
        } catch { /* ignore */ }
      }

      resolve({ filePath: finalPath || '', title: title || 'Vidéo téléchargée' });
    });
  });
}

// Download auto-subtitles only (no video), returns path to .srt file or null
export function downloadSubtitles(url, tempDir, { signal } = {}) {
  return new Promise(resolve => {
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch { /* ignore */ }

    const args = [
      url,
      '--write-auto-subs',
      '--sub-langs', 'fr,en',
      '--sub-format', 'srt',
      '--skip-download',
      '--no-playlist',
      '-o', path.join(tempDir, '%(id)s'),
    ];

    try { args.push(...prepareYtDlp({ action: 'MEDIA_INSPECT' })); } catch { resolve(null); return; } // ROOT POLICY refusal ⇒ "no subtitles"
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (signal) signal.addEventListener('abort', () => { try { proc.kill(); } catch { /* ignore */ } }, { once: true });

    proc.on('close', () => {
      try {
        const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.srt'));
        resolve(files.length > 0 ? path.join(tempDir, files[0]) : null);
      } catch { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

// Clean subtitle text (remove timestamps, sequence numbers, HTML tags)
export function cleanSubtitleText(raw) {
  return raw
    .split('\n')
    .filter(line => !/^\d+$/.test(line.trim()))          // sequence numbers
    .filter(line => !/^\d{2}:\d{2}/.test(line.trim()))   // timestamps
    .map(line => line.replace(/<[^>]+>/g, '').trim())     // HTML tags
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isYoutubeHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'youtube.com' || host.endsWith('.youtube.com');
}

export function classifyYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || !isYoutubeHostname(u.hostname)) {
      return { kind: 'invalid' };
    }
    const urlPath = u.pathname.replace(/\/+$/, '') || '/';
    const shortMatch = urlPath.match(/^\/shorts\/([A-Za-z0-9_-]{11})$/);
    if (shortMatch) {
      return {
        kind: 'short',
        videoId: shortMatch[1],
        canonicalUrl: `https://www.youtube.com/shorts/${shortMatch[1]}`,
      };
    }
    const channelMatch = urlPath.match(/^\/((?:@[^/?#]+)|(?:channel\/[^/?#]+)|(?:c\/[^/?#]+)|(?:user\/[^/?#]+))(?:\/(videos|shorts|featured|about|streams|playlists|community|membership|store|channels))?$/);
    if (!channelMatch) return { kind: 'invalid' };
    return {
      kind: channelMatch[2] === 'shorts' ? 'channel_shorts' : 'channel',
      channelPath: `/${channelMatch[1]}`,
      tab: channelMatch[2] ?? null,
    };
  } catch {
    return { kind: 'invalid' };
  }
}

// Normalize a YouTube channel URL to its requested collection.
// returns individual video entries instead of channel-tab sub-playlists.
export function normalizeChannelVideosUrl(raw) {
  try {
    const u = new URL(raw);
    const classified = classifyYouTubeUrl(raw);
    if (classified.kind !== 'channel' && classified.kind !== 'channel_shorts') return raw;
    u.pathname = `${classified.channelPath}/${classified.kind === 'channel_shorts' ? 'shorts' : 'videos'}`;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch { return raw; }
}

export function normalizeDiscoveryOptions(options = {}) {
  const mode = options.mode ?? 'limited';
  if (mode === 'all') {
    if (options.limit !== undefined && options.limit !== null) {
      throw new TypeError('Le mode Tous ne doit pas contenir de limite numérique');
    }
    return { mode: 'all', limit: null };
  }
  const limit = options.limit ?? DEFAULT_DISCOVERY_LIMIT;
  if (mode !== 'limited' || !SUPPORTED_DISCOVERY_LIMITS.includes(limit)) {
    throw new TypeError('Mode de découverte invalide : utilisez 25, 50, 100 ou Tous');
  }
  return { mode: 'limited', limit };
}

export function optionalString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

export function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function entryThumbnail(entry) {
  const direct = optionalString(entry?.thumbnail);
  if (direct) return direct;
  const thumbnails = Array.isArray(entry?.thumbnails) ? entry.thumbnails : [];
  for (let i = thumbnails.length - 1; i >= 0; i--) {
    const url = optionalString(thumbnails[i]?.url);
    if (url) return url;
  }
  return undefined;
}

export function normalizePlaylistEntry(entry, isShortsCollection) {
  if (!entry || entry._type === 'playlist') return null;
  const id = optionalString(entry.id);
  if (!id) return null;
  const entryUrl = optionalString(entry.webpage_url) ?? optionalString(entry.url) ?? '';
  const isShort = isShortsCollection || /youtube\.com\/shorts\//i.test(entryUrl);
  const title = optionalString(entry.title);
  const thumbnail = entryThumbnail(entry);
  const channel = optionalString(entry.channel) ?? optionalString(entry.uploader);
  const duration = optionalNumber(entry.duration);
  const uploadDate = optionalString(entry.upload_date);
  const timestamp = optionalNumber(entry.timestamp);
  return {
    id,
    title: title ?? '',
    url: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
    ...(thumbnail ? { thumbnail } : {}),
    ...(channel ? { channel } : {}),
    ...(duration !== undefined && duration >= 0 ? { duration } : {}),
    ...(uploadDate ? { uploadDate } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

// limit_reached: the selected numeric limit was hit by the final UNIQUE count.
// has_more: true only if yt-dlp declared more entries than returned, false when
// collection ended naturally below the limit, null when unknown (never guessed).
export function computeLimitState(discovery, uniqueCount, declaredCount) {
  if (discovery.mode === 'all') {
    return { requested_limit: null, returned_count: uniqueCount, limit_reached: false, has_more: false };
  }
  const limitReached = uniqueCount >= discovery.limit;
  let hasMore = false;
  if (limitReached) hasMore = declaredCount !== undefined && declaredCount > uniqueCount ? true : null;
  return { requested_limit: discovery.limit, returned_count: uniqueCount, limit_reached: limitReached, has_more: hasMore };
}

export function parsePlaylistData(data, {
  sourceUrl = '',
  mode = 'limited',
  limit,
} = {}) {
  const discovery = normalizeDiscoveryOptions({ mode, limit });
  const isShortsCollection = classifyYouTubeUrl(sourceUrl).kind === 'channel_shorts';
  const videos = [];
  const seen = new Set();

  for (const entry of Array.isArray(data?.entries) ? data.entries : []) {
    if (discovery.mode === 'limited' && videos.length >= discovery.limit) break;
    const video = normalizePlaylistEntry(entry, isShortsCollection);
    if (!video || seen.has(video.id)) continue;
    seen.add(video.id);
    videos.push(video);
  }

  const declaredCount = optionalNumber(data?.playlist_count);
  return {
    title: optionalString(data?.title) ?? optionalString(data?.playlist_title) ?? '',
    uploader: optionalString(data?.uploader) ?? optionalString(data?.channel) ?? '',
    playlistId: optionalString(data?.id) ?? '',
    video_count: videos.length,
    videos,
    source_type: isShortsCollection ? 'shorts' : 'videos',
    mode: discovery.mode,
    limit: discovery.limit,
    ...computeLimitState(discovery, videos.length, declaredCount),
  };
}

// Fetch playlist metadata without downloading anything.
// Returns { title, uploader, playlistId, video_count, videos: [{id,title,url}] }
export function getPlaylistInfo(url, {
  signal,
  mode = 'limited',
  limit,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  onProgress,
  spawnImpl = spawn,
} = {}) {
  const discovery = normalizeDiscoveryOptions({ mode, limit });
  const classified = classifyYouTubeUrl(url);
  if (classified.kind === 'short') {
    return Promise.resolve({
      title: '', uploader: '', playlistId: '', video_count: 1,
      videos: [{ id: classified.videoId, url: classified.canonicalUrl }],
      source_type: 'short', mode: 'limited', limit: 1,
      requested_limit: 1, returned_count: 1, limit_reached: false, has_more: false,
    });
  }
  const normalizedUrl = normalizeChannelVideosUrl(url);
  const isShortsCollection = classifyYouTubeUrl(normalizedUrl).kind === 'channel_shorts';
  return new Promise((resolve, reject) => {
    const args = [
      normalizedUrl,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--no-playlist-reverse',
    ];
    if (discovery.mode === 'limited') args.push('--playlist-end', String(discovery.limit));

    try { args.push(...prepareYtDlp({ action: 'MEDIA_INSPECT', spawnInjected: spawnImpl !== spawn })); } catch (error) { reject(error); return; } // ROOT POLICY + egress proxy
    const proc = spawnImpl(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const videos = [];
    const seen = new Set();
    let stdoutBuffer = '';
    let stderr = '';
    let inactivityTimedOut = false;
    let inactivityTimer = null;
    let playlistTitle = '';
    let playlistUploader = '';
    let playlistId = '';
    let declaredCount;

    const resetInactivityWatchdog = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        inactivityTimedOut = true;
        void killProcessTree(proc);
      }, Math.max(1, Number(inactivityTimeoutMs) || DEFAULT_INACTIVITY_TIMEOUT_MS));
    };

    const acceptEntry = entry => {
      if (!playlistTitle) playlistTitle = optionalString(entry?.playlist_title) ?? optionalString(entry?.playlist) ?? '';
      if (!playlistUploader) playlistUploader = optionalString(entry?.playlist_uploader) ?? optionalString(entry?.channel) ?? optionalString(entry?.uploader) ?? '';
      if (!playlistId) playlistId = optionalString(entry?.playlist_id) ?? '';
      const count = optionalNumber(entry?.playlist_count) ?? optionalNumber(entry?.n_entries);
      if (count !== undefined) declaredCount = count;
      const video = normalizePlaylistEntry(entry, isShortsCollection);
      if (!video || seen.has(video.id)) return;
      if (discovery.mode === 'limited' && videos.length >= discovery.limit) return;
      seen.add(video.id);
      videos.push(video);
      resetInactivityWatchdog();
      onProgress?.({ count: videos.length, video });
    };

    const consumeLines = flush => {
      const lines = stdoutBuffer.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      if (flush && remainder.trim()) lines.push(remainder);
      stdoutBuffer = flush ? '' : remainder;
      for (const line of lines) {
        if (!line.trim()) continue;
        try { acceptEntry(JSON.parse(line)); } catch { /* ignore malformed extractor line */ }
      }
    };

    resetInactivityWatchdog();

    if (signal) {
      const onAbort = () => { void killProcessTree(proc); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    proc.stdout.on('data', d => {
      stdoutBuffer += d.toString();
      consumeLines(false);
    });
    proc.stderr.on('data', d => { stderr += d.toString().trim(); });

    proc.on('error', err => {
      clearTimeout(inactivityTimer);
      if (err.code === 'ENOENT') reject(new Error('yt-dlp introuvable. Lance : winget install yt-dlp'));
      else reject(err);
    });

    proc.on('close', code => {
      clearTimeout(inactivityTimer);
      if (signal?.aborted) {
        const e = new Error('Annulé');
        e.name = 'AbortError';
        return reject(e);
      }
      if (inactivityTimedOut) {
        const e = new Error('Délai d’inactivité de la découverte YouTube dépassé');
        e.name = 'TimeoutError';
        return reject(e);
      }
      if (code !== 0) return reject(new Error(friendlyError(stderr)));
      consumeLines(true);
      resolve({
        title: playlistTitle,
        uploader: playlistUploader,
        playlistId,
        video_count: videos.length,
        videos,
        source_type: isShortsCollection ? 'shorts' : 'videos',
        mode: discovery.mode,
        limit: discovery.limit,
        ...computeLimitState(discovery, videos.length, declaredCount),
      });
    });
  });
}

export function friendlyError(raw) {
  if (!raw) return 'Téléchargement échoué';
  const lower = raw.toLowerCase();
  if (lower.includes('private video') || lower.includes('private')) return 'Vidéo privée — impossible de télécharger';
  if (lower.includes('geo') || lower.includes('not available in your country')) return 'Vidéo bloquée dans votre région';
  if (lower.includes('removed') || lower.includes('deleted') || lower.includes('unavailable')) return 'Vidéo supprimée ou indisponible';
  if (lower.includes('invalid url') || lower.includes('unsupported url')) return 'URL invalide ou plateforme non supportée';
  if (lower.includes('copyright') || lower.includes('content removed')) return 'Vidéo retirée (copyright)';
  if (lower.includes('age') || lower.includes('sign in')) return 'Vidéo restreinte — connexion requise';
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[debug]') && !l.startsWith('WARNING'));
  return lines[lines.length - 1] || 'Téléchargement échoué';
}
