/**
 * RASSILON V1 — local single-machine safe worker. Owns the
 * DISABLED/IDLE/WORKING/PAUSED/AUTO_PAUSED/ERROR state machine (Phase 2
 * mission §4; Phase 3 mission §13/§16 add AUTO_PAUSED/ERROR as real,
 * reachable states), the bounded local queue, the job-acceptance pipeline
 * (signature/replay/schema/policy/resource checks), and lifecycle
 * (enable/disable/pause/resume/kill).
 *
 * This module is the ONLY place that calls runJobExecutor()
 * (rassilon-executors.js) — routes/rassilon.js never calls the executor
 * registry directly, mirroring MAÎTRE's orchestrator-is-the-only-caller
 * discipline (maitre.js's header comment).
 *
 * No hidden worker (mission §46 Phase 2): nothing in this module starts
 * timers or accepts jobs until initRassilonWorker() is called explicitly
 * by server.js at boot, and the in-memory queue/active-job state is never
 * persisted as "still running" across a process restart — crash recovery
 * always finds RUNNING rows in SQLite and marks them INTERRUPTED on next
 * boot, never resumes them.
 */
import {
  getRassilonSettings, updateRassilonSettings, setRassilonEnabled,
  getRassilonIdentity, insertRassilonJob, getRassilonJobById, listRassilonJobs,
  listRassilonJobsByStatuses, updateRassilonJob,
  getRassilonDevice, revokeAllRassilonSessions, setRassilonLanSettings,
} from './sqlite.js';
import { validateSettingsPatch } from './rassilon-settings.js';
import { validateJobSchema, verifyJobSignature, isExpired, isReasonableTimestamp, RassilonJobError, JOB_TYPES } from './rassilon-job-schema.js';
import { runJobExecutor, RassilonExecutionError, AVAILABLE_EXECUTORS } from './rassilon-executors.js';
import { RassilonEmbeddingError } from './rassilon-embedding.js';
import { checkAdmission, checkRuntimeBudget, getSystemRamStatus } from './rassilon-resource-guard.js';
import { detectPowerStatus } from './rassilon-power.js';
import { detectIdleStatus } from './rassilon-idle.js';
import { cleanupJobScratchDir, sweepScratchOnBoot } from './rassilon-scratch.js';
import { recordAuditEvent } from './rassilon-audit.js';
import { requestRassilonLanStop } from './rassilon-lan-runtime.js';

export class RassilonWorkerError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'RassilonWorkerError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new RassilonWorkerError(code, detail);
}

// AUTO_PAUSED is a distinct state from PAUSED (mission §13): PAUSED means
// a human explicitly asked for a pause and only a human resumes it;
// AUTO_PAUSED means the safety-guard sweep paused the worker on its own
// (battery/idle/RAM pressure) and MAY be auto-resumed once conditions
// clear (mission §14) — never the reverse. ERROR (mission §16) is a
// distinct, real, reachable state for durable internal faults, not a
// per-job failure (a failed job just becomes JOB status FAILED; ERROR is
// reserved for problems with the WORKER itself).
export const STATES = Object.freeze(['DISABLED', 'IDLE', 'WORKING', 'PAUSED', 'AUTO_PAUSED', 'ERROR']);

// Bounded local queue (mission §28) — conservative default, documented,
// not unbounded.
export const MAX_QUEUE_SIZE = 10;

// Anti-replay window (mission §18/§15): the maximum lifetime a job's own
// expiresAt may declare relative to createdAt, independent of whatever
// the issuer requests — keeps every accepted job short-lived by
// construction rather than trusting the issuer's expiresAt alone.
export const MAX_JOB_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes

// How often the automatic safety-guard sweep (battery/idle/RAM pressure)
// runs while WORKING or IDLE-and-enabled. Battery/idle probes cost
// ~300-600ms each (PowerShell cold start + compile) — 30s keeps that
// overhead negligible.
const SAFETY_GUARD_INTERVAL_MS = 30_000;

// Auto-resume hysteresis (mission §15): conditions must read "healthy" on
// this many CONSECUTIVE sweeps before AUTO_PAUSED -> IDLE actually fires,
// to avoid oscillating pause/resume when a reading flickers near a
// threshold (e.g. battery% bouncing at the minimumBatteryPercent edge, or
// idle/active toggling around the 60s activity threshold). At the 30s
// sweep interval, 2 consecutive healthy sweeps = a minimum ~30-60s of
// sustained healthy condition before resuming — documented as the real
// value, not left implicit.
const AUTO_RESUME_HEALTHY_SWEEPS_REQUIRED = 2;

