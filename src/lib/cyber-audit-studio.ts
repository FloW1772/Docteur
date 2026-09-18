// Dedicated lib file for Cyber Audit Studio (SENTINEL V1, CA-8), following
// the same shape as metagpt-studio.ts/investment-studio.ts: typed
// interfaces mirroring the backend's already-minimal API output, one
// generic request wrapper, errors always piped through studioRequestError
// (never a raw backend string surfaced to the UI). No direct fetch to any
// other path — every call goes through this file's `base`, which is the
// server's own semantic route (/api/cyber-audit/missions/...), never an
// arbitrary/user-supplied URL.
import { studioRequestError } from './studio-errors';

export type CyberMissionStatus =
  | 'CREATED' | 'READY' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED' | 'BLOCKED_BY_POLICY';

export type CyberMissionMode = 'PASSIVE' | 'SAFE_ACTIVE';

export interface CyberScopeInput {
  allowedHosts: string[];
  allowedPorts: number[];
  allowedProtocols: Array<'http:' | 'https:'>;
  allowedPaths?: string[];
  excludedPaths?: string[];
  followSubdomains?: boolean;
  maxDepth?: number;
  maxRequests?: number;
  requestsPerSecond?: number;
  timeoutMs?: number;
}

export interface CyberScopeSummary {
  allowedHosts: string[];
  allowedPorts: number[];
  allowedProtocols: string[];
  maxDepth: number;
  maxRequests: number;
}

export interface CyberMission {
  id: string;
  title: string;
  clientName: string;
  status: CyberMissionStatus;
  mode: string;
  createdAt: string;
  updatedAt?: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  lastError: string | null;
  counts: { requests: number; pages: number; findings: number };
  scope: CyberScopeSummary | null;
}

export interface CyberFinding {
  id: string;
  title: string;
  category: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'OPEN' | 'CONFIRMED' | 'FALSE_POSITIVE' | 'ACCEPTED_RISK' | 'RESOLVED';
  asset: string;
  description: string;
  impact: string;
  recommendation: string;
  references: string[];
  evidenceIds: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface CyberEvidence {
  id: string;
  url: string;
  method: string;
  timestamp: string;
  responseStatus: number | null;
  relevantHeaders: Record<string, string | string[]>;
  excerpt: string;
  sha256: string;
}

export interface CyberEvent {
  fromStatus: string | null;
  toStatus: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface CreateMissionInput {
  title: string;
  clientName: string;
  authorizationConfirmed: boolean;
  authorizationReference?: string;
  scope: CyberScopeInput;
  mode?: CyberMissionMode;
}

const base = `${window.location.protocol}//${window.location.hostname}:3001/api/cyber-audit/missions`;

export async function cyberAuditRequest<T>(suffix = '', body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`${base}${suffix}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(studioRequestError(data.error || data.code));
  return data as T;
}

export function listCyberMissions(): Promise<{ ok: boolean; missions: CyberMission[] }> {
  return cyberAuditRequest('');
}

export function getCyberMission(id: string): Promise<{ ok: boolean; mission: CyberMission }> {
  return cyberAuditRequest(`/${id}`);
}

export function createCyberMission(input: CreateMissionInput): Promise<{ ok: boolean; mission: CyberMission }> {
  return cyberAuditRequest('', input, 'POST');
}

export function startCyberMission(id: string): Promise<{ ok: boolean; mission: CyberMission }> {
  return cyberAuditRequest(`/${id}/start`, {}, 'POST');
}

export function cancelCyberMission(id: string): Promise<{ ok: boolean; mission: CyberMission & { alreadyFinished?: boolean } }> {
  return cyberAuditRequest(`/${id}/cancel`, {}, 'POST');
}

export function getCyberFindings(id: string): Promise<{ ok: boolean; findings: CyberFinding[] }> {
  return cyberAuditRequest(`/${id}/findings`);
}

export function getCyberEvidence(id: string, evidenceId: string): Promise<{ ok: boolean; evidence: CyberEvidence }> {
  return cyberAuditRequest(`/${id}/evidence/${evidenceId}`);
}

export function getCyberEvents(id: string): Promise<{ ok: boolean; events: CyberEvent[] }> {
  return cyberAuditRequest(`/${id}/events`);
}

// The report is opened directly by the browser (window.open), not fetched
// as JSON — this just centralizes the URL construction so the modal never
// hand-builds an /api path itself.
export function cyberReportUrl(id: string, format: 'html' | 'json' = 'html'): string {
  return `${base}/${id}/report?format=${format}`;
}

// ---------------------------------------------------------------------
// Pure, deterministic UI-side rules — no network I/O. Mirrors
// metagpt-studio.ts's canApprove/canApply colocated-pure-function
// convention.
// ---------------------------------------------------------------------

const WILDCARD_PATTERN = /\*/;

/** UI-side scope validation mirroring the backend's own denials, so the
 * wizard can refuse obviously-invalid input before ever calling the API
 * (the backend re-validates independently regardless — this is only a
 * faster/friendlier first check, never the actual security boundary). */
export function validateScopeForWizard(scope: CyberScopeInput): string | null {
  if (!scope.allowedHosts || scope.allowedHosts.length === 0) return 'scope_hosts_invalid';
  if (scope.allowedHosts.some(h => WILDCARD_PATTERN.test(h) || h.trim() === '')) return 'scope_wildcard_denied';
  if (!scope.allowedPorts || scope.allowedPorts.length === 0) return 'scope_ports_invalid';
  if (!scope.allowedProtocols || scope.allowedProtocols.length === 0) return 'scope_protocols_invalid';
  return null;
}

export const ALLOWED_CYBER_MODES: CyberMissionMode[] = ['PASSIVE', 'SAFE_ACTIVE'];

export const SEVERITY_ORDER: CyberFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export function sortFindingsBySeverity(findings: CyberFinding[]): CyberFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export type RemediationPriority = 'QUICK_WINS' | 'SHORT_TERM' | 'LONG_TERM';

/** Same explicit rule as the backend report generator (cyber-report.js) —
 * kept identical and documented here so the UI's Remediation view never
 * silently diverges from what the exported report says. */
export function remediationPriority(finding: Pick<CyberFinding, 'severity' | 'confidence'>): RemediationPriority {
  if (['CRITICAL', 'HIGH'].includes(finding.severity) && ['HIGH', 'MEDIUM'].includes(finding.confidence)) return 'QUICK_WINS';
  if (finding.severity === 'MEDIUM' || (finding.severity === 'HIGH' && finding.confidence === 'LOW')) return 'SHORT_TERM';
  return 'LONG_TERM';
}
