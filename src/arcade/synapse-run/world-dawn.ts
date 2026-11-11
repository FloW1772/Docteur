// [VISUAL-1] Synapse Run — « Aube numérique », the visual universe of section 1 (Signal Deck, 0 → 500 m).
// Decoration only, built from the renderer's own primitives (three meshes, flat colours: no texture, no file, no
// network). It reads the distance, the decorative clock and the renderer's zone colour; it never reads the course and
// writes nothing back. Layout rules that keep the run readable:
//   * every piece lies outside the play volume: beside the track beyond the rails (|x| ≥ 3.9 m), under the lane
//     surface (y < 0) or on the far backdrop. Seen from the runner camera such a piece is always farther than any
//     obstacle, shard or player it overlaps on screen, so it can never hide one
//   * nothing above the lanes, no obstacle colour (pink, amber), no shard shape (octahedron, ring) near the track
//   * 2 draw calls, drawn with the kit's two materials (world-kit.ts):
//       backdrop — sky gradient, rising sun, horizon skyline, ground, track bed and light lines: one merged unlit mesh
//                  that travels with the camera; its fog is baked into the vertex colours (camera depth is constant)
//       city     — instances of the kit's unit box: spires, their light edges and dawn-lit tops, floor grid, speed
//                  streaks and ground pulses; world-anchored, they stop where section 2 starts
//   * reduced motion: no speed streaks and no travelling pulses; the static scenery stays. Software renderer: no pulses
//     (no per-frame instance upload)
// [VISUAL-2] Built on the shared kit; the director (worlds.ts) melts it into the zone colour over the first half of the
// 90 m blend into section 2, then retires it (its backdrop geometry and instances are released). Its pulses now shrink
// with that fade instead of vanishing at once. Everything drawn inside section 1 is unchanged.
import { Color, CircleGeometry, PlaneGeometry, RingGeometry, type BufferGeometry, type Scene } from 'three';
import { SECTIONS } from './sections.ts';
import { LANE_WIDTH } from './simulation.ts';
import {
  FLOOR_Y, SKY_HALF_WIDTH, SKY_Z, createBackdrop, createCityLayer, flat, floorStrip, hash, mergeParts, paint, skyStrip,
  type World, type WorldKit, type WorldOptions,
} from './world-kit.ts';

/** The dawn ends where section 2 starts. */
export const DAWN_END = SECTIONS[1].start;

// Far scenery is recycled where the fog is total, i.e. drawn in the haze colour. It used to vanish into a uniform
// background; in front of this sky it would show as a dark shape wherever the sky is not haze. So the sky stays pure
// haze up to HAZE_TOP, above every scenery top (existing pieces ≤ 13 m, spires ≤ SPIRE_MAX), and the sun and its rings
// sit beyond the spires' lateral band: anything appearing at the far end appears against haze.
const HAZE_TOP = 16, SPIRE_MAX = 15.5;

export const DAWN = {
  /** background and fog colour of section 1 */
  haze: 0x0b1b36,
  lanes: [0x15214a, 0x1b2a58, 0x15214a],
  /** lit lane: as distinct from the others as the original (1.24:1 vs 1.20:1); pink block on it ≥ 3.6:1 */
  laneActive: 0x1f3874,
  /** sky stops [height m on the backdrop, colour]: pure haze up to HAZE_TOP, then dawn gold, turquoise, electric blue */
  sky: [[-30, 0x0b1b36], [HAZE_TOP, 0x0b1b36], [18.5, 0x1b3d63], [21, 0xc99a74], [24, 0x8fcfd2], [31, 0x2f8fcf], [46, 0x14438f], [66, 0x0a1d4c], [100, 0x050b24]],
  sunLow: 0xffc89a, sunHigh: 0xfff1d8, sunRing: 0x8fe3ee, skyline: 0x102a4d,
  ground: 0x07132b, bed: 0x040a1a, line: 0x1d86a8,
  spire: [0x163f6c, 0x1f5288], spireEdge: 0x56d4f5, spireCap: 0xd9a77e,
  grid: 0x1a5a86, streak: 0x5aa6e8, pulse: 0x7cc0ee,
} as const;

