// [VISUAL-4] Synapse Run — « Horizon fracturé », the visual universe of section 4 (Core Transit, 2200 → 3500 m).
// Same rules and kit as universes 1–3 (world-dawn.ts, world-city.ts, world-forest.ts): decoration only, nothing in the
// play volume (beside the track beyond |x| = 3.9 m, under the lane surface, or on the backdrop), nothing above the
// lanes, never the obstacle pink (#ff4fa3) or amber (#ffb547) near the track, no shard shape; 2 draw calls with the
// kit's materials and box: its only own geometry is its backdrop.
//   * backdrop — a digital world breaking up at sunset: rosy haze, a bordeaux-to-orange glow above the haze line,
//                indigo night above; a setting sun cut into shifted slices (on the left: the dawn rose on the right);
//                floating shard islands with golden rims and broken angular monoliths on the horizon; dark bordeaux
//                soil with orange, rose and golden perspective lines; fog baked like universe 1
//   * city     — floating islands (tilted violet slabs with a golden rim and two hanging orchid crystals, their
//                orange or rose glint on the soil), broken monoliths (two tilted pieces split by a glowing seam, leaning
//                away from the track), geometric tiles on the soil, speed streaks, impulses along the lines. Rotated
//                instances of the kit's box through an own placement helper (the kit is unchanged), like the forest
//   * no pop-in: created half-way through the 90 m blend from the forest (worlds.ts); pieces placed then only ≥ REVEAL m
//     ahead; sky haze up to HAZE_TOP, above every floating piece, every bright backdrop piece above that line
//   * leaving the section: section 5 has no universe yet, so the horizon melts into section 5's original colours over
//     the whole 90 m blend and is retired; world-anchored pieces stop before 3500 m
//   * no flicker: colours fixed per piece. Reduced motion: no streaks and no impulses. Software renderer: no impulses.
//     When only the impulses move, only their slice of the instance buffer is uploaded
import { CircleGeometry, Color, Euler, Object3D, PlaneGeometry, Vector3, type BufferGeometry, type Scene } from 'three';
import { SECTIONS } from './sections.ts';
import { LANE_WIDTH } from './simulation.ts';
import {
  FLOOR_Y, SKY_HALF_WIDTH, SKY_Z, createBackdrop, createCityLayer, flat, floorStrip, hash, mergeParts, paint, skyStrip,
  type World, type WorldKit, type WorldOptions,
} from './world-kit.ts';

export const HORIZON_START = SECTIONS[3].start, HORIZON_END = SECTIONS[4].start;

// islands ≤ ~16.5 m, monoliths ≤ ~20 m (checked by worlds-check-phase4.mjs): below the haze line
const HAZE_TOP = 21;
/** pieces placed at creation start this far ahead: view depth beyond the fog far plane (95 m), i.e. fully fogged */
const REVEAL = 92;

export const HORIZON = {
  /** background and fog colour of section 4: a slightly rosy dusk haze */
  haze: 0x2a1226,
  lanes: [0x1c0b18, 0x240f20, 0x1c0b18],
  /** lit lane: more distinct than the original (1.22:1 vs 1.20:1); pink block on it 4.87:1 (original 4.45:1) */
  laneActive: 0x3a1b42,
  /** sky stops [height m on the backdrop, colour]: pure haze up to HAZE_TOP, bordeaux, orange glow, rose, indigo night */
  sky: [[-30, 0x2a1226], [HAZE_TOP, 0x2a1226], [23.5, 0x5a1a3a], [26, 0xc85a3a], [29, 0xe88a48], [32.5, 0xb0406a], [41, 0x581e5c], [60, 0x281046], [100, 0x0e0726]],
  sunLow: 0xff7a3a, sunHigh: 0xffd27a, silhouette: 0x341430, shard: 0x3a1840, gold: 0xd9a85a,
  ground: 0x1a0712, bed: 0x0c0308, lines: [0xc8582a, 0xa83a68, 0x7a5a26],
  island: [0x3a1a4a, 0x4e2458], rim: 0xc9a54e, crystal: [0xd77ae0, 0xb48aff], glint: [0x6a2e24, 0x5e2440],
  monolith: [0x2a1236, 0x381a48], seam: 0xff7a3a, tile: 0x4a2a3a, streak: 0xb48ae0, pulse: 0xff9a7a,
} as const;

