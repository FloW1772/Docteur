// Unit tests for monitor-performance-guard.js — degraded-status trigger
// at threshold, auto-backoff interval math, backoff cap.
// Run with: node --test test-monitor-performance-guard.mjs
import './test-setup.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordCycle, getOverheadStatus, nextInterval, _resetPerformanceGuard } from './src/lib/monitor-performance-guard.js';

beforeEach(() => { _resetPerformanceGuard(); });

test('getOverheadStatus: empty ring is never degraded', () => {
  const status = getOverheadStatus();
  assert.equal(status.degraded, false);
  assert.equal(status.eventsPerMin, 0);
});

test('getOverheadStatus: high event volume triggers degraded status', () => {
  recordCycle({ durationMs: 100, intervalMs: 10_000, eventCount: 5000, dbWrites: 10 });
  const status = getOverheadStatus();
  assert.equal(status.degraded, true);
});

test('getOverheadStatus: cycle duration close to the full interval triggers degraded status', () => {
  recordCycle({ durationMs: 9000, intervalMs: 10_000, eventCount: 1, dbWrites: 1 });
  const status = getOverheadStatus();
  assert.equal(status.degraded, true);
});

test('getOverheadStatus: normal load is never degraded', () => {
  recordCycle({ durationMs: 50, intervalMs: 10_000, eventCount: 20, dbWrites: 2 });
  const status = getOverheadStatus();
  assert.equal(status.degraded, false);
});

test('nextInterval: doubles the interval when degraded', () => {
  recordCycle({ durationMs: 9000, intervalMs: 10_000, eventCount: 1, dbWrites: 1 });
  assert.equal(nextInterval(10_000), 20_000);
});

test('nextInterval: leaves the interval unchanged when not degraded', () => {
  recordCycle({ durationMs: 50, intervalMs: 10_000, eventCount: 5, dbWrites: 1 });
  assert.equal(nextInterval(10_000), 10_000);
});

test('nextInterval: backoff is capped at MAX_BACKOFF_MS regardless of how degraded', () => {
  recordCycle({ durationMs: 9999, intervalMs: 10_000, eventCount: 999_999, dbWrites: 999 });
  const result = nextInterval(4 * 60 * 1000); // already close to cap
  assert.ok(result <= 5 * 60 * 1000, 'backoff must never exceed the 5-minute cap');
});
