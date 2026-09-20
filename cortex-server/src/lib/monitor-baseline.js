/**
 * Observateur passive monitoring — baseline. A bounded, explainable
 * per-process baseline derived as a query over already-persisted
 * monitor_connections history (no separate blob that can drift from the
 * real data). Never an opaque score — always "these are the usual
 * destinations/hours", queryable and displayable as-is.
 */
import { getMonitorConnectionHistory } from './sqlite.js';

const MAX_BASELINE_DESTINATIONS = 200;
const BASELINE_LOOKBACK_DAYS = 14;

export function getBaseline(processName, { lookbackDays = BASELINE_LOOKBACK_DAYS } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const history = getMonitorConnectionHistory(processName, since);

  const destinations = new Set();
  const activeHours = new Array(24).fill(0);
  let totalBytes = 0;

  for (const row of history) {
    if (destinations.size < MAX_BASELINE_DESTINATIONS) {
      destinations.add(`${row.remote_address}:${row.remote_port ?? ''}`);
    }
    const hour = new Date(row.first_seen).getUTCHours();
    activeHours[hour] += row.sample_count ?? 1;
    totalBytes += row.approx_bytes ?? 0;
  }

  const sampleCount = history.reduce((n, row) => n + (row.sample_count ?? 1), 0);
  const avgBytesPerSample = sampleCount > 0 ? totalBytes / sampleCount : 0;

  return {
    processName,
    destinations: Array.from(destinations),
    activeHours,
    avgBytesPerSample,
    sampleCount,
    lookbackDays,
  };
}

export function isKnownDestination(baseline, remoteAddress, remotePort) {
  return baseline.destinations.includes(`${remoteAddress}:${remotePort ?? ''}`);
}
