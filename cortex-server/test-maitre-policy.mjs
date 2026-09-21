// Unit tests for maitre-policy.js — real isolated test DB (incident
// lookups are real reads). Covers ALLOW/CONFIRM/DENY across all levels
// and action types, critical process protection, host isolation
// prerequisites, and structural invariants.
// Run with: node --test test-maitre-policy.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import { createIncident } from './src/lib/maitre-store.js';
import { evaluateActionPolicy, POLICY_DECISIONS } from './src/lib/maitre-policy.js';
import { validateActionInput } from './src/lib/maitre-actions.js';

const TEST_DB_DIR = './data-test-maitre-policy';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function incident() {
  return createIncident({ title: 'policy test incident', severity: 'SUSPICIOUS' });
}

test('POLICY_DECISIONS: exact closed set', () => {
  assert.deepEqual([...POLICY_DECISIONS], ['ALLOW', 'CONFIRM', 'DENY']);
});

test('evaluateActionPolicy: missing incident denies', () => {
  const action = validateActionInput({ incidentId: 'does-not-exist', actionType: 'COLLECT_EVIDENCE', target: { evidenceType: 'OTHER' } });
  const result = evaluateActionPolicy(action);
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reason, 'incident_not_found');
});

test('evaluateActionPolicy: unknown actionType denies', () => {
  const result = evaluateActionPolicy({ incidentId: incident().id, actionType: 'BOGUS_ACTION', level: 1, target: {} });
  assert.equal(result.decision, 'DENY');
});

test('evaluateActionPolicy: invalid level/action combination denies', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'COLLECT_EVIDENCE', target: { evidenceType: 'OTHER' } });
  const tampered = { ...action, level: 3 }; // client trying to smuggle a different level
  const result = evaluateActionPolicy(tampered);
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reason, 'invalid_level_action_combination');
});

// ── LEVEL 1 ────────────────────────────────────────────────────────────────

test('LEVEL 1: COLLECT_EVIDENCE is ALLOW (passive)', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'COLLECT_EVIDENCE', target: { evidenceType: 'PROCESS_SNAPSHOT', pid: 1234 } });
  const result = evaluateActionPolicy(action);
  assert.equal(result.decision, 'ALLOW');
});

test('LEVEL 1: SCAN_WITH_DEFENDER is CONFIRM (resource-intensive, not silent ALLOW)', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'SCAN_WITH_DEFENDER', target: { path: 'C:\\Users\\test\\file.exe' } });
  const result = evaluateActionPolicy(action);
  assert.equal(result.decision, 'CONFIRM');
});

// ── LEVEL 2 — CONFIRM always required ──────────────────────────────────────

test('LEVEL 2: TERMINATE_PROCESS is always CONFIRM, never ALLOW', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'TERMINATE_PROCESS', target: { pid: 4242, processIdentity: 'app.exe' } });
  const result = evaluateActionPolicy(action);
  assert.equal(result.decision, 'CONFIRM');
  assert.ok(result.requirements.includes('user_confirmation'));
});

test('LEVEL 2: BLOCK_REMOTE_IP is always CONFIRM', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'BLOCK_REMOTE_IP', target: { ip: '203.0.113.5' } });
  assert.equal(evaluateActionPolicy(action).decision, 'CONFIRM');
});

test('LEVEL 2: QUARANTINE_WITH_DEFENDER is always CONFIRM', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'QUARANTINE_WITH_DEFENDER', target: { path: 'C:\\evil.exe' } });
  assert.equal(evaluateActionPolicy(action).decision, 'CONFIRM');
});

test('LEVEL 2: DISABLE_PERSISTENCE_ENTRY is always CONFIRM', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'DISABLE_PERSISTENCE_ENTRY', target: { persistenceItemId: 'x', persistenceType: 'REGISTRY_RUN' } });
  assert.equal(evaluateActionPolicy(action).decision, 'CONFIRM');
});

