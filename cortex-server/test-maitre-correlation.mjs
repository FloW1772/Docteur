// Unit + integration tests for maitre-correlation.js — real isolated
// test DB (never the real Docteur DB). Covers all 5 deterministic
// rules, explainability, time windows, incident creation/dedup,
// severity escalation discipline (CRITICAL never from a single match),
// and false-positive discipline for common benign scenarios.
// Run with: node --test test-maitre-correlation.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import { ingestSecurityEvent } from './src/lib/maitre-signal-intake.js';
import {
  runCorrelation, escalateSeverity, createIncidentFromCorrelation, linkEvidenceToIncident,
} from './src/lib/maitre-correlation.js';
import { getIncident, listIncidents, createEvidence, updateIncident } from './src/lib/maitre-store.js';

const TEST_DB_DIR = './data-test-maitre-correlation';
let uniqueCounter = 0;

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => { uniqueCounter += 1; });

function uid(label) { return `${label}-${uniqueCounter}-${Math.random().toString(36).slice(2)}`; }

function ingest(overrides) {
  return ingestSecurityEvent({
    source: 'maitre', category: 'test', severity: 'OBSERVATION', detectorId: uid('detector'),
    occurredAt: new Date().toISOString(), subject: {}, metadata: {}, ...overrides,
  }).event;
}

// ── Single benign event never correlates ─────────────────────────────────

test('runCorrelation: a single benign event alone produces no matches', () => {
  ingest({ source: 'process-monitor', category: 'process-inspection', subject: { name: uid('lonely.exe') } });
  const matches = runCorrelation();
  assert.equal(matches.length, 0);
});

// ── CORR-001: new_process + new_network_destination ──────────────────────

test('CORR-001: correlates a process observation with an Observateur network anomaly for the same process name', () => {
  const name = uid('app.exe');
  const now = new Date().toISOString();
  ingest({ source: 'process-monitor', category: 'process-inspection', occurredAt: now, subject: { name } });
  ingest({ source: 'observateur', category: 'network', occurredAt: now, subject: { anomalyId: uid('anom'), processName: name } });
  const matches = runCorrelation().filter(m => m.ruleId === 'CORR-001');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matchedEventIds.length, 2);
  assert.ok(matches[0].reason.length > 0);
});

function matchesIncludingEvent(matches, ruleId, eventId) {
  return matches.filter(m => m.ruleId === ruleId && m.matchedEventIds.includes(eventId));
}

test('CORR-001: does not fire for two unrelated process names', () => {
  const now = new Date().toISOString();
  const eventA = ingest({ source: 'process-monitor', category: 'process-inspection', occurredAt: now, subject: { name: uid('a.exe') } });
  ingest({ source: 'observateur', category: 'network', occurredAt: now, subject: { anomalyId: uid('anom'), processName: uid('b.exe') } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-001', eventA.id);
  assert.equal(matches.length, 0);
});

// ── CORR-002: new_executable + persistence_added ─────────────────────────

test('CORR-002: correlates a new executable with a new persistence entry pointing to it', () => {
  const fileName = uid('evil') + '.exe';
  const path = `C:\\Users\\test\\${fileName}`;
  const now = new Date().toISOString();
  const fileEvent = ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path, isExecutable: true } });
  ingest({ source: 'persistence-monitor', category: 'REGISTRY_RUN', occurredAt: now, subject: { changeType: 'NEW' }, metadata: { target: path } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-002', fileEvent.id);
  assert.equal(matches.length, 1);
  assert.match(matches[0].reason, /executable/i);
});

test('CORR-002: does not fire when the persistence target does not reference the file', () => {
  const now = new Date().toISOString();
  const fileEvent = ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path: `C:\\${uid('unrelated1')}.exe`, isExecutable: true } });
  ingest({ source: 'persistence-monitor', category: 'REGISTRY_RUN', occurredAt: now, subject: { changeType: 'NEW' }, metadata: { target: `C:\\${uid('unrelated2')}.exe` } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-002', fileEvent.id);
  assert.equal(matches.length, 0);
});

