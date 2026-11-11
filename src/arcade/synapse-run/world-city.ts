// [VISUAL-2] Synapse Run — « Cité des impulsions », the visual universe of section 2 (Data Tunnels, 500 → 1200 m).
// Same rules and kit as universe 1 (world-dawn.ts): decoration only, nothing in the play volume (beside the track
// beyond |x| = 3.9 m, under the lane surface, or on the backdrop), nothing above the lanes, no obstacle colour (pink
// #ff4fa3, amber #ffb547), no shard shape; 2 draw calls with the kit's materials and box: its only own geometry is
// its backdrop.
//   * backdrop — violet night with a magenta city glow above the haze line, searchlight beams, a dense horizon skyline
//                with lit windows, wet ground with neon lines, the reflections of the elevated rails, and two elevated
//                light rails per side (« lignes électriques »); fog baked like universe 1
//   * city     — towers of violet glass with a neon edge, two neon bands and, on some, a sign panel facing the track
//                (flat colour, no text); their reflection on the wet ground; a far row of towers; speed streaks; and
//                the impulses that give the universe its name, running along the rails and the ground lines
//   * no pop-in: the director creates this universe half-way through the 90 m blend, when the dawn has melted into the
//     zone colour; only pieces already deep in the fog (≥ REVEAL m ahead) are placed then. The sky stays haze up to
//     HAZE_TOP, above every tower, and every bright backdrop piece (beams, windows) sits above that line, so towers
//     recycled at the far end always appear against haze
//   * no flicker, no blinking neon: colours are fixed per tower. Reduced motion: no streaks and no impulses. Software
//     renderer: no impulses
import { Color, PlaneGeometry, type BufferGeometry, type Scene } from 'three';
import { SECTIONS } from './sections.ts';
import { LANE_WIDTH } from './simulation.ts';
import {
  FLOOR_Y, SKY_HALF_WIDTH, SKY_Z, createBackdrop, createCityLayer, flat, floorStrip, gradient, hash, mergeParts, paint,
  skyStrip, wallStrip, type World, type WorldKit, type WorldOptions,
} from './world-kit.ts';

export const CITY_START = SECTIONS[1].start, CITY_END = SECTIONS[2].start;

const HAZE_TOP = 22.5, TOWER_MAX = 22;
/** pieces placed at creation start this far ahead: view depth beyond the fog far plane (95 m), i.e. fully fogged */
const REVEAL = 92;

export const CITY = {
  /** background and fog colour of section 2 */
  haze: 0x140c30,
  lanes: [0x170f31, 0x1e1440, 0x170f31],
  /** lit lane: more distinct than the original (1.22:1 vs 1.20:1); pink block on it 4.62:1 (original 4.45:1) */
  laneActive: 0x2d2062,
  /** sky stops [height m on the backdrop, colour]: pure haze up to HAZE_TOP, then the magenta glow of the city, night */
  sky: [[-30, 0x140c30], [HAZE_TOP, 0x140c30], [25, 0x34125a], [28, 0x7a2896], [31.5, 0x5a2290], [40, 0x2c1366], [58, 0x160a3c], [100, 0x08041a]],
  beam: [[HAZE_TOP, 0x3a1466], [28, 0x9c3cc0], [44, 0x4a1c80], [80, 0x120838]],
  skyline: 0x1d0f3d, windows: [0xc46bff, 0x8f7bff],
  ground: 0x0a0619, bed: 0x06030f, lines: [0x5d3bc0, 0x8d2aa6], railReflection: 0x3a1a63, rail: 0xb35cff,
  tower: [0x1a1038, 0x2b1a58], farTower: 0x150c30, neon: [0xd34cff, 0x8f6bff], reflection: [0x5a2380, 0x3c2c86],
  streak: 0x8a5cff, pulse: 0xe46bff,
} as const;

const BEAMS: readonly (readonly [number, number])[] = [[-118, 2.2], [-74, 1.4], [-47, 1.8], [52, 1.6], [86, 2.4], [131, 1.5]];
const RAIL_X = 21, RAIL_Y = [13.5, 17], RAIL_HEIGHT = 0.22;
const LINE_X = [7.5, 11];
const TOWERS = 28, TOWER_SPACING = 12;
const FAR = 16, FAR_SPACING = 21;
const STREAKS = 16, STREAK_SPACING = 9;
const PULSES = 12, PULSE_SPEED = 22, PULSE_RUN = 110;
// impulse tracks: [x, base y, width, height] — the four elevated rails, then the four ground lines
const TRACKS: readonly (readonly [number, number, number, number])[] = [
  [RAIL_X - 0.06, RAIL_Y[0] - RAIL_HEIGHT / 2, 0.12, RAIL_HEIGHT], [RAIL_X - 0.06, RAIL_Y[1] - RAIL_HEIGHT / 2, 0.12, RAIL_HEIGHT],
  [LINE_X[0], FLOOR_Y + 0.034, 0.18, 0.012], [LINE_X[1], FLOOR_Y + 0.034, 0.18, 0.012],
];
// instance layout of the city mesh
const TOWER_AT = 0, NEON_AT = TOWER_AT + TOWERS, BAND_AT = NEON_AT + TOWERS, SIGN_AT = BAND_AT + TOWERS * 2;
const REFL_AT = SIGN_AT + TOWERS, FAR_AT = REFL_AT + TOWERS, STREAK_AT = FAR_AT + FAR, PULSE_AT = STREAK_AT + STREAKS;
const COUNT = PULSE_AT + PULSES;

