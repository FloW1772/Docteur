import { useState, useEffect, useRef } from 'react';
import { checkServerOnline } from '../lib/storage';

const POLL_INTERVAL = 30_000;

// Returns null while the first check is in progress, then true/false.
// Only active when `enabled` is true (remote access mode).
export function useConnectivity(enabled: boolean): boolean | null {
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    async function check() {
      const online = await checkServerOnline();
      if (mountedRef.current) setIsOnline(online);
    }

    function onVisible() {
      if (document.visibilityState === 'visible') void check();
    }

    void check();
    const intervalId = setInterval(check, POLL_INTERVAL);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return isOnline;
}
