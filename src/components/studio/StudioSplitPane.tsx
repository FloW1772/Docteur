// Shared two-column layout — main content + secondary rail (history,
// properties, sources, activity), matching mission requirement 4 (HEADER /
// NAVIGATION / ZONE PRINCIPALE / ZONE SECONDAIRE). Collapses to a single
// column below the tablet breakpoint (see .studio-split-pane CSS) rather
// than shrinking a desktop split view down to illegible slivers.
import type { ReactNode } from 'react';

interface Props {
  main: ReactNode;
  secondary: ReactNode;
  secondaryLabel?: string;
}

export default function StudioSplitPane({ main, secondary, secondaryLabel = 'Informations' }: Props) {
  return (
    <div className="studio-split-pane">
      <div className="studio-split-main">{main}</div>
      <aside className="studio-split-secondary" aria-label={secondaryLabel}>{secondary}</aside>
    </div>
  );
}
