// [VISUAL-5] Synapse Run — « Cœur du Cortex », the visual universe of section 5 (Overdrive, 3500 m → no end).
// Same rules and kit as universes 1–4: decoration only, nothing in the play volume (beside the track beyond |x| = 3.9 m,
// under the lane surface, or on the backdrop), nothing above the lanes, never the obstacle pink (#ff4fa3) or amber
// (#ffb547) near the track, no shard shape; 2 draw calls with the kit's materials and box: its only own geometry is its
// backdrop.
//   * backdrop — the heart of Docteur: violet night, indigo haze, a golden halo blending into the sky around a
//                stylised neural core straight ahead (golden hexagon, polygonal rings, rays, a cyan ring recalling the
//                dawn), neural connections from the core to nodes across the sky, monumental circuit towers on the
//                horizon, very dark indigo soil with golden and violet lines. The core sits far above the horizon line:
//                every gameplay element stays below eye level (gate tops 2.6 m, highest jump ≈ 3.1 m, camera 3.4 m), so
//                on screen the core can never cover an obstacle, a shard or the runner
//   * city     — decorative portals beside the track (two columns joined by a lintel, all beyond 18 m: never across the
//                lanes), golden circuit strips on the columns with slow lights climbing them, synapse lights, a far
//                row of digital columns, circuit traces on the soil, speed streaks, impulses along the lines
//   * section 5 has no end: everything is recycled around the player (fixed instance count), nothing accumulates
//   * no pop-in: created half-way through the 90 m blend from the horizon (worlds.ts); pieces placed then only ≥ REVEAL
//     m ahead; sky haze up to HAZE_TOP, above every column, every bright backdrop piece above that line
//   * no flicker, no intensity animation. Reduced motion: no streaks, no impulses, no climbing lights. Software
//     renderer: no impulses or climbing lights. When only those move, only their slice of the buffer is uploaded
import { CircleGeometry, Color, Object3D, PlaneGeometry, RingGeometry, type BufferGeometry, type Scene } from 'three';
import { SECTIONS } from './sections.ts';
import { LANE_WIDTH } from './simulation.ts';
import {
  FLOOR_Y, SKY_HALF_WIDTH, SKY_Z, createBackdrop, createCityLayer, flat, floorStrip, gradient, hash, mergeParts, paint,
  skyStrip, type World, type WorldKit, type WorldOptions,
} from './world-kit.ts';

/** Section 5 is the last one: it never ends. */
export const CORTEX_START = SECTIONS[4].start;

// columns ≤ 22.7 m (checked by worlds-check-phase5.mjs): below the haze line
const HAZE_TOP = 23.5;
/** pieces placed at creation start this far ahead: view depth beyond the fog far plane (95 m), i.e. fully fogged */
const REVEAL = 92;

export const CORTEX = {
  /** background and fog colour of section 5: indigo haze */
  haze: 0x150b33,
  lanes: [0x140a28, 0x1a0e34, 0x140a28],
  /** lit lane: more distinct than the original (1.22:1 vs 1.20:1); pink block on it 4.90:1 (original 4.45:1) */
  laneActive: 0x2c1a5c,
  /** sky stops [height m on the backdrop, colour]: pure haze up to HAZE_TOP, violet glow, violet night */
  sky: [[-30, 0x150b33], [HAZE_TOP, 0x150b33], [26, 0x2a1250], [30, 0x4a1a6e], [36, 0x3a1460], [50, 0x1e0c44], [70, 0x110830], [100, 0x080420]],
  halo: 0x6a3a6a, coreLight: 0xfff0c0, coreGold: 0xe0a840, ringGold: 0xd9a84a, ringViolet: 0xb05ad8, ringChampagne: 0xa88a5a,
  ray: 0xc89a4a, ringCyan: 0x56d4f5, link: 0x5a2a8a, node: 0xe8c890, tower: 0x1e0f3e, towerLine: 0x8a6a3a,
  ground: 0x0a0618, bed: 0x05030c, lines: [0x9a7a3a, 0x5a2a9a, 0x6a5426],
  post: [0x1e1040, 0x2a1656], lintel: 0x2a1656, underline: 0xe8c890, strip: [0xe8c890, 0x56d4f5], synapse: 0xf0c0ff,
  column: [0x1a0e38, 0x241448], band: 0xc04cd8, trace: [0x6a5426, 0x4a2a7a], pad: 0x8a7040,
  streak: 0xc8b0ff, pulse: 0xf3d9a0, climber: 0xfff0c8,
} as const;

