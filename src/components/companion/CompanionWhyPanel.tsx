// Companion V1 — COMP-6A "Pourquoi tu sais ça ?": provenance, ids, user confirmation, freshness, conflict, context used.
// Shows ids and metadata only — never a system prompt, a secret, a credential or an approval token.
import { useEffect, useRef } from 'react';
import { displayText, memoryStateLabel, originLabel, userConfirmed, type ContextExplainDto, type MemoryExplainDto } from '../../lib/companion/ui-contracts';
import { CompanionPrivacyBadge, ToneBadge } from './CompanionCommon';
import './companion.css';

function MemoryWhy({ e }: { e: MemoryExplainDto }) {
  const st = memoryStateLabel(e.state);
  const p = e.provenance;
  return (
    <div data-testid="cmp-why-memory" data-memory-id={e.memoryId}>
      <div className="cmp-row">
        <CompanionPrivacyBadge scope={e.privacyScope} />
        <ToneBadge tone={st.tone} label={`État : ${st.label}`}>{st.label}</ToneBadge>
        {e.conflict === 'OPEN_CONFLICT' && <ToneBadge tone="warn" label="Conflit ouvert">CONFLIT OUVERT</ToneBadge>}
      </div>
      <dl className="cmp-dl">
        <dt>Souvenir</dt><dd>{e.memoryId} (propriétaire : {displayText(e.durableOwner)})</dd>
        <dt>Origine</dt><dd>{p ? originLabel(p.origin) : 'Inconnue'}</dd>
        <dt>Source</dt><dd>{p ? displayText(p.sourceType) : '—'}</dd>
        <dt>Confirmé par vous</dt><dd>{p && userConfirmed(p.origin) ? 'Oui' : 'Non'}</dd>
        {p?.proposalId && (<><dt>Proposition d’origine</dt><dd>{p.proposalId}</dd></>)}
        <dt>Références</dt><dd>{p?.evidenceRefs?.length ? p.evidenceRefs.map(r => `${r.kind}:${displayText(r.ref, 80)}`).join(', ') : 'Aucune'}</dd>
        {p?.sourceReference && (<><dt>Référence source</dt><dd>{`${p.sourceReference.kind}:${displayText(p.sourceReference.ref, 80)}`}</dd></>)}
        <dt>Sensibilité</dt><dd>{displayText(e.sensitivity)}</dd>
        <dt>Confirmé le</dt><dd>{displayText(e.freshness?.confirmedAt)}</dd>
        <dt>Valide jusqu’au</dt><dd>{displayText(e.freshness?.validTo)}</dd>
        <dt>À revoir après</dt><dd>{displayText(e.freshness?.reviewAfter)}</dd>
      </dl>
    </div>
  );
}

export function CompanionWhyPanel({ explain, context, onClose }: { explain: MemoryExplainDto | null; context?: ContextExplainDto | null; onClose: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, [explain, context]);
  if (!explain && !context) return null;
  return (
    <section className="cmp-card" aria-labelledby="cmp-why-title" data-testid="cmp-why">
      <h2 id="cmp-why-title" tabIndex={-1} ref={headingRef}>Pourquoi tu sais ça ?</h2>
      {explain && <MemoryWhy e={explain} />}
      {context && (
        <div data-testid="cmp-why-context">
          <h3>Contexte utilisé — requête {context.requestId}</h3>
          {!context.found && <p className="cmp-muted">Aucun contexte enregistré pour cette requête.</p>}
          {context.found && (
            <>
              <p className="cmp-muted">Utilisé le {displayText(context.usedAt)} · état des souvenirs : maintenant · {context.truncationCount ?? 0} troncature(s)</p>
              <ul className="cmp-list">{context.contextUsed.map(c => <li key={c.itemId}><ToneBadge tone="muted">{c.kind}</ToneBadge> {displayText(c.itemId, 90)}</li>)}</ul>
              {context.memories.map(m => <MemoryWhy key={m.memoryId} e={m} />)}
            </>
          )}
        </div>
      )}
      <div className="cmp-row"><button type="button" className="cmp-btn ghost" onClick={onClose}>Fermer l’explication</button></div>
    </section>
  );
}
