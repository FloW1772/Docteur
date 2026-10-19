// EETF V1 — EETF-6 skybox preview (client side, Three.js already bundled by Docteur).
//
// Builds an inside-out sphere textured with a PANORAMA_REFERENCE image so the user can look around it.
// PREVIEW ONLY: the image is treated AS IF equirectangular for display; nothing here certifies the
// projection, produces cubemap faces, or turns yaw / pitch / fov into a scene camera.
// EXR / HDR panoramas hold LDR content in V1, so the viewer is fed a PNG derivative: RGBELoader /
// EXRLoader are not needed (no new dependency). The texture is injected (no network fetch here).
// Not wired into the UI yet (EETF-7).
import * as THREE from 'three';

/** Same bounds as the backend (cortex-server/src/lib/eetf-environments.js, PROVISIONAL limits). */
export const PREVIEW_LIMITS = Object.freeze({ yawMin: -180, yawMax: 180, pitchMin: -90, pitchMax: 90, fovMin: 30, fovMax: 120 });

export interface SkyboxPreviewParams { yaw?: number; pitch?: number; fov?: number; aspect?: number }
export interface SkyboxPreview {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mesh: THREE.Mesh;
  params: Readonly<{ yaw: number; pitch: number; fov: number; aspect: number }>;
  labels: readonly string[];
  dispose: () => void;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new RangeError(`${name} must be a finite number in [${min}, ${max}]`);
  return v;
}

export function validatePreviewParams(p: SkyboxPreviewParams = {}): Readonly<{ yaw: number; pitch: number; fov: number; aspect: number }> {
  return Object.freeze({
    yaw: bounded(p.yaw, 0, PREVIEW_LIMITS.yawMin, PREVIEW_LIMITS.yawMax, 'yaw'),
    pitch: bounded(p.pitch, 0, PREVIEW_LIMITS.pitchMin, PREVIEW_LIMITS.pitchMax, 'pitch'),
    fov: bounded(p.fov, 90, PREVIEW_LIMITS.fovMin, PREVIEW_LIMITS.fovMax, 'fov'),
    aspect: bounded(p.aspect, 16 / 9, 0.25, 4, 'aspect'),
  });
}

/**
 * `fov` is the HORIZONTAL field of view (as in the backend view renderer); it is converted to the vertical
 * fov Three.js expects. Pixel-exact agreement with the backend rendered view is NOT claimed (different
 * sampling and sphere UV conventions); both only share the same parameter bounds.
 */
/** EETF-7: updates an existing preview's camera (same bounds); nothing is rebuilt or reallocated. */
export function applyPreviewParams(preview: SkyboxPreview, params: SkyboxPreviewParams): Readonly<{ yaw: number; pitch: number; fov: number; aspect: number }> {
  const p = validatePreviewParams(params);
  const d2r = Math.PI / 180;
  preview.camera.fov = (2 * Math.atan(Math.tan((p.fov * d2r) / 2) / p.aspect)) / d2r;
  preview.camera.aspect = p.aspect;
  preview.camera.rotation.y = -p.yaw * d2r;
  preview.camera.rotation.x = p.pitch * d2r;
  preview.camera.updateProjectionMatrix();
  return p;
}

export function buildSkyboxPreview(texture: THREE.Texture, params: SkyboxPreviewParams = {}): SkyboxPreview {
  if (!(texture instanceof THREE.Texture)) throw new TypeError('an already loaded THREE.Texture is required');
  const p = validatePreviewParams(params);
  texture.colorSpace = THREE.SRGBColorSpace; // sRGB assumed (profiles are stripped by EETF)
  const geometry = new THREE.SphereGeometry(50, 64, 32);
  geometry.scale(-1, 1, 1); // look at the inside of the sphere
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const d2r = Math.PI / 180;
  const vfov = (2 * Math.atan(Math.tan((p.fov * d2r) / 2) / p.aspect)) / d2r;
  const camera = new THREE.PerspectiveCamera(vfov, p.aspect, 0.1, 100);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = -p.yaw * d2r;
  camera.rotation.x = p.pitch * d2r;
  const labels = Object.freeze(['PREVIEW_ONLY', 'NOT_CERTIFIED_EQUIRECTANGULAR', 'NOT_A_SCENE_CAMERA', 'NOT_A_CUBEMAP']);
  scene.userData = { eetf: { previewOnly: true, labels } };
  return {
    scene, camera, mesh, params: p, labels,
    dispose: () => { geometry.dispose(); material.dispose(); },
  };
}
