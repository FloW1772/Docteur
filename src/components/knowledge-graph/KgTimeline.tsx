// [Knowledge Graph V1] KG-6 — timeline of an entity's claims: dated periods on an axis
// (open-ended ones run to today), a per-year histogram when the history is dense,
// undated claims counted apart (never placed on a date), and an accessible list.
import { useMemo } from 'react';
import type { KgTimeline as Timeline } from '../../lib/cortex/client';
import { statusLabel, timelineBars } from '../../lib/kg/graph-model';

const WIDTH = 600;
const LANE = 14;
const LIST_LIMIT = 60;

export default function KgTimeline({ timeline, onOpenClaim }: { timeline: Timeline; onOpenClaim: (id: string) => void }) {
  const { bars, min, max, overflow } = useMemo(() => timelineBars(timeline.items, WIDTH, timeline.now), [timeline]);
  const lanes = Math.max(1, ...bars.map(b => b.lane + 1));
  const histMax = Math.max(1, ...(timeline.buckets ?? []).map(b => b.count));
  const objectText = (o: Timeline['items'][number]['object']) => (o.kind === 'entity' ? o.label : o.kind === 'value' ? String(o.value.value) : o.text);
  return (
    <section className="kg-timeline" aria-labelledby="kg-timeline-title" data-testid="kg-timeline">
      <h3 id="kg-timeline-title" className="kg-details-title">Chronologie</h3>
      <p className="kg-muted">
        {timeline.totalDated} affirmation{timeline.totalDated > 1 ? 's' : ''} datée{timeline.totalDated > 1 ? 's' : ''}
        {min && max ? ` · de ${min} à ${max}` : ''}
        {timeline.undatedCount > 0 ? ` · ${timeline.undatedCount} sans date (non placée${timeline.undatedCount > 1 ? 's' : ''} sur l’axe)` : ''}
      </p>
      {timeline.buckets && (
        <svg className="kg-timeline-hist" viewBox={`0 0 ${WIDTH} 40`} role="img" aria-label={`Répartition par année : ${timeline.buckets.length} années`}>
          {timeline.buckets.map((b, i) => {
            const w = WIDTH / timeline.buckets!.length;
            const h = Math.max(2, (b.count / histMax) * 36);
            return <rect key={b.year} x={i * w} y={40 - h} width={Math.max(1, w - 1)} height={h} className={b.disputed ? 'kg-hist-bar kg-hist-bar--disputed' : 'kg-hist-bar'}><title>{`${b.year} : ${b.count}`}</title></rect>;
          })}
        </svg>
      )}
      {bars.length > 0 && (
        <svg className="kg-timeline-axis" viewBox={`0 0 ${WIDTH} ${lanes * LANE + 18}`} role="img" aria-label="Périodes de validité">
          {bars.map(b => (
            <rect key={b.claimId} x={b.x} y={b.lane * LANE} width={b.width} height={LANE - 4} rx={2} className={`kg-tl-bar kg-tl-bar--${b.status.toLowerCase()}${b.open ? ' kg-tl-bar--open' : ''}`}>
              <title>{b.label}</title>
            </rect>
          ))}
          <text x={0} y={lanes * LANE + 14} className="kg-tl-tick">{min}</text>
          <text x={WIDTH} y={lanes * LANE + 14} textAnchor="end" className="kg-tl-tick">{max}</text>
        </svg>
      )}
      {(overflow > 0 || timeline.truncated) && <p className="kg-muted">Vue condensée : {overflow > 0 ? `${overflow} période(s) non dessinée(s) sur l’axe` : ''}{timeline.truncated ? ' · liste limitée aux premières affirmations' : ''}.</p>}
      <ol className="kg-timeline-list">
        {timeline.items.slice(0, LIST_LIMIT).map(c => (
          <li key={c.claimId}>
            <button type="button" className="kg-claim-row" onClick={() => onOpenClaim(c.claimId)}>
              <span><time>{c.validFrom ?? '…'}</time> → <time>{c.validTo ?? 'aujourd’hui'}</time> · {c.predicate} : {objectText(c.object)}</span>
              <span className="kg-claim-meta">{statusLabel(c.status)}{c.contradiction ? ' · ⚠ contradiction' : ''}</span>
            </button>
          </li>
        ))}
      </ol>
      {timeline.items.length > LIST_LIMIT && <p className="kg-muted">{timeline.items.length - LIST_LIMIT} autre(s) dans la période — affinez avec les filtres de date.</p>}
    </section>
  );
}
