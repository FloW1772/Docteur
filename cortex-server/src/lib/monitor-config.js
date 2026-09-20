/**
 * Observateur passive monitoring — settings. Same convention as
 * inbox-watcher.js's getInboxSettings/updateInboxSettings: a single JSON
 * blob under one meta key, server-side enum validation on every write
 * (never trust a client-sent enum value).
 */
import { getMeta, setMeta } from './sqlite.js';

const META_KEY = 'monitor_settings';

export const REPORT_MODES = ['OFF', 'ON_EVENTS_ONLY', 'ON_SUMMARY', 'ON_DETAILED_REPORTS', 'ON_ALERTS_ONLY', 'CUSTOM'];
export const REPORT_FREQUENCIES = ['MANUAL', 'HOURLY', 'DAILY', 'WEEKLY', 'ON_EVENT', 'CUSTOM'];
export const NOTIFY_MODES = ['NONE', 'IMPORTANT_ONLY', 'ALL_ANOMALIES'];

const DEFAULTS = Object.freeze({
  enabled: false,
  autostart: false,
  collectionIntervalMs: 10_000,
  reportMode: 'ON_SUMMARY',
  reportFrequency: 'DAILY',
  customReportFrequencyMinutes: 60,
  retentionDays: 7,
  maxHistorySize: 50_000,
  includeProcessMetadata: true,
  includeRemoteEndpoints: true,
  includeLocalServices: true,
  notifyMode: 'IMPORTANT_ONLY',
  generateDailySummary: true,
  generateWeeklySummary: false,
  cloudAiEnabled: false,
  ollamaEnabled: true,
  paused: false,
  lastReportAt: null,
});

function sanitize(settings) {
  const s = { ...settings };
  if (!REPORT_MODES.includes(s.reportMode)) s.reportMode = DEFAULTS.reportMode;
  if (!REPORT_FREQUENCIES.includes(s.reportFrequency)) s.reportFrequency = DEFAULTS.reportFrequency;
  if (!NOTIFY_MODES.includes(s.notifyMode)) s.notifyMode = DEFAULTS.notifyMode;
  const clamp = (value, fallback, min, max) => {
    const n = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
  };
  s.collectionIntervalMs = clamp(s.collectionIntervalMs, DEFAULTS.collectionIntervalMs, 2_000, 300_000);
  s.retentionDays = clamp(s.retentionDays, DEFAULTS.retentionDays, 1, 30);
  s.maxHistorySize = clamp(s.maxHistorySize, DEFAULTS.maxHistorySize, 1_000, 500_000);
  s.customReportFrequencyMinutes = clamp(s.customReportFrequencyMinutes, DEFAULTS.customReportFrequencyMinutes, 5, 10_080);
  s.enabled = Boolean(s.enabled);
  s.autostart = Boolean(s.autostart);
  s.includeProcessMetadata = Boolean(s.includeProcessMetadata);
  s.includeRemoteEndpoints = Boolean(s.includeRemoteEndpoints);
  s.includeLocalServices = Boolean(s.includeLocalServices);
  s.generateDailySummary = Boolean(s.generateDailySummary);
  s.generateWeeklySummary = Boolean(s.generateWeeklySummary);
  // Cloud AI defaults OFF and V1 implements no send path — never trust a
  // client PUT to silently flip this without the rest of the wiring
  // existing; kept settable so the config field exists for future use,
  // per the mission's "config field exists, cloud send not implemented"
  // scope, but still coerced to a boolean, never left as arbitrary JSON.
  s.cloudAiEnabled = Boolean(s.cloudAiEnabled);
  s.ollamaEnabled = Boolean(s.ollamaEnabled);
  s.paused = Boolean(s.paused);
  return s;
}

export function getMonitorSettings() {
  const raw = getMeta(META_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    return sanitize({ ...DEFAULTS, ...raw });
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateMonitorSettings(updates) {
  const merged = sanitize({ ...getMonitorSettings(), ...updates });
  setMeta(META_KEY, merged);
  return merged;
}
