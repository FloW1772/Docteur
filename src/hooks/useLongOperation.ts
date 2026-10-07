// [Global Loading V1] React binding of the central long-operation model.
//
// run(task) starts the task with an AbortSignal and two helpers (setStep,
// setProgress), and guarantees an end state: success, error, timeout or
// cancel. The "slower than expected" flag and the elapsed time tick once per
// second while running. A result that arrives after a timeout, a cancel, a
// newer run or an unmount is ignored — it can never overwrite a newer state.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  IDLE_OPERATION, OPERATION_POLICIES, errorMessage, elapsedMs, isSlow, operationReducer,
  type OperationKind, type OperationPolicy, type OperationProgress, type OperationState,
} from '../lib/loading/operation';

export interface LongOperationContext {
  signal: AbortSignal;
  setStep: (step: string | null) => void;
  setProgress: (progress: OperationProgress | null) => void;
}

export type LongOperationTask<T> = (ctx: LongOperationContext) => Promise<T>;

export interface LongOperation {
  state: OperationState;
  policy: OperationPolicy;
  running: boolean;
  slow: boolean;
  elapsedMs: number;
  run: <T>(label: string, task: LongOperationTask<T>, options?: { step?: string }) => Promise<T | undefined>;
  cancel: () => void;
  retry: () => Promise<unknown>;
  reset: () => void;
}

export function useLongOperation(kindOrPolicy: OperationKind | OperationPolicy): LongOperation {
  const policy: OperationPolicy = typeof kindOrPolicy === 'string' ? OPERATION_POLICIES[kindOrPolicy] : kindOrPolicy;
  const [state, dispatch] = useReducer(operationReducer, IDLE_OPERATION);
  const [now, setNow] = useState(() => Date.now());
  const runId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timers = useRef<number[]>([]);
  const last = useRef<{ label: string; task: LongOperationTask<unknown>; step?: string } | null>(null);
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const clearTimers = useCallback(() => {
    for (const id of timers.current) { window.clearTimeout(id); window.clearInterval(id); }
    timers.current = [];
  }, []);

  useEffect(() => () => {
    // Unmount: stop waiting; late results are ignored by the run id check.
    runId.current += 1;
    controller.current?.abort();
    clearTimers();
  }, [clearTimers]);

  const run = useCallback(async <T,>(label: string, task: LongOperationTask<T>, options: { step?: string } = {}): Promise<T | undefined> => {
    controller.current?.abort();
    clearTimers();
    const id = ++runId.current;
    const ctrl = new AbortController();
    controller.current = ctrl;
    last.current = { label, task: task as LongOperationTask<unknown>, step: options.step };
    const startedAt = Date.now();
    setNow(startedAt);
    dispatch({ type: 'start', label, step: options.step ?? null, at: startedAt });

    const current = () => id === runId.current;
    let timedOut = false;
    timers.current.push(window.setInterval(() => { if (current()) setNow(Date.now()); }, 1_000));
    timers.current.push(window.setTimeout(() => {
      if (!current()) return;
      timedOut = true;
      ctrl.abort();
      runId.current += 1; // anything that still resolves for this run is now stale
      clearTimers();
      dispatch({ type: 'timeout', at: Date.now() });
      setNow(Date.now());
    }, policyRef.current.timeoutMs));

    try {
      const result = await task({
        signal: ctrl.signal,
        setStep: (step) => { if (current()) dispatch({ type: 'step', step }); },
        setProgress: (progress) => { if (current()) dispatch({ type: 'progress', progress }); },
      });
      if (!current()) return undefined;
      clearTimers();
      dispatch({ type: 'succeed', at: Date.now() });
      return result;
    } catch (error) {
      if (!current() || timedOut) return undefined;
      clearTimers();
      if (ctrl.signal.aborted) dispatch({ type: 'cancel', at: Date.now() });
      else dispatch({ type: 'fail', error: errorMessage(error, policyRef.current), at: Date.now() });
      return undefined;
    } finally {
      if (current()) setNow(Date.now());
    }
  }, [clearTimers]);

  const cancel = useCallback(() => {
    if (!policyRef.current.cancellable || !controller.current) return;
    const ctrl = controller.current;
    runId.current += 1;
    ctrl.abort();
    clearTimers();
    dispatch({ type: 'cancel', at: Date.now() });
  }, [clearTimers]);

  const retry = useCallback(() => {
    const previous = last.current;
    if (!previous || !policyRef.current.retryable) return Promise.resolve(undefined);
    return run(previous.label, previous.task, { step: previous.step });
  }, [run]);

  const reset = useCallback(() => {
    runId.current += 1;
    controller.current?.abort();
    clearTimers();
    dispatch({ type: 'reset' });
  }, [clearTimers]);

  return {
    state,
    policy,
    running: state.status === 'running',
    slow: isSlow(state, policy, now),
    elapsedMs: elapsedMs(state, now),
    run,
    cancel,
    retry,
    reset,
  };
}

/**
 * Elapsed-time clock for an operation whose lifecycle is driven elsewhere
 * (e.g. the capture flow in App.tsx): ticks once per second while `active`.
 */
export function useOperationClock(active: boolean): { startedAt: number | null; now: number } {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) { setStartedAt(null); return undefined; }
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return { startedAt, now };
}
