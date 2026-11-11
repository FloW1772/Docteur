// [VISUAL-2] Synapse Run — shared kit of the visual universes (world-dawn.ts, world-city.ts; directed by worlds.ts).
// The kit owns, for the renderer's lifetime, ONE shaded unit box and the TWO materials universe 1 introduced: every
// universe draws with them, so the shader programs stay at those two and the box stays one geometry whatever the
// number of universes. A universe owns only its backdrop geometry and its InstancedMesh, and releases exactly those
// when the director retires it; it never disposes anything from the kit.
// Helpers and stage constants moved here unchanged from world-dawn.ts (universe 1 renders the same vertices).
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedMesh, Mesh, MeshBasicMaterial, Object3D,
  PerspectiveCamera, PlaneGeometry, Vector3, type Scene,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { positionRunCamera } from './camera.ts';

/** Stage shared by every backdrop, in the runner's frame (z ahead of the player). */
export const SKY_Z = 120; // backdrop distance ahead of the player (camera far plane: 140)
export const SKY_HALF_WIDTH = 260;
export const FLOOR_Y = -0.3;
export const FLOOR_FROM = -20, FLOOR_TO = 116, FLOOR_ROWS = 17; // 8 m rows follow the fog curve closely

export type Stops = readonly (readonly [number, number])[];

/** A universe as the director sees it. fade: 0 = fully drawn, 1 = melted into the zone colour `haze`. */
export interface World {
  update(distance: number, timeMs: number, fade: number, haze: Color): void;
  setReducedMotion(value: boolean): void;
  /** releases the universe's own backdrop geometry and InstancedMesh (never a kit resource) */
  dispose(): void;
}
export interface WorldOptions { reducedMotion: boolean; software: boolean; /** distance at creation */ from: number }

/** Deterministic 0..1 value per scenery cell (no Math.random; the course never sees it). */
export const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
export const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const tmp = new Color(), tmp2 = new Color();

export function gradient(out: Color, stops: Stops, y: number): void {
  let i = 1;
  while (i < stops.length - 1 && y > stops[i][0]) i++;
  const [y0, c0] = stops[i - 1], [y1, c1] = stops[i];
  out.setHex(c0).lerp(tmp2.setHex(c1), Math.max(0, Math.min(1, (y - y0) / (y1 - y0))));
}

/** Unlit part: normals / uvs dropped, one colour per vertex from its local position. */
export function paint(geometry: BufferGeometry, colorAt: (out: Color, y: number, index: number) => void): BufferGeometry {
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) { colorAt(tmp, position.getY(i), i); tmp.toArray(colors, i * 3); }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}
export const flat = (hex: number) => (out: Color) => { out.setHex(hex); };

/** Sky: one quad strip at the backdrop distance, a row of two vertices per gradient stop. */
export function skyStrip(stops: Stops): BufferGeometry {
  const sky = new BufferGeometry();
  const rows = new Float32Array(stops.length * 6), index: number[] = [];
  stops.forEach(([y], i) => {
    rows.set([-SKY_HALF_WIDTH, y, SKY_Z, SKY_HALF_WIDTH, y, SKY_Z], i * 6);
    if (i > 0) index.push(2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i - 2, 2 * i + 1, 2 * i);
  });
  sky.setAttribute('position', new BufferAttribute(rows, 3));
  sky.setIndex(index);
  return paint(sky, (out, y) => gradient(out, stops, y));
}

/** Horizontal strip on the floor, FLOOR_FROM → FLOOR_TO, in FLOOR_ROWS rows (enough vertices to bake the fog). */
export const floorStrip = (width: number, x: number, y: number) =>
  new PlaneGeometry(width, FLOOR_TO - FLOOR_FROM, 1, FLOOR_ROWS).rotateX(-Math.PI / 2).translate(x, y, (FLOOR_FROM + FLOOR_TO) / 2);
/** Vertical strip facing the track, FLOOR_FROM → FLOOR_TO (an elevated light line seen from the side). */
export const wallStrip = (height: number, x: number, y: number) =>
  new PlaneGeometry(FLOOR_TO - FLOOR_FROM, height, FLOOR_ROWS, 1).rotateY(Math.PI / 2).translate(x, y, (FLOOR_FROM + FLOOR_TO) / 2);

export function mergeParts(parts: BufferGeometry[], label: string): BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error(label);
  return merged;
}

