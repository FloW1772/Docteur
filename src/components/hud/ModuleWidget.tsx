// HUD generic module widget — the shared shape for MetaGPT/Sherlock/
// Investment/OpenMontage/Connectors mini-widgets. Deliberately minimal
// (name, status, one optional metric, one optional action) per mission
// requirement 10 ("ne pas surcharger ces widgets"). Never fabricates data:
// callers must pass status="unavailable" (not a fake "idle") when no real
// state exists yet.
import type { ReactNode } from 'react';
import HudPanel from './HudPanel';
import StatusIndicator, { type WidgetStatus } from './StatusIndicator';

interface Props {
  name: string;
  status: WidgetStatus;
  /** A single short, real metric (e.g. "3 sites", "12 positions") — never a fabricated number. */
  metric?: string;
  /** Optional extra line for a bit more context (e.g. mission title, last search term). */
  detail?: string;
  onOpen?: () => void;
  openLabel?: string;
  children?: ReactNode;
  loading?: boolean;
  error?: string;
}

const ACTIVE_STATUSES = new Set<WidgetStatus>(['listening', 'thinking', 'searching', 'generating']);

export default function ModuleWidget({ name, status, metric, detail, onOpen, openLabel = 'Ouvrir', children, loading = false, error }: Props) {
  const active = ACTIVE_STATUSES.has(status);
  return (
    <HudPanel
      compact
      className={`hud2-module-widget${active ? ' hud2-module-widget--active' : ''}`}
      ariaLabel={`Module ${name}`}
    >
      <div className="hud2-module-widget-header">
        <strong className="hud2-module-widget-name">{name}</strong>
        <StatusIndicator status={status} compact />
      </div>

      {loading && <p className="hud2-module-widget-loading" role="status">Chargement…</p>}

      {!loading && error && (
        <p className="hud2-module-widget-error" role="alert">{error}</p>
      )}

      {!loading && !error && (
        <>
          {metric && <p className="hud2-module-widget-metric">{metric}</p>}
          {detail && <p className="hud2-module-widget-detail">{detail}</p>}
          {!metric && !detail && status === 'unavailable' && (
            <p className="hud2-module-widget-detail">Aucune donnée pour l'instant.</p>
          )}
        </>
      )}

      {children}

      {onOpen && (
        <button type="button" className="hud2-module-widget-open" onClick={onOpen}>{openLabel}</button>
      )}
    </HudPanel>
  );
}
