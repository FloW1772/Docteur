// Tracks the user's prefers-reduced-motion OS/browser setting, live. CSS
// animations are neutralized globally via globals.css's media query; this
// hook exists for animation loops CSS cannot reach (WebGL/canvas/rAF-driven
// code, e.g. NeuralBrain's shader breathing and pulse easing).
import { useEffect, useState } from 'react';

function getPreference(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(getPreference);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  return reduced;
}
