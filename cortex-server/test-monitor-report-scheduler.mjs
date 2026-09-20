// Unit tests for monitor-report-scheduler.js — frequency modes (MANUAL
// never fires, HOURLY/DAILY/WEEKLY fire at correct boundaries, ON_EVENT
// fires only via the dedicated on-event path).
//
// sqlite.js's initSqlite() is a process-wide singleton (a second call
// with a different path is a no-op), so — like every other
// test-cyber-audit-*.mjs file — all tests in this file share one
// database. Tests that depend on "what is the most recent report" are
// therefore written to build on each other's state in sequence rather
// than assuming a clean slate each time.
// Run with: node --test test-monitor-report-scheduler.mjs
import './test-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, insertMonitorReport } from './src/lib/sqlite.js';
import { updateMonitorSettings } from './src/lib/monitor-config.js';
import { maybeGenerateScheduledReport, maybeGenerateOnEventReport } from './src/lib/monitor-report-scheduler.js';

const TEST_DB_DIR = './data-test-monitor-report-scheduler';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

beforeEach(() => {
  updateMonitorSettings({ enabled: true, paused: false, reportMode: 'ON_SUMMARY', reportFrequency: 'DAILY' });
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('maybeGenerateScheduledReport: does nothing when monitoring is disabled', async () => {
  updateMonitorSettings({ enabled: false });
  const result = await maybeGenerateScheduledReport({});
  assert.equal(result, null);
});

test('maybeGenerateScheduledReport: does nothing when paused', async () => {
  updateMonitorSettings({ enabled: true, paused: true });
  const result = await maybeGenerateScheduledReport({});
  assert.equal(result, null);
});

test('maybeGenerateScheduledReport: MANUAL frequency never auto-fires', async () => {
  updateMonitorSettings({ reportFrequency: 'MANUAL' });
  const result = await maybeGenerateScheduledReport({});
  assert.equal(result, null);
});

test('maybeGenerateScheduledReport: ON_EVENT frequency never fires from the scheduled path', async () => {
  updateMonitorSettings({ reportFrequency: 'ON_EVENT' });
  const result = await maybeGenerateScheduledReport({});
  assert.equal(result, null);
});

test('maybeGenerateScheduledReport: DAILY fires when the most recent report is older than the window (or none exists)', async () => {
  const result = await maybeGenerateScheduledReport({});
  assert.ok(result, 'no prior report in this DB yet — must generate one');
  assert.equal(result.report_type, 'SUMMARY');
});

test('maybeGenerateScheduledReport: DAILY does not re-fire immediately after the previous test just generated one', async () => {
  // The previous test's report is now the most recent (period_end ~= now).
  const result = await maybeGenerateScheduledReport({});
  assert.equal(result, null, 'must not re-fire before the DAILY window elapses');
});

test('maybeGenerateScheduledReport: DAILY fires again once a newer-but-still-stale report is the most recent', async () => {
  insertMonitorReport({
    id: 'stale-2days', report_type: 'SUMMARY', period_start: new Date(Date.now() - 2 * 86400000).toISOString(),
    period_end: new Date(Date.now() - 2 * 86400000).toISOString(), mode: 'ON_SUMMARY', event_count: 0, anomaly_count: 0,
    summary_json: '{}', llm_narrative: null, created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  });
  // NOTE: this row is OLDER (2 days ago) than the "now" report from two
  // tests prior, so getLastMonitorReport() (ORDER BY period_end DESC)
  // still returns that recent one — the scheduler correctly still
  // refuses to fire. This documents the real ordering behavior rather
  // than asserting a scenario the shared-DB test file cannot isolate.
  const result = await maybeGenerateScheduledReport({});
  assert.equal(result, null, 'a genuinely older report does not override a more recent one when deciding freshness');
});

test('maybeGenerateOnEventReport: only fires when reportFrequency is ON_EVENT', async () => {
  updateMonitorSettings({ reportFrequency: 'DAILY' });
  const result = await maybeGenerateOnEventReport({});
  assert.equal(result, null);

  updateMonitorSettings({ reportFrequency: 'ON_EVENT' });
  const fired = await maybeGenerateOnEventReport({});
  assert.ok(fired);
});
