// [GAME-4] Synapse Run — deterministic simulation, fixed-step loop and input adapter (no DOM, no WebGL).
// Fixed seeds only. Handcrafted fixtures replace the generated course where a test needs an exact obstacle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK, DT, GRAVITY, HIGH_GATE, HORIZON, JUMP_VELOCITY, LANE_CHANGE_TICKS, MAX_ROW_GAP, MIN_ROW_GAP, PRUNE_BEHIND,
  SHARD_MARGIN, SHARD_POINTS, SLIDE_TICKS, SPEED, START_SAFE_Z, TICK_RATE, checksum, createSim, generateCourse, laneX,
  playerX, score, stepSim,
} from '../src/arcade/synapse-run/simulation.ts';
import { MAX_FRAME_DELTA_MS, MAX_STEPS_PER_FRAME, STEP_MS, createFixedStepper } from '../src/arcade/synapse-run/loop.ts';
import { MAX_COMMANDS_PER_TICK, actionForKey, createCommandQueue } from '../src/arcade/synapse-run/input.ts';
import { createAutopilot } from '../src/arcade/synapse-run/autopilot.ts';

const SEED = 20261021;

/** A running state with an exact handcrafted course and course generation pushed out of reach. */
function fixture({ obstacles = [], shards = [] } = {}) {
  const s = createSim(1);
  s.obstacles = obstacles.map((o, i) => ({ id: 100 + i, ...o }));
  s.shards = shards.map((sh, i) => ({ id: 200 + i, collected: false, ...sh }));
  s.nextRowZ = 1e9;
  s.status = 'RUNNING';
  return s;
}
const ticksTo = z => Math.round((z * TICK_RATE) / SPEED); // ticks for the player to reach distance z
function run(s, ticks, at = {}) {
  for (let i = 0; i < ticks; i++) stepSim(s, at[s.tick] ?? []);
  return s;
}
/** Deterministic scripted inputs from a tiny local LCG (test-only, independent of the simulation PRNG). */
function script(seed, ticks) {
  let x = seed >>> 0;
  const out = {};
  const commands = ['LEFT', 'RIGHT', 'JUMP', 'SLIDE'];
  for (let t = 0; t < ticks; t++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    if (x % 9 === 0) out[t] = [commands[(x >>> 8) % 4]];
  }
  out[0] = ['START', ...(out[0] ?? [])];
  return out;
}

test('A same seed + same inputs + same ticks ⇒ identical state', () => {
  const inputs = script(7, 900);
  const a = run(createSim(SEED), 900, inputs), b = run(createSim(SEED), 900, inputs);
  assert.deepEqual(a, b);
  assert.equal(checksum(a), checksum(b));
  const c = run(createSim(SEED), 900, script(8, 900));
  assert.notEqual(checksum(a), checksum(c), 'different inputs diverge');
});

test('B different seeds produce different courses; seeds are explicit uint32', () => {
  const course = seed => createSim(seed).obstacles.map(o => `${o.type}:${o.lane}:${o.z}`).join('|');
  const courses = new Set([1, 2, 3, SEED, 0xffffffff].map(course));
  assert.equal(courses.size, 5);
  assert.equal(createSim(-1).seed, 0xffffffff);
  assert.equal(createSim(2 ** 32 + 5).seed, 5);
  assert.equal(createSim(NaN).seed, 0);
});

test('C each tick advances exactly SPEED / 60 metres; READY does not move', () => {
  const s = createSim(SEED);
  run(s, 30);
  assert.deepEqual([s.status, s.tick, s.distance], ['READY', 0, 0]);
  stepSim(s, ['START']);
  assert.deepEqual([s.status, s.tick, s.distance], ['RUNNING', 1, SPEED / TICK_RATE]);
  const f = fixture();
  run(f, 600);
  assert.equal(f.distance, 120);
  assert.equal(f.distance, (f.runTicks * SPEED) / TICK_RATE);
  assert.equal(DT, 1 / 60);
});

