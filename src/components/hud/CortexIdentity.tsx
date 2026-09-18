// Small identity readout above the Cortex core (mission requirement 7 —
// "CORTEX / ACTIVE" or the real current state, never a fabricated metric
// like CPU%/GPU%/token throughput the app doesn't actually measure).
import { CORTEX_STATE_LABEL, CORTEX_STATE_COLOR, type CortexVisualState } from '../../hooks/useCortexState';

interface Props {
  state: CortexVisualState;
}

export default function CortexIdentity({ state }: Props) {
  const label = CORTEX_STATE_LABEL[state] || 'Repos';
  const color = state === 'idle' ? 'var(--hud-muted)' : CORTEX_STATE_COLOR[state];
  return (
    <>
      <div className="hud2-cortex-atmosphere" data-state={state} aria-hidden="true">
        <div className="hud2-cortex-orbit" />
        <div className="hud2-cortex-dust" />
      </div>
      <div className="hud2-cortex-identity" aria-hidden="true">
        <span className="hud2-cortex-identity-name">CORTEX</span>
        <span className="hud2-cortex-identity-state" style={{ color }}>{label}</span>
      </div>
    </>
  );
}