const CORE = { y: 36, halo: 14 };
const LINE_X = [8, 12, 17];
const PORTALS = 16, PORTAL_SPACING = 22;
const COLUMNS = 16, COLUMN_SPACING = 19;
const CIRCUITS = 16, CIRCUIT_SPACING = 13;
const STREAKS = 16, STREAK_SPACING = 9;
const PULSES = 12, PULSE_SPEED = 16, PULSE_RUN = 110;
const CLIMB_SPEED = 2.2; // m/s up a column: slow lights
// instance layout of the city mesh: the animated pieces (impulses, then climbing lights) are last and contiguous
const INNER_AT = 0, OUTER_AT = INNER_AT + PORTALS, LINTEL_AT = OUTER_AT + PORTALS, UNDER_AT = LINTEL_AT + PORTALS;
const ISTRIP_AT = UNDER_AT + PORTALS, OSTRIP_AT = ISTRIP_AT + PORTALS, SYNAPSE_AT = OSTRIP_AT + PORTALS;
const COLUMN_AT = SYNAPSE_AT + PORTALS, CSTRIP_AT = COLUMN_AT + COLUMNS, CBAND_AT = CSTRIP_AT + COLUMNS;
const TRACE_AT = CBAND_AT + COLUMNS, PAD_AT = TRACE_AT + CIRCUITS * 2, STREAK_AT = PAD_AT + CIRCUITS;
const PULSE_AT = STREAK_AT + STREAKS, CLIMB_AT = PULSE_AT + PULSES, COUNT = CLIMB_AT + PORTALS;

const tmp = new Color(), tmp2 = new Color();

function backdropGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [skyStrip(CORTEX.sky)];
  const z = SKY_Z;
  // golden halo: warm at the centre, the sky's own colour on the rim, so it melts into the sky
  parts.push(paint(new CircleGeometry(CORE.halo, 24).translate(0, CORE.y, z - 0.5), (out, y, i) => {
    if (i === 0) out.setHex(CORTEX.halo); else gradient(out, CORTEX.sky, y);
  }));
  // the neural core: golden hexagon, polygonal rings, rays, a cyan ring recalling the dawn
  parts.push(paint(new CircleGeometry(4.2, 6).translate(0, CORE.y, z - 1),
    (out, _y, i) => { out.setHex(i === 0 ? CORTEX.coreLight : CORTEX.coreGold); }));
  parts.push(paint(new RingGeometry(5.2, 5.7, 6).rotateZ(Math.PI / 6).translate(0, CORE.y, z - 0.9), flat(CORTEX.ringGold)));
  parts.push(paint(new RingGeometry(7.4, 7.7, 8).translate(0, CORE.y, z - 0.85), flat(CORTEX.ringViolet)));
  parts.push(paint(new RingGeometry(9.6, 9.85, 12).rotateZ(Math.PI / 12).translate(0, CORE.y, z - 0.8), flat(CORTEX.ringChampagne)));
  parts.push(paint(new RingGeometry(10.6, 10.75, 24).translate(0, CORE.y, z - 0.75), flat(CORTEX.ringCyan)));
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6, from = 5.9, to = k & 1 ? 7.2 : 9.4, mid = (from + to) / 2;
    parts.push(paint(new PlaneGeometry(to - from, 0.22).rotateZ(a).translate(Math.cos(a) * mid, CORE.y + Math.sin(a) * mid, z - 0.95), flat(CORTEX.ray)));
  }
  // neural connections from the core's outer ring to nodes across the sky (all above the haze line)
  for (const side of [-1, 1]) {
    let px = side * 10.75, py = CORE.y;
    for (let k = 0, x = 24; k < 8; k++, x += 12 + hash(side * 90 + k) * 12) {
      const y = 27 + hash(side * 110 + k) * 26, sx = side * x;
      parts.push(paint(new CircleGeometry(0.7, 6).translate(sx, y, z - 0.7), flat(CORTEX.node)));
      parts.push(paint(new PlaneGeometry(Math.hypot(sx - px, y - py), 0.2).rotateZ(Math.atan2(y - py, sx - px)).translate((sx + px) / 2, (y + py) / 2, z - 0.6), flat(CORTEX.link)));
      px = sx; py = y;
    }
  }
  // monumental circuit towers on the horizon, none within 26 m of the axis; their golden circuit lines only above the
  // haze line, where no recycled column can ever be in front of them
  for (const side of [-1, 1]) {
    for (let x = 26, n = side * 9000; x < SKY_HALF_WIDTH - 20; n++) {
      const width = 3.5 + hash(n) * 5, height = (8 + hash(n + 0.5) * 20) * (hash(n + 0.25) > 0.8 ? 1.3 : 1);
      const cx = side * (x + width / 2);
      parts.push(paint(new PlaneGeometry(width, height + 1).translate(cx, (height - 1) / 2, z - 3), flat(CORTEX.tower)));
      if (height > HAZE_TOP + 2) {
        for (const dx of [-0.25, 0.25]) parts.push(paint(new PlaneGeometry(0.18, height - HAZE_TOP).translate(cx + dx * width, (height + HAZE_TOP) / 2, z - 3.05), flat(CORTEX.towerLine)));
      }
      x += width + 0.4 + hash(n + 0.75) * 2;
    }
  }
  // very dark indigo soil, track bed, golden and violet lines
  parts.push(paint(floorStrip(2 * SKY_HALF_WIDTH, 0, FLOOR_Y), flat(CORTEX.ground)));
  parts.push(paint(floorStrip(3 * LANE_WIDTH + 1.2, 0, -0.06), flat(CORTEX.bed)));
  for (const side of [-1, 1]) LINE_X.forEach((x, i) => parts.push(paint(floorStrip(0.14, side * x, FLOOR_Y + 0.03), flat(CORTEX.lines[i]))));
  return mergeParts(parts, 'CORTEX_BACKDROP_MERGE');
}