test('LEVEL 2: never returns ALLOW for any level-2 action', () => {
  const inc = incident();
  const actions = [
    validateActionInput({ incidentId: inc.id, actionType: 'TERMINATE_PROCESS', target: { pid: 1, processIdentity: 'x.exe' } }),
    validateActionInput({ incidentId: inc.id, actionType: 'BLOCK_REMOTE_IP', target: { ip: '203.0.113.1' } }),
    validateActionInput({ incidentId: inc.id, actionType: 'QUARANTINE_WITH_DEFENDER', target: { path: 'C:\\x.exe' } }),
    validateActionInput({ incidentId: inc.id, actionType: 'DISABLE_PERSISTENCE_ENTRY', target: { persistenceItemId: 'x', persistenceType: 'STARTUP_FILE' } }),
  ];
  for (const action of actions) {
    assert.notEqual(evaluateActionPolicy(action).decision, 'ALLOW', action.actionType);
  }
});

// ── Critical process protection (reuses MA-4 classification) ─────────────

test('critical process deny: TERMINATE_PROCESS on lsass.exe is denied at validation, never reaches policy as ALLOW', () => {
  const inc = incident();
  assert.throws(() => validateActionInput({ incidentId: inc.id, actionType: 'TERMINATE_PROCESS', target: { pid: 500, processIdentity: 'lsass.exe' } }));
});

test('Docteur process deny: TERMINATE_PROCESS on node.exe is denied at validation', () => {
  const inc = incident();
  assert.throws(() => validateActionInput({ incidentId: inc.id, actionType: 'TERMINATE_PROCESS', target: { pid: 1234, processIdentity: 'node.exe' } }));
});

// ── LEVEL 3 — strengthened confirmation ────────────────────────────────────

test('LEVEL 3: HOST_ISOLATION with all prerequisites is CONFIRM with strengthened_confirmation requirement', () => {
  const inc = incident();
  const action = validateActionInput({
    incidentId: inc.id, actionType: 'HOST_ISOLATION',
    target: { reason: 'critical incident', previewMetadata: { blocked: [] }, rollbackPlanAvailable: true },
  });
  const result = evaluateActionPolicy(action);
  assert.equal(result.decision, 'CONFIRM');
  assert.ok(result.requirements.includes('strengthened_confirmation'));
  assert.equal(result.riskLevel, 'high');
});

test('LEVEL 3: HOST_ISOLATION missing rollback plan denies at validation (never reaches policy)', () => {
  const inc = incident();
  assert.throws(() => validateActionInput({ incidentId: inc.id, actionType: 'HOST_ISOLATION', target: { reason: 'x', previewMetadata: {} } }));
});

test('LEVEL 3: RESTORE_HOST_NETWORK is CONFIRM', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'RESTORE_HOST_NETWORK', target: { relatedActionId: 'some-action-id' } });
  assert.equal(evaluateActionPolicy(action).decision, 'CONFIRM');
});

test('LEVEL 3: never returns ALLOW', () => {
  const inc = incident();
  const action = validateActionInput({
    incidentId: inc.id, actionType: 'HOST_ISOLATION',
    target: { reason: 'x', previewMetadata: {}, rollbackPlanAvailable: true },
  });
  assert.notEqual(evaluateActionPolicy(action).decision, 'ALLOW');
});

// ── Explainability ──────────────────────────────────────────────────────

test('evaluateActionPolicy: every decision includes reason/requirements/riskLevel, never opaque', () => {
  const inc = incident();
  const action = validateActionInput({ incidentId: inc.id, actionType: 'TERMINATE_PROCESS', target: { pid: 1, processIdentity: 'x.exe' } });
  const result = evaluateActionPolicy(action);
  assert.equal(typeof result.decision, 'string');
  assert.equal(typeof result.reason, 'string');
  assert.ok(Array.isArray(result.requirements));
  assert.equal(typeof result.riskLevel, 'string');
});
