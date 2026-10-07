// YouTube Multi-Channel Scraper V1 — several channel URLs pasted at once, discovered through ONE bounded FIFO queue.
//
//   parseChannelLines(text|string[])  split one URL per line (blank lines ignored)
//   normalizeChannelInput(line)       legitimate normalisation only (scheme-less youtube.com, workflow prefix), then the
//                                     existing classifyDiscoveryInput decides; only CHANNEL listings are accepted here
//   createChannelDiscoveryQueue()     jobs PENDING → VALIDATING → QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED
//                                     (+ DUPLICATE: same channel already in the batch, never discovered twice)
//
// Each job runs the EXISTING discoverYouTube (same yt-dlp argv, same Root Policy + Media Egress proxy via prepareYtDlp,
// same stall watchdog and process-tree kill). This module never spawns anything itself: no new path to the network.
// The concurrency limit is global (all batches share it) and only protects the machine / the remote site: every channel
// is still discovered in full, there is no item cap.
import { randomUUID } from 'node:crypto';
import { classifyDiscoveryInput, discoverYouTube } from './youtube-discovery.js';

export const JOB_STATUS = Object.freeze({
  PENDING: 'PENDING', VALIDATING: 'VALIDATING', QUEUED: 'QUEUED', RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', DUPLICATE: 'DUPLICATE',
});
const TERMINAL = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED, JOB_STATUS.DUPLICATE]);
const WAITING = new Set([JOB_STATUS.PENDING, JOB_STATUS.VALIDATING, JOB_STATUS.QUEUED]);

// 2 channels at once: a root channel URL already runs 3 yt-dlp listings back to back (videos, shorts, streams), each a
// Python process paging the YouTube API. Two in parallel roughly halves the wall time of a long list without the HTTP 429
// throttling YouTube applies to aggressive parallel crawls. Configurable (DOCTEUR_YT_CHANNEL_CONCURRENCY), bounded 1..4.
export const DEFAULT_CHANNEL_CONCURRENCY = 2;
export const MAX_CHANNEL_CONCURRENCY = 4;
// Anti-abuse bound on the number of LINES of one paste (not on discovered items).
export const MAX_CHANNELS_PER_BATCH = 500;
export const DEFAULT_RETENTION_MS = 2 * 60 * 60_000; // finished batches are forgotten after 2 h
export const DEFAULT_MAX_BATCHES = 20;

const WORKFLOW_PREFIX = /^(?:chaine|chaîne|yt|youtube)\s+(\S+)$/i;
const SCHEMELESS_YOUTUBE = /^(?:(?:www|m|music)\.)?youtube\.com(?:[/?#]|$)/i;

export const INPUT_ERROR_MESSAGES = Object.freeze({
  invalid_input: 'URL invalide',
  not_youtube: 'Pas une URL YouTube',
  bare_handle_not_allowed: 'Handle seul : colle l’URL complète (https://www.youtube.com/@…) ou préfixe la ligne par « yt »',
  invalid_handle: 'Handle YouTube invalide',
  invalid_channel: 'Identifiant de chaîne invalide',
  unsupported_path: 'Chemin YouTube non pris en charge pour une chaîne',
  unsupported_tab: 'Onglet de chaîne non pris en charge (vidéos, Shorts ou streams uniquement)',
  not_a_channel: 'Pas une URL de chaîne (vidéo, Short, playlist ou direct)',
});

export function clampConcurrency(value, fallback = DEFAULT_CHANNEL_CONCURRENCY) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_CHANNEL_CONCURRENCY);
}

export function parseChannelLines(input) {
  const raw = Array.isArray(input) ? input.map(v => (typeof v === 'string' ? v : '')) : String(input ?? '').split(/\r?\n/);
  return raw.map(line => line.trim()).filter(Boolean);
}

/**
 * @returns {{ ok:true, input:string, request:string, allowBareHandle:boolean, normalizedUrl:string, mode:string, handle:string|null,
 *             channelIdHint:string|null, key:string } | { ok:false, input:string, reason:string, message:string }}
 */
