// Cortex Command Center — activity panel. Purely presentational: it never
// fetches or polls anything itself, it only renders activity entries that
// App.tsx already derives from real state (TopBar's cortex badge inputs,
// MetaGPT mission state, video job state, agent job state). This keeps a
// single source of truth per feature and avoids a second competing
// polling/SSE mechanism (see project inventory: video-job-polling vs SSE
// already coexist — this panel must not add a third).
import type { CortexVisualState } from '../../hooks/useCortexState';
import { CORTEX_STATE_LABEL } from '../../hooks/useCortexState';

export interface ActivityEntry {
  id: string;
  label: string;
  detail?: string;
  /** Drives the same color vocabulary as CortexVisualState for consistency. */
  state: CortexVisualState;
}

interface Props {
  cortexState: CortexVisualState;
  entries: ActivityEntry[];
  open: boolean;
  onClose: () => void;
}

const DOT_COLOR: Record<CortexVisualState, string> = {
  idle: '#3d3060',
  listening: '#3dffaa',
  thinking: '#5ee7ff',
  searching: '#5ee7ff',
  generating: '#ffb547',
  done: '#3dffaa',
  error: '#ff4d58',
};

export default function ActivityPanel({ cortexState, entries, open, onClose }: Props) {
  if (!open) return null;

  return (
    <aside
      className="activity-panel glass"
      role="dialog"
      aria-label="Panneau d'activité"
      aria-modal="false"
    >
      <header className="activity-panel-header">
        <span className="activity-panel-title">ACTIVITÉ</span>
        <span
          className="activity-panel-cortex-state"
          style={{ color: DOT_COLOR[cortexState] }}
        >
          {CORTEX_STATE_LABEL[cortexState] || 'Repos'}
        </span>
        <button
          type="button"
          className="activity-panel-close"
          onClick={onClose}
          aria-label="Fermer le panneau d'activité"
        >
          ×
        </button>
      </header>

      {entries.length === 0 ? (
        <p className="activity-panel-empty" role="status">
          Aucune activité en cours.
        </p>
      ) : (
        <ul className="activity-panel-list">
          {entries.map(entry => (
            <li key={entry.id} className="activity-panel-item">
              <span
                className="activity-panel-dot"
                style={{ background: DOT_COLOR[entry.state] }}
                aria-hidden="true"
              />
              <span className="activity-panel-item-label">{entry.label}</span>
              {entry.detail && (
                <span className="activity-panel-item-detail">{entry.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
