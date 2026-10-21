// [GAME-5] Synapse Run — touch input, pause reasons, local progression, missions, save session and the
// foundation.js save bridge. Deterministic, synthetic data, no DOM/WebGL/IndexedDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LANE_CHANGE_TICKS, checksum, createSim, stepSim } from '../src/arcade/synapse-run/simulation.ts';
import { STEP_MS, createFixedStepper } from '../src/arcade/synapse-run/loop.ts';
import { BUTTON_COMMANDS, actionForKey, commandForButton } from '../src/arcade/synapse-run/input.ts';
import { SWIPE_MAX_DURATION_MS, SWIPE_MIN_DISTANCE_PX, createSwipeDetector, swipeCommand } from '../src/arcade/synapse-run/gestures.ts';
import { createPauseState } from '../src/arcade/synapse-run/pause.ts';
import {
  MAX_COUNTER, MAX_HELD_RUNS, MISSIONS, SYNAPSE_RUN_SAVE_VERSION, createSaveSession, defaultProfile, missionProgress,
  serializeProfile, settleCompletedRun, validateProfile,
} from '../src/arcade/synapse-run/progression.ts';
import { ARCADE_SAVE_MAX_BYTES, createArcadeSaveStore, measureArcadeSaveData } from '../src/lib/arcade/saves.ts';
import { getArcadeGame } from '../src/lib/arcade/registry.ts';

