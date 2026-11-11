// [VISUAL-3] Synapse Run — « Forêt synaptique », the visual universe of section 3 (Synaptic Garden, 1200 → 2200 m).
// Same rules and kit as universes 1 and 2 (world-dawn.ts, world-city.ts): decoration only, nothing in the play volume
// (beside the track beyond |x| = 3.9 m, under the lane surface, or on the backdrop), nothing above the lanes, no
// obstacle colour (pink #ff4fa3, amber #ffb547), no shard shape or shard cyan near the track; 2 draw calls with the
// kit's materials and box: its only own geometry is its backdrop.
//   * backdrop — night blue sky tinted green, turquoise haze, an emerald glow on the horizon, a discreet neural network
//                of lines and nodes in the sky, distant canopies and a few giant tree silhouettes, dark soil with green
//                energy lines; fog baked like universe 1
//   * city     — neural trees: dark trunk with a turquoise edge, three geometric branches (two outward, one short
//                toward the track, all high above it) ending in small light nodes, two glowing roots on the soil; small
//                emerald crystals; discreet digital tiles on the ground; speed streaks; slow impulses along the energy
//                lines. Branches, roots and crystals are rotated instances of the same box (own placement helper; the
//                kit is unchanged)
//   * no pop-in: created half-way through the 90 m blend from the city (worlds.ts), pieces placed then only ≥ REVEAL m
//     ahead; sky haze up to HAZE_TOP, above every tree, every bright backdrop piece above that line
//   * leaving the section: section 4 has no universe yet, so the forest melts into section 4's original colours over
//     the whole 90 m blend and is retired; world-anchored pieces stop before 2200 m
//   * no flicker: colours fixed per tree. Reduced motion: no streaks and no impulses. Software renderer: no impulses.
//     The impulses alone move every frame: only their slice of the instance buffer is uploaded then
import { CircleGeometry, Color, Object3D, PlaneGeometry, type BufferGeometry, type Scene } from 'three';
import { SECTIONS } from './sections.ts';
import { LANE_WIDTH } from './simulation.ts';
import {
  FLOOR_Y, SKY_HALF_WIDTH, SKY_Z, createBackdrop, createCityLayer, flat, floorStrip, hash, mergeParts, paint, skyStrip,
  type World, type WorldKit, type WorldOptions,
} from './world-kit.ts';

export const FOREST_START = SECTIONS[2].start, FOREST_END = SECTIONS[3].start;

// trunks ≤ 13.7 m, branch lights ≤ ~15 m (checked by worlds-check.mjs): below the haze line
const HAZE_TOP = 18.5;
/** pieces placed at creation start this far ahead: view depth beyond the fog far plane (95 m), i.e. fully fogged */
const REVEAL = 92;

export const FOREST = {
  /** background and fog colour of section 3: turquoise haze */
  haze: 0x07232a,
  lanes: [0x091719, 0x0c1e21, 0x091719],
  /** lit lane: more distinct than the original (1.22:1 vs 1.20:1); pink block on it 4.60:1 (original 4.45:1) */
  laneActive: 0x133033,
  /** sky stops [height m on the backdrop, colour]: pure haze up to HAZE_TOP, emerald horizon glow, green-tinted night */
  sky: [[-30, 0x07232a], [HAZE_TOP, 0x07232a], [21, 0x0d4038], [24, 0x1f7a5c], [28, 0x175a5a], [38, 0x0c3346], [56, 0x081e33], [100, 0x040c1c]],
  network: 0x1e7d73, networkNode: 0x5fe8c8, canopy: 0x0b2c2f, glow: 0x6dffb0,
  ground: 0x041416, bed: 0x020a0c, lines: [0x1f9a6a, 0x14807f],
  trunk: [0x0a1c1f, 0x10282b], edge: 0x3fe0c8, branch: [0x2bbfa6, 0x37c77e], node: [0x5ff0d0, 0x6dff9e], root: [0x1fae78, 0x1c9c8c],
  crystal: 0x3fd99a, tile: 0x1b6b5e, streak: 0x3fbf9a, pulse: 0x5fe3d0,
} as const;