// In-memory-only state — never persisted as "the worker is running" across
// a restart (mission §22/§46 Phase 2: no hidden persistence, crash
// recovery always re-derives state from SQLite's RUNNING->INTERRUPTED
// sweep, never from a remembered in-memory flag).
let currentState = 'DISABLED';
let queue = []; // array of jobId, FIFO
let activeJob = null; // { jobId, abortController, startedAt }
let safetyGuardTimer = null;
let workerLogger = { info() {}, warn() {}, error() {} };
let workerProviders = {}; // { ollamaClient, embeddingModel } — injected at init, forwarded to executors that need a local provider
let consecutiveHealthySweeps = 0; // hysteresis counter for AUTO_PAUSED -> IDLE (mission §15)
let errorDetail = null; // { code, message } set when entering ERROR (mission §16/§17), cleared on recovery

// Payload cache: submitJob() validates+queues by jobId while persisting
// only a bounded summary to SQLite (matching the architecture's DB-
// summary-only storage, mission §16 — resource_budget/payload_summary
// are NOT the full replay-able payload). runJob() needs the actual
// validated payload object to hand to the executor, so submitJob()
// stashes it here BEFORE calling processQueue() (which can synchronously
// start runJob() for this very job). Bounded by MAX_QUEUE_SIZE+1 entries
// — never grows unboundedly since every entry is deleted the moment
// runJob consumes it, and rejected/never-queued jobs never get an entry.
const jobPayloadCache = new Map();

function log(level, msg, extra) {
  try { workerLogger[level]?.(extra ?? {}, msg); } catch { /* logging must never crash the worker */ }
}

export function getRassilonState() {
  return currentState;
}

export function getRassilonStatus() {
  const settings = getRassilonSettings();
  const activeRow = activeJob ? getRassilonJobById(activeJob.jobId) : null;
  const remoteController = activeRow ? getRassilonDevice(activeRow.issuerDeviceId) : null;
  return {
    state: currentState,
    enabled: settings.enabled,
    queueDepth: queue.length,
    activeJob: activeJob ? {
      jobId: activeJob.jobId,
      jobType: activeRow?.jobType ?? null,
      startedAt: activeJob.startedAt,
    } : null,
    remoteController: remoteController ? { deviceId: remoteController.deviceId, displayName: remoteController.displayName, fingerprint: remoteController.fingerprint } : null,
    settings,
    error: currentState === 'ERROR' ? errorDetail : null,
  };
}

// ── Boot / init (mission §34/§46 Phase 2) ───────────────────────────────────

/**
 * Called once by server.js at startup. Performs crash recovery (any
 * RUNNING job from a prior process becomes INTERRUPTED, queued jobs are
 * cancelled per the documented V1 policy), sweeps the scratch workspace,
 * and leaves the worker in DISABLED or IDLE depending on persisted
 * settings.enabled — never starts accepting jobs on its own initiative
 * beyond restoring the previously-explicit enabled state.
 *
 * `providers` (mission §3 Phase 3): { ollamaClient, embeddingModel },
 * forwarded to EMBEDDING_BATCH jobs at execution time. Wired by server.js
 * from the SAME module-level ollamaClient/env.EMBEDDING_MODEL every other
 * embedding call site in this codebase already uses (mission §3: "Auditer
 * d'abord le provider existant... ne pas écrire un nouveau moteur").
 * Tests inject their own mock client here instead.
 */
export function initRassilonWorker({ logger, providers = {} } = {}) {
  if (logger) workerLogger = logger;
  workerProviders = providers;
  errorDetail = null;
  consecutiveHealthySweeps = 0;

  // Fatal internal precondition check (mission §16 — "executor registry
  // invalid" is one of the named ERROR triggers): if the executor
  // registry doesn't expose exactly the job types the schema layer
  // declares, something is structurally broken (a code defect, not a
  // per-job problem) and the worker must not silently proceed as if
  // nothing were wrong.
  const registrySanityIssue = checkExecutorRegistrySanity();
  if (registrySanityIssue) {
    currentState = 'ERROR';
    errorDetail = {
      code: 'executor_registry_invalid', message: registrySanityIssue, timestamp: new Date().toISOString(),
    };
    log('error', 'RASSILON entering ERROR at boot: executor registry invalid', { detail: registrySanityIssue });
    recordAuditEvent({ eventType: 'WORKER_ERROR', resultSummary: { code: 'executor_registry_invalid' } });
    return { state: currentState, interruptedCount: 0, cancelledQueuedCount: 0 };
  }

  const interrupted = listRassilonJobsByStatuses(['RUNNING']);
  for (const job of interrupted) {
    updateRassilonJob(job.jobId, { status: 'INTERRUPTED', completed_at: new Date().toISOString(), error_reason: 'server_restart' });
    recordAuditEvent({ eventType: 'JOB_INTERRUPTED', jobId: job.jobId, issuerDeviceId: job.issuerDeviceId, resultSummary: { reason: 'server_restart' } });
    cleanupJobScratchDir(job.jobId);
  }

  // Mission §34 recommendation: cancel queued jobs on restart rather than
  // re-validating and silently resuming them — documented explicitly, not
  // left implicit.
  const queued = listRassilonJobsByStatuses(['QUEUED', 'VALIDATED', 'RECEIVED']);
  for (const job of queued) {
    updateRassilonJob(job.jobId, { status: 'CANCELLED', completed_at: new Date().toISOString(), error_reason: 'server_restart_queue_cleared' });
    recordAuditEvent({ eventType: 'JOB_CANCELLED', jobId: job.jobId, issuerDeviceId: job.issuerDeviceId, resultSummary: { reason: 'server_restart_queue_cleared' } });
    cleanupJobScratchDir(job.jobId);
  }

  sweepScratchOnBoot();

  queue = [];
  activeJob = null;

  const settings = getRassilonSettings();
  currentState = settings.enabled ? 'IDLE' : 'DISABLED';
  if (currentState !== 'DISABLED') startSafetyGuard();

  return { state: currentState, interruptedCount: interrupted.length, cancelledQueuedCount: queued.length };
}