test('CORR-002: does not fire for an UNCHANGED persistence entry (only NEW)', () => {
  const fileName = uid('stable') + '.exe';
  const path = `C:\\Users\\test\\${fileName}`;
  const now = new Date().toISOString();
  const fileEvent = ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path, isExecutable: true } });
  ingest({ source: 'persistence-monitor', category: 'REGISTRY_RUN', occurredAt: now, subject: { changeType: 'UNCHANGED' }, metadata: { target: path } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-002', fileEvent.id);
  assert.equal(matches.length, 0);
});

// ── CORR-003: Defender detection + same file (resource/path match) ───────

test('CORR-003: correlates a Defender detection with a file inspection of the same resource', () => {
  const marker = uid('flagged');
  const path = `C:\\Users\\test\\${marker}.exe`;
  const now = new Date().toISOString();
  const defenderEvent = ingest({ source: 'windows-defender', category: 'detection', occurredAt: now, subject: { resource: path } });
  ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-003', defenderEvent.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].severity, 'HIGH');
});

test('CORR-003: does not fire for an unrelated resource', () => {
  const now = new Date().toISOString();
  const defenderEvent = ingest({ source: 'windows-defender', category: 'detection', occurredAt: now, subject: { resource: `C:\\${uid('x')}.exe` } });
  ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path: `C:\\${uid('y')}.exe` } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-003', defenderEvent.id);
  assert.equal(matches.length, 0);
});

// ── CORR-004: persistence_added + unsigned executable ────────────────────

test('CORR-004: correlates a new persistence entry with an unsigned executable it targets', () => {
  const fileName = uid('unsigned') + '.exe';
  const path = `C:\\Users\\test\\${fileName}`;
  const now = new Date().toISOString();
  const fileEvent = ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path }, metadata: { signed: false } });
  ingest({ source: 'persistence-monitor', category: 'REGISTRY_RUN', occurredAt: now, subject: { changeType: 'NEW' }, metadata: { target: path } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-004', fileEvent.id);
  assert.equal(matches.length, 1);
});

test('CORR-004: does not fire for a SIGNED executable (normal signed Microsoft process scenario)', () => {
  const fileName = uid('signed') + '.exe';
  const path = `C:\\Windows\\System32\\${fileName}`;
  const now = new Date().toISOString();
  const fileEvent = ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path }, metadata: { signed: true } });
  ingest({ source: 'persistence-monitor', category: 'REGISTRY_RUN', occurredAt: now, subject: { changeType: 'NEW' }, metadata: { target: path } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-004', fileEvent.id);
  assert.equal(matches.length, 0, 'a signed executable must not trigger this rule (false-positive discipline)');
});

// ── CORR-005: Observateur suspicious endpoint + same-PID-name process ─────