const key = (code, extra = {}) => actionForKey({ code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
const p = (pointerId, x, y, t) => ({ pointerId, x, y, t });

// ── input ───────────────────────────────────────────────────────────────────────────────────────────────
test('keyboard mapping unchanged + pause shortcut; repeat and chords ignored', () => {
  assert.deepEqual(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD', 'ArrowUp', 'KeyW', 'Space', 'ArrowDown', 'KeyS', 'Enter'].map(c => key(c)), ['LEFT', 'LEFT', 'RIGHT', 'RIGHT', 'JUMP', 'JUMP', 'JUMP', 'SLIDE', 'SLIDE', 'CONFIRM']);
  assert.deepEqual([key('Escape'), key('KeyP')], ['PAUSE', 'PAUSE']);
  assert.equal(key('KeyP', { repeat: true }), null);
  assert.equal(key('Escape', { ctrlKey: true }), null);
});

test('swipes: four directions, threshold, dominant axis, exact diagonal', () => {
  assert.deepEqual([swipeCommand(-40, 0), swipeCommand(40, 0), swipeCommand(0, -40), swipeCommand(0, 40)], ['LEFT', 'RIGHT', 'JUMP', 'SLIDE']);
  assert.equal(swipeCommand(SWIPE_MIN_DISTANCE_PX - 1, 10), null, 'tiny movement ignored');
  assert.equal(swipeCommand(0, 0), null);
  assert.equal(swipeCommand(50, -30), 'RIGHT', 'dominant horizontal');
  assert.equal(swipeCommand(-20, 45), 'SLIDE', 'dominant vertical');
  assert.equal(swipeCommand(-40, -40), 'LEFT', 'exact diagonal → horizontal (deterministic)');
  assert.equal(swipeCommand(NaN, 40), null);
});

test('one gesture = at most one command; only the first pointer; slow gestures ignored', () => {
  const d = createSwipeDetector();
  d.down(p(1, 100, 100, 0));
  assert.equal(d.move(p(1, 110, 100, 10)), null);
  assert.equal(d.move(p(1, 60, 100, 40)), 'LEFT');
  assert.equal(d.move(p(1, 10, 100, 60)), null, 'no second command from the same gesture');
  assert.equal(d.up(p(1, 0, 40, 80)), null);
  // multi-touch: a second finger neither starts nor ends nor redirects the gesture
  d.down(p(1, 100, 100, 100));
  d.down(p(2, 300, 300, 105));
  assert.equal(d.move(p(2, 300, 200, 110)), null);
  assert.equal(d.up(p(2, 300, 100, 120)), null);
  assert.equal(d.tracking, true);
  assert.equal(d.up(p(1, 100, 160, 130)), 'SLIDE', 'command at release');
  // slow gesture
  d.down(p(3, 0, 0, 1000));
  assert.equal(d.up(p(3, 80, 0, 1000 + SWIPE_MAX_DURATION_MS + 1)), null);
  // cancel
  d.down(p(4, 0, 0, 2000)); d.cancel(4);
  assert.equal(d.tracking, false);
  assert.equal(d.up(p(4, 80, 0, 2010)), null);
});

test('on-screen buttons map to the same four commands, nothing else', () => {
  assert.deepEqual(['left', 'right', 'jump', 'slide'].map(commandForButton), ['LEFT', 'RIGHT', 'JUMP', 'SLIDE']);
  for (const v of ['pause', 'START', 'toString', '__proto__', '', null, undefined]) assert.equal(commandForButton(v), null, String(v));
  assert.ok(Object.isFrozen(BUTTON_COMMANDS));
});

test('keyboard, swipe and button command sequences give the same simulation state', () => {
  const play = commandsPerTick => {
    const s = createSim(4242);
    stepSim(s, ['START']);
    for (let t = 0; t < 400; t++) stepSim(s, commandsPerTick[t] ?? []);
    return checksum(s);
  };
  const plan = { 5: 'LEFT', 20: 'JUMP', 90: 'RIGHT', 100: 'RIGHT', 160: 'SLIDE', 230: 'LEFT' };
  const fromKeys = { 5: ['ArrowLeft'], 20: ['Space'], 90: ['KeyD'], 100: ['ArrowRight'], 160: ['ArrowDown'], 230: ['KeyA'] };
  const fromSwipes = { 5: [-60, 5], 20: [3, -80], 90: [70, 10], 100: [45, -20], 160: [0, 90], 230: [-50, 49] };
  const fromButtons = { 5: 'left', 20: 'jump', 90: 'right', 100: 'right', 160: 'slide', 230: 'left' };
  const viaKeys = Object.fromEntries(Object.entries(fromKeys).map(([t, [c]]) => [t, [key(c)]]));
  const viaSwipes = Object.fromEntries(Object.entries(fromSwipes).map(([t, [dx, dy]]) => [t, [swipeCommand(dx, dy)]]));
  const viaButtons = Object.fromEntries(Object.entries(fromButtons).map(([t, b]) => [t, [commandForButton(b)]]));
  const expected = play(Object.fromEntries(Object.entries(plan).map(([t, c]) => [t, [c]])));
  assert.equal(play(viaKeys), expected);
  assert.equal(play(viaSwipes), expected);
  assert.equal(play(viaButtons), expected);
});

// ── pause ───────────────────────────────────────────────────────────────────────────────────────────────
/** The game's loop rule: ticks run only with no pause reason; the stepper is reset on every change. */
function pausedGame() {
  const pause = createPauseState();
  let ticks = 0, now = 0;
  const stepper = createFixedStepper(() => { ticks++; });
  const frame = () => { now += STEP_MS; if (!pause.paused) stepper.frame(now); };
  const sync = () => stepper.reset();
  const run = n => { for (let i = 0; i < n; i++) frame(); };
  return { pause, sync, run, wait: ms => { now += ms; }, get ticks() { return ticks; } };
}

test('PLAYER / HOST pause reasons: each freezes, neither cancels the other', () => {
  const g = pausedGame();
  g.run(10); const t0 = g.ticks; assert.ok(t0 >= 8);
  g.pause.add('PLAYER'); g.sync(); g.run(30);
  assert.equal(g.ticks, t0, 'PLAYER freezes');
  g.pause.remove('PLAYER'); g.sync(); g.run(10);
  assert.ok(g.ticks > t0, 'PLAYER resume resumes');
  const t1 = g.ticks;
  g.pause.add('HOST'); g.sync(); g.run(30);
  assert.equal(g.ticks, t1, 'HOST freezes');
  g.pause.remove('HOST'); g.sync(); g.run(10);
  assert.ok(g.ticks > t1);
  // player pauses, host pauses, host resumes → still paused
  const t2 = g.ticks;
  g.pause.add('PLAYER'); g.pause.add('HOST'); g.sync(); g.run(10);
  g.pause.remove('HOST'); g.sync(); g.run(30);
  assert.equal(g.ticks, t2, 'host resume while player paused = still paused');
  assert.deepEqual(g.pause.reasons(), ['PLAYER']);
  // host pauses again, player resumes → still paused
  g.pause.add('HOST'); g.pause.remove('PLAYER'); g.sync(); g.run(30);
  assert.equal(g.ticks, t2, 'player resume while host paused = still paused');
  g.pause.remove('HOST'); g.sync(); g.run(10);
  assert.ok(g.ticks > t2, 'all reasons cleared → resumes');
  // duplicate add / remove are no-ops
  assert.equal(g.pause.add('HOST'), true); assert.equal(g.pause.add('HOST'), false);
  assert.equal(g.pause.remove('HOST'), true); assert.equal(g.pause.remove('HOST'), false);
});

test('no accumulated dt: a long pause never produces a catch-up burst', () => {
  const g = pausedGame();
  g.run(5);
  g.pause.add('PLAYER'); g.sync();
  g.wait(60_000); g.run(10);
  const before = g.ticks;
  g.pause.remove('PLAYER'); g.sync();
  g.run(1);
  assert.equal(g.ticks - before, 0, 'first frame after resume only re-anchors time');
  g.run(1);
  assert.equal(g.ticks - before, 1);
});

test('hidden page: HIDDEN + PLAYER, so returning never resumes by itself', () => {
  const pause = createPauseState();
  pause.add('HIDDEN'); pause.add('PLAYER');
  pause.remove('HIDDEN');
  assert.equal(pause.paused, true);
  assert.deepEqual(pause.reasons(), ['PLAYER']);
});

// ── progression ─────────────────────────────────────────────────────────────────────────────────────────
const run = (distanceM, shards, score) => ({ distanceM, shards, score });

test('default profile and missions are fixed, original and small', () => {
  const d = defaultProfile();
  assert.deepEqual(d, { bestDistanceM: 0, bestScore: 0, totalRuns: 0, totalDistanceM: 0, totalShards: 0, missions: { 'run-500': { progress: 0, completed: false }, 'shards-10': { progress: 0, completed: false }, 'score-750': { progress: 0, completed: false } } });
  assert.deepEqual(MISSIONS.map(m => [m.id, m.metric, m.target]), [['run-500', 'distance', 500], ['shards-10', 'shards', 10], ['score-750', 'score', 750]]);
  assert.ok(Object.isFrozen(MISSIONS) && MISSIONS.every(Object.isFrozen));
  assert.equal(SYNAPSE_RUN_SAVE_VERSION, 1);
  assert.deepEqual(getArcadeGame('synapse-run').save, { currentVersion: 1, minSupportedVersion: 1 }, 'host policy accepts exactly v1');
});

test('validation accepts exact v1 profiles and rejects everything else', () => {
  const good = settleCompletedRun(defaultProfile(), run(520, 4, 560)).profile;
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(good))), good);
  const mutate = fn => { const x = JSON.parse(JSON.stringify(good)); fn(x); return x; };
  const bad = [
    null, [], 'x', 42, {}, mutate(x => { x.bestDistanceM = -1; }), mutate(x => { x.bestScore = 1.5; }), mutate(x => { x.totalRuns = MAX_COUNTER + 1; }),
    mutate(x => { x.totalShards = '4'; }), mutate(x => { x.extra = 1; }), mutate(x => { delete x.totalRuns; }), mutate(x => { x.missions.other = { progress: 0, completed: false }; }),
    mutate(x => { delete x.missions['run-500']; }), mutate(x => { x.missions['run-500'] = { progress: 600, completed: true }; }), mutate(x => { x.missions['run-500'].completed = 'yes'; }),
    mutate(x => { x.missions['shards-10'] = { progress: 10, completed: false }; }), mutate(x => { x.missions['shards-10'] = { progress: 3, completed: true }; }),
    mutate(x => { x.missions['score-750'].extra = true; }), mutate(x => { x.missions = []; }), mutate(x => { x.bestDistanceM = x.totalDistanceM + 1; }),
    { ...defaultProfile(), totalDistanceM: 5 }, JSON.parse('{"__proto__":{"polluted":true},"bestDistanceM":0}'), mutate(x => { x.totalRuns = Infinity; }),
  ];
  for (const data of bad) assert.equal(validateProfile(data), null, JSON.stringify(data));
  assert.equal({}.polluted, undefined);
  const input = JSON.parse(JSON.stringify(good));
  const out = validateProfile(input);
  assert.notEqual(out, input, 'a fresh object, never the untrusted one');
  assert.notEqual(out.missions, input.missions);
});

