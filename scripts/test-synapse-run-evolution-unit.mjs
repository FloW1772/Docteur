import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { positionRunCamera } from '../src/arcade/synapse-run/camera.ts';
import { createSim, stepSim, playerX, laneX, checksum, generateCourse, LANE_CHANGE_TICKS, TICK_RATE, PRUNE_BEHIND } from '../src/arcade/synapse-run/simulation.ts';
import { SECTIONS, MAX_SPEED, REACTION_FLOOR, difficultyAt, sectionIndex } from '../src/arcade/synapse-run/sections.ts';
import { actionForKey, commandForButton } from '../src/arcade/synapse-run/input.ts';
import { swipeCommand } from '../src/arcade/synapse-run/gestures.ts';
import { createAutopilot } from '../src/arcade/synapse-run/autopilot.ts';
import { parseArcadeGameEvent, buildArcadeFullscreenState } from '../src/lib/arcade/protocol.ts';

test('fullscreen protocol: exit only, exact envelope, stale instances and extra capabilities rejected', () => {
  const expected = {gameId:'synapse-run',instanceId:'a'.repeat(32)};
  const exit = {channel:'docteur-arcade',v:1,type:'ARCADE_FULLSCREEN_EXIT',...expected,payload:{}};
  assert.deepEqual(parseArcadeGameEvent(exit,expected),exit);
  for (const change of [{instanceId:'b'.repeat(32)},{payload:{enter:true}},{type:'ARCADE_FULLSCREEN_ENTER'},{target:'parent'},{gameId:'other'}]) assert.equal(parseArcadeGameEvent({...exit,...change},expected),null);
  assert.deepEqual(buildArcadeFullscreenState(expected.gameId,expected.instanceId,true).payload,{fullscreen:true});
});

test('direction: real perspective projection, all adapters, all four lane transitions', () => {
  for (const aspect of [0.45, 1, 1.78]) for (const [start, action, target] of [[1,'LEFT',0],[1,'RIGHT',2],[0,'RIGHT',1],[2,'LEFT',1]]) {
    const sign = action === 'LEFT' ? -1 : 1;
    const codes = action === 'LEFT' ? ['ArrowLeft', 'KeyA'] : ['ArrowRight', 'KeyD'];
    const commands = [...codes.map(code => actionForKey({code})), commandForButton(action.toLowerCase()), swipeCommand(sign * 80, 0)];
    for (const command of commands) {
      const s = createSim(42); s.status = 'RUNNING'; s.lane = s.laneFrom = s.laneTo = start;
      s.obstacles = []; s.shards = []; s.nextRowZ = 1e9;
      const camera = new PerspectiveCamera(62, aspect, 0.1, 140);
      positionRunCamera(camera, 0);
      const project = x => new Vector3(x, 0.8, 0).project(camera).x;
      const before = project(playerX(s));
      stepSim(s, [command]); assert.equal(s.laneTo, target);
      assert.equal(Math.sign(playerX(s) - laneX(start)), sign, 'first tick responds');
      for (let t = 1; t < LANE_CHANGE_TICKS; t++) stepSim(s);
      assert.equal(playerX(s), laneX(target));
      assert.equal(Math.sign(project(playerX(s)) - before), sign, 'LEFT screen-left; RIGHT screen-right');
    }
  }
});

test('five zones, continuous speed, bounded difficulty and human reaction reserve', () => {
  assert.deepEqual(SECTIONS.map(s => s.start), [0,500,1200,2200,3500]);
  for (const [i,s] of SECTIONS.entries()) {
    assert.equal(sectionIndex(s.start), i);
    assert.ok(Math.abs(difficultyAt(s.start - 0.001).speed - difficultyAt(s.start + 0.001).speed) < 0.001);
  }
  for (let d = 0; d < 100000; d += 17) {
    const s = difficultyAt(d);
    assert.ok(s.speed >= 12 && s.speed <= MAX_SPEED);
    assert.ok(s.reaction >= REACTION_FLOOR);
  }
  assert.ok(REACTION_FLOOR - 2 * LANE_CHANGE_TICKS / TICK_RATE > 0.68, 'reaction after two lane changes');
});

test('1000 seeds: all tiers, full simulation to 4500 m, reachability and bounded state', () => {
  let rows = 0, maxObstacles = 0, maxShards = 0, ticks = 0;
  const tiers = [0,0,0,0,0];
  for (let seed = 0; seed < 1000; seed++) {
    const course = createSim(seed); generateCourse(course, 5000);
    const byRow = new Map();
    for (const o of course.obstacles) { if (!byRow.has(o.z)) byRow.set(o.z, []); byRow.get(o.z).push(o); }
    let previous = 0;
    for (const [z, row] of byRow) {
      rows++; tiers[sectionIndex(z)]++;
      const occupied = new Set(row.map(o => o.lane));
      assert.ok(occupied.size <= 2 && occupied.size === row.length);
      assert.ok(row.every(o => [0,1,2].includes(o.lane)));
      if (previous) {
        // Any free lane of the previous row can reach any free lane here, after clearing its collision envelope.
        const time = (z - previous - 1.8) / MAX_SPEED;
        assert.ok(time >= REACTION_FLOOR);
        assert.ok(time >= 0.68 + 2 * LANE_CHANGE_TICKS / TICK_RATE);
      }
      previous = z;
    }
    const state = createSim(seed), pilot = createAutopilot(seed ^ 0x5eed);
    while (state.distance < 4500 && state.status !== 'GAME_OVER' && state.tick < 25000) {
      stepSim(state, pilot(state)); ticks++;
      assert.ok(Number.isFinite(state.distance + state.y + state.vy + playerX(state) + state.speed));
      assert.ok(state.y >= 0 && state.laneProgress >= 0 && state.laneProgress < LANE_CHANGE_TICKS);
      assert.ok([0,1,2].includes(state.lane) && [0,1,2].includes(state.laneTo));
      assert.ok(['RUN','JUMP','SLIDE'].includes(state.mode) && (state.mode !== 'SLIDE' || state.y === 0));
      maxObstacles = Math.max(maxObstacles, state.obstacles.length); maxShards = Math.max(maxShards, state.shards.length);
    }
    assert.equal(state.status, 'RUNNING', `seed ${seed}, distance ${state.distance}, crash ${JSON.stringify(state.crash)}`);
    assert.ok(state.distance >= 4500);
    assert.ok(state.obstacles.every(o => o.z >= state.distance - PRUNE_BEHIND));
  }
  assert.ok(maxObstacles <= 12 && maxShards <= 30);
  const result = { seeds:1000, generatedDistance:5000, simulatedDistancePerSeed:4500, rows, tiers, ticks, unavoidableRows:0, invalidStates:0, nonFinite:0, maxObstacles, maxShards };
  fs.mkdirSync('.tmp/game7', {recursive:true}); fs.writeFileSync('.tmp/game7/fairness.json', JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
});

test('GAME-7 canonical: five independent 36000-tick replays; fixed checksum', () => {
  const results = [];
  for (let i = 0; i < 5; i++) {
    const s = createSim(20261021), pilot = createAutopilot(20261021 ^ 0x5eed);
    for (let t = 0; t < 36000; t++) stepSim(s, pilot(s));
    assert.equal(s.status, 'RUNNING'); assert.equal(s.tick, 36000);
    results.push(checksum(s));
  }
  assert.equal(new Set(results).size, 1);
  console.log('GAME-7 canonical', results);
  assert.equal(results[0], 'b7cfb3ec');
});