// Confirms the executor registry actually implements every closed job
// type the schema layer declares — a structural self-check, not a
// per-job validation. Returns a human-readable problem string, or null
// if sane. This is intentionally cheap (no I/O) since it runs at every
// boot.
function checkExecutorRegistrySanity() {
  const missing = JOB_TYPES.filter(t => !AVAILABLE_EXECUTORS.includes(t));
  if (missing.length > 0) return `executor(s) missing for declared job type(s): ${missing.join(', ')}`;
  return null;
}

/** Test-only: resets in-memory state without touching SQLite (each test file re-inits its own DB separately). */
export function resetRassilonWorkerForTests() {
  stopSafetyGuard();
  currentState = 'DISABLED';
  queue = [];
  activeJob = null;
  errorDetail = null;
  consecutiveHealthySweeps = 0;
  workerLogger = { info() {}, warn() {}, error() {} };
}

// ── Settings changes (mission §18/§19/§20 Phase 3) ──────────────────────────

// Fields whose in-flight application policy matters (mission §19/§20):
// changing any of these while a job is WORKING never affects that job —
// the active job keeps running under the resourceBudget it was admitted
// with (captured on the rassilon_jobs row at acceptance time, never
// re-read from live settings mid-run). A new/lower value only takes
// effect for jobs admitted AFTER the change (checkAdmission always reads
// getRassilonSettings() fresh at admission time). This is the "next-job
// only" policy — documented and enforced structurally (the running job's
// budget was already snapshotted; there's no code path that re-reads
// settings for an in-flight job's own limits), not by a special-cased
// runtime check.
const NEXT_JOB_ONLY_FIELDS = Object.freeze(['maxCpuPercent', 'maxRamMb', 'maxJobDurationSec', 'maxConcurrentJobs', 'maxScratchMb']);

/**
 * Validates and applies a settings PATCH, emitting a bounded
 * SETTINGS_CHANGED audit event (mission §18): fields changed, old/new
 * values, timestamp — never secrets (settings has none, but this stays
 * generic rather than assuming that will always be true). Safe to call
 * in any state except DISABLED/ERROR is NOT required by the mission (a
 * settings change while disabled is harmless — it just adjusts what
 * enable() will read next), so this intentionally does NOT gate on
 * currentState the way job submission does.
 */
export function changeRassilonSettings(input) {
  const before = getRassilonSettings();
  const patch = validateSettingsPatch(input);
  const after = updateRassilonSettings(patch);

  const changedFields = Object.keys(input).filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  if (changedFields.length > 0) {
    const fieldChanges = {};
    for (const field of changedFields) {
      fieldChanges[field] = { old: before[field], new: after[field] };
    }
    recordAuditEvent({
      eventType: 'SETTINGS_CHANGED',
      resultSummary: {
        fields: changedFields,
        changes: fieldChanges,
        appliedDuringWorking: currentState === 'WORKING',
        nextJobOnly: changedFields.some(f => NEXT_JOB_ONLY_FIELDS.includes(f)),
      },
    });
    log('info', 'RASSILON settings changed', { fields: changedFields });
  }

  return after;
}

// ── Enable / disable / pause / resume / kill (mission §31-§34 Phase 2;
// §16/§17 Phase 3 ERROR behavior) ──────────────────────────────────────────

/**
 * Enabling FROM an ERROR state is the one explicit, deterministic
 * recovery path (mission §17 — "Recovery : manuel ou safe deterministic
 * recovery. Pas de silent auto-reset si état inconnu."): calling
 * enable() re-runs the same registry sanity check init() runs, and only
 * clears ERROR if that check now passes. A worker stuck in ERROR because
 * of a genuinely broken registry stays in ERROR even after an enable
 * attempt — this is not a silent reset, it's a re-validated one.
 */
