import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
// Professeur V2 (PROF-6) — Sport Coach adaptation loop: check-in validation, trend rules (one bad session = observation),
// bounded adjustments with readable reasons, pain (spare → pause → professional → explicit gentle resume), equipment,
// technique regressions/progressions, fail-closed on unsafe model output and out-of-bounds sessions, persistence
// (reload + real restart), malformed stored data, every register. In-memory SQLite + temp file DB; scripted model.
// Run: node --test test-teacher-sport-adaptation.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { initSqlite, setRouterSettings, getLearningPathById, updateLearningPath, getTrackAttempts } from './src/lib/sqlite.js';
import { createTeacherRoute } from './src/routes/teacher.js';
import { validateSportProfile, screenSportProfile } from './src/lib/sport-profile.js';
import { sportContext, catalogTemplates, expandProgram, sportSafetyScan, estimateMinutes } from './src/lib/sport-program.js';
import { validateCheckin, decideAdaptation, adaptSession, sessionViolations, sessionTargetRpe, programContext } from './src/lib/sport-adaptation.js';
import { EXERCISE_BY_ID } from './src/lib/sport-catalog.js';
import { TEACHER_REGISTERS } from './src/lib/teacher-register.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-prof6-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
initSqlite(':memory:');
setRouterSettings({ strict_local_mode: true, chat_model: 'fake-prof6' });

const baseProfile = (extra = {}) => ({ goal: 'remise_en_forme', level: 'intermediaire', locations: ['maison'], equipment: ['halteres'], sessions_per_week: 2, session_minutes: 40, days: ['lundi', 'jeudi'], ...extra });
const OK = { completed: true, rpe: 6, unusual_pain: false, technique_confidence: 4, energy: 4 };
const ci = (extra = {}) => ({ ...OK, ...extra });

function programFor(raw = baseProfile(), youth = false) {
  const profile = validateSportProfile(raw).profile;
  const screen = screenSportProfile(profile);
  const ctx = sportContext(profile, { excludedAreas: screen.excludedAreas, youth });
  return { profile, ctx, sessions: expandProgram(catalogTemplates(ctx), ctx) };
}
const entry = (checkin, session) => ({ checkin: validateCheckin(checkin).checkin, target_rpe: sessionTargetRpe(session) });

// ═══ check-in ═════════════════════════════════════════════════════════════════════════════════════════════════════
test('check-in: boundaries accepted (RPE 1/10, energy & technique 1/5), everything else rejected', () => {
  for (const ok of [ci({ rpe: 1 }), ci({ rpe: 10 }), ci({ energy: 1, technique_confidence: 5 }), ci({ energy: 5, technique_confidence: 1 }),
    ci({ completed: false, rpe: null }), ci({ unusual_pain: true, pain_areas: ['dos'], pain_worsening: true }), ci({ unavailable_equipment: ['halteres'], comment: 'ok' })]) {
    assert.equal(validateCheckin(ok).ok, true, JSON.stringify(ok));
  }
  const bad = [
    [undefined, 'checkin'], [ci({ rpe: 0 }), 'rpe'], [ci({ rpe: 11 }), 'rpe'], [ci({ rpe: 6.5 }), 'rpe'], [ci({ rpe: '7' }), 'rpe'],
    [ci({ energy: 0 }), 'energy'], [ci({ energy: 6 }), 'energy'], [ci({ technique_confidence: 9 }), 'technique_confidence'],
    [{ ...OK, completed: undefined }, 'completed'], [ci({ unusual_pain: 'oui' }), 'unusual_pain'], [ci({ unusual_pain: true }), 'pain_areas'],
    [ci({ unusual_pain: true, pain_areas: ['rate'] }), 'pain_areas'], [ci({ comment: 'x'.repeat(501) }), 'comment'], [ci({ unavailable_equipment: 'halteres' }), 'unavailable_equipment'],
  ];
  for (const [raw, field] of bad) {
    const v = validateCheckin(raw);
    assert.equal(v.ok, false, JSON.stringify(raw));
    assert.ok(v.errors.some(e => e.field === field), `${field} in ${JSON.stringify(v.errors)}`);
  }
});

