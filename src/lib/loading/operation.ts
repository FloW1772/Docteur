// [Global Loading V1] Central model for long operations.
//
// Every long operation in Docteur is described by the same small state:
// what is running, its current step, its progress when it is known, how long
// it has been running, and how it ended (success, error, timeout, cancel).
// The UI reads this state instead of a bare boolean, so a spinner can never
// spin forever without saying anything: each policy has a "slower than
// expected" threshold and a finite timeout.
//
// Three presentation scopes, chosen per operation (never "everything full screen"):
//   local  → small spinner next to the component that is waiting;
//   modal  → progress panel inside the dialog that started the work;
//   global → blocking overlay, only when the whole app must not be used
//            meanwhile (e.g. restoring a backup over the current neurons).

export type OperationScope = 'local' | 'modal' | 'global';
export type OperationStatus = 'idle' | 'running' | 'success' | 'error' | 'timeout' | 'cancelled';

export interface OperationProgress {
  current: number;
  total: number;
  unit?: string;
}

export interface OperationPolicy {
  scope: OperationScope;
  /** After this delay the UI says the operation is slower than expected (it keeps running). */
  slowAfterMs: number;
  /** Hard limit: past it the operation is reported as timed out. Always finite. */
  timeoutMs: number;
  /** Only true when stopping really stops the work (an AbortSignal reaches the request). */
  cancellable: boolean;
  retryable: boolean;
  /** Shown on timeout when the server may still finish the work on its own. */
  mayContinueAfterTimeout?: boolean;
}

export interface OperationState {
  status: OperationStatus;
  label: string;
  step: string | null;
  progress: OperationProgress | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  attempt: number;
}

export type OperationAction =
  | { type: 'start'; label: string; step?: string | null; at: number }
  | { type: 'step'; step: string | null }
  | { type: 'progress'; progress: OperationProgress | null }
  | { type: 'succeed'; at: number }
  | { type: 'fail'; error: string; at: number }
  | { type: 'timeout'; at: number }
  | { type: 'cancel'; at: number }
  | { type: 'reset' };

export const IDLE_OPERATION: OperationState = Object.freeze({
  status: 'idle',
  label: '',
  step: null,
  progress: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  attempt: 0,
}) as OperationState;

/**
 * Policies of the long operations wired to the model (Global Loading V1).
 * The underlying requests already carry their own client timeout (cortex
 * client); each timeoutMs is a safety net set just above that real bound, so
 * the UI always reaches an end state even if a lower layer misbehaves.
 */
export const OPERATION_POLICIES = {
  // Deep capture: the client request is already bounded (DEEP_CAPTURE_TIMEOUT_MS = 5 min) and cancellable.
  articleCapture: { scope: 'modal', slowAfterMs: 45_000, timeoutMs: 330_000, cancellable: true, retryable: true },
  // Local/cloud image generation (2 requests × 90 s): the server keeps generating if the page stops waiting.
  imageGeneration: { scope: 'modal', slowAfterMs: 30_000, timeoutMs: 200_000, cancellable: false, retryable: true, mayContinueAfterTimeout: true },
  visionAnalysis: { scope: 'local', slowAfterMs: 20_000, timeoutMs: 150_000, cancellable: false, retryable: true }, // request: 120 s
  pdfExport: { scope: 'local', slowAfterMs: 15_000, timeoutMs: 120_000, cancellable: false, retryable: true }, // requests: 60 / 90 s
  // No automatic retry: the server may already have stored the user message (a resend could duplicate it).
  chatReply: { scope: 'local', slowAfterMs: 20_000, timeoutMs: 150_000, cancellable: false, retryable: false }, // request: 120 s
  // [Browser Media Bridge V1] Media Reader load: same thresholds as media-resource.ts (SLOW_AFTER_MS / LOAD_TIMEOUT_MS,
  // equality checked by test-global-loading-unit); closing the reader really aborts the load.
  mediaReader: { scope: 'modal', slowAfterMs: 4_000, timeoutMs: 20_000, cancellable: true, retryable: true },
  // [Document Toolbox PDF V1] local PDF operations (request bounded by the client timeout of 180 s).
  documentToolbox: { scope: 'local', slowAfterMs: 10_000, timeoutMs: 200_000, cancellable: false, retryable: true },
  // [Media Studio V1] chunked import (1 GB max): aborting really stops the upload (the server drops the partial file).
  mediaStudioImport: { scope: 'local', slowAfterMs: 20_000, timeoutMs: 1_200_000, cancellable: true, retryable: true },
  // [Media Studio V1] FFmpeg export: the server job is the source of truth (own 30 min limit); cancel kills the FFmpeg tree.
  mediaStudioExport: { scope: 'local', slowAfterMs: 120_000, timeoutMs: 1_860_000, cancellable: true, retryable: true },
  // Restoring a backup rewrites the neurons the whole app is showing: the only global blocking operation.
  // Request 90 s, then the local restore of every neuron (can be long on big backups).
  backupImport: { scope: 'global', slowAfterMs: 20_000, timeoutMs: 600_000, cancellable: false, retryable: false, mayContinueAfterTimeout: true },
} as const satisfies Record<string, OperationPolicy>;

