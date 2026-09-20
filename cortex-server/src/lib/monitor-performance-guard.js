/**
 * Observateur passive monitoring — performance guard. Tracks recent
 * collector cycle costs in a small bounded in-memory ring buffer
 * (operational telemetry, not user data — no new table). If the
 * collector is spending too much of its own interval, or producing too
 * many events/DB writes per minute, monitor-service.js backs off its
 * polling interval automatically and surfaces MONITORING DEGRADED
 * instead of letting Docteur's own performance suffer.
 */

const RING_SIZE = 30; // ~30 collection cycles of history
const EVENTS_PER_MIN_THRESHOLD = 2_000;
const CYCLE_DURATION_RATIO_THRESHOLD = 0.5; // collector taking >50% of its own interval
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let ring = [];

export function recordCycle({ durationMs, intervalMs, eventCount, dbWrites }) {
  ring.push({ timestamp: Date.now(), durationMs, intervalMs, eventCount, dbWrites });
  if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);
}

function ratePerMinute(field) {
  if (ring.length === 0) return 0;
  const windowMs = Date.now() - ring[0].timestamp;
  const total = ring.reduce((sum, r) => sum + (r[field] ?? 0), 0);
  if (windowMs <= 0) return total;
  return (total / windowMs) * 60_000;
}

export function getOverheadStatus() {
  if (ring.length === 0) {
    return { eventsPerMin: 0, writesPerMin: 0, avgCycleDurationMs: 0, degraded: false };
  }
  const eventsPerMin = ratePerMinute('eventCount');
  const writesPerMin = ratePerMinute('dbWrites');
  const avgCycleDurationMs = ring.reduce((sum, r) => sum + r.durationMs, 0) / ring.length;
  const last = ring[ring.length - 1];
  const cycleRatio = last.intervalMs > 0 ? last.durationMs / last.intervalMs : 0;

  const degraded = eventsPerMin > EVENTS_PER_MIN_THRESHOLD || cycleRatio > CYCLE_DURATION_RATIO_THRESHOLD;
  return { eventsPerMin, writesPerMin, avgCycleDurationMs, degraded };
}

// Returns the next interval to use: doubled (bounded) if degraded,
// otherwise unchanged. Pure function — monitor-service.js owns applying it.
export function nextInterval(currentIntervalMs) {
  const { degraded } = getOverheadStatus();
  if (!degraded) return currentIntervalMs;
  return Math.min(currentIntervalMs * 2, MAX_BACKOFF_MS);
}

export function _resetPerformanceGuard() {
  ring = [];
}