// ═══ rules ════════════════════════════════════════════════════════════════════════════════════════════════════════
test('rules: normal session → nothing; ONE easy / hard / missed / tired session → observation only', () => {
  const { sessions } = programFor();
  const s = sessions[0];
  const t = sessionTargetRpe(s);
  assert.equal(decideAdaptation({ entries: [entry(ci({ rpe: t }), s)] }).kind, 'none');
  for (const c of [ci({ rpe: Math.min(10, t + 3) }), ci({ rpe: Math.max(1, t - 3) }), ci({ completed: false, rpe: null }), ci({ energy: 1 }), ci({ technique_confidence: 1 })]) {
    const d = decideAdaptation({ entries: [entry(c, s)] });
    assert.equal(d.kind, 'observe', JSON.stringify(c));
    assert.match(d.reason, /Une seule séance ne suffit pas/);
  }
});

test('rules: trends over two sessions → bounded adjustment with a readable reason', () => {
  const { sessions } = programFor();
  const s = sessions[0];
  const t = sessionTargetRpe(s);
  const two = (c) => decideAdaptation({ entries: [entry(c, s), entry(c, s)] });
  assert.equal(two(ci({ rpe: Math.min(10, t + 2) })).rule, 'hard_reduce');
  assert.equal(two(ci({ completed: false, rpe: null })).rule, 'missed_reduce');
  assert.equal(two(ci({ energy: 2 })).rule, 'energy_reduce');
  assert.equal(two(ci({ technique_confidence: 2 })).rule, 'technique_regress');
  assert.equal(two(ci({ rpe: t - 2, technique_confidence: 4 })).rule, 'easy_progress');
  assert.equal(two(ci({ rpe: t - 2, technique_confidence: 5 })).rule, 'easy_progress_harder');
  assert.equal(two(ci({ rpe: t - 2, technique_confidence: 3 })).kind, 'observe', 'easy but shaky technique: no progression');
  for (const c of [ci({ rpe: Math.min(10, t + 2) }), ci({ energy: 2 })]) assert.ok(two(c).reason.length > 20);
});

test('rules: pain first — spare + reduce; repeated or worsening pain → pause + professional; never "continue"', () => {
  const { sessions } = programFor();
  const s = sessions[0];
  const once = decideAdaptation({ entries: [entry(ci({ unusual_pain: true, pain_areas: ['epaule'] }), s)] });
  assert.equal(once.rule, 'pain_reduce');
  assert.match(once.reason, /professionnel de santé/);
  const worse = decideAdaptation({ entries: [entry(ci({ unusual_pain: true, pain_areas: ['dos'], pain_worsening: true }), s)] });
  assert.equal(worse.kind, 'pause');
  const again = decideAdaptation({ entries: [entry(ci({ unusual_pain: true, pain_areas: ['dos'] }), s)], previousPain: true });
  assert.equal(again.kind, 'pause');
  assert.match(again.reason, /professionnel de santé/);
  for (const d of [once, worse, again]) assert.equal(sportSafetyScan(d.reason), null, 'no unsafe advice in our own texts');
  assert.equal(decideAdaptation({ entries: [entry(ci({ unusual_pain: true, pain_areas: ['dos'] }), s), entry(ci({ rpe: 1 }), s)] }).kind, 'observe', 'pain priority applies to the latest check-in');
});

