// [FILAMENT-1] Unit tests for the PURE parts of the playable Filament slice. Status when written: NOT RUN.
//   node --experimental-strip-types --no-warnings --test scripts/test-filament-game-unit.mjs
// No physics step is ever executed here (the engine module is loaded for its constants only): stepping the engine
// belongs under the supervised launcher (scripts/filament-safe-run.mjs). Covered:
//   * levels.ts is the replayed fixtures' data, field for field (same floats), with the recorded references;
//   * loop.ts bounds the steps per frame, drops the backlog, freezes when the attempt ends;
//   * input.ts hit-testing and key mapping;
//   * static guards: the game never imports the lab, never scans, and its engine file is the certified one.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { FILAMENT_CHAPTERS, FILAMENT_LEVELS, PENDING_LEVELS, PLANNED_LEVELS, getLevel, previewLevel } from '../src/arcade/filament/levels.ts';
import { createAttempt } from '../src/arcade/filament/session.ts';
import { createFixedStepper, MAX_STEPS_PER_FRAME, MAX_FRAME_DELTA_MS, STEP_MS } from '../src/arcade/filament/loop.ts';
import { distanceToSegment, keyCommand, pickFan, pickThread, segmentsIntersect, threadsCrossed, PICK_RADIUS_MOUSE } from '../src/arcade/filament/input.ts';
import { FIXTURE as FIXTURE_A } from './filament-single-replay-fixture.mjs';
import { FIXTURE as FIXTURE_B } from './filament-replay-ch1-b-fixture.mjs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('[FILAMENT-2] chapter 1: 8 levels in difficulty order; CH1-A and CH1-B are still their replayed fixtures', () => {
  // [FILAMENT-4 CH2-A] chapter 1 = the first 8 playable levels, unchanged
  const CH1 = FILAMENT_LEVELS.filter(l => l.chapter === 'ch1');
  assert.deepEqual(FILAMENT_LEVELS.slice(0, 8), CH1);
  assert.equal(CH1.length, 8);
  assert.deepEqual(CH1.map(l => l.code), ['CH1-A', 'CH1-G', 'CH1-D', 'CH1-B', 'CH1-C', 'CH1-H', 'CH1-I', 'CH1-J']);
  assert.deepEqual(CH1.map(l => l.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  const byCode = code => CH1.find(l => l.code === code);
  assert.deepStrictEqual(structuredClone(byCode('CH1-A').physics), structuredClone(FIXTURE_A.level));
  assert.deepStrictEqual(structuredClone(byCode('CH1-B').physics), structuredClone(FIXTURE_B.level));
  assert.equal(byCode('CH1-B').physics.orb.x, FIXTURE_B.level.orb.x); // same float, not merely close
  assert.deepStrictEqual(structuredClone(byCode('CH1-A').reference.actions), structuredClone(FIXTURE_A.actions));
  assert.deepStrictEqual(structuredClone(byCode('CH1-B').reference.actions), structuredClone(FIXTURE_B.actions));
  assert.deepEqual(CH1.map(l => l.reference.winTick), [87, 178, 209, 221, 206, 178, 157, 210]);
  for (const level of CH1) {
    assert.equal(level.physics.stars.length, 3, level.code);
    assert.equal(level.reference.starAt.length, 3, level.code);
    // starting geometry: no thread shorter than its anchor → orb distance (rejected drafts e and f failed this)
    for (const t of level.physics.threads) assert.ok(Math.hypot(level.physics.orb.x - t.anchor.x, level.physics.orb.y - t.anchor.y) <= t.length + 0.5, level.code);
    assert.equal(level.physics.currents, undefined, level.code); // not drawn by the renderer yet
    assert.equal(level.physics.wells, undefined, level.code);
  }
  assert.ok(Object.isFrozen(FILAMENT_LEVELS) && Object.isFrozen(byCode('CH1-B').physics.segments[0].a));
  for (const bad of [-1, 24, 1.5, NaN]) assert.equal(getLevel(bad), null);
});

