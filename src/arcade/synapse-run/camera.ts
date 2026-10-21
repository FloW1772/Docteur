import type { PerspectiveCamera } from 'three';

/** Simulation travels +Z; presentation reflects Z so +X is screen-right in Three's right-handed camera.
 * The scene is reflected once, including every obstacle and shard; input and collision axes stay unchanged.
 */
export function positionRunCamera(camera: PerspectiveCamera, distance: number, lateral = 0): void {
  camera.position.set(lateral, 3.4, -distance + 6.8);
  camera.lookAt(lateral * 0.6, 1, -distance - 7);
  camera.updateMatrixWorld();
}
