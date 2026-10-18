// [Knowledge Graph V1] KG-6 — details of an entity, a claim or a relation, with the
// evidence and provenance the server returned for the current visibility. Both sides
// of a contradiction are always shown together; ambiguity is always spelled out.
import type { KgClaimSummary, KgClaimView, KgEntityView, KgEvidenceView, KgRelationView } from '../../lib/cortex/client';
import { statusLabel, typeLabel } from '../../lib/kg/graph-model';

const objectText = (o: KgClaimSummary['object'] | KgClaimView['claim']['object']) =>
  o.kind === 'entity' ? (o.label ?? o.entityId) : o.kind === 'value' ? `${String(o.value.value)}${o.value.unit ? ` ${o.value.unit}` : ''}` : o.text;
const period = (from: string | null, to: string | null) => (from || to ? `${from ?? '…'} → ${to ?? 'aujourd’hui'}` : 'sans date de validité');

function Status({ status }: { status: string }) {
  return <span className={`kg-status kg-status--${status.toLowerCase()}`}>{statusLabel(status)}</span>;
}

function Locator({ e }: { e: KgEvidenceView }) {
  const l = e.locator;
  const parts = [l.kind === 'SOURCE' ? 'source entière' : l.kind.toLowerCase()];
  if (l.page) parts.push(`p. ${l.page}`);
  if (l.section) parts.push(`section ${l.section}`);
  if (l.chunkId) parts.push(`chunk ${l.chunkId}`);
  if (l.messageId) parts.push(`message ${l.messageId}`);
  if (l.charStart !== null && l.charStart !== undefined) parts.push(`car. ${l.charStart}–${l.charEnd ?? '…'}`);
  return <span className="kg-locator">{parts.join(' · ')}</span>;
}