export function createCortexWorld(kit: WorldKit, scene: Scene, options: WorldOptions): World {
  let motion = !options.reducedMotion;
  // pieces nearer than REVEAL at creation would pop in: they are never placed (the section has no far end)
  const revealFrom = Math.max(CORTEX_START, options.from + REVEAL);
  const backdrop = createBackdrop(kit, scene, backdropGeometry());
  const city = createCityLayer(kit, scene, COUNT);
  const { mesh, hide } = city;
  const colorAt = (i: number, hex: number) => mesh.setColorAt(i, tmp.setHex(hex));
  const fill = (from: number, to: number, hex: number) => { for (let i = from; i < to; i++) colorAt(i, hex); };
  fill(LINTEL_AT, UNDER_AT, CORTEX.lintel); fill(UNDER_AT, ISTRIP_AT, CORTEX.underline);
  fill(ISTRIP_AT, OSTRIP_AT, CORTEX.strip[0]); fill(OSTRIP_AT, SYNAPSE_AT, CORTEX.strip[1]); fill(SYNAPSE_AT, COLUMN_AT, CORTEX.synapse);
  fill(CSTRIP_AT, CBAND_AT, CORTEX.strip[0]); fill(CBAND_AT, TRACE_AT, CORTEX.band); fill(PAD_AT, STREAK_AT, CORTEX.pad);
  fill(STREAK_AT, PULSE_AT, CORTEX.streak); fill(PULSE_AT, CLIMB_AT, CORTEX.pulse); fill(CLIMB_AT, COUNT, CORTEX.climber);
  const dummy = new Object3D();
  const put = (i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    dummy.position.set(x, y, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
  };
  const placeable = (front: number) => front >= revealFrom;
  // where each portal's climbing light runs: x, front z, run height (0 = portal not placed)
  const climbX = new Float32Array(PORTALS), climbZ = new Float32Array(PORTALS), climbRun = new Float32Array(PORTALS);

  let portalBase = Number.NaN, columnBase = Number.NaN, circuitBase = Number.NaN, streakBase = Number.NaN, animatedShown = true;
  const placePortals = (distance: number): boolean => {
    const first = Math.floor(distance / PORTAL_SPACING) - 1;
    if (first === portalBase) return false;
    portalBase = first;
    for (let i = 0; i < PORTALS; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 30011;
      const z = row * PORTAL_SPACING + hash(n) * 6, w = 1.6 + hash(n + 0.1) * 0.6;
      if (!placeable(z - w / 2)) {
        for (const at of [INNER_AT, OUTER_AT, LINTEL_AT, UNDER_AT, ISTRIP_AT, OSTRIP_AT, SYNAPSE_AT]) hide(at + i);
        climbRun[i] = 0;
        continue;
      }
      // inner column beyond the renderer's own hexagonal silhouettes (they reach ~20.1 m): faces ≥ 20.4 m
      const inner = side * (21.5 + hash(n + 0.2) * 1.5), outer = inner + side * (6 + hash(n + 0.3) * 2);
      const hi = 14 + hash(n + 0.4) * 8, ho = 14 + hash(n + 0.5) * 8, lintelY = FLOOR_Y + Math.min(hi, ho) - 1.2;
      put(INNER_AT + i, inner, FLOOR_Y, z, w, hi, w);
      put(OUTER_AT + i, outer, FLOOR_Y, z, w, ho, w);
      mesh.setColorAt(INNER_AT + i, tmp.setHex(CORTEX.post[0]).lerp(tmp2.setHex(CORTEX.post[1]), hash(n + 0.6)));
      mesh.setColorAt(OUTER_AT + i, tmp.setHex(CORTEX.post[0]).lerp(tmp2.setHex(CORTEX.post[1]), hash(n + 0.7)));
      // the lintel joins the two columns beside the track; it never reaches over the lanes (it starts ≥ 21.5 m out)
      const span = Math.abs(outer - inner);
      put(LINTEL_AT + i, (inner + outer) / 2, lintelY, z, span, 0.9, 1.2);
      put(UNDER_AT + i, (inner + outer) / 2, lintelY - 0.1, z, span - w, 0.1, 0.4); // golden line under the lintel
      // circuit strips down the front faces: golden on the inner column, cyan (the dawn's colour) on the outer one
      put(ISTRIP_AT + i, inner, FLOOR_Y + 0.4, z - w / 2, 0.12, hi - 0.8, 0.06);
      put(OSTRIP_AT + i, outer, FLOOR_Y + 0.4, z - w / 2, 0.12, ho - 0.8, 0.06);
      put(SYNAPSE_AT + i, inner + side * (w / 2 + 0.3), lintelY - 0.65, z, 0.4, 0.4, 0.4); // a synapse under the lintel's inner end
      climbX[i] = inner; climbZ[i] = z - w / 2 - 0.04; climbRun[i] = hi - 1.6;
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  };
  const placeColumns = (distance: number): boolean => {
    const first = Math.floor(distance / COLUMN_SPACING) - 1;
    if (first === columnBase) return false;
    columnBase = first;
    for (let i = 0; i < COLUMNS; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 32003;
      const z = row * COLUMN_SPACING + hash(n) * 8, w = 2.4 + hash(n + 0.1) * 1.6;
      if (!placeable(z - w / 2)) { hide(COLUMN_AT + i); hide(CSTRIP_AT + i); hide(CBAND_AT + i); continue; }
      const x = side * (36 + hash(n + 0.2) * 8), h = 12 + hash(n + 0.3) * 11;
      put(COLUMN_AT + i, x, FLOOR_Y, z, w, h, w);
      mesh.setColorAt(COLUMN_AT + i, tmp.setHex(CORTEX.column[0]).lerp(tmp2.setHex(CORTEX.column[1]), hash(n + 0.4)));
      put(CSTRIP_AT + i, x, FLOOR_Y + 0.4, z - w / 2, 0.14, h - 0.8, 0.06);
      put(CBAND_AT + i, x, FLOOR_Y + h * (0.55 + hash(n + 0.5) * 0.25), z, w * 1.05, 0.2, w * 1.05);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  };
  // circuit traces on the soil: an L of two segments ending on a pad, between the lines (flat, below the lanes)
  const placeCircuits = (distance: number): boolean => {
    const first = Math.floor(distance / CIRCUIT_SPACING) - 1;
    if (first === circuitBase) return false;
    circuitBase = first;
    for (let i = 0; i < CIRCUITS; i++) {
      const row = first + (i >> 1), side = i & 1 ? 1 : -1, n = row * 2 + (i & 1) + 34019, z = row * CIRCUIT_SPACING + hash(n) * 5;
      const along = 3 + hash(n + 0.1) * 3, across = 1.5 + hash(n + 0.2) * 1.5, x = side * (9 + hash(n + 0.3) * 1.5);
      if (!placeable(z)) { hide(TRACE_AT + i * 2); hide(TRACE_AT + i * 2 + 1); hide(PAD_AT + i); continue; }
      const tone = hash(n + 0.4) < 0.5 ? 0 : 1, y = FLOOR_Y + 0.012;
      put(TRACE_AT + i * 2, x, y, z + along / 2, 0.1, 0.012, along);
      put(TRACE_AT + i * 2 + 1, x + side * across / 2, y, z + along, across, 0.012, 0.1);
      put(PAD_AT + i, x + side * across, y, z + along, 0.4, 0.014, 0.4);
      colorAt(TRACE_AT + i * 2, CORTEX.trace[tone]); colorAt(TRACE_AT + i * 2 + 1, CORTEX.trace[tone]);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return true;
  };
  const placeStreaks = (distance: number): boolean => {
    const first = Math.floor(distance / STREAK_SPACING) - 1;
    if (first === streakBase) return false;
    streakBase = first;
    for (let i = 0; i < STREAKS; i++) {
      const row = first + (i >> 1), n = row * 2 + (i & 1) + 36011, z = row * STREAK_SPACING + hash(n) * 4;
      const length = 1.6 + hash(n + 0.3) * 1.4;
      if (!motion || !placeable(z - length / 2)) hide(STREAK_AT + i);
      else put(STREAK_AT + i, (i & 1 ? 1 : -1) * (4.05 + hash(n + 0.1) * 0.55), 0.45 + hash(n + 0.2) * 2.2, z, 0.035, 0.035, length);
    }
    return true;
  };
  // impulses along the soil lines, and slow lights climbing each portal's golden strip; they shrink with the fade
  const placeAnimated = (distance: number, timeMs: number, animate: boolean, size: number) => {
    const t = timeMs / 1000;
    for (let j = 0; j < PULSES; j++) {
      if (!animate) { hide(PULSE_AT + j); continue; }
      const travelled = (t * PULSE_SPEED + j * 29) % PULSE_RUN;
      put(PULSE_AT + j, (j & 1 ? 1 : -1) * LINE_X[(j >> 1) % LINE_X.length], FLOOR_Y + 0.034, distance - 8 + travelled, 0.18, 0.012, 2.2 * size * Math.min(1, travelled / 10));
    }
    for (let i = 0; i < PORTALS; i++) {
      if (!animate || climbRun[i] <= 0) { hide(CLIMB_AT + i); continue; }
      const climbed = (t * CLIMB_SPEED + i * 3.7) % climbRun[i];
      put(CLIMB_AT + i, climbX[i], FLOOR_Y + 0.5 + climbed, climbZ[i], 0.2 * size, 0.6 * size, 0.08);
    }
  };

  return {
    update(distance, timeMs, fade, haze) {
      const shown = fade < 1;
      backdrop.setVisible(shown); mesh.visible = shown;
      if (!shown) return;
      backdrop.update(distance, fade, haze);
      let placed = placePortals(distance);
      if (placeColumns(distance)) placed = true;
      if (placeCircuits(distance)) placed = true;
      if (placeStreaks(distance)) placed = true;
      const animate = motion && !options.software;
      const animating = animate || animatedShown;
      if (animating) { placeAnimated(distance, timeMs, animate, 1 - fade); animatedShown = animate; }
      if (!placed && !animating) return;
      // only the animated pieces moved: upload just their slice (252 instances otherwise); a placement uploads all
      mesh.instanceMatrix.clearUpdateRanges();
      if (!placed) mesh.instanceMatrix.addUpdateRange(PULSE_AT * 16, (COUNT - PULSE_AT) * 16);
      mesh.instanceMatrix.needsUpdate = true;
    },
    setReducedMotion(value) { motion = !value; streakBase = Number.NaN; },
    dispose() { backdrop.dispose(); city.dispose(); },
  };
}
