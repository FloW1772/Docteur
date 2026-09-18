// Shared tab navigation for Studio sections. Visually distinct from action
// buttons (underline-style active indicator instead of opacity), unlike the
// previous per-Studio ad hoc button rows that looked identical to actions.
interface Props<T extends string> {
  tabs: readonly T[];
  active: T;
  onChange: (tab: T) => void;
  /** Optional per-tab badge (e.g. a count or a dot) keyed by tab value. */
  badges?: Partial<Record<T, number>>;
}

export default function StudioTabs<T extends string>({ tabs, active, onChange, badges }: Props<T>) {
  return (
    <nav className="studio-tabs" role="tablist">
      {tabs.map(tab => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={active === tab}
          className={`studio-tab${active === tab ? ' studio-tab--active' : ''}`}
          onClick={() => onChange(tab)}
        >
          {tab}
          {!!badges?.[tab] && <span className="studio-tab-badge">{badges[tab]}</span>}
        </button>
      ))}
    </nav>
  );
}
