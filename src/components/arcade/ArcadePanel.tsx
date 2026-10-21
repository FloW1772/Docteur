// [GAME-2] Docteur Arcade — opt-in module: the fixed game list (src/lib/arcade/registry.ts) and, once launched,
// the sandboxed host. No gameplay and no saves yet (GAME-4 / GAME-3); the panel says so instead of pretending.
import { useEffect, useRef, useState } from 'react';
import ArcadeGameHost from './ArcadeGameHost';
import { ARCADE_GAMES, getArcadeGame, type ArcadeGameId } from '../../lib/arcade/registry';
import './arcade.css';

export default function ArcadePanel() {
  // `launch` changes on every launch so the host remounts with a fresh instance id
  const [running, setRunning] = useState<{ gameId: ArcadeGameId; launch: number } | null>(null);
  const launchCount = useRef(0);
  const launchButtons = useRef(new Map<ArcadeGameId, HTMLButtonElement>());
  const restoreFocusTo = useRef<ArcadeGameId | null>(null);
  const runningGame = running ? getArcadeGame(running.gameId) : null;

  useEffect(() => {
    if (running || !restoreFocusTo.current) return;
    launchButtons.current.get(restoreFocusTo.current)?.focus();
    restoreFocusTo.current = null;
  }, [running]);

  const launch = (gameId: ArcadeGameId) => {
    launchCount.current += 1;
    setRunning({ gameId, launch: launchCount.current });
  };

  const stop = () => {
    restoreFocusTo.current = running?.gameId ?? null;
    setRunning(null);
  };

  return (
    <div className="arc-root" data-testid="arcade-panel">
      <p className="arc-intro">
        Arcade locale et optionnelle. Chaque jeu tourne dans un bac à sable isolé : aucun accès à vos notes, à la mémoire,
        au Companion ni aux appareils, aucun réseau pendant le jeu. Ni publicité, ni pistage, ni achat, ni compte.
      </p>
      {runningGame && running ? (
        <ArcadeGameHost key={running.launch} game={runningGame} onStop={stop} />
      ) : (
        <ul className="arc-list" data-testid="arcade-game-list" aria-label="Jeux de l’Arcade">
          {ARCADE_GAMES.map(game => (
            <li key={game.id} className="arc-card" data-testid={`arcade-game-${game.id}`} data-status={game.status}>
              <div className="arc-card-head">
                <h3>{game.title}</h3>
                <span className="arc-badge">Fondation technique</span>
                <span className="arc-badge muted">Jeu à venir ({game.nextMilestone})</span>
              </div>
              <p className="arc-muted">{game.description}</p>
              <button
                type="button"
                className="arc-btn primary"
                data-testid={`arcade-launch-${game.id}`}
                ref={el => { if (el) launchButtons.current.set(game.id, el); else launchButtons.current.delete(game.id); }}
                onClick={() => launch(game.id)}
              >
                Lancer la fondation {game.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