export function enableRassilon(settingsPayload) {
  if (!settingsPayload || typeof settingsPayload !== 'object') fail('settings_required_to_enable');
  // Mission §3/architecture §4 (Phase 2): cannot enable with defaults
  // only — the caller must supply the full quota/policy payload, not
  // rely on whatever DB defaults happen to already be there.
  const REQUIRED_FIELDS = ['maxCpuPercent', 'maxRamMb', 'maxConcurrentJobs', 'maxJobDurationSec', 'maxScratchMb', 'pauseOnBattery', 'minimumBatteryPercent', 'pauseWhenUserActive'];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in settingsPayload)) fail('settings_incomplete', { missingField: field });
  }

  if (currentState === 'ERROR') {
    const registrySanityIssue = checkExecutorRegistrySanity();
    if (registrySanityIssue) fail('cannot_enable_worker_in_error', { detail: registrySanityIssue });
    errorDetail = null;
    recordAuditEvent({ eventType: 'WORKER_RECOVERED' });
    log('info', 'RASSILON recovered from ERROR via explicit enable');
  }

  const patch = validateSettingsPatch(settingsPayload);
  updateRassilonSettings(patch);
  setRassilonEnabled(true);
  currentState = 'IDLE';
  consecutiveHealthySweeps = 0;
  startSafetyGuard();
  recordAuditEvent({ eventType: 'RASSILON_ENABLED' });
  log('info', 'RASSILON enabled');
  return getRassilonStatus();
}

/**
 * Always works, from any state including ERROR (mission §17 — "Disable :
 * doit toujours fonctionner").
 */
export function disableRassilon() {
  cancelQueue('rassilon_disabled');
  cancelActiveJob('rassilon_disabled');
  setRassilonEnabled(false);
  revokeAllRassilonSessions();
  setRassilonLanSettings({ enabled: false });
  requestRassilonLanStop();
  currentState = 'DISABLED';
  errorDetail = null;
  stopSafetyGuard();
  recordAuditEvent({ eventType: 'RASSILON_DISABLED' });
  log('info', 'RASSILON disabled');
  return getRassilonStatus();
}

/**
 * Manual pause (mission §13/§14): always PAUSED, never AUTO_PAUSED — a
 * human explicitly asked, so only a human (resumeRassilon) can undo it.
 * The safety-guard sweep's own auto-pause path never overwrites a
 * PAUSED state back into AUTO_PAUSED, and never auto-resumes out of it
 * (checked in runSafetyGuardSweep below).
 */
export function pauseRassilon() {
  if (currentState === 'DISABLED') fail('cannot_pause_disabled');
  if (currentState === 'ERROR') fail('cannot_pause_in_error');
  currentState = 'PAUSED';
  recordAuditEvent({ eventType: 'RASSILON_PAUSED' });
  return getRassilonStatus();
}

/**
 * Manual resume — valid from PAUSED or AUTO_PAUSED (a human can always
 * resume early, regardless of why the pause happened).
 */
export function resumeRassilon() {
  if (currentState === 'DISABLED') fail('cannot_resume_disabled');
  if (currentState === 'ERROR') fail('cannot_resume_in_error');
  currentState = activeJob ? 'WORKING' : 'IDLE';
  consecutiveHealthySweeps = 0;
  recordAuditEvent({ eventType: 'RASSILON_RESUMED' });
  processQueue();
  return getRassilonStatus();
}

/**
 * Kill switch (mission §29 Phase 3 / §33/§34 Phase 2): stop accepting,
 * cancel queue, cancel active job, cleanup, land in DISABLED — no silent
 * restart. Always works, from any state including ERROR (mission §17 —
 * "Kill switch : doit toujours fonctionner").
 */
export function killAllRassilonWork() {
  cancelQueue('kill_switch');
  cancelActiveJob('kill_switch');
  setRassilonEnabled(false);
  revokeAllRassilonSessions();
  setRassilonLanSettings({ enabled: false });
  requestRassilonLanStop();
  currentState = 'DISABLED';
  errorDetail = null;
  stopSafetyGuard();
  recordAuditEvent({ eventType: 'KILL_SWITCH_TRIGGERED' });
  recordAuditEvent({ eventType: 'LOCAL_STOP' });
  log('warn', 'RASSILON kill switch triggered');
  return getRassilonStatus();
}

function cancelQueue(reason) {
  for (const jobId of queue) {
    updateRassilonJob(jobId, { status: 'CANCELLED', completed_at: new Date().toISOString(), error_reason: reason });
    recordAuditEvent({ eventType: 'JOB_CANCELLED', jobId, resultSummary: { reason } });
    cleanupJobScratchDir(jobId);
  }
  queue = [];
}

function cancelActiveJob(reason) {
  if (!activeJob) return;
  activeJob.abortController.abort();
  // The executor's own catch path (in processQueue's job-run try/catch)
  // finalizes the SQLite row/audit event/cleanup once runJobExecutor's
  // promise actually rejects — this function only signals cancellation,
  // it does not race to write the terminal state itself.
  log('info', `cancelling active job ${activeJob.jobId} (${reason})`);
}

