// Professeur V2 (PROF-3) — unit tests of the pure THÉORIE | PRATIQUE view-model (src/lib/teacher/dual-track.ts, Node
// type stripping), including parity with the server's own rules (cortex-server/src/lib/teacher-progress.js).
// Usage: node --test scripts/test-teacher-dual-track-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dualTrackLayout, DUAL_TRACK_COLUMNS_MIN_WIDTH, allowedPracticeModes, canSubmitTrack, bothTracksPassed,
  shouldRequestPracticeSpec, verdictTone, advanceLabel, TRACK_STATE_LABELS, EVIDENCE_LABELS,
} from '../src/lib/teacher/dual-track.ts';
import * as server from '../cortex-server/src/lib/teacher-progress.js';

const tracks = (theory, practice, extra = {}) => ({
  version: 1,
  theory: { state: theory, evaluation: { kind: 'short' }, lastVerdict: null, passedAt: null, attempts: 0 },
  practice: { state: practice, spec: { kind: 'checklist', instructions: 'x', checklist: ['a', 'b'], generated: false }, evidence: null, lastVerdict: null, passedAt: null, attempts: 0, ...extra },
});

test('layout: two columns from 900 px, tabs below (states stay separate either way)', () => {
  assert.equal(DUAL_TRACK_COLUMNS_MIN_WIDTH, 900);
  assert.equal(dualTrackLayout(1048), 'columns');
  assert.equal(dualTrackLayout(900), 'columns');
  assert.equal(dualTrackLayout(899), 'tabs');
  assert.equal(dualTrackLayout(360), 'tabs');
  assert.equal(dualTrackLayout(0), 'tabs');
  assert.equal(dualTrackLayout(Number.NaN), 'tabs');
});

test('practice modes: identical to the server rule for every kind', () => {
  const specs = [
    { kind: 'result', checklist: ['a'] }, { kind: 'result' }, { kind: 'deliverable' }, { kind: 'deliverable', checklist: ['a'] },
    { kind: 'exercise', checklist: ['a'] }, { kind: 'exercise', checklist: [] }, { kind: 'checklist', checklist: ['a', 'b'] }, null, undefined, {},
  ];
  for (const spec of specs) assert.deepEqual(allowedPracticeModes(spec), server.allowedPracticeModes(spec), JSON.stringify(spec));
});

test('submission allowed only while ACTIVE / REMEDIATION (server canAttempt)', () => {
  for (const state of ['LOCKED', 'ACTIVE', 'REMEDIATION', 'PASSED']) {
    assert.equal(canSubmitTrack(state), server.canAttempt(tracks(state, state), 'theory').ok, state);
  }
  assert.equal(canSubmitTrack(undefined), false);
});

test('gate hint mirrors the server gate: both PASSED (the server still decides on /advance)', () => {
  assert.equal(bothTracksPassed(tracks('PASSED', 'ACTIVE')), false, 'theory only');
  assert.equal(bothTracksPassed(tracks('ACTIVE', 'PASSED')), false, 'practice only');
  assert.equal(bothTracksPassed(tracks('PASSED', 'REMEDIATION')), false);
  assert.equal(bothTracksPassed(tracks('PASSED', 'PASSED')), true);
  assert.equal(bothTracksPassed(null), false);
  assert.equal(advanceLabel({ passed: false, isLast: false }), 'Valide la théorie ET la pratique pour continuer');
  assert.equal(advanceLabel({ passed: true, isLast: false }), 'Module suivant');
  assert.equal(advanceLabel({ passed: true, isLast: true }), 'Terminer le parcours');
});

test('practice spec requested once, only for the generic default, before any attempt, on an open track', () => {
  assert.equal(shouldRequestPracticeSpec(tracks('ACTIVE', 'ACTIVE')), true);
  assert.equal(shouldRequestPracticeSpec(tracks('ACTIVE', 'REMEDIATION')), true);
  assert.equal(shouldRequestPracticeSpec(tracks('LOCKED', 'LOCKED')), false);
  assert.equal(shouldRequestPracticeSpec(tracks('ACTIVE', 'PASSED')), false);
  assert.equal(shouldRequestPracticeSpec(tracks('ACTIVE', 'ACTIVE', { attempts: 1 })), false);
  const generated = tracks('ACTIVE', 'ACTIVE');
  generated.practice.spec.generated = true;
  assert.equal(shouldRequestPracticeSpec(generated), false);
  const authored = tracks('ACTIVE', 'ACTIVE');
  delete authored.practice.spec.generated;
  assert.equal(shouldRequestPracticeSpec(authored), false, 'server-authored spec: never replaced');
  // same decision as the server's canReplacePracticeSpec for every case above
  for (const t of [tracks('ACTIVE', 'ACTIVE'), tracks('LOCKED', 'LOCKED'), tracks('ACTIVE', 'PASSED'), tracks('ACTIVE', 'ACTIVE', { attempts: 1 }), generated, authored]) {
    assert.equal(shouldRequestPracticeSpec(t), server.canReplacePracticeSpec(t).ok);
  }
});

test('verdict tone and labels: invalid ≠ failed; self-report is never presented as verified', () => {
  assert.equal(verdictTone(null), null);
  assert.equal(verdictTone({ passed: true, score: 90, criteria: [], feedback: '' }), 'passed');
  assert.equal(verdictTone({ passed: false, score: 20, criteria: [], feedback: '' }), 'failed');
  assert.equal(verdictTone({ passed: false, score: 0, criteria: [], feedback: '', invalid: true }), 'invalid');
  assert.match(EVIDENCE_LABELS.SELF_REPORTED, /non observé/);
  assert.doesNotMatch(EVIDENCE_LABELS.SELF_REPORTED, /vérifié/i);
  assert.deepEqual(Object.keys(TRACK_STATE_LABELS).sort(), Object.keys(server.TRACK_STATES).sort());
});
