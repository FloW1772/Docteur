/**
 * MAÎTRE — orchestrator. Ingestion + correlation + incident creation +
 * ALL read queries + the thin propose/approve/reject/execute passthrough
 * MA-11's route calls. This file is the ONLY thing cortex-server/src/
 * routes/maitre.js imports from the MAÎTRE lib surface — mirrors
 * cyber-orchestrator.js's/monitor-orchestrator.js's own "orchestrator is
 * the only thing a route imports" shape.
 *
 * This file adds NO new capability beyond MA-2→MA-10 (mission §1): every
 * function below is a direct call-through (with bounds/validation
 * already enforced downstream) to an already-certified module — never a
 * reimplementation. Propose/approve/reject/execute are pure
 * passthroughs to maitre-approval.js/maitre-executor.js; this file adds
 * no policy logic, no approval logic, no execution logic of its own
 * (mission §10: "ne doit PAS reproduire la logique de l'executor").
 */
import { ingestObservateurSignals } from './maitre-signal-intake.js';
import { runCorrelation, createIncidentFromCorrelation } from './maitre-correlation.js';
import {
  getIncident, listIncidents, listSecurityEvents, getSecurityEvent, getEvidence, listEvidenceForIncident,
} from './maitre-store.js';
import {
  createActionProposal, getActionProposal, listActionProposalsForIncident,
  createApprovalRequest, approveProposal, rejectProposal,
} from './maitre-approval.js';
import { executeApprovedAction, getActionRun } from './maitre-executor.js';
import { listProcesses, inspectProcess } from './maitre-process-inspector.js';
import { getPersistenceSnapshot } from './maitre-persistence-inspector.js';
import { getDefenderStatus, getDefenderDetections } from './maitre-defender-adapter.js';
import { hostIsolationPreflight, detectActiveIsolationOnStartup, getIsolationState } from './maitre-host-isolation.js';
import { analyzeIncident } from './maitre-analyst.js';
import {
  listMaitreActionRunsForIncident, findActiveMaitreIsolationState,
  listMaitreIsolationStatesForIncident,
} from './sqlite.js';

/**
 * One full pass: pull Observateur signals, run correlation over the
 * resulting (plus any previously ingested) events, and create/reuse
 * incidents for every match. Read/analyze/persist only — no system
 * action, no Ollama, no cloud. Callers (a future scheduler, or a
 * manual trigger) decide the cadence; this file itself has no timer.
 */
export function runIngestionAndCorrelationPass({ correlationWindowMs } = {}) {
  const observateurResults = ingestObservateurSignals();
  const matches = runCorrelation(correlationWindowMs ? { windowMs: correlationWindowMs } : {});
  const incidents = matches.map(createIncidentFromCorrelation);

  return {
    observateurSignalsIngested: observateurResults.length,
    correlationMatches: matches.length,
    incidentsTouched: incidents.length,
    incidents,
  };
}

export function getIncidentDetail(incidentId) {
  const incident = getIncident(incidentId);
  if (!incident) return null;
  const events = incident.eventRefs.map(getSecurityEvent).filter(Boolean);
  const evidence = listEvidenceForIncident(incidentId);
  return { incident, events, evidence };
}

export { listIncidents, listSecurityEvents, getEvidence };

// ── Overview (mission §16) — bounded summary, no secrets ──────────────────

const OVERVIEW_RECENT_EVENTS_LIMIT = 10;
const SEVERITY_RANK = { INFO: 0, OBSERVATION: 1, SUSPICIOUS: 2, HIGH: 3, CRITICAL: 4 };

/**
 * A single bounded read for the Studio Overview tab / Command Center
 * widget: open-incident count, highest active severity, Defender
 * availability, a handful of recent events, pending-approval count, and
 * isolation status. Every sub-call is already bounded/redacted by its
 * own module — this function only aggregates, never widens scope.
 */