/** Unit box standing on y = 0. Its vertex shade multiplies each instance colour: darker base, lighter top, darker front. */
function shadedBox(): BufferGeometry {
  // BoxGeometry: 4 vertices per face, in the order +x, −x, +y, −y, +z, −z (−z faces the camera)
  return paint(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), (out, y, i) => {
    const face = i >> 2;
    const shade = face < 2 ? 0.62 + 0.38 * y : face === 2 ? 1 : face === 3 ? 0.4 : 0.5 + 0.32 * y;
    out.setRGB(shade, shade, shade);
  });
}

export interface WorldKit {
  readonly box: BufferGeometry;
  readonly backdropMaterial: MeshBasicMaterial;
  readonly cityMaterial: MeshBasicMaterial;
  readonly fogNear: number;
  readonly fogFar: number;
  dispose(): void;
}

export function createWorldKit(options: { fogNear: number; fogFar: number }): WorldKit {
  const box = shadedBox();
  const backdropMaterial = new MeshBasicMaterial({ vertexColors: true, fog: false, side: DoubleSide });
  const cityMaterial = new MeshBasicMaterial({ vertexColors: true });
  return {
    box, backdropMaterial, cityMaterial, fogNear: options.fogNear, fogFar: options.fogFar,
    dispose() { box.dispose(); backdropMaterial.dispose(); cityMaterial.dispose(); },
  };
}

export interface Backdrop {
  /** follows the player and melts into `haze` by `fade` (repainted only when either changes) */
  update(distance: number, fade: number, haze: Color): void;
  setVisible(value: boolean): void;
  dispose(): void;
}

/** Camera-anchored merged mesh. Vertices up to FLOOR_TO get the scene's fog baked in (their camera depth is fixed). */
export function createBackdrop(kit: WorldKit, scene: Scene, geometry: BufferGeometry): Backdrop {
  const mesh = new Mesh(geometry, kit.backdropMaterial);
  mesh.frustumCulled = false;
  // fog baked per floor vertex with the scene's own curve (smoothstep over view depth from the runner camera)
  const probe = new PerspectiveCamera();
  positionRunCamera(probe, 0);
  const v = new Vector3();
  const position = geometry.getAttribute('position'), colors = geometry.getAttribute('color') as BufferAttribute;
  const base = Float32Array.from(colors.array), fogWeight = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    if (position.getZ(i) > FLOOR_TO) continue; // backdrop pieces are never fogged
    // the scene is mirrored in z (scene.scale.z = −1): world z = −local z
    fogWeight[i] = smoothstep(kit.fogNear, kit.fogFar, -v.set(position.getX(i), position.getY(i), -position.getZ(i)).applyMatrix4(probe.matrixWorldInverse).z);
  }
  scene.add(mesh);

  let paintedFade = -1;
  const paintedHaze = new Color();
  const repaint = (fade: number, haze: Color) => {
    const out = colors.array;
    for (let i = 0, c = 0; i < fogWeight.length; i++, c += 3) {
      const t = 1 - (1 - fogWeight[i]) * (1 - fade);
      out[c] = base[c] + (haze.r - base[c]) * t;
      out[c + 1] = base[c + 1] + (haze.g - base[c + 1]) * t;
      out[c + 2] = base[c + 2] + (haze.b - base[c + 2]) * t;
    }
    colors.needsUpdate = true;
    paintedFade = fade;
    paintedHaze.copy(haze);
  };
  return {
    update(distance, fade, haze) {
      mesh.position.z = distance;
      if (fade !== paintedFade || !haze.equals(paintedHaze)) repaint(fade, haze);
    },
    setVisible(value) { mesh.visible = value; },
    dispose() { scene.remove(mesh); geometry.dispose(); },
  };
}

export interface CityLayer {
  readonly mesh: InstancedMesh;
  put(i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void;
  hide(i: number): void;
  dispose(): void;
}

/** World-anchored instances of the kit's shaded box (one draw call); instance colours multiply the box shade. */
export function createCityLayer(kit: WorldKit, scene: Scene, count: number): CityLayer {
  const mesh = new InstancedMesh(kit.box, kit.cityMaterial, count);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const dummy = new Object3D();
  const put = (i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    dummy.position.set(x, y, z); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
  };
  return {
    mesh, put,
    hide: i => put(i, 0, FLOOR_Y, 0, 0, 0, 0),
    // InstancedMesh.dispose() releases its instance buffers only: the shared box and material stay with the kit
    dispose() { scene.remove(mesh); mesh.dispose(); },
  };
}