function EvidenceList({ evidence, onOpenSource }: { evidence: KgEvidenceView[]; onOpenSource?: (evidenceId: string) => void }) {
  if (!evidence.length) return <p className="kg-muted">Aucune preuve visible avec les filtres de confidentialité actuels.</p>;
  return (
    <ul className="kg-evidence">
      {evidence.map(e => (
        <li key={e.evidenceId} className={`kg-evidence-item kg-evidence-item--${e.stance.toLowerCase()}`} data-evidence-id={e.evidenceId}>
          <div className="kg-evidence-head">
            <span className="kg-stance">{e.stance === 'SUPPORTS' ? 'Soutient' : 'Contredit'}</span>
            <strong>{e.source.name}</strong>
            <span className="kg-muted">{e.source.type.toLowerCase()}{e.source.privacy === 'PRIVATE' ? ' · privée (locale)' : ''}{e.status !== 'ACTIVE' ? ` · ${e.status.toLowerCase()}` : ''}</span>
          </div>
          <blockquote className="kg-excerpt">{e.preview}</blockquote>
          <div className="kg-evidence-meta">
            <Locator e={e} />
            {e.sourceRef && <span className="kg-muted">origine : {e.sourceRef.adapter} {e.sourceRef.sourceRef}{e.sourceRef.inputPath ? ` (${e.sourceRef.inputPath})` : ''}</span>}
            {onOpenSource && <button type="button" className="kg-link" onClick={() => onOpenSource(e.evidenceId)} aria-label={`Ouvrir la source : ${e.source.name}`}>Ouvrir la source</button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EntityDetails({ view, onOpenEntity, onOpenClaim }: { view: KgEntityView; onOpenEntity: (id: string) => void; onOpenClaim: (id: string) => void }) {
  const e = view.entity;
  return (
    <section className="kg-details" aria-labelledby="kg-details-title" data-testid="kg-entity-details">
      <h3 id="kg-details-title" className="kg-details-title">{e.label}</h3>
      <p className="kg-muted">{typeLabel(e.type)}{e.memberIds.length > 1 ? ` · ${e.memberIds.length} fiches fusionnées (réversible)` : ''}</p>
      {view.ambiguity && (
        <div className="kg-ambiguity" role="note">
          <strong>Entité ambiguë</strong> — elle n’a pas été rattachée de façon certaine. Candidats possibles :
          <ul>{view.ambiguity.candidates.map(c => <li key={c.entityId}><button type="button" className="kg-link" onClick={() => onOpenEntity(c.entityId)}>{c.label ?? c.entityId}</button> <span className="kg-muted">({c.method})</span></li>)}</ul>
        </div>
      )}
      {view.aliases.length > 0 && (
        <>
          <h4>Alias</h4>
          <ul className="kg-chips">{view.aliases.map(a => <li key={a.alias} title={a.sources.join(', ')}>{a.alias}</li>)}</ul>
        </>
      )}
      {view.identifiers.length > 0 && (
        <>
          <h4>Identifiants</h4>
          <ul className="kg-plain">{view.identifiers.map(i => <li key={`${i.scheme}:${i.value}`}><code>{i.scheme}</code> {i.value}{i.status !== 'ACTIVE' ? ` (${i.status.toLowerCase()})` : ''}</li>)}</ul>
        </>
      )}
      <h4>Affirmations ({view.claims.live.length})</h4>
      {view.claims.live.length === 0 ? <p className="kg-muted">Aucune affirmation visible.</p> : (
        <ul className="kg-claims">
          {view.claims.live.map(c => (
            <li key={c.claimId}>
              <button type="button" className="kg-claim-row" onClick={() => onOpenClaim(c.claimId)} data-claim-id={c.claimId}>
                <span>{c.subject.label} — <em>{c.predicate}</em> — {objectText(c.object)}</span>
                <span className="kg-claim-meta"><Status status={c.status} /> {period(c.validFrom, c.validTo)}{c.contradiction ? ' · ⚠ contradiction' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.claims.history.length > 0 && (
        <details className="kg-history">
          <summary>Historique remplacé ({view.claims.history.length})</summary>
          <ul className="kg-claims">{view.claims.history.map(c => <li key={c.claimId}><button type="button" className="kg-claim-row" onClick={() => onOpenClaim(c.claimId)}>{c.predicate} — {objectText(c.object)} <Status status={c.status} /></button></li>)}</ul>
        </details>
      )}
      {view.resolutions.length > 0 && (
        <details className="kg-history">
          <summary>Journal de résolution ({view.resolutions.length})</summary>
          <ul className="kg-plain">{view.resolutions.map(r => <li key={r.resolutionId}>{r.sourceLabel} → {r.targetLabel} : {r.decision.toLowerCase()} ({r.method}, {r.actor.toLowerCase()}){r.reversedAt ? ' · annulée' : ''}</li>)}</ul>
        </details>
      )}
      <h4>Provenance</h4>
      {view.provenance.length === 0 ? <p className="kg-muted">Aucune source visible.</p> : (
        <ul className="kg-plain">{view.provenance.map(p => <li key={p.sourceId}>{p.sourceName} <span className="kg-muted">({p.sourceType.toLowerCase()}{p.adapter ? ` · ${p.adapter}` : ''}{p.privacy === 'PRIVATE' ? ' · privée' : ''})</span></li>)}</ul>
      )}
    </section>
  );
}

export function ClaimDetails({ view, onOpenEntity, onOpenClaim, onOpenSource }: { view: KgClaimView; onOpenEntity: (id: string) => void; onOpenClaim: (id: string) => void; onOpenSource?: (evidenceId: string) => void }) {
  const c = view.claim;
  return (
    <section className="kg-details" aria-labelledby="kg-claim-title" data-testid="kg-claim-details">
      <h3 id="kg-claim-title" className="kg-details-title">
        <button type="button" className="kg-link" onClick={() => onOpenEntity(c.subject.entityId)}>{c.subject.label}</button> — <em>{c.predicate}</em> — {c.object.kind === 'entity' ? <button type="button" className="kg-link" onClick={() => onOpenEntity((c.object as { entityId: string }).entityId)}>{objectText(c.object)}</button> : objectText(c.object)}
      </h3>
      <dl className="kg-facts">
        <dt>Statut</dt><dd><Status status={c.status} /></dd>
        <dt>Validité</dt><dd>{period(c.validFrom, c.validTo)} ({c.temporalState.toLowerCase()})</dd>
        <dt>Observée le</dt><dd>{c.observedAt ?? 'inconnu'}</dd>
        <dt>Extraction</dt><dd>{c.extractionMethod ?? 'inconnue'}</dd>
        <dt>Confiance modèle</dt><dd>{c.modelConfidence ?? '—'}</dd>
        <dt>Confiance source</dt><dd>{c.sourceConfidence ?? '—'}</dd>
      </dl>
      {view.contradictions.length > 0 && (
        <div className="kg-conflict" role="note" data-testid="kg-contradiction">
          <strong>Contradiction ouverte</strong> — les deux versions sont conservées ; aucune n’est choisie.
          {view.contradictions.map(k => (
            <div key={k.conflictId} className="kg-conflict-side">
              <button type="button" className="kg-link" onClick={() => onOpenClaim(k.otherClaim.claimId)}>{k.otherClaim.subject.label} — {k.otherClaim.predicate} — {objectText(k.otherClaim.object)}</button>
              <span className="kg-muted"> · <Status status={k.otherClaim.status} /> · {period(k.otherClaim.validFrom, k.otherClaim.validTo)}</span>
              <ul className="kg-plain">{k.otherEvidence.map(e => <li key={e.evidenceId}>« {e.snippet} » — {e.sourceName}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
      <h4>Preuves ({view.supportingEvidence} pour, {view.contradictingEvidence} contre)</h4>
      <EvidenceList evidence={view.evidence} onOpenSource={onOpenSource} />
      {c.supersededBy && <p className="kg-muted">Remplacée par une affirmation plus récente — <button type="button" className="kg-link" onClick={() => onOpenClaim(c.supersededBy!)}>voir</button>.</p>}
    </section>
  );
}

export function RelationDetails({ view, onOpenEntity }: { view: KgRelationView; onOpenEntity: (id: string) => void }) {
  const r = view.relation;
  return (
    <section className="kg-details" aria-labelledby="kg-relation-title" data-testid="kg-relation-details">
      <h3 id="kg-relation-title" className="kg-details-title">
        <button type="button" className="kg-link" onClick={() => onOpenEntity(r.source.entityId)}>{r.source.label}</button> — <em>{r.type}</em> — <button type="button" className="kg-link" onClick={() => onOpenEntity(r.target.entityId)}>{r.target.label}</button>
      </h3>
      <p className="kg-muted">Relation descriptive : elle n’accorde aucune permission.</p>
      <dl className="kg-facts">
        <dt>Confiance</dt><dd>{r.confidence}</dd>
        <dt>Vérifiée</dt><dd>{r.verified ? 'oui' : 'non'}</dd>
        <dt>Créée le</dt><dd>{r.createdAt}</dd>
      </dl>
      <h4>Provenance</h4>
      {view.provenance ? (
        <p>{view.provenance.sourceName} <span className="kg-muted">({view.provenance.sourceType.toLowerCase()}{view.provenance.privacy === 'PRIVATE' ? ' · privée' : ''}) {view.provenance.refs.map(x => `${x.adapter} ${x.ref}`).join(', ')}</span></p>
      ) : <p className="kg-muted">Sans source.</p>}
    </section>
  );
}
