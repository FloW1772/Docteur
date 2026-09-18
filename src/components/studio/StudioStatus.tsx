// Shared status chip — reuses the same color vocabulary as the Command
// Center's StatusIndicator (hud2-status), but generic over any label set
// since each Studio's state machine has its own vocabulary (MetaGPT mission
// states, Sherlock job states, video job states...). Never color-only: the
// text label is always rendered alongside the dot.
export type StudioStatusTone = 'neutral' | 'active' | 'success' | 'warning' | 'error';

const TONE_COLOR: Record<StudioStatusTone, string> = {
  neutral: '#7a6c9a',
  active: '#5ee7ff',
  success: '#3dffaa',
  warning: '#ffb547',
  error: '#ff4d58',
};

interface Props {
  label: string;
  tone: StudioStatusTone;
  compact?: boolean;
}

export default function StudioStatus({ label, tone, compact = false }: Props) {
  const color = TONE_COLOR[tone];
  return (
    <span className={`studio-status${compact ? ' studio-status--compact' : ''}`} role="status">
      <span className="studio-status-dot" style={{ background: color }} aria-hidden="true" />
      <span className="studio-status-label" style={{ color }}>{label}</span>
    </span>
  );
}
