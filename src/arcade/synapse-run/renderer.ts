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
  TetrahedronGeometry, TorusGeometry, WebGLRenderer, type Material, type BufferGeometry,
} from 'three';
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
  calls: number; triangles: number; geometries: number; programs: number; pixelRatio: number; width: number; height: number;
  meshes: number; software: boolean; renderer: string;
  player: { x: number; y: number; scaleY: number; crashed: boolean };
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

  // player: an abstract "light construct" — octahedron core, ring, two fins (original, code-generated)
  const player = new Group();
  const body = new Group();
  const coreMat = mat(COLORS.core, COLORS.core, 0.55);
  const crashMat = mat(COLORS.crash, COLORS.crash, 0.6);
  const core = new Mesh(geo(new OctahedronGeometry(0.42, 0)), coreMat);
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

  // BLOCK: solid wall from the ground with a bright top edge (jump it). HIGH_GATE: open arch, the bar hangs above a
  // lit underside strip (slide under it). Same collision boxes as simulation.ts.
  const blockGeo = geo(new BoxGeometry(1.8, BLOCK.top - BLOCK.bottom, BLOCK.halfDepth * 2));
  const blockEdgeGeo = geo(new BoxGeometry(1.86, 0.08, BLOCK.halfDepth * 2 + 0.04));
  const blockMat = mat(COLORS.block, COLORS.block, 0.25);
  const blockEdgeMat = mat(COLORS.blockEdge, COLORS.blockEdge, 0.8);
  const gateBarGeo = geo(new BoxGeometry(1.9, HIGH_GATE.top - HIGH_GATE.bottom, HIGH_GATE.halfDepth * 2));
  const gateUnderGeo = geo(new BoxGeometry(1.9, 0.06, HIGH_GATE.halfDepth * 2 + 0.04));
  const gatePostGeo = geo(new BoxGeometry(0.14, HIGH_GATE.top, 0.14));
  const gateMat = mat(COLORS.gate, COLORS.gate, 0.3);
  const gateUnderMat = mat(COLORS.gateUnder, COLORS.gateUnder, 0.9);
  const shardGeo = geo(new OctahedronGeometry(0.3, 0));
  const shardMat = mat(COLORS.shard, COLORS.shard, 0.9);

  const obstacleMeshes = new Map<number, { type: 'BLOCK' | 'HIGH_GATE'; group: Group }>();
  const shardMeshes = new Map<number, { mesh: Mesh; collectedAt: number | null }>();
  const live = new Set<number>();

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
      if (!entry) { entry = { type: o.type, group: makeObstacle(o.type) }; obstacleMeshes.set(o.id, entry); scene.add(entry.group); }
      entry.group.position.x = laneX(o.lane);
      entry.group.position.z = o.z;
    }
    for (const [id, entry] of obstacleMeshes) if (!live.has(id)) { scene.remove(entry.group); obstacleMeshes.delete(id); }
    live.clear();
    for (const s of state.shards) {
      live.add(s.id);
      let entry = shardMeshes.get(s.id);
      if (!entry) { entry = { mesh: new Mesh(shardGeo, shardMat), collectedAt: null }; shardMeshes.set(s.id, entry); scene.add(entry.mesh); }
      entry.mesh.position.set(laneX(s.lane), (SHARD.bottom + SHARD.top) / 2, s.z);
      if (!s.collected) { entry.mesh.visible = true; entry.mesh.scale.setScalar(1); continue; }
      // collected: a short decorative pop (skipped under reduced motion), then hidden
      if (entry.collectedAt === null) entry.collectedAt = timeMs;
      const age = timeMs - entry.collectedAt;
      const popping = !reducedMotion && age < SHARD_POP_MS;
      entry.mesh.visible = popping;
      if (popping) { entry.mesh.scale.setScalar(1 + age / SHARD_POP_MS); entry.mesh.position.y += age / 400; }
    }
    for (const [id, entry] of shardMeshes) if (!live.has(id)) { scene.remove(entry.mesh); shardMeshes.delete(id); }
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
      const isCrashed = state.status === 'GAME_OVER';
      if (isCrashed !== crashed) { crashed = isCrashed; core.material = crashed ? crashMat : coreMat; }
      const lane = state.laneProgress > 0 ? state.laneTo : state.lane;
      if (lane !== activeLane) {
        activeLane = lane;
        strips.forEach((strip, i) => { strip.material = i === lane ? laneActiveMat : laneMat[i]; });
      }
      const t = timeMs / 1000;
      if (!reducedMotion && state.status === 'RUNNING') {
        ring.rotation.z = t * 2.2;
        core.rotation.y = t * 1.4;
      }
      if (!reducedMotion) for (const entry of shardMeshes.values()) entry.mesh.rotation.y = t * 2 + entry.mesh.position.z * 0.3;
      track.position.z = z + 60;
      placeDecor(z);
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
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      for (const entry of obstacleMeshes.values()) scene.remove(entry.group);
      for (const entry of shardMeshes.values()) scene.remove(entry.mesh);
      obstacleMeshes.clear(); shardMeshes.clear();
      for (const decor of [stripes, cones, nodes]) { scene.remove(decor); decor.dispose(); }
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
        programs: renderer.info.programs?.length ?? 0, pixelRatio: renderer.getPixelRatio(), width, height,
        meshes: obstacleMeshes.size + shardMeshes.size, software, renderer: name,
        player: { x: player.position.x, y: player.position.y, scaleY: body.scale.y, crashed },
        activeLane, silhouettes, poppingShards,
      };
    },
  };
}