const SUN = { x: -50, y: 30, radius: 9, slices: 9 };
const LINE_X = [8, 13, 20];
const ISLANDS = 20, ISLAND_SPACING = 20, CRYSTALS_PER_ISLAND = 2;
const MONOLITHS = 16, MONOLITH_SPACING = 24, MONOLITH_GAP = 0.7;
const TILES = 24, TILE_SPACING = 7;
const STREAKS = 16, STREAK_SPACING = 9;
const PULSES = 12, PULSE_SPEED = 18, PULSE_RUN = 110;
// instance layout of the city mesh
const BODY_AT = 0, RIM_AT = BODY_AT + ISLANDS, CRYSTAL_AT = RIM_AT + ISLANDS, GLINT_AT = CRYSTAL_AT + ISLANDS * CRYSTALS_PER_ISLAND;
const LOW_AT = GLINT_AT + ISLANDS, SEAM_AT = LOW_AT + MONOLITHS, UP_AT = SEAM_AT + MONOLITHS, TILE_AT = UP_AT + MONOLITHS;
const STREAK_AT = TILE_AT + TILES, PULSE_AT = STREAK_AT + STREAKS, COUNT = PULSE_AT + PULSES;

const tmp = new Color(), tmp2 = new Color();

/** Floating shard: an inverted triangle with a golden rim along its flat top (backdrop pieces, above the haze line). */
function shard(parts: BufferGeometry[], x: number, y: number, r: number, tilt = 0): void {
  parts.push(paint(new CircleGeometry(r, 3).rotateZ(-Math.PI / 2 + tilt).translate(x, y, SKY_Z - 2.5), flat(HORIZON.shard)));
  if (tilt === 0) parts.push(paint(new PlaneGeometry(Math.sqrt(3) * r, 0.35).translate(x, y + r / 2 + 0.17, SKY_Z - 2.45), flat(HORIZON.gold)));
}

function backdropGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [skyStrip(HORIZON.sky)];
  // the setting sun, cut into horizontal slices shifted sideways: the fracture of the horizon
  for (let k = 0; k < SUN.slices; k++) {
    const y = SUN.y - SUN.radius + 1 + 2 * k, half = Math.sqrt(Math.max(0, SUN.radius ** 2 - (y - SUN.y) ** 2));
    parts.push(paint(new PlaneGeometry(2 * half, 1.7).translate(SUN.x + ((k % 3) - 1) * 0.9, y, SKY_Z - 1),
      (out, py) => { out.setHex(HORIZON.sunLow).lerp(tmp2.setHex(HORIZON.sunHigh), (py - SUN.y + SUN.radius) / (2 * SUN.radius)); }));
  }
  // floating islands far above the horizon, each with a broken-off splinter
  for (let k = 0; k < 8; k++) {
    const side = k & 1 ? 1 : -1, x = side * (35 + hash(k + 0.1) * 150), y = 33 + hash(k + 0.2) * 16, r = 3 + hash(k + 0.3) * 5;
    shard(parts, x, y, r);
    shard(parts, x + side * r * 1.1, y - r * 0.2, r * 0.45, 0.4);
  }
  // broken angular monoliths and peaks on the horizon, none within 26 m of the axis (where far obstacles appear)
  for (const side of [-1, 1]) {
    for (let x = 26, n = side * 7000; x < SKY_HALF_WIDTH - 20; n++) {
      if (hash(n + 0.5) < 0.4) {
        const r = 4 + hash(n) * 6;
        parts.push(paint(new CircleGeometry(r, 3).rotateZ(Math.PI / 2).translate(side * (x + r), -0.5, SKY_Z - 3), flat(HORIZON.silhouette)));
        x += 1.6 * r + 0.5;
      } else {
        const width = 3 + hash(n) * 4, height = (6 + hash(n + 0.25) * 18) * (hash(n + 0.75) > 0.82 ? 1.4 : 1);
        parts.push(paint(new PlaneGeometry(width, height + 1).rotateZ((hash(n + 0.33) - 0.5) * 0.4).translate(side * (x + width / 2), (height - 1) / 2, SKY_Z - 3), flat(HORIZON.silhouette)));
        x += width + 0.4 + hash(n + 0.66) * 2;
      }
    }
  }
  // dark bordeaux soil, track bed and the orange, rose and golden perspective lines
  parts.push(paint(floorStrip(2 * SKY_HALF_WIDTH, 0, FLOOR_Y), flat(HORIZON.ground)));
  parts.push(paint(floorStrip(3 * LANE_WIDTH + 1.2, 0, -0.06), flat(HORIZON.bed)));
  for (const side of [-1, 1]) LINE_X.forEach((x, i) => parts.push(paint(floorStrip(0.14, side * x, FLOOR_Y + 0.03), flat(HORIZON.lines[i]))));
  return mergeParts(parts, 'HORIZON_BACKDROP_MERGE');
}