export function normalizeChannelInput(line) {
  const input = String(line ?? '').trim();
  let request = input;
  let allowBareHandle = false;
  const prefixed = request.match(WORKFLOW_PREFIX);
  if (prefixed) { request = prefixed[1]; allowBareHandle = true; }
  // "youtube.com/@x" / "www.youtube.com/@x": the scheme is the only thing missing. Nothing else is ever rewritten.
  if (SCHEMELESS_YOUTUBE.test(request)) request = `https://${request}`;

  const classified = classifyDiscoveryInput(request, { allowBareHandle });
  const reject = reason => ({ ok: false, input, reason, message: INPUT_ERROR_MESSAGES[reason] ?? INPUT_ERROR_MESSAGES.invalid_input });
  if (!classified.ok) return reject(['invalid_video_id', 'invalid_playlist_id'].includes(classified.reason) ? 'not_a_channel' : classified.reason);
  if (classified.kind !== 'channel') return reject('not_a_channel');

  const channelIdHint = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(classified.channelPath)?.[1] ?? null;
  // Handles and legacy /c/, /user/ names are case-insensitive on YouTube; UC… channel ids are not.
  const pathKey = channelIdHint ? classified.channelPath : classified.channelPath.toLowerCase();
  return {
    ok: true, input, request, allowBareHandle,
    normalizedUrl: classified.canonicalUrl, mode: classified.mode, handle: classified.handle ?? null,
    channelIdHint, key: `${classified.mode}|${pathKey}`,
  };
}

function inputError(code, message) { return Object.assign(new Error(message), { code }); }