test('D lanes stay inside LEFT..RIGHT', () => {
  const s = fixture();
  assert.equal(s.lane, 1);
  run(s, 1, { [s.tick]: ['LEFT'] }); run(s, LANE_CHANGE_TICKS);
  assert.equal(s.lane, 0);
  run(s, 1, { [s.tick]: ['LEFT'] });
  assert.deepEqual([s.lane, s.laneProgress], [0, 0], 'outward command ignored');
  for (let i = 0; i < 4; i++) { run(s, 1, { [s.tick]: ['RIGHT'] }); run(s, LANE_CHANGE_TICKS); }
  assert.equal(s.lane, 2);
  assert.equal(playerX(s), laneX(2));
});

test('E lane change takes exactly 8 ticks; contradictory inputs resolve deterministically (one buffered, last wins)', () => {
  const s = fixture();
  const xs = [];
  stepSim(s, ['LEFT']); xs.push(playerX(s));
  for (let i = 1; i < LANE_CHANGE_TICKS; i++) { stepSim(s); xs.push(playerX(s)); }
  assert.deepEqual(xs.map(x => Number(x.toFixed(4))), [1, 2, 3, 4, 5, 6, 7, 8].map(k => Number((-2.2 * k / 8).toFixed(4))));
  assert.deepEqual([s.lane, s.laneProgress], [0, 0]);
  // LEFT then RIGHT in the same tick: go left, then come back
  const b = fixture();
  stepSim(b, ['LEFT', 'RIGHT']);
  assert.deepEqual([b.laneTo, b.laneBuffer], [0, 1]);
  run(b, LANE_CHANGE_TICKS - 1);
  assert.deepEqual([b.lane, b.laneTo, b.laneProgress], [0, 1, 1], 'buffered change starts on the settling tick');
  run(b, LANE_CHANGE_TICKS - 1);
  assert.deepEqual([b.lane, b.laneProgress], [1, 0]);
  // RIGHT, LEFT, RIGHT during one change: only the last buffered command survives
  const c = fixture();
  stepSim(c, ['LEFT']); stepSim(c, ['RIGHT']); stepSim(c, ['LEFT']); stepSim(c, ['RIGHT']);
  assert.equal(c.laneBuffer, 1);
});

test('F jump only while running and grounded', () => {
  const s = createSim(SEED);
  stepSim(s, ['JUMP']);
  assert.deepEqual([s.status, s.mode, s.y], ['READY', 'RUN', 0]);
  stepSim(s, ['START']); stepSim(s, ['JUMP']);
  assert.equal(s.mode, 'JUMP');
  assert.ok(s.y > 0);
});

test('G gravity and landing are deterministic (fixed airtime, peak, exact landing at 0)', () => {
  const s = fixture();
  stepSim(s, ['JUMP']);
  let ticks = 1, peak = s.y;
  while (s.mode === 'JUMP') { stepSim(s); ticks++; peak = Math.max(peak, s.y); }
  assert.deepEqual([s.y, s.vy, s.mode], [0, 0, 'RUN']);
  const expected = 2 * JUMP_VELOCITY / GRAVITY * TICK_RATE;
  assert.ok(Math.abs(ticks - expected) <= 1, `${ticks} ≈ ${expected}`);
  assert.ok(peak > BLOCK.top && peak < 1.6, `peak ${peak}`);
  const again = fixture(); stepSim(again, ['JUMP']); let t2 = 1; while (again.mode === 'JUMP') { stepSim(again); t2++; }
  assert.equal(t2, ticks);
});

test('H no double jump in mid-air', () => {
  const s = fixture();
  stepSim(s, ['JUMP']); run(s, 5);
  const vy = s.vy;
  stepSim(s, ['JUMP']);
  assert.ok(s.vy < vy, 'velocity keeps falling');
  const single = fixture(); stepSim(single, ['JUMP']); run(single, 6);
  assert.deepEqual([s.y, s.vy], [single.y, single.vy]);
});

test('I slide lasts exactly SLIDE_TICKS ticks and holding/repeating cannot extend it', () => {
  const s = fixture();
  stepSim(s, ['SLIDE']);
  let sliding = 1;
  for (let i = 0; i < 100; i++) { stepSim(s, ['SLIDE']); if (s.mode === 'SLIDE') sliding++; else break; } // repeated presses ignored
  assert.equal(sliding, SLIDE_TICKS);
  assert.equal(s.mode, 'RUN');
});