test('settlement: totals, bests (better replaces, worse does not), input untouched, saturation', () => {
  const start = defaultProfile();
  const a = settleCompletedRun(start, run(300, 6, 360));
  assert.deepEqual(start, defaultProfile(), 'input not mutated');
  assert.deepEqual([a.profile.totalRuns, a.profile.totalDistanceM, a.profile.totalShards, a.profile.bestDistanceM, a.profile.bestScore], [1, 300, 6, 300, 360]);
  assert.deepEqual(a.newRecords, { distance: true, score: true });
  const b = settleCompletedRun(a.profile, run(120, 2, 140));
  assert.deepEqual([b.profile.totalRuns, b.profile.totalDistanceM, b.profile.totalShards, b.profile.bestDistanceM, b.profile.bestScore], [2, 420, 8, 300, 360]);
  assert.deepEqual(b.newRecords, { distance: false, score: false });
  const c = settleCompletedRun(b.profile, run(301.9, 0, 301));
  assert.deepEqual([c.profile.bestDistanceM, c.profile.bestScore, c.newRecords.distance], [301, 360, true]);
  const huge = { ...defaultProfile(), totalRuns: MAX_COUNTER, totalDistanceM: MAX_COUNTER, bestDistanceM: 10 };
  const d = settleCompletedRun(huge, run(1e12, NaN, -5));
  assert.deepEqual([d.profile.totalRuns, d.profile.totalDistanceM, d.profile.totalShards, d.profile.bestScore], [MAX_COUNTER, MAX_COUNTER, 0, 0]);
  assert.ok(validateProfile(d.profile), 'saturated profile still valid');
});

