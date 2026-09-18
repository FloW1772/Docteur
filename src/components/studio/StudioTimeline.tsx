// Shared chronological event list — used by Investment (timeline events)
// and MetaGPT (mission transition history). Deliberately separates the
// factual EVENT from any attached interpretation/commentary, per the
// mission rule that speculative market interpretation must never be
// visually confused with the event itself.
import type { ReactNode } from 'react';

export interface StudioTimelineEntry {
  id: string;
  /** Short uppercase kind label, e.g. "EARNINGS" or a state name. */
  kind: string;
  /** Formatted date/time string, or null if unreliable/unknown. */
  when: string | null;
  title: ReactNode;
  /** Optional speculative/derived note, rendered visually distinct from the event itself. */
  interpretation?: ReactNode;
  source?: ReactNode;
}

interface Props {
  entries: StudioTimelineEntry[];
  unreliableLabel?: string;
}

export default function StudioTimeline({ entries, unreliableLabel = 'date non fiable' }: Props) {
  return (
    <ul className="studio-timeline">
      {entries.map(entry => (
        <li key={entry.id} className="studio-timeline-item">
          <span className="studio-timeline-kind">[{entry.kind.toUpperCase()}]</span>{' '}
          {entry.when ? <strong className="studio-timeline-when">{entry.when}</strong> : <em className="studio-timeline-unreliable">{unreliableLabel}</em>}
          {' — '}{entry.title}
          {entry.source && <span className="studio-timeline-source"> ({entry.source})</span>}
          {entry.interpretation && <p className="studio-timeline-interpretation">{entry.interpretation}</p>}
        </li>
      ))}
    </ul>
  );
}
