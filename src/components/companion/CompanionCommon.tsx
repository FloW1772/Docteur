// Companion V1 — COMP-6A shared UI pieces (isolated; not wired into App.tsx).
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { errorText, privacyBadge, type Tone } from '../../lib/companion/ui-contracts';
import './companion.css';

export function CompanionPrivacyBadge({ scope }: { scope: unknown }) {
  const b = privacyBadge(scope);
  return (
    <span className={`cmp-badge ${b.tone}`} data-scope={b.scope} title={b.description} aria-label={`Confidentialité : ${b.label}. ${b.description}`}>
      {b.scope === 'NEVER_CLOUD' && <Lock size={12} aria-hidden="true" />}
      {b.label}
    </span>
  );
}

export function ToneBadge({ tone, children, label }: { tone: Tone; children: ReactNode; label?: string }) {
  return <span className={`cmp-badge ${tone}`} aria-label={label}>{children}</span>;
}

/** A refusal / failure, by code. Unknown codes are shown as unknown refusals (never as success). */
export function CompanionErrorAlert({ code, id }: { code: string | null; id?: string }) {
  if (!code) return null;
  const e = errorText(code);
  return (
    <div className="cmp-alert danger" role="alert" id={id} data-error-code={e.code}>
      <strong>{e.code}</strong> — {e.text}
    </div>
  );
}
