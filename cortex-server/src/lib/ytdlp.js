import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LOCAL_BIN = path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function findBin() {
  if (fs.existsSync(LOCAL_BIN)) return LOCAL_BIN;
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

export const YTDLP_BIN = findBin();

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

    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let finalPath = '';
    let title = '';
    let lastStderr = '';

    if (signal) {
      const onAbort = () => { try { proc.kill(); } catch { /* ignore */ } };
      signal.addEventListener('abort', onAbort, { once: true });
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

// Normalize a YouTube channel URL to its /videos tab so yt-dlp --flat-playlist
// returns individual video entries instead of channel-tab sub-playlists.
export function normalizeChannelVideosUrl(raw) {
  try {
    const u = new URL(raw);
    if (!u.hostname.includes('youtube.com')) return raw;
    // Strip known tab suffixes, then ensure /videos
    const TAB_SUFFIXES = /\/(featured|about|shorts|streams|playlists|community|membership|store|channels)\/?$/;
    const cleanPath = u.pathname.replace(TAB_SUFFIXES, '').replace(/\/$/, '');
    // Only touch paths that look like channel roots (/@x, /channel/UC..., /c/x, /user/x)
    const CHANNEL_ROOT = /^\/((@[^/?#]+)|(channel\/[^/?#]+)|(c\/[^/?#]+)|(user\/[^/?#]+))$/;
    if (!CHANNEL_ROOT.test(cleanPath) && !cleanPath.endsWith('/videos')) return raw;
    u.pathname = cleanPath.endsWith('/videos') ? cleanPath : cleanPath + '/videos';
    u.search = '';
    return u.toString();
  } catch { return raw; }
}

// Fetch playlist metadata without downloading anything.
// Returns { title, uploader, playlistId, video_count, videos: [{id,title,url}] }
export function getPlaylistInfo(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist-reverse',
    ];

    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (signal) {
      const onAbort = () => { try { proc.kill(); } catch { /* ignore */ } };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString().trim(); });

    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error('yt-dlp introuvable. Lance : winget install yt-dlp'));
      else reject(err);
    });

    proc.on('close', code => {
      if (signal?.aborted) {
        const e = new Error('Annulé');
        e.name = 'AbortError';
        return reject(e);
      }
      if (code !== 0) return reject(new Error(friendlyError(stderr)));

      let data;
      try { data = JSON.parse(stdout); }
      catch { return reject(new Error('Impossible de lire la réponse yt-dlp')); }

      const videos = (data.entries ?? [])
        .filter(e => e._type === 'url' || (e._type !== 'playlist' && e.id))
        .map(e => ({
          id:    e.id  ?? '',
          title: e.title || e.id || 'Vidéo sans titre',
          url:   e.url || e.webpage_url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ''),
        }))
        .filter(v => v.id && v.url);

      resolve({
        title:       data.title      ?? data.playlist_title ?? 'Playlist sans titre',
        uploader:    data.uploader   ?? data.channel ?? '',
        playlistId:  data.id         ?? '',
        video_count: videos.length,
        videos,
      });
    });
  });
}

function friendlyError(raw) {
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
