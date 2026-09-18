// Shared provenance badge — every Studio that shows externally-sourced data
// (Investment research sources, Sherlock result metadata, MetaGPT approval
// hashes) needs a consistent "where did this come from / how fresh is it"
// indicator, so provenance never looks like live/authoritative data by
// accident (mission-wide rule: never imply live data when it is historical
// or user-supplied).
interface Props {
  label: string;
  url?: string;
  timestamp?: string;
  recency?: string;
}

export default function StudioSourceBadge({ label, url, timestamp, recency }: Props) {
  const content = url ? (
    <a href={url} target="_blank" rel="noreferrer" className="studio-source-link">{label}</a>
  ) : (
    <span className="studio-source-link studio-source-link--plain">{label}</span>
  );
  return (
    <span className="studio-source-badge">
      {content}
      {(recency || timestamp) && (
        <span className="studio-source-meta">
          {recency && <span className="studio-source-recency">{recency}</span>}
          {recency && timestamp && ' · '}
          {timestamp && <span>récupéré le {timestamp}</span>}
        </span>
      )}
    </span>
  );
}
