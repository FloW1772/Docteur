// Dedicated lib file for Observateur (passive monitoring), following the
// same shape as cyber-audit-studio.ts: typed interfaces mirroring the
// backend's already-minimal API output, one generic request wrapper,
// errors always piped through studioRequestError. No direct fetch to
// any other path — every call goes through this file's `base`
// (/api/monitor/...), never an arbitrary/user-supplied URL.
import { studioRequestError } from './studio-errors';

export type MonitorReportMode = 'OFF' | 'ON_EVENTS_ONLY' | 'ON_SUMMARY' | 'ON_DETAILED_REPORTS' | 'ON_ALERTS_ONLY' | 'CUSTOM';
export type MonitorReportFrequency = 'MANUAL' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'ON_EVENT' | 'CUSTOM';
export type MonitorNotifyMode = 'NONE' | 'IMPORTANT_ONLY' | 'ALL_ANOMALIES';
export type MonitorAnomalySeverity = 'OBSERVATION' | 'SUSPICIOUS' | 'REQUIRES_REVIEW';

export interface MonitorSettings {
  enabled: boolean;
  autostart: boolean;
  collectionIntervalMs: number;
  reportMode: MonitorReportMode;
  reportFrequency: MonitorReportFrequency;
  customReportFrequencyMinutes: number;
  retentionDays: number;
  maxHistorySize: number;
  includeProcessMetadata: boolean;
  includeRemoteEndpoints: boolean;
  includeLocalServices: boolean;
  notifyMode: MonitorNotifyMode;
  generateDailySummary: boolean;
  generateWeeklySummary: boolean;
  cloudAiEnabled: boolean;
  ollamaEnabled: boolean;
  paused: boolean;
  lastReportAt: string | null;
}

export interface MonitorOverheadStatus {
  eventsPerMin: number;
  writesPerMin: number;
  avgCycleDurationMs: number;
  degraded: boolean;
}

export interface MonitorStatus {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  mode: MonitorReportMode;
  reportFrequency: MonitorReportFrequency;
  lastReportAt: string | null;
  overhead: MonitorOverheadStatus;
  degraded: boolean;
}

export interface MonitorConnection {
  id: string;
  process_name: string;
  pid: number | null;
  remote_address: string;
  remote_port: number | null;
  local_port: number | null;
  protocol: string;
  state: string | null;
  first_seen: string;
  last_seen: string;
  sample_count: number;
  approx_bytes: number;
  window_bucket: string;
}

export interface MonitorProcess {
  id: string;
  process_name: string;
  pid: number | null;
  first_seen: string;
  last_seen: string;
  connection_count: number;
  distinct_destinations: number;
  window_bucket: string;
}

export interface MonitorAnomaly {
  id: string;
  detected_at: string;
  rule_id: string;
  severity: MonitorAnomalySeverity;
  process_name: string | null;
  remote_address: string | null;
  description: string;
  evidence_ref: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'DISMISSED';
  security_signal: string | null;
}

export interface MonitorReport {
  id: string;
  report_type: 'SUMMARY' | 'DETAILED';
  period_start: string;
  period_end: string;
  mode: string;
  event_count: number;
  anomaly_count: number;
  summary_json: string;
  llm_narrative: string | null;
  created_at: string;
}

const base = `${window.location.protocol}//${window.location.hostname}:3001/api/monitor`;

export async function monitorRequest<T>(suffix = '', body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch(`${base}${suffix}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(studioRequestError(data.error || data.code));
  return data as T;
}

export function getMonitorStatus(): Promise<{ ok: boolean; status: MonitorStatus }> {
  return monitorRequest('/status');
}

export function startMonitor(): Promise<{ ok: boolean; settings: MonitorSettings }> {
  return monitorRequest('/start', {}, 'POST');
}

export function pauseMonitor(): Promise<{ ok: boolean; settings: MonitorSettings }> {
  return monitorRequest('/pause', {}, 'POST');
}

export function resumeMonitor(): Promise<{ ok: boolean; settings: MonitorSettings }> {
  return monitorRequest('/resume', {}, 'POST');
}

export function getMonitorSettings(): Promise<{ ok: boolean; settings: MonitorSettings }> {
  return monitorRequest('/settings');
}

export function putMonitorSettings(updates: Partial<MonitorSettings>): Promise<{ ok: boolean; settings: MonitorSettings }> {
  return monitorRequest('/settings', updates, 'PUT');
}

export function getLiveConnections(sinceMinutes = 30): Promise<{ ok: boolean; connections: MonitorConnection[] }> {
  return monitorRequest(`/connections/live?sinceMinutes=${sinceMinutes}`);
}

export function getMonitorProcesses(sinceMinutes = 60): Promise<{ ok: boolean; processes: MonitorProcess[] }> {
  return monitorRequest(`/processes?sinceMinutes=${sinceMinutes}`);
}

export function getMonitorAnomalies(): Promise<{ ok: boolean; anomalies: MonitorAnomaly[] }> {
  return monitorRequest('/anomalies');
}

export function listMonitorReports(): Promise<{ ok: boolean; reports: MonitorReport[] }> {
  return monitorRequest('/reports');
}

// The report is opened directly by the browser (window.open), not fetched
// as JSON — this just centralizes the URL construction.
export function monitorReportUrl(id: string, format: 'html' | 'json' = 'html'): string {
  return `${base}/reports/${id}?format=${format}`;
}

export const ANOMALY_SEVERITY_ORDER: MonitorAnomalySeverity[] = ['REQUIRES_REVIEW', 'SUSPICIOUS', 'OBSERVATION'];

export function sortAnomaliesBySeverity(anomalies: MonitorAnomaly[]): MonitorAnomaly[] {
  return [...anomalies].sort((a, b) => ANOMALY_SEVERITY_ORDER.indexOf(a.severity) - ANOMALY_SEVERITY_ORDER.indexOf(b.severity));
}
