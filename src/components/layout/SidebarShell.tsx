import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, Search, Upload } from 'lucide-react';

const STORAGE_KEY = 'docteur.sidebarCollapsed';

/** Presentation only: keep the existing sidebar mounted and its state intact. */
export default function SidebarShell({ children, mode, mobile, hidden = false, onSearch, onCapture }: {
  children: ReactNode;
  mode: 'focus' | 'dashboard';
  mobile: boolean;
  hidden?: boolean;
  onSearch: () => void;
  onCapture: () => void;
}) {
  const [preference, setPreference] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
  });
  const [focusExpanded, setFocusExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { setFocusExpanded(false); }, [mode]);
  const collapsed = !mobile && (mode === 'focus' ? !focusExpanded : preference);

  function changeCollapsed(value: boolean) {
    if (mode === 'focus') setFocusExpanded(!value);
    else {
      setPreference(value);
      try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* Optional storage. */ }
    }
  }

  const toggleLabel = collapsed ? 'Déployer la navigation' : 'Réduire la navigation';
  return (
    <div className={`shell-sidebar hud2-sidebar-shell${collapsed ? ' hud2-sidebar-shell--collapsed' : ''}${hidden ? ' mobile-hidden' : ''}`}
      data-sidebar-state={collapsed ? 'collapsed' : 'expanded'}
      data-tooltips-dismissed={dismissed || undefined}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        setDismissed(true);
        if (!mobile && !collapsed) { changeCollapsed(true); toggleRef.current?.focus(); }
      }}>
      <nav className="hud2-sidebar-controls" aria-label="Navigation compacte">
        {[
          { label: toggleLabel, icon: collapsed ? PanelLeftOpen : PanelLeftClose, action: () => changeCollapsed(!collapsed) },
          ...(collapsed ? [
            { label: 'Rechercher', icon: Search, action: onSearch },
            { label: 'Capturer', icon: Upload, action: onCapture },
          ] : []),
        ].map(({ label, icon: Icon, action }, index) => (
          <span className="hud2-sidebar-tool" key={index}>
            <button type="button" ref={index === 0 ? toggleRef : undefined}
              aria-label={label} aria-describedby={`${id}-tip-${index}`}
              aria-expanded={index === 0 ? !collapsed : undefined}
              aria-controls={index === 0 ? `${id}-content` : undefined}
              onFocus={() => setDismissed(false)} onMouseEnter={() => setDismissed(false)} onClick={action}>
              <Icon size={17} aria-hidden="true" />
            </button>
            <span role="tooltip" id={`${id}-tip-${index}`} className="hud2-sidebar-tooltip">{label}</span>
          </span>
        ))}
      </nav>
      <div id={`${id}-content`} className="hud2-sidebar-content" hidden={collapsed}>{children}</div>
    </div>
  );
}
