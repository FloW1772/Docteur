// Unit tests of the YouTube Multi-Channel V1 frontend logic (pure TypeScript, run through Node's type stripping).
// Usage: node --test scripts/test-youtube-multi-channel-frontend-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batchHeadline, batchProgress, batchSummaryText, batchTone, canCancelJob, canImportJob, canRetryJob,
  detectYouTubeMultiChannelInput, jobDetail, jobLabel, jobPhasesText, multiChannelHint, queueErrorText, toDiscoveryResult,
} from '../src/lib/youtube/multi-channel.ts';
import { detectYouTubeDiscoveryInput } from '../src/lib/youtube/discovery-input.ts';

const detect = detectYouTubeMultiChannelInput;
const UC = 'UCkVv-e3hXZd_V2CTQSgsmSg';

test('a single URL is NEVER a multi-channel request: the historical single-URL flow keeps it', () => {
  for (const text of ['https://www.youtube.com/@solo', '  https://www.youtube.com/@solo  \n\n', 'yt @solo', '']) {
    assert.equal(detect(text), null, JSON.stringify(text));
  }
  assert.ok(detectYouTubeDiscoveryInput('https://www.youtube.com/@solo'), 'single flow still detects it');
});

test('several channel URLs, one per line (blank lines and spaces tolerated)', () => {
  const r = detect(`https://www.youtube.com/@chaine1\n\n   https://www.youtube.com/@chaine2   \r\nhttps://www.youtube.com/channel/${UC}\nhttps://youtube.com/@chaine3/\n`);
  assert.ok(r);
  assert.equal(r.lines.length, 4);
  assert.equal(r.validCount, 4);
  assert.equal(r.invalidCount, 0);
  assert.match(multiChannelHint(r), /^4 chaînes YouTube détectées/);
});

test('scheme-less youtube.com lines and workflow prefixes are recognised like the server does', () => {
  const r = detect('youtube.com/@a\nwww.youtube.com/@b\nyt @c\nyt youtube.com/@d');
  assert.equal(r.validCount, 4);
});

test('mixed valid / invalid lines: still a multi-channel request; invalid lines counted (the server reports each one)', () => {
  const r = detect('https://www.youtube.com/@a\nhtps://youtube.com/@typo\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n@bare\nhttps://www.youtube.com/@c');
  assert.ok(r);
  assert.equal(r.validCount, 2);
  assert.equal(r.invalidCount, 3);
  assert.match(multiChannelHint(r), /3 lignes invalides/);
});

test('duplicates are predicted for the hint (case-insensitive handles, trailing slash, host variants)', () => {
  const r = detect('https://www.youtube.com/@Chaine\nhttps://youtube.com/@chaine/\nm.youtube.com/@CHAINE\nhttps://www.youtube.com/@autre');
  assert.equal(r.validCount, 2);
  assert.equal(r.duplicateCount, 2);
  assert.match(multiChannelHint(r), /2 doublons ignorés/);
});

test('historical behaviours are preserved: foreign URL lists, prose, prefixed commands, only-videos lists', () => {
  // a list with an article URL keeps the multi-URL deep capture
  assert.equal(detect('https://www.youtube.com/@a\nhttps://www.lemonde.fr/article'), null);
  // prose containing a channel URL
  assert.equal(detect('Regarde cette chaîne\nhttps://www.youtube.com/@a'), null);
  // explicit deep / todo commands
  assert.equal(detect('info https://www.youtube.com/@a\nhttps://www.youtube.com/@b'), null);
  assert.equal(detect('todo https://www.youtube.com/@a\nhttps://www.youtube.com/@b'), null);
  // several single videos (no channel at all): not a channel list
  assert.equal(detect('https://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://youtu.be/dQw4w9WgXcQ'), null);
  // garbage only
  assert.equal(detect('foo\nbar'), null);
});

// ── snapshot helpers ────────────────────────────────────────────────────────────────────────────────────────────────
const job = (over = {}) => ({
  id: 'j', index: 0, input: 'https://www.youtube.com/@a', normalizedUrl: 'https://www.youtube.com/@a', mode: 'CHANNEL_ALL_MEDIA', handle: '@a',
  channelId: null, channelName: null, status: 'QUEUED', phases: [], currentTab: null, pages: 0, itemsFound: 0, message: null, error: null,
  duplicateOf: null, retryable: false, attempts: 0, createdAt: 0, startedAt: null, completedAt: null, ...over,
});
const summary = (over = {}) => ({ total: 0, waiting: 0, running: 0, completed: 0, failed: 0, cancelled: 0, duplicate: 0, items: 0, active: false, ...over });

