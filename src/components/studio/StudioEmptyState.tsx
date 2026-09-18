// Shared empty state — replaces each Studio's own bare "role=status" text
// paragraph with a consistent, slightly more inviting placeholder. Text
// content stays entirely caller-supplied (mission requirement: no invented
// copy/data) — this only standardizes the visual treatment.
import type { ReactNode } from 'react';

interface Props {
  message: string;
  action?: ReactNode;
}

export default function StudioEmptyState({ message, action }: Props) {
  return (
    <div className="studio-empty" role="status">
      <p className="studio-empty-message">{message}</p>
      {action}
    </div>
  );
}
