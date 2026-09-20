/**
 * Observateur passive monitoring — orchestrator. The ONLY module
 * monitor.js (the route) is allowed to call. Wires
 * monitor-service.js (scheduler/lifecycle) + monitor-config.js +
 * sqlite.js read helpers together, mirroring cyber-orchestrator.js's
 * "route delegates only to orchestrator" discipline.
 */
import { getMonitorSettings, updateMonitorSettings } from './monitor-config.js';
import { getOverheadStatus } from './monitor-performance-guard.js';
import {
  pauseMonitorService, resumeMonitorService, isMonitorServiceRunning,
} from './monitor-service.js';
import {
  getLiveMonitorConnections, getMonitorProcesses, getMonitorAnomalies,
  getMonitorReports, getMonitorReportById, getLastMonitorReport,
} from './sqlite.js';
import { generateMonitorReport } from './monitor-report.js';

export function getStatus() {
  const settings = getMonitorSettings();
  const overhead = getOverheadStatus();
  const lastReport = getLastMonitorReport();
  return {
    enabled: settings.enabled,
    paused: settings.paused,
    running: isMonitorServiceRunning(),
    mode: settings.reportMode,
    reportFrequency: settings.reportFrequency,
    lastReportAt: lastReport?.created_at ?? null,
    overhead,
    degraded: overhead.degraded,
  };
}

export function startMonitoring() {
  return updateMonitorSettings({ enabled: true, paused: false });
}

export function pauseMonitoring() {
  const settings = updateMonitorSettings({ paused: true });
  pauseMonitorService();
  return settings;
}

export function resumeMonitoring() {
  const settings = updateMonitorSettings({ paused: false });
  resumeMonitorService();
  return settings;
}

export function getSettings() {
  return getMonitorSettings();
}

export function putSettings(updates) {
  return updateMonitorSettings(updates);
}

export function getLiveConnections({ sinceMinutes = 30, limit = 500 } = {}) {
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  return getLiveMonitorConnections(since, limit);
}

export function getProcesses({ sinceMinutes = 60, limit = 500 } = {}) {
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  return getMonitorProcesses(since, limit);
}

export function getAnomalies({ limit = 200 } = {}) {
  return getMonitorAnomalies(limit);
}

export function listReports({ limit = 100 } = {}) {
  return getMonitorReports(limit);
}

export function getReport(id, format = 'html') {
  const report = getMonitorReportById(id);
  if (!report) return null;
  return generateMonitorReport(report, format);
}

export function generateManualReport(reportType = 'SUMMARY') {
  return generateMonitorReport(null, 'json', { reportType, manual: true });
}
