// [LOAD-1/LOAD-2] Docteur boot screen. Shown until the local backend answers its readiness ping
// (src/lib/startup/readiness.ts), then renders the application exactly once. Every state shown is one the frontend
// actually observed — no fake steps, no percentage. "Réessayer" only re-runs the read-only ping; nothing is started,
// restarted or executed from here.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import LoadingSpinner from '../loading/LoadingSpinner';
import {
  createReadinessPoller, initialStartupState, probeBackend, STARTUP_POLICY,
  type ProbeOutcome, type ReadinessPoller, type StartupPhase, type StartupState,
} from '../../lib/startup/readiness';
import { outcomeText, STARTUP_TEXT } from '../../lib/startup/startup-text';
import './startup.css';

type ScreenPhase = Exclude<StartupPhase, 'READY'>;

const VIEW: Readonly<Record<ScreenPhase, { label: string; detail: string | null; serverStep: string }>> = {
  STARTING: { label: STARTUP_TEXT.starting, detail: null, serverStep: 'vérification…' },
  WAITING: { label: STARTUP_TEXT.waiting, detail: STARTUP_TEXT.waitingDetail, serverStep: 'en attente' },
  DELAYED: { label: STARTUP_TEXT.delayed, detail: STARTUP_TEXT.delayedDetail, serverStep: 'en attente' },
  FAILED: { label: STARTUP_TEXT.failed, detail: null, serverStep: 'ne répond pas' },
};

const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));
const isPolling = (phase: StartupPhase) => phase === 'STARTING' || phase === 'WAITING' || phase === 'DELAYED';

function useStartupReadiness(probe: (signal: AbortSignal) => Promise<ProbeOutcome>) {
  const [state, setState] = useState<StartupState>(() => initialStartupState(Date.now()));
  const poller = useRef<ReadinessPoller | null>(null);
  useEffect(() => {
    const p = createReadinessPoller({
      probe,
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      onChange: (next) => {
        if (next.phase === 'READY') console.info('[startup] backend ready before App mount', { elapsedMs: (next.lastCheckAt ?? next.startedAt) - next.startedAt, attempts: next.attempts });
        setState(next);
      },
    });
    poller.current = p;
    p.start();
    return () => { p.stop(); if (poller.current === p) poller.current = null; };
  }, [probe]);
  return { state, retry: () => poller.current?.retry(), stop: () => poller.current?.stop() };
}

/** Wall clock for the elapsed-time line, ticking only while polling (no timer left once READY / FAILED / offline). */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function StartupGate({ renderReady, probe = probeBackend }: Readonly<{
  renderReady: () => ReactNode;
  probe?: (signal: AbortSignal) => Promise<ProbeOutcome>;
}>) {
  const { state, retry, stop } = useStartupReadiness(probe);
  const [offlineOpened, setOfflineOpened] = useState(false);
  const now = useTicker(!offlineOpened && isPolling(state.phase));

  if (state.phase === 'READY' || offlineOpened) return <>{renderReady()}</>;

  const phase: ScreenPhase = state.phase;
  const view = VIEW[phase];
  const failed = phase === 'FAILED';
  const showActions = failed || phase === 'DELAYED';
  const elapsed = seconds((failed ? (state.lastCheckAt ?? now) : now) - state.startedAt);
  const reason = outcomeText(state.lastOutcome);
  const openOffline = () => { stop(); setOfflineOpened(true); };

  return (
    <main className="startup" data-testid="startup-screen" data-phase={phase} aria-busy={!failed}>
      <section className="startup-card" aria-labelledby="startup-title">
        <img className="startup-logo" src="/icon-192.svg" alt="" width={64} height={64} />
        <h1 id="startup-title" className="startup-title">Docteur</h1>
        <p className="startup-subtitle">Cortex personnel</p>

        {failed ? (
          <div className="startup-failure" role="alert" data-testid="startup-failure">
            <p className="startup-failure-title">{view.label}</p>
            {reason && <p className="startup-failure-reason">{reason}</p>}
            <p className="startup-failure-hint">{`La vérification automatique s’est arrêtée après ${elapsed} s. ${STARTUP_TEXT.failedHint}`}</p>
          </div>
        ) : (
          <LoadingSpinner className="startup-status" label={view.label} detail={view.detail} meta={`${elapsed} s`} size={18} />
        )}

        <ul className="startup-steps" aria-label="État du démarrage">
          <li data-state="done"><span className="startup-step-mark" aria-hidden="true">✓</span>Interface : chargée</li>
          <li data-state={failed ? 'failed' : 'pending'} data-testid="startup-step-server">
            <span className="startup-step-mark" aria-hidden="true">{failed ? '✕' : '…'}</span>Serveur local : {view.serverStep}
          </li>
        </ul>

        {showActions && (
          <div className="startup-actions">
            {failed && <button type="button" className="startup-btn startup-btn--primary" onClick={retry}>{STARTUP_TEXT.retry}</button>}
            <button type="button" className="startup-btn" onClick={openOffline}>{STARTUP_TEXT.offline}</button>
          </div>
        )}

        {showActions && (
          <details className="startup-details">
            <summary>Détails techniques</summary>
            <dl>
              <dt>Vérification</dt><dd>serveur local Docteur, port 3001 (/api/ping)</dd>
              <dt>Tentatives</dt><dd>{state.attempts}</dd>
              {reason && <><dt>Dernier résultat</dt><dd>{reason}</dd></>}
              <dt>Abandon automatique</dt><dd>{`après ${seconds(STARTUP_POLICY.failAfterMs)} s sans réponse`}</dd>
            </dl>
          </details>
        )}
      </section>
    </main>
  );
}
