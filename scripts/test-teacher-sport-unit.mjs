// Professeur V2 (PROF-5) — unit tests of the Sport Coach form/view helpers (src/lib/teacher/sport.ts), checked
// against the REAL server validator and dose wording (cortex-server/src/lib/sport-*.js).
// Usage: node --test scripts/test-teacher-sport-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSportForm, buildSportProfile, toggleEquipment, toggleIn, sportErrorText, sessionsByWeek, doseText, secondsText } from '../src/lib/teacher/sport.ts';
import { validateSportProfile } from '../cortex-server/src/lib/sport-profile.js';
import { doseLabel } from '../cortex-server/src/lib/sport-program.js';

test('the default form is a valid profile for the server', () => {
  const v = validateSportProfile(buildSportProfile(defaultSportForm()));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('payload: comma lists split, numbers parsed, pain only when declared, free goal text only for "libre"', () => {
  const form = { ...defaultSportForm(), customEquipment: ' TRX , step ,', liked: 'course, vélo', age: '42', painPresent: true, painAreas: ['genou'], painIntensity: 3, goal: 'libre', goal_custom: '  randonnée  ' };
  const p = buildSportProfile(form);
  assert.deepEqual(p.custom_equipment, ['TRX', 'step']);
  assert.deepEqual(p.liked, ['course', 'vélo']);
  assert.equal(p.age, 42);
  assert.deepEqual(p.pain, { present: true, areas: ['genou'], intensity: 3, worsening: false });
  assert.equal(p.goal_custom, 'randonnée');
  assert.equal(validateSportProfile(p).ok, true);
  const noPain = buildSportProfile(defaultSportForm());
  assert.deepEqual(noPain.pain, { present: false });
  assert.equal('goal_custom' in noPain, false);
  assert.equal('age' in noPain, false);
  const typo = buildSportProfile({ ...defaultSportForm(), session_minutes: 'trente' });
  assert.equal(validateSportProfile(typo).ok, false, 'non-numeric input is sent as is and refused by the server');
});

test('equipment toggle: "aucun" exclusive, empty selection falls back to "aucun"', () => {
  assert.deepEqual(toggleEquipment(['aucun'], 'halteres'), ['halteres']);
  assert.deepEqual(toggleEquipment(['halteres', 'banc'], 'aucun'), ['aucun']);
  assert.deepEqual(toggleEquipment(['halteres'], 'halteres'), ['aucun']);
  assert.deepEqual(toggleIn(['lundi'], 'mardi'), ['lundi', 'mardi']);
  assert.deepEqual(toggleIn(['lundi', 'mardi'], 'lundi'), ['mardi']);
});

test('server field errors become readable sentences (out of scope → professional)', () => {
  const v = validateSportProfile({ ...buildSportProfile(defaultSportForm()), sessions_per_week: 9, goal: 'libre', goal_custom: 'rééducation du genou' });
  const texts = v.errors.map(sportErrorText);
  assert.ok(texts.some(t => t.startsWith('Séances par semaine')));
  assert.ok(texts.some(t => /professionnel de santé/.test(t)));
});

test('program layout and dose wording identical to the server', () => {
  const sessions = [{ week: 1, index: 0 }, { week: 1, index: 1 }, { week: 2, index: 2 }];
  assert.deepEqual(sessionsByWeek(sessions).map(w => [w.week, w.sessions.length]), [[1, 2], [2, 1]]);
  assert.deepEqual(sessionsByWeek(undefined), []);
  for (const e of [{ sets: 3, type: 'reps', reps: 10 }, { sets: 1, type: 'duration', duration_sec: 1200 }, { sets: 2, type: 'duration', duration_sec: 45 }]) {
    assert.equal(doseText(e), doseLabel(e));
  }
  assert.equal(secondsText(90), '1 min 30 s');
  assert.equal(secondsText(45), '45 s');
});

// ── PROF-6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
import { defaultCheckinForm, buildCheckin, checkinSummary, programProgress, AREA_LABELS, EQUIPMENT_LABELS, sessionEquipment, ADAPTATION_LABELS } from '../src/lib/teacher/sport.ts';
import { SPORT_LABELS } from '../cortex-server/src/lib/sport-profile.js';
import { validateCheckin, ADAPTATION_RULE_LABELS } from '../cortex-server/src/lib/sport-adaptation.js';

test('PROF-6: static labels identical to the server vocabularies', () => {
  assert.deepEqual(AREA_LABELS, SPORT_LABELS.areas);
  assert.deepEqual(EQUIPMENT_LABELS, SPORT_LABELS.equipment);
  assert.deepEqual(Object.keys(ADAPTATION_LABELS).sort(), Object.keys(ADAPTATION_RULE_LABELS).sort());
});

test('PROF-6: the UI check-in is accepted by the server validator (done / not done / pain)', () => {
  assert.equal(validateCheckin(buildCheckin(defaultCheckinForm())).ok, true);
  const notDone = buildCheckin({ ...defaultCheckinForm(), completed: false });
  assert.equal(notDone.rpe, null);
  assert.equal(validateCheckin(notDone).ok, true);
  const pain = buildCheckin({ ...defaultCheckinForm(), pain: true, painAreas: ['dos'], painWorsening: true, unavailable: ['halteres'], comment: '  ok ' });
  assert.equal(validateCheckin(pain).ok, true);
  assert.equal(pain.comment, 'ok');
  assert.equal(validateCheckin(buildCheckin({ ...defaultCheckinForm(), pain: true })).ok, false, 'pain without area is refused by the server');
  const noPainLeftovers = buildCheckin({ ...defaultCheckinForm(), pain: false, painAreas: ['dos'], painWorsening: true });
  assert.deepEqual([noPainLeftovers.pain_areas, noPainLeftovers.pain_worsening], [[], false]);
});

test('PROF-6: check-in summary, progress, session equipment', () => {
  assert.equal(checkinSummary({ completed: true, rpe: 7, energy: 2, technique_confidence: 4, unusual_pain: true, pain_areas: ['genou'] }), 'séance faite · RPE 7/10 · énergie 2/5 · technique 4/5 · douleur inhabituelle (genou)');
  assert.equal(checkinSummary({ completed: false, rpe: null, energy: 3, technique_confidence: 3, unusual_pain: false, pain_areas: [] }), 'séance non terminée · énergie 3/5 · technique 3/5');
  assert.equal(checkinSummary(null), '');
  const steps = [{ step_index: 0, tracks: { practice: { state: 'PASSED' } } }, { step_index: 1, tracks: { practice: { state: 'ACTIVE' } } }, { step_index: 2, tracks: { practice: { state: 'LOCKED' } } }, { step_index: 3, tracks: null }];
  assert.deepEqual(programProgress(steps, 1), { total: 4, done: 1, current: 2, percent: 25 });
  assert.deepEqual(sessionEquipment({ exercises: [{ equipment: ['halteres'] }, { equipment: [] }, { equipment: ['halteres', 'banc'] }] }), ['halteres', 'banc']);
});
