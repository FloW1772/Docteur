// HUD generic status indicator — a colored dot + text label, never color
// alone (mission requirement: "ne pas faire reposer l'état uniquement sur
// la couleur" — e.g. SEARCHING must have text/icon, not just a blue dot).
// Reuses the same 7-value CortexVisualState vocabulary already established
// by useCortexState/ActivityPanel, plus an explicit "unavailable" state for
// modules that have no data yet (never fabricated).
import type { CortexVisualState } from '../../hooks/useCortexState';
import { CORTEX_STATE_COLOR } from '../../hooks/useCortexState';

export type WidgetStatus = CortexVisualState | 'unavailable';

const STATUS_LABEL: Record<WidgetStatus, string> = {
  idle: 'Repos',
  listening: 'Écoute',
  thinking: 'Réflexion',
  searching: 'Recherche',
  generating: 'Génération',
  done: 'Terminé',
  error: 'Erreur',
  unavailable: 'Non disponible',
};

const STATUS_COLOR: Record<WidgetStatus, string> = {
  ...CORTEX_STATE_COLOR,
  idle: '#9daebb',
  unavailable: '#9daebb',
};

interface Props {
  status: WidgetStatus;
  /** Overrides the default label text (still never color-only). */
  label?: string;
  compact?: boolean;
}

export default function StatusIndicator({ status, label, compact = false }: Props) {
  const color = STATUS_COLOR[status];
  const text = label ?? STATUS_LABEL[status];
  return (
    <span className={`hud2-status${compact ? ' hud2-status--compact' : ''}`} role="status">
      <span className="hud2-status-dot" style={{ background: color }} aria-hidden="true" />
      <span className="hud2-status-label" style={{ color }}>{text}</span>
    </span>
  );
}