// ═══ transforms ═══════════════════════════════════════════════════════════════════════════════════════════════════
test('adjustments stay within level bounds and the time budget; changes listed', () => {
  const { sessions, ctx } = programFor();
  const s = sessions[2];
  for (const rule of ['hard_reduce', 'missed_reduce', 'energy_reduce', 'easy_progress', 'resume']) {
    const r = adaptSession(s, { rule }, ctx);
    assert.ok(r, rule);
    assert.deepEqual(sessionViolations(r.session, ctx), [], rule);
    assert.ok(r.session.estimated_minutes <= Math.max(ctx.minutes, s.estimated_minutes), `${rule}: time`);
    for (const ch of r.changes) if (typeof ch.from === 'number') assert.ok(Math.abs(ch.to - ch.from) <= 120, `${rule}: bounded step ${JSON.stringify(ch)}`);
  }
  const hard = adaptSession(s, { rule: 'hard_reduce' }, ctx);
  assert.ok(hard.session.exercises.every((e, i) => e.rpe <= s.exercises[i].rpe && e.rest_sec >= s.exercises[i].rest_sec));
  assert.ok(hard.changes.some(c => c.field === 'rpe'));
});

test('excessive progression attempt: 50 "easy" adjustments in a row never exceed the level / youth caps or the budget', () => {
  for (const [raw, youth] of [[baseProfile(), false], [baseProfile({ level: 'debutant' }), false], [baseProfile({ level: 'experimente', locations: ['salle'], equipment: ['barre', 'rack', 'halteres', 'banc'], session_minutes: 60 }), true]]) {
    const { sessions, ctx } = programFor(raw, youth);
    let s = sessions[0];
    for (let i = 0; i < 50; i++) {
      const r = adaptSession(s, { rule: i % 2 ? 'easy_progress' : 'easy_progress_harder' }, ctx);
      assert.ok(r);
      s = r.session;
    }
    assert.deepEqual(sessionViolations(s, ctx), []);
    assert.ok(s.exercises.every(e => e.rpe <= ctx.bounds.rpe[1] && (e.type !== 'reps' || e.reps <= ctx.bounds.reps[1])));
    assert.ok(estimateMinutes(s) <= Math.max(ctx.minutes, sessions[0].estimated_minutes));
    assert.ok(s.exercises.every(e => !e.id || ctx.bounds.complexity.includes(EXERCISE_BY_ID[e.id].complexity)), 'harder variants only within the allowed complexity');
    if (youth) assert.ok(s.exercises.every(e => e.rpe <= 7));
  }
});

test('fail closed: an adapted session that would break a bound is never delivered', () => {
  const { sessions, ctx } = programFor(baseProfile({ level: 'debutant' }));
  const broken = { ...sessions[0], exercises: sessions[0].exercises.map(e => ({ ...e, rpe: 10 })) };
  assert.equal(adaptSession(broken, { rule: 'missed_reduce' }, ctx), null);
});

test('pain area spared, equipment substituted, technique regression / progression by variants', () => {
  const p = programFor(baseProfile({ goal: 'force' }));
  const painCtx = { ...p.ctx, excludedAreas: ['genou', 'hanche'] };
  const spared = adaptSession(p.sessions[0], { rule: 'pain_reduce' }, painCtx);
  assert.ok(spared.session.exercises.every(e => !e.areas.some(a => ['genou', 'hanche'].includes(a))));
  assert.ok(spared.session.exercises.length >= p.ctx.bounds.exercises[0], 'still a complete session');
  const noDumbbells = programContext({ ...p.profile }, { unavailable_equipment: ['halteres'], excluded_areas: [] });
  const swapped = adaptSession(p.sessions[0], { rule: 'equipment_unavailable' }, noDumbbells);
  assert.ok(swapped.session.exercises.every(e => !e.equipment.includes('halteres')));
  assert.ok(swapped.changes.some(c => c.field === 'exercise' || c.field === 'removed'));
  const easier = adaptSession(p.sessions[0], { rule: 'technique_regress' }, p.ctx);
  assert.ok(easier.changes.some(c => c.field === 'exercise'), 'easier variants swapped in');
  const harder = adaptSession(p.sessions[0], { rule: 'easy_progress_harder' }, p.ctx);
  assert.ok(harder.changes.filter(c => c.field === 'exercise').length <= 1, 'one exercise at a time');
});