export function cancelJobById(jobId) {
  const job = getRassilonJobById(jobId);
  if (!job) fail('job_not_found', { jobId });
  if (activeJob?.jobId === jobId) {
    cancelActiveJob('user_cancel');
    return getRassilonJobById(jobId);
  }
  if (queue.includes(jobId)) {
    queue = queue.filter(id => id !== jobId);
    updateRassilonJob(jobId, { status: 'CANCELLED', completed_at: new Date().toISOString(), error_reason: 'user_cancel' });
    recordAuditEvent({ eventType: 'JOB_CANCELLED', jobId, resultSummary: { reason: 'user_cancel' } });
    cleanupJobScratchDir(jobId);
    return getRassilonJobById(jobId);
  }
  fail('job_not_active_or_queued', { jobId, status: job.status });
}

export function cancelJobsByIssuer(issuerDeviceId, reason = 'issuer_revoked') {
  let cancelled = 0;
  for (const jobId of [...queue]) {
    const job = getRassilonJobById(jobId);
    if (job?.issuerDeviceId !== issuerDeviceId) continue;
    queue = queue.filter(id => id !== jobId);
    updateRassilonJob(jobId, { status: 'CANCELLED', completed_at: new Date().toISOString(), error_reason: reason });
    recordAuditEvent({ eventType: 'JOB_CANCELLED', jobId, issuerDeviceId, resultSummary: { reason } });
    cleanupJobScratchDir(jobId);
    cancelled += 1;
  }
  if (activeJob) {
    const job = getRassilonJobById(activeJob.jobId);
    if (job?.issuerDeviceId === issuerDeviceId) {
      cancelActiveJob(reason);
      cancelled += 1;
    }
  }
  return cancelled;
}

// ── Job submission / acceptance pipeline (mission §32 of the architecture
// report, §16/§17/§19/§20/§24 of the Phase 2 mission) ──────────────────────

// Bounded, time-windowed record of processed jobIds — anti-replay beyond
// what the UNIQUE PRIMARY KEY on rassilon_jobs.job_id already guarantees
// at the DB layer (a duplicate insert throws; this catches that and
// reports it as a clean rejection reason rather than an unhandled DB
// error). The DB row IS the source of truth; this is not a second store,
// just where the try/catch around insertRassilonJob lives.

export function submitJob(rawJob) {
  recordAuditEvent({ eventType: 'JOB_RECEIVED', jobId: typeof rawJob?.jobId === 'string' ? rawJob.jobId : null, issuerDeviceId: typeof rawJob?.issuerId === 'string' ? rawJob.issuerId : null });

  if (currentState === 'DISABLED') return reject('rassilon_disabled', rawJob);
  if (currentState === 'PAUSED') return reject('rassilon_paused', rawJob);
  if (currentState === 'AUTO_PAUSED') return reject('rassilon_auto_paused', rawJob);
  if (currentState === 'ERROR') return reject('rassilon_error_state', rawJob);

  let job;
  try {
    job = validateJobSchema(rawJob);
  } catch (err) {
    if (err instanceof RassilonJobError) return reject(err.code, rawJob, err.detail);
    throw err;
  }

  // Anti-replay: reasonable timestamp, not expired, lifetime capped
  // regardless of what the issuer declared (mission §18).
  if (!isReasonableTimestamp(job)) return reject('created_at_unreasonable', job);
  const declaredLifetimeMs = Date.parse(job.expiresAt) - Date.parse(job.createdAt);
  if (declaredLifetimeMs > MAX_JOB_LIFETIME_MS) return reject('job_lifetime_exceeds_policy', job);
  if (isExpired(job)) return reject('job_expired', job);

  // Issuer authentication (mission §19 — local trusted issuer only) +
  // signature verification (mission §17/T2/T10).
  const identity = getRassilonIdentity(job.issuerId);
  if (!identity) return reject('issuer_not_registered', job);
  if (!verifyJobSignature(job, identity.public_key_pem)) return reject('signature_invalid', job);

  // Executor allowlist — already enforced by validateJobSchema's closed
  // JOB_TYPES check, re-asserted here defensively since this is the
  // security-critical gate (mission §23).
  const settings = getRassilonSettings();
  if (settings.acceptedJobTypes.length > 0 && !settings.acceptedJobTypes.includes(job.jobType)) {
    return reject('job_type_not_accepted_by_policy', job);
  }

  // Resource admission (mission §51 — reject BEFORE execution).
  const admission = checkAdmission({ resourceBudget: job.resourceBudget, settings });
  if (!admission.admitted) return reject(admission.reasons[0], job, { reasons: admission.reasons });

  // Queue bound (mission §28).
  if (queue.length >= MAX_QUEUE_SIZE) return reject('queue_full', job);

  // Persist as RECEIVED then VALIDATED->QUEUED — a duplicate jobId throws
  // here (UNIQUE PRIMARY KEY), which is exactly the anti-replay signal
  // for "already processed" (mission §17).
  let row;
  try {
    row = insertRassilonJob({
      job_id: job.jobId,
      job_type: job.jobType,
      issuer_device_id: job.issuerId,
      status: 'QUEUED',
      resource_budget: JSON.stringify(job.resourceBudget),
      payload_summary: JSON.stringify({ kind: job.payload?.kind ?? null }),
      expires_at: job.expiresAt,
      policy_version: job.policyVersion,
    });
  } catch {
    return reject('job_id_already_processed', job);
  }

  // Stashed BEFORE processQueue() runs — processQueue() can synchronously
  // start runJob() for this very job (empty queue, no active job), which
  // reads this cache before its very first await, so the write must
  // happen before, not after, the call below.
  jobPayloadCache.set(job.jobId, job.payload);

  queue.push(job.jobId);
  recordAuditEvent({ eventType: 'JOB_QUEUED', jobId: job.jobId, issuerDeviceId: job.issuerId });
  log('info', `job ${job.jobId} queued (${job.jobType})`);

  processQueue();
  return { accepted: true, job: row };
}

