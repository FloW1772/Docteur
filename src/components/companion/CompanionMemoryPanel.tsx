// Companion V1 — COMP-6A memory panel: one card per memory (category, short summary, privacy, provenance, freshness,
// conflict, enabled, review). Every control only asks for a proposal; nothing changes without review + confirmation.
import { useState } from 'react';
import {
  PRIVACY_SCOPES, categoryLabel, displayText, memoryStateLabel, originLabel, privacyChange, type LocalMutationActionId, type MemoryRowDto,
} from '../../lib/companion/ui-contracts';
import { CompanionPrivacyBadge, ToneBadge } from './CompanionCommon';
import './companion.css';

type Request = (actionId: LocalMutationActionId, parameters: Record<string, unknown>) => void;

function MemoryCard({ m, onExplain, onRequestAction }: { m: MemoryRowDto; onExplain: (id: string) => void; onRequestAction: Request }) {
  const [scope, setScope] = useState<string>(typeof m.privacyScope === 'string' ? m.privacyScope : 'NEVER_CLOUD');
  const st = memoryStateLabel(m.state);
  const titleId = `cmp-mem-${m.memoryId}`;
  const change = privacyChange(m.privacyScope, scope);
  return (
    <li>
      <article className="cmp-card" aria-labelledby={titleId} data-memory-id={m.memoryId}>
        <h3 id={titleId}>{categoryLabel(m.category)} <span className="cmp-muted">· {m.memoryId}</span></h3>
        <p className="cmp-summary" data-testid="cmp-summary">
          {m.summary ? displayText(m.summary, 160) : <em className="cmp-muted">{m.summaryWithheld ? 'Résumé masqué (forme de secret détectée).' : 'Aucun résumé.'}</em>}
        </p>
        <div className="cmp-row">
          <CompanionPrivacyBadge scope={m.privacyScope} />
          <ToneBadge tone={st.tone} label={`État : ${st.label}`}>{st.label}</ToneBadge>
          {m.conflict && <ToneBadge tone="warn" label="Conflit ouvert avec un autre souvenir">CONFLIT</ToneBadge>}
          {m.reviewRequired && <ToneBadge tone="warn" label="Révision nécessaire : ce souvenir est peut-être périmé">À REVOIR</ToneBadge>}
          <ToneBadge tone={m.companionEnabled ? 'ok' : 'muted'} label={m.companionEnabled ? 'Utilisé par le Companion' : 'Non utilisé par le Companion'}>{m.companionEnabled ? 'Utilisé' : 'Désactivé'}</ToneBadge>
        </div>
        <dl className="cmp-dl">
          <dt>Provenance</dt><dd>{m.provenance ? `${originLabel(m.provenance.origin)} · ${m.provenance.sourceType} · ${m.provenance.evidenceCount} référence(s)` : 'Inconnue'}</dd>
          <dt>Confirmé le</dt><dd>{displayText(m.freshness?.confirmedAt)}</dd>
          <dt>Dernière utilisation</dt><dd>{displayText(m.freshness?.lastPresentedAt)}</dd>
          <dt>À revoir après</dt><dd>{displayText(m.freshness?.reviewAfter)}</dd>
        </dl>
        <div className="cmp-row">
          <button type="button" className="cmp-btn" onClick={() => onExplain(m.memoryId)}>Pourquoi tu sais ça ?<span className="cmp-sr"> ({m.memoryId})</span></button>
          <button type="button" className="cmp-btn ghost" onClick={() => onRequestAction('COMPANION.MEMORY.SET_ENABLED', { memoryId: m.memoryId, enabled: !m.companionEnabled })}>
            {m.companionEnabled ? 'Ne plus utiliser' : 'Utiliser à nouveau'}<span className="cmp-sr"> ({m.memoryId})</span>
          </button>
          <label className="cmp-row">
            <span className="cmp-muted">Confidentialité</span>
            <select className="cmp-select" value={scope} onChange={e => setScope(e.target.value)} aria-label={`Nouvelle portée de confidentialité pour ${m.memoryId}`}>
              {PRIVACY_SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button type="button" className="cmp-btn ghost" disabled={change === 'NONE' || change === 'UNKNOWN'}
            onClick={() => onRequestAction('COMPANION.MEMORY.SET_PRIVACY', { memoryId: m.memoryId, scope })}
            aria-describedby={change === 'LOOSENS_CLOUD' ? `${titleId}-loosen` : undefined}>
            Proposer ce changement<span className="cmp-sr"> de confidentialité ({m.memoryId})</span>
          </button>
          {change === 'LOOSENS_CLOUD' && <span id={`${titleId}-loosen`} className="cmp-muted">Assouplit la protection cloud : confirmation renforcée.</span>}
          <button type="button" className="cmp-btn danger" onClick={() => onRequestAction('COMPANION.MEMORY.FORGET', { memoryId: m.memoryId })}>
            Oublier…<span className="cmp-sr"> ({m.memoryId})</span>
          </button>
        </div>
      </article>
    </li>
  );
}

export function CompanionMemoryPanel({ memories, error, onExplain, onRequestAction }: { memories: MemoryRowDto[] | null; error?: string | null; onExplain: (id: string) => void; onRequestAction: Request }) {
  return (
    <section className="cmp-card" aria-labelledby="cmp-memories-title" data-testid="cmp-memories">
      <h2 id="cmp-memories-title">Souvenirs du Companion</h2>
      {error && <p className="cmp-alert danger" role="alert">{error}</p>}
      {!memories && !error && <p className="cmp-muted" role="status">Chargement…</p>}
      {memories && memories.length === 0 && <p className="cmp-muted">Aucun souvenir.</p>}
      {memories && memories.length > 0 && (
        <ul className="cmp-list">{memories.map(m => <MemoryCard key={m.memoryId} m={m} onExplain={onExplain} onRequestAction={onRequestAction} />)}</ul>
      )}
    </section>
  );
}