// ═══ routes ═══════════════════════════════════════════════════════════════════════════════════════════════════════
const model = { verdict: null };
const ollamaClient = {
  chat: async ({ messages }) => {
    const p = messages.map(m => m.content).join('\n');
    if (p.includes('modèles de séance')) return { message: { content: 'non' } };
    if (p.includes('Explique la séance suivante')) return { message: { content: 'Leçon. Question : RPE ?' } };
    if (p.includes('évalue la partie THÉORIE')) return { message: { content: model.verdict ?? JSON.stringify({ passed: true, score: 90, criteria: [{ name: 'RPE', met: true }], feedback: 'Bien.' }) } };
    return { message: { content: 'ok' } };
  },
};
const makeApp = () => { const a = new Hono(); a.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null })); return a; };
const app = makeApp();
const call = async (method, p, body, on = app) => {
  const r = await on.request(`/api${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
};
const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error(`network forbidden: ${url}`); };
test.after(() => { globalThis.fetch = realFetch; });

async function startSport(profile = baseProfile(), register = 'standard') {
  const created = await call('POST', '/teacher/sport/paths', { register, profile });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await call('POST', `/teacher/paths/${created.body.path.id}/start`);
  return { id: created.body.path.id, steps: started.body.steps };
}
const program = (id) => getLearningPathById(id).profile.program;
const stepAt = async (id, i) => (await call('GET', `/teacher/paths/${id}`)).body.steps.find(s => s.step_index === i);
async function doSession(id, i, checkin, { allChecked = true } = {}) {
  const s = await stepAt(id, i);
  if (s.tracks.theory.state !== 'PASSED') await call('POST', `/teacher/paths/${id}/steps/${s.id}/theory/answer`, { answer: 'effort modéré' });
  const n = s.tracks.practice.spec.checklist.length;
  return call('POST', `/teacher/paths/${id}/steps/${s.id}/practice/submit`, { mode: 'self_report', confirmations: Array.from({ length: n }, (_, k) => allChecked || k === 0), checkin });
}
const advance = async (id, i) => call('POST', `/teacher/paths/${id}/steps/${(await stepAt(id, i)).id}/advance`);

test('route: invalid check-in refused (400), nothing recorded', async () => {
  const { id, steps } = await startSport();
  const r = await call('POST', `/teacher/paths/${id}/steps/${steps[0].id}/practice/submit`, { mode: 'self_report', confirmations: steps[0].tracks.practice.spec.checklist.map(() => true), checkin: ci({ rpe: 42 }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'SPORT_CHECKIN_INVALID');
  assert.equal(getTrackAttempts(steps[0].id, 'practice').length, 0);
});

test('route: normal → nothing; single hard → observation; second hard → future sessions reduced, past untouched, reason shown', async () => {
  const { id } = await startSport();
  const before = structuredClone(program(id).sessions);
  const t0 = sessionTargetRpe(before[0]);
  const r0 = await doSession(id, 0, ci({ rpe: t0 }));
  assert.equal(r0.body.sport.decision.kind, 'none');
  assert.deepEqual(program(id).sessions, before);
  await advance(id, 0);
  const r1 = await doSession(id, 1, ci({ rpe: Math.min(10, sessionTargetRpe(before[1]) + 3) }));
  assert.equal(r1.body.sport.decision.kind, 'observe');
  assert.deepEqual(program(id).sessions, before, 'one bad session changes nothing');
  await advance(id, 1);
  const r2 = await doSession(id, 2, ci({ rpe: Math.min(10, sessionTargetRpe(before[2]) + 3) }));
  assert.equal(r2.body.sport.decision.rule, 'hard_reduce');
  assert.ok(r2.body.sport.adaptation.reason.includes('plus dures'));
  assert.ok(r2.body.sport.adaptation.summary.length > 0);
  const after = program(id).sessions;
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3), 'past and current sessions untouched');
  assert.ok(after.slice(3).every((s, k) => s.exercises.every((e, j) => e.rpe <= before[3 + k].exercises[j].rpe)), 'future sessions lighter');
  const s3 = await stepAt(id, 3);
  assert.deepEqual(s3.tracks.practice.spec.workout, after[3], 'module spec follows the adapted session');
  const fresh = makeApp();
  const reloaded = (await call('GET', `/teacher/paths/${id}`, undefined, fresh)).body.path.profile.program;
  assert.deepEqual(reloaded.adaptations.map(a => a.rule), ['observe', 'hard_reduce'], 'adaptation log persisted');
});

test('route: pain → area spared in future sessions; worsening → pause, gate closed, explicit gentle resume', async () => {
  const { id } = await startSport(baseProfile({ goal: 'force' }));
  const r = await doSession(id, 0, ci({ unusual_pain: true, pain_areas: ['genou'] }));
  assert.equal(r.body.sport.decision.rule, 'pain_reduce');
  assert.ok(program(id).sessions.slice(1).every(s => s.exercises.every(e => !e.areas.includes('genou'))));
  assert.ok(program(id).excluded_areas.includes('genou'));
  await advance(id, 0);
  const worse = await doSession(id, 1, ci({ unusual_pain: true, pain_areas: ['genou'], pain_worsening: true }));
  assert.equal(worse.body.sport.decision.kind, 'pause');
  assert.match(worse.body.sport.pause.reason, /professionnel de santé/);
  const blocked = await advance(id, 1);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'SPORT_PAUSED_FOR_PAIN');
  assert.equal((await call('POST', `/teacher/paths/${id}/sport/resume`, {})).body.code, 'SPORT_RESUME_CONFIRM_REQUIRED');
  const before = structuredClone(program(id).sessions);
  const resumed = await call('POST', `/teacher/paths/${id}/sport/resume`, { no_pain: true });
  assert.equal(resumed.status, 200);
  assert.equal(program(id).pause, null);
  assert.equal(resumed.body.sport.adaptation.rule, 'resume');
  assert.ok(program(id).sessions.slice(2).every((s, k) => s.exercises.every((e, j) => !before[2 + k].exercises[j] || e.rpe <= before[2 + k].exercises[j].rpe)), 'gentler after resume');
  assert.equal((await advance(id, 1)).status, 200, 'progress allowed again');
  assert.ok(program(id).sessions.slice(2).every(s => s.exercises.every(e => !e.areas.includes('genou'))), 'the paused area stays spared after resume');
  assert.equal((await call('POST', `/teacher/paths/${id}/sport/resume`, { no_pain: true })).body.code, 'SPORT_NOT_PAUSED');
});

test('route: missed workout → practice not validated (redo), twice → lighter volume', async () => {
  const { id } = await startSport();
  const m1 = await doSession(id, 0, ci({ completed: false, rpe: null }));
  assert.equal(m1.body.verdict.passed, false);
  assert.match(m1.body.verdict.feedback, /non terminée/);
  assert.equal(m1.body.steps[0].tracks.practice.state, 'REMEDIATION');
  assert.equal(m1.body.sport.decision.kind, 'observe');
  const m2 = await doSession(id, 0, ci({ completed: false, rpe: null }));
  assert.equal(m2.body.sport.decision.rule, 'missed_reduce');
  const ok = await doSession(id, 0, ci());
  assert.equal(ok.body.steps[0].tracks.practice.state, 'PASSED', 'the session can still be done and validated');
});

test('route: equipment unavailable → future sessions use alternatives; limitation never reintroduced by a harder variant', async () => {
  const { id } = await startSport(baseProfile({ goal: 'force', limitations: { areas: ['genou'] } }));
  const r = await doSession(id, 0, ci({ unavailable_equipment: ['halteres'] }));
  assert.equal(r.body.sport.decision.rule, 'equipment_unavailable');
  assert.ok(program(id).sessions.slice(1).every(s => s.exercises.every(e => !e.equipment.includes('halteres'))));
  for (let i = 1; i <= 2; i++) { await advance(id, i - 1); await doSession(id, i, ci({ rpe: 2, technique_confidence: 5 })); }
  assert.ok(program(id).adaptations.some(a => a.rule === 'easy_progress_harder' || a.rule === 'easy_progress'));
  assert.ok(program(id).sessions.every(s => s.exercises.every(e => !e.areas.includes('genou'))), 'declared limitation still spared');
});

test('route: unsafe sport evaluation (continue despite pain / diagnosis) refused; state unchanged', async () => {
  const { id, steps } = await startSport();
  for (const feedback of ['Continue malgré la douleur, ça ira mieux.', 'Tu as une tendinite, rien de grave.']) {
    model.verdict = JSON.stringify({ passed: true, score: 95, criteria: [{ name: 'x', met: true }], feedback });
    const r = await call('POST', `/teacher/paths/${id}/steps/${steps[0].id}/theory/answer`, { answer: 'réponse' });
    assert.equal(r.body.evaluated, false);
    assert.equal(r.body.verdict.passed, false);
    assert.equal(r.body.verdict.invalid, true);
    assert.equal(r.body.steps[0].tracks.theory.state, 'ACTIVE', 'no state change');
    assert.ok(!JSON.stringify(r.body).includes(feedback), 'unsafe text never returned');
  }
  model.verdict = null;
});

test('route: client cannot push a program or an adaptation (extra fields ignored)', async () => {
  const { id, steps } = await startSport();
  const before = structuredClone(program(id).sessions);
  await call('POST', `/teacher/paths/${id}/steps/${steps[0].id}/practice/submit`, {
    mode: 'self_report', confirmations: steps[0].tracks.practice.spec.checklist.map(() => true), checkin: ci(),
    program: { sessions: [] }, adaptation: { rule: 'easy_progress', reps: 999 }, profile: { program: null },
  });
  assert.deepEqual(program(id).sessions, before);
  assert.equal((await call('PUT', `/teacher/paths/${id}/plan`, { plan: [{ title: 'x' }] })).status, 409);
});

test('route: malformed stored adaptation data never breaks the loop', async () => {
  const { id } = await startSport();
  const p = getLearningPathById(id);
  updateLearningPath(id, { profile: { ...p.profile, program: { ...p.profile.program, adaptations: 'garbage', adaptation_cursor: 'x' } } });
  const r = await doSession(id, 0, ci({ unusual_pain: true, pain_areas: ['dos'] }));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(program(id).adaptations));
  assert.equal(program(id).adaptations.at(-1).rule, 'pain_reduce');
});

test('route: completed program — every session done, path completed, log kept', async () => {
  const { id } = await startSport(baseProfile({ sessions_per_week: 2, weeks: 2 }));
  for (let i = 0; i < 4; i++) {
    await doSession(id, i, ci());
    const a = await advance(id, i);
    assert.equal(a.status, 200);
    if (i === 3) assert.equal(a.body.finished, true);
  }
  assert.equal(getLearningPathById(id).status, 'completed');
});

for (const register of TEACHER_REGISTERS) {
  test(`register ${register}: adaptation identical rules; youth caps kept for enfant`, async () => {
    const { id } = await startSport(baseProfile({ level: 'experimente', locations: ['salle'], equipment: ['barre', 'rack', 'halteres', 'banc'], session_minutes: 60 }), register);
    for (let i = 0; i < 2; i++) { if (i) await advance(id, i - 1); await doSession(id, i, ci({ rpe: 1, technique_confidence: 5 })); }
    const prog = program(id);
    assert.ok(prog.adaptations.some(a => a.rule.startsWith('easy_progress')));
    const ctx = programContext(getLearningPathById(id).profile.athlete, prog);
    for (const s of prog.sessions) assert.deepEqual(sessionViolations(s, ctx), []);
    if (register === 'enfant') assert.ok(prog.sessions.every(s => s.exercises.every(e => e.rpe <= 7)));
  });
}

test('Strict Local: the adaptation loop made zero network calls', () => { assert.equal(fetchCalls.length, 0); });

// ═══ real restart ══════════════════════════════════════════════════════════════════════════════════════════════════
const lib = (f) => pathToFileURL(path.join(HERE, 'src', 'lib', f)).href;
const routes = (f) => pathToFileURL(path.join(HERE, 'src', 'routes', f)).href;
function runProcess(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import '${pathToFileURL(path.join(HERE, 'test-setup.mjs')).href}';\n${code}`], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr.slice(-1500)}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop());
}
const PRELUDE = (file) => `
  import { Hono } from 'hono';
  import { initSqlite, setRouterSettings } from '${lib('sqlite.js')}';
  import { createTeacherRoute } from '${routes('teacher.js')}';
  initSqlite(${JSON.stringify(file)});
  setRouterSettings({ strict_local_mode: true, chat_model: 'fake' });
  const ollamaClient = { chat: async ({ messages }) => { const p = messages.map(m => m.content).join('\\n');
    if (/évalue la partie/.test(p)) return { message: { content: '{"passed":true,"score":90,"criteria":[{"name":"c","met":true}],"feedback":"ok"}' } };
    return { message: { content: 'non' } }; } };
  const app = new Hono(); app.route('/api', createTeacherRoute({ services: {}, ollamaClient, logger: null }));
  const call = async (method, p, body) => { const r = await app.request('/api' + p, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };`;