test('J jump/slide rules: slide in the air ignored, jump cancels a slide', () => {
  const a = fixture();
  stepSim(a, ['JUMP']); stepSim(a, ['SLIDE']);
  assert.equal(a.mode, 'JUMP');
  const b = fixture();
  stepSim(b, ['SLIDE']); run(b, 5); stepSim(b, ['JUMP']);
  assert.deepEqual([b.mode, b.slideTicks], ['JUMP', 0]);
  assert.ok(b.y > 0);
});

test('K same-lane obstacle ends the run', () => {
  for (const type of ['BLOCK', 'HIGH_GATE']) {
    const s = fixture({ obstacles: [{ type, lane: 1, z: 10 }] });
    run(s, ticksTo(12));
    assert.equal(s.status, 'GAME_OVER', type);
    assert.deepEqual(s.crash, { obstacleId: 100, type });
    assert.ok(s.distance < 10, 'stopped at the obstacle');
  }
});

test('L obstacles in other lanes never collide', () => {
  const s = fixture({ obstacles: [{ type: 'BLOCK', lane: 0, z: 10 }, { type: 'HIGH_GATE', lane: 2, z: 12 }] });
  run(s, ticksTo(20));
  assert.equal(s.status, 'RUNNING');
});

test('M jump clears a BLOCK when timed; early and late jumps still collide; a jump never clears a HIGH_GATE', () => {
  const jumpAt = (type, ahead) => {
    const s = fixture({ obstacles: [{ type, lane: 1, z: 10 }] });
    run(s, ticksTo(10 - ahead)); stepSim(s, ['JUMP']); run(s, ticksTo(ahead + 3));
    return s.status;
  };
  assert.equal(jumpAt('BLOCK', 4), 'RUNNING');
  assert.equal(jumpAt('BLOCK', 3), 'RUNNING');
  assert.equal(jumpAt('BLOCK', 1.6), 'GAME_OVER', 'late jump');
  assert.equal(jumpAt('BLOCK', 7), 'GAME_OVER', 'early jump lands on it');
  assert.equal(jumpAt('HIGH_GATE', 4), 'GAME_OVER');
});

test('N slide clears a HIGH_GATE when timed; too early still collides; a slide never clears a BLOCK', () => {
  const slideAt = (type, ahead) => {
    const s = fixture({ obstacles: [{ type, lane: 1, z: 10 }] });
    run(s, ticksTo(10 - ahead)); stepSim(s, ['SLIDE']); run(s, ticksTo(ahead + 3));
    return s.status;
  };
  assert.equal(slideAt('HIGH_GATE', 4), 'RUNNING');
  assert.equal(slideAt('HIGH_GATE', 1), 'RUNNING');
  assert.equal(slideAt('HIGH_GATE', 9), 'GAME_OVER', 'slide over before the gate');
  assert.equal(slideAt('BLOCK', 4), 'GAME_OVER');
  assert.ok(HIGH_GATE.bottom > 0.7 && HIGH_GATE.bottom < 1.6);
});

test('O a shard is collected once, only in its lane', () => {
  const s = fixture({ shards: [{ lane: 1, z: 5 }, { lane: 0, z: 6 }] });
  run(s, ticksTo(4)); // 1 m before the shard: boxes (0.4 + 0.35) do not overlap yet
  assert.equal(s.shardsCollected, 0);
  run(s, ticksTo(1)); // several ticks overlap the shard box
  assert.equal(s.shardsCollected, 1);
  assert.deepEqual(s.shards.map(x => x.collected), [true, false]);
  run(s, ticksTo(3));
  assert.equal(s.shardsCollected, 1, 'already collected shard ignored');
  assert.equal(score(s), Math.floor(s.distance) + SHARD_POINTS);
});

test('P GAME_OVER freezes the simulation completely', () => {
  const s = fixture({ obstacles: [{ type: 'BLOCK', lane: 1, z: 10 }] });
  run(s, ticksTo(12));
  const frozen = checksum(s);
  run(s, 300, Object.fromEntries(Array.from({ length: 300 }, (_, i) => [s.tick + i, ['LEFT', 'JUMP', 'START']])));
  assert.equal(checksum(s), frozen);
});

