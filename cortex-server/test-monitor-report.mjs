// Unit tests for monitor-report.js — SUMMARY/DETAILED generation from
// persisted data, HTML escaping (XSS fixture), Ollama-unavailable
// fallback (llm_narrative stays null, generation still succeeds).
// Run with: node --test test-monitor-report.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, upsertMonitorConnections, upsertMonitorProcesses, insertMonitorAnomaly } from './src/lib/sqlite.js';
import { createReport, generateMonitorReport } from './src/lib/monitor-report.js';

const TEST_DB_DIR = './data-test-monitor-report';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedData({ processName = 'chrome.exe', remoteAddress = '1.1.1.1' } = {}) {
  const now = new Date().toISOString();
  const bucket = now.slice(0, 13);
  upsertMonitorConnections([{
    id: `c-${Math.random()}`, process_name: processName, pid: 1, remote_address: remoteAddress,
    remote_port: 443, local_port: 1, protocol: 'TCP', state: 'ESTABLISHED', first_seen: now, last_seen: now,
    approx_bytes: 0, window_bucket: bucket,
  }]);
  upsertMonitorProcesses([{
    id: `p-${Math.random()}`, process_name: processName, pid: 1, first_seen: now, last_seen: now,
    connection_count: 1, distinct_destinations: 1, window_bucket: bucket,
  }]);
}

test('createReport: generates a SUMMARY report row without an Ollama client (llm_narrative stays null)', async () => {
  seedData();
  const periodStart = new Date(Date.now() - 3600_000).toISOString();
  const periodEnd = new Date().toISOString();
  const report = await createReport({ reportType: 'SUMMARY', mode: 'ON_SUMMARY', periodStart, periodEnd });
  assert.equal(report.report_type, 'SUMMARY');
  assert.equal(report.llm_narrative, null);
  assert.ok(report.event_count >= 1);
});

test('createReport: Ollama client that throws still lets the report generate (narrative stays null, never blocks)', async () => {
  seedData();
  const failingClient = {};
  const periodStart = new Date(Date.now() - 3600_000).toISOString();
  const periodEnd = new Date().toISOString();
  const report = await createReport({
    reportType: 'SUMMARY', mode: 'ON_SUMMARY', periodStart, periodEnd,
    ollamaClient: failingClient, ollamaModel: 'nonexistent-model',
  });
  assert.equal(report.llm_narrative, null);
});

test('generateMonitorReport: HTML output escapes a malicious process name (XSS fixture)', async () => {
  const maliciousName = '<script>alert(1)</script>';
  seedData({ processName: maliciousName, remoteAddress: '2.2.2.2' });
  const periodStart = new Date(Date.now() - 3600_000).toISOString();
  const periodEnd = new Date().toISOString();
  const reportRow = await createReport({ reportType: 'DETAILED', mode: 'ON_DETAILED_REPORTS', periodStart, periodEnd });
  const html = generateMonitorReport(reportRow, 'html');
  assert.equal(html.format, 'html');
  assert.equal(html.content.includes('<script>alert(1)</script>'), false, 'raw script tag must never appear unescaped');
  assert.ok(html.content.includes('&lt;script&gt;'));
});

test('generateMonitorReport: json format returns valid parseable JSON', async () => {
  seedData();
  const periodStart = new Date(Date.now() - 3600_000).toISOString();
  const periodEnd = new Date().toISOString();
  const reportRow = await createReport({ reportType: 'SUMMARY', mode: 'ON_SUMMARY', periodStart, periodEnd });
  const json = generateMonitorReport(reportRow, 'json');
  assert.equal(json.format, 'json');
  assert.doesNotThrow(() => JSON.parse(json.content));
});

test('generateMonitorReport: anomalies list is included and rendered without throwing', async () => {
  insertMonitorAnomaly({
    id: 'anom-1', detected_at: new Date().toISOString(), rule_id: 'new-listening-port', severity: 'SUSPICIOUS',
    process_name: 'server.exe', remote_address: null, description: 'test anomaly', evidence_ref: '{}',
    status: 'OPEN', security_signal: null,
  });
  seedData();
  const periodStart = new Date(Date.now() - 3600_000).toISOString();
  const periodEnd = new Date().toISOString();
  const reportRow = await createReport({ reportType: 'DETAILED', mode: 'ON_DETAILED_REPORTS', periodStart, periodEnd });
  const html = generateMonitorReport(reportRow, 'html');
  assert.ok(html.content.includes('test anomaly'));
});
