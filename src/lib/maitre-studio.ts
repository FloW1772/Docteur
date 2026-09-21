// Dedicated lib file for MAÎTRE (MA-11), following the same shape as
// monitor-studio.ts/cyber-audit-studio.ts: typed interfaces mirroring
// the backend's already-bounded/redacted API output, one generic
// request wrapper, errors always piped through studioRequestError. No
// direct fetch to any other path — every call goes through this file's
// `base` (/api/maitre/...), never an arbitrary/user-supplied URL.
//
// This file NEVER exposes a way to send a client-chosen action level,
// an "approved"/"verified" flag, or a raw command — proposeAction()'s
// input shape mirrors maitre-actions.js's per-type target schemas
// exactly; the backend is always the trust boundary (mission §11).
import { studioRequestError } from './studio-errors';

export type MaitreSeverity = 'INFO' | 'OBSERVATION' | 'SUSPICIOUS' | 'HIGH' | 'CRITICAL';
export type MaitreIncidentStatus = 'OPEN' | 'INVESTIGATING' | 'AWAITING_APPROVAL' | 'CONTAINED' | 'RESOLVED' | 'DISMISSED';
export type MaitreConfidence = 'low' | 'medium' | 'high';
export type MaitreActionStatus = 'PROPOSED' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'READY' | 'CONSUMED';
export type MaitreActionLevel = 1 | 2 | 3;
export type MaitreActionType =
  | 'SCAN_WITH_DEFENDER' | 'COLLECT_EVIDENCE'
  | 'TERMINATE_PROCESS' | 'QUARANTINE_WITH_DEFENDER' | 'BLOCK_REMOTE_IP' | 'DISABLE_PERSISTENCE_ENTRY'
  | 'HOST_ISOLATION' | 'RESTORE_HOST_NETWORK';
export type MaitreRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NOT_SUPPORTED' | 'PARTIAL_FAILURE' | 'MANUAL_REVIEW';
export type MaitreIsolationStatus = 'NOT_ISOLATED' | 'ISOLATION_ACTIVE' | 'PARTIAL_FAILURE' | 'RESTORE_AVAILABLE' | 'MANUAL_REVIEW';
export type MaitreProcessCriticality = 'NORMAL' | 'SYSTEM_CRITICAL' | 'DOCTEUR_CRITICAL';
export type MaitreAnalystSource = 'DETERMINISTIC' | 'OLLAMA_LOCAL';

