import React from 'react';
import { createRoot } from 'react-dom/client';
import Before from './brain-before';
import After from '../src/components/neural/NeuralBrain';
const pages = Array.from({ length: 6638 }, (_, i) => ({ id: `bench-${i}`, title: `Neuron ${i}`, kind: 'note', blocks: [], links: [], createdAt: i + 1, updatedAt: i + 1 }));
export function mount(before) {
  const Component = before ? Before : After;
  createRoot(document.getElementById('root')).render(<Component pages={pages} selectedPageId={null} bloomEnabled={false} />);
}
