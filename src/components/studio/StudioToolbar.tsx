// Shared action row — groups a Studio's primary/secondary/destructive
// actions with consistent spacing and visual weight, instead of every
// Studio rendering an identical flat row of same-styled buttons regardless
// of importance (mission requirement 4: "les actions destructives/sensibles
// doivent être clairement séparées").
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered right-aligned, visually separated (e.g. Cancel). */
  destructive?: ReactNode;
}

export default function StudioToolbar({ children, destructive }: Props) {
  return (
    <div className="studio-toolbar">
      <div className="studio-toolbar-primary">{children}</div>
      {destructive && <div className="studio-toolbar-destructive">{destructive}</div>}
    </div>
  );
}