test('missions M1 / M2 / M3 complete once; single-run progress never accumulates across runs', () => {
  let profile = defaultProfile();
  for (let i = 0; i < 5; i++) profile = settleCompletedRun(profile, run(450, 9, 700)).profile; // 2250 m, 45 shards in total
  assert.deepEqual(profile.missions, { 'run-500': { progress: 450, completed: false }, 'shards-10': { progress: 9, completed: false }, 'score-750': { progress: 700, completed: false } });
  let r = settleCompletedRun(profile, run(500, 3, 530));
  assert.deepEqual(r.completedMissions, ['run-500']);
  r = settleCompletedRun(r.profile, run(100, 10, 200));
  assert.deepEqual(r.completedMissions, ['shards-10']);
  r = settleCompletedRun(r.profile, run(700, 6, 760));
  assert.deepEqual(r.completedMissions, ['score-750']);
  const done = r.profile;
  assert.ok(MISSIONS.every(m => done.missions[m.id].completed && done.missions[m.id].progress === m.target));
  const again = settleCompletedRun(done, run(900, 20, 1100));
  assert.deepEqual(again.completedMissions, [], 'completed missions never complete again');
  assert.deepEqual(again.profile.missions, done.missions);
  // live in-run view: shows best of stored and current run, without touching the profile
  const live = missionProgress(defaultProfile(), run(250, 12, 370));
  assert.deepEqual(live.map(x => [x.mission.id, x.progress, x.completed]), [['run-500', 250, false], ['shards-10', 10, true], ['score-750', 370, false]]);
});

