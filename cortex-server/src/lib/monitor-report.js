/**
 * Observateur passive monitoring — report generator. Mirrors
 * cyber-report.js: a pure function over already-persisted data,
 * HTML-escaped, no <script>, SUMMARY/DETAILED variants, format=html|json.
 *
 * The optional Ollama narrative step runs ONLY here, ONLY at report
 * generation time (never per event), ONLY on the already-aggregated
 * summary (never raw connection-by-connection data or anything the
 * privacy guard already stripped), and NEVER decides severity — every
 * anomaly's severity was already assigned by monitor-anomaly.js before
 * this file ever runs. A failed/slow/unavailable Ollama call must never
 * block report persistence — llm_narrative simply stays null.
 */
import crypto from 'node:crypto';
import { chatCompletion } from './ollama.js';
import {
  getLiveMonitorConnections, getMonitorProcesses, getMonitorAnomalies,
  insertMonitorReport,
} from './sqlite.js';

const OLLAMA_TIMEOUT_MS = 8_000;

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSummaryData({ periodStart, periodEnd }) {
  const connections = getLiveMonitorConnections(periodStart, 5_000).filter(c => c.last_seen <= periodEnd);
  const processes = getMonitorProcesses(periodStart, 5_000).filter(p => p.last_seen <= periodEnd);
  const anomalies = getMonitorAnomalies(500).filter(a => a.detected_at >= periodStart && a.detected_at <= periodEnd);

  const topApps = [...processes]
    .sort((a, b) => b.connection_count - a.connection_count)
    .slice(0, 10)
    .map(p => ({ processName: p.process_name, connectionCount: p.connection_count }));

  const newDestinations = [...new Set(connections.map(c => c.remote_address))].slice(0, 20);

  return {
    connectionCount: connections.length,
    processCount: processes.length,
    topApps,
    newDestinations,
    anomalyCount: anomalies.length,
    anomalies,
    connections,
    processes,
  };
}

async function buildNarrative(ollamaClient, model, summary) {
  if (!ollamaClient || !model) return null;
  try {
    const prompt = `Résume en 3-4 phrases, en français, cette activité réseau observée passivement (métadonnées uniquement) : ${summary.connectionCount} connexions, ${summary.processCount} applications, ${summary.anomalyCount} anomalies détectées. Applications principales: ${summary.topApps.map(a => a.processName).join(', ')}. Ne déclare jamais qu'il s'agit d'une attaque confirmée ou d'un malware — reste descriptif.`;
    const withTimeout = Promise.race([
      chatCompletion(ollamaClient, model, [{ role: 'user', content: prompt }]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ollama_timeout')), OLLAMA_TIMEOUT_MS)),
    ]);
    const result = await withTimeout;
    return typeof result === 'string' ? result : (result?.content ?? null);
  } catch {
    return null; // Ollama unavailable/slow/erroring — narrative stays null, report still generates
  }
}

function renderHtml({ reportType, periodStart, periodEnd, summary, narrative }) {
  const anomalyRows = summary.anomalies.map(a => `
    <tr>
      <td>${escapeHtml(a.detected_at)}</td>
      <td>${escapeHtml(a.severity)}</td>
      <td>${escapeHtml(a.process_name)}</td>
      <td>${escapeHtml(a.remote_address)}</td>
      <td>${escapeHtml(a.description)}</td>
    </tr>`).join('');

  const detailSections = reportType === 'DETAILED' ? `
    <h2>Chronologie</h2>
    <table><thead><tr><th>Première apparition</th><th>Dernière activité</th><th>Application</th><th>Destination</th><th>Port</th><th>Protocole</th></tr></thead><tbody>
      ${summary.connections.slice(0, 200).map(c => `
        <tr>
          <td>${escapeHtml(c.first_seen)}</td>
          <td>${escapeHtml(c.last_seen)}</td>
          <td>${escapeHtml(c.process_name)}</td>
          <td>${escapeHtml(c.remote_address)}</td>
          <td>${escapeHtml(c.remote_port)}</td>
          <td>${escapeHtml(c.protocol)}</td>
        </tr>`).join('')}
    </tbody></table>` : '';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Rapport Observateur — ${escapeHtml(reportType)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.85rem; }
  th { background: #f0f0f0; }
  .meta { color: #555; font-size: 0.9rem; }
</style>
</head><body>
  <h1>Observateur — Rapport ${escapeHtml(reportType)}</h1>
  <p class="meta">Période : ${escapeHtml(periodStart)} → ${escapeHtml(periodEnd)}</p>
  <h2>Résumé</h2>
  <ul>
    <li>Connexions observées : ${summary.connectionCount}</li>
    <li>Applications observées : ${summary.processCount}</li>
    <li>Anomalies : ${summary.anomalyCount}</li>
    <li>Nouvelles destinations : ${escapeHtml(summary.newDestinations.join(', ') || 'aucune')}</li>
  </ul>
  ${narrative ? `<h2>Synthèse (Ollama, informative uniquement)</h2><p>${escapeHtml(narrative)}</p>` : ''}
  <h2>Anomalies</h2>
  <table><thead><tr><th>Détecté</th><th>Sévérité</th><th>Application</th><th>Destination</th><th>Description</th></tr></thead>
  <tbody>${anomalyRows || '<tr><td colspan="5">Aucune anomalie sur la période.</td></tr>'}</tbody></table>
  ${detailSections}
</body></html>`;
}

export async function createReport({ reportType, mode, periodStart, periodEnd, ollamaClient = null, ollamaModel = null }) {
  const summary = buildSummaryData({ periodStart, periodEnd });
  const narrative = await buildNarrative(ollamaClient, ollamaModel, summary);

  const row = {
    id: crypto.randomUUID(),
    report_type: reportType,
    period_start: periodStart,
    period_end: periodEnd,
    mode,
    event_count: summary.connectionCount,
    anomaly_count: summary.anomalyCount,
    summary_json: JSON.stringify({
      connectionCount: summary.connectionCount,
      processCount: summary.processCount,
      topApps: summary.topApps,
      newDestinations: summary.newDestinations,
      anomalyCount: summary.anomalyCount,
    }),
    llm_narrative: narrative,
    created_at: new Date().toISOString(),
  };
  insertMonitorReport(row);
  return row;
}

export function generateMonitorReport(reportRow, format = 'html', overrides = {}) {
  if (!reportRow && !overrides.manual) return null;
  const reportType = reportRow?.report_type ?? overrides.reportType ?? 'SUMMARY';
  const periodStart = reportRow?.period_start ?? new Date(Date.now() - 86_400_000).toISOString();
  const periodEnd = reportRow?.period_end ?? new Date().toISOString();
  const summary = reportRow ? JSON.parse(reportRow.summary_json) : buildSummaryData({ periodStart, periodEnd });
  const fullSummary = reportRow ? { ...summary, anomalies: getMonitorAnomalies(500), connections: getLiveMonitorConnections(periodStart, 5000) } : summary;

  if (format === 'json') {
    return { format: 'json', content: JSON.stringify({ reportType, periodStart, periodEnd, ...summary, narrative: reportRow?.llm_narrative ?? null }) };
  }
  return { format: 'html', content: renderHtml({ reportType, periodStart, periodEnd, summary: fullSummary, narrative: reportRow?.llm_narrative ?? null }) };
}
