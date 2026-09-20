/**
 * Observateur passive monitoring — aggregator. Turns an already
 * privacy-guard-filtered snapshot into bounded upsert rows keyed by an
 * hourly window_bucket, so continuous polling of one process/destination
 * pair produces ONE row updated repeatedly (sample_count++, last_seen
 * bumped), never one row per poll. Pure functions — unit-testable
 * without spawning real OS processes.
 */
import crypto from 'node:crypto';

export function windowBucketFor(date = new Date()) {
  return date.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
}

export function buildConnectionRows(connections, bucket = windowBucketFor()) {
  return connections.map(conn => ({
    id: crypto.randomUUID(),
    process_name: conn.processName || 'processus inconnu',
    pid: conn.pid ?? null,
    remote_address: conn.remoteAddress,
    remote_port: conn.remotePort ?? null,
    local_port: conn.localPort ?? null,
    protocol: conn.protocol,
    state: conn.state ?? null,
    first_seen: conn.timestamp,
    last_seen: conn.timestamp,
    approx_bytes: conn.approxBytes ?? 0,
    window_bucket: bucket,
  }));
}

export function buildProcessRows(connections, bucket = windowBucketFor()) {
  const byProcess = new Map();
  for (const conn of connections) {
    const name = conn.processName || 'processus inconnu';
    if (!byProcess.has(name)) {
      byProcess.set(name, { pid: conn.pid ?? null, destinations: new Set(), count: 0, timestamp: conn.timestamp });
    }
    const entry = byProcess.get(name);
    entry.count += 1;
    entry.destinations.add(`${conn.remoteAddress}:${conn.remotePort ?? ''}`);
  }
  return Array.from(byProcess.entries()).map(([processName, entry]) => ({
    id: crypto.randomUUID(),
    process_name: processName,
    pid: entry.pid,
    first_seen: entry.timestamp,
    last_seen: entry.timestamp,
    connection_count: entry.count,
    distinct_destinations: entry.destinations.size,
    window_bucket: bucket,
  }));
}
