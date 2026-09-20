/**
 * Observateur passive monitoring — report scheduler. Decides WHEN to
 * generate a report based on reportFrequency; checked once per
 * monitor-service.js tick (no separate cron/timer). No LLM call happens
 * per event — only here, at most once per generated report.
 */
import { getMonitorSettings } from './monitor-config.js';
import { getLastMonitorReport } from './sqlite.js';
import { createReport } from './monitor-report.js';

const FREQUENCY_MS = {
  HOURLY: 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
};

function reportTypeForMode(mode) {
  return mode === 'ON_DETAILED_REPORTS' ? 'DETAILED' : 'SUMMARY';
}

export async function maybeGenerateScheduledReport({ ollamaClient = null, ollamaModel = null } = {}) {
  const settings = getMonitorSettings();
  if (!settings.enabled || settings.paused) return null;
  if (settings.reportFrequency === 'MANUAL' || settings.reportFrequency === 'ON_EVENT') return null;
  if (settings.reportMode === 'OFF') return null;

  const freqMs = settings.reportFrequency === 'CUSTOM'
    ? settings.customReportFrequencyMinutes * 60_000
    : (FREQUENCY_MS[settings.reportFrequency] ?? FREQUENCY_MS.DAILY);

  const last = getLastMonitorReport();
  const lastMs = last ? new Date(last.created_at).getTime() : 0;
  if (Date.now() - lastMs < freqMs) return null;

  const periodEnd = new Date().toISOString();
  const periodStart = new Date(Date.now() - freqMs).toISOString();
  return createReport({
    reportType: reportTypeForMode(settings.reportMode),
    mode: settings.reportMode,
    periodStart,
    periodEnd,
    ollamaClient: settings.ollamaEnabled ? ollamaClient : null,
    ollamaModel,
  });
}

// ON-EVENT mode: called right after an anomaly write (monitor-service.js),
// not on the tick-based schedule above.
export async function maybeGenerateOnEventReport({ ollamaClient = null, ollamaModel = null } = {}) {
  const settings = getMonitorSettings();
  if (!settings.enabled || settings.paused) return null;
  if (settings.reportFrequency !== 'ON_EVENT') return null;

  const periodEnd = new Date().toISOString();
  const periodStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return createReport({
    reportType: reportTypeForMode(settings.reportMode),
    mode: settings.reportMode,
    periodStart,
    periodEnd,
    ollamaClient: settings.ollamaEnabled ? ollamaClient : null,
    ollamaModel,
  });
}
