// [GAME-2] Docteur Arcade — sandboxed game host. One mount = one launch = one instance id; ArcadePanel remounts
// the host (new React key) for every launch, so nothing from an earlier instance can reach a newer one.
// Isolation: <iframe sandbox="allow-scripts"> (opaque origin, no Docteur storage/cookies/DOM) + the game page's own
// CSP (connect-src 'none'). The bridge is protocol v1 only (src/lib/arcade/protocol.ts); the host trusts a message
// only when event.source is this iframe's window and the envelope matches this game + instance exactly.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import StudioStatus, { type StudioStatusTone } from '../studio/StudioStatus';
import type { ArcadeGameEntry } from '../../lib/arcade/registry';
import {
  ARCADE_IFRAME_ALLOW, ARCADE_IFRAME_SANDBOX, arcadeFrameSrc, buildArcadeHostCommand, createArcadeInstanceId,
  parseArcadeGameEvent, type ArcadeHostCommand,
} from '../../lib/arcade/protocol';

/** The page must answer ARCADE_READY within this delay, otherwise the frame is removed. */
export const ARCADE_READY_TIMEOUT_MS = 10_000;

type HostPhase = 'loading' | 'active' | 'paused' | 'stopped' | 'error';
type HostError = 'NO_RESPONSE' | 'UNEXPECTED_NAVIGATION' | 'GAME_RUNTIME_ERROR';

const PHASE_STATUS: Record<HostPhase, { label: string; tone: StudioStatusTone }> = {
  loading: { label: 'Démarrage du bac à sable…', tone: 'neutral' },
  active: { label: 'Fondation active', tone: 'active' },
  paused: { label: 'En pause', tone: 'warning' },
  stopped: { label: 'Arrêté', tone: 'neutral' },
  error: { label: 'Fermé par sécurité', tone: 'error' },
};

const ERROR_TEXT: Record<HostError, string> = {
  NO_RESPONSE: 'La page du jeu n’a pas répondu à temps ; elle a été fermée.',
  UNEXPECTED_NAVIGATION: 'La page du jeu a tenté de changer d’adresse ; elle a été fermée par sécurité.',
  GAME_RUNTIME_ERROR: 'Le jeu a signalé une erreur ; il a été fermé.',
};

interface Props {
  game: ArcadeGameEntry;
  onStop: () => void;
}

export default function ArcadeGameHost({ game, onStop }: Props) {
  const [instanceId] = useState(createArcadeInstanceId);
  const [phase, setPhase] = useState<HostPhase>('loading');
  const [error, setError] = useState<HostError | null>(null);
  const [frameMounted, setFrameMounted] = useState(true);
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const loadsRef = useRef(0);
  const closedRef = useRef(false);
  const droppedRef = useRef(0);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const post = useCallback((command: ArcadeHostCommand) => {
    // The sandbox origin is opaque ("null"), so no targetOrigin can name it. The frame is torn down on any
    // re-navigation (see onLoad), and commands carry no secret beyond the per-launch instance id.
    frameRef.current?.contentWindow?.postMessage(command, '*');
  }, []);

  const closeWithError = useCallback((code: HostError) => {
    closedRef.current = true;
    setError(code);
    setPhase('error');
    setFrameMounted(false);
  }, []);

  useEffect(() => { headingRef.current?.focus(); }, []);

  useEffect(() => {
    if (!frameMounted) return;
    const readyTimer = window.setTimeout(() => { if (!readyRef.current) closeWithError('NO_RESPONSE'); }, ARCADE_READY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      if (closedRef.current) return;
      const frame = frameRef.current;
      const message = frame && event.source !== null && event.source === frame.contentWindow
        ? parseArcadeGameEvent(event.data, { gameId: game.id, instanceId })
        : null;
      if (!message) {
        droppedRef.current += 1;
        rootRef.current?.setAttribute('data-dropped-messages', String(droppedRef.current));
        return;
      }
      switch (message.type) {
        case 'ARCADE_READY':
          if (readyRef.current) return;
          readyRef.current = true;
          window.clearTimeout(readyTimer);
          post(buildArcadeHostCommand('ARCADE_INIT', game.id, instanceId, { reducedMotion: reducedMotionRef.current }));
          return;
        case 'ARCADE_STATE':
          if (readyRef.current) setPhase(message.payload.state);
          return;
        case 'ARCADE_ERROR':
          closeWithError('GAME_RUNTIME_ERROR');
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(readyTimer);
    };
  }, [game.id, instanceId, post, closeWithError, frameMounted]);

  const onFrameLoad = () => {
    loadsRef.current += 1;
    // the page was loaded once; a second load means it navigated itself somewhere else
    if (loadsRef.current > 1) closeWithError('UNEXPECTED_NAVIGATION');
  };

  const stop = () => {
    if (frameMounted) post(buildArcadeHostCommand('ARCADE_STOP', game.id, instanceId));
    closedRef.current = true;
    onStop();
  };

  const status = PHASE_STATUS[phase];
  return (
    <section ref={rootRef} className="arc-host" data-testid="arcade-host" data-phase={phase} aria-labelledby="arc-host-title">
      <div className="arc-host-head">
        <h3 id="arc-host-title" ref={headingRef} tabIndex={-1}>{game.title}</h3>
        <span data-testid="arcade-host-status"><StudioStatus label={status.label} tone={status.tone} compact /></span>
      </div>
      {frameMounted ? (
        <iframe
          ref={frameRef}
          data-testid="arcade-frame"
          className="arc-frame"
          title={`${game.title} — bac à sable Arcade`}
          src={arcadeFrameSrc(game.route, instanceId)}
          sandbox={ARCADE_IFRAME_SANDBOX}
          allow={ARCADE_IFRAME_ALLOW}
          referrerPolicy="no-referrer"
          onLoad={onFrameLoad}
        />
      ) : (
        <p className="arc-alert" role="alert" data-testid="arcade-host-error">{error ? ERROR_TEXT[error] : 'Jeu fermé.'}</p>
      )}
      <div className="arc-controls" role="group" aria-label={`Commandes ${game.title}`}>
        {/* one toggle (not two buttons that disable each other) so keyboard focus stays put across pause/resume */}
        <button
          type="button"
          className="arc-btn"
          data-testid="arcade-pause-toggle"
          disabled={phase !== 'active' && phase !== 'paused'}
          aria-pressed={phase === 'paused'}
          onClick={() => post(buildArcadeHostCommand(phase === 'paused' ? 'ARCADE_RESUME' : 'ARCADE_PAUSE', game.id, instanceId))}
        >
          {phase === 'paused' ? 'Reprendre' : 'Pause'}
        </button>
        <button type="button" className="arc-btn danger" data-testid="arcade-stop" onClick={stop}>Arrêter</button>
      </div>
      <p className="arc-muted">Fondation technique : aucune partie à jouer pour l’instant. Tab entre dans le cadre du jeu et en ressort.</p>
    </section>
  );
}
