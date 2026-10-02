import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  MODE_LABEL, TAB_LABEL, discoveryStatusText, formatDuration, isActive,
  type DiscoveryView,
} from '../../lib/youtube/discovery-view';

// Persistent YouTube discovery status. It lives OUTSIDE the capture modal (which closes on submit), so the progress and
// the Cancel button stay visible until DONE / ERROR / CANCELLED / TIMEOUT.
export default function YouTubeDiscoveryPanel({
  view, onCancel, onClose,
}: {
  view: DiscoveryView;
  onCancel: () => void;
  onClose: () => void;
}) {
  const active = isActive(view);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const elapsed = (view.endedAt ?? now) - view.startedAt;
  const failed = view.status === 'error' || view.status === 'timeout';
  const accent = failed ? '#ff4d58' : view.status === 'done' ? '#3dffaa' : view.status === 'cancelled' ? '#9f8fbf' : '#a78bfa';
  const showTotal = view.phases.length > 1; // root channel: per-type counts + unique total; explicit tab: plain count
  const currentPages = view.phases.find(p => p.tab === view.currentTab)?.pages ?? 0;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="yt-discovery-panel"
      data-status={view.status}
      data-mode={view.mode ?? ''}
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 9000, width: 'min(360px, calc(100vw - 32px))',
        padding: 14, borderRadius: 12, background: 'rgba(12, 9, 22, 0.96)', backdropFilter: 'blur(14px)',
        border: `1px solid ${accent}55`, boxShadow: '0 20px 60px rgba(0,0,0,0.55)', color: '#e6dcff',
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        {active
          ? <Loader2 size={15} className="animate-spin" style={{ color: accent, flexShrink: 0 }} />
          : <span style={{ width: 8, height: 8, borderRadius: 99, background: accent, flexShrink: 0 }} />}
        <span className="font-grotesk font-semibold text-sm" style={{ flex: 1 }}>Découverte YouTube</span>
        {!active && (
          <button type="button" aria-label="Fermer la découverte YouTube" onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#9f8fbf', cursor: 'pointer', padding: 2 }}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="font-mono text-xs" style={{ color: '#9f8fbf', lineHeight: 1.6 }}>
        <div data-testid="yt-discovery-channel">Chaîne YouTube détectée : <span style={{ color: '#c4b5fd' }}>{view.channelLabel}</span></div>
        {view.mode && <div data-testid="yt-discovery-mode">Mode : <span style={{ color: '#c4b5fd' }}>{MODE_LABEL[view.mode]}</span></div>}
      </div>

      <div className="font-mono text-sm mt-2" data-testid="yt-discovery-status" style={{ color: accent, lineHeight: 1.5, wordBreak: 'break-word' }}>
        {discoveryStatusText(view)}
      </div>

      {view.phases.length > 0 && (
        <ul className="font-mono text-xs mt-2" data-testid="yt-discovery-phases" style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: 1.7 }}>
          {view.phases.map(phase => (
            <li key={phase.tab} data-tab={phase.tab} data-phase-status={phase.status}
              style={{ color: phase.status === 'running' ? '#e6dcff' : '#9f8fbf' }}>
              {TAB_LABEL[phase.tab]} :{' '}
              {phase.status === 'pending' ? 'en attente'
                : phase.status === 'unavailable' ? 'indisponible'
                : `${phase.count} trouvé${phase.count > 1 ? 's' : ''}`}
              {phase.status === 'running' && phase.pages > 0 ? ` · page ${phase.pages}` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="font-mono text-xs mt-2" style={{ color: '#9f8fbf', lineHeight: 1.6 }}>
        {showTotal
          ? <div data-testid="yt-discovery-total">Total unique : {view.total}</div>
          : <div data-testid="yt-discovery-total">{view.total} élément{view.total > 1 ? 's' : ''} trouvé{view.total > 1 ? 's' : ''}</div>}
        <div data-testid="yt-discovery-elapsed">Durée : {formatDuration(elapsed)}{active && currentPages > 0 ? ` · page ${currentPages}` : ''}</div>
      </div>

      {active && (
        <button
          type="button"
          aria-label="Annuler la découverte YouTube"
          data-testid="yt-discovery-cancel"
          onClick={onCancel}
          className="font-mono text-xs mt-3"
          style={{ width: '100%', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,77,88,0.1)', border: '1px solid rgba(255,77,88,0.3)', color: '#ff4d58', cursor: 'pointer' }}
        >
          Annuler
        </button>
      )}
    </div>
  );
}
