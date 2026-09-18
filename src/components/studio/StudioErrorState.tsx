// Shared error display — every Studio previously funneled raw backend error
// codes/messages into a single generic <p role="alert">. This keeps the
// same accessible contract (role="alert", real message never hidden) but
// adds a consistent visual treatment and an optional retry affordance,
// without ever fabricating guidance the caller didn't provide.
import type { ReactNode } from 'react';

interface Props {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  children?: ReactNode;
}

export default function StudioErrorState({ message, onRetry, retryLabel = 'Réessayer', children }: Props) {
  return (
    <div className="studio-error" role="alert">
      <p className="studio-error-message">{message}</p>
      {(onRetry || children) && (
        <div className="studio-error-actions">
          {onRetry && <button type="button" className="studio-error-retry" onClick={onRetry}>{retryLabel}</button>}
          {children}
        </div>
      )}
    </div>
  );
}
