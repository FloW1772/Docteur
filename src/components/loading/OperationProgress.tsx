// [Global Loading V1] MODAL OPERATION — progress panel for a long operation.
//
// Running: current step, determinate bar when progress is known (role
// progressbar + aria-valuenow), indeterminate otherwise, elapsed time, the
// "slower than expected" notice, and Cancel only when cancelling really stops
// the work. Ended: error / timeout / cancelled with Retry when allowed.
// The step and notices live in a polite live region; the elapsed time is
// deliberately outside it so screen readers are not spammed every second.
import {
  SLOW_MESSAGE, describeOperation, formatElapsed, progressPercent,
  type OperationPolicy, type OperationState,
} from '../../lib/loading/operation';

interface Props {
  state: OperationState;
  policy: OperationPolicy;
  elapsedMs: number;
  slow: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
  cancelLabel?: string;
  /** Accessible name of the Cancel button (defaults to "Annuler <label>"). */
  cancelAriaLabel?: string;
  /** Optional extra line under the step (e.g. a model loading hint). */
  hint?: string | null;
  compact?: boolean;
  /** Optional test id for the "slower than expected" line (keeps existing feature test hooks). */
  slowTestId?: string;
}

export default function OperationProgress({
  state, policy, elapsedMs, slow, onCancel, onRetry, onDismiss,
  cancelLabel = 'Annuler', cancelAriaLabel, hint = null, compact = false, slowTestId,
}: Props) {
  if (state.status === 'idle' || state.status === 'success') return null;
  const percent = progressPercent(state.progress);
  const running = state.status === 'running';
  const ended = !running;
  const canRetry = ended && policy.retryable && !!onRetry;
  const now = (state.startedAt ?? 0) + elapsedMs;

  return (
    <div
      className={`dl-op${compact ? ' dl-op--compact' : ''} dl-op--${state.status}`}
      role="group"
      aria-label={state.label}
      aria-busy={running}
      data-operation-status={state.status}
    >
      {running ? (
        <>
          <div className="dl-op-head">
            <span className="dl-spinner" aria-hidden="true" />
            <span className="dl-op-label">{state.label}</span>
          </div>
          <div aria-live="polite" className="dl-op-live">
            {state.step && state.step !== state.label && <p className="dl-op-step">{state.step}</p>}
            {slow && <p className="dl-op-slow" data-testid={slowTestId}>{SLOW_MESSAGE}</p>}
          </div>
          {hint && <p className="dl-op-hint">{hint}</p>}
          {percent !== null ? (
            <div
              className="dl-bar"
              role="progressbar"
              aria-label={`Progression : ${state.label}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${state.progress!.current} sur ${state.progress!.total}${state.progress!.unit ? ` ${state.progress!.unit}` : ''} (${percent} %)`}
            >
              <span className="dl-bar-fill" style={{ width: `${percent}%` }} />
            </div>
          ) : (
            <div className="dl-bar dl-bar--indeterminate" role="progressbar" aria-label={`Progression : ${state.label}`} aria-valuetext="En cours, durée inconnue">
              <span className="dl-bar-fill" />
            </div>
          )}
          <div className="dl-op-foot">
            <span className="dl-op-elapsed">Écoulé : {formatElapsed(elapsedMs)}</span>
            {policy.cancellable && onCancel && (
              <button type="button" className="dl-btn dl-btn--danger" onClick={onCancel} aria-label={cancelAriaLabel ?? `${cancelLabel} ${state.label.toLowerCase()}`}>
                {cancelLabel}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className={`dl-op-result${state.status === 'cancelled' ? '' : ' dl-op-result--alert'}`} role={state.status === 'cancelled' ? 'status' : 'alert'}>
            {describeOperation(state, policy, now)}
          </p>
          {(canRetry || onDismiss) && (
            <div className="dl-op-foot">
              {canRetry && <button type="button" className="dl-btn" onClick={onRetry}>Réessayer</button>}
              {onDismiss && <button type="button" className="dl-btn dl-btn--ghost" onClick={onDismiss}>Fermer</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
