// [GAME-4] Synapse Run — Three.js view of a SimState. Read-only with respect to the game: meshes mirror the
// simulation, they never decide anything (collision lives in simulation.ts). Original low-poly look built from
// primitive geometry and flat materials only: no textures, no model files, no remote assets.
// [GAME-6] Polish, measured first:
//   * the 32 cross stripes and 32 side pillars (cone + node) are 3 InstancedMeshes instead of 96 meshes
//   * the player's current lane is lit; BLOCK and HIGH_GATE differ by silhouette, not only colour (a solid low wall
//     with a bright top edge vs an open arch with a hanging bar and a lit underside)
//   * a collected shard pops briefly before disappearing; the construct turns red on GAME_OVER (static, no flashing)
//   * a software WebGL renderer (SwiftShader, llvmpipe, …) is detected once at start-up: buffers are then capped at
//     DPR 1 and main.ts switches the page to its low-effects layout; nothing about obstacles or the course changes
//   * a lost WebGL context is reported once (no recreation loop)
import {
  AmbientLight, Box3, BoxGeometry, Color, ConeGeometry, DirectionalLight, Fog, Group, HemisphereLight, IcosahedronGeometry,
  InstancedMesh, Mesh, MeshLambertMaterial, Object3D, OctahedronGeometry, PerspectiveCamera, PlaneGeometry, Scene,
  CapsuleGeometry, CylinderGeometry, TorusGeometry, Vector3, WebGLRenderer, type Material, type BufferGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { positionRunCamera } from './camera.ts';
import { SECTIONS, sectionIndex } from './sections.ts';
import {
  BLOCK, HIGH_GATE, LANE_WIDTH, PLAYER_HEIGHT, PLAYER_SLIDE_HEIGHT, SHARD, laneX, playerX, type SimState,
} from './simulation.ts';

/** Canvas buffers never exceed this device-pixel ratio (keeps high-DPI screens from rendering huge buffers). */
export const MAX_PIXEL_RATIO = 2;
/** Software renderers rasterise every pixel on the CPU: one buffer pixel per CSS pixel. */
export const SOFTWARE_PIXEL_RATIO = 1;
export const SHARD_POP_MS = 180;
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
const PILLAR_SPACING = 8;
const PILLAR_PAIRS = 16;
const STRIPE_SPACING = 4;
const STRIPES = 32;

const COLORS = {
  background: 0x0a0814, lane: 0x1a1433, laneAlt: 0x221a40, laneActive: 0x2e2463, divider: 0x5ee7ff, rail: 0x3dffaa,
  core: 0x5ee7ff, crash: 0xff3b5c, ring: 0x3dffaa, fin: 0xa78bfa, block: 0xff4fa3, blockEdge: 0xffd1e6,
  gate: 0xffb547, gateUnder: 0xfff0c2, shard: 0x9ff6ff, pillar: 0x2a2150, node: 0x3dffaa, stripe: 0x2c2458,
};

/** Measured from the meshes: height span, and the lowest point of the WIDE parts (0 = solid from the ground). */
export interface ObstacleSilhouette { type: 'BLOCK' | 'HIGH_GATE'; top: number; openBelow: number; parts: number }

export interface RunRendererInfo {
  calls: number; triangles: number; geometries: number; programs: number; pixelRatio: number; width: number; height: number; aspect: number;
  meshes: number; software: boolean; renderer: string;
  player: { x: number; y: number; scaleY: number; crashed: boolean; screenX: number; lean: number };
  zone: string;
  activeLane: number; silhouettes: ObstacleSilhouette[]; poppingShards: number;
}

export interface RunRenderer {
  render(state: SimState, timeMs: number): void;
  setReducedMotion(value: boolean): void;
  resize(): void;
  dispose(): void;
  readonly software: boolean;
  info(): RunRendererInfo;
}

function rendererName(renderer: WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return '';
  }
}