test('Q restart = a fresh state: no old obstacles, shards, crash or counters', () => {
  const s = run(createSim(SEED), 1200, script(3, 1200));
  const fresh = createSim(999);
  assert.deepEqual([fresh.status, fresh.tick, fresh.distance, fresh.shardsCollected, fresh.crash, fresh.lane, fresh.mode], ['READY', 0, 0, 0, null, 1, 'RUN']);
  assert.ok(fresh.obstacles.every(o => !s.obstacles.some(p => p === o)));
  assert.ok(fresh.obstacles.every(o => o.z >= START_SAFE_Z));
});

test('R same-seed restart reproduces the same opening course', () => {
  const first = createSim(SEED);
  run(first, 500, script(4, 500));
  assert.deepEqual(createSim(SEED), createSim(SEED));
  assert.deepEqual(createSim(SEED).obstacles, createSim(first.seed).obstacles);
});

test('S fairness invariants hold over 300 seeds × 1.5 km of generated course', () => {
  for (let seed = 0; seed < 300; seed++) {
    const s = createSim(seed * 7919 + 1);
    generateCourse(s, 1500);
    const rows = new Map();
    for (const o of s.obstacles) rows.set(o.z, [...(rows.get(o.z) ?? []), o]);
    const zs = [...rows.keys()].sort((a, b) => a - b);
    assert.ok(zs[0] >= START_SAFE_Z);
    for (const [z, row] of rows) {
      assert.ok(row.length >= 1 && row.length <= 2, `row at ${z} blocks ${row.length} lanes`);
      assert.equal(new Set(row.map(o => o.lane)).size, row.length);
      assert.ok(row.every(o => o.type === 'BLOCK' || o.type === 'HIGH_GATE'));
    }
    for (let i = 1; i < zs.length; i++) {
      const gap = zs[i] - zs[i - 1];
      assert.ok(gap >= MIN_ROW_GAP && gap <= MAX_ROW_GAP && Number.isInteger(gap), `gap ${gap}`);
    }
    for (const shard of s.shards) {
      assert.ok(zs.every(z => Math.abs(shard.z - z) >= SHARD_MARGIN), `shard at ${shard.z} too close to a row`);
    }
  }
});

function longRun(seed, ticks) {
  const s = createSim(seed);
  const autopilot = createAutopilot(seed ^ 0x5eed);
  const play = () => autopilot(s);
  let maxObstacles = 0, maxShards = 0, laneChanges = 0, jumps = 0, slides = 0, lastLane = s.lane;
  for (let i = 0; i < ticks && s.status !== 'GAME_OVER'; i++) {
    const commands = play();
    if (commands.includes('JUMP')) jumps++;
    if (commands.includes('SLIDE')) slides++;
    stepSim(s, commands);
    if (s.lane !== lastLane) { laneChanges++; lastLane = s.lane; }
    maxObstacles = Math.max(maxObstacles, s.obstacles.length);
    maxShards = Math.max(maxShards, s.shards.length);
    for (const v of [s.distance, s.y, s.vy, playerX(s)]) assert.ok(Number.isFinite(v), `non-finite at tick ${s.tick}`);
    assert.ok([0, 1, 2].includes(s.lane) && [0, 1, 2].includes(s.laneTo) && s.laneProgress >= 0 && s.laneProgress < LANE_CHANGE_TICKS);
    assert.ok(s.y >= 0 && ['RUN', 'JUMP', 'SLIDE'].includes(s.mode) && (s.mode !== 'SLIDE' || s.y === 0));
  }
  return { s, maxObstacles, maxShards, laneChanges, jumps, slides };
}