function reject(reasonCode, rawJobOrJob, detail) {
  const jobId = typeof rawJobOrJob?.jobId === 'string' ? rawJobOrJob.jobId : null;
  const issuerDeviceId = typeof rawJobOrJob?.issuerId === 'string' ? rawJobOrJob.issuerId : null;
  recordAuditEvent({ eventType: 'JOB_REJECTED', jobId, issuerDeviceId, resultSummary: { reason: reasonCode } });
  log('warn', `job rejected: ${reasonCode}`, { jobId });
  return { accepted: false, reason: reasonCode, detail: detail ?? null };
}

// ── Scheduler (mission §29 — simple FIFO, maxConcurrentJobs respected) ────

function processQueue() {
  if (currentState !== 'IDLE' && currentState !== 'WORKING') return;
  if (activeJob) return; // maxConcurrentJobs = 1 in Phase 2 (mission §29 default) — one in-flight job at a time
  if (queue.length === 0) return;

  const settings = getRassilonSettings();
  if (settings.maxConcurrentJobs < 1) return;

  const jobId = queue.shift();
  runJob(jobId);
}

async function runJob(jobId) {
  const jobRow = getRassilonJobById(jobId);
  if (!jobRow) return; // defensive — should be unreachable, queue only ever holds ids just inserted

  const abortController = new AbortController();
  activeJob = { jobId, abortController, startedAt: new Date().toISOString() };
  currentState = 'WORKING';
  updateRassilonJob(jobId, { status: 'RUNNING', started_at: activeJob.startedAt });
  recordAuditEvent({ eventType: 'JOB_STARTED', jobId, issuerDeviceId: jobRow.issuerDeviceId });
  const remoteIssuer = getRassilonDevice(jobRow.issuerDeviceId);
  if (remoteIssuer) recordAuditEvent({ eventType: 'REMOTE_JOB_STARTED', jobId, issuerDeviceId: jobRow.issuerDeviceId });

  // The DB row stores only a bounded summary, not the full replay-able
  // payload (mission §16 architecture report). The actual validated
  // payload was stashed into jobPayloadCache by submitJob() at
  // acceptance time — retrieved and removed here, once, right before use.
  const payload = jobPayloadCache.get(jobId);
  jobPayloadCache.delete(jobId);

  try {
    // workerProviders ({ ollamaClient, embeddingModel }) is forwarded so
    // EMBEDDING_BATCH can reach the local Ollama client injected at
    // initRassilonWorker() time (mission §3/§49 Phase 3) — SAFE_CPU_TASK
    // ignores it entirely, it needs no provider.
    const result = await runJobExecutor(
      { jobType: jobRow.jobType, payload, resourceBudget: jobRow.resourceBudget },
      { externalSignal: abortController.signal, providers: workerProviders },
    );
    updateRassilonJob(jobId, { status: 'COMPLETED', completed_at: new Date().toISOString(), result_summary: JSON.stringify(result) });
    recordAuditEvent({ eventType: 'JOB_COMPLETED', jobId, issuerDeviceId: jobRow.issuerDeviceId });
    if (remoteIssuer) recordAuditEvent({ eventType: 'REMOTE_JOB_COMPLETED', jobId, issuerDeviceId: jobRow.issuerDeviceId });
  } catch (err) {
    if (err instanceof RassilonExecutionError && err.code === 'job_timed_out') {
      updateRassilonJob(jobId, { status: 'FAILED', completed_at: new Date().toISOString(), error_reason: 'job_timed_out' });
      recordAuditEvent({ eventType: 'JOB_FAILED', jobId, issuerDeviceId: jobRow.issuerDeviceId, resultSummary: { reason: 'job_timed_out' } });
      if (remoteIssuer) recordAuditEvent({ eventType: 'REMOTE_JOB_FAILED', jobId, issuerDeviceId: jobRow.issuerDeviceId, resultSummary: { reason: 'job_timed_out' } });
    } else if (err instanceof RassilonExecutionError && err.code === 'job_cancelled') {
      updateRassilonJob(jobId, { status: 'CANCELLED', completed_at: new Date().toISOString(), error_reason: 'cancelled' });
      recordAuditEvent({ eventType: 'JOB_CANCELLED', jobId, issuerDeviceId: jobRow.issuerDeviceId });
      if (remoteIssuer) recordAuditEvent({ eventType: 'REMOTE_JOB_CANCELLED', jobId, issuerDeviceId: jobRow.issuerDeviceId });
    } else if (err instanceof RassilonEmbeddingError) {
      // Mission §40 — provider failure (unavailable/timeout/malformed
      // response/wrong dimensions/empty vectors) must land the JOB as
      // FAILED with a SPECIFIC reason, never a generic 'executor_error'
      // that hides what actually went wrong — and must never itself take
      // down the worker (mission §40 — "Worker doit rester sain sauf
      // erreur système critique", which a provider/network failure is
      // not).
      updateRassilonJob(jobId, { status: 'FAILED', completed_at: new Date().toISOString(), error_reason: err.code });
      recordAuditEvent({ eventType: 'JOB_FAILED', jobId, issuerDeviceId: jobRow.issuerDeviceId, resultSummary: { reason: err.code } });
      if (remoteIssuer) recordAuditEvent({ eventType: 'REMOTE_JOB_FAILED', jobId, issuerDeviceId: jobRow.issuerDeviceId, resultSummary: { reason: err.code } });
      log('warn', `embedding job ${jobId} failed`, { reason: err.code });
    } else {
      updateRassilonJob(jobId, { status: 'FAILED', completed_at: new Date().toISOString(), error_reason: 'executor_error' });
      recordAuditEvent({ eventType: 'JOB_FAILED', jobId, issuerDeviceId: jobRow.issuerDeviceId, resultSummary: { reason: 'executor_error' } });
      if (remoteIssuer) recordAuditEvent({ eventType: 'REMOTE_JOB_FAILED', jobId, issuerDeviceId: jobRow.issuerDeviceId, resultSummary: { reason: 'executor_error' } });
      log('error', `job ${jobId} failed`, { error: err?.message });
    }
  } finally {
    cleanupJobScratchDir(jobId);
    activeJob = null;
    // Only fall back to IDLE if nothing paused/erred the worker WHILE
    // this job was running — a safety-guard auto-pause or a fatal error
    // that occurred mid-execution must not be silently overwritten back
    // to IDLE just because the job itself finished (mission §13/§16:
    // AUTO_PAUSED/ERROR are real states, not transient job-completion
    // side effects).
    if (currentState === 'WORKING') currentState = 'IDLE';
    processQueue();
  }
}

