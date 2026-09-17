export function isTerminalVideoStatus(status: string): boolean {
  return ['done', 'completed', 'failed', 'error', 'cancelled'].includes(status);
}

export function startVideoJobPolling<T extends { job: { status: string } }>(
  fetchJob: () => Promise<T>,
  onDetail: (detail: T) => void,
  onTerminal: () => void | Promise<void>,
  options?: { schedule?: typeof setTimeout; clear?: typeof clearTimeout; intervalMs?: number },
): () => void {
  return startJobPolling(fetchJob, detail => detail.job.status, onDetail, onTerminal, options);
}

// Generic form for job shapes whose status isn't nested under `.job.status`
// (e.g. OpenMontage's flat job record). Same recursive-timeout behavior:
// stops on a terminal status, swallows transient fetch errors and retries.
export function startJobPolling<T>(
  fetchJob: () => Promise<T>,
  getStatus: (detail: T) => string,
  onDetail: (detail: T) => void,
  onTerminal: () => void | Promise<void>,
  { schedule = setTimeout, clear = clearTimeout, intervalMs = 1500 } = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    try {
      const detail = await fetchJob();
      if (stopped) return;
      if (isTerminalVideoStatus(getStatus(detail))) {
        stopped = true;
        onDetail(detail);
        await onTerminal();
        return;
      }
      onDetail(detail);
    } catch { /* Retry transient network failures after the normal delay. */ }
    if (!stopped) timer = schedule(poll, intervalMs);
  }
  void poll();
  return () => { stopped = true; if (timer !== undefined) clear(timer); };
}
