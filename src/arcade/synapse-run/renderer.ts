// [GAME-4] Synapse Run — Three.js view of a SimState. Read-only with respect to the game: meshes mirror the
// simulation, they never decide anything (collision lives in simulation.ts). Original low-poly look built from
// primitive geometry and flat materials only: no textures, no model files, no remote assets.
import {
  AmbientLight, BoxGeometry, Color, ConeGeometry, DirectionalLight, Fog, Group, HemisphereLight, IcosahedronGeometry,
  Mesh, MeshLambertMaterial, OctahedronGeometry, PerspectiveCamera, PlaneGeometry, Scene, TetrahedronGeometry,
  TorusGeometry, WebGLRenderer, type Material, type BufferGeometry,
} from 'three';
import {
  BLOCK, HIGH_GATE, LANE_WIDTH, PLAYER_HEIGHT, PLAYER_SLIDE_HEIGHT, SHARD, laneX, playerX, type SimState,
} from './simulation.ts';

/** Canvas buffers never exceed this device-pixel ratio (keeps high-DPI screens from rendering huge buffers). */
export const MAX_PIXEL_RATIO = 2;
const PILLAR_SPACING = 8;
const PILLAR_PAIRS = 16;
const STRIPE_SPACING = 4;
const STRIPES = 32;

const COLORS = {
  background: 0x0a0814, lane: 0x1a1433, laneAlt: 0x221a40, divider: 0x5ee7ff, rail: 0x3dffaa,
  core: 0x5ee7ff, ring: 0x3dffaa, fin: 0xa78bfa, block: 0xff4fa3, gate: 0xffb547, shard: 0x9ff6ff, pillar: 0x2a2150, node: 0x3dffaa,
};

export interface RunRenderer {
  render(state: SimState, timeMs: number): void;
  setReducedMotion(value: boolean): void;
  resize(): void;
  dispose(): void;
  info(): { calls: number; triangles: number; geometries: number; pixelRatio: number; width: number; height: number; meshes: number; player: { x: number; y: number; scaleY: number } };
}