test('CORR-005: correlates an Observateur signal with a process observation sharing the process name', () => {
  const name = uid('correlated.exe');
  const now = new Date().toISOString();
  const observateurEvent = ingest({ source: 'observateur', category: 'network', severity: 'SUSPICIOUS', occurredAt: now, subject: { processName: name } });
  ingest({ source: 'process-monitor', category: 'process-inspection', occurredAt: now, subject: { name } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-005', observateurEvent.id);
  assert.equal(matches.length, 1);
});

// ── Time windows ──────────────────────────────────────────────────────────

test('CORR-001: out-of-window events (>5 min apart) do not correlate', () => {
  const name = uid('slow.exe');
  const t0 = Date.now();
  const processEvent = ingest({ source: 'process-monitor', category: 'process-inspection', occurredAt: new Date(t0).toISOString(), subject: { name } });
  ingest({ source: 'observateur', category: 'network', occurredAt: new Date(t0 + 10 * 60_000).toISOString(), subject: { anomalyId: uid('a'), processName: name } });
  const matches = matchesIncludingEvent(runCorrelation({ referenceTime: t0 + 10 * 60_000, windowMs: 60 * 60_000 }), 'CORR-001', processEvent.id);
  assert.equal(matches.length, 0, 'events more than 5 minutes apart must not satisfy CORR-001s own 5-minute window');
});

test('runCorrelation: events entirely outside the overall correlation window are excluded from consideration', () => {
  const name = uid('ancient.exe');
  const longAgo = Date.now() - 2 * 60 * 60_000; // 2 hours ago
  const processEvent = ingest({ source: 'process-monitor', category: 'process-inspection', occurredAt: new Date(longAgo).toISOString(), subject: { name } });
  ingest({ source: 'observateur', category: 'network', occurredAt: new Date(longAgo).toISOString(), subject: { anomalyId: uid('a'), processName: name } });
  // Default windowMs is 1 hour — events 2 hours old should not even enter recentEvents().
  const matches = matchesIncludingEvent(runCorrelation({ referenceTime: Date.now(), windowMs: 60 * 60_000 }), 'CORR-001', processEvent.id);
  assert.equal(matches.length, 0);
});

// ── Explainability ────────────────────────────────────────────────────────

test('runCorrelation: every match has ruleId, matchedEventIds, reason, severity, confidence, evidenceRefs — never an opaque score', () => {
  const name = uid('explainable.exe');
  const now = new Date().toISOString();
  ingest({ source: 'process-monitor', category: 'process-inspection', occurredAt: now, subject: { name } });
  ingest({ source: 'observateur', category: 'network', occurredAt: now, subject: { anomalyId: uid('a'), processName: name } });
  const matches = runCorrelation();
  assert.ok(matches.length >= 1);
  for (const m of matches) {
    assert.equal(typeof m.ruleId, 'string');
    assert.ok(Array.isArray(m.matchedEventIds) && m.matchedEventIds.length >= 1);
    assert.equal(typeof m.reason, 'string');
    assert.ok(m.reason.length > 0);
    assert.ok(['OBSERVATION', 'SUSPICIOUS', 'HIGH', 'CRITICAL'].includes(m.severity));
    assert.equal(typeof m.confidence, 'number');
    assert.ok(Array.isArray(m.evidenceRefs));
  }
});

// ── Severity escalation discipline ────────────────────────────────────────

test('escalateSeverity: a single OBSERVATION anomaly stays OBSERVATION', () => {
  assert.equal(escalateSeverity([{ severity: 'OBSERVATION' }]), 'OBSERVATION');
});

test('escalateSeverity: a single SUSPICIOUS match stays SUSPICIOUS, never escalates alone', () => {
  assert.equal(escalateSeverity([{ severity: 'SUSPICIOUS' }]), 'SUSPICIOUS');
});

test('escalateSeverity: a single HIGH match stays HIGH — CRITICAL requires TWO corroborating matches', () => {
  assert.equal(escalateSeverity([{ severity: 'HIGH' }]), 'HIGH', 'a single HIGH match must never alone become CRITICAL');
});

test('escalateSeverity: CRITICAL discipline test — single Observateur anomaly != CRITICAL', () => {
  assert.notEqual(escalateSeverity([{ severity: 'SUSPICIOUS' }]), 'CRITICAL');
});

test('escalateSeverity: CRITICAL discipline test — single unsigned file != CRITICAL', () => {
  assert.notEqual(escalateSeverity([{ severity: 'OBSERVATION' }]), 'CRITICAL');
});

test('escalateSeverity: CRITICAL discipline test — single persistence entry != CRITICAL', () => {
  assert.notEqual(escalateSeverity([{ severity: 'OBSERVATION' }]), 'CRITICAL');
});

test('escalateSeverity: HIGH + a second SUSPICIOUS-or-above match together DO escalate to CRITICAL', () => {
  assert.equal(escalateSeverity([{ severity: 'HIGH' }, { severity: 'SUSPICIOUS' }]), 'CRITICAL');
});

test('escalateSeverity: empty match list defaults to OBSERVATION, never throws', () => {
  assert.equal(escalateSeverity([]), 'OBSERVATION');
});

// ── Incident creation ──────────────────────────────────────────────────────

test('createIncidentFromCorrelation: creates a new OPEN incident from a match', () => {
  const match = { ruleId: 'CORR-001', matchedEventIds: [uid('e1')], reason: 'test reason', severity: 'SUSPICIOUS', confidence: 0.5, evidenceRefs: [] };
  const incident = createIncidentFromCorrelation(match);
  assert.equal(incident.status, 'OPEN');
  assert.equal(incident.severity, 'SUSPICIOUS');
  assert.ok(incident.title.includes('CORR-001'));
});

test('createIncidentFromCorrelation: never creates INVESTIGATING/CONTAINED/RESOLVED directly', () => {
  const match = { ruleId: 'CORR-002', matchedEventIds: [uid('e2')], reason: 'x', severity: 'OBSERVATION', confidence: 0.3, evidenceRefs: [] };
  const incident = createIncidentFromCorrelation(match);
  assert.equal(incident.status, 'OPEN');
});

test('createIncidentFromCorrelation: rejects an invalid severity rather than persisting a broken incident', () => {
  const match = { ruleId: 'CORR-001', matchedEventIds: [uid('e3')], reason: 'x', severity: 'ATTACK_CONFIRMED', confidence: 0.9, evidenceRefs: [] };
  assert.throws(() => createIncidentFromCorrelation(match));
});

// ── Incident deduplication ─────────────────────────────────────────────────

test('createIncidentFromCorrelation: the SAME match twice reuses the SAME incident (dedup)', () => {
  const eventIds = [uid('dedup-e1'), uid('dedup-e2')];
  const match = { ruleId: 'CORR-002', matchedEventIds: eventIds, reason: 'dedup test reason', severity: 'SUSPICIOUS', confidence: 0.8, evidenceRefs: [] };
  const first = createIncidentFromCorrelation(match);
  const second = createIncidentFromCorrelation(match);
  assert.equal(first.id, second.id);

  const openIncidents = listIncidents({ status: 'OPEN', limit: 500 }).filter(i => i.id === first.id);
  assert.equal(openIncidents.length, 1, 'must not create a duplicate incident row');
});

test('createIncidentFromCorrelation: reusing an incident appends a timeline entry rather than duplicating the whole timeline', () => {
  const eventIds = [uid('timeline-e1')];
  const match = { ruleId: 'CORR-001', matchedEventIds: eventIds, reason: 'timeline test', severity: 'OBSERVATION', confidence: 0.4, evidenceRefs: [] };
  const first = createIncidentFromCorrelation(match);
  const firstTimelineLength = first.timeline.length;
  const second = createIncidentFromCorrelation(match);
  assert.equal(second.timeline.length, firstTimelineLength + 1);
});

test('createIncidentFromCorrelation: a DIFFERENT match (different ruleId, same events) creates a DIFFERENT incident', () => {
  const eventIds = [uid('diff-rule-e1')];
  const matchA = { ruleId: 'CORR-001', matchedEventIds: eventIds, reason: 'a', severity: 'OBSERVATION', confidence: 0.3, evidenceRefs: [] };
  const matchB = { ruleId: 'CORR-002', matchedEventIds: eventIds, reason: 'b', severity: 'OBSERVATION', confidence: 0.3, evidenceRefs: [] };
  const incidentA = createIncidentFromCorrelation(matchA);
  const incidentB = createIncidentFromCorrelation(matchB);
  assert.notEqual(incidentA.id, incidentB.id);
});

test('createIncidentFromCorrelation: a resolved incident matching the same fingerprint is not silently reopened', () => {
  const eventIds = [uid('resolved-e1')];
  const match = { ruleId: 'CORR-004', matchedEventIds: eventIds, reason: 'resolved test', severity: 'SUSPICIOUS', confidence: 0.6, evidenceRefs: [] };
  const incident = createIncidentFromCorrelation(match);
  // Manually walk it to a terminal state via the store's own transition validation.
  updateIncident(incident.id, { status: 'INVESTIGATING' });
  updateIncident(incident.id, { status: 'RESOLVED' });

  const reMatched = createIncidentFromCorrelation(match);
  assert.equal(reMatched.status, 'RESOLVED', 'must not silently flip a resolved incident back to OPEN');
  assert.equal(reMatched.id, incident.id);
});

// ── Incident timeline ──────────────────────────────────────────────────────

test('createIncidentFromCorrelation: initial timeline records event_observed, correlation_matched, incident_created — no system action entries', () => {
  const match = { ruleId: 'CORR-003', matchedEventIds: [uid('tl-e1')], reason: 'timeline content test', severity: 'HIGH', confidence: 0.9, evidenceRefs: [] };
  const incident = createIncidentFromCorrelation(match);
  const types = incident.timeline.map(t => t.type);
  assert.deepEqual(types, ['event_observed', 'correlation_matched', 'incident_created']);
  for (const entry of incident.timeline) {
    assert.doesNotMatch(JSON.stringify(entry), /kill|quarantine|scan|block|isolate/i);
  }
});

// ── Evidence linking ────────────────────────────────────────────────────────

test('linkEvidenceToIncident: attaches an Evidence id to an incident without duplicating', () => {
  const match = { ruleId: 'CORR-001', matchedEventIds: [uid('ev-link-e1')], reason: 'evidence link test', severity: 'OBSERVATION', confidence: 0.3, evidenceRefs: [] };
  const incident = createIncidentFromCorrelation(match);
  const evidence = createEvidence({ type: 'OTHER', source: 'test', metadata: { note: 'x' } });

  const updated1 = linkEvidenceToIncident(incident.id, evidence.id);
  assert.deepEqual(updated1.evidenceRefs, [evidence.id]);

  const updated2 = linkEvidenceToIncident(incident.id, evidence.id);
  assert.deepEqual(updated2.evidenceRefs, [evidence.id], 'linking the same evidence twice must not duplicate the reference');
});

test('linkEvidenceToIncident: unknown incident id throws', () => {
  assert.throws(() => linkEvidenceToIncident('nope', 'some-evidence-id'));
});

// ── False-positive discipline ──────────────────────────────────────────────

test('false-positive discipline: a common startup entry alone (no correlation) never becomes an incident', () => {
  const startupEvent = ingest({ source: 'persistence-monitor', category: 'STARTUP_FILE', subject: { changeType: 'NEW' }, metadata: { target: 'C:\\Users\\x\\Startup\\OneDrive.lnk' } });
  const matches = runCorrelation().filter(m => m.matchedEventIds.includes(startupEvent.id));
  assert.equal(matches.length, 0);
});

test('false-positive discipline: a normal signed Microsoft process + persistence does not trigger CORR-004', () => {
  const path = `C:\\Windows\\System32\\svchost-${uid('x')}.exe`;
  const now = new Date().toISOString();
  const fileEvent = ingest({ source: 'integrity-monitor', category: 'file-inspection', occurredAt: now, subject: { path }, metadata: { signed: true } });
  ingest({ source: 'persistence-monitor', category: 'AUTO_START_SERVICE', occurredAt: now, subject: { changeType: 'NEW' }, metadata: { target: path } });
  const matches = matchesIncludingEvent(runCorrelation(), 'CORR-004', fileEvent.id);
  assert.equal(matches.length, 0);
});

test('false-positive discipline: a normal browser network connection alone never reaches HIGH/CRITICAL', () => {
  const browserEvent = ingest({ source: 'observateur', category: 'network', severity: 'OBSERVATION', subject: { processName: `chrome-${uid('x')}.exe` } });
  const matches = runCorrelation().filter(m => m.matchedEventIds.includes(browserEvent.id));
  for (const m of matches) {
    assert.notEqual(m.severity, 'HIGH');
    assert.notEqual(m.severity, 'CRITICAL');
  }
});