export type OperationKind = keyof typeof OPERATION_POLICIES;

export function operationReducer(state: OperationState, action: OperationAction): OperationState {
  switch (action.type) {
    case 'start':
      return {
        status: 'running',
        label: action.label,
        step: action.step ?? null,
        progress: null,
        startedAt: action.at,
        finishedAt: null,
        error: null,
        attempt: state.attempt + 1,
      };
    case 'step':
      return state.status === 'running' ? { ...state, step: action.step } : state;
    case 'progress':
      return state.status === 'running' ? { ...state, progress: action.progress } : state;
    case 'succeed':
      return state.status === 'running' ? { ...state, status: 'success', finishedAt: action.at } : state;
    case 'fail':
      return state.status === 'running' ? { ...state, status: 'error', error: action.error || 'Erreur inconnue', finishedAt: action.at } : state;
    case 'timeout':
      return state.status === 'running' ? { ...state, status: 'timeout', finishedAt: action.at } : state;
    case 'cancel':
      return state.status === 'running' ? { ...state, status: 'cancelled', finishedAt: action.at } : state;
    case 'reset':
      return { ...IDLE_OPERATION, attempt: state.attempt };
    default:
      return state;
  }
}

/** Percentage of a known progress, clamped to 0–100; null when progress is unknown. */
export function progressPercent(progress: OperationProgress | null | undefined): number | null {
  if (!progress || !Number.isFinite(progress.current) || !Number.isFinite(progress.total) || progress.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}

export function elapsedMs(state: OperationState, now: number): number {
  if (state.startedAt === null) return 0;
  return Math.max(0, (state.finishedAt ?? now) - state.startedAt);
}

export function isSlow(state: OperationState, policy: Pick<OperationPolicy, 'slowAfterMs'>, now: number): boolean {
  return state.status === 'running' && elapsedMs(state, now) >= policy.slowAfterMs;
}

export const SLOW_MESSAGE = 'Plus long que prévu — l’opération continue.';

/** What the UI should say about the current state (one sentence, French). */
export function describeOperation(state: OperationState, policy: OperationPolicy, now: number): string {
  switch (state.status) {
    case 'idle':
      return '';
    case 'running': {
      const base = state.step || state.label;
      return isSlow(state, policy, now) ? `${base} — ${SLOW_MESSAGE}` : base;
    }
    case 'success':
      return `${state.label} — terminé.`;
    case 'error':
      return `${state.label} — échec : ${state.error}`;
    case 'timeout':
      return policy.mayContinueAfterTimeout
        ? `${state.label} — délai dépassé (${formatElapsed(policy.timeoutMs)}). Le serveur a peut-être terminé en arrière-plan.`
        : `${state.label} — délai dépassé (${formatElapsed(policy.timeoutMs)}).`;
    case 'cancelled':
      return `${state.label} — annulé.`;
    default:
      return '';
  }
}

export function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Human message for an error thrown by a long call (abort/timeout names are not shown raw). */
export function errorMessage(error: unknown, policy?: Pick<OperationPolicy, 'mayContinueAfterTimeout'>): string {
  if (isAbortLike(error)) {
    return policy?.mayContinueAfterTimeout
      ? 'La requête a été interrompue (délai réseau dépassé). Le serveur a peut-être terminé en arrière-plan.'
      : 'La requête a été interrompue (délai réseau dépassé).';
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error ?? 'Erreur inconnue');
}