test('restart: pause, adaptations, adapted sessions and check-in history survive a process restart', () => {
  const file = path.join(tmp, 'prof6-restart.sqlite');
  const first = runProcess(`${PRELUDE(file)}
    const created = await call('POST', '/teacher/sport/paths', { profile: ${JSON.stringify(baseProfile())} });
    const id = created.body.path.id;
    const s0 = (await call('POST', '/teacher/paths/' + id + '/start')).body.steps[0];
    await call('POST', '/teacher/paths/' + id + '/steps/' + s0.id + '/theory/answer', { answer: 'x' });
    const r = await call('POST', '/teacher/paths/' + id + '/steps/' + s0.id + '/practice/submit', { mode: 'self_report', confirmations: s0.tracks.practice.spec.checklist.map(() => true), checkin: { completed: true, rpe: 6, unusual_pain: true, pain_areas: ['dos'], pain_worsening: true, technique_confidence: 3, energy: 3 } });
    const got = await call('GET', '/teacher/paths/' + id);
    console.log(JSON.stringify({ id, stepId: s0.id, program: got.body.path.profile.program, decision: r.body.sport.decision }));`);
  assert.equal(first.decision.kind, 'pause');
  const second = runProcess(`${PRELUDE(file)}
    const got = await call('GET', '/teacher/paths/${first.id}');
    const attempts = await call('GET', '/teacher/paths/${first.id}/steps/${first.stepId}/attempts');
    const gate = await call('POST', '/teacher/paths/${first.id}/steps/${first.stepId}/advance');
    console.log(JSON.stringify({ program: got.body.path.profile.program, attempts: attempts.body.attempts, gate: gate.body.code }));`);
  assert.deepEqual(second.program, first.program, 'program (pause, adaptations, sessions) identical after restart');
  assert.equal(second.gate, 'SPORT_PAUSED_FOR_PAIN', 'still paused after restart');
  assert.deepEqual(second.attempts.find(a => a.track === 'practice').payload.checkin.pain_areas, ['dos'], 'check-in history readable after restart');
});

test('route: a NEW area reported with worsening pain (pause) is spared after the gentle resume', async () => {
  const { id } = await startSport(baseProfile({ goal: 'force' }));
  assert.ok(program(id).sessions.slice(1).some(s => s.exercises.some(e => e.areas.includes('dos'))), 'fixture: some future exercise loads the back');
  const r = await doSession(id, 0, ci({ unusual_pain: true, pain_areas: ['dos'], pain_worsening: true }));
  assert.equal(r.body.sport.decision.kind, 'pause');
  await call('POST', `/teacher/paths/${id}/sport/resume`, { no_pain: true });
  assert.ok(program(id).sessions.slice(1).every(s => s.exercises.every(e => !e.areas.includes('dos'))), 'back spared in every future session');
  const ctx = programContext(getLearningPathById(id).profile.athlete, program(id));
  for (const s of program(id).sessions.slice(1)) assert.deepEqual(sessionViolations(s, ctx), []);
});
