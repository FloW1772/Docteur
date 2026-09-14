import { spawn } from 'node:child_process';
import { YTDLP_BIN } from './ytdlp.js';

const FORBIDDEN = /(?:HTTP(?:\s+Error)?\s*[:=]?\s*403\b|403\s*[: ]\s*Forbidden)/i;
const REFUSED = 'Le site refuse le téléchargement de cette vidéo. Une session navigateur ou une authentification peut être nécessaire.';

export function redactDownloadLog(value) {
  return String(value).split(/\r?\n/).map(line =>
    /cookie|token|password|authorization|api[_-]?key|secret|bearer/i.test(line)
      ? '[diagnostic sensible masqué]'
      : line.replace(/https?:\/\/\S+/gi, '[URL masquée]')
        .replace(/[A-Z]:[\\/][^\r\n]*/gi, '[chemin masqué]')
  ).join('\n');
}

// Injection limitée au lancement du processus pour tester les erreurs sans réseau.
export function createAudioDownloader(spawnProcess = spawn) {
  return async function downloadAudio(url, outputPath, {
    onProgress, signal, logger, jobId,
    browser = process.env.VIDEO_YTDLP_BROWSER,
    timeoutMs = 20 * 60_000,
  } = {}) {
    const configuredBrowser = browser?.trim().toLowerCase();
    if (configuredBrowser && !['chrome', 'firefox'].includes(configuredBrowser)) {
      throw new Error('VIDEO_YTDLP_BROWSER doit valoir chrome ou firefox.');
    }
    const strategies = [
      { name: 'normal', extra: [] },
      { name: 'audio-alternative', extra: ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '--no-continue', '--force-overwrites'] },
    ];
    if (configuredBrowser) strategies.push({
      name: 'browser-session',
      extra: ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '--no-continue', '--force-overwrites', '--cookies-from-browser', configuredBrowser],
    });
    for (const strategy of strategies) {
      if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
      const args = ['-x', '--audio-format', 'wav', '--audio-quality', '0',
        '--no-playlist', '--newline', '--socket-timeout', '30', '--retries', '0',
        '--fragment-retries', '0', '-o', outputPath, ...strategy.extra, '--', url];
      const safeArgs = args.map((arg, i) => arg === url ? '[URL masquée]' :
        args[i - 1] === '-o' ? '[sortie audio]' : arg);
      const started = Date.now();
      logger?.debug({ jobId, strategy: strategy.name, args: safeArgs, source: new URL(url).hostname }, 'VIDEO_DOWNLOAD_START');
      const result = await new Promise(resolve => {
        let stderr = '', stdout = '', forbidden = false, timedOut = false, settled = false;
        let proc, timer;
        const abort = () => {
          // yt-dlp can have an ffmpeg child during WAV conversion.
          if (process.platform === 'win32' && proc?.pid) {
            const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => proc.kill());
            killer.on('close', code => { if (code !== 0) proc.kill(); });
          } else proc?.kill();
        };
        const finish = (code, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve({ code, error, timedOut, forbidden, stderr: redactDownloadLog(stderr), stdout: redactDownloadLog(stdout) });
        };
        try { proc = spawnProcess(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
        catch (err) { finish(null, err.code ?? 'SPAWN_ERROR'); return; }
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
        proc.stdout.on('data', chunk => {
          stdout = (stdout + chunk).slice(-8192);
          for (const match of chunk.toString().matchAll(/\[download\]\s+([\d.]+)%/g)) {
            onProgress?.({ step: 'download', percent: Number(match[1]) });
          }
        });
        proc.stderr.on('data', chunk => {
          stderr = (stderr + chunk).slice(-16384);
          forbidden ||= FORBIDDEN.test(stderr);
        });
        proc.on('error', err => finish(null, err.code ?? 'SPAWN_ERROR'));
        proc.on('close', code => finish(code));
      });
      const diagnostic = { jobId, strategy: strategy.name, args: safeArgs, durationMs: Date.now() - started, ...result };
      if (result.code === 0 && !signal?.aborted && !result.timedOut) {
        logger?.debug(diagnostic, 'VIDEO_DOWNLOAD_DONE');
        return;
      }
      logger?.warn(diagnostic, 'VIDEO_DOWNLOAD_FAILED');
      if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
      if (result.timedOut) throw new Error('Le téléchargement audio a dépassé le délai de 20 minutes.');
      if (!result.forbidden) throw new Error(result.error === 'ENOENT'
        ? 'yt-dlp introuvable'
        : 'Le téléchargement audio a échoué. Consultez les logs du serveur pour le diagnostic.');
    }
    throw new Error(REFUSED);
  };
}

export const downloadAudio = createAudioDownloader();