const LINE_X = [7, 11.5];
const TREES = 24, TREE_SPACING = 14, BRANCHES = 3, ROOTS = 2, ROOT_MAX = 6;
const CRYSTALS = 16, CRYSTAL_SPACING = 18;
const TILES = 24, TILE_SPACING = 7;
const STREAKS = 16, STREAK_SPACING = 9;
const PULSES = 12, PULSE_SPEED = 14, PULSE_RUN = 110;
// instance layout of the city mesh
const TRUNK_AT = 0, EDGE_AT = TRUNK_AT + TREES, BRANCH_AT = EDGE_AT + TREES, NODE_AT = BRANCH_AT + TREES * BRANCHES;
const ROOT_AT = NODE_AT + TREES * BRANCHES, CRYSTAL_AT = ROOT_AT + TREES * ROOTS, TILE_AT = CRYSTAL_AT + CRYSTALS;
const STREAK_AT = TILE_AT + TILES, PULSE_AT = STREAK_AT + STREAKS, COUNT = PULSE_AT + PULSES;

const tmp = new Color(), tmp2 = new Color();

function backdropGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [skyStrip(FOREST.sky)];
  // a discreet neural network in the sky, above the haze line: nodes joined to their neighbour
  for (const side of [-1, 1]) {
    let px = Number.NaN, py = 0;
    for (let k = 0, x = 30; k < 9; k++, x += 14 + hash(side * 50 + k) * 12) {
      const y = 25 + hash(side * 70 + k) * 22, sx = side * x;
      parts.push(paint(new CircleGeometry(0.6, 6).translate(sx, y, SKY_Z - 0.6), flat(FOREST.networkNode)));
      if (!Number.isNaN(px)) {
        const length = Math.hypot(sx - px, y - py);
        parts.push(paint(new PlaneGeometry(length, 0.22).rotateZ(Math.atan2(y - py, sx - px)).translate((sx + px) / 2, (y + py) / 2, SKY_Z - 0.5), flat(FOREST.network)));
      }
      px = sx; py = y;
    }
  }
  // distant canopies (domes in the haze band) and, now and then, a giant tree whose crown rises into the glow, with a
  // few lights above the haze line; none within 26 m of the axis (where far obstacles appear)
  for (const side of [-1, 1]) {
    for (let x = 26, n = side * 5000; x < SKY_HALF_WIDTH - 20; n++) {
      const r = 3.5 + hash(n) * 7;
      parts.push(paint(new CircleGeometry(r, 10, 0, Math.PI).translate(side * (x + r), -0.5, SKY_Z - 3), flat(FOREST.canopy)));
      if (hash(n + 0.5) > 0.78) {
        const cx = side * (x + r), height = 14 + hash(n + 0.25) * 8, crown = 4 + hash(n + 0.75) * 2;
        parts.push(paint(new PlaneGeometry(1.2, height + 1).translate(cx, (height - 1) / 2, SKY_Z - 3.05), flat(FOREST.canopy)));
        parts.push(paint(new CircleGeometry(crown, 10).translate(cx, height, SKY_Z - 3.05), flat(FOREST.canopy)));
        for (let k = 0; k < 2; k++) {
          const ly = Math.max(HAZE_TOP + 1, height + (hash(n + k + 0.6) - 0.3) * crown);
          parts.push(paint(new PlaneGeometry(0.5, 0.5).translate(cx + (hash(n + k + 0.9) - 0.5) * crown, ly, SKY_Z - 3.1), flat(FOREST.glow)));
        }
      }
      x += 1.5 * r + 0.5 + hash(n + 0.33) * 3;
    }
  }
  // dark soil, track bed and the green energy lines
  parts.push(paint(floorStrip(2 * SKY_HALF_WIDTH, 0, FLOOR_Y), flat(FOREST.ground)));
  parts.push(paint(floorStrip(3 * LANE_WIDTH + 1.2, 0, -0.06), flat(FOREST.bed)));
  for (const side of [-1, 1]) LINE_X.forEach((x, i) => parts.push(paint(floorStrip(0.14, side * x, FLOOR_Y + 0.03), flat(FOREST.lines[i]))));
  return mergeParts(parts, 'FOREST_BACKDROP_MERGE');
}

