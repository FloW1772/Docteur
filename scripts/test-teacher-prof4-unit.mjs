// Professeur V2 (PROF-4) — unit tests of the history / navigation view-model helpers (src/lib/teacher/dual-track.ts).
// Usage: node --test scripts/test-teacher-prof4-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptStatus, ATTEMPT_STATUS_LABELS, submissionSummary, trackHistory, canViewModule } from '../src/lib/teacher/dual-track.ts';
import { presentHistory } from '../cortex-server/src/lib/teacher-history.js';

const v = (extra = {}) => ({ passed: false, score: 10, criteria: [], feedback: '', ...extra });

test('attempt status: passed / failed / invalid / corrupted, each with a learner label', () => {
  assert.equal(attemptStatus({ passed: true, verdict: v({ passed: true }) }), 'passed');
  assert.equal(attemptStatus({ passed: false, verdict: v() }), 'failed');
  assert.equal(attemptStatus({ passed: false, verdict: v({ invalid: true }) }), 'invalid');
  assert.equal(attemptStatus({ passed: false, verdict: null, corrupted: true }), 'corrupted');
  assert.equal(attemptStatus({ passed: true, verdict: v({ passed: false }) }), 'failed', 'never shown as passed unless both agree');
  for (const s of ['passed', 'failed', 'invalid', 'corrupted']) assert.ok(ATTEMPT_STATUS_LABELS[s]);
});

test('submission summary: learner text clipped, self-report as x/y, nothing else', () => {
  assert.equal(submissionSummary({ answer: 'abc' }), 'abc');
  assert.equal(submissionSummary({ answer: 'x'.repeat(500) }, 20).length, 20);
  assert.equal(submissionSummary({ mode: 'deliverable', submission: 'mon livrable' }), 'mon livrable');
  assert.equal(submissionSummary({ mode: 'self_report', confirmations: [true, false, true], note: 'ok' }), '2/3 point(s) déclaré(s) — ok');
  assert.equal(submissionSummary({}), '');
  assert.equal(submissionSummary(undefined), '');
});

test('track history filters the server-ordered list per track (works on the real server presenter output)', () => {
  const rows = presentHistory([
    { id: '1', track: 'theory', created_at: 'a', passed: false, evidence: null, payload: { answer: 'x' }, verdict: v() },
    { id: '2', track: 'practice', created_at: 'b', passed: false, evidence: 'SELF_REPORTED', payload: {}, verdict: v({ selfReported: true }) },
    { id: '3', track: 'theory', created_at: 'c', passed: true, evidence: null, payload: { answer: 'y' }, verdict: v({ passed: true }) },
  ]);
  assert.deepEqual(trackHistory(rows, 'theory').map(a => [a.id, a.index]), [['1', 1], ['3', 2]]);
  assert.deepEqual(trackHistory(rows, 'practice').map(a => a.id), ['2']);
  assert.deepEqual(trackHistory(null, 'theory'), []);
});

test('modules viewable once unlocked on a track; a fully LOCKED module stays closed', () => {
  const t = (theory, practice) => ({ theory: { state: theory }, practice: { state: practice } });
  assert.equal(canViewModule(t('LOCKED', 'LOCKED')), false);
  assert.equal(canViewModule(t('ACTIVE', 'ACTIVE')), true);
  assert.equal(canViewModule(t('PASSED', 'PASSED')), true);
  assert.equal(canViewModule(null), false);
});
