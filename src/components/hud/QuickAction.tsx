// HUD generic quick-action button — opens an EXISTING component/flow, never
// duplicates its logic (mission requirement: "les actions doivent ouvrir
// les composants existants, ne pas dupliquer leur logique").
import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export default function QuickAction({ icon: Icon, label, onClick, disabled = false }: Props) {
  return (
    <button type="button" className="hud2-quick-action" onClick={onClick} disabled={disabled} title={label}>
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
