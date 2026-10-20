// [LOAD-1/LOAD-2] Boot readiness — the only startup signal the frontend can genuinely observe.
//
// cortex-server calls serve() only after every top-level boot step has finished (DB, migrations, Root Policy, Companion /
// KG boot, media egress), so GET /api/ping answering 200 { ok: true } means "backend initialised and listening". Before
// that the port is closed: the frontend cannot see finer steps (initialising, loading data), so it never claims them.
// No percentage exists here on purpose. The poller only re-runs the read-only ping: it never starts, restarts or kills
// anything (the launcher owns the backend process).

export type ProbeOutcome =
  | { kind: 'ready' }
  | { kind: 'unreachable' }
  | { kind: 'timeout' }
  | { kind: 'unexpected'; status: number };

export type StartupPhase = 'STARTING' | 'WAITING' | 'DELAYED' | 'FAILED' | 'READY';

export interface StartupState {
  phase: StartupPhase;
  /** Completed probes in the current run (a Retry starts a new run). */
  attempts: number;
  startedAt: number;
  /** When the last probe completed (null before the first one). */
  lastCheckAt: number | null;
  lastOutcome: ProbeOutcome | null;
}

export interface StartupPolicy {
  /** One probe never waits longer than this (connection + body). */
  probeTimeoutMs: number;
  /** After this, a still-unanswered start is shown as DELAYED (calm, polling continues). */
  delayedAfterMs: number;
  /** After this, polling stops and FAILED offers Retry — same 120 s budget as scripts/wait-for-cortex.mjs (launcher). */
  failAfterMs: number;
}

export const STARTUP_POLICY: Readonly<StartupPolicy> = Object.freeze({
  probeTimeoutMs: 2_000,
  delayedAfterMs: 15_000,
  failAfterMs: 120_000,
});

/** Pause before the next probe: starts at ~1.3 s and caps at 5 s (unchanged from the pre-LOAD startup gate). */
export function nextProbeDelayMs(attempts: number): number {
  return Math.min(5_000, Math.round(800 * 1.6 ** Math.min(attempts, 5)));
}

/** Phase after a probe that did not report readiness, from the time elapsed since the run started. */
export function phaseAfterMiss(elapsedMs: number, policy: StartupPolicy = STARTUP_POLICY): StartupPhase {
  if (elapsedMs >= policy.failAfterMs) return 'FAILED';
  if (elapsedMs >= policy.delayedAfterMs) return 'DELAYED';
  return 'WAITING';
}

export function initialStartupState(at: number): StartupState {
  return { phase: 'STARTING', attempts: 0, startedAt: at, lastCheckAt: null, lastOutcome: null };
}

/** The local backend ping URL — same host/port rule as the API client (src/lib/cortex/client.ts). */
export function backendPingUrl(loc: Pick<Location, 'protocol' | 'hostname'> = window.location): string {
  return `${loc.protocol}//${loc.hostname}:3001/api/ping`;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One readiness check. Ready only for HTTP 200 with a JSON body { ok: true } (any other answer on that port is
 * "unexpected", never "ready"). Bounded by `timeoutMs` for headers AND body, and aborted early by `signal`.
 */
export async function probeBackend(signal: AbortSignal, {
  url = backendPingUrl(), timeoutMs = STARTUP_POLICY.probeTimeoutMs, fetchImpl = fetch as FetchLike,
}: { url?: string; timeoutMs?: number; fetchImpl?: FetchLike } = {}): Promise<ProbeOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
    if (res.status !== 200) return { kind: 'unexpected', status: res.status };
    const body: unknown = await res.json().catch(() => null);
    return (body as { ok?: unknown } | null)?.ok === true ? { kind: 'ready' } : { kind: 'unexpected', status: res.status };
  } catch {
    return timedOut ? { kind: 'timeout' } : { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export interface ReadinessPollerDeps {
  probe: (signal: AbortSignal) => Promise<ProbeOutcome>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onChange: (state: StartupState) => void;
  policy?: StartupPolicy;
}

export interface ReadinessPoller {
  /** Starts the first run (no-op if already running or finished). */
  start(): void;
  /** Starts a fresh run with a fresh budget — only from FAILED. */
  retry(): void;
  /** Ends polling for good: clears the pending timer, aborts the in-flight probe, ignores its late answer. */
  stop(): void;
  getState(): StartupState | null;
}

/**
 * A single sequential loop: at most one probe in flight, the next one scheduled only after the previous one completed.
 * Every run has a generation number; any answer from an older generation (after stop/retry) is dropped, and READY is
 * terminal, so nothing can ever turn READY back into FAILED.
 */
export function createReadinessPoller(deps: ReadinessPollerDeps): ReadinessPoller {
  const policy = deps.policy ?? STARTUP_POLICY;
  let state: StartupState | null = null;
  let generation = 0;
  let running = false;
  let timer: unknown = null;
  let inFlight: AbortController | null = null;

  const emit = (next: StartupState) => { state = next; deps.onChange(next); };
  const clearPending = () => {
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    if (inFlight) { inFlight.abort(); inFlight = null; }
  };

  async function check(gen: number): Promise<void> {
    timer = null;
    if (gen !== generation || !running || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    let outcome: ProbeOutcome;
    try { outcome = await deps.probe(controller.signal); } catch { outcome = { kind: 'unreachable' }; }
    if (gen !== generation || !running || state === null || state.phase === 'READY') return; // stale answer
    inFlight = null;
    const at = deps.now();
    const attempts = state.attempts + 1;
    if (outcome.kind === 'ready') {
      running = false;
      emit({ ...state, phase: 'READY', attempts, lastCheckAt: at, lastOutcome: outcome });
      return;
    }
    const phase = phaseAfterMiss(at - state.startedAt, policy);
    emit({ ...state, phase, attempts, lastCheckAt: at, lastOutcome: outcome });
    if (phase === 'FAILED') { running = false; return; }
    timer = deps.setTimer(() => { void check(gen); }, nextProbeDelayMs(attempts));
  }

  function begin(): void {
    clearPending();
    generation += 1;
    running = true;
    emit(initialStartupState(deps.now()));
    void check(generation);
  }

  return {
    start() { if (state === null) begin(); },
    retry() { if (state?.phase === 'FAILED') begin(); },
    stop() { running = false; generation += 1; clearPending(); },
    getState() { return state; },
  };
}