const tmp = new Color(), tmp2 = new Color();

function backdropGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [skyStrip(CITY.sky)];
  // searchlight beams rising from behind the city, above the haze line, fading into the night
  for (const [x, width] of BEAMS) {
    parts.push(paint(new PlaneGeometry(width, 80 - HAZE_TOP, 1, 8).translate(x, (80 + HAZE_TOP) / 2, SKY_Z - 0.5), (out, y) => gradient(out, CITY.beam, y)));
  }
  // horizon skyline, none within 26 m of the axis (where far obstacles appear); lit windows only above the haze line
  for (const side of [-1, 1]) {
    for (let x = 26, n = side * 3000; x < SKY_HALF_WIDTH - 20; n++) {
      const width = 3 + hash(n) * 4.5, height = (6 + hash(n + 0.5) * 18) * (hash(n + 0.25) > 0.8 ? 1.45 : 1);
      parts.push(paint(new PlaneGeometry(width, height + 1).translate(side * (x + width / 2), (height - 1) / 2, SKY_Z - 3), flat(CITY.skyline)));
      for (let k = 0, y = HAZE_TOP + 1; k < 3 && y < height - 0.8; k++, y += 2.2 + hash(n + k) * 1.5) {
        if (hash(n + 0.1 * k + 0.33) < 0.35) continue;
        const wx = side * (x + 0.6 + hash(n + k + 0.6) * (width - 1.2));
        parts.push(paint(new PlaneGeometry(0.9, 0.45).translate(wx, y, SKY_Z - 3.1), flat(CITY.windows[(k + (n & 1)) & 1])));
      }
      x += width + 0.3 + hash(n + 0.75) * 1.5;
    }
  }
  // wet ground, track bed, neon lines, the reflections of the rails, and the elevated rails themselves
  parts.push(paint(floorStrip(2 * SKY_HALF_WIDTH, 0, FLOOR_Y), flat(CITY.ground)));
  parts.push(paint(floorStrip(3 * LANE_WIDTH + 1.2, 0, -0.06), flat(CITY.bed)));
  for (const side of [-1, 1]) {
    LINE_X.forEach((x, i) => parts.push(paint(floorStrip(0.14, side * x, FLOOR_Y + 0.03), flat(CITY.lines[i]))));
    parts.push(paint(floorStrip(0.35, side * RAIL_X, FLOOR_Y + 0.03), flat(CITY.railReflection)));
    for (const y of RAIL_Y) parts.push(paint(wallStrip(RAIL_HEIGHT, side * RAIL_X, y), flat(CITY.rail)));
  }
  return mergeParts(parts, 'CITY_BACKDROP_MERGE');
}

