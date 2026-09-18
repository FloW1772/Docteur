// Generic low-frequency polling hook for HUD module-summary widgets — NOT
// the same use case as video-job-polling.ts's startJobPolling (which polls
// a single job until a terminal status, then stops). This hook keeps
// polling at a fixed interval for as long as the component using it is
// mounted (e.g. "what's MetaGPT's latest mission state" on the dashboard),
// pausing while the tab is hidden to avoid wasted background requests
// (mission requirement: "pas de polling agressif inutile").
import { useEffect, useRef, useState } from 'react';

export interface PollResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useIntervalPoll<T>(
  fetcher: () => Promise<T>,
  intervalMs = 15000,
  deps: unknown[] = [],
): PollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (document.hidden) {
        // Skip the network call entirely while the tab is hidden — reschedule
        // and re-check later rather than polling in the background.
        timer = setTimeout(tick, intervalMs);
        return;
      }
      try {
        const result = await fetcherRef.current();
        if (stopped) return;
        setData(result);
        setError(null);
      } catch (e) {
        if (stopped) return;
        setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }

    void tick();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  return { data, loading, error };
}
