// [Global Loading V1] LOCAL LOADING — small spinner next to the component that
// waits. Announced politely to assistive tech; the rotation stops under
// prefers-reduced-motion (the text stays, so the state is never color/motion-only).
interface Props {
  label: string;
  /** Optional second line, e.g. the "slower than expected" notice. */
  detail?: string | null;
  /** Fast-changing info (elapsed time): visible, but excluded from live announcements. */
  meta?: string | null;
  size?: number;
  className?: string;
}

export default function LoadingSpinner({ label, detail = null, meta = null, size = 14, className = '' }: Props) {
  return (
    <span className={`dl-loading ${className}`.trim()} role="status" aria-live="polite">
      <span className="dl-spinner" style={{ width: size, height: size }} aria-hidden="true" />
      <span className="dl-loading-text">
        <span>
          {label}
          {meta && <span className="dl-loading-meta" aria-live="off"> — {meta}</span>}
        </span>
        {detail && <span className="dl-loading-detail">{detail}</span>}
      </span>
    </span>
  );
}
