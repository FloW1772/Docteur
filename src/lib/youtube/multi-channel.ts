// YouTube Multi-Channel V1 — frontend detection + pure view helpers. The server (youtube-channel-queue.js) is the
// authority for normalisation, validation and dedup; this file only decides "is this paste a list of YouTube channels?"
// and formats the queue snapshot. A single line never comes here: it keeps the historical single-URL flow.
import type {
  YouTubeChannelBatch, YouTubeChannelBatchSummary, YouTubeChannelJob, YouTubeChannelJobResult, YouTubeChannelJobStatus,
  YouTubeDiscoveryResult,
} from '../cortex/client';
import { detectYouTubeDiscoveryInput } from './discovery-input.ts';

export interface YouTubeMultiChannelInput {
  lines: string[];
  /** lines predicted to be channel URLs (the server confirms) */
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
}

const WORKFLOW_PREFIX = /^(?:chaine|chaîne|yt|youtube)\s+\S+$/i;
const SCHEMELESS_YOUTUBE = /^(?:(?:www|m|music)\.)?youtube\.com(?:[/?#]|$)/i;

function isYouTubeHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be';
}

/** A well-formed http(s) URL to another site: such a list keeps the historical multi-URL (article) capture. */
function isForeignUrl(token: string): boolean {
  if (!/^https?:\/\//i.test(token)) return false;
  try { return !isYouTubeHost(new URL(token).hostname); } catch { return false; }
}

function predictChannel(line: string): string | null {
  // same order as the server: optional workflow prefix, then the missing scheme of a youtube.com path
  const prefixed = /^(chaine|chaîne|yt|youtube)\s+(\S+)$/i.exec(line);
  const token = prefixed ? prefixed[2] : line;
  const request = SCHEMELESS_YOUTUBE.test(token) ? `https://${token}` : token;
  const detected = detectYouTubeDiscoveryInput(prefixed ? `${prefixed[1]} ${request}` : request);
  if (!detected) return null;
  // dedup key for the hint only (handles are case-insensitive; the server applies the authoritative rule)
  if (detected.handle) return `${detected.mode}|${detected.handle.toLowerCase()}`;
  let path = request.replace(/^https?:\/\/(?:www\.|m\.)?/i, '');
  while (path.endsWith('/')) path = path.slice(0, -1);
  return `${detected.mode}|${path}`;
}

export function detectYouTubeMultiChannelInput(raw: string): YouTubeMultiChannelInput | null {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  for (const line of lines) {
    if (/\s/.test(line) && !WORKFLOW_PREFIX.test(line)) return null; // prose, or a prefixed command (info/veille/todo…)
    if (isForeignUrl(line)) return null;
  }
  const seen = new Set<string>();
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  for (const line of lines) {
    const key = predictChannel(line);
    if (!key) invalidCount += 1;
    else if (seen.has(key)) duplicateCount += 1;
    else { seen.add(key); validCount += 1; }
  }
  if (validCount === 0) return null;
  return { lines, validCount, invalidCount, duplicateCount };
}

export function multiChannelHint(input: YouTubeMultiChannelInput): string {
  const parts = [`${input.validCount} chaîne${input.validCount > 1 ? 's' : ''} YouTube détectée${input.validCount > 1 ? 's' : ''} — découverte en file`];
  if (input.invalidCount > 0) parts.push(`${input.invalidCount} ligne${input.invalidCount > 1 ? 's' : ''} invalide${input.invalidCount > 1 ? 's' : ''}`);
  if (input.duplicateCount > 0) parts.push(`${input.duplicateCount} doublon${input.duplicateCount > 1 ? 's' : ''} ignoré${input.duplicateCount > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

// ── snapshot view helpers ───────────────────────────────────────────────────────────────────────────────────────────

export const JOB_STATUS_LABEL: Record<YouTubeChannelJobStatus, string> = {
  PENDING: 'En attente', VALIDATING: 'Validation', QUEUED: 'En attente', RUNNING: 'En cours',
  COMPLETED: 'Terminée', FAILED: 'Erreur', CANCELLED: 'Annulée', DUPLICATE: 'Doublon',
};

export const JOB_STATUS_COLOR: Record<YouTubeChannelJobStatus, string> = {
  PENDING: '#9f8fbf', VALIDATING: '#9f8fbf', QUEUED: '#9f8fbf', RUNNING: '#a78bfa',
  COMPLETED: '#3dffaa', FAILED: '#ff4d58', CANCELLED: '#9f8fbf', DUPLICATE: '#7a6c9a',
};

const TERMINAL: ReadonlySet<YouTubeChannelJobStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DUPLICATE']);
const TAB_SEARCH: Record<string, string> = { videos: 'vidéos', shorts: 'Shorts', streams: 'streams', playlist: 'playlist' };
const TAB_SHORT: Record<string, string> = { videos: 'Vidéos', shorts: 'Shorts', streams: 'Streams', playlist: 'Playlist' };

export const isJobTerminal = (job: YouTubeChannelJob): boolean => TERMINAL.has(job.status);
export const canCancelJob = (job: YouTubeChannelJob): boolean => !isJobTerminal(job);
export const canRetryJob = (job: YouTubeChannelJob): boolean => job.retryable && (job.status === 'FAILED' || job.status === 'CANCELLED');
export const canImportJob = (job: YouTubeChannelJob): boolean => job.status === 'COMPLETED' && job.itemsFound > 0;

export function jobLabel(job: YouTubeChannelJob): string {
  return job.channelName || job.handle || job.normalizedUrl || job.input;
}

const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`;

export function jobDetail(job: YouTubeChannelJob): string {
  switch (job.status) {
    case 'PENDING':
    case 'VALIDATING':
    case 'QUEUED':
      return 'En attente d’un créneau';
    case 'RUNNING': {
      const parts = [job.currentTab ? `Recherche ${TAB_SEARCH[job.currentTab] ?? job.currentTab}…` : (job.message ?? 'Démarrage…')];
      if (job.pages > 0) parts.push(`page ${job.pages}`);
      parts.push(`${plural(job.itemsFound, 'élément')} trouvé${job.itemsFound > 1 ? 's' : ''}`);
      return parts.join(' · ');
    }
    case 'COMPLETED':
      return plural(job.itemsFound, 'élément');
    case 'FAILED':
      return job.error?.message ?? job.message ?? 'Échec';
    case 'CANCELLED':
      return 'Annulée';
    case 'DUPLICATE':
      return job.message ?? 'Doublon ignoré';
  }
}

/** "Vidéos 120 · Shorts indisponible · Streams en attente" — only for multi-listing modes. */
export function jobPhasesText(job: YouTubeChannelJob): string | null {
  if (job.phases.length < 2) return null;
  return job.phases.map(p => {
    const label = TAB_SHORT[p.tab] ?? p.tab;
    if (p.status === 'pending') return `${label} en attente`;
    if (p.status === 'unavailable') return `${label} indisponible`;
    return `${label} ${p.count}`;
  }).join(' · ');
}

/** Channels that count for progress: duplicates are skipped lines, not work. */
export const effectiveTotal = (s: YouTubeChannelBatchSummary): number => Math.max(0, s.total - s.duplicate);

export function batchProgress(s: YouTubeChannelBatchSummary): number {
  const total = effectiveTotal(s);
  return total === 0 ? 1 : (s.completed + s.failed + s.cancelled) / total;
}

/** "3 / 8 terminées · 2 en cours · 2 en attente · 1 erreur" — an isolated error is never presented as a global failure. */
export function batchSummaryText(s: YouTubeChannelBatchSummary): string {
  const parts = [`${s.completed} / ${effectiveTotal(s)} terminée${s.completed > 1 ? 's' : ''}`];
  if (s.running > 0) parts.push(`${s.running} en cours`);
  if (s.waiting > 0) parts.push(`${s.waiting} en attente`);
  if (s.failed > 0) parts.push(plural(s.failed, 'erreur'));
  if (s.cancelled > 0) parts.push(`${s.cancelled} annulée${s.cancelled > 1 ? 's' : ''}`);
  if (s.duplicate > 0) parts.push(`${s.duplicate} doublon${s.duplicate > 1 ? 's' : ''} ignoré${s.duplicate > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

export type BatchTone = 'active' | 'success' | 'partial' | 'failed' | 'cancelled';
export function batchTone(s: YouTubeChannelBatchSummary): BatchTone {
  if (s.active) return 'active';
  if (s.completed > 0) return s.failed > 0 || s.cancelled > 0 ? 'partial' : 'success';
  if (s.failed > 0) return 'failed';
  return 'cancelled';
}

export function batchHeadline(batch: YouTubeChannelBatch): string {
  const s = batch.summary;
  const tone = batchTone(s);
  if (tone === 'active') return `Découverte de ${plural(effectiveTotal(s), 'chaîne')} · ${batch.concurrency} en parallèle max`;
  if (tone === 'success') return `Terminé : ${plural(s.completed, 'chaîne')} · ${plural(s.items, 'élément')}`;
  if (tone === 'partial') return `Terminé : ${s.completed} chaîne${s.completed > 1 ? 's' : ''} OK · ${plural(s.items, 'élément')}`;
  if (tone === 'failed') return 'Aucune chaîne n’a pu être découverte';
  return 'Découverte annulée';
}

/** Adapts one channel result to the single-URL result shape, so the existing import (doChannelCapture) is reused as-is. */
export function toDiscoveryResult(result: YouTubeChannelJobResult): YouTubeDiscoveryResult {
  return {
    mode: result.mode, channel: result.channel, items: result.items, total: result.items.length,
    counts: result.counts, duplicates: result.duplicates, durationMs: result.durationMs,
  };
}

export const QUEUE_ERROR_TEXT: Record<string, string> = {
  BATCH_NOT_FOUND: 'File introuvable (le serveur a peut-être redémarré)',
  JOB_NOT_FOUND: 'Chaîne introuvable dans la file',
  JOB_ALREADY_FINISHED: 'Cette chaîne est déjà terminée',
  JOB_NOT_RETRYABLE: 'Cette chaîne ne peut pas être relancée',
  JOB_NOT_COMPLETED: 'Résultats pas encore disponibles',
  EMPTY_INPUT: 'Aucune URL de chaîne',
  TOO_MANY_INPUTS: 'Trop de lignes dans un seul envoi',
};

export function queueErrorText(error: unknown): string {
  const e = error as { code?: string; message?: string } | null;
  return (e?.code && QUEUE_ERROR_TEXT[e.code]) || e?.message || 'Erreur inconnue';
}
