import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 (PROF-5) — Sport Coach: profile validation, safety screen, program generation (model proposal strictly
// validated, catalog fallback), level/youth bounds, equipment/location/area feasibility, time budget, progression,
// every register, routes (create, start, practice = SELF_REPORTED workout, lesson safety), Strict Local.
// In-memory SQLite only; scripted local model; fetch is a spy.
// Run: node --test test-teacher-sport.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { validateSportProfile, screenSportProfile, isYouthContext } from './src/lib/sport-profile.js';
import {
  sportContext, catalogTemplates, validateModelTemplates, expandProgram, estimateMinutes, sportSafetyScan, LEVEL_PARAMS,
  workoutPracticeSpec,
} from './src/lib/sport-program.js';
import { EXERCISES, EXERCISE_BY_ID } from './src/lib/sport-catalog.js';
import { TEACHER_REGISTERS, teacherRegisterInstruction } from './src/lib/teacher-register.js';

initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-sport' });

const base = (extra = {}) => ({
  goal: 'remise_en_forme', level: 'debutant', locations: ['maison'], equipment: ['aucun'],
  sessions_per_week: 2, session_minutes: 30, days: ['lundi', 'jeudi'], ...extra,
});
function build(raw, register = 'standard') {
  const v = validateSportProfile(raw);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const screen = screenSportProfile(v.profile);
  assert.equal(screen.allowed, true);
  const ctx = sportContext(v.profile, { excludedAreas: screen.excludedAreas, youth: isYouthContext(v.profile, register) });
  const templates = catalogTemplates(ctx);
  return { profile: v.profile, screen, ctx, templates, sessions: expandProgram(templates, ctx) };
}
const allExercises = (sessions) => sessions.flatMap(s => s.exercises);
const volume = (s) => s.exercises.reduce((a, e) => a + e.sets * (e.type === 'reps' ? e.reps : e.duration_sec / 4), 0);

/** Every invariant a delivered program must hold, whatever the profile. */
function assertProgramInvariants({ profile, ctx, sessions, screen }) {
  const b = ctx.bounds;
  assert.equal(sessions.length, profile.sessions_per_week * profile.weeks, 'one module per session');
  for (const s of sessions) {
    assert.ok(profile.days.includes(s.day), 'scheduled on an available day');
    assert.ok(s.estimated_minutes <= profile.session_minutes, `fits the time budget (${s.estimated_minutes} ≤ ${profile.session_minutes})`);
    assert.ok(s.exercises.length >= b.exercises[0] && s.exercises.length <= b.exercises[1], 'exercise count bounded');
    assert.ok(s.warmup.length > 0 && s.cooldown.length > 0, 'warm-up and cool-down present');
    for (const e of s.exercises) {
      const cat = EXERCISE_BY_ID[e.id];
      assert.ok(cat, 'catalog exercise');
      assert.ok(cat.equipment.every(q => ctx.equipment.includes(q)), `${e.name}: equipment available`);
      assert.ok(cat.locations.some(l => profile.locations.includes(l)), `${e.name}: feasible location`);
      assert.ok(!e.areas.some(a => screen.excludedAreas.includes(a)), `${e.name}: no excluded area`);
      assert.ok(b.complexity.includes(cat.complexity), `${e.name}: complexity allowed`);
      assert.ok(e.rpe >= b.rpe[0] && e.rpe <= b.rpe[1], `${e.name}: RPE ${e.rpe} within ${b.rpe}`);
      if (e.pattern !== 'cardio') assert.ok(e.sets >= b.sets[0] && e.sets <= b.sets[1], `${e.name}: sets`);
      if (e.type === 'reps') assert.ok(e.reps >= b.reps[0] && e.reps <= b.reps[1], `${e.name}: reps`);
      assert.ok(e.rest_sec >= b.restSec[0] && e.rest_sec <= b.restSec[1], `${e.name}: rest`);
      assert.ok(e.cues.length > 0, 'technique cues');
      assert.equal(sportSafetyScan(JSON.stringify(e)), null);
    }
  }
  // progression: a later occurrence of the same template is never lighter
  const byTemplate = {};
  for (const s of sessions) (byTemplate[s.template] ??= []).push(volume(s));
  for (const vols of Object.values(byTemplate)) for (let i = 1; i < vols.length; i++) assert.ok(vols[i] >= vols[i - 1], `monotonic progression ${vols}`);
}

// ═══ profile validation ═══════════════════════════════════════════════════════════════════════════════════════════
test('profile: complete profile accepted, unknown fields dropped, defaults applied', () => {
  const v = validateSportProfile(base({ hacker: '<script>', weeks: 3, age: 34, liked: ['course'], limitations: { declared: 'asthme léger', areas: [] } }));
  assert.equal(v.ok, true);
  assert.equal('hacker' in v.profile, false);
  assert.deepEqual([v.profile.weeks, v.profile.progression, v.profile.age, v.profile.pain.present], [3, 'standard', 34, false]);
});

test('profile: invalid / missing / extreme inputs rejected with field errors (nothing silently clamped)', () => {
  const cases = [
    [null, 'profile'], [{}, 'goal'], [base({ goal: 'devenir pro' }), 'goal'], [base({ level: 'dieu' }), 'level'],
    [base({ locations: [] }), 'locations'], [base({ locations: ['lune'] }), 'locations'], [base({ equipment: ['aucun', 'halteres'] }), 'equipment'],
    [base({ equipment: ['laser'] }), 'equipment'], [base({ sessions_per_week: 0 }), 'sessions_per_week'], [base({ sessions_per_week: 14 }), 'sessions_per_week'],
    [base({ session_minutes: 5 }), 'session_minutes'], [base({ session_minutes: 999 }), 'session_minutes'], [base({ session_minutes: 30.5 }), 'session_minutes'],
    [base({ days: ['lundi'] }), 'days'], [base({ days: ['funday', 'lundi'] }), 'days'], [base({ age: 200 }), 'age'], [base({ age: 3 }), 'age'],
    [base({ pain: { present: true, areas: ['genou'], intensity: 11 } }), 'pain.intensity'], [base({ pain: { present: true, areas: ['oreille'], intensity: 2 } }), 'pain.areas'],
    [base({ pain: 'oui' }), 'pain'], [base({ sessions_per_week: 6, days: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'], weeks: 8 }), 'weeks'],
    [base({ goal: 'libre' }), 'goal_custom'], [base({ goal: 'libre', goal_custom: 'rééducation de mon genou opéré' }), 'goal_custom'],
    [base({ liked: Array(20).fill('x') }), 'liked'], [base({ custom_equipment: [42] }), 'custom_equipment'], [base({ progression: 'max' }), 'progression'],
  ];
  for (const [raw, field] of cases) {
    const v = validateSportProfile(raw);
    assert.equal(v.ok, false, JSON.stringify(raw));
    assert.ok(v.errors.some(e => e.field === field), `${field} expected in ${JSON.stringify(v.errors)}`);
  }
});

test('safety screen: high or worsening pain → no program + professional advice; mild pain → areas spared, one notice', () => {
  for (const pain of [{ present: true, areas: ['genou'], intensity: 7 }, { present: true, areas: ['dos'], intensity: 3, worsening: true }]) {
    const s = screenSportProfile(validateSportProfile(base({ pain })).profile);
    assert.equal(s.allowed, false);
    assert.equal(s.code, 'SPORT_PAIN_STOP');
    assert.match(s.message, /professionnel de santé/);
    assert.equal(sportSafetyScan(s.message), null);
  }
  const mild = screenSportProfile(validateSportProfile(base({ pain: { present: true, areas: ['genou'], intensity: 3 }, limitations: { areas: ['epaule'] } })).profile);
  assert.equal(mild.allowed, true);
  assert.deepEqual(mild.excludedAreas.sort(), ['epaule', 'genou']);
  assert.match(mild.notice, /Genou/);
});

// ═══ catalog programs: the PROF-5 matrix ═════════════════════════════════════════════════════════════════════════
const MATRIX = {
  'beginner home no equipment': base(),
  'beginner home with equipment': base({ equipment: ['tapis', 'bandes', 'halteres'] }),
  'intermediate dumbbells': base({ level: 'intermediaire', goal: 'hypertrophie', equipment: ['halteres', 'banc'], sessions_per_week: 3, session_minutes: 50, days: ['lundi', 'mercredi', 'vendredi'] }),
  'experienced gym': base({ level: 'experimente', goal: 'force', locations: ['salle'], equipment: ['barre', 'rack', 'banc', 'halteres'], sessions_per_week: 4, session_minutes: 75, days: ['lundi', 'mardi', 'jeudi', 'vendredi'] }),
  'outdoor endurance': base({ level: 'intermediaire', goal: 'endurance', locations: ['exterieur'], sessions_per_week: 3, session_minutes: 45, days: ['mardi', 'jeudi', 'samedi'] }),
  mobility: base({ goal: 'mobilite', session_minutes: 20 }),
  strength: base({ goal: 'force', level: 'intermediaire', equipment: ['kettlebell', 'halteres'] }),
  hypertrophy: base({ goal: 'hypertrophie', level: 'experimente', locations: ['salle'], equipment: ['halteres', 'banc', 'barre', 'rack'], session_minutes: 60 }),
  'weight loss mixed home+outdoor': base({ goal: 'perte_de_poids', locations: ['maison', 'exterieur'], equipment: ['velo'], sessions_per_week: 3, days: ['lundi', 'mercredi', 'vendredi'] }),
  'custom equipment': base({ custom_equipment: ['TRX'], equipment: ['bandes'] }),
  '2 sessions / week': base({ sessions_per_week: 2 }),
  'higher frequency (6/week)': base({ level: 'intermediaire', sessions_per_week: 6, weeks: 4, days: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'] }),
  'short workout (15 min)': base({ session_minutes: 15 }),
  'long workout (120 min)': base({ level: 'experimente', goal: 'hypertrophie', locations: ['salle'], equipment: ['halteres', 'banc', 'barre', 'rack', 'tapis_de_course'], session_minutes: 120 }),
  'free goal': base({ goal: 'libre', goal_custom: 'Préparer une randonnée de 3 jours' }),
  'treadmill only (missing gear for most)': base({ level: 'intermediaire', equipment: ['tapis_de_course'] }),
};
for (const [name, raw] of Object.entries(MATRIX)) {
  test(`program — ${name}: complete, feasible, bounded, within time, progressive`, () => {
    const p = build(raw);
    assertProgramInvariants(p);
    assert.ok(p.sessions.every(s => s.exercises.some(e => e.pattern !== 'mobility') || raw.goal === 'mobilite'), 'real training content');
  });
}

test('level really changes the program: complexity, volume, intensity, progression', () => {
  const beginner = build(base({ goal: 'force', locations: ['salle'], equipment: ['barre', 'rack', 'halteres', 'banc'], session_minutes: 60 }));
  const expert = build(base({ goal: 'force', level: 'experimente', locations: ['salle'], equipment: ['barre', 'rack', 'halteres', 'banc'], session_minutes: 60 }));
  const cx = (p) => new Set(allExercises(p.sessions).map(e => EXERCISE_BY_ID[e.id].complexity));
  assert.deepEqual([...cx(beginner)], ['basic'], 'beginner: basic exercises only');
  assert.ok(cx(expert).has('advanced'), 'experienced: advanced lifts available');
  assert.ok(Math.max(...allExercises(beginner.sessions).map(e => e.rpe)) <= LEVEL_PARAMS.debutant.rpe[1]);
  assert.ok(Math.max(...allExercises(expert.sessions).map(e => e.rpe)) > LEVEL_PARAMS.debutant.rpe[1], 'experienced: higher intensity');
  assert.ok(Math.max(...allExercises(expert.sessions).map(e => e.sets)) > Math.max(...allExercises(beginner.sessions).map(e => e.sets)), 'experienced: more sets');
  const growth = (p) => volume(p.sessions.at(-1)) / volume(p.sessions[0]);
  const slow = build(base({ goal: 'force', progression: 'douce' }));
  const fast = build(base({ goal: 'force', progression: 'soutenue' }));
  assert.ok(growth(fast) > growth(slow), 'progression pace respected');
});

test('equipment substitution: exercises needing absent gear never appear; alternatives offered with the gear at hand', () => {
  const p = build(base({ level: 'intermediaire', goal: 'force', equipment: ['halteres'] }));
  assert.ok(!allExercises(p.sessions).some(e => e.equipment.includes('barre')));
  assert.ok(allExercises(p.sessions).some(e => e.substitution), 'with/without-equipment alternatives present');
  for (const e of allExercises(p.sessions)) if (e.substitution) assert.ok(e.substitution.equipment.every(q => ['halteres'].includes(q)));
});

test('painful / limited areas are never loaded, whatever the goal', () => {
  for (const goal of ['force', 'hypertrophie', 'endurance', 'remise_en_forme']) {
    const p = build(base({ goal, level: 'intermediaire', equipment: ['halteres'], pain: { present: true, areas: ['genou'], intensity: 4 }, limitations: { areas: ['epaule'] } }));
    assertProgramInvariants(p);
    assert.ok(!allExercises(p.sessions).some(e => e.areas.includes('genou') || e.areas.includes('epaule')));
  }
});

// ═══ model proposal validation ════════════════════════════════════════════════════════════════════════════════════
const ctxFor = (raw, register = 'standard') => { const p = build(raw, register); return p.ctx; };
const ex = (extra = {}) => ({ name: 'Squat goblet', pattern: 'lower', type: 'reps', equipment: ['halteres'], areas: ['genou', 'hanche'], sets: 3, reps: 10, rest_sec: 60, tempo: '2-0-2', rpe: 6, cues: ['Buste droit'], mistakes: ['Talons qui décollent'], easier: 'Squat', harder: 'Fente', ...extra });
const tpl = (exercises) => ({ templates: [{ name: 'Séance A', focus: 'Bas du corps', exercises }] });
const INTER = base({ level: 'intermediaire', equipment: ['halteres'], session_minutes: 40 });

test('model proposal: a valid proposal is kept; missing gear swapped to its feasible substitution', () => {
  const ctx = ctxFor(INTER);
  const ok = validateModelTemplates(tpl([ex(), ex({ name: 'Pompes', pattern: 'push', equipment: [], areas: ['epaule'] }), ex({ name: 'Planche', pattern: 'core', type: 'duration', reps: undefined, duration_sec: 40, equipment: [], areas: [] })]), ctx);
  assert.equal(ok.ok, true, ok.reason);
  const swapped = validateModelTemplates(tpl([ex({ name: 'Squat barre', equipment: ['barre', 'rack'], substitution: { name: 'Squat goblet haltère', equipment: ['halteres'] } }), ex({ name: 'Pompes', pattern: 'push', equipment: [], areas: ['epaule'] }), ex({ name: 'Rowing', pattern: 'pull', areas: ['dos'] })]), ctx);
  assert.equal(swapped.ok, true, swapped.reason);
  assert.equal(swapped.templates[0].exercises[0].name, 'Squat goblet haltère');
  assert.deepEqual(swapped.templates[0].exercises[0].equipment, ['halteres']);
  assert.match(swapped.templates[0].exercises[0].note, /matériel absent/);
  const custom = validateModelTemplates(tpl([ex({ name: 'Rowing TRX', pattern: 'pull', equipment: ['TRX'], areas: ['dos'] }), ex(), ex({ name: 'Pompes', pattern: 'push', equipment: [], areas: ['epaule'] })]), ctxFor({ ...INTER, custom_equipment: ['TRX'] }));
  assert.equal(custom.ok, true, 'declared custom equipment usable');
});

test('model proposal: anything out of contract rejected as a whole (→ catalog fallback)', () => {
  const ctx = ctxFor(INTER);
  const three = (bad) => tpl([bad, ex({ name: 'Pompes', pattern: 'push', equipment: [], areas: ['epaule'] }), ex({ name: 'Rowing', pattern: 'pull', areas: ['dos'] })]);
  const cases = {
    templates_count: { templates: [] },
    exercise_count: tpl([ex()]),
    equipment_unavailable: three(ex({ equipment: ['barre'] })),
    equipment_unknown: three(ex({ equipment: ['laser'] })),
    sets_out_of_bounds: three(ex({ sets: 9 })),
    reps_out_of_bounds: three(ex({ reps: 100 })),
    rpe_out_of_bounds: three(ex({ rpe: 10 })),
    rest_out_of_bounds: three(ex({ rest_sec: 5 })),
    exercise_pattern: three(ex({ pattern: 'magic' })),
    cues_invalid: three(ex({ cues: [] })),
    'unsafe_text:continue_despite_pain': three(ex({ cues: ['Continue malgré la douleur, ça passe'] })),
    'unsafe_text:diagnosis': three(ex({ mistakes: ['Tu as une tendinite si ça tire'] })),
    too_long: tpl([ex({ sets: 4, reps: 20, rest_sec: 150 }), ex({ name: 'Ex B', sets: 4, reps: 20, rest_sec: 150 }), ex({ name: 'Ex C', sets: 4, reps: 20, rest_sec: 150 }), ex({ name: 'Ex D', sets: 4, reps: 20, rest_sec: 150 }), ex({ name: 'Ex E', sets: 4, reps: 20, rest_sec: 150 })]),
  };
  for (const [reason, raw] of Object.entries(cases)) {
    const v = validateModelTemplates(raw, ctx);
    assert.equal(v.ok, false, reason);
    assert.equal(v.reason, reason);
  }
  const painCtx = ctxFor({ ...INTER, pain: { present: true, areas: ['genou'], intensity: 2 } });
  assert.equal(validateModelTemplates(three(ex()), painCtx).reason, 'excluded_area');
  assert.equal(validateModelTemplates('pas un objet', ctx).ok, false);
});

test('youth context (enfant register or minor): RPE ≤ 7, no advanced lifts, even for an experienced profile', () => {
  const raw = base({ level: 'experimente', goal: 'force', locations: ['salle'], equipment: ['barre', 'rack', 'halteres', 'banc'], session_minutes: 60 });
  for (const [p, label] of [[build(raw, 'enfant'), 'enfant register'], [build({ ...raw, age: 15 }, 'standard'), 'age 15']]) {
    assert.equal(p.ctx.youth, true, label);
    assertProgramInvariants(p);
    assert.ok(allExercises(p.sessions).every(e => e.rpe <= 7 && EXERCISE_BY_ID[e.id].complexity !== 'advanced'), label);
  }
  assert.equal(validateModelTemplates(tpl([ex({ rpe: 9 }), ex(), ex()]), ctxFor(raw, 'enfant')).reason, 'rpe_out_of_bounds');
  assert.equal(build(raw, 'expert').ctx.youth, false);
});

test('safety scan: unsafe coaching sentences caught, normal coaching untouched', () => {
  for (const bad of ['Continue malgré la douleur.', 'Ignore la douleur et termine la série', 'No pain no gain !', 'Tu as une entorse, rien de grave', 'Prends un anti-inflammatoire avant la séance', 'Pas besoin de consulter un médecin', 'Voici ton programme de rééducation', 'La douleur est normale']) {
    assert.ok(sportSafetyScan(bad), bad);
  }
  for (const ok of ['Arrête l’exercice si une douleur apparaît.', 'Les courbatures sont normales le lendemain.', 'Garde le dos droit.', 'En cas de douleur qui persiste, demande l’avis d’un professionnel de santé.']) {
    assert.equal(sportSafetyScan(ok), null, ok);
  }
});

test('workout practice spec: self-report checklist covering warm-up, every exercise, cool-down', () => {
  const p = build(base());
  const spec = workoutPracticeSpec(p.sessions[0]);
  assert.equal(spec.kind, 'workout');
  assert.equal(spec.checklist.length, p.sessions[0].exercises.length + 2);
  assert.match(spec.checklist[0], /Échauffement/);
  assert.match(spec.checklist.at(-1), /Retour au calme/);
});

// ═══ routes ═══════════════════════════════════════════════════════════════════════════════════════════════════════
const model = { program: null, lesson: null, fail: false, prompts: [] };
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    model.prompts.push(p);
    if (model.fail) throw Object.assign(new Error('ollama down'), { code: 'ECONNREFUSED' });
    if (p.includes('modèles de séance')) return { message: { content: model.program ?? 'pas de JSON' } };
    if (p.includes('Explique la séance suivante')) return { message: { content: model.lesson ?? 'Leçon de séance : objectif, technique, RPE.\n\nQuestion : que signifie RPE 6 ?' } };
    if (p.includes('évalue la partie THÉORIE')) return { message: { content: JSON.stringify({ passed: true, score: 90, criteria: [{ name: 'RPE', met: true }], feedback: 'Bien.' }) } };
    return { message: { content: 'ok' } };
  },
};
const app = new Hono();
app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));
const call = async (method, p, body) => {
  const r = await app.request(`/api${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
};
const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error(`network forbidden: ${url}`); };
test.after(() => { globalThis.fetch = realFetch; });

test('route: options expose the closed vocabularies', async () => {
  const o = (await call('GET', '/teacher/sport/options')).body;
  assert.ok(o.goals.includes('hypertrophie') && o.levels.length === 3 && o.equipment.includes('kettlebell') && o.labels.goals.force === 'Force');
});

test('route: create (catalog fallback on invalid model output) → start → workout modules, SELF_REPORTED only', async () => {
  model.program = 'je ne sais pas faire du JSON';
  const created = await call('POST', '/teacher/sport/paths', { register: 'debutant', profile: base() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.program_source, 'catalog');
  assert.equal(created.body.fallback_reason, 'not_json');
  const { path } = created.body;
  assert.deepEqual([path.mode, path.schema_version, path.register], ['sport', 2, 'debutant']);
  assert.equal(path.profile.program.sessions.length, 8);
  assert.equal(path.plan.length, 8);
  assert.equal((await call('PUT', `/teacher/paths/${path.id}/plan`, { plan: [{ title: 'x' }] })).body.code, 'SPORT_PLAN_LOCKED');
  const list = (await call('GET', '/teacher/paths')).body.paths.find(p => p.id === path.id);
  assert.equal(list.profile.program.sessions, undefined, 'list stays light');
  assert.equal(list.profile.program.session_count, 8);

  const started = await call('POST', `/teacher/paths/${path.id}/start`);
  const s0 = started.body.steps[0];
  assert.equal(s0.tracks.practice.spec.kind, 'workout');
  assert.equal(s0.tracks.practice.spec.generated, true);
  assert.equal(s0.tracks.practice.spec.workout.week, 1);
  assert.equal((await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/practice/spec`)).body.cached, true, 'never replaced by a model exercise');
  const deliverable = await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/practice/submit`, { mode: 'deliverable', submission: 'j’ai fait la séance' });
  assert.equal(deliverable.body.code, 'PRACTICE_MODE_NOT_ALLOWED', 'no fake "assessment" of a physical session');
  const lesson = await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/explain`);
  assert.equal(lesson.body.lesson_source, 'model');
  assert.ok(model.prompts.at(-1).includes(teacherRegisterInstruction('debutant')));
  await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/theory/answer`, { answer: 'effort modéré' });
  // PROF-6 contract: a workout declaration must carry a session check-in
  const noCheckin = await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: s0.tracks.practice.spec.checklist.map(() => true) });
  assert.equal(noCheckin.status, 400);
  assert.equal(noCheckin.body.code, 'SPORT_CHECKIN_INVALID');
  const checkin = { completed: true, rpe: 6, unusual_pain: false, technique_confidence: 4, energy: 4 };
  const done = await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/practice/submit`, { mode: 'self_report', confirmations: s0.tracks.practice.spec.checklist.map(() => true), checkin });
  assert.equal(done.body.can_advance, true);
  assert.equal(done.body.steps[0].tracks.practice.evidence, 'SELF_REPORTED');
  assert.equal((await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/advance`)).status, 200);
});

test('route: a valid model proposal is used (source model); provider failure → catalog program, still created', async () => {
  model.program = JSON.stringify(tpl([ex({ equipment: [], name: 'Squat', areas: ['genou'] }), ex({ name: 'Pompes', pattern: 'push', equipment: [], areas: ['epaule'] }), ex({ name: 'Superman', pattern: 'pull', equipment: [], areas: ['dos'] })]));
  const viaModel = await call('POST', '/teacher/sport/paths', { register: 'standard', profile: base({ level: 'intermediaire', session_minutes: 40 }) });
  assert.equal(viaModel.status, 201);
  assert.equal(viaModel.body.program_source, 'model');
  assert.equal(viaModel.body.path.profile.program.sessions[0].exercises[0].name, 'Squat');
  model.fail = true;
  const viaCatalog = await call('POST', '/teacher/sport/paths', { profile: base() });
  model.fail = false;
  assert.equal(viaCatalog.status, 201);
  assert.deepEqual([viaCatalog.body.program_source, viaCatalog.body.fallback_reason], ['catalog', 'provider_unavailable']);
});

test('route: invalid profile 400 with field errors; high pain 422 with professional advice; nothing created', async () => {
  const before = (await call('GET', '/teacher/paths')).body.paths.length;
  const bad = await call('POST', '/teacher/sport/paths', { profile: base({ sessions_per_week: 9, age: 500 }) });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map(e => e.field).sort(), ['age', 'sessions_per_week']);
  const pain = await call('POST', '/teacher/sport/paths', { profile: base({ pain: { present: true, areas: ['dos'], intensity: 8 } }) });
  assert.equal(pain.status, 422);
  assert.equal(pain.body.code, 'SPORT_PAIN_STOP');
  assert.equal((await call('POST', '/teacher/sport/paths', { profile: 'x' })).status, 400);
  assert.equal((await call('GET', '/teacher/paths')).body.paths.length, before);
});

test('route: an unsafe model lesson is never stored; deterministic lesson instead', async () => {
  model.program = null;
  const { path } = (await call('POST', '/teacher/sport/paths', { profile: base() })).body;
  const s0 = (await call('POST', `/teacher/paths/${path.id}/start`)).body.steps[0];
  model.lesson = 'Si ton genou fait mal, continue malgré la douleur, tu as sûrement une tendinite.';
  const lesson = await call('POST', `/teacher/paths/${path.id}/steps/${s0.id}/explain`);
  model.lesson = null;
  assert.equal(lesson.body.lesson_source, 'catalog_unsafe_model_output');
  assert.equal(sportSafetyScan(lesson.body.step.content), null);
  assert.match(lesson.body.step.content, /RPE/);
});

for (const register of TEACHER_REGISTERS) {
  test(`route: register ${register} — program prompt uses it; youth caps only for enfant`, async () => {
    model.program = null;
    const r = await call('POST', '/teacher/sport/paths', { register, profile: base({ level: 'experimente', goal: 'force', locations: ['salle'], equipment: ['barre', 'rack'], session_minutes: 60 }) });
    assert.equal(r.status, 201);
    assert.ok(model.prompts.at(-1).includes(teacherRegisterInstruction(register)));
    assert.equal(r.body.path.register, register);
    const program = r.body.path.profile.program;
    assert.equal(program.youth, register === 'enfant');
    const rpes = program.sessions.flatMap(s => s.exercises.map(e => e.rpe));
    if (register === 'enfant') assert.ok(Math.max(...rpes) <= 7);
    else assert.ok(Math.max(...rpes) > 7, 'adult experienced: full range');
  });
}

test('Strict Local: Sport Coach made zero network calls', () => {
  assert.equal(fetchCalls.length, 0);
});

test('catalog sanity: ids unique, variants and substitutes point to real exercises', () => {
  const ids = EXERCISES.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of EXERCISES) for (const ref of [e.easier, e.harder, ...e.substitutes].filter(Boolean)) assert.ok(EXERCISE_BY_ID[ref], `${e.id} → ${ref}`);
  for (const e of EXERCISES) assert.equal(sportSafetyScan(JSON.stringify(e)), null);
});
