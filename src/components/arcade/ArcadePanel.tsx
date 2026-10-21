// [GAME-2] Docteur Arcade — opt-in module: the fixed game list (src/lib/arcade/registry.ts) and, once launched,
// the sandboxed host. No gameplay yet (GAME-4); the panel says so instead of pretending.
// [GAME-3] Each savable game's card shows its local save status (never its contents) and offers an explicit,
// two-step reset of THAT game's save only.
import { useCallback, useEffect, useRef, useState } from 'react';
import ArcadeGameHost, { ARCADE_SAVE_ERROR_TEXT } from './ArcadeGameHost';
import { ARCADE_GAMES, getArcadeGame, type ArcadeGameEntry, type ArcadeGameId } from '../../lib/arcade/registry';
import { getArcadeSaveStore, type ArcadeSaveLoadResult } from '../../lib/arcade/saves';
import './arcade.css';

type SaveView = { kind: 'checking' } | { kind: 'loaded'; result: ArcadeSaveLoadResult };

function saveStatusText(view: SaveView): string {
  if (view.kind === 'checking') return 'Sauvegarde locale : vérification…';
  const { result } = view;
  if (!result.ok) return `Sauvegarde locale : ${ARCADE_SAVE_ERROR_TEXT[result.code]}`;
  if (result.status === 'EMPTY') return 'Sauvegarde locale : aucune';
  return `Sauvegarde locale disponible (mise à jour le ${new Date(result.save.updatedAt).toLocaleString('fr-FR')})`;
}

/** A save exists in some form (valid, unreadable or newer) and can be reset by the user. */
function canReset(view: SaveView): boolean {
  if (view.kind !== 'loaded') return false;
  const { result } = view;
  return result.ok ? result.status === 'FOUND' : result.code === 'CORRUPT_SAVE' || result.code === 'UNSUPPORTED_SAVE_VERSION';
}

function GameSaveControls({ game }: { game: ArcadeGameEntry }) {
  const [view, setView] = useState<SaveView>({ kind: 'checking' });
  const [confirming, setConfirming] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'status' | 'reset' | null>(null);

  const refresh = useCallback(async () => {
    const result = await getArcadeSaveStore().load(game.id);
    setView({ kind: 'loaded', result });
  }, [game.id]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);
  useEffect(() => {
    if (confirming || !focusAfter.current) return;
    (focusAfter.current === 'reset' ? resetRef.current : statusRef.current)?.focus();
    focusAfter.current = null;
  });

  const erase = async () => {
    const result = await getArcadeSaveStore().remove(game.id);
    setDeleteFailed(!result.ok);
    focusAfter.current = 'status';
    setConfirming(false);
    await refresh();
  };

  return (
    <div className="arc-save" data-testid={`arcade-save-${game.id}`} data-save-state={view.kind === 'checking' ? 'checking' : view.result.ok ? view.result.status : view.result.code}>
      <p className="arc-muted" ref={statusRef} tabIndex={-1} role="status" data-testid={`arcade-save-status-${game.id}`}>
        {saveStatusText(view)}{deleteFailed ? ' — l’effacement a échoué.' : ''}
      </p>
      {canReset(view) && !confirming && (
        <button type="button" ref={resetRef} className="arc-btn" data-testid={`arcade-save-reset-${game.id}`} onClick={() => setConfirming(true)}>
          Effacer la sauvegarde locale…
        </button>
      )}
      {confirming && (
        <div className="arc-confirm" role="group" aria-labelledby={`arc-confirm-${game.id}`} data-testid={`arcade-save-confirm-${game.id}`}>
          <p className="arc-muted" id={`arc-confirm-${game.id}`}>Effacer définitivement la sauvegarde locale de {game.title} sur cet appareil ? Les autres données de Docteur ne sont pas touchées.</p>
          <div className="arc-controls">
            <button type="button" className="arc-btn danger" data-testid={`arcade-save-confirm-delete-${game.id}`} onClick={() => { void erase(); }}>Effacer définitivement</button>
            <button type="button" ref={cancelRef} className="arc-btn" data-testid={`arcade-save-cancel-${game.id}`} onClick={() => { focusAfter.current = 'reset'; setConfirming(false); }}>Annuler</button>
          </div>
        </div>
      )}
    </div>
  );
}

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
              {game.save && <GameSaveControls game={game} />}
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
