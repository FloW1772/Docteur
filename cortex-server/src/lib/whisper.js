import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YTDLP_BIN } from './ytdlp.js';
import { downloadAudio } from './video-audio-download.js';
export { downloadAudio };
import { assertSafeUrl } from './url-security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
export const TMP_DIR = path.join(ROOT, 'data', 'tmp');

const WHISPER_SCRIPT = path.join(__dirname, 'whisper_transcribe.py');

const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';

// ── Tmp dir management ────────────────────────────────────────────────────────

export function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

export function cleanTmpDir() {
  try {
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function removeTmpFile(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

// ── Get video duration via yt-dlp (no download) ───────────────────────────────

export async function getVideoDuration(url) {
  return new Promise((resolve) => {
    const proc = spawn(YTDLP_BIN, [url, '--print', 'duration', '--no-playlist', '--no-warnings'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, windowsHide: true,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      const n = parseInt(out.trim(), 10);
      resolve(isNaN(n) ? null : n);
    });
    proc.on('error', () => resolve(null));
  });
}

// ── Transcribe via Python faster-whisper ─────────────────────────────────────

function transcribeAudio(audioPath, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = [WHISPER_SCRIPT, audioPath];
    const proc = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    if (signal) {
      signal.addEventListener('abort', () => { try { proc.kill(); } catch { /* ignore */ } }, { once: true });
    }

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      // Progress lines: PROGRESS:<percent>
      for (const line of chunk.split('\n')) {
        const m = line.match(/^PROGRESS:(\d+)$/);
        if (m) onProgress?.({ step: 'transcribe', percent: parseInt(m[1], 10) });
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (signal?.aborted) { const e = new Error('Annulé'); e.name = 'AbortError'; return reject(e); }
      if (code !== 0) return reject(new Error(stderr.trim() || 'Transcription échouée'));
      try {
        const result = JSON.parse(stdout.split('\n').findLast(l => l.startsWith('{')) ?? '{}');
        resolve(result);
      } catch {
        reject(new Error('Résultat de transcription invalide'));
      }
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Transcribe an audio file directly. Used by the voice endpoint.
 * model: 'tiny' for fast wake-word check, 'small' for full transcription.
 * Returns { text, language, duration_s }
 */
export async function transcribeAudioFile(audioPath, model = 'small', { signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = [WHISPER_SCRIPT, audioPath, model];
    const proc = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    if (signal) {
      signal.addEventListener('abort', () => { try { proc.kill(); } catch { /* ignore */ } }, { once: true });
    }

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (signal?.aborted) { const e = new Error('Annulé'); e.name = 'AbortError'; return reject(e); }
      if (code !== 0) return reject(new Error(stderr.trim() || 'Transcription échouée'));
      try {
        const result = JSON.parse(stdout.split('\n').findLast(l => l.startsWith('{')) ?? '{}');
        resolve(result);
      } catch {
        reject(new Error('Résultat de transcription invalide'));
      }
    });
  });
}

/**
 * Like transcribeAudioFile but also requests segment-level timestamps
 * (faster-whisper's natural speech-pause boundaries) — used by the long
 * video pipeline to cut transcript chunks on natural breaks.
 * Returns { text, language, duration_s, segments: [{start,end,text}] }
 */
export async function transcribeAudioFileWithSegments(audioPath, model = 'small', { signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = [WHISPER_SCRIPT, audioPath, model, '--segments'];
    const proc = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    if (signal) {
      signal.addEventListener('abort', () => { try { proc.kill(); } catch { /* ignore */ } }, { once: true });
    }

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (signal?.aborted) { const e = new Error('Annulé'); e.name = 'AbortError'; return reject(e); }
      if (code !== 0) return reject(new Error(stderr.trim() || 'Transcription échouée'));
      try {
        const result = JSON.parse(stdout.split('\n').findLast(l => l.startsWith('{')) ?? '{}');
        resolve(result);
      } catch {
        reject(new Error('Résultat de transcription invalide'));
      }
    });
  });
}

/**
 * Découpe un fichier audio en morceaux de durée fixe via ffmpeg (copie sans
 * réencodage). Utilisé pour rester sous la limite 100 MB de Groq et pour
 * borner l'empreinte mémoire de la transcription locale sur de très longues
 * vidéos. Retourne la liste des chemins créés dans outDir.
 */
export function splitAudioFile(audioPath, outDir, segmentSeconds) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const pattern = path.join(outDir, 'chunk_%04d.wav');
    const args = ['-i', audioPath, '-f', 'segment', '-segment_time', String(segmentSeconds), '-c', 'copy', '-reset_timestamps', '1', pattern, '-y'];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => reject(err.code === 'ENOENT' ? new Error('ffmpeg introuvable') : err));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || 'Découpage audio échoué'));
      const files = fs.readdirSync(outDir)
        .filter(f => f.startsWith('chunk_') && f.endsWith('.wav'))
        .sort()
        .map(f => path.join(outDir, f));
      resolve(files);
    });
  });
}

/**
 * Full pipeline: assertSafeUrl → download audio → transcribe → delete audio
 * VRAM note: caller must ensure Ollama is NOT running a request simultaneously.
 * Returns { text, language, duration_s }
 */
export async function transcribeYouTube(url, { onProgress, signal } = {}) {
  assertSafeUrl(url); // SSRF guard

  ensureTmpDir();
  const id = `whisper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const audioPath = path.join(TMP_DIR, `${id}.wav`);

  try {
    onProgress?.({ step: 'download', percent: 0, label: 'Téléchargement audio…' });
    await downloadAudio(url, audioPath.replace(/\.wav$/, '.%(ext)s'), { onProgress, signal });

    // yt-dlp may output with the final extension in the template
    const actualPath = fs.existsSync(audioPath) ? audioPath
      : fs.readdirSync(TMP_DIR).map(f => path.join(TMP_DIR, f)).find(f => f.includes(id)) ?? audioPath;

    onProgress?.({ step: 'transcribe', percent: 0, label: 'Transcription en cours…' });
    const result = await transcribeAudio(actualPath, { onProgress, signal });

    return result;
  } finally {
    // Always clean up audio file
    removeTmpFile(audioPath);
    // Also clean any variant (e.g. .webm before conversion)
    try {
      fs.readdirSync(TMP_DIR)
        .filter(f => f.startsWith(id))
        .forEach(f => removeTmpFile(path.join(TMP_DIR, f)));
    } catch { /* ignore */ }
  }
}