test('fixed stepper: whole ticks, ≤ MAX_STEPS_PER_FRAME per frame, backlog dropped, stops when the attempt ends', () => {
  let ticks = 0;
  const stepper = createFixedStepper(() => { ticks += 1; return true; });
  assert.equal(stepper.frame(1000), 0); // first frame only sets the clock
  assert.equal(stepper.frame(1000 + STEP_MS * 2), 2);
  assert.equal(stepper.frame(1000 + STEP_MS * 2 + 10_000), MAX_STEPS_PER_FRAME); // a 10 s stall counts as 100 ms
  assert.ok(stepper.dropped >= Math.floor(MAX_FRAME_DELTA_MS / STEP_MS) - MAX_STEPS_PER_FRAME - 1);
  stepper.reset();
  assert.equal(stepper.frame(50_000), 0);
  let left = 3;
  const ending = createFixedStepper(() => { left -= 1; return left > 0; });
  ending.frame(0);
  assert.equal(ending.frame(STEP_MS * 4), 3);
  assert.equal(left, 0);
  assert.equal(ticks, 2 + MAX_STEPS_PER_FRAME);
});

test('input geometry: taps near a thread, swipes across it, nothing else', () => {
  const lines = [{ index: 0, a: { x: 400, y: 70 }, b: { x: 400, y: 180 } }];
  assert.equal(distanceToSegment({ x: 410, y: 120 }, lines[0].a, lines[0].b), 10);
  assert.equal(pickThread({ x: 410, y: 120 }, lines, PICK_RADIUS_MOUSE), 0);
  assert.equal(pickThread({ x: 450, y: 120 }, lines, PICK_RADIUS_MOUSE), -1);
  assert.equal(segmentsIntersect({ x: 380, y: 100 }, { x: 420, y: 110 }, lines[0].a, lines[0].b), true);
  assert.equal(segmentsIntersect({ x: 380, y: 300 }, { x: 420, y: 300 }, lines[0].a, lines[0].b), false);
  assert.deepEqual(threadsCrossed({ x: 380, y: 100 }, { x: 420, y: 110 }, lines, []), [0]);
});

test('keys: cut, pause, restart, next; nothing else', () => {
  assert.equal(keyCommand(' ').kind, 'CUT_NEXT');
  assert.deepEqual(keyCommand('3'), { kind: 'CUT', thread: 2 });
  assert.equal(keyCommand('Escape').kind, 'PAUSE');
  assert.equal(keyCommand('R').kind, 'RESTART');
  assert.equal(keyCommand('n').kind, 'NEXT');
  for (const key of ['9', '0', 'a', 'Tab', 'ArrowLeft', '']) assert.equal(keyCommand(key), null);
  assert.equal(keyCommand('F').kind, 'FAN'); // [FILAMENT-4]
  // [FILAMENT-6] F drives the level's first fan, G its second one (level 23 has two)
  assert.deepEqual([keyCommand('f'), keyCommand('G')], [{ kind: 'FAN', slot: 0 }, { kind: 'FAN', slot: 1 }]);
});

