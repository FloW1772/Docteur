export function isTerminalVideoStatus(status: string): boolean {
  return ['done', 'completed', 'failed', 'error', 'cancelled'].includes(status);
}

export function startVideoJobPolling<T extends { job: { status: string } }>(
  fetchJob: () => Promise<T>,
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
      if (isTerminalVideoStatus(detail.job.status)) {
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