export function createForestWorld(kit: WorldKit, scene: Scene, options: WorldOptions): World {
  let motion = !options.reducedMotion;
  // pieces nearer than REVEAL at creation would pop in: they are never placed
  const revealFrom = Math.max(FOREST_START, options.from + REVEAL);
  const backdrop = createBackdrop(kit, scene, backdropGeometry());
  const city = createCityLayer(kit, scene, COUNT);
  const { mesh, hide } = city;
  const colorAt = (i: number, hex: number) => mesh.setColorAt(i, tmp.setHex(hex));
  for (let i = EDGE_AT; i < BRANCH_AT; i++) colorAt(i, FOREST.edge);
  for (let i = CRYSTAL_AT; i < TILE_AT; i++) colorAt(i, FOREST.crystal);
  for (let i = TILE_AT; i < STREAK_AT; i++) colorAt(i, FOREST.tile);
  for (let i = STREAK_AT; i < PULSE_AT; i++) colorAt(i, FOREST.streak);
  for (let i = PULSE_AT; i < COUNT; i++) colorAt(i, FOREST.pulse);
  // like the kit's put, plus a rotation (branches, roots, crystals): the box turns about its base centre
  const dummy = new Object3D();
  const put = (i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rz = 0) => {
    dummy.position.set(x, y, z); dummy.rotation.set(0, ry, rz); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
  };
  const placeable = (front: number, back: number) => front >= revealFrom && back < FOREST_END;

  let treeBase = Number.NaN, crystalBase = Number.NaN, tileBase = Number.NaN, streakBase = Number.NaN, pulsesShown = true;
  const placeTrees = (distance: number): boolean => {
    const first = Math.floor(distance / TREE_SPACING) - 1;
    if (first === treeBase) return false;
    treeBase = first;
    for (let i = 0; i < TREES; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 12011;
      const z = row * TREE_SPACING + hash(n) * 5, x = side * (22 + hash(n + 0.4) * 10);
      const h = 9 + hash(n + 0.3) * 5, width = 0.7 + hash(n + 0.1) * 0.4;
      if (!placeable(z - width / 2, z + ROOT_MAX)) {
        hide(TRUNK_AT + i); hide(EDGE_AT + i);
        for (let k = 0; k < BRANCHES; k++) { hide(BRANCH_AT + i * BRANCHES + k); hide(NODE_AT + i * BRANCHES + k); }
        for (let k = 0; k < ROOTS; k++) hide(ROOT_AT + i * ROOTS + k);
        continue;
      }
      // colours follow the tree (its row), not the recycled instance slot; fixed, never animated
      const tone = hash(n + 0.5) < 0.5 ? 0 : 1;
      put(TRUNK_AT + i, x, FLOOR_Y, z, width, h, width);
      mesh.setColorAt(TRUNK_AT + i, tmp.setHex(FOREST.trunk[0]).lerp(tmp2.setHex(FOREST.trunk[1]), hash(n + 0.8)));
      put(EDGE_AT + i, x - side * width / 2, FLOOR_Y, z - width / 2, 0.07, h, 0.07); // turquoise edge facing the track
      // branches: k = 0, 2 outward, k = 1 short and toward the track; each tilts by θ from vertical about its base
      for (let k = 0; k < BRANCHES; k++) {
        const m = n + 0.11 * (k + 1), outward = k !== 1, dir = outward ? side : -side;
        const theta = 0.55 + hash(m) * 0.35, length = outward ? 2.8 + hash(m + 0.2) * 1.8 : 1.6 + hash(m + 0.2) * 0.9;
        const y = FLOOR_Y + h * (0.45 + 0.17 * k), tipX = x + dir * length * Math.sin(theta), tipY = y + length * Math.cos(theta);
        put(BRANCH_AT + i * BRANCHES + k, x, y, z, 0.16, length, 0.16, 0, -dir * theta);
        put(NODE_AT + i * BRANCHES + k, tipX, tipY - 0.17, z, 0.34, 0.34, 0.34); // a small light at the tip
        colorAt(BRANCH_AT + i * BRANCHES + k, FOREST.branch[tone]);
        colorAt(NODE_AT + i * BRANCHES + k, FOREST.node[tone]);
      }
      // roots on the soil: one toward the track and the viewer, one outward and away (flat, below the lane surface)
      for (let k = 0; k < ROOTS; k++) {
        const length = 3 + hash(n + 0.6 + k * 0.1) * (ROOT_MAX - 3);
        const ry = k === 0 ? -side * (Math.PI / 2 + 0.5) : side * (0.6 + hash(n + 0.7) * 0.6);
        put(ROOT_AT + i * ROOTS + k, x + Math.sin(ry) * length / 2, FLOOR_Y + 0.012, z + Math.cos(ry) * length / 2, 0.12, 0.012, length, ry);
        colorAt(ROOT_AT + i * ROOTS + k, FOREST.root[tone]);
      }
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  };
  const placeCrystals = (distance: number): boolean => {
    const first = Math.floor(distance / CRYSTAL_SPACING) - 1;
    if (first === crystalBase) return false;
    crystalBase = first;
    for (let i = 0; i < CRYSTALS; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 14009, z = row * CRYSTAL_SPACING + hash(n) * 8;
      if (!placeable(z - 1, z + 1)) { hide(CRYSTAL_AT + i); continue; }
      const height = 0.7 + hash(n + 0.1) * 0.8, width = 0.35 + hash(n + 0.2) * 0.2;
      put(CRYSTAL_AT + i, side * (8.6 + hash(n + 0.3) * 1.8), FLOOR_Y, z, width, height, width, hash(n + 0.4) * Math.PI, side * (0.15 + hash(n + 0.5) * 0.25));
    }
    return true;
  };
  const placeTiles = (distance: number): boolean => {
    const first = Math.floor(distance / TILE_SPACING) - 1;
    if (first === tileBase) return false;
    tileBase = first;
    for (let i = 0; i < TILES; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 16001, z = row * TILE_SPACING + hash(n) * 3;
      if (!placeable(z - 0.4, z + 0.4)) hide(TILE_AT + i);
      else put(TILE_AT + i, side * (13 + hash(n + 0.1) * 7), FLOOR_Y + 0.012, z, 0.5, 0.012, 0.5, hash(n + 0.2) < 0.5 ? 0 : Math.PI / 4);
    }
    return true;
  };
  const placeStreaks = (distance: number): boolean => {
    const first = Math.floor(distance / STREAK_SPACING) - 1;
    if (first === streakBase) return false;
    streakBase = first;
    for (let i = 0; i < STREAKS; i++) {
      const row = first + (i >> 1), n = row * 2 + (i & 1) + 18013, z = row * STREAK_SPACING + hash(n) * 4;
      const length = 1.6 + hash(n + 0.3) * 1.4;
      if (!motion || !placeable(z - length / 2, z + length / 2)) hide(STREAK_AT + i);
      else put(STREAK_AT + i, (i & 1 ? 1 : -1) * (4.05 + hash(n + 0.1) * 0.55), 0.45 + hash(n + 0.2) * 2.2, z, 0.035, 0.035, length);
    }
    return true;
  };
  // slow impulses along the energy lines toward the horizon, entering from behind the camera, growing in, and
  // shrinking with the fade
  const placePulses = (distance: number, timeMs: number, animate: boolean, size: number) => {
    for (let j = 0; j < PULSES; j++) {
      if (!animate) { hide(PULSE_AT + j); continue; }
      const travelled = ((timeMs / 1000) * PULSE_SPEED + j * 31) % PULSE_RUN;
      put(PULSE_AT + j, (j & 1 ? 1 : -1) * LINE_X[(j >> 1) % LINE_X.length], FLOOR_Y + 0.034, distance - 8 + travelled, 0.18, 0.012, 2.2 * size * Math.min(1, travelled / 10));
    }
  };

  return {
    update(distance, timeMs, fade, haze) {
      const shown = fade < 1;
      backdrop.setVisible(shown); mesh.visible = shown;
      if (!shown) return;
      backdrop.update(distance, fade, haze);
      let placed = placeTrees(distance);
      if (placeCrystals(distance)) placed = true;
      if (placeTiles(distance)) placed = true;
      if (placeStreaks(distance)) placed = true;
      const animate = motion && !options.software;
      const pulsing = animate || pulsesShown;
      if (pulsing) { placePulses(distance, timeMs, animate, 1 - fade); pulsesShown = animate; }
      if (!placed && !pulsing) return;
      // only the impulses moved: upload just their slice (308 instances otherwise); a placement uploads everything
      mesh.instanceMatrix.clearUpdateRanges();
      if (!placed) mesh.instanceMatrix.addUpdateRange(PULSE_AT * 16, PULSES * 16);
      mesh.instanceMatrix.needsUpdate = true;
    },
    setReducedMotion(value) { motion = !value; streakBase = Number.NaN; },
    dispose() { backdrop.dispose(); city.dispose(); },
  };
}