export function createCityWorld(kit: WorldKit, scene: Scene, options: WorldOptions): World {
  let motion = !options.reducedMotion;
  // pieces nearer than REVEAL at creation would pop in: they are never placed
  const revealFrom = Math.max(CITY_START, options.from + REVEAL);
  const backdrop = createBackdrop(kit, scene, backdropGeometry());
  const city = createCityLayer(kit, scene, COUNT);
  const { mesh, put, hide } = city;
  for (let i = FAR_AT; i < FAR_AT + FAR; i++) mesh.setColorAt(i, tmp.setHex(CITY.farTower));
  for (let i = STREAK_AT; i < PULSE_AT; i++) mesh.setColorAt(i, tmp.setHex(CITY.streak));
  for (let i = PULSE_AT; i < COUNT; i++) mesh.setColorAt(i, tmp.setHex(CITY.pulse));
  const colorAt = (i: number, hex: number) => mesh.setColorAt(i, tmp.setHex(hex));
  const placeable = (front: number, back: number) => front >= revealFrom && back < CITY_END;

  let towerBase = Number.NaN, farBase = Number.NaN, streakBase = Number.NaN, pulsesShown = true;
  const placeTowers = (distance: number): boolean => {
    const first = Math.floor(distance / TOWER_SPACING) - 1;
    if (first === towerBase) return false;
    towerBase = first;
    for (let i = 0; i < TOWERS; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 4001;
      const z = row * TOWER_SPACING + hash(n) * 4, w = 3 + hash(n + 0.1) * 2.5, d = 3 + hash(n + 0.2) * 2;
      const h = 10 + hash(n + 0.3) * (TOWER_MAX - 10), x = side * (25 + hash(n + 0.4) * 9);
      const inner = x - side * w / 2, front = z - d / 2, band = BAND_AT + i * 2;
      if (!placeable(front, z + d / 2)) {
        for (const slot of [TOWER_AT + i, NEON_AT + i, band, band + 1, SIGN_AT + i, REFL_AT + i]) hide(slot);
        continue;
      }
      // colours follow the tower (its row), not the recycled instance slot; fixed, never animated
      const tone = hash(n + 0.5) < 0.5 ? 0 : 1, neon = CITY.neon[tone], other = CITY.neon[1 - tone];
      put(TOWER_AT + i, x, FLOOR_Y, z, w, h, d);
      mesh.setColorAt(TOWER_AT + i, tmp.setHex(CITY.tower[0]).lerp(tmp2.setHex(CITY.tower[1]), hash(n + 0.8)));
      put(NEON_AT + i, inner, FLOOR_Y, front, 0.1, h, 0.1); // neon edge on the corner facing the track
      colorAt(NEON_AT + i, neon);
      put(band, x, FLOOR_Y + h * 0.38, z, w * 1.04, 0.22, d * 1.04);
      put(band + 1, x, FLOOR_Y + h * 0.74, z, w * 1.04, 0.22, d * 1.04);
      colorAt(band, neon); colorAt(band + 1, neon);
      // sign panel on the face that looks at the track, well above the lanes' height
      if (hash(n + 0.6) < 0.55) {
        put(SIGN_AT + i, inner - side * 0.06, FLOOR_Y + 3 + hash(n + 0.7) * (h - 7), z - d * 0.15, 0.1, 2.6, 1.3);
        colorAt(SIGN_AT + i, other);
      } else {
        hide(SIGN_AT + i);
      }
      // reflection of the neon edge on the wet ground, running toward the viewer
      put(REFL_AT + i, inner, FLOOR_Y + 0.012, front - 3.25, 0.22, 0.012, 6.5);
      colorAt(REFL_AT + i, CITY.reflection[tone]);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  };
  const placeFar = (distance: number): boolean => {
    const first = Math.floor(distance / FAR_SPACING) - 1;
    if (first === farBase) return false;
    farBase = first;
    for (let i = 0; i < FAR; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 6007;
      const z = row * FAR_SPACING + hash(n) * 8, w = 5 + hash(n + 0.1) * 3, d = 5 + hash(n + 0.2) * 3;
      if (!placeable(z - d / 2, z + d / 2)) { hide(FAR_AT + i); continue; }
      // beyond the near row (its outer faces end at 36.75 m)
      put(FAR_AT + i, side * (41.5 + hash(n + 0.4) * 9), FLOOR_Y, z, w, 12 + hash(n + 0.3) * (TOWER_MAX - 12), d);
    }
    return true;
  };
  const placeStreaks = (distance: number): boolean => {
    const first = Math.floor(distance / STREAK_SPACING) - 1;
    if (first === streakBase) return false;
    streakBase = first;
    for (let i = 0; i < STREAKS; i++) {
      const row = first + (i >> 1), n = row * 2 + (i & 1) + 9973, z = row * STREAK_SPACING + hash(n) * 4;
      if (!motion || !placeable(z, z)) hide(STREAK_AT + i);
      else put(STREAK_AT + i, (i & 1 ? 1 : -1) * (4.05 + hash(n + 0.1) * 0.55), 0.45 + hash(n + 0.2) * 2.2, z, 0.035, 0.035, 1.6 + hash(n + 0.3) * 1.4);
    }
    return true;
  };
  // impulses along the rails and the ground lines toward the horizon, entering from behind the camera, growing in, and
  // shrinking with the fade
  const placePulses = (distance: number, timeMs: number, animate: boolean, size: number) => {
    for (let j = 0; j < PULSES; j++) {
      if (!animate) { hide(PULSE_AT + j); continue; }
      const [x, y, width, height] = TRACKS[(j >> 1) % TRACKS.length];
      const travelled = ((timeMs / 1000) * PULSE_SPEED + j * 29) % PULSE_RUN;
      put(PULSE_AT + j, (j & 1 ? 1 : -1) * x, y, distance - 8 + travelled, width, height, 2.4 * size * Math.min(1, travelled / 10));
    }
  };

  return {
    update(distance, timeMs, fade, haze) {
      const shown = fade < 1;
      backdrop.setVisible(shown); mesh.visible = shown;
      if (!shown) return;
      backdrop.update(distance, fade, haze);
      let moved = placeTowers(distance);
      if (placeFar(distance)) moved = true;
      if (placeStreaks(distance)) moved = true;
      const animate = motion && !options.software;
      if (animate || pulsesShown) { placePulses(distance, timeMs, animate, 1 - fade); pulsesShown = animate; moved = true; }
      if (moved) mesh.instanceMatrix.needsUpdate = true;
    },
    setReducedMotion(value) { motion = !value; streakBase = Number.NaN; },
    dispose() { backdrop.dispose(); city.dispose(); },
  };
}