test('T + long run: 10 simulated minutes, bounded entities, finite state, reproducible checksum', () => {
  const ticks = 10 * 60 * TICK_RATE;
  const started = performance.now();
  const a = longRun(SEED, ticks);
  const elapsedMs = performance.now() - started;
  const b = longRun(SEED, ticks);
  assert.equal(a.s.status, 'RUNNING', `bot crashed at tick ${a.s.tick}: ${JSON.stringify(a.s.crash)}`);
  assert.equal(a.s.tick, ticks);
  assert.equal(a.s.distance, 10 * 60 * SPEED);
  assert.equal(checksum(a.s), checksum(b.s));
  // bound: rows within [distance − PRUNE_BEHIND, distance + HORIZON + one gap], ≤ 2 obstacles and ≤ 5 shards each
  const rowBound = Math.ceil((HORIZON + PRUNE_BEHIND + MAX_ROW_GAP) / MIN_ROW_GAP) + 1;
  assert.ok(a.maxObstacles <= 2 * rowBound && a.maxShards <= 5 * rowBound, JSON.stringify({ maxObstacles: a.maxObstacles, maxShards: a.maxShards, rowBound }));
  assert.ok(a.s.obstacles.every(o => o.z >= a.s.distance - PRUNE_BEHIND));
  assert.ok(a.laneChanges > 20 && a.jumps > 50 && a.slides > 50, JSON.stringify({ laneChanges: a.laneChanges, jumps: a.jumps, slides: a.slides }));
  console.log(`# long run: ${ticks} ticks (10 simulated min) in ${elapsedMs.toFixed(0)} ms; checksum ${checksum(a.s)}; shards ${a.s.shardsCollected}; max entities ${a.maxObstacles}/${a.maxShards}; lane changes ${a.laneChanges}, jumps ${a.jumps}, slides ${a.slides}`);
  for (const seed of [1, 42, 0xdeadbeef]) assert.equal(longRun(seed, 2 * 60 * TICK_RATE).s.status, 'RUNNING', `seed ${seed} survivable`);
});

test('loop: fixed 1/60 s steps, bounded catch-up, no time accumulated across reset', () => {
  let n = 0;
  const loop = createFixedStepper(() => { n++; });
  assert.equal(loop.frame(1000), 0, 'first frame only records the time');
  assert.equal(loop.frame(1000 + STEP_MS), 1);
  assert.equal(loop.frame(1000 + STEP_MS * 1.5), 0);
  assert.equal(loop.frame(1000 + STEP_MS * 2), 1);
  assert.equal(loop.frame(1000 + STEP_MS * 2 + 16.6), 1, 'a 16.6 ms vsync frame is one step, not 0 then 2');
  // a 5 s stall counts as 100 ms: 5 steps now, at most one more step of backlog, never 300 catch-up ticks
  assert.equal(loop.frame(6000), MAX_STEPS_PER_FRAME);
  assert.ok(loop.frame(6000 + 1) <= 1, 'no hidden backlog left');
  assert.ok(MAX_FRAME_DELTA_MS <= (MAX_STEPS_PER_FRAME + 1) * STEP_MS + 1e-9, "the cap leaves at most one step of backlog");
  const flood = createFixedStepper(() => {}); // a pathological 1 s per frame clock still runs ≤ 5 steps per frame
  flood.frame(0); for (let t = 1000; t <= 10_000; t += 1000) assert.equal(flood.frame(t), MAX_STEPS_PER_FRAME);
  loop.reset();
  assert.equal(loop.frame(60_000), 0, 'after reset (pause → resume) nothing accumulated');
  // 60 frames at 16.67 ms = 60 steps; at 8.33 ms (120 Hz) also 60 steps per second
  const count = interval => { const l = createFixedStepper(() => { n++; }); const before = n; l.frame(0); for (let t = interval; t <= 1000 + 1e-9; t += interval) l.frame(t); return n - before; };
  assert.equal(count(1000 / 60), 60);
  assert.ok(Math.abs(count(1000 / 120) - 60) <= 1);
  assert.ok(Math.abs(count(1000 / 30) - 60) <= 1);
});

test('input: mapping, auto-repeat and chords ignored, per-tick queue bounded', () => {
  const key = (code, extra = {}) => actionForKey({ code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
  assert.deepEqual(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD', 'ArrowUp', 'KeyW', 'Space', 'ArrowDown', 'KeyS', 'Enter'].map(c => key(c)), ['LEFT', 'LEFT', 'RIGHT', 'RIGHT', 'JUMP', 'JUMP', 'JUMP', 'SLIDE', 'SLIDE', 'CONFIRM']);
  for (const code of ['KeyQ', 'Tab', 'Escape', 'F5', 'toString', '__proto__']) assert.equal(key(code), null, code);
  assert.equal(key('ArrowLeft', { repeat: true }), null);
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(key('KeyA', { [mod]: true }), null);
  const q = createCommandQueue();
  for (let i = 0; i < 50; i++) q.push('LEFT');
  assert.equal(q.take().length, MAX_COMMANDS_PER_TICK);
  assert.deepEqual(q.take(), []);
});