// routes/rassilon.js calls submitJob directly under this alias — kept as
// a separate export name since earlier revisions of this module split
// acceptance/payload-stashing into two steps; submitJob now does both
// itself (the payload is stashed into jobPayloadCache — declared above,
// near runJob — before processQueue() can synchronously consume it).
export { submitJob as submitJobAndEnqueue };

export function getJob(jobId) {
  return getRassilonJobById(jobId);
}

export function listJobs(options) {
  return listRassilonJobs(options);
}

// ── Safety guard loop (mission §6/§11-§13/§27/§28 of the architecture
// report; mission §11/§12/§13 of this phase) ────────────────────────────

// Providers are passed explicitly (defaulting to the real Windows
// probes) rather than imported-and-called directly, specifically so
// tests can inject deterministic AC/battery/idle/active readings without
// depending on real laptop hardware (mission §52/§53 — "provider
// injectable... Ne pas rendre tests dépendants d'un laptop réel"). ESM
// named-import bindings are read-only from the importing module's side
// (can't be monkey-patched via the namespace object), so parameter
// injection is the correct mechanism here, not module mutation.
const RAM_PRESSURE_THRESHOLD_PERCENT = 90;
const ACTIVE_THRESHOLD_MS = 60_000; // machine considered "in active use" if input within the last minute

/**
 * Evaluates whether current conditions justify an automatic pause.
 * Returns a reason string (used both as the AUTO_PAUSED trigger and as
 * the audit resultSummary) or null if everything reads healthy.
 *
 * Idle-probe-failure policy (mission §44): if pauseWhenUserActive=true
 * and the idle reading is UNKNOWN (idleMs === null — probe failed, not
 * "user is away"), this treats that as NOT healthy — conservatively
 * preferring not to start a new intensive job when the user's actual
 * activity state can't be confirmed, rather than defaulting to "assume
 * away" on missing data.
 */