test('[FILAMENT-4] chapter 2: CH2-A … F validated and playable, no specification pending, consistent geometry, stable ids', () => {
  assert.deepEqual(FILAMENT_CHAPTERS.map(c => [c.id, c.theme]), [['ch1', 'aube'], ['ch2', 'altitude'], ['ch3', 'verger'], ['ch4', 'crepuscule']]);
  assert.equal(FILAMENT_LEVELS.length, 24); // pending levels never join the playable / saved list
  assert.deepEqual(FILAMENT_LEVELS.map(l => l.chapter), ['ch1', 'ch1', 'ch1', 'ch1', 'ch1', 'ch1', 'ch1', 'ch1', 'ch2', 'ch2', 'ch2', 'ch2', 'ch2', 'ch2', 'ch3', 'ch3', 'ch3', 'ch3', 'ch3', 'ch4', 'ch4', 'ch4', 'ch4', 'ch4']);
  // [FILAMENT-4 CH2-A] the data of the single supervised calibration (FILAMENT_CH2_A_SINGLE_CALIBRATION.md), verbatim
  const a = FILAMENT_LEVELS[8];
  assert.deepEqual([a.id, a.code, a.number, a.title], ['ch2-a', 'CH2-A', 9, 'Premier souffle']);
  assert.deepStrictEqual(structuredClone(a.physics), {
    orb: { x: 180, y: 160 },
    threads: [{ anchor: { x: 180, y: 60 }, length: 100 }],
    currents: [{ x: 100, y: 180, w: 600, h: 290, ax: 1000, ay: 0 }],
    goal: { x: 353, y: 445, r: 34 },
    stars: [{ x: 201, y: 237 }, { x: 240, y: 298 }, { x: 291, y: 368 }],
  });
  assert.deepStrictEqual(structuredClone(a.reference), { actions: [{ tick: 20, action: { type: 'CUT', thread: 0 } }], winTick: 111, starAt: [59, 80, 96] });
  // [CH2 SEQUENTIAL] CH2-B: data of its single supervised calibration (FILAMENT_CHAPTER_2_SEQUENTIAL_FINALIZATION.md)
  const b = FILAMENT_LEVELS[9];
  assert.deepEqual([b.id, b.code, b.number, b.title], ['ch2-b', 'CH2-B', 10, 'La traversée']);
  assert.deepStrictEqual(structuredClone(b.physics.goal), { x: 600, y: 428, r: 34 });
  assert.deepStrictEqual(structuredClone(b.physics.stars), [{ x: 293, y: 254 }, { x: 391, y: 298 }, { x: 499, y: 353 }]);
  assert.deepStrictEqual(structuredClone(b.reference), { actions: [{ tick: 82, action: { type: 'CUT', thread: 0 } }], winTick: 187, starAt: [116, 142, 166] });
  assert.equal(b.physics.orb.x, 160 + 150 * Math.sin(-60 * Math.PI / 180)); // the spec's float, unchanged
  // [CH2-C v3] the single supervised calibration of the ramp correction (FILAMENT_CH2_C_RAMP_CORRECTION_V3.md)
  const c = FILAMENT_LEVELS[10];
  assert.deepEqual([c.id, c.code, c.number, c.title], ['ch2-c', 'CH2-C', 11, 'Les jardins suspendus']);
  assert.deepStrictEqual(structuredClone(c.physics.segments), [{ a: { x: 517, y: 434 }, b: { x: 643, y: 446 }, kind: 'deflector' }]);
  assert.deepStrictEqual(structuredClone(c.physics.goal), { x: 702, y: 433, r: 34 });
  assert.deepStrictEqual(structuredClone(c.physics.stars), [{ x: 269, y: 262 }, { x: 403, y: 326 }, { x: 543, y: 414 }]);
  assert.deepStrictEqual(structuredClone(c.reference), { actions: [{ tick: 66, action: { type: 'CUT', thread: 0 } }], winTick: 196, starAt: [113, 142, 168] });
  assert.equal(c.physics.orb.x, 130 + 120 * Math.sin(-50 * Math.PI / 180)); // the spec's float, unchanged
  // [CH2-D / CH2-E] data of their single supervised calibrations (FILAMENT_CH2_D_E_F_FINALIZATION.md)
  const d = FILAMENT_LEVELS[11];
  assert.deepEqual([d.id, d.code, d.number, d.title], ['ch2-d', 'CH2-D', 12, 'Vents contraires']);
  assert.deepStrictEqual(structuredClone(d.physics.goal), { x: 249, y: 464, r: 34 });
  assert.deepStrictEqual(structuredClone(d.physics.stars), [{ x: 172, y: 234 }, { x: 211, y: 294 }, { x: 243, y: 370 }]);
  assert.deepStrictEqual(structuredClone(d.reference), { actions: [{ tick: 20, action: { type: 'CUT', thread: 0 } }], winTick: 125, starAt: [57, 83, 104] });
  const e = FILAMENT_LEVELS[12];
  assert.deepEqual([e.id, e.code, e.number, e.title], ['ch2-e', 'CH2-E', 13, 'Le souffle des cristaux']);
  assert.deepStrictEqual(structuredClone(e.physics.goal), { x: 673, y: 422, r: 34 });
  assert.deepStrictEqual(structuredClone(e.physics.stars), [{ x: 286, y: 221 }, { x: 433, y: 161 }, { x: 580, y: 267 }]);
  assert.deepStrictEqual(structuredClone(e.reference), { actions: [{ tick: 10, action: { type: 'TOGGLE', current: 0 } }, { tick: 30, action: { type: 'CUT', thread: 0 } }], winTick: 269, starAt: [124, 178, 234] });
  assert.equal(e.physics.currents[0].fan.initiallyOn, false); // the player switches it on
  // [CH2-F v3] the redesign validated by its single supervised run (FILAMENT_CH2_F_REDESIGN_V3.md)
  const f = FILAMENT_LEVELS[13];
  assert.deepEqual([f.id, f.code, f.number, f.title], ['ch2-f', 'CH2-F', 14, 'Le passage des nuages']);
  assert.deepStrictEqual(structuredClone(f.physics), {
    orb: { x: 150, y: 168 },
    threads: [{ anchor: { x: 150, y: 68 }, length: 100 }],
    currents: [
      { x: 110, y: 170, w: 340, h: 140, ax: 250, ay: -900 },
      { x: 450, y: 200, w: 200, h: 270, ax: 100, ay: -2000, fan: { initiallyOn: false, device: { x: 550, y: 478 } } },
    ],
    segments: [{ a: { x: 690, y: 300 }, b: { x: 690, y: 500 }, kind: 'wall' }],
    rifts: [{ a: { x: 240, y: 485 }, b: { x: 600, y: 485 } }],
    goal: { x: 722, y: 131, r: 34 },
    stars: [{ x: 278, y: 231 }, { x: 427, y: 259 }, { x: 583, y: 223 }],
  });
  assert.deepStrictEqual(structuredClone(f.reference), { actions: [{ tick: 10, action: { type: 'TOGGLE', current: 1 } }, { tick: 76, action: { type: 'CUT', thread: 0 } }], winTick: 340, starAt: [189, 252, 301] });
  // [FILAMENT-5] chapter 2 has nothing pending; chapter 3 « Vergers Stellaires » = five specifications, levels 15–19
  // [FILAMENT-5 CH3] CH3-A and CH3-B: data of their single supervised calibrations (FILAMENT_CH3_SEQUENTIAL_PHYSICS_VALIDATION.md)
  const g = FILAMENT_LEVELS[14];
  assert.deepEqual([g.id, g.chapter, g.number, g.title], ['ch3-a', 'ch3', 15, 'La première orbite']);
  assert.deepStrictEqual(structuredClone(g.physics), {
    orb: { x: 200, y: 150 },
    threads: [{ anchor: { x: 200, y: 50 }, length: 100 }],
    wells: [{ x: 370, y: 300, radius: 220, strength: 2600 }],
    goal: { x: 262, y: 430, r: 34 },
    stars: [{ x: 202, y: 219 }, { x: 214, y: 291 }, { x: 234, y: 359 }],
  });
  assert.deepStrictEqual(structuredClone(g.reference), { actions: [{ tick: 20, action: { type: 'CUT', thread: 0 } }], winTick: 107, starAt: [54, 78, 93] });
  const h = FILAMENT_LEVELS[15];
  assert.deepEqual([h.id, h.chapter, h.number, h.title], ['ch3-b', 'ch3', 16, 'Les fruits suspendus']);
  assert.deepStrictEqual(structuredClone(h.physics.goal), { x: 561, y: 425, r: 34 });
  assert.deepStrictEqual(structuredClone(h.physics.stars), [{ x: 297, y: 264 }, { x: 363, y: 337 }, { x: 452, y: 386 }]);
  assert.deepStrictEqual(structuredClone(h.reference), { actions: [{ tick: 82, action: { type: 'CUT', thread: 0 } }], winTick: 186, starAt: [114, 138, 161] });
  assert.equal(h.physics.orb.x, 180 + 150 * Math.sin(-60 * Math.PI / 180)); // the spec's float, unchanged
  // [CH3-C v3] the gravity redesign validated by its single supervised run (FILAMENT_CH3_C_GRAVITY_REDESIGN.md)
  const k = FILAMENT_LEVELS[16];
  assert.deepEqual([k.id, k.chapter, k.number, k.title], ['ch3-c', 'ch3', 17, 'L’appel des astres']);
  assert.deepStrictEqual(structuredClone(k.physics.wells), [{ x: 360, y: 190, radius: 160, strength: 2600 }, { x: 600, y: 360, radius: 200, strength: 2800 }]);
  assert.deepStrictEqual(structuredClone(k.physics.rifts), [{ a: { x: 300, y: 485 }, b: { x: 520, y: 485 } }]);
  assert.deepStrictEqual(structuredClone(k.physics.goal), { x: 605, y: 393, r: 34 });
  assert.deepStrictEqual(structuredClone(k.physics.stars), [{ x: 304, y: 254 }, { x: 397, y: 290 }, { x: 496, y: 334 }]);
  assert.deepStrictEqual(structuredClone(k.reference), { actions: [{ tick: 82, action: { type: 'CUT', thread: 0 } }], winTick: 177, starAt: [113, 135, 157] });
  assert.equal(k.physics.orb.x, 180 + 150 * Math.sin(-60 * Math.PI / 180)); // the CH3-B pendulum's float
  // [CH3-D v2] the air-column redesign validated by its single supervised run (FILAMENT_CH3_D_AIR_COLUMN_REDESIGN.md)
  const m = FILAMENT_LEVELS[17];
  assert.deepEqual([m.id, m.chapter, m.number, m.title], ['ch3-d', 'ch3', 18, 'Le jardin renversé']);
  assert.deepStrictEqual(structuredClone(m.physics), {
    orb: { x: 200, y: 160 },
    threads: [{ anchor: { x: 200, y: 60 }, length: 100 }],
    currents: [{ x: 140, y: 200, w: 190, h: 270, ax: 500, ay: -1700, timing: { period: 240, on: 120, phase: 200 } }],
    wells: [{ x: 640, y: 140, radius: 200, strength: 2400 }],
    rifts: [{ a: { x: 120, y: 485 }, b: { x: 700, y: 485 } }],
    goal: { x: 643, y: 262, r: 34 },
    stars: [{ x: 259, y: 237 }, { x: 372, y: 168 }, { x: 511, y: 192 }],
  });
  assert.deepStrictEqual(structuredClone(m.reference), { actions: [{ tick: 30, action: { type: 'CUT', thread: 0 } }], winTick: 241, starAt: [106, 157, 206] });
  // [CH3-E v2] the fan-column redesign validated by its single supervised run (FILAMENT_CH3_E_FAN_REDESIGN_V2.md)
  const n = FILAMENT_LEVELS[18];
  assert.deepEqual([n.id, n.chapter, n.number, n.title], ['ch3-e', 'ch3', 19, 'Le cœur du verger']);
  assert.deepStrictEqual(structuredClone(n.physics), {
    orb: { x: 150, y: 160 },
    threads: [{ anchor: { x: 150, y: 60 }, length: 100 }, { anchor: { x: 330, y: 60 }, length: 206 }],
    currents: [{ x: 440, y: 260, w: 220, h: 220, ax: 120, ay: -2000, fan: { initiallyOn: false, device: { x: 590, y: 478 } } }],
    wells: [{ x: 730, y: 290, radius: 140, strength: 1800 }],
    rifts: [{ a: { x: 420, y: 485 }, b: { x: 700, y: 485 } }],
    goal: { x: 745, y: 265, r: 34 },
    stars: [{ x: 454, y: 306 }, { x: 539, y: 327 }, { x: 636, y: 303 }],
  });
  assert.deepStrictEqual(structuredClone(n.reference), { actions: [{ tick: 10, action: { type: 'TOGGLE', current: 0 } }, { tick: 20, action: { type: 'CUT', thread: 0 } }, { tick: 117, action: { type: 'CUT', thread: 1 } }], winTick: 216, starAt: [144, 167, 193] });
  // the orb starts outside the fan column and the star (no drift before the first action)
  const [column] = n.physics.currents, [heart] = n.physics.wells;
  assert.ok(n.physics.orb.x < column.x && Math.hypot(n.physics.orb.x - heart.x, n.physics.orb.y - heart.y) > heart.radius);
  // [FILAMENT-6 CH4] levels 20–24: the data of their single supervised calibrations (FILAMENT_CHAPTER_4_SEQUENTIAL_VALIDATION.md)
  const cut = (tick, thread) => ({ tick, action: { type: 'CUT', thread } });
  const toggle = (tick, current) => ({ tick, action: { type: 'TOGGLE', current } });
  const ch4 = FILAMENT_LEVELS.slice(19);
  assert.deepEqual(ch4.map(l => [l.id, l.chapter, l.number]), [['ch4-a', 'ch4', 20], ['ch4-b', 'ch4', 21], ['ch4-c', 'ch4', 22], ['ch4-d', 'ch4', 23], ['ch4-e', 'ch4', 24]]);
  assert.deepEqual(ch4.map(l => l.title), ['Le dernier rayon', 'Les ombres mouvantes', 'Entre deux horizons', 'Les fils du crépuscule', 'Au-delà de la lisière']);
  assert.deepStrictEqual(ch4.map(l => structuredClone(l.physics.goal)), [{ x: 160, y: 414, r: 34 }, { x: 725, y: 285, r: 34 }, { x: 702, y: 304, r: 34 }, { x: 53, y: 343, r: 34 }, { x: 748, y: 236, r: 34 }]);
  assert.deepStrictEqual(ch4.map(l => structuredClone(l.physics.stars)), [
    [{ x: 488, y: 272 }, { x: 381, y: 296 }, { x: 258, y: 319 }],
    [{ x: 397, y: 229 }, { x: 496, y: 247 }, { x: 605, y: 263 }],
    [{ x: 325, y: 263 }, { x: 436, y: 304 }, { x: 567, y: 326 }],
    [{ x: 346, y: 307 }, { x: 267, y: 351 }, { x: 164, y: 355 }],
    [{ x: 281, y: 224 }, { x: 422, y: 160 }, { x: 580, y: 231 }],
  ]);
  assert.deepStrictEqual(ch4.map(l => structuredClone(l.reference)), [
    { actions: [cut(82, 0)], winTick: 230, starAt: [118, 152, 195] },
    { actions: [cut(20, 0), cut(95, 1)], winTick: 203, starAt: [134, 160, 183] },
    { actions: [cut(82, 0)], winTick: 205, starAt: [118, 143, 174] },
    { actions: [toggle(10, 0), toggle(14, 1), cut(20, 0), cut(117, 1)], winTick: 221, starAt: [144, 166, 193] },
    { actions: [toggle(10, 0), cut(30, 0)], winTick: 264, starAt: [121, 174, 226] },
  ]);
  assert.deepStrictEqual(structuredClone(ch4[4].physics.currents), [
    { x: 140, y: 200, w: 190, h: 270, ax: 500, ay: -1700, fan: { initiallyOn: false, device: { x: 235, y: 478 } } },
    { x: 580, y: 140, w: 180, h: 190, ax: 0, ay: -1500, timing: { period: 300, on: 120, phase: 90 } },
  ]);
  // the whole game: 24 playable levels in four chapters, nothing pending
  assert.deepEqual(PENDING_LEVELS.map(p => [p.id, p.chapter, p.number]), []);
  const ids = new Set([...FILAMENT_LEVELS, ...PENDING_LEVELS].map(l => l.id));
  assert.equal(ids.size, 24);
  assert.equal(PLANNED_LEVELS, 24);
  for (const p of PENDING_LEVELS) assert.equal(FILAMENT_LEVELS.some(l => l.id === p.id), false, p.id); // not playable, not saved
  for (const p of PENDING_LEVELS) {
    // [FILAMENT-5] wells and pegs: within the lab limits; the orb starts outside every well radius and clear of pegs
    assert.ok((p.physics.wells ?? []).length <= 4 && (p.physics.pegs ?? []).length <= 24, p.id);
    for (const w of p.physics.wells ?? []) {
      assert.ok(w.radius > 0 && Number.isFinite(w.strength), p.id);
      assert.ok(Math.hypot(p.physics.orb.x - w.x, p.physics.orb.y - w.y) > w.radius, p.id);
    }
    for (const g of p.physics.pegs ?? []) assert.ok(Math.hypot(p.physics.orb.x - g.x, p.physics.orb.y - g.y) > 18 + g.r, p.id);
    assert.equal(p.status, 'PENDING_VALIDATION', p.id);
    assert.equal('goal' in p.physics, false, p.id);
    assert.equal('stars' in p.physics, false, p.id);
    for (const t of p.physics.threads) assert.ok(Math.hypot(p.physics.orb.x - t.anchor.x, p.physics.orb.y - t.anchor.y) <= t.length + 0.5, p.id);
    for (const c of p.physics.currents ?? []) {
      assert.ok(c.w > 0 && c.h > 0 && Number.isFinite(c.ax) && Number.isFinite(c.ay), p.id);
      // the orb never starts inside a wind zone (no unexplained drift before the first action)
      assert.ok(!(p.physics.orb.x >= c.x && p.physics.orb.x <= c.x + c.w && p.physics.orb.y >= c.y && p.physics.orb.y <= c.y + c.h), p.id);
      if (c.fan) assert.ok(c.fan.device.x >= 0 && c.fan.device.x <= 800 && c.fan.device.y >= 0 && c.fan.device.y <= 500, p.id);
      if (c.timing) assert.ok(c.timing.period > c.timing.on && c.timing.on > 0, p.id);
    }
    assert.ok((p.physics.currents ?? []).length <= 8 && p.design.actions.length <= 8, p.id); // lab LEVEL_LIMITS
    const preview = previewLevel(p);
    assert.equal(preview.physics.stars.length, 0, p.id);
    assert.ok(preview.physics.goal.x < -1000, p.id); // no goal on screen
  }
});