const SUN = { x: 44, y: 21, radius: 6 }; // off-axis: the vanishing point of the track stays clear
const LINE_X = [8, 12.5, 18, 25, 34];
const SPIRES = 24, SPIRE_SPACING = 14;
const GRID_ROWS = 18, GRID_SPACING = 8;
const STREAKS = 16, STREAK_SPACING = 9;
const PULSES = 10, PULSE_SPEED = 16, PULSE_RUN = 110;
// instance layout of the city mesh
const SPIRE_AT = 0, EDGE_AT = SPIRE_AT + SPIRES, CAP_AT = EDGE_AT + SPIRES * 2, GRID_AT = CAP_AT + SPIRES;
const STREAK_AT = GRID_AT + GRID_ROWS * 2, PULSE_AT = STREAK_AT + STREAKS, CITY = PULSE_AT + PULSES;

const tmp = new Color(), tmp2 = new Color();

function backdropGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [skyStrip(DAWN.sky)];
  // rising sun with two thin halo rings
  parts.push(paint(new CircleGeometry(SUN.radius, 40).translate(SUN.x, SUN.y, SKY_Z - 1),
    (out, y) => { out.setHex(DAWN.sunLow).lerp(tmp2.setHex(DAWN.sunHigh), (y - SUN.y + SUN.radius) / (2 * SUN.radius)); }));
  for (const [inner, outer] of [[8, 8.3], [10.3, 10.5]]) parts.push(paint(new RingGeometry(inner, outer, 48).translate(SUN.x, SUN.y, SKY_Z - 1.2), flat(DAWN.sunRing)));
  // horizon skyline: flat silhouettes in front of the sun, none within 26 m of the axis (where far obstacles appear)
  for (const side of [-1, 1]) {
    for (let x = 26, n = side * 1000; x < SKY_HALF_WIDTH - 20; n++) {
      const width = 4 + hash(n) * 6, height = (2.5 + hash(n + 0.5) * 9) * (hash(n + 0.25) > 0.85 ? 1.6 : 1);
      parts.push(paint(new PlaneGeometry(width, height + 1).translate(side * (x + width / 2), (height - 1) / 2, SKY_Z - 3), flat(DAWN.skyline)));
      x += width + 0.6 + hash(n + 0.75) * 3;
    }
  }
  // ground, track bed (seen between the lanes) and the light lines that run to the horizon
  parts.push(paint(floorStrip(2 * SKY_HALF_WIDTH, 0, FLOOR_Y), flat(DAWN.ground)));
  parts.push(paint(floorStrip(3 * LANE_WIDTH + 1.2, 0, -0.06), flat(DAWN.bed)));
  for (const x of LINE_X) for (const side of [-1, 1]) parts.push(paint(floorStrip(0.12, side * x, FLOOR_Y + 0.03), flat(DAWN.line)));
  return mergeParts(parts, 'DAWN_BACKDROP_MERGE');
}

