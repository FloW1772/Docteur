export type CapturePipelineState =
  | 'CAPTURING'
  | 'EXTRACTED'
  | 'SAVING'
  | 'INDEXING'
  | 'READY'
  | 'FAILED';

// The observed qwen analysis can legitimately exceed two minutes. This is a
// safety ceiling, not an expected duration; the user can still cancel sooner.
export const DEEP_CAPTURE_TIMEOUT_MS = 5 * 60_000;

export type CaptureFailureCode = 'SAVE_FAILED' | 'INDEX_FAILED';

export class CapturePipelineError extends Error {
  readonly code: CaptureFailureCode;

  constructor(code: CaptureFailureCode, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${code}: ${detail}`);
    this.name = 'CapturePipelineError';
    this.code = code;
  }
}

interface CapturePipelineOptions<T> {
  createPersisted: () => Promise<T>;
  index: (value: T) => Promise<void>;
  persistStatus: (value: T, status: 'READY' | 'INDEX_FAILED', error?: string) => Promise<T>;
  onState?: (state: CapturePipelineState) => void;
}

/**
 * Transaction boundary for a captured article. The initial create must be
 * acknowledged by the authoritative store, indexing is awaited, and READY is
 * persisted last. An index failure keeps the saved article retryable.
 */
export async function persistCapturedArticle<T>({
  createPersisted,
  index,
  persistStatus,
  onState,
}: CapturePipelineOptions<T>): Promise<T> {
  onState?.('SAVING');

  let value: T;
  try {
    value = await createPersisted();
  } catch (error) {
    onState?.('FAILED');
    throw new CapturePipelineError('SAVE_FAILED', error);
  }

  onState?.('INDEXING');
  try {
    await index(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      value = await persistStatus(value, 'INDEX_FAILED', detail);
    } catch {
      // Preserve the primary indexing error. The caller still receives an
      // explicit failure and can retry from the in-memory saved article.
    }
    onState?.('FAILED');
    throw new CapturePipelineError('INDEX_FAILED', error);
  }

  try {
    value = await persistStatus(value, 'READY');
  } catch (error) {
    onState?.('FAILED');
    throw new CapturePipelineError('SAVE_FAILED', error);
  }
  onState?.('READY');
  return value;
}