export function createHorizonWorld(kit: WorldKit, scene: Scene, options: WorldOptions): World {
  let motion = !options.reducedMotion;
  // pieces nearer than REVEAL at creation would pop in: they are never placed
  const revealFrom = Math.max(HORIZON_START, options.from + REVEAL);
  const backdrop = createBackdrop(kit, scene, backdropGeometry());
  const city = createCityLayer(kit, scene, COUNT);
  const { mesh, hide } = city;
  const colorAt = (i: number, hex: number) => mesh.setColorAt(i, tmp.setHex(hex));
  for (let i = RIM_AT; i < CRYSTAL_AT; i++) colorAt(i, HORIZON.rim);
  for (let i = SEAM_AT; i < UP_AT; i++) colorAt(i, HORIZON.seam);
  for (let i = TILE_AT; i < STREAK_AT; i++) colorAt(i, HORIZON.tile);
  for (let i = STREAK_AT; i < PULSE_AT; i++) colorAt(i, HORIZON.streak);
  for (let i = PULSE_AT; i < COUNT; i++) colorAt(i, HORIZON.pulse);
  // like the kit's put, plus a rotation: the box turns about its base centre (Euler XYZ, as Object3D)
  const dummy = new Object3D(), turn = new Euler(), offset = new Vector3();
  const put = (i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rz = 0) => {
    dummy.position.set(x, y, z); dummy.rotation.set(0, ry, rz); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
  };
  /** the point `height` up a piece's own (tilted) axis: where the next piece of a stack sits */
  const above = (height: number, ry: number, rz: number) => offset.set(0, height, 0).applyEuler(turn.set(0, ry, rz));
  const placeable = (front: number, back: number) => front >= revealFrom && back < HORIZON_END;

  let islandBase = Number.NaN, monolithBase = Number.NaN, tileBase = Number.NaN, streakBase = Number.NaN, pulsesShown = true;
  const placeIslands = (distance: number): boolean => {
    const first = Math.floor(distance / ISLAND_SPACING) - 1;
    if (first === islandBase) return false;
    islandBase = first;
    for (let i = 0; i < ISLANDS; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 20011;
      // outer band (≥ 31.8 m with any turn), beyond the monoliths' leaning tops (≤ 31.1 m): they never cross
      const z = row * ISLAND_SPACING + hash(n) * 8, x = side * (36 + hash(n + 0.4) * 8), y = FLOOR_Y + 7 + hash(n + 0.3) * 6;
      const w = 3 + hash(n + 0.1) * 3, t = 1.2 + hash(n + 0.2) * 1.2, d = 3 + hash(n + 0.6) * 3;
      const ry = hash(n + 0.7) * Math.PI, rz = (hash(n + 0.8) - 0.5) * 0.5, crystals = CRYSTAL_AT + i * CRYSTALS_PER_ISLAND;
      if (!placeable(z - 4.5, z + 4.5)) {
        hide(BODY_AT + i); hide(RIM_AT + i); hide(GLINT_AT + i);
        for (let k = 0; k < CRYSTALS_PER_ISLAND; k++) hide(crystals + k);
        continue;
      }
      // colours follow the island (its row), not the recycled instance slot; fixed, never animated
      const tone = hash(n + 0.5) < 0.5 ? 0 : 1;
      put(BODY_AT + i, x, y, z, w, t, d, ry, rz);
      mesh.setColorAt(BODY_AT + i, tmp.setHex(HORIZON.island[0]).lerp(tmp2.setHex(HORIZON.island[1]), hash(n + 0.9)));
      const top = above(t, ry, rz);
      put(RIM_AT + i, x + top.x, y + top.y, z + top.z, w * 1.02, 0.12, d * 1.02, ry, rz); // golden rim on the top face
      // two orchid crystals hanging under the island (rotated by π: they grow downward), never below 3.5 m
      for (let k = 0; k < CRYSTALS_PER_ISLAND; k++) {
        const m = n + 0.13 * (k + 1), length = 1.4 + hash(m) * 1.6;
        put(crystals + k, x + (k ? 0.2 : -0.2) * w, y + 0.15, z + (k ? 0.15 : -0.15) * d, 0.4, length, 0.4, hash(m + 0.2) * Math.PI, Math.PI + (hash(m + 0.4) - 0.5) * 0.4);
        colorAt(crystals + k, HORIZON.crystal[tone]);
      }
      // the island's orange or rose glint on the soil, running toward the viewer
      put(GLINT_AT + i, x - side * w * 0.3, FLOOR_Y + 0.012, z - 3, 0.3, 0.012, 6);
      colorAt(GLINT_AT + i, HORIZON.glint[tone]);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  };
  const placeMonoliths = (distance: number): boolean => {
    const first = Math.floor(distance / MONOLITH_SPACING) - 1;
    if (first === monolithBase) return false;
    monolithBase = first;
    for (let i = 0; i < MONOLITHS; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 22003;
      const z = row * MONOLITH_SPACING + hash(n) * 10, x = side * (22 + hash(n + 0.4) * 5);
      if (!placeable(z - 3, z + 3)) { hide(LOW_AT + i); hide(SEAM_AT + i); hide(UP_AT + i); continue; }
      const w = 1.8 + hash(n + 0.1), d = 1.8 + hash(n + 0.2), low = 5 + hash(n + 0.3) * 6, high = 3 + hash(n + 0.6) * 5;
      // both pieces lean away from the track (negative side tilt about z), the upper one more: a broken column
      const ry = hash(n + 0.7) * 0.6, rz = -side * (0.03 + hash(n + 0.8) * 0.05), rz2 = rz - side * (0.04 + hash(n + 0.9) * 0.06);
      put(LOW_AT + i, x, FLOOR_Y, z, w, low, d, ry, rz);
      const seam = above(low, ry, rz);
      put(SEAM_AT + i, x + seam.x, FLOOR_Y + seam.y, z + seam.z, w * 1.06, 0.16, d * 1.06, ry, rz); // the glowing fracture
      const upper = above(low + MONOLITH_GAP, ry, rz);
      put(UP_AT + i, x + upper.x + side * 0.35, FLOOR_Y + upper.y, z + upper.z, w * 0.92, high, d * 0.92, ry + 0.3, rz2);
      const shade = hash(n + 0.5);
      mesh.setColorAt(LOW_AT + i, tmp.setHex(HORIZON.monolith[0]).lerp(tmp2.setHex(HORIZON.monolith[1]), shade));
      mesh.setColorAt(UP_AT + i, tmp.setHex(HORIZON.monolith[0]).lerp(tmp2.setHex(HORIZON.monolith[1]), 1 - shade));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  };
  const placeTiles = (distance: number): boolean => {
    const first = Math.floor(distance / TILE_SPACING) - 1;
    if (first === tileBase) return false;
    tileBase = first;
    for (let i = 0; i < TILES; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 24007, z = row * TILE_SPACING + hash(n) * 3;
      if (!placeable(z - 0.5, z + 0.5)) hide(TILE_AT + i);
      else put(TILE_AT + i, side * (8.5 + hash(n + 0.1) * 9), FLOOR_Y + 0.012, z, 0.6, 0.012, 0.6, Math.PI / 4); // diamonds
    }
    return true;
  };
  const placeStreaks = (distance: number): boolean => {
    const first = Math.floor(distance / STREAK_SPACING) - 1;
    if (first === streakBase) return false;
    streakBase = first;
    for (let i = 0; i < STREAKS; i++) {
      const row = first + (i >> 1), n = row * 2 + (i & 1) + 26003, z = row * STREAK_SPACING + hash(n) * 4;
      const length = 1.6 + hash(n + 0.3) * 1.4;
      if (!motion || !placeable(z - length / 2, z + length / 2)) hide(STREAK_AT + i);
      else put(STREAK_AT + i, (i & 1 ? 1 : -1) * (4.05 + hash(n + 0.1) * 0.55), 0.45 + hash(n + 0.2) * 2.2, z, 0.035, 0.035, length);
    }
    return true;
  };
  // impulses along the perspective lines toward the horizon, entering from behind the camera, growing in, and
  // shrinking with the fade
  const placePulses = (distance: number, timeMs: number, animate: boolean, size: number) => {
    for (let j = 0; j < PULSES; j++) {
      if (!animate) { hide(PULSE_AT + j); continue; }
      const travelled = ((timeMs / 1000) * PULSE_SPEED + j * 33) % PULSE_RUN;
      put(PULSE_AT + j, (j & 1 ? 1 : -1) * LINE_X[(j >> 1) % LINE_X.length], FLOOR_Y + 0.034, distance - 8 + travelled, 0.18, 0.012, 2.2 * size * Math.min(1, travelled / 10));
    }
  };

  return {
    update(distance, timeMs, fade, haze) {
      const shown = fade < 1;
      backdrop.setVisible(shown); mesh.visible = shown;
      if (!shown) return;
      backdrop.update(distance, fade, haze);
      let placed = placeIslands(distance);
      if (placeMonoliths(distance)) placed = true;
      if (placeTiles(distance)) placed = true;
      if (placeStreaks(distance)) placed = true;
      const animate = motion && !options.software;
      const pulsing = animate || pulsesShown;
      if (pulsing) { placePulses(distance, timeMs, animate, 1 - fade); pulsesShown = animate; }
      if (!placed && !pulsing) return;
      // only the impulses moved: upload just their slice (200 instances otherwise); a placement uploads everything
      mesh.instanceMatrix.clearUpdateRanges();
      if (!placed) mesh.instanceMatrix.addUpdateRange(PULSE_AT * 16, PULSES * 16);
      mesh.instanceMatrix.needsUpdate = true;
    },
    setReducedMotion(value) { motion = !value; streakBase = Number.NaN; },
    dispose() { backdrop.dispose(); city.dispose(); },
  };
}