export function createChannelDiscoveryQueue({
  concurrency = clampConcurrency(process.env.DOCTEUR_YT_CHANNEL_CONCURRENCY),
  discover = discoverYouTube,
  now = Date.now,
  idFactory = randomUUID,
  retentionMs = DEFAULT_RETENTION_MS,
  maxBatches = DEFAULT_MAX_BATCHES,
  logger = null,
} = {}) {
  const limit = clampConcurrency(concurrency);
  const batches = new Map();   // batchId → { id, createdAt, jobIds: [] }
  const jobs = new Map();      // jobId → job (internal, includes the result)
  const fifo = [];             // jobIds waiting for a slot, oldest first
  const running = new Map();   // runId → { jobId, controller, done: Promise }
  let closed = false;

  const isActive = job => !TERMINAL.has(job.status);
  const batchJobs = batch => batch.jobIds.map(id => jobs.get(id)).filter(Boolean);

  function jobView(job) {
    return {
      id: job.id, index: job.index, input: job.input, normalizedUrl: job.normalizedUrl, mode: job.mode, handle: job.handle,
      channelId: job.channelId, channelName: job.channelName, status: job.status, phases: job.phases, currentTab: job.currentTab,
      pages: job.pages, itemsFound: job.itemsFound, message: job.message, error: job.error, duplicateOf: job.duplicateOf,
      retryable: job.retryable, attempts: job.attempts, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt,
    };
  }

  function summaryOf(list) {
    const s = { total: list.length, waiting: 0, running: 0, completed: 0, failed: 0, cancelled: 0, duplicate: 0, items: 0, active: false };
    for (const job of list) {
      if (WAITING.has(job.status)) s.waiting += 1;
      else if (job.status === JOB_STATUS.RUNNING) s.running += 1;
      else if (job.status === JOB_STATUS.COMPLETED) { s.completed += 1; s.items += job.itemsFound; }
      else if (job.status === JOB_STATUS.FAILED) s.failed += 1;
      else if (job.status === JOB_STATUS.CANCELLED) s.cancelled += 1;
      else if (job.status === JOB_STATUS.DUPLICATE) s.duplicate += 1;
    }
    s.active = s.waiting + s.running > 0;
    return s;
  }

  function snapshot(batch) {
    const list = batchJobs(batch);
    return { batchId: batch.id, createdAt: batch.createdAt, concurrency: limit, summary: summaryOf(list), jobs: list.map(jobView) };
  }

  function prune() {
    const t = now();
    const finished = [...batches.values()].filter(b => !batchJobs(b).some(isActive));
    for (const b of finished) {
      const last = Math.max(b.createdAt, ...batchJobs(b).map(j => j.completedAt ?? 0));
      if (t - last > retentionMs) forget(b);
    }
    const excess = batches.size - maxBatches;
    if (excess > 0) finished.filter(b => batches.has(b.id)).sort((a, b) => a.createdAt - b.createdAt).slice(0, excess).forEach(forget);
  }
  function forget(batch) {
    for (const id of batch.jobIds) jobs.delete(id);
    batches.delete(batch.id);
  }

  function resetProgress(job) {
    job.phases = []; job.currentTab = null; job.pages = 0; job.itemsFound = 0; job.message = null; job.error = null;
    job.result = null; job.startedAt = null; job.completedAt = null;
  }

  function settleAsDuplicate(job, original) {
    job.status = JOB_STATUS.DUPLICATE;
    job.duplicateOf = original.id;
    job.message = `Même chaîne que la ligne ${original.index + 1}`;
    job.completedAt = now();
  }

  // channelId dedup without any extra network call: a "/channel/UC…" line whose id an earlier job already resolved
  // (same mode) is not discovered again.
  function resolvedTwin(job) {
    if (!job.channelIdHint) return null;
    const batch = batches.get(job.batchId);
    return batchJobs(batch).find(other => other !== job && other.status === JOB_STATUS.COMPLETED
      && other.channelId === job.channelIdHint && other.mode === job.mode) ?? null;
  }

  function onDiscoveryEvent(job, runId, event) {
    if (job.runId !== runId || job.status !== JOB_STATUS.RUNNING) return; // stale run (cancelled / retried)
    switch (event.type) {
      case 'mode':
        job.phases = (event.sources ?? []).map(tab => ({ tab, status: 'pending', count: 0 }));
        if (event.handle && !job.handle) job.handle = event.handle;
        job.message = 'Chaîne détectée';
        break;
      case 'phase_start':
        job.currentTab = event.tab;
        job.phases = job.phases.map(p => (p.tab === event.tab ? { ...p, status: 'running' } : p));
        job.message = `Recherche ${event.tab}…`;
        break;
      case 'progress':
        job.pages = event.pages ?? job.pages;
        job.itemsFound = event.total ?? job.itemsFound;
        job.phases = job.phases.map(p => (p.tab === event.tab ? { ...p, count: event.count ?? p.count } : p));
        break;
      case 'items_batch':
        job.itemsFound = event.total ?? job.itemsFound;
        break;
      case 'phase_done':
        job.itemsFound = event.total ?? job.itemsFound;
        job.phases = job.phases.map(p => (p.tab === event.tab ? { ...p, status: event.available ? 'done' : 'unavailable', count: event.count ?? p.count } : p));
        break;
      default:
        break;
    }
  }

  function finishRun(job, runId, result) {
    if (job.runId !== runId || job.status !== JOB_STATUS.RUNNING) return; // already CANCELLED by the user, or retried
    job.completedAt = now();
    job.currentTab = null;
    // yt-dlp reports a missing tab and a missing channel with the same "…tab… does not exist" text, which the single-URL
    // discovery turns into "listing unavailable". Here every listing being unavailable means: nothing to show for this line.
    const nothingAvailable = result?.status === 'done' && result.items.length === 0 && job.phases.length > 0 && job.phases.every(p => p.status === 'unavailable');
    if (nothingAvailable) {
      job.status = JOB_STATUS.FAILED;
      job.error = { code: 'CHANNEL_UNAVAILABLE', message: 'Chaîne introuvable ou sans média public' };
      job.message = job.error.message;
      job.retryable = true;
    } else if (result?.status === 'done') {
      job.status = JOB_STATUS.COMPLETED;
      job.result = { mode: result.mode, channel: result.channel, items: result.items, counts: result.counts, duplicates: result.duplicates, durationMs: result.durationMs };
      job.itemsFound = result.items.length;
      job.channelId = result.channel?.id || job.channelIdHint || null;
      job.channelName = result.channel?.uploader || result.channel?.title || job.handle || null;
      job.message = `${job.itemsFound} élément${job.itemsFound > 1 ? 's' : ''}`;
      // a later "/channel/UC…" line pointing at the very channel just resolved is a duplicate
      for (const other of batchJobs(batches.get(job.batchId))) {
        if (other.status === JOB_STATUS.QUEUED && other.channelIdHint && other.channelIdHint === job.channelId && other.mode === job.mode) settleAsDuplicate(other, job);
      }
    } else if (result?.status === 'cancelled') {
      job.status = JOB_STATUS.CANCELLED;
      job.message = 'Annulée';
      job.retryable = true;
    } else {
      job.status = JOB_STATUS.FAILED;
      job.error = { code: result?.code ?? 'YTDLP_ERROR', message: result?.message ?? 'Échec de la découverte YouTube' };
      job.message = job.error.message;
      job.retryable = true;
    }
  }

  function start(job) {
    const runId = idFactory();
    const controller = new AbortController();
    job.status = JOB_STATUS.RUNNING;
    job.runId = runId;
    job.attempts += 1;
    job.startedAt = now();
    job.message = 'Démarrage…';
    job.retryable = false;
    let done;
    try {
      done = Promise.resolve(discover(job.request, {
        signal: controller.signal,
        allowBareHandle: job.allowBareHandle,
        onEvent: event => { try { onDiscoveryEvent(job, runId, event); } catch { /* a view update never breaks the run */ } },
      }));
    } catch (err) {
      done = Promise.reject(err);
    }
    const settled = done
      .then(result => finishRun(job, runId, result), err => finishRun(job, runId, { status: err?.name === 'AbortError' ? 'cancelled' : 'error', code: err?.code, message: err?.message }))
      .finally(() => { running.delete(runId); pump(); });
    running.set(runId, { jobId: job.id, controller, done: settled });
  }

  // The slot is held until the discovery promise settles, i.e. until the yt-dlp process tree is really gone.
  function pump() {
    if (closed) return;
    while (running.size < limit && fifo.length > 0) {
      const job = jobs.get(fifo.shift());
      if (!job || job.status !== JOB_STATUS.QUEUED) continue; // cancelled / forgotten while waiting
      const twin = resolvedTwin(job);
      if (twin) { settleAsDuplicate(job, twin); continue; }
      start(job);
    }
  }

  function enqueue(job) {
    job.status = JOB_STATUS.QUEUED;
    job.message = 'En attente';
    fifo.push(job.id);
  }

  function createBatch(input) {
    if (closed) throw inputError('QUEUE_CLOSED', 'File YouTube arrêtée');
    const lines = parseChannelLines(input);
    if (lines.length === 0) throw inputError('EMPTY_INPUT', 'Aucune URL de chaîne');
    if (lines.length > MAX_CHANNELS_PER_BATCH) throw inputError('TOO_MANY_INPUTS', `Trop de lignes (${lines.length}) : ${MAX_CHANNELS_PER_BATCH} chaînes maximum par envoi`);
    prune();
    const batch = { id: idFactory(), createdAt: now(), jobIds: [] };
    batches.set(batch.id, batch);
    const firstByKey = new Map();
    lines.forEach((line, index) => {
      const job = {
        id: idFactory(), batchId: batch.id, index, input: line, request: null, allowBareHandle: false,
        normalizedUrl: null, mode: null, handle: null, channelIdHint: null, channelId: null, channelName: null,
        status: JOB_STATUS.PENDING, duplicateOf: null, retryable: false, attempts: 0, runId: null, createdAt: now(),
      };
      resetProgress(job);
      jobs.set(job.id, job);
      batch.jobIds.push(job.id);

      job.status = JOB_STATUS.VALIDATING;
      const normalized = normalizeChannelInput(line);
      if (!normalized.ok) {
        job.status = JOB_STATUS.FAILED;
        job.error = { code: 'INVALID_INPUT', reason: normalized.reason, message: normalized.message };
        job.message = normalized.message;
        job.completedAt = now();
        return; // an invalid line is final: retrying the same text cannot succeed
      }
      Object.assign(job, {
        request: normalized.request, allowBareHandle: normalized.allowBareHandle, normalizedUrl: normalized.normalizedUrl,
        mode: normalized.mode, handle: normalized.handle, channelIdHint: normalized.channelIdHint, channelId: normalized.channelIdHint,
      });
      const original = firstByKey.get(normalized.key);
      if (original) { settleAsDuplicate(job, original); return; }
      firstByKey.set(normalized.key, job);
      enqueue(job);
    });
    logger?.info?.({ batch: batch.id, lines: lines.length, queued: batchJobs(batch).filter(j => j.status === JOB_STATUS.QUEUED).length }, 'YOUTUBE_CHANNEL_BATCH_CREATED');
    pump();
    return snapshot(batch);
  }

  function lookup(batchId, jobId) {
    const batch = batches.get(batchId);
    if (!batch) return { error: { code: 'BATCH_NOT_FOUND', status: 404 } };
    if (jobId === undefined) return { batch };
    const job = jobs.get(jobId);
    if (!job || job.batchId !== batchId) return { error: { code: 'JOB_NOT_FOUND', status: 404 } };
    return { batch, job };
  }

  function cancelOne(job) {
    if (TERMINAL.has(job.status)) return false;
    const wasRunning = job.status === JOB_STATUS.RUNNING;
    job.status = JOB_STATUS.CANCELLED;
    job.message = 'Annulée';
    job.retryable = true;
    job.completedAt = now();
    job.currentTab = null;
    if (wasRunning) for (const run of running.values()) if (run.jobId === job.id) run.controller.abort(); // → existing tree kill
    return true;
  }

  return {
    concurrency: limit,
    createBatch,
    getBatch(batchId) {
      const { batch, error } = lookup(batchId);
      return error ? { error } : snapshot(batch);
    },
    getJobResult(batchId, jobId) {
      const { job, error } = lookup(batchId, jobId);
      if (error) return { error };
      if (job.status !== JOB_STATUS.COMPLETED || !job.result) return { error: { code: 'JOB_NOT_COMPLETED', status: 409 } };
      return { job: jobView(job), ...job.result };
    },
    cancelJob(batchId, jobId) {
      const { batch, job, error } = lookup(batchId, jobId);
      if (error) return { error };
      if (!cancelOne(job)) return { error: { code: 'JOB_ALREADY_FINISHED', status: 409 }, snapshot: snapshot(batch) };
      pump();
      return snapshot(batch);
    },
    cancelBatch(batchId) {
      const { batch, error } = lookup(batchId);
      if (error) return { error };
      for (const job of batchJobs(batch)) cancelOne(job);
      return snapshot(batch);
    },
    retryJob(batchId, jobId) {
      const { batch, job, error } = lookup(batchId, jobId);
      if (error) return { error };
      if (!job.retryable || ![JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status)) return { error: { code: 'JOB_NOT_RETRYABLE', status: 409 }, snapshot: snapshot(batch) };
      resetProgress(job);
      job.retryable = false;
      job.runId = null;
      job.channelId = job.channelIdHint;
      enqueue(job);
      pump();
      return snapshot(batch);
    },
    /** For tests / diagnostics: how many discoveries currently hold a slot. */
    runningCount: () => running.size,
    /** Aborts every running discovery (tree kill) and resolves once all of them have settled. */
    async close() {
      closed = true;
      for (const job of jobs.values()) cancelOne(job);
      fifo.length = 0;
      await Promise.allSettled([...running.values()].map(r => r.done));
    },
  };
}

let defaultQueue = null;
export function getDefaultChannelQueue(options) {
  if (!defaultQueue) defaultQueue = createChannelDiscoveryQueue(options);
  return defaultQueue;
}
export async function shutdownDefaultChannelQueue() {
  if (defaultQueue) await defaultQueue.close();
}
