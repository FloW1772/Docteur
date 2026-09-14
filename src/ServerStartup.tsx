import { useEffect, useState } from 'react';
import App from './App';

// Waits for cortex-server's /api/ping to respond before mounting the real
// App — split out of main.tsx (a plain bootstrap entry with no exports) so
// this file exports only a component, which Vite's Fast Refresh needs to
// treat it as a valid refresh boundary during development.
export function ServerStartup() {
  const [ready, setReady] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = performance.now();
    let attempts = 0;
    async function probe() {
      attempts++;
      try {
        const response = await fetch(`${location.protocol}//${location.hostname}:3001/api/ping`, { signal: AbortSignal.timeout(2000) });
        if (response.ok && !cancelled) {
          console.info('[startup] backend ready before App mount', { elapsedMs: Math.round(performance.now() - started), attempts, at: new Date().toISOString() });
          setReady(true);
          return;
        }
      } catch (error) {
        // The backend simply isn't listening yet — expected during startup,
        // browsers already log the underlying ERR_CONNECTION_REFUSED
        // themselves, so this stays silent to avoid doubling that spam.
        // Anything else (timeout aside — same "not ready yet" case) is a real,
        // unexpected failure of the probe itself and must stay visible.
        const name = (error as { name?: string } | null)?.name;
        const isExpectedNotReadyYet = name === 'TypeError' || name === 'TimeoutError' || name === 'AbortError';
        if (!isExpectedNotReadyYet) {
          console.warn('[startup] unexpected error while probing backend readiness', error);
        }
      }
      if (!cancelled) {
        setElapsed(Math.round((performance.now() - started) / 1000));
        // Backoff starts gentler (800ms) than before and still caps at 5s —
        // fewer failed requests logged by the browser itself while the
        // backend is merely not up yet, without slowing down real startup.
        timer = setTimeout(probe, Math.min(5000, 800 * 1.6 ** Math.min(attempts, 5)));
      }
    }
    void probe();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  if (ready) return <App />;
  return <div role="status" style={{ padding: 40, color: '#f0eaff' }}>
    Connexion au serveur en cours... {elapsed}s
    {elapsed >= 15 && <button onClick={() => setReady(true)} style={{ display: 'block', marginTop: 20 }}>Ouvrir la copie hors ligne</button>}
  </div>;
}
