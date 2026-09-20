/**
 * Observateur passive monitoring — service/scheduler. Single
 * setInterval-based loop (no cron dependency), same start/pause/resume
 * shape as inbox-watcher.js's startInboxWatcher/stopInboxWatcher, but
 * with a real pause (clears the timer, doesn't just hide UI) and a
 * performance-guard-driven adaptive interval.
 *
 * Per tick: collect -> privacy-guard filter -> aggregate (one batched
 * transaction) -> run anomaly rules -> record cycle cost -> maybe
 * generate a scheduled/on-event report -> maybe purge old data.
 */
import crypto from 'node:crypto';
import { collectSnapshot } from './monitor-collector.js';
import { sanitizeSnapshot } from './monitor-privacy-guard.js';
import { windowBucketFor, buildConnectionRows, buildProcessRows } from './monitor-aggregator.js';
import { evaluateConnection } from './monitor-anomaly.js';
import { recordCycle, nextInterval, getOverheadStatus } from './monitor-performance-guard.js';
import { getMonitorSettings } from './monitor-config.js';
import { maybeGenerateScheduledReport, maybeGenerateOnEventReport } from './monitor-report-scheduler.js';
import { maybeRunRetentionPurge } from './monitor-retention.js';
import { upsertMonitorConnections, upsertMonitorProcesses, insertMonitorEvent } from './sqlite.js';

let timerHandle = null;
let currentIntervalMs = 10_000;
let running = false;
let deps = { ollamaClient: null, ollamaModel: null, logger: null };

function logEvent(eventType, detail = {}) {
  try {
    insertMonitorEvent({ id: crypto.randomUUID(), event_type: eventType, detail: JSON.stringify(detail), created_at: new Date().toISOString() });
  } catch { /* non-fatal — event log is best-effort */ }
}

async function tick() {
  const settings = getMonitorSettings();
  if (!settings.enabled || settings.paused) return;

  const cycleStart = Date.now();
  let eventCount = 0;
  let dbWrites = 0;

  try {
    const rawSnapshot = await collectSnapshot();
    const snapshot = sanitizeSnapshot(rawSnapshot);
    const bucket = windowBucketFor();

    const connectionRows = settings.includeRemoteEndpoints ? buildConnectionRows(snapshot.connections, bucket) : [];
    const processRows = settings.includeProcessMetadata ? buildProcessRows(snapshot.connections, bucket) : [];

    if (connectionRows.length > 0) { upsertMonitorConnections(connectionRows); dbWrites += 1; }
    if (processRows.length > 0) { upsertMonitorProcesses(processRows); dbWrites += 1; }
    eventCount = snapshot.connections.length;

    let anomalyDetected = false;
    for (const conn of snapshot.connections) {
      const candidates = evaluateConnection(conn);
      if (candidates.length > 0) { anomalyDetected = true; dbWrites += candidates.length; }
    }

    if (anomalyDetected) {
      await maybeGenerateOnEventReport(deps).catch(() => null);
    }
    await maybeGenerateScheduledReport(deps).catch(() => null);
    maybeRunRetentionPurge();
  } catch (err) {
    deps.logger?.warn?.({ err: err?.message }, 'monitor: cycle failed');
  } finally {
    const durationMs = Date.now() - cycleStart;
    recordCycle({ durationMs, intervalMs: currentIntervalMs, eventCount, dbWrites });
    const adjusted = nextInterval(settings.collectionIntervalMs);
    if (adjusted !== currentIntervalMs) {
      currentIntervalMs = adjusted;
      if (getOverheadStatus().degraded) logEvent('degraded', { intervalMs: adjusted });
      restartTimer();
    } else if (currentIntervalMs !== settings.collectionIntervalMs && !getOverheadStatus().degraded) {
      // Recovered from a prior backoff — settings interval takes over again.
      currentIntervalMs = settings.collectionIntervalMs;
      restartTimer();
    }
  }
}

function restartTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => { void tick(); }, currentIntervalMs);
}

export function startMonitorService({ ollamaClient = null, ollamaModel = null, logger = null } = {}) {
  deps = { ollamaClient, ollamaModel, logger };
  const settings = getMonitorSettings();
  currentIntervalMs = settings.collectionIntervalMs;
  if (running) return;
  running = true;
  restartTimer();
  logEvent('start', {});
  logger?.info?.('observateur monitor service started');
}

export function pauseMonitorService() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  running = false;
  logEvent('pause', {});
}

export function resumeMonitorService() {
  if (running) return;
  running = true;
  const settings = getMonitorSettings();
  currentIntervalMs = settings.collectionIntervalMs;
  restartTimer();
  logEvent('resume', {});
}

export function stopMonitorService() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  running = false;
}

export function isMonitorServiceRunning() {
  return running;
}

export function startMonitorServiceIfAutostart({ ollamaClient = null, ollamaModel = null, logger = null } = {}) {
  const settings = getMonitorSettings();
  if (!settings.autostart) return;
  startMonitorService({ ollamaClient, ollamaModel, logger });
}
