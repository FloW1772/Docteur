import { useState, useEffect } from 'react';

// Breakpoint below which we treat the device as "mobile"
const MOBILE_BREAKPOINT = 768;

// True if the device likely has touch AND a small screen
export function isMobileDevice(): boolean {
  return (
    window.innerWidth < MOBILE_BREAKPOINT ||
    ('ontouchstart' in window && window.innerWidth < 1024)
  );
}

export function useMobile(): boolean {
  const [mobile, setMobile] = useState(() => isMobileDevice());

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return mobile;
}

// Auto-enable performance mode on first visit from mobile (if not already set)
export function initMobilePerformanceMode(): void {
  if (!isMobileDevice()) return;
  const VISUAL_KEY = 'docteur.visualSettings';
  try {
    const raw = localStorage.getItem(VISUAL_KEY);
    if (raw) return; // User already has explicit settings — respect them
    // No prior setting: default to performance mode on mobile
    localStorage.setItem(VISUAL_KEY, JSON.stringify({ flowParticles: false, bgAnimations: false }));
  } catch { /* ignore */ }
}