/** Throws if WebGL is unavailable; the caller shows the fallback (never retried). */
export function createRunRenderer(container: HTMLElement, options: { reducedMotion: boolean; onContextLost?: () => void }): RunRenderer {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(COLORS.background, 1);
  renderer.domElement.className = 'sr-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true'); // the container carries the text alternative
  container.appendChild(renderer.domElement);
  const name = rendererName(renderer);
  const software = SOFTWARE_RENDERER.test(name);
  let contextLost = false;
  const onLost = (event: Event) => {
    event.preventDefault();
    if (contextLost) return;
    contextLost = true;
    options.onContextLost?.();
  };
  renderer.domElement.addEventListener('webglcontextlost', onLost);

  let reducedMotion = options.reducedMotion;
  const scene = new Scene();
  scene.scale.z = -1;
  scene.background = new Color(COLORS.background);
  scene.fog = new Fog(COLORS.background, 30, 95);
  const camera = new PerspectiveCamera(62, 1, 0.1, 140);

  scene.add(new HemisphereLight(0xb9a8ff, 0x120c24, 1.1));
  scene.add(new AmbientLight(0x403060, 0.6));
  const sun = new DirectionalLight(0xffffff, 1.2);
  sun.position.set(4, 10, -6);
  scene.add(sun);

  // shared geometry / materials: created once, disposed once
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const geo = <T extends BufferGeometry>(g: T): T => { geometries.push(g); return g; };
  const mat = (color: number, emissive = 0x000000, emissiveIntensity = 0): MeshLambertMaterial => {
    const m = new MeshLambertMaterial({ color, emissive, emissiveIntensity, flatShading: true });
    materials.push(m);
    return m;
  };

  const laneGeo = geo(new PlaneGeometry(LANE_WIDTH - 0.08, 160));
  const laneMat = [mat(COLORS.lane), mat(COLORS.laneAlt), mat(COLORS.lane)];
  const laneActiveMat = mat(COLORS.laneActive, COLORS.laneActive, 0.35);
  const track = new Group();
  const strips: Mesh[] = [];
  for (let lane = 0; lane < 3; lane++) {
    const strip = new Mesh(laneGeo, laneMat[lane]);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(laneX(lane), 0, 0);
    track.add(strip);
    strips.push(strip);
  }
  const dividerGeo = geo(new BoxGeometry(0.06, 0.02, 160));
  const dividerMat = mat(COLORS.divider, COLORS.divider, 0.6);
  for (const x of [-LANE_WIDTH / 2, LANE_WIDTH / 2]) {
    const line = new Mesh(dividerGeo, dividerMat);
    line.position.set(x, 0.01, 0);
    track.add(line);
  }
  const railGeo = geo(new BoxGeometry(0.18, 0.25, 160));
  const railMat = mat(COLORS.rail, COLORS.rail, 0.35);
  for (const x of [-1.5 * LANE_WIDTH - 0.15, 1.5 * LANE_WIDTH + 0.15]) {
    const rail = new Mesh(railGeo, railMat);
    rail.position.set(x, 0.12, 0);
    track.add(rail);
  }
  scene.add(track);

  // cross stripes and side pillars are recycled along z (the sense of speed): one draw call per kind
  const stripes = new InstancedMesh(geo(new BoxGeometry(3 * LANE_WIDTH, 0.015, 0.12)), mat(COLORS.stripe), STRIPES);
  const cones = new InstancedMesh(geo(new ConeGeometry(0.45, 4.5, 5)), mat(COLORS.pillar), PILLAR_PAIRS * 2);
  const nodes = new InstancedMesh(geo(new IcosahedronGeometry(0.42, 0)), mat(COLORS.node, COLORS.node, 0.8), PILLAR_PAIRS * 2);
  for (const decor of [stripes, cones, nodes]) { decor.frustumCulled = false; scene.add(decor); }
  const dummy = new Object3D();
  // Fixed instancing budgets: three layers, no per-zone geometry allocation.
  const archMat = mat(COLORS.divider, COLORS.divider, 0.5);
  const arches = new InstancedMesh(geo(new TorusGeometry(5.2, 0.13, 5, 18, Math.PI)), archMat, 10);
  const branches = new InstancedMesh(geo(new CylinderGeometry(0.08, 0.23, 3.5, 5)), mat(0x318f85, 0x146459, 0.25), 48);
  const tendrils = new InstancedMesh(geo(new TorusGeometry(1.3, 0.1, 4, 12, Math.PI * 1.4)), mat(0x48efb7, 0x48efb7, 0.45), 24);
  const skyline = new InstancedMesh(geo(new CylinderGeometry(0.7, 1.3, 1, 6)), mat(0x252c49), 36);
  const scenery = [arches, branches, skyline, tendrils];
  for (const mesh of scenery) { mesh.frustumCulled = false; scene.add(mesh); }
  let sceneryBase = Number.NaN;
  const placeScenery = (distance: number) => {
    const base = Math.floor(distance / 20) * 20 - 20;
    if (base === sceneryBase) return;
    sceneryBase = base;
    for (let i = 0; i < 10; i++) {
      const z = base + i * 20, zone = sectionIndex(Math.max(0, z));
      const tunnel = zone === 1 || zone >= 3;
      dummy.position.set(0, tunnel ? 0.3 : -0.5, z);
      dummy.rotation.set(0, 0, zone === 2 ? Math.sin(z) * 0.15 : 0);
      dummy.scale.set(tunnel ? 1 : 1.3, zone === 3 ? 0.85 : zone === 4 ? 1.25 : 1, 1); dummy.updateMatrix(); arches.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 48; i++) {
      const z = base + Math.floor(i / 4) * 12, zone = sectionIndex(Math.max(0, z));
      const side = i % 2 ? 1 : -1, organic = zone === 2;
      dummy.position.set(side * (organic ? 5.5 : 7), 2 + (i % 4 < 2 ? 0 : 2.5), z);
      dummy.rotation.set(organic ? 0.2 : 0, 0, side * (organic ? 0.7 : 0.2));
      dummy.scale.set(1, organic ? 1.4 : 0.8, 1); dummy.updateMatrix(); branches.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 36; i++) {
      const z = base + Math.floor(i / 2) * 10, side = i % 2 ? 1 : -1;
      const height = 4 + (Math.abs(Math.sin(z * 1.7)) * 9);
      dummy.position.set(side * (12 + (i % 3) * 3), height / 2 - 2, z);
      dummy.rotation.set(0, z * 0.1, 0); dummy.scale.set(1.6, height, 1.6); dummy.updateMatrix(); skyline.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < 24; i++) {
      const z = base + Math.floor(i / 2) * 12, zone = sectionIndex(Math.max(0, z)), side = i % 2 ? 1 : -1;
      dummy.position.set(side * 5.8, 3.4, z); dummy.rotation.set(0, side * 0.5, side * 0.5);
      dummy.scale.setScalar(zone === 2 ? 1.2 : 0); dummy.updateMatrix(); tendrils.setMatrixAt(i, dummy.matrix);
    }
    for (const mesh of scenery) mesh.instanceMatrix.needsUpdate = true;
    dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1);
  };
  let decorBase = { stripes: Number.NaN, pillars: Number.NaN };
  const placeDecor = (z: number) => {
    const stripeBase = Math.floor(z / STRIPE_SPACING) * STRIPE_SPACING - 2 * STRIPE_SPACING;
    const pillarBase = Math.floor(z / PILLAR_SPACING) * PILLAR_SPACING - 2 * PILLAR_SPACING;
    if (stripeBase !== decorBase.stripes) {
      for (let i = 0; i < STRIPES; i++) {
        dummy.position.set(0, 0.012, stripeBase + i * STRIPE_SPACING);
        dummy.updateMatrix();
        stripes.setMatrixAt(i, dummy.matrix);
      }
      stripes.instanceMatrix.needsUpdate = true;
    }
    if (pillarBase !== decorBase.pillars) {
      for (let i = 0; i < PILLAR_PAIRS * 2; i++) {
        const x = (i % 2 === 0 ? -1 : 1) * (1.5 * LANE_WIDTH + 2.2), pz = pillarBase + Math.floor(i / 2) * PILLAR_SPACING;
        dummy.position.set(x, 2.25, pz); dummy.updateMatrix(); cones.setMatrixAt(i, dummy.matrix);
        dummy.position.set(x, 4.7, pz); dummy.updateMatrix(); nodes.setMatrixAt(i, dummy.matrix);
      }
      cones.instanceMatrix.needsUpdate = true;
      nodes.instanceMatrix.needsUpdate = true;
    }
    decorBase = { stripes: stripeBase, pillars: pillarBase };
  };

  // Original articulated energy construct: floating visor, tapered torso and jointed running limbs.
  const player = new Group();
  const body = new Group();
  const coreMat = mat(COLORS.core, COLORS.core, 0.55);
  const crashMat = mat(COLORS.crash, COLORS.crash, 0.6);
  const core = new Mesh(geo(new CapsuleGeometry(0.23, 0.36, 3, 8)), coreMat);
  core.position.y = 0.91;
  const ring = new Mesh(geo(new TorusGeometry(0.5, 0.06, 6, 12)), mat(COLORS.ring, COLORS.ring, 0.7));
  ring.position.y = 0.9; ring.rotation.x = Math.PI / 2;
  const finGeo = geo(new CapsuleGeometry(0.085, 0.32, 2, 6));
  const finMat = mat(COLORS.fin, COLORS.fin, 0.3);
  const finL = new Mesh(finGeo, finMat); finL.position.set(-0.32, 0.87, 0);
  const finR = new Mesh(finGeo, finMat); finR.position.set(0.32, 0.87, 0);
  const head = new Mesh(geo(new IcosahedronGeometry(0.25, 1)), coreMat); head.position.y = 1.36;
  const visor = new Mesh(geo(new CapsuleGeometry(0.07, 0.22, 2, 6)), mat(0xffffff, 0x9fffff, 0.8));
  visor.rotation.z = Math.PI / 2; visor.position.set(0, 1.38, 0.2);
  const legL = new Mesh(finGeo, finMat), legR = new Mesh(finGeo, finMat);
  legL.position.set(-0.15, 0.32, 0); legR.position.set(0.15, 0.32, 0);
  ring.scale.setScalar(0.7); ring.position.y = 0.72;
  body.add(core, ring, finL, finR, head, visor, legL, legR);
  player.add(body);
  scene.add(player);

  // BLOCK: solid wall from the ground with a bright top edge (jump it). HIGH_GATE: open arch, the bar hangs above a
  // lit underside strip (slide under it). Same collision boxes as simulation.ts.
  const blockGeo = geo(new RoundedBoxGeometry(1.8, BLOCK.top - BLOCK.bottom, BLOCK.halfDepth * 2, 1, 0.12));
  const blockEdgeGeo = geo(new BoxGeometry(1.86, 0.08, BLOCK.halfDepth * 2 + 0.04));
  const blockMat = mat(COLORS.block, COLORS.block, 0.25);
  const blockEdgeMat = mat(COLORS.blockEdge, COLORS.blockEdge, 0.8);
  const gateBarGeo = geo(new RoundedBoxGeometry(1.9, HIGH_GATE.top - HIGH_GATE.bottom, HIGH_GATE.halfDepth * 2, 1, 0.12));
  const gateUnderGeo = geo(new BoxGeometry(1.9, 0.06, HIGH_GATE.halfDepth * 2 + 0.04));
  const gatePostGeo = geo(new CylinderGeometry(0.07, 0.1, HIGH_GATE.top, 6));
  const gateMat = mat(COLORS.gate, COLORS.gate, 0.3);
  const gateUnderMat = mat(COLORS.gateUnder, COLORS.gateUnder, 0.9);
  const shardGeo = geo(new OctahedronGeometry(0.3, 0));
  const shardMat = mat(COLORS.shard, COLORS.shard, 0.9);
  const shardHalos = new InstancedMesh(geo(new TorusGeometry(0.38, 0.025, 3, 10)), mat(0x6abacb, 0x6abacb, 0.4), 40);
  shardHalos.frustumCulled = false; scene.add(shardHalos);

  const obstacleMeshes = new Map<number, { type: 'BLOCK' | 'HIGH_GATE'; group: Group }>();
  const shardMeshes = new Map<number, { mesh: Mesh; collectedAt: number | null }>();
  const live = new Set<number>();
  const obstaclePool: Record<'BLOCK' | 'HIGH_GATE', Group[]> = { BLOCK: [], HIGH_GATE: [] };
  const shardPool: Mesh[] = [];

  const makeObstacle = (type: 'BLOCK' | 'HIGH_GATE'): Group => {
    const g = new Group();
    if (type === 'BLOCK') {
      const wall = new Mesh(blockGeo, blockMat); wall.position.y = (BLOCK.top + BLOCK.bottom) / 2;
      const edge = new Mesh(blockEdgeGeo, blockEdgeMat); edge.position.y = BLOCK.top;
      g.add(wall, edge);
    } else {
      const bar = new Mesh(gateBarGeo, gateMat); bar.position.y = (HIGH_GATE.top + HIGH_GATE.bottom) / 2;
      const under = new Mesh(gateUnderGeo, gateUnderMat); under.position.y = HIGH_GATE.bottom;
      const left = new Mesh(gatePostGeo, gateMat); left.position.set(-0.98, HIGH_GATE.top / 2, 0);
      const right = new Mesh(gatePostGeo, gateMat); right.position.set(0.98, HIGH_GATE.top / 2, 0);
      g.add(bar, under, left, right);
    }
    return g;
  };

  // keeps the entity → mesh maps in step with the simulation arrays (create new ids, drop pruned ones)
  const sync = (state: SimState, timeMs: number) => {
    live.clear();
    for (const o of state.obstacles) {
      live.add(o.id);
      let entry = obstacleMeshes.get(o.id);
      // ids restart at 1 on every new run, so a still-drawn id may now be the other obstacle type
      if (entry && entry.type !== o.type) { scene.remove(entry.group); if (obstaclePool[entry.type].length < 16) obstaclePool[entry.type].push(entry.group); entry = undefined; }
      if (!entry) { entry = { type: o.type, group: obstaclePool[o.type].pop() ?? makeObstacle(o.type) }; obstacleMeshes.set(o.id, entry); scene.add(entry.group); }
      entry.group.position.x = laneX(o.lane);
      entry.group.position.z = o.z;
    }
    for (const [id, entry] of obstacleMeshes) if (!live.has(id)) { scene.remove(entry.group); obstacleMeshes.delete(id); if (obstaclePool[entry.type].length < 16) obstaclePool[entry.type].push(entry.group); }
    live.clear();
    let haloCount = 0;
    for (const s of state.shards) {
      live.add(s.id);
      let entry = shardMeshes.get(s.id);
      if (!entry) { entry = { mesh: shardPool.pop() ?? new Mesh(shardGeo, shardMat), collectedAt: null }; shardMeshes.set(s.id, entry); scene.add(entry.mesh); }
      entry.mesh.position.set(laneX(s.lane), (SHARD.bottom + SHARD.top) / 2, s.z);
      if (!s.collected) {
        entry.mesh.visible = true; entry.mesh.scale.set(0.8, 1.3, 0.8);
        if (haloCount < 40) {
          dummy.position.copy(entry.mesh.position); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1);
          dummy.updateMatrix(); shardHalos.setMatrixAt(haloCount++, dummy.matrix);
        }
        continue;
      }
      // collected: a short decorative pop (skipped under reduced motion), then hidden
      if (entry.collectedAt === null) entry.collectedAt = timeMs;
      const age = timeMs - entry.collectedAt;
      const popping = !reducedMotion && age < SHARD_POP_MS;
      entry.mesh.visible = popping;
      if (popping) { entry.mesh.scale.setScalar(1 + age / SHARD_POP_MS); entry.mesh.position.y += age / 400; }
    }
    for (const [id, entry] of shardMeshes) if (!live.has(id)) { scene.remove(entry.mesh); shardMeshes.delete(id); if (shardPool.length < 40) shardPool.push(entry.mesh); }
    shardHalos.count = haloCount; shardHalos.instanceMatrix.needsUpdate = true;
  };

  let width = 0, height = 0;
  const pixelCap = software ? SOFTWARE_PIXEL_RATIO : MAX_PIXEL_RATIO;
  const resize = () => {
    const w = Math.max(1, Math.floor(container.clientWidth));
    const h = Math.max(1, Math.floor(container.clientHeight));
    const ratio = Math.min(window.devicePixelRatio || 1, pixelCap);
    if (w === width && h === height && renderer.getPixelRatio() === ratio) return;
    width = w; height = h;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // narrow portrait frames widen the field of view so all three lanes stay visible
    camera.fov = w / h < 0.8 ? 78 : 62;
    camera.updateProjectionMatrix();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(container);
  resize();

  let cameraX = 0;
  let activeLane = -1;
  let crashed = false;
  let previousY = 0, landingAt = -1000, zone = 0;
  const projected = new Vector3(), zoneColor = new Color(), oldColor = new Color();
  return {
    software,
    render(state, timeMs) {
      if (contextLost) return;
      resize();
      sync(state, timeMs);
      const z = state.distance;
      const x = playerX(state);
      player.position.set(x, state.y, z);
      // the slide visibly lowers the construct to its collision height
      const sliding = state.mode === 'SLIDE';
      body.scale.set(sliding ? 1.15 : 1, sliding ? PLAYER_SLIDE_HEIGHT / PLAYER_HEIGHT : 1, 1);
      if (previousY > 0 && state.y === 0) landingAt = timeMs;
      previousY = state.y;
      const motion = !reducedMotion && state.status === 'RUNNING';
      const cycle = motion ? Math.sin(state.distance * 2.5) * 0.7 : 0;
      legL.rotation.x = state.mode === 'JUMP' ? -0.8 : cycle;
      legR.rotation.x = state.mode === 'JUMP' ? 0.5 : -cycle;
      finL.rotation.x = -legL.rotation.x; finR.rotation.x = -legR.rotation.x;
      body.rotation.z = motion && state.laneProgress ? -(state.laneTo - state.laneFrom) * 0.18 : 0;
      body.rotation.x = sliding ? -0.4 : 0;
      if (motion && !sliding) body.scale.y *= 1 - Math.max(0, 1 - (timeMs - landingAt) / 160) * 0.14;
      const isCrashed = state.status === 'GAME_OVER';
      if (isCrashed !== crashed) { crashed = isCrashed; core.material = crashed ? crashMat : coreMat; }
      const lane = state.laneProgress > 0 ? state.laneTo : state.lane;
      if (lane !== activeLane) {
        activeLane = lane;
        strips.forEach((strip, i) => { strip.material = i === lane ? laneActiveMat : laneMat[i]; });
      }
      const t = timeMs / 1000;
      if (motion) {
        ring.rotation.z = t * 2.2;
      }
      if (!reducedMotion) for (const entry of shardMeshes.values()) entry.mesh.rotation.y = t * 2 + entry.mesh.position.z * 0.3;
      track.position.z = z + 60;
      placeScenery(z);
      placeDecor(z);
      zone = sectionIndex(z);
      const current = SECTIONS[zone], previous = SECTIONS[Math.max(0, zone - 1)];
      const blend = Math.min(1, Math.max(0, (z - current.start) / 90));
      zoneColor.setHex(previous.background).lerp(oldColor.setHex(current.background), blend);
      (scene.background as Color).copy(zoneColor); (scene.fog as Fog).color.copy(zoneColor);
      archMat.color.setHex(previous.accent).lerp(oldColor.setHex(current.accent), blend);
      archMat.emissive.copy(archMat.color);
      // stable runner camera: follows z exactly; lateral follow is damped, and locked to the centre under reduced motion
      cameraX = reducedMotion ? 0 : cameraX + (x * 0.45 - cameraX) * 0.15;
      positionRunCamera(camera, z, cameraX);
      renderer.render(scene, camera);
    },
    setReducedMotion(value) { reducedMotion = value; },
    resize,
    dispose() {
      observer?.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      for (const entry of obstacleMeshes.values()) scene.remove(entry.group);
      for (const entry of shardMeshes.values()) scene.remove(entry.mesh);
      obstacleMeshes.clear(); shardMeshes.clear();
      for (const decor of [stripes, cones, nodes, shardHalos, ...scenery]) { scene.remove(decor); decor.dispose(); }
      obstaclePool.BLOCK.length = 0; obstaclePool.HIGH_GATE.length = 0; shardPool.length = 0;
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      renderer.dispose();
      if (!contextLost) renderer.forceContextLoss();
      renderer.domElement.remove();
    },
    info() {
      const silhouettes: ObstacleSilhouette[] = [];
      const box = new Box3();
      for (const { type, group } of obstacleMeshes.values()) {
        group.updateMatrixWorld(true);
        let top = 0, openBelow = Number.POSITIVE_INFINITY;
        for (const part of group.children) {
          box.setFromObject(part);
          top = Math.max(top, box.max.y);
          if (box.max.x - box.min.x > 0.5) openBelow = Math.min(openBelow, Math.max(0, box.min.y));
        }
        silhouettes.push({ type, top: Number(top.toFixed(3)), openBelow: Number(openBelow.toFixed(3)), parts: group.children.length });
      }
      let poppingShards = 0;
      for (const entry of shardMeshes.values()) if (entry.collectedAt !== null && entry.mesh.visible) poppingShards += 1;
      return {
        calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries,
        programs: renderer.info.programs?.length ?? 0, pixelRatio: renderer.getPixelRatio(), width, height, aspect: camera.aspect,
        meshes: obstacleMeshes.size + shardMeshes.size, software, renderer: name,
        player: { x: player.position.x, y: player.position.y, scaleY: body.scale.y, crashed,
          screenX: projected.set(player.position.x, player.position.y + 0.8, -player.position.z).project(camera).x, lean: body.rotation.z },
        zone: SECTIONS[zone].name,
        activeLane, silhouettes, poppingShards,
      };
    },
  };
}