test('per-channel labels and details', () => {
  assert.equal(jobLabel(job()), '@a');
  assert.equal(jobLabel(job({ channelName: 'Chaîne A' })), 'Chaîne A');
  assert.equal(jobLabel(job({ handle: null, normalizedUrl: null, input: 'nope' })), 'nope');
  assert.equal(jobDetail(job()), 'En attente d’un créneau');
  assert.equal(jobDetail(job({ status: 'RUNNING', currentTab: 'shorts', pages: 3, itemsFound: 240 })), 'Recherche Shorts… · page 3 · 240 éléments trouvés');
  assert.equal(jobDetail(job({ status: 'COMPLETED', itemsFound: 1 })), '1 élément');
  assert.equal(jobDetail(job({ status: 'FAILED', error: { code: 'INVALID_INPUT', message: 'Pas une URL YouTube' } })), 'Pas une URL YouTube');
  assert.equal(jobDetail(job({ status: 'DUPLICATE', message: 'Même chaîne que la ligne 1' })), 'Même chaîne que la ligne 1');
  assert.equal(jobPhasesText(job({ phases: [{ tab: 'videos', status: 'done', count: 12 }, { tab: 'shorts', status: 'unavailable', count: 0 }, { tab: 'streams', status: 'pending', count: 0 }] })),
    'Vidéos 12 · Shorts indisponible · Streams en attente');
  assert.equal(jobPhasesText(job({ phases: [{ tab: 'videos', status: 'done', count: 12 }] })), null, 'single listing: no breakdown');
});

test('actions: cancel while unfinished, retry only FAILED/CANCELLED when retryable, import only completed with items', () => {
  for (const status of ['PENDING', 'VALIDATING', 'QUEUED', 'RUNNING']) assert.equal(canCancelJob(job({ status })), true, status);
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'DUPLICATE']) assert.equal(canCancelJob(job({ status })), false, status);
  assert.equal(canRetryJob(job({ status: 'FAILED', retryable: true })), true);
  assert.equal(canRetryJob(job({ status: 'CANCELLED', retryable: true })), true);
  assert.equal(canRetryJob(job({ status: 'FAILED', retryable: false })), false, 'invalid input is not retryable');
  assert.equal(canRetryJob(job({ status: 'COMPLETED', retryable: true })), false, 'completed is never redone');
  assert.equal(canImportJob(job({ status: 'COMPLETED', itemsFound: 3 })), true);
  assert.equal(canImportJob(job({ status: 'COMPLETED', itemsFound: 0 })), false);
});

test('global progress: "3 / 8 terminées · 2 en cours · 2 en attente · 1 erreur", duplicates excluded from the work total', () => {
  const s = summary({ total: 9, completed: 3, running: 2, waiting: 2, failed: 1, duplicate: 1, active: true });
  assert.equal(batchSummaryText(s), '3 / 8 terminées · 2 en cours · 2 en attente · 1 erreur · 1 doublon ignoré');
  assert.equal(batchProgress(s), 4 / 8);
  assert.equal(batchProgress(summary({ total: 0 })), 1);
});

test('an isolated error is never a global failure', () => {
  assert.equal(batchTone(summary({ total: 3, completed: 2, failed: 1 })), 'partial');
  assert.equal(batchTone(summary({ total: 2, completed: 2 })), 'success');
  assert.equal(batchTone(summary({ total: 2, failed: 2 })), 'failed');
  assert.equal(batchTone(summary({ total: 2, cancelled: 2 })), 'cancelled');
  assert.equal(batchTone(summary({ total: 2, running: 1, failed: 1, active: true })), 'active');
  const partial = { batchId: 'b', createdAt: 0, concurrency: 2, jobs: [], summary: summary({ total: 3, completed: 2, failed: 1, items: 40 }) };
  assert.equal(batchHeadline(partial), 'Terminé : 2 chaînes OK · 40 éléments');
  assert.equal(batchHeadline({ ...partial, summary: summary({ total: 4, waiting: 2, running: 2, active: true }) }), 'Découverte de 4 chaînes · 2 en parallèle max');
});

test('toDiscoveryResult adapts one channel result to the single-URL import shape (doChannelCapture reused as-is)', () => {
  const items = [{ id: 'a', title: 'A', url: 'u' }, { id: 'b', title: 'B', url: 'v' }];
  const channel = { handle: '@a', url: 'https://www.youtube.com/@a', title: 'T', uploader: 'U', id: 'UCa' };
  const r = toDiscoveryResult({ job: job(), mode: 'CHANNEL_ALL_MEDIA', channel, items, counts: { videos: 2 }, duplicates: 0, durationMs: 5 });
  assert.deepEqual(r, { mode: 'CHANNEL_ALL_MEDIA', channel, items, total: 2, counts: { videos: 2 }, duplicates: 0, durationMs: 5 });
});

test('queue errors are translated', () => {
  assert.equal(queueErrorText({ code: 'JOB_ALREADY_FINISHED', message: 'x' }), 'Cette chaîne est déjà terminée');
  assert.equal(queueErrorText({ message: 'HTTP 500' }), 'HTTP 500');
  assert.equal(queueErrorText(null), 'Erreur inconnue');
});
