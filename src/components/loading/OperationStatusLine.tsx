// [Global Loading V1] LOCAL LOADING for a long operation: while running, a small
// spinner next to the component with the elapsed time and the "slower than
// expected" notice; once ended badly (error / timeout / cancel), the compact
// result panel with Retry. Nothing is rendered when idle or successful.
import LoadingSpinner from './LoadingSpinner';
import OperationProgress from './OperationProgress';
import { SLOW_MESSAGE, formatElapsed } from '../../lib/loading/operation';
import type { LongOperation } from '../../hooks/useLongOperation';

interface Props {
  operation: LongOperation;
  onRetry?: () => void;
  /** Running label; defaults to the current step or the operation label. */
  runningLabel?: string;
}

export default function OperationStatusLine({ operation, onRetry, runningLabel }: Props) {
  const { state } = operation;
  if (state.status === 'running') {
    const label = runningLabel ?? state.step ?? state.label;
    return (
      <LoadingSpinner
        label={label}
        meta={formatElapsed(operation.elapsedMs)}
        detail={operation.slow ? SLOW_MESSAGE : null}
      />
    );
  }
  return (
    <OperationProgress
      state={state}
      policy={operation.policy}
      elapsedMs={operation.elapsedMs}
      slow={operation.slow}
      onRetry={onRetry}
      onDismiss={operation.reset}
      compact
    />
  );
}