export function createDawnWorld(kit: WorldKit, scene: Scene, options: WorldOptions): World {
  let motion = !options.reducedMotion;
  const backdrop = createBackdrop(kit, scene, backdropGeometry());
  const city = createCityLayer(kit, scene, CITY);
  const { put, hide } = city;
  // fixed colour per instance range (spire bodies are recoloured per spire when placed)
  const ranges: [number, number][] = [[EDGE_AT, DAWN.spire[0]], [CAP_AT, DAWN.spireEdge], [GRID_AT, DAWN.spireCap], [STREAK_AT, DAWN.grid], [PULSE_AT, DAWN.streak], [CITY, DAWN.pulse]];
  for (let i = 0, r = 0; i < CITY; i++) {
    while (i >= ranges[r][0]) r++;
    city.mesh.setColorAt(i, tmp.setHex(ranges[r][1]));
  }

  let spireBase = Number.NaN, gridBase = Number.NaN, streakBase = Number.NaN, pulsesShown = true;
  const placeSpires = (distance: number): boolean => {
    const first = Math.floor(distance / SPIRE_SPACING) - 1;
    if (first === spireBase) return false;
    spireBase = first;
    for (let i = 0; i < SPIRES; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1);
      const z = row * SPIRE_SPACING + hash(n) * 5, w = 2.2 + hash(n + 0.1) * 1.4, d = 2.2 + hash(n + 0.2) * 1.2;
      const h = 8 + hash(n + 0.3) * (SPIRE_MAX - 8), x = side * (19 + hash(n + 0.4) * 8), edge = EDGE_AT + i * 2;
      if (z + d / 2 >= DAWN_END) { hide(SPIRE_AT + i); hide(edge); hide(edge + 1); hide(CAP_AT + i); continue; }
      put(SPIRE_AT + i, x, FLOOR_Y, z, w, h, d);
      put(edge, x - w / 2, FLOOR_Y, z - d / 2, 0.08, h, 0.08);
      put(edge + 1, x + w / 2, FLOOR_Y, z - d / 2, 0.08, h, 0.08);
      put(CAP_AT + i, x, FLOOR_Y + h - 0.4, z, w * 1.03, 0.4, d * 1.03); // the first light of the day on the tops
      // colour follows the spire (its row), not the recycled instance slot
      city.mesh.setColorAt(SPIRE_AT + i, tmp.setHex(DAWN.spire[0]).lerp(tmp2.setHex(DAWN.spire[1]), hash(n + 0.5)));
    }
    if (city.mesh.instanceColor) city.mesh.instanceColor.needsUpdate = true;
    return true;
  };
  const placeGrid = (distance: number): boolean => {
    const first = Math.floor(distance / GRID_SPACING) - 1;
    if (first === gridBase) return false;
    gridBase = first;
    for (let i = 0; i < GRID_ROWS * 2; i++) {
      const z = (first + (i >> 1)) * GRID_SPACING;
      if (z >= DAWN_END) hide(GRID_AT + i);
      else put(GRID_AT + i, (i & 1 ? 1 : -1) * 21.5, FLOOR_Y + 0.012, z, 30, 0.012, 0.1);
    }
    return true;
  };
  const placeStreaks = (distance: number): boolean => {
    const first = Math.floor(distance / STREAK_SPACING) - 1;
    if (first === streakBase) return false;
    streakBase = first;
    for (let i = 0; i < STREAKS; i++) {
      const row = first + (i >> 1), n = row * 2 + (i & 1) + 7919, z = row * STREAK_SPACING + hash(n) * 4;
      if (!motion || z >= DAWN_END) hide(STREAK_AT + i);
      else put(STREAK_AT + i, (i & 1 ? 1 : -1) * (4.05 + hash(n + 0.1) * 0.55), 0.45 + hash(n + 0.2) * 2.2, z, 0.035, 0.035, 1.6 + hash(n + 0.3) * 1.4);
    }
    return true;
  };
  // pulses run along the light lines toward the horizon, entering from behind the camera and growing in (no pop);
  // during the handoff they shrink with the fade
  const placePulses = (distance: number, timeMs: number, animate: boolean, size: number) => {
    for (let j = 0; j < PULSES; j++) {
      if (!animate) { hide(PULSE_AT + j); continue; }
      const travelled = ((timeMs / 1000) * PULSE_SPEED + j * 37) % PULSE_RUN;
      put(PULSE_AT + j, (j & 1 ? 1 : -1) * LINE_X[(j >> 1) % LINE_X.length], FLOOR_Y + 0.034, distance - 8 + travelled, 0.16, 0.012, 1.8 * size * Math.min(1, travelled / 10));
    }
  };

  return {
    update(distance, timeMs, fade, haze) {
      const shown = fade < 1;
      backdrop.setVisible(shown); city.mesh.visible = shown;
      if (!shown) return;
      backdrop.update(distance, fade, haze);
      let moved = placeSpires(distance);
      if (placeGrid(distance)) moved = true;
      if (placeStreaks(distance)) moved = true;
      const animate = motion && !options.software;
      if (animate || pulsesShown) { placePulses(distance, timeMs, animate, 1 - fade); pulsesShown = animate; moved = true; }
      if (moved) city.mesh.instanceMatrix.needsUpdate = true;
    },
    setReducedMotion(value) { motion = !value; streakBase = Number.NaN; },
    dispose() { backdrop.dispose(); city.dispose(); },
  };
}