export interface MaitreSecurityEvent {
  id: string;
  incidentId: string | null;
  source: string;
  category: string;
  severity: MaitreSeverity;
  confidence: MaitreConfidence;
  subject: Record<string, unknown>;
  metadata: Record<string, unknown>;
  detectorId: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface MaitreEvidence {
  id: string;
  incidentId: string;
  type: string;
  source: string;
  sha256: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MaitreIncident {
  id: string;
  title: string;
  summary: string;
  severity: MaitreSeverity;
  status: MaitreIncidentStatus;
  eventRefs: string[];
  evidenceRefs: string[];
  timeline: { at: string; type: string; ruleId?: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export interface MaitreActionProposal {
  id: string;
  createdAt: string;
  updatedAt: string;
  incidentId: string;
  actionType: MaitreActionType;
  level: MaitreActionLevel;
  target: Record<string, unknown>;
  parameters: Record<string, unknown>;
  reason: string;
  evidenceRefs: string[];
  status: MaitreActionStatus;
  proposalHash: string;
  policyResult: { decision: 'ALLOW' | 'CONFIRM' | 'DENY'; reasonCode: string; requirements?: string[]; riskLevel?: string };
  expiresAt: string | null;
}

export interface MaitreApproval {
  id: string;
  createdAt: string;
  actionId: string;
  incidentId: string;
  actionType: MaitreActionType;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED';
  approvedAt: string | null;
  consumedAt: string | null;
  expiresAt: string;
}

export interface MaitreActionRun {
  actionId: string;
  actionType: MaitreActionType;
  status: MaitreRunStatus;
  startedAt: string;
  finishedAt: string | null;
  result: Record<string, unknown>;
  error: string | null;
}

export interface MaitreIncidentDetail {
  incident: MaitreIncident;
  events: MaitreSecurityEvent[];
  evidence: MaitreEvidence[];
  actions: MaitreActionProposal[];
  actionRuns: MaitreActionRun[];
}

export interface MaitreOverview {
  openIncidentCount: number;
  totalIncidentCount: number;
  highestActiveSeverity: MaitreSeverity | null;
  defenderAvailable: boolean;
  recentEvents: MaitreSecurityEvent[];
  pendingApprovalCount: number;
  isolationStatus: MaitreIsolationStatus;
}

export interface MaitreProcess {
  pid: number;
  name: string;
  executablePath: string | null;
  parentPid: number | null;
  startTime: string | null;
  criticality: MaitreProcessCriticality;
  signature?: string | null;
  sha256?: string | null;
}

export interface MaitreDefenderStatus {
  available: boolean;
  antivirusEnabled?: boolean;
  realTimeProtectionEnabled?: boolean;
  signatureAge?: number | null;
  reason?: string;
}

export interface MaitreDefenderDetection {
  threatName: string;
  severity: string | null;
  detectedAt: string | null;
  path: string | null;
  actionTaken: string | null;
}

export interface MaitrePersistenceItem {
  id: string;
  type: 'REGISTRY_RUN' | 'REGISTRY_RUNONCE' | 'STARTUP_FILE' | 'SCHEDULED_TASK' | 'AUTO_START_SERVICE';
  scope: string;
  name: string;
  target: string;
  sourceLocation?: string;
  changeStatus?: 'NEW' | 'CHANGED' | 'REMOVED' | 'UNCHANGED';
}

export interface MaitreIsolationStatusSummary {
  status: MaitreIsolationStatus;
  isolationStateId?: string;
  actionId?: string;
  incidentId?: string;
  restoreAvailable?: boolean;
}

export interface MaitreAnalystResult {
  result: {
    summary: string;
    observedFacts: string[];
    hypotheses: string[];
    unknowns: string[];
    reviewSuggestions: string[];
    confidence: number;
  };
  provenance: { source: MaitreAnalystSource; model: string | null; generatedAt: string; incidentId: string };
}

const base = `${window.location.protocol}//${window.location.hostname}:3001/api/maitre`;

export async function maitreRequest<T>(suffix = '', body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`${base}${suffix}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(studioRequestError(data.error || data.code));
  return data as T;
}

export function getMaitreOverview(): Promise<{ ok: boolean; overview: MaitreOverview }> {
  return maitreRequest('/overview');
}

export function listMaitreIncidents(opts: { limit?: number; offset?: number; status?: MaitreIncidentStatus } = {}): Promise<{ ok: boolean; incidents: MaitreIncident[] }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  return maitreRequest(`/incidents${qs ? `?${qs}` : ''}`);
}

export function getMaitreIncidentDetail(id: string): Promise<{ ok: boolean } & MaitreIncidentDetail> {
  return maitreRequest(`/incidents/${encodeURIComponent(id)}`);
}

export function analyzeMaitreIncident(id: string): Promise<{ ok: boolean } & MaitreAnalystResult> {
  return maitreRequest(`/incidents/${encodeURIComponent(id)}/analyze`, {}, 'POST');
}

export function listMaitreEvents(opts: { limit?: number; offset?: number; incidentId?: string } = {}): Promise<{ ok: boolean; events: MaitreSecurityEvent[] }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.incidentId) params.set('incidentId', opts.incidentId);
  const qs = params.toString();
  return maitreRequest(`/events${qs ? `?${qs}` : ''}`);
}

export function getMaitreEvidence(id: string): Promise<{ ok: boolean; evidence: MaitreEvidence }> {
  return maitreRequest(`/evidence/${encodeURIComponent(id)}`);
}

export function listMaitreProcesses(): Promise<{ ok: boolean; processes?: MaitreProcess[]; available?: boolean; reason?: string }> {
  return maitreRequest('/processes');
}

export function inspectMaitreProcess(pid: number): Promise<{ ok: boolean; available: boolean; process?: MaitreProcess; reason?: string }> {
  return maitreRequest(`/processes/${pid}`);
}

export function getMaitrePersistence(): Promise<{ ok: boolean; items: MaitrePersistenceItem[]; sourceAvailability?: Record<string, boolean> }> {
  return maitreRequest('/persistence');
}

export function getMaitreDefenderStatus(): Promise<{ ok: boolean; status: MaitreDefenderStatus }> {
  return maitreRequest('/defender/status');
}

export function getMaitreDefenderDetections(): Promise<{ ok: boolean; detections: MaitreDefenderDetection[] }> {
  return maitreRequest('/defender/detections');
}

export function getMaitreIsolationStatus(): Promise<{ ok: boolean } & MaitreIsolationStatusSummary> {
  return maitreRequest('/isolation/status');
}

// ── Action workflow: PROPOSE → POLICY → APPROVAL → EXECUTE ────────────────
// This file never lets a caller supply `level`/`status`/`proposalHash` —
// only actionType/target/parameters/reason/incidentId are accepted, and
// even if a caller passed extra fields the backend ignores/rejects them.

export interface MaitreProposeActionInput {
  incidentId: string;
  actionType: MaitreActionType;
  target: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  reason?: string;
  evidenceRefs?: string[];
}

export function proposeMaitreAction(input: MaitreProposeActionInput): Promise<{ ok: boolean; proposal: MaitreActionProposal }> {
  return maitreRequest('/actions/propose', input, 'POST');
}

export function getMaitreAction(id: string): Promise<{ ok: boolean; action: MaitreActionProposal }> {
  return maitreRequest(`/actions/${encodeURIComponent(id)}`);
}

export function requestMaitreApproval(actionId: string): Promise<{ ok: boolean; approval: MaitreApproval }> {
  return maitreRequest(`/actions/${encodeURIComponent(actionId)}/request-approval`, {}, 'POST');
}

/**
 * strengthenedConfirmation must be an explicit `true` the caller passes
 * only after a distinct, deliberate UI confirmation step (mission §9) —
 * this function does not infer it from anything; the caller (the
 * Studio's confirmation dialog) is responsible for only ever passing
 * `true` when the user has actively confirmed, never on modal-open,
 * hover, or a prior unrelated confirmation.
 */
export function approveMaitreAction(approvalId: string, strengthenedConfirmation = false): Promise<{ ok: boolean; approval: MaitreApproval }> {
  return maitreRequest(`/actions/${encodeURIComponent(approvalId)}/approve`, { strengthenedConfirmation }, 'POST');
}

export function rejectMaitreAction(approvalId: string, reason = ''): Promise<{ ok: boolean; approval: MaitreApproval }> {
  return maitreRequest(`/actions/${encodeURIComponent(approvalId)}/reject`, { reason }, 'POST');
}

export function executeMaitreAction(actionId: string, approvalId?: string): Promise<{ ok: boolean; run: MaitreActionRun }> {
  return maitreRequest(`/actions/${encodeURIComponent(actionId)}/execute`, { approvalId: approvalId ?? null }, 'POST');
}

export function getMaitreActionRun(runId: string): Promise<{ ok: boolean; run: MaitreActionRun }> {
  return maitreRequest(`/actions/runs/${encodeURIComponent(runId)}`);
}

// ── Display helpers ─────────────────────────────────────────────────────

export const SEVERITY_ORDER: MaitreSeverity[] = ['CRITICAL', 'HIGH', 'SUSPICIOUS', 'OBSERVATION', 'INFO'];

export function sortIncidentsBySeverity(incidents: MaitreIncident[]): MaitreIncident[] {
  return [...incidents].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}