test('serialized payload is canonical, deterministic and tiny', () => {
  const profile = settleCompletedRun(settleCompletedRun(defaultProfile(), run(812, 14, 952)).profile, run(40, 1, 50)).profile;
  const a = JSON.stringify(serializeProfile(profile)), b = JSON.stringify(serializeProfile(JSON.parse(JSON.stringify(profile))));
  assert.equal(a, b);
  const measured = measureArcadeSaveData(serializeProfile(profile));
  assert.ok(measured.ok);
  const maxed = { ...defaultProfile(), bestDistanceM: MAX_COUNTER, bestScore: MAX_COUNTER, totalRuns: MAX_COUNTER, totalDistanceM: MAX_COUNTER, totalShards: MAX_COUNTER };
  for (const m of MISSIONS) maxed.missions[m.id] = { progress: m.target, completed: true };
  const worst = measureArcadeSaveData(serializeProfile(maxed)).bytes;
  assert.ok(worst < 512 && worst < ARCADE_SAVE_MAX_BYTES / 100, `worst-case payload ${worst} bytes`);
  console.log(`# progression payload: ${measured.bytes} bytes (example), ${worst} bytes (all counters at maximum); GAME-3 limit ${ARCADE_SAVE_MAX_BYTES}`);
});

// ── save session ────────────────────────────────────────────────────────────────────────────────────────
test('session: empty → default, valid → restored, one settlement per run, abandoned runs never settle', () => {
  const s = createSaveSession();
  assert.equal(s.saveStatus, 'LOADING');
  assert.equal(s.onLoad({ status: 'EMPTY' }), null);
  assert.deepEqual([s.saveStatus, s.profile], ['READY', defaultProfile()]);
  const first = s.settle(1, run(200, 3, 230));
  assert.equal(first.settled, true);
  assert.deepEqual(first.write, serializeProfile(s.profile));
  assert.deepEqual(s.settle(1, run(200, 3, 230)), { settled: false, write: null, newRecords: { distance: false, score: false }, completedMissions: [] }, 'duplicate GAME_OVER');
  assert.equal(s.settle(0, run(999, 99, 9999)).settled, false, 'an older run id (stale) cannot settle');
  assert.equal(s.profile.totalRuns, 1);
  // run 2 is abandoned (never reaches GAME_OVER → settle is never called); run 3 ends normally
  s.onWriteResult(true);
  s.settle(3, run(100, 1, 110));
  assert.equal(s.profile.totalRuns, 2, 'the abandoned run 2 counted nothing');

  const restored = createSaveSession();
  const saved = serializeProfile(s.profile);
  restored.onLoad({ status: 'FOUND', saveVersion: 1, data: JSON.parse(JSON.stringify(saved)) });
  assert.deepEqual([restored.saveStatus, restored.profile], ['READY', saved]);
});

test('session: writes coalesce (one in flight), failures are reported and never retried in a loop', () => {
  const s = createSaveSession();
  s.onLoad({ status: 'EMPTY' });
  const w1 = s.settle(1, run(100, 1, 110)).write;
  assert.ok(w1);
  assert.equal(s.writeStatus, 'WRITING');
  assert.equal(s.settle(2, run(200, 2, 220)).write, null, 'second settlement while writing: coalesced');
  assert.equal(s.settle(3, run(300, 3, 330)).write, null);
  const follow = s.onWriteResult(true);
  assert.equal(follow.totalRuns, 3, 'one follow-up write carries both settlements');
  assert.equal(s.onWriteResult(false), null, 'failed write: no automatic retry');
  assert.equal(s.writeStatus, 'FAILED');
  assert.equal(s.onWriteResult(false), null, 'stray result ignored');
  assert.equal(s.profile.totalRuns, 3, 'in-memory profile intact after a failure');
  assert.equal(s.settle(4, run(10, 0, 10)).write.totalRuns, 4, 'the next settlement writes the full profile again');
});

