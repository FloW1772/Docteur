import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import NeuralBrain from '../src/components/neural/NeuralBrain';

// Observe real allocation/dispose events without replacing the renderer.
const counters = { environments: 0, environmentDisposals: 0, roomDisposals: 0, bloomDisposals: 0, vignetteDisposals: 0 };
const originalEnvironment = THREE.PMREMGenerator.prototype.fromScene;
THREE.PMREMGenerator.prototype.fromScene = function (...args) {
  const target = originalEnvironment.apply(this, args);
  counters.environments++;
  target.addEventListener('dispose', () => counters.environmentDisposals++);
  return target;
};
for (const [prototype, counter] of [[RoomEnvironment.prototype, 'roomDisposals'], [UnrealBloomPass.prototype, 'bloomDisposals'], [ShaderPass.prototype, 'vignetteDisposals']]) {
  const original = prototype.dispose;
  prototype.dispose = function (...args) {
    if (counter !== 'vignetteDisposals' || ('strength' in this.uniforms && 'offset' in this.uniforms)) counters[counter]++;
    return original.apply(this, args);
  };
}
const root = createRoot(document.getElementById('root'));
const pages = [{ id: 'gpu', kind: 'note', title: 'Synthetic GPU fixture', blocks: [], createdAt: 1, updatedAt: 1, links: [] }];
window.gpuReview = { counters,
  render: compact => root.render(<StrictMode><NeuralBrain pages={pages} compact={compact} bloomEnabled /></StrictMode>),
  unmount: () => root.unmount(),
};