export async function getMaitreOverview(opts) {
  const incidents = listIncidents({ limit: 100 });
  const openIncidents = incidents.filter(i => i.status !== 'RESOLVED' && i.status !== 'DISMISSED');
  const highestSeverity = openIncidents.reduce((max, i) => (
    (SEVERITY_RANK[i.severity] ?? 0) > (SEVERITY_RANK[max] ?? -1) ? i.severity : max
  ), null);

  const recentEvents = listSecurityEvents({ limit: OVERVIEW_RECENT_EVENTS_LIMIT });

  const pendingApprovals = incidents
    .flatMap(i => listActionProposalsForIncident(i.id, { limit: 50 }))
    .filter(a => a.status === 'AWAITING_APPROVAL').length;

  const defenderStatus = await getDefenderStatus(opts).catch(() => ({ available: false, reason: 'unavailable' }));
  const isolationState = findActiveMaitreIsolationState();

  return {
    openIncidentCount: openIncidents.length,
    totalIncidentCount: incidents.length,
    highestActiveSeverity: highestSeverity,
    defenderAvailable: !!defenderStatus?.available,
    recentEvents,
    pendingApprovalCount: pendingApprovals,
    isolationStatus: mapIsolationStatus(isolationState),
  };
}

function mapIsolationStatus(state) {
  if (!state) return 'NOT_ISOLATED';
  if (state.status === 'ACTIVE') return 'ISOLATION_ACTIVE';
  if (state.status === 'PARTIAL_FAILURE') return 'PARTIAL_FAILURE';
  if (state.status === 'RESTORING') return 'RESTORE_AVAILABLE';
  return 'NOT_ISOLATED';
}

// ── Isolation status (mission §4/§25) ──────────────────────────────────────

export function getIsolationStatusSummary() {
  const detection = detectActiveIsolationOnStartup();
  if (!detection.isolationActive) return { status: 'NOT_ISOLATED' };
  return {
    status: mapIsolationStatus({ status: detection.status }),
    isolationStateId: detection.isolationStateId,
    actionId: detection.actionId,
    incidentId: detection.incidentId,
    restoreAvailable: detection.restoreAvailable,
  };
}

// ── Processes (mission §20) ─────────────────────────────────────────────
// opts (exec/checkPlatform) forwarded so route/browser tests can inject a
// mock — never touching real PowerShell or a real process (mission §42).

export async function listMaitreProcesses(opts) {
  return listProcesses(opts);
}

export async function inspectMaitreProcess(pid, opts) {
  return inspectProcess(pid, opts);
}

// ── Persistence (mission §22) ──────────────────────────────────────────

export async function getMaitrePersistenceSnapshot(opts) {
  return getPersistenceSnapshot(opts);
}

// ── Defender (mission §23) ─────────────────────────────────────────────

export async function getMaitreDefenderStatus(opts) {
  return getDefenderStatus(opts);
}

export async function getMaitreDefenderDetections(opts) {
  return getDefenderDetections(opts);
}

// ── Actions / approvals / execution — thin passthrough only ───────────────
// (mission §10: this orchestrator adds NO executor logic of its own —
// every function below is a direct call to the already-certified
// MA-7/8/9/10 modules, with no policy/approval/execution reimplemented
// here.)

export function proposeMaitreAction(input) {
  return createActionProposal(input);
}

export function getMaitreActionProposal(actionId) {
  return getActionProposal(actionId);
}

export function listMaitreActionsForIncidentDetail(incidentId, opts) {
  return listActionProposalsForIncident(incidentId, opts);
}

export function requestMaitreApproval(actionId) {
  return createApprovalRequest(actionId);
}

export function approveMaitreAction(approvalId, opts) {
  return approveProposal(approvalId, opts);
}

export function rejectMaitreAction(approvalId, opts) {
  return rejectProposal(approvalId, opts);
}

export async function executeMaitreAction(actionId, opts) {
  return executeApprovedAction(actionId, opts);
}

export function getMaitreActionRunDetail(runId) {
  return getActionRun(runId);
}

export function listMaitreActionRunsForIncidentDetail(incidentId, opts) {
  return listMaitreActionRunsForIncident(incidentId, opts);
}

export function listMaitreIsolationStatesForIncidentDetail(incidentId, opts) {
  return listMaitreIsolationStatesForIncident(incidentId, opts);
}

export function getMaitreIsolationStateDetail(isolationStateId) {
  return getIsolationState(isolationStateId);
}

export async function getMaitreHostIsolationPreflight(opts) {
  return hostIsolationPreflight(opts);
}

// ── Local analyst (MA-6, mission §18) — deterministic or Ollama, never LLM-authoritative on severity ──

export async function analyzeMaitreIncident(incidentId, opts) {
  return analyzeIncident(incidentId, opts);
}
