// [VISUAL-2] Synapse Run — world director: which universe dresses which section, and which universe exists right now.
// Resources (world-kit.ts): the kit's box and two materials live as long as the renderer; a universe adds one backdrop
// geometry, one InstancedMesh and 2 draw calls while it exists. The director keeps AT MOST ONE universe alive:
//   * inside a section: that section's universe, if it has one
//   * across the 90 m blend into the next section (the renderer's existing zone-colour blend):
//       both sections have a universe → the outgoing one melts into the zone colour over the first half and is retired
//       at the midpoint; in the same frame, after that, the incoming one is created fully melted and emerges over the
//       second half. At the midpoint both are exactly the zone colour, which is also the scene background and fog:
//       no gap, no cut, no colour jump
//       only one side has a universe → it melts out (or emerges) over the whole blend, as in phase 1
//   * every other universe is retired: its backdrop geometry and instance buffers are released (dispose), so the GPU
//     never holds two backdrops (a merely hidden mesh would still hold its geometry: only dispose frees it)
//   * a universe that fails to build is never retried; its section keeps the original look
// Gameplay is only read (the zone and blend the renderer already computes); nothing here feeds back into the run.
import type { Color, Scene } from 'three';
import { SECTIONS } from './sections.ts';
import { createWorldKit, type World, type WorldKit, type WorldOptions } from './world-kit.ts';
import { DAWN, createDawnWorld } from './world-dawn.ts';
import { CITY, createCityWorld } from './world-city.ts';
// [VISUAL-3] section 3 wears « Forêt synaptique » (world-forest.ts): the city now hands over to it at 1245 m like the
// dawn hands over to the city at 545 m; the forest melts out alone into section 4 (2200 → 2290 m). Lifecycle unchanged.
import { FOREST, createForestWorld } from './world-forest.ts';
// [VISUAL-4] section 4 wears « Horizon fracturé » (world-horizon.ts): the forest now hands over to it at 2245 m; the
// horizon melts out alone into section 5 (3500 → 3590 m). Lifecycle unchanged.
import { HORIZON, createHorizonWorld } from './world-horizon.ts';
// [VISUAL-5] section 5 wears « Cœur du Cortex » (world-cortex.ts): the horizon now hands over to it at 3545 m. Section 5
// never ends, so the cortex stays until the run ends; a restart at 0 m retires it and rebuilds the dawn. Lifecycle unchanged.
import { CORTEX, createCortexWorld } from './world-cortex.ts';

interface WorldSpec {
  readonly haze: number;
  readonly palette: { readonly lanes: readonly number[]; readonly active: number };
  create(kit: WorldKit, scene: Scene, options: WorldOptions): World;
}

/** Universe of each section (index = section); null: the section keeps its original look. */
export const WORLDS: readonly (WorldSpec | null)[] = [
  { haze: DAWN.haze, palette: { lanes: DAWN.lanes, active: DAWN.laneActive }, create: createDawnWorld },
  { haze: CITY.haze, palette: { lanes: CITY.lanes, active: CITY.laneActive }, create: createCityWorld },
  { haze: FOREST.haze, palette: { lanes: FOREST.lanes, active: FOREST.laneActive }, create: createForestWorld },
  { haze: HORIZON.haze, palette: { lanes: HORIZON.lanes, active: HORIZON.laneActive }, create: createHorizonWorld },
  { haze: CORTEX.haze, palette: { lanes: CORTEX.lanes, active: CORTEX.laneActive }, create: createCortexWorld },
];

export interface WorldDirector {
  /** zone colour of a section: its universe's haze, or the section's original background */
  haze(section: number): number;
  /** lane palette of a section, or null for the original lane colours */
  palette(section: number): WorldSpec['palette'] | null;
  update(distance: number, timeMs: number, zone: number, blend: number, haze: Color): void;
  setReducedMotion(value: boolean): void;
  dispose(): void;
}

export function createWorldDirector(scene: Scene, options: { reducedMotion: boolean; software: boolean; fogNear: number; fogFar: number }): WorldDirector {
  const kit = createWorldKit(options);
  let reducedMotion = options.reducedMotion;
  const live = new Map<number, World>();
  const failed = new Set<number>();
  const spec = (section: number) => (failed.has(section) ? null : WORLDS[section] ?? null);
  const retire = (section: number) => {
    const world = live.get(section);
    if (!world) return;
    live.delete(section);
    world.dispose();
  };
  const ensure = (section: number, distance: number): World | null => {
    const existing = live.get(section);
    if (existing) return existing;
    const s = spec(section);
    if (!s) return null;
    try {
      const world = s.create(kit, scene, { reducedMotion, software: options.software, from: distance });
      live.set(section, world);
      return world;
    } catch {
      failed.add(section); // no retry loop: the section keeps the original look
      return null;
    }
  };

  return {
    haze: section => spec(section)?.haze ?? SECTIONS[section].background,
    palette: section => spec(section)?.palette ?? null,
    update(distance, timeMs, zone, blend, haze) {
      const blending = zone > 0 && blend < 1;
      const handover = blending && spec(zone - 1) !== null && spec(zone) !== null;
      // outgoing (previous section's) universe: whole blend, or its first half when another universe takes over
      const outFade = !blending ? 1 : handover ? Math.min(1, blend * 2) : blend;
      // this section's universe: second half after a handover, whole blend if the previous section had none
      let inFade = 0;
      if (handover) inFade = blend <= 0.5 ? 1 : 2 - blend * 2;
      else if (blending) inFade = 1 - blend;
      // retire first, so that two backdrops never coexist
      for (const section of live.keys()) if (section !== zone && !(section === zone - 1 && outFade < 1)) retire(section);
      if (inFade >= 1) retire(zone);
      live.get(zone - 1)?.update(distance, timeMs, outFade, haze);
      if (inFade < 1) ensure(zone, distance)?.update(distance, timeMs, inFade, haze);
    },
    setReducedMotion(value) {
      reducedMotion = value;
      for (const world of live.values()) world.setReducedMotion(value);
    },
    dispose() {
      for (const section of live.keys()) retire(section);
      kit.dispose();
    },
  };
}