/** Throws if WebGL is unavailable; the caller shows the fallback (never retried). */
export function createRunRenderer(container: HTMLElement, options: { reducedMotion: boolean }): RunRenderer {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(COLORS.background, 1);
  renderer.domElement.className = 'sr-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  let reducedMotion = options.reducedMotion;
  const scene = new Scene();
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
  const track = new Group();
  for (let lane = 0; lane < 3; lane++) {
    const strip = new Mesh(laneGeo, laneMat[lane]);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(laneX(lane), 0, 0);
    track.add(strip);
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

  // cross stripes and side pillars are recycled along z: they give the sense of speed
  const stripeGeo = geo(new BoxGeometry(3 * LANE_WIDTH, 0.015, 0.12));
  const stripeMat = mat(0x2c2458);
  const stripes: Mesh[] = [];
  for (let i = 0; i < STRIPES; i++) { const m = new Mesh(stripeGeo, stripeMat); m.position.y = 0.012; scene.add(m); stripes.push(m); }
  const pillarGeo = geo(new ConeGeometry(0.45, 4.5, 5));
  const nodeGeo = geo(new IcosahedronGeometry(0.42, 0));
  const pillarMat = mat(COLORS.pillar);
  const nodeMat = mat(COLORS.node, COLORS.node, 0.8);
  const pillars: Group[] = [];
  for (let i = 0; i < PILLAR_PAIRS * 2; i++) {
    const g = new Group();
    const cone = new Mesh(pillarGeo, pillarMat); cone.position.y = 2.25; g.add(cone);
    const node = new Mesh(nodeGeo, nodeMat); node.position.y = 4.7; g.add(node);
    g.position.x = (i % 2 === 0 ? -1 : 1) * (1.5 * LANE_WIDTH + 2.2);
    scene.add(g); pillars.push(g);
  }

  // player: an abstract "light construct" — octahedron core, ring, two fins (original, code-generated)
  const player = new Group();
  const body = new Group();
  const core = new Mesh(geo(new OctahedronGeometry(0.42, 0)), mat(COLORS.core, COLORS.core, 0.55));
  core.position.y = 0.9;
  const ring = new Mesh(geo(new TorusGeometry(0.5, 0.06, 6, 12)), mat(COLORS.ring, COLORS.ring, 0.7));
  ring.position.y = 0.9; ring.rotation.x = Math.PI / 2;
  const finGeo = geo(new TetrahedronGeometry(0.28, 0));
  const finMat = mat(COLORS.fin, COLORS.fin, 0.3);
  const finL = new Mesh(finGeo, finMat); finL.position.set(-0.45, 0.55, 0);
  const finR = new Mesh(finGeo, finMat); finR.position.set(0.45, 0.55, 0);
  const base = new Mesh(geo(new ConeGeometry(0.32, 0.5, 6)), mat(COLORS.fin, COLORS.fin, 0.25));
  base.position.y = 0.28; base.rotation.x = Math.PI;
  body.add(core, ring, finL, finR, base);
  player.add(body);
  scene.add(player);

  const blockGeo = geo(new BoxGeometry(1.8, BLOCK.top - BLOCK.bottom, BLOCK.halfDepth * 2));
  const blockMat = mat(COLORS.block, COLORS.block, 0.25);
  const gateBarGeo = geo(new BoxGeometry(1.9, HIGH_GATE.top - HIGH_GATE.bottom, HIGH_GATE.halfDepth * 2));
  const gatePostGeo = geo(new BoxGeometry(0.14, HIGH_GATE.top, 0.14));
  const gateMat = mat(COLORS.gate, COLORS.gate, 0.3);
  const shardGeo = geo(new OctahedronGeometry(0.3, 0));
  const shardMat = mat(COLORS.shard, COLORS.shard, 0.9);

  const obstacleMeshes = new Map<number, Group | Mesh>();
  const shardMeshes = new Map<number, Mesh>();

  const makeObstacle = (type: 'BLOCK' | 'HIGH_GATE'): Group | Mesh => {
    if (type === 'BLOCK') {
      const m = new Mesh(blockGeo, blockMat);
      m.position.y = (BLOCK.top + BLOCK.bottom) / 2;
      return m;
    }
    const g = new Group();
    const bar = new Mesh(gateBarGeo, gateMat); bar.position.y = (HIGH_GATE.top + HIGH_GATE.bottom) / 2;
    const left = new Mesh(gatePostGeo, gateMat); left.position.set(-0.98, HIGH_GATE.top / 2, 0);
    const right = new Mesh(gatePostGeo, gateMat); right.position.set(0.98, HIGH_GATE.top / 2, 0);
    g.add(bar, left, right);
    return g;
  };

  // keeps the entity → mesh maps in step with the simulation arrays (create new ids, drop pruned ones)
  const sync = (state: SimState) => {
    const live = new Set<number>();
    for (const o of state.obstacles) {
      live.add(o.id);
      let mesh = obstacleMeshes.get(o.id);
      if (!mesh) { mesh = makeObstacle(o.type); obstacleMeshes.set(o.id, mesh); scene.add(mesh); }
      mesh.position.x = laneX(o.lane);
      mesh.position.z = o.z;
    }
    for (const [id, mesh] of obstacleMeshes) if (!live.has(id)) { scene.remove(mesh); obstacleMeshes.delete(id); }
    live.clear();
    for (const s of state.shards) {
      live.add(s.id);
      let mesh = shardMeshes.get(s.id);
      if (!mesh) { mesh = new Mesh(shardGeo, shardMat); shardMeshes.set(s.id, mesh); scene.add(mesh); }
      mesh.visible = !s.collected;
      mesh.position.set(laneX(s.lane), (SHARD.bottom + SHARD.top) / 2, s.z);
    }
    for (const [id, mesh] of shardMeshes) if (!live.has(id)) { scene.remove(mesh); shardMeshes.delete(id); }
  };

  let width = 0, height = 0;
  const resize = () => {
    const w = Math.max(1, Math.floor(container.clientWidth));
    const h = Math.max(1, Math.floor(container.clientHeight));
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
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
  return {
    render(state, timeMs) {
      resize();
      sync(state);
      const z = state.distance;
      const x = playerX(state);
      player.position.set(x, state.y, z);
      // the slide visibly lowers the construct to its collision height
      const sliding = state.mode === 'SLIDE';
      body.scale.set(sliding ? 1.15 : 1, sliding ? PLAYER_SLIDE_HEIGHT / PLAYER_HEIGHT : 1, 1);
      const t = timeMs / 1000;
      if (!reducedMotion && state.status === 'RUNNING') {
        ring.rotation.z = t * 2.2;
        core.rotation.y = t * 1.4;
      }
      for (const mesh of shardMeshes.values()) if (!reducedMotion) mesh.rotation.y = t * 2 + mesh.position.z * 0.3;
      track.position.z = z + 60;
      const stripeBase = Math.floor(z / STRIPE_SPACING) * STRIPE_SPACING - 2 * STRIPE_SPACING;
      stripes.forEach((m, i) => { m.position.z = stripeBase + i * STRIPE_SPACING; });
      const pillarBase = Math.floor(z / PILLAR_SPACING) * PILLAR_SPACING - 2 * PILLAR_SPACING;
      pillars.forEach((g, i) => { g.position.z = pillarBase + Math.floor(i / 2) * PILLAR_SPACING; });
      // stable runner camera: follows z exactly; lateral follow is damped, and locked to the centre under reduced motion
      cameraX = reducedMotion ? 0 : cameraX + (x * 0.45 - cameraX) * 0.15;
      camera.position.set(cameraX, 3.4, z - 6.8);
      camera.lookAt(cameraX * 0.6, 1.0, z + 7);
      renderer.render(scene, camera);
    },
    setReducedMotion(value) { reducedMotion = value; },
    resize,
    dispose() {
      observer?.disconnect();
      for (const mesh of obstacleMeshes.values()) scene.remove(mesh);
      for (const mesh of shardMeshes.values()) scene.remove(mesh);
      obstacleMeshes.clear(); shardMeshes.clear();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
    info() {
      return {
        calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries,
        pixelRatio: renderer.getPixelRatio(), width, height, meshes: obstacleMeshes.size + shardMeshes.size,
        player: { x: player.position.x, y: player.position.y, scaleY: body.scale.y },
      };
    },
  };
}