test('session: corrupt / newer / invalid saves are protected; unavailable storage still plays', () => {
  for (const [result, status] of [
    [{ status: 'ERROR', code: 'CORRUPT_SAVE' }, 'PROTECTED'], [{ status: 'ERROR', code: 'UNSUPPORTED_SAVE_VERSION' }, 'PROTECTED'],
    [{ status: 'FOUND', saveVersion: 1, data: { bestDistanceM: -1 } }, 'PROTECTED'], [{ status: 'FOUND', saveVersion: 2, data: serializeProfile(defaultProfile()) }, 'PROTECTED'],
    [{ status: 'ERROR', code: 'STORAGE_UNAVAILABLE' }, 'UNAVAILABLE'], [{ status: 'ERROR', code: 'STORAGE_FAILED' }, 'UNAVAILABLE'],
  ]) {
    const s = createSaveSession();
    assert.equal(s.onLoad(result), null);
    assert.equal(s.saveStatus, status, JSON.stringify(result));
    const settled = s.settle(1, run(600, 12, 800));
    assert.deepEqual([settled.settled, settled.write], [true, null], 'never writes over a protected save / to unavailable storage');
    assert.equal(s.profile.totalRuns, 1, 'the session still counts in memory');
    assert.equal(s.onLoad({ status: 'EMPTY' }), null, 'a second load result is ignored');
  }
});

test('session: runs finished before the load answers are applied once, then written', () => {
  const s = createSaveSession();
  assert.equal(s.settle(1, run(100, 2, 120)).write, null);
  assert.equal(s.settle(2, run(50, 1, 60)).write, null);
  const stored = settleCompletedRun(defaultProfile(), run(400, 5, 450)).profile;
  const write = s.onLoad({ status: 'FOUND', saveVersion: 1, data: serializeProfile(stored) });
  assert.deepEqual([write.totalRuns, write.totalDistanceM, write.bestDistanceM], [3, 550, 400]);
  for (let i = 3; i < 3 + MAX_HELD_RUNS + 5; i++) createSaveSession().settle(i, run(1, 0, 1)); // independent sessions stay bounded
});

test('session against the real GAME-3 store: write, reload, corrupt record untouched', async () => {
  const map = new Map();
  const backend = { get: async k => structuredClone(map.get(k)), update: async (k, next) => { map.set(k, structuredClone(next(map.has(k) ? structuredClone(map.get(k)) : undefined))); }, delete: async k => { map.delete(k); } };
  const store = createArcadeSaveStore({ backend, now: () => 1000 });
  const s = createSaveSession();
  s.onLoad({ status: 'EMPTY' });
  const payload = s.settle(1, run(510, 11, 760)).write;
  assert.equal((await store.write('synapse-run', SYNAPSE_RUN_SAVE_VERSION, payload)).ok, true);
  const loaded = await store.load('synapse-run');
  const again = createSaveSession();
  again.onLoad({ status: 'FOUND', saveVersion: loaded.save.saveVersion, data: loaded.save.data });
  assert.deepEqual(again.profile.missions, { 'run-500': { progress: 500, completed: true }, 'shards-10': { progress: 10, completed: true }, 'score-750': { progress: 750, completed: true } });
  map.set('arcade:v1:synapse-run', 'corrupt-bytes');
  const third = createSaveSession();
  const result = await store.load('synapse-run');
  third.onLoad({ status: 'ERROR', code: result.code });
  assert.deepEqual([third.saveStatus, third.settle(1, run(1, 0, 1)).write, map.get('arcade:v1:synapse-run')], ['PROTECTED', null, 'corrupt-bytes']);
});

// ── foundation.js save bridge ───────────────────────────────────────────────────────────────────────────
function foundation() {
  const listeners = {}, sent = [], attrs = {}, elements = {}, toGame = [];
  const origin = 'http://127.0.0.1:5173', id = 'a'.repeat(32);
  const parent = { postMessage: (data, target) => { assert.equal(target, origin); sent.push(JSON.parse(JSON.stringify(data))); } };
  const events = new EventTarget();
  events.addEventListener('synapse-run:save-result', e => toGame.push(JSON.parse(JSON.stringify(e.detail)))); // vm realm → plain objects
  const document = { getElementById: k => (elements[k] ??= {}), documentElement: { setAttribute: (k, v) => { attrs[k] = v; } }, addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) };
  const window = { parent, location: { hash: `#instance=${id}`, origin }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/arcade/synapse-run/foundation.js', import.meta.url), 'utf8'), { window, document, CustomEvent });
  const host = (type, payload = {}, extra = {}) => listeners.message({ data: { channel: 'docteur-arcade', v: 1, type, gameId: 'synapse-run', instanceId: id, payload, ...extra }, source: parent, origin });
  const gameWrite = detail => events.dispatchEvent(new CustomEvent('synapse-run:save-write', { detail }));
  return { sent, toGame, host, gameWrite, attrs };
}

