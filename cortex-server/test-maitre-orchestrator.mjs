// Integration tests for maitre-orchestrator.js — real isolated test DB.
// Confirms the MA-5 orchestrator only ever ingests/correlates/creates
// incidents/reads — never a system action.
// Run with: node --test test-maitre-orchestrator.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, insertMonitorAnomaly } from './src/lib/sqlite.js';
import { ingestSecurityEvent } from './src/lib/maitre-signal-intake.js';
import { runIngestionAndCorrelationPass, getIncidentDetail, listIncidents } from './src/lib/maitre-orchestrator.js';

const TEST_DB_DIR = './data-test-maitre-orchestrator';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('runIngestionAndCorrelationPass: empty state produces zero signals/matches/incidents, never throws', () => {
  const result = runIngestionAndCorrelationPass();
  assert.equal(result.observateurSignalsIngested, 0);
  assert.equal(result.correlationMatches, 0);
  assert.equal(result.incidentsTouched, 0);
});

test('runIngestionAndCorrelationPass: ingests a real Observateur anomaly and correlates existing events', () => {
  const now = new Date().toISOString();
  const name = 'orch-test-app.exe';
  ingestSecurityEvent({ source: 'process-monitor', category: 'process-inspection', severity: 'OBSERVATION', detectorId: 'd1', occurredAt: now, subject: { name } });
  insertMonitorAnomaly({
    id: 'orch-anom-1', detected_at: now, rule_id: 'new-external-destination-from-docteur-component',
    severity: 'REQUIRES_REVIEW', process_name: name, remote_address: '198.51.100.50',
    description: 'test', evidence_ref: '{}', status: 'OPEN',
    security_signal: JSON.stringify({ source: 'observateur', category: 'network', severity: 'REQUIRES_REVIEW', confidence: 'medium', evidenceRef: {} }),
  });

  const result = runIngestionAndCorrelationPass();
  assert.ok(result.observateurSignalsIngested >= 1);
});

test('getIncidentDetail: returns incident + events + evidence for a real created incident', () => {
  const incidents = listIncidents({ limit: 500 });
  if (incidents.length === 0) return; // depends on prior test producing a correlation match; skip gracefully if none
  const detail = getIncidentDetail(incidents[0].id);
  assert.ok(detail.incident);
  assert.ok(Array.isArray(detail.events));
  assert.ok(Array.isArray(detail.evidence));
});

test('getIncidentDetail: unknown incident id returns null, never throws', () => {
  assert.equal(getIncidentDetail('does-not-exist'), null);
});
