// Shared modal shell for the 4 Studios (MetaGPT/Sherlock/Investment/Video),
// bringing them visually in line with the Cortex Command Center's hud2-*
// design language. Purely presentational — each Studio keeps its own state,
// data fetching, and business logic; this only standardizes the outer frame
// (backdrop, dialog role, Escape-to-close, header, close button).
import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  icon: ReactNode;
  title: string;
  onClose: () => void;
  /** Short, always-visible safety/scope reminder under the header (e.g. "PAPER only", "no real broker"). */
  subtitle?: ReactNode;
  children: ReactNode;
  width?: string;
}

export default function StudioShell({ icon, title, onClose, subtitle, children, width = 'min(1080px, calc(100vw - 24px))' }: Props) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        className="studio-shell glass"
        style={{ width }}
      >
        <header className="studio-shell-header">
          <span className="studio-shell-icon" aria-hidden="true">{icon}</span>
          <h2 className="studio-shell-title">{title}</h2>
          <button type="button" className="studio-shell-close" aria-label={`Fermer ${title}`} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {subtitle && <p className="studio-shell-subtitle">{subtitle}</p>}
        <div className="studio-shell-body">{children}</div>
      </section>
    </div>
  );
}