test('bridge: load result reaches the game; game writes become typed ARCADE_SAVE_WRITE; results correlate', () => {
  const f = foundation();
  f.gameWrite({ saveVersion: 1, data: {} });
  assert.deepEqual(f.toGame.pop(), { op: 'WRITE', status: 'ERROR', code: 'SAVE_BUSY' }, 'no write before INIT');
  f.host('ARCADE_INIT', { reducedMotion: false });
  const load = f.sent.find(m => m.type === 'ARCADE_SAVE_LOAD');
  f.host('ARCADE_SAVE_RESULT', { op: 'LOAD', status: 'FOUND', save: { saveVersion: 1, createdAt: 1, updatedAt: 2, data: { synthetic: 1 } } }, { requestId: load.requestId });
  assert.deepEqual(f.toGame.pop(), { op: 'LOAD', status: 'FOUND', saveVersion: 1, data: { synthetic: 1 } });
  f.gameWrite({ saveVersion: 1, data: { synthetic: 2 } });
  const write = f.sent.at(-1);
  assert.deepEqual([write.type, write.payload, /^[0-9a-f]{16}$/.test(write.requestId), write.requestId !== load.requestId], ['ARCADE_SAVE_WRITE', { saveVersion: 1, data: { synthetic: 2 } }, true, true]);
  // wrong op / unknown id / already answered are ignored
  f.host('ARCADE_SAVE_RESULT', { op: 'LOAD', status: 'EMPTY' }, { requestId: write.requestId });
  f.host('ARCADE_SAVE_RESULT', { op: 'WRITE', status: 'SAVED' }, { requestId: 'ffffffffffffffff' });
  f.host('ARCADE_SAVE_RESULT', { op: 'WRITE', status: 'ERROR', code: 'free text' }, { requestId: write.requestId });
  assert.equal(f.toGame.length, 0);
  f.host('ARCADE_SAVE_RESULT', { op: 'WRITE', status: 'SAVED', save: { saveVersion: 1, createdAt: 1, updatedAt: 3 } }, { requestId: write.requestId });
  assert.deepEqual(f.toGame.pop(), { op: 'WRITE', status: 'SAVED' });
  f.host('ARCADE_SAVE_RESULT', { op: 'WRITE', status: 'SAVED' }, { requestId: write.requestId });
  assert.equal(f.toGame.length, 0, 'answered once');
});

test('bridge: bounded pending requests, malformed write requests refused, no delete path for the game', () => {
  const f = foundation();
  f.host('ARCADE_INIT', { reducedMotion: false }); // LOAD pending (1)
  for (let i = 0; i < 5; i++) f.gameWrite({ saveVersion: 1, data: { i } });
  assert.equal(f.sent.filter(m => m.type === 'ARCADE_SAVE_WRITE').length, 3, 'at most 4 requests pending (LOAD + 3)');
  assert.equal(f.toGame.filter(r => r.code === 'SAVE_BUSY').length, 2);
  for (const detail of [null, 'x', {}, { saveVersion: 0, data: {} }, { saveVersion: 1.5, data: {} }, { saveVersion: '1', data: {} }]) f.gameWrite(detail);
  assert.equal(f.sent.filter(m => m.type === 'ARCADE_SAVE_WRITE').length, 3);
  const types = new Set(f.sent.map(m => m.type));
  assert.equal(types.has('ARCADE_SAVE_DELETE'), false);
  const source = fs.readFileSync(new URL('../public/arcade/synapse-run/foundation.js', import.meta.url), 'utf8');
  assert.equal(/send\('ARCADE_SAVE_DELETE'|'ARCADE_SAVE_DELETE', \{/.test(source), false, 'the page never sends a delete');
});