async function evaluateAutoPauseReason(settings, { powerProvider, idleProvider }) {
  if (settings.pauseOnBattery) {
    const power = await powerProvider();
    if (power.status === 'ON_BATTERY') {
      if (power.batteryPercent !== null && power.batteryPercent < settings.minimumBatteryPercent) return 'battery_low';
      return 'on_battery';
    }
  }

  if (settings.pauseWhenUserActive) {
    const idle = await idleProvider();
    if (idle.idleMs === null) return 'user_activity_unknown'; // mission §44 — fail conservative, not fail open
    if (idle.idleMs < ACTIVE_THRESHOLD_MS) return 'user_active';
  }

  const ram = getSystemRamStatus();
  if (ram.available === false) return 'ram_telemetry_unavailable'; // mission §42 — never proceed as if telemetry failure meant "all clear"
  if (ram.usedPercent > RAM_PRESSURE_THRESHOLD_PERCENT) return 'ram_pressure';

  return null;
}

/**
 * Periodic safety-guard sweep (mission §13/§14/§15 Phase 3): evaluates
 * auto-pause conditions, transitions IDLE/WORKING -> AUTO_PAUSED (never
 * touches a manual PAUSED — mission §14: "Manual pause : NE JAMAIS
 * auto-resume", enforced here by simply never being the auto-pause path's
 * target), and auto-resumes AUTO_PAUSED -> IDLE only after
 * AUTO_RESUME_HEALTHY_SWEEPS_REQUIRED consecutive healthy sweeps (mission
 * §15 hysteresis).
 */
async function runSafetyGuardSweep({ powerProvider = detectPowerStatus, idleProvider = detectIdleStatus } = {}) {
  if (currentState === 'DISABLED' || currentState === 'ERROR') return;

  const settings = getRassilonSettings();

  try {
    const pauseReason = await evaluateAutoPauseReason(settings, { powerProvider, idleProvider });

    if (pauseReason) {
      consecutiveHealthySweeps = 0;
      // Mission §14: never overwrite a MANUAL pause, and never re-trigger
      // audit noise if already AUTO_PAUSED for the same sweep.
      if (currentState === 'IDLE' || currentState === 'WORKING') {
        log('info', `auto-pause: ${pauseReason}`);
        currentState = 'AUTO_PAUSED';
        recordAuditEvent({ eventType: 'AUTO_PAUSED', resultSummary: { reason: pauseReason } });
      }
    } else if (currentState === 'AUTO_PAUSED') {
      // Healthy this sweep — count toward the hysteresis requirement
      // before actually resuming (mission §15: avoid oscillation).
      consecutiveHealthySweeps += 1;
      if (consecutiveHealthySweeps >= AUTO_RESUME_HEALTHY_SWEEPS_REQUIRED) {
        log('info', 'auto-resume: conditions healthy');
        currentState = 'IDLE';
        consecutiveHealthySweeps = 0;
        recordAuditEvent({ eventType: 'AUTO_RESUMED' });
        processQueue();
      }
    } else {
      consecutiveHealthySweeps = 0;
    }

    // Mid-execution runtime budget check for the active job (mission §10
    // architecture report — cancel safely, never a voluntary OOM).
    if (activeJob) {
      const jobRow = getRassilonJobById(activeJob.jobId);
      if (jobRow) {
        const budget = jobRow.resourceBudget;
        const runtimeCheck = checkRuntimeBudget({ resourceBudget: budget });
        if (!runtimeCheck.withinBudget) {
          log('warn', `job ${activeJob.jobId} exceeded runtime budget (${runtimeCheck.reason}), cancelling`);
          cancelActiveJob(runtimeCheck.reason);
        }
      }
    }
  } catch (err) {
    // A safety-guard sweep failure is NOT, by itself, a durable internal
    // worker fault (mission §16 — ERROR is for the executor registry/DB/
    // unrecoverable exceptions, not a transient probe hiccup) — logged
    // and the worker stays exactly where it was, re-evaluated next tick.
    log('error', 'safety guard sweep failed', { error: err?.message });
  }
}

function startSafetyGuard() {
  if (safetyGuardTimer) return;
  safetyGuardTimer = setInterval(runSafetyGuardSweep, SAFETY_GUARD_INTERVAL_MS);
  safetyGuardTimer.unref?.(); // never keeps the process alive on its own
}

function stopSafetyGuard() {
  if (safetyGuardTimer) clearInterval(safetyGuardTimer);
  safetyGuardTimer = null;
}

export { runSafetyGuardSweep as __runSafetyGuardSweepForTests };

/**
 * Test-only: forces the worker into ERROR with a synthetic detail, the
 * same shape a real registry-sanity failure would produce, without
 * requiring a test to corrupt the actual shared executor registry
 * (which would leak into every other test file in the same process).
 * Exercises ERROR's BEHAVIOR (submitJob rejection, disable/kill always
 * working, enable() refusing to silently clear it) — the real ERROR
 * TRIGGER (checkExecutorRegistrySanity at boot) is covered separately by
 * asserting the current real registry passes its own sanity check.
 */
export function __forceErrorStateForTests(code = 'simulated_fatal_error', message = 'test-forced error') {
  currentState = 'ERROR';
  errorDetail = { code, message, timestamp: new Date().toISOString() };
}