test('[FILAMENT-4] fan requests: only a current with a fan, once per tick; chapter 1 has none (no step run)', () => {
  const fanLevel = FILAMENT_LEVELS.find(l => l.id === 'ch2-e'); // [CH2-E] now playable
  const attempt = createAttempt(fanLevel);
  assert.equal(attempt.firstFan(), 0);
  assert.equal(attempt.requestToggle(0), true);
  assert.equal(attempt.requestToggle(0), false); // already queued for the next tick
  for (const bad of [1, -1, 0.5, NaN]) assert.equal(attempt.requestToggle(bad), false);
  const plain = createAttempt(FILAMENT_LEVELS[0]);
  assert.equal(plain.firstFan(), -1);
  assert.equal(plain.requestToggle(0), false);
  assert.equal(keyCommand('f').kind, 'FAN');
  assert.equal(pickFan({ x: 240, y: 470 }, [{ index: 0, x: 235, y: 478 }], 26), 0);
  assert.equal(pickFan({ x: 300, y: 470 }, [{ index: 0, x: 235, y: 478 }], 26), -1);
});

test('static guards: no lab, no scan, certified engine, bounded loop constants', () => {
  for (const file of ['main.ts', 'session.ts', 'loop.ts', 'input.ts', 'renderer.ts', 'levels.ts', 'chapter1.ts', 'chapter2.ts', 'chapter3.ts', 'chapter4.ts']) {
    const text = read(`src/arcade/filament/${file}`);
    assert.doesNotMatch(text, /filament-lab-lib|scanSummary|\bscan\(|\breplay\(/, file);
    assert.doesNotMatch(text, /fetch\(|XMLHttpRequest|WebSocket|localStorage|indexedDB|getContext\('webgl/, file);
  }
  const engine = crypto.createHash('sha256').update(fs.readFileSync(new URL('../src/arcade/filament/physics.ts', import.meta.url))).digest('hex');
  assert.equal(engine, '733fd8352dfd09ee2cfea66163bded689ec69ac976603d54889d43f9d9b31b59');
  assert.ok(MAX_STEPS_PER_FRAME <= 8 && MAX_FRAME_DELTA_MS <= 100);
});
