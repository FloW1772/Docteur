// Customizable Dashboard V1 — the edit panel. Only the Dashboard's cards are arranged here; hiding a card never
// disables the feature (its TopBar / menu / console / voice entry points stay). Native HTML5 drag & drop (no new
// dependency) for the mouse, ▲/▼ buttons for touch, arrow keys on the handle for the keyboard. Nothing is written
// while dragging: the parent persists only when a drop / move / hide / show actually changes the layout.
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react';
import HudPanel from './HudPanel';
import {
  DASHBOARD_CARDS, moveCard, moveCardBy, hideCard, showCard, visibleCards, type DashboardLayout,
} from '../../lib/dashboard/dashboard-layout';

const LABEL = new Map(DASHBOARD_CARDS.map(c => [c.id, c]));

interface Props {
  layout: DashboardLayout;
  onChange: (next: DashboardLayout) => void;
  onRestoreDefaults: () => void;
  onDone: () => void;
}

export default function DashboardCustomizer({ layout, onChange, onRestoreDefaults, onDone }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const focusAfterMove = useRef<string | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const visible = visibleCards(layout);
  const hidden = layout.order.filter(id => layout.hidden.has(id));

  // keep the keyboard focus on the card that was just moved
  useEffect(() => {
    if (!focusAfterMove.current) return;
    handles.current.get(focusAfterMove.current)?.focus();
    focusAfterMove.current = null;
  }, [layout]);

  const move = (id: string, delta: -1 | 1) => { focusAfterMove.current = id; onChange(moveCardBy(layout, id, delta)); };
  const onHandleKey = (id: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); move(id, -1); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); move(id, 1); }
  };
  const dragProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => { setDragging(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); },
    onDragOver: (e: DragEvent) => { if (!dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== id) setOver(id); },
    onDrop: (e: DragEvent) => { e.preventDefault(); if (dragging && dragging !== id) onChange(moveCard(layout, dragging, id)); setDragging(null); setOver(null); },
    onDragEnd: () => { setDragging(null); setOver(null); },
  });

  return (
    <div className="hud2-customizer" role="dialog" aria-modal="false" aria-label="Personnaliser le Dashboard" data-testid="dashboard-customizer">
      <HudPanel title="Dashboard — Personnalisation">
        <p className="hud2-module-widget-detail" style={{ marginBottom: 8 }}>
          Glissez les cartes pour changer leur ordre (les 4 premières entourent le Cortex). Masquer une carte ne désactive rien :
          la fonctionnalité reste accessible depuis la barre du haut, le menu, la console et les commandes.
        </p>

        <ol className="hud2-customizer-list" data-testid="dashboard-visible-list" aria-label="Cartes affichées">
          {visible.length === 0 && <li className="hud2-module-widget-detail" data-testid="dashboard-all-hidden-note">Aucune carte affichée — réaffichez-en depuis la liste ci-dessous.</li>}
          {visible.map((id, index) => {
            const card = LABEL.get(id);
            return (
              <li
                key={id}
                data-testid="dashboard-card-item"
                data-card-id={id}
                className={`hud2-customizer-item${dragging === id ? ' is-dragging' : ''}${over === id && dragging !== id ? ' is-over' : ''}`}
                {...dragProps(id)}
              >
                <button
                  type="button"
                  className="hud2-customizer-handle"
                  ref={el => { if (el) handles.current.set(id, el); else handles.current.delete(id); }}
                  aria-label={`Déplacer ${card?.label ?? id} (position ${index + 1} sur ${visible.length}) — flèches haut/bas`}
                  aria-roledescription="poignée de déplacement"
                  data-testid="dashboard-card-handle"
                  onKeyDown={onHandleKey(id)}
                >
                  <GripVertical size={14} />
                </button>
                <span className="hud2-customizer-name">
                  <strong>{card?.label ?? id}</strong>
                  <span className="hud2-customizer-slot">{index < 4 ? `coin ${index + 1}` : 'colonne'}</span>
                </span>
                <span className="hud2-customizer-actions">
                  <button type="button" aria-label={`Monter ${card?.label ?? id}`} data-testid="dashboard-card-up" disabled={index === 0} onClick={() => move(id, -1)}><ArrowUp size={12} /></button>
                  <button type="button" aria-label={`Descendre ${card?.label ?? id}`} data-testid="dashboard-card-down" disabled={index === visible.length - 1} onClick={() => move(id, 1)}><ArrowDown size={12} /></button>
                  <button type="button" aria-label={`Masquer ${card?.label ?? id} du Dashboard`} data-testid="dashboard-card-hide" onClick={() => onChange(hideCard(layout, id))}><EyeOff size={12} /> Masquer</button>
                </span>
              </li>
            );
          })}
        </ol>

        <h4 className="hud2-panel-title" style={{ marginTop: 12 }}>Fonctionnalités masquées ({hidden.length})</h4>
        <ul className="hud2-customizer-list" data-testid="dashboard-hidden-list" aria-label="Fonctionnalités masquées">
          {hidden.length === 0 && <li className="hud2-module-widget-detail">Aucune.</li>}
          {hidden.map(id => {
            const card = LABEL.get(id);
            return (
              <li key={id} className="hud2-customizer-item hud2-customizer-item--hidden" data-testid="dashboard-hidden-item" data-card-id={id}>
                <span className="hud2-customizer-name">
                  <strong>{card?.label ?? id}</strong>
                  <span className="hud2-customizer-slot">{card?.description}{card && !card.defaultVisible ? ' · optionnelle' : ''}</span>
                </span>
                <span className="hud2-customizer-actions">
                  <button type="button" aria-label={`Réafficher ${card?.label ?? id} dans le Dashboard`} data-testid="dashboard-card-show" onClick={() => onChange(showCard(layout, id))}><Eye size={12} /> Réafficher</button>
                </span>
              </li>
            );
          })}
        </ul>

        <div className="hud2-customizer-footer">
          {confirmReset ? (
            <span className="hud2-customizer-confirm" role="alertdialog" aria-label="Confirmer la restauration">
              <span>Restaurer l’ordre et les cartes par défaut ?</span>
              <button type="button" data-testid="dashboard-reset-confirm" onClick={() => { setConfirmReset(false); onRestoreDefaults(); }}>Oui, restaurer</button>
              <button type="button" data-testid="dashboard-reset-cancel" onClick={() => setConfirmReset(false)}>Annuler</button>
            </span>
          ) : (
            <button type="button" data-testid="dashboard-reset" onClick={() => setConfirmReset(true)}><RotateCcw size={12} /> Restaurer la disposition par défaut</button>
          )}
          <button type="button" className="hud2-customizer-done" data-testid="dashboard-customize-done" onClick={onDone}>Terminer</button>
        </div>
      </HudPanel>
    </div>
  );
}
