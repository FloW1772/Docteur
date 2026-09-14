import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useGestureCamera } from '../src/hooks/useGestureCamera';
import NeuralBrain from '../src/components/neural/NeuralBrain';
function Harness() {
  const input = useRef(null);
  const gesture = useGestureCamera({ settings: { cortex3dEnabled: true, navigationEnabled: true, sensitivity: 5, easterEggEnabled: false },
    onNext: () => window.actions.push('next'), onPrev: () => window.actions.push('prev'),
    onScroll: () => window.actions.push('scroll'), onRotate: (x, y) => { window.actions.push('rotate'); input.current?.(x, y, 0); }, onZoom: () => {} });
  window.gestureTest = gesture;
  return <><video ref={gesture.videoRef} /><NeuralBrain pages={[]} gestureInputRef={input} bloomEnabled={false} /></>;
}
export function mount() { window.actions = []; createRoot(document.getElementById('root')).render(<Harness />); }
