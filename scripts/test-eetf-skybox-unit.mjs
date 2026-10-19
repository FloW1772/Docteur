// [EETF V1] EETF-6 — unit tests of the client skybox preview builder (Three.js, Node type stripping).
// Usage: node --test scripts/test-eetf-skybox-unit.mjs
// No WebGL, no network: only the scene objects are built and inspected.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildSkyboxPreview, validatePreviewParams, PREVIEW_LIMITS } from '../src/lib/eetf/skybox-preview.ts';
import { RESOURCE_LIMITS } from '../cortex-server/src/lib/eetf-contracts.js';

const texture = () => { const t = new THREE.DataTexture(new Uint8Array(4 * 2 * 4).fill(128), 4, 2); t.needsUpdate = true; return t; };

test('inside-out sphere with the panorama texture; sRGB assumed; PREVIEW_ONLY labels on the scene', () => {
  const tex = texture();
  const p = buildSkyboxPreview(tex, { yaw: 30, pitch: -10, fov: 90, aspect: 16 / 9 });
  assert.ok(p.mesh.geometry instanceof THREE.SphereGeometry);
  p.mesh.geometry.computeBoundingBox();
  assert.ok(p.mesh.geometry.attributes.position.count > 0);
  // scale(-1, 1, 1) flips the winding so the inside is rendered: the first vertex x has the opposite sign of a fresh sphere
  const fresh = new THREE.SphereGeometry(50, 64, 32);
  assert.equal(p.mesh.geometry.attributes.position.getX(10), -fresh.attributes.position.getX(10));
  assert.equal(p.mesh.material.map, tex);
  assert.equal(tex.colorSpace, THREE.SRGBColorSpace);
  assert.deepEqual([...p.labels], ['PREVIEW_ONLY', 'NOT_CERTIFIED_EQUIRECTANGULAR', 'NOT_A_SCENE_CAMERA', 'NOT_A_CUBEMAP']);
  assert.equal(p.scene.userData.eetf.previewOnly, true);
  assert.ok(p.scene.children.includes(p.mesh));
  p.dispose();
});

test('camera: horizontal fov → vertical fov, yaw / pitch as a viewer orientation (YXZ)', () => {
  const p = buildSkyboxPreview(texture(), { yaw: 90, pitch: 20, fov: 90, aspect: 2 });
  const expected = (2 * Math.atan(Math.tan(Math.PI / 4) / 2)) * 180 / Math.PI;
  assert.ok(Math.abs(p.camera.fov - expected) < 1e-9);
  assert.equal(p.camera.aspect, 2);
  assert.equal(p.camera.rotation.order, 'YXZ');
  assert.ok(Math.abs(p.camera.rotation.y + Math.PI / 2) < 1e-9 && Math.abs(p.camera.rotation.x - (20 * Math.PI) / 180) < 1e-9);
});

test('parameter validation mirrors the backend bounds; NaN / Infinity / extreme values and non-textures refused', () => {
  assert.equal(PREVIEW_LIMITS.fovMin, RESOURCE_LIMITS.previewFovMinDeg.value);
  assert.equal(PREVIEW_LIMITS.fovMax, RESOURCE_LIMITS.previewFovMaxDeg.value);
  assert.deepEqual({ ...validatePreviewParams() }, { yaw: 0, pitch: 0, fov: 90, aspect: 16 / 9 });
  for (const bad of [{ fov: Number.NaN }, { fov: Infinity }, { fov: 10 }, { fov: 170 }, { yaw: 181 }, { pitch: -91 }, { aspect: 0 }, { aspect: 100 }]) {
    assert.throws(() => validatePreviewParams(bad), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => buildSkyboxPreview({ image: 'javascript:alert(1)' }), TypeError);
  assert.throws(() => buildSkyboxPreview('https://example.com/pano.png'), TypeError, 'a URL is never loaded by the builder');
});
