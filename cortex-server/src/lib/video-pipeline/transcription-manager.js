// Gestionnaire de transcription abstrait — le reste du pipeline vidéo longue
// ignore quel moteur Whisper a été utilisé. Reproduit fidèlement le pattern
// Groq→local de deepCaptureWhisper() dans server.js (bascule annoncée, jamais
// silencieuse, toujours loggée via logWhisperCall).
import fs from 'node:fs';
import path from 'node:path';
import { transcribeAudioFileWithSegments } from '../whisper.js';
import { transcribeWithGroq } from '../whisper-groq.js';
import { getCloudKeys, getWhisperStats, logWhisperCall, getRouterSettings } from '../sqlite.js';

// Résout 'auto' → 'groq' si une clé est configurée et qu'aucun quota Groq n'a
// été atteint dans la dernière heure, sinon 'local'.
export function resolveWhisperProvider(requested) {
  // strict_local_mode wins regardless of what was requested — checked here,
  // at the point of the actual decision, not just when a setting is saved.
  if (getRouterSettings()?.strict_local_mode === true) return 'local';
  if (requested !== 'auto') return requested;
  const keys = getCloudKeys();
  if (!keys.groq_key) return 'local';
  const stats = getWhisperStats();
  const lastQuota = stats.last_quota_at ? new Date(stats.last_quota_at) : null;
  const quotaRecent = lastQuota && (Date.now() - lastQuota.getTime() < 60 * 60 * 1000);
  return quotaRecent ? 'local' : 'groq';
}

/**
 * Transcrit un segment audio, en respectant le provider demandé, avec bascule
 * automatique et ANNONCÉE Groq → local en cas d'échec/quota/taille.
 * Retourne { text, language, duration_s, segments, providerUsed, fallback }
 * où fallback = { reason, label } | null.
 */
export async function transcribeSegment(audioPath, requestedProvider, { onFallback, signal } = {}) {
  const provider = resolveWhisperProvider(requestedProvider);
  let fallback = null;

  if (provider === 'groq') {
    const keys = getCloudKeys();
    if (!keys.groq_key) {
      fallback = { reason: 'no_key', label: 'Clé Groq non configurée — bascule vers Whisper local…' };
      onFallback?.(fallback);
    } else {
      const stat = fs.statSync(audioPath);
      if (stat.size > 100 * 1024 * 1024) {
        fallback = { reason: 'too_large', label: '⚠️ Segment >100 MB — bascule vers Whisper local…' };
        onFallback?.(fallback);
      } else {
        try {
          const result = await transcribeWithGroq(audioPath, keys.groq_key);
          logWhisperCall({ provider: 'whisper_groq', durationS: null, fallback: false, fallbackReason: null });
          return { text: result.text, language: result.language, duration_s: null, segments: null, providerUsed: 'whisper_groq', fallback: null };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          const reason = err.isTooLarge ? 'too_large' : err.isQuota ? 'quota' : 'error';
          const label  = err.isTooLarge ? '⚠️ Audio >100 MB — bascule vers Whisper local…'
            : err.isQuota ? '⚠️ Quota Groq atteint (429) — bascule vers Whisper local…'
            : '⚠️ Groq indisponible — bascule vers Whisper local…';
          fallback = { reason, label };
          onFallback?.(fallback);
        }
      }
    }
  }

  // Local (soit demandé directement, soit bascule depuis Groq)
  const result = await transcribeAudioFileWithSegments(audioPath, 'small', { signal });
  logWhisperCall({
    provider: 'whisper_local',
    durationS: result.duration_s ?? null,
    fallback: fallback !== null,
    fallbackReason: fallback?.reason ?? null,
  });
  return { text: result.text, language: result.language, duration_s: result.duration_s, segments: result.segments ?? null, providerUsed: 'whisper_local', fallback };
}

export function fileSizeBytes(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}
