// Shared tab navigation for Studio sections. Visually distinct from action
// buttons (underline-style active indicator instead of opacity), unlike the
// previous per-Studio ad hoc button rows that looked identical to actions.
import { useId, type ReactNode } from 'react';

interface Props<T extends string> {
  tabs: readonly T[];
  active: T;
  onChange: (tab: T) => void;
  /** Optional per-tab badge (e.g. a count or a dot) keyed by tab value. */
  badges?: Partial<Record<T, number>>;
  children?: ReactNode;
}

export default function StudioTabs<T extends string>({ tabs, active, onChange, badges, children }: Props<T>) {
  const id = useId();
  return (
    <>
    <nav className="studio-tabs" role="tablist" aria-label="Sections du Studio">
      {tabs.map(tab => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`${id}-${tab}`}
          tabIndex={active === tab ? 0 : -1}
          aria-controls={children ? `${id}-panel` : undefined}
          aria-selected={active === tab}
          className={`studio-tab${active === tab ? ' studio-tab--active' : ''}`}
          onClick={() => onChange(tab)}
          onKeyDown={e => {
            const index = tabs.indexOf(tab);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
              : e.key === 'ArrowRight' ? (index + 1) % tabs.length
                : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1;
            if (next < 0) return;
            e.preventDefault();
            onChange(tabs[next]);
            document.getElementById(`${id}-${tabs[next]}`)?.focus();
          }}
        >
          {tab}
          {!!badges?.[tab] && <span className="studio-tab-badge">{badges[tab]}</span>}
        </button>
      ))}
    </nav>
    {children && <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${active}`} tabIndex={0}>{children}</div>}
    </>
  );
}
