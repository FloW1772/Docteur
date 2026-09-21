// Observateur Studio — unifies passive local monitoring (network
// connections + processes, metadata only) with the existing Web Audit
// (formerly "Cyber Audit / SENTINEL", unchanged behavior, embedded here
// via CyberAuditStudioModal's `bare` mode). Observateur is surveillance
// and visibility — not an antivirus, not a remediation engine. No tab
// here ever blocks a process, quarantines anything, or modifies the
// system; a REQUIRES_REVIEW anomaly only ever offers an inert "OPEN IN
// MAITRE" placeholder (MAITRE does not exist yet).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, ShieldCheck, Pause, Play } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import StudioTabs from '../studio/StudioTabs';
import StudioStatus, { type StudioStatusTone } from '../studio/StudioStatus';
import StudioEmptyState from '../studio/StudioEmptyState';
import CyberAuditStudioModal from './CyberAuditStudioModal';
import {
  type MonitorStatus, type MonitorSettings, type MonitorConnection, type MonitorProcess,
  type MonitorAnomaly, type MonitorReport, type MonitorAnomalySeverity,
  getMonitorStatus, startMonitor, pauseMonitor, resumeMonitor,
  getMonitorSettings as fetchMonitorSettings, putMonitorSettings,
  getLiveConnections, getMonitorProcesses, getMonitorAnomalies, listMonitorReports, monitorReportUrl,
  sortAnomaliesBySeverity,
} from '../../lib/monitor-studio';

interface Props {
  onClose: () => void;
  initialTab?: Tab;
  /** Opens MAÎTRE Studio for deeper review of a REQUIRES_REVIEW anomaly
   * (MA-11) — Observateur itself never analyzes or acts on the anomaly
   * beyond detecting/classifying it. */
  onOpenMaitre?: () => void;
}

type Tab = 'OVERVIEW' | 'LIVE' | 'NETWORK' | 'APPLICATIONS' | 'ANOMALIES' | 'REPORTS' | 'WEB AUDIT' | 'HISTORY' | 'SETTINGS';
const TABS: readonly Tab[] = ['OVERVIEW', 'LIVE', 'NETWORK', 'APPLICATIONS', 'ANOMALIES', 'REPORTS', 'WEB AUDIT', 'HISTORY', 'SETTINGS'];

const SEVERITY_TONE: Record<MonitorAnomalySeverity, StudioStatusTone> = {
  OBSERVATION: 'neutral', SUSPICIOUS: 'warning', REQUIRES_REVIEW: 'error',
};
const SEVERITY_LABEL: Record<MonitorAnomalySeverity, string> = {
  OBSERVATION: 'Observation', SUSPICIOUS: 'Suspect', REQUIRES_REVIEW: 'À examiner',
};

const REPORT_MODE_LABEL: Record<MonitorSettings['reportMode'], string> = {
  OFF: 'Désactivé', ON_EVENTS_ONLY: 'Événements uniquement', ON_SUMMARY: 'Résumés',
  ON_DETAILED_REPORTS: 'Rapports détaillés', ON_ALERTS_ONLY: 'Alertes uniquement', CUSTOM: 'Personnalisé',
};

const POLL_MS = 10_000; // slower than the backend's own collection interval — the UI never re-renders per packet, the backend already aggregates

export default function ObservateurStudioModal({ onClose, initialTab = 'OVERVIEW', onOpenMaitre }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [settings, setSettings] = useState<MonitorSettings | null>(null);
  const [connections, setConnections] = useState<MonitorConnection[]>([]);
  const [processes, setProcesses] = useState<MonitorProcess[]>([]);
  const [anomalies, setAnomalies] = useState<MonitorAnomaly[]>([]);
  const [reports, setReports] = useState<MonitorReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const [{ status: s }, { settings: st }] = await Promise.all([getMonitorStatus(), fetchMonitorSettings()]);
      setStatus(s);
      setSettings(st);
    } catch (e) { setError((e as Error).message); }
  }, []);

  const refreshData = useCallback(async () => {
    try {
      const [conn, proc, anom, rep] = await Promise.all([
        getLiveConnections(30), getMonitorProcesses(60), getMonitorAnomalies(), listMonitorReports(),
      ]);
      setConnections(conn.connections);
      setProcesses(proc.processes);
      setAnomalies(sortAnomaliesBySeverity(anom.anomalies));
      setReports(rep.reports);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void refreshStatus(); void refreshData(); }, [refreshStatus, refreshData]);

  useEffect(() => {
    const id = setInterval(() => { void refreshStatus(); void refreshData(); }, POLL_MS);
    return () => clearInterval(id);
  }, [refreshStatus, refreshData]);

  const handleStart = useCallback(async () => {
    setPending(true); setError(null);
    try { await startMonitor(); await refreshStatus(); } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }, [refreshStatus]);

  const handlePause = useCallback(async () => {
    setPending(true); setError(null);
    try { await pauseMonitor(); await refreshStatus(); } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }, [refreshStatus]);

  const handleResume = useCallback(async () => {
    setPending(true); setError(null);
    try { await resumeMonitor(); await refreshStatus(); } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }, [refreshStatus]);

  const handleSettingsChange = useCallback(async (updates: Partial<MonitorSettings>) => {
    setPending(true); setError(null);
    try {
      const { settings: st } = await putMonitorSettings(updates);
      setSettings(st);
      await refreshStatus();
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }, [refreshStatus]);

  const anomalyCounts = useMemo(() => ({
    ANOMALIES: anomalies.filter(a => a.status === 'OPEN').length || undefined,
  }), [anomalies]);

  return (
    <StudioShell
      icon={<Eye size={20} />}
      title="Observateur"
      onClose={onClose}
      subtitle="Surveillance et visibilité — pas un antivirus, pas un moteur de remédiation. Métadonnées uniquement, jamais de contenu de communication."
    >
      {error && <p className="studio-error" role="alert">{error}</p>}

      <div className="studio-filter-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StudioStatus
            label={status?.paused ? 'En pause' : status?.enabled ? 'Actif' : 'Arrêté'}
            tone={status?.paused ? 'warning' : status?.enabled ? 'success' : 'neutral'}
          />
          {status?.degraded && <StudioStatus label="MONITORING DEGRADED" tone="error" />}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!status?.enabled && (
            <button type="button" className="studio-button studio-button--primary" onClick={handleStart} disabled={pending}>
              <Play size={14} /> Démarrer
            </button>
          )}
          {status?.enabled && !status?.paused && (
            <button type="button" className="studio-button" onClick={handlePause} disabled={pending}>
              <Pause size={14} /> Pause
            </button>
          )}
          {status?.enabled && status?.paused && (
            <button type="button" className="studio-button studio-button--primary" onClick={handleResume} disabled={pending}>
              <Play size={14} /> Reprendre
            </button>
          )}
        </div>
      </div>

      <StudioTabs tabs={TABS} active={tab} onChange={setTab} badges={anomalyCounts} />

      {tab === 'OVERVIEW' && <OverviewTab status={status} connections={connections} processes={processes} anomalies={anomalies} reports={reports} />}
      {tab === 'LIVE' && <LiveTab connections={connections} />}
      {tab === 'NETWORK' && <NetworkTab connections={connections} />}
      {tab === 'APPLICATIONS' && <ApplicationsTab processes={processes} />}
      {tab === 'ANOMALIES' && <AnomaliesTab anomalies={anomalies} onOpenMaitre={onOpenMaitre} />}
      {tab === 'REPORTS' && <ReportsTab reports={reports} />}
      {tab === 'WEB AUDIT' && <CyberAuditStudioModal bare onClose={onClose} />}
      {tab === 'HISTORY' && <HistoryTab connections={connections} processes={processes} />}
      {tab === 'SETTINGS' && settings && (
        <SettingsTab settings={settings} onChange={handleSettingsChange} pending={pending} />
      )}
    </StudioShell>
  );
}

// ---------------------------------------------------------------------

function OverviewTab({ status, connections, processes, anomalies, reports }: {
  status: MonitorStatus | null; connections: MonitorConnection[]; processes: MonitorProcess[];
  anomalies: MonitorAnomaly[]; reports: MonitorReport[];
}) {
  const lastReport = reports[0];
  return (
    <div className="studio-grid">
      <div className="studio-card"><h4>Mode</h4><p>{status ? REPORT_MODE_LABEL[status.mode] : '—'}</p></div>
      <div className="studio-card"><h4>Dernier rapport</h4><p>{lastReport ? new Date(lastReport.created_at).toLocaleString('fr-FR') : 'Aucun'}</p></div>
      <div className="studio-card"><h4>Connexions observées</h4><p>{connections.length}</p></div>
      <div className="studio-card"><h4>Applications observées</h4><p>{processes.length}</p></div>
      <div className="studio-card"><h4>Anomalies en cours</h4><p>{anomalies.filter(a => a.status === 'OPEN').length}</p></div>
      <div className="studio-card">
        <h4>Charge système</h4>
        <p>{status ? `${status.overhead.eventsPerMin.toFixed(0)} évts/min` : '—'}{status?.degraded ? ' — dégradé' : ''}</p>
      </div>
    </div>
  );
}

function LiveTab({ connections }: { connections: MonitorConnection[] }) {
  if (connections.length === 0) return <StudioEmptyState message="Aucune connexion observée pour le moment." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Application</th><th>Destination</th><th>Protocole</th><th>État</th><th>1re vue</th><th>Dernière activité</th></tr></thead>
      <tbody>
        {connections.slice(0, 100).map(c => (
          <tr key={c.id}>
            <td>{c.process_name}</td>
            <td>{c.remote_address}{c.remote_port ? `:${c.remote_port}` : ''}</td>
            <td>{c.protocol}</td>
            <td>{c.state ?? '—'}</td>
            <td>{new Date(c.first_seen).toLocaleTimeString('fr-FR')}</td>
            <td>{new Date(c.last_seen).toLocaleTimeString('fr-FR')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NetworkTab({ connections }: { connections: MonitorConnection[] }) {
  const byDestination = useMemo(() => {
    const map = new Map<string, { count: number; apps: Set<string> }>();
    for (const c of connections) {
      const key = c.remote_address;
      const entry = map.get(key) ?? { count: 0, apps: new Set<string>() };
      entry.count += c.sample_count;
      entry.apps.add(c.process_name);
      map.set(key, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [connections]);

  if (byDestination.length === 0) return <StudioEmptyState message="Aucune destination observée pour le moment." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Destination</th><th>Échantillons</th><th>Applications</th></tr></thead>
      <tbody>
        {byDestination.slice(0, 100).map(([dest, entry]) => (
          <tr key={dest}><td>{dest}</td><td>{entry.count}</td><td>{[...entry.apps].join(', ')}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function ApplicationsTab({ processes }: { processes: MonitorProcess[] }) {
  if (processes.length === 0) return <StudioEmptyState message="Aucune application observée pour le moment." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Application</th><th>Connexions</th><th>Destinations distinctes</th><th>Dernière activité</th></tr></thead>
      <tbody>
        {processes.map(p => (
          <tr key={p.id}>
            <td>{p.process_name}</td>
            <td>{p.connection_count}</td>
            <td>{p.distinct_destinations}</td>
            <td>{new Date(p.last_seen).toLocaleTimeString('fr-FR')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnomaliesTab({ anomalies, onOpenMaitre }: { anomalies: MonitorAnomaly[]; onOpenMaitre?: () => void }) {
  if (anomalies.length === 0) return <StudioEmptyState message="Aucune anomalie détectée." />;
  return (
    <div className="studio-list">
      {anomalies.map(a => (
        <div key={a.id} className="studio-card" style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <StudioStatus label={SEVERITY_LABEL[a.severity]} tone={SEVERITY_TONE[a.severity]} compact />
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{new Date(a.detected_at).toLocaleString('fr-FR')}</span>
          </div>
          <p>{a.description}</p>
          {a.severity === 'REQUIRES_REVIEW' && (
            <div style={{ marginTop: 6 }}>
              <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>Analyse approfondie recommandée avec MAÎTRE.</p>
              {onOpenMaitre ? (
                <button type="button" className="studio-button" onClick={onOpenMaitre}>
                  Ouvrir dans MAÎTRE
                </button>
              ) : (
                <button type="button" className="studio-button" disabled title="MAÎTRE n'est pas disponible depuis cette vue">
                  Ouvrir dans MAÎTRE
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ReportsTab({ reports }: { reports: MonitorReport[] }) {
  if (reports.length === 0) return <StudioEmptyState message="Aucun rapport généré pour le moment." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Date</th><th>Type</th><th>Événements</th><th>Anomalies</th><th>Actions</th></tr></thead>
      <tbody>
        {reports.map(r => (
          <tr key={r.id}>
            <td>{new Date(r.created_at).toLocaleString('fr-FR')}</td>
            <td>{r.report_type === 'DETAILED' ? 'Détaillé' : 'Résumé'}</td>
            <td>{r.event_count}</td>
            <td>{r.anomaly_count}</td>
            <td>
              <a href={monitorReportUrl(r.id, 'html')} target="_blank" rel="noreferrer" className="studio-button">Voir</a>{' '}
              <a href={monitorReportUrl(r.id, 'html')} download className="studio-button">HTML</a>{' '}
              <a href={monitorReportUrl(r.id, 'json')} download className="studio-button">JSON</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTab({ connections, processes }: { connections: MonitorConnection[]; processes: MonitorProcess[] }) {
  const timeline = useMemo(() => {
    const events = [
      ...connections.map(c => ({ type: 'Connexion', label: `${c.process_name} → ${c.remote_address}`, at: c.last_seen })),
      ...processes.map(p => ({ type: 'Application', label: p.process_name, at: p.last_seen })),
    ];
    return events.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 100);
  }, [connections, processes]);

  if (timeline.length === 0) return <StudioEmptyState message="Aucun historique pour le moment." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Horodatage</th><th>Type</th><th>Détail</th></tr></thead>
      <tbody>
        {timeline.map((e, i) => (
          <tr key={i}><td>{new Date(e.at).toLocaleString('fr-FR')}</td><td>{e.type}</td><td>{e.label}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function SettingsTab({ settings, onChange, pending }: {
  settings: MonitorSettings; onChange: (updates: Partial<MonitorSettings>) => void; pending: boolean;
}) {
  return (
    <div className="studio-form">
      <label className="studio-field">
        <span>Mode de rapport</span>
        <select value={settings.reportMode} disabled={pending} onChange={e => onChange({ reportMode: e.target.value as MonitorSettings['reportMode'] })}>
          {Object.entries(REPORT_MODE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="studio-field">
        <span>Fréquence des rapports</span>
        <select value={settings.reportFrequency} disabled={pending} onChange={e => onChange({ reportFrequency: e.target.value as MonitorSettings['reportFrequency'] })}>
          <option value="MANUAL">Manuel</option>
          <option value="HOURLY">Toutes les heures</option>
          <option value="DAILY">Quotidien</option>
          <option value="WEEKLY">Hebdomadaire</option>
          <option value="ON_EVENT">Sur événement</option>
          <option value="CUSTOM">Personnalisé</option>
        </select>
      </label>
      <label className="studio-field">
        <span>Rétention (jours)</span>
        <input type="number" min={1} max={30} value={settings.retentionDays} disabled={pending}
          onChange={e => onChange({ retentionDays: Number(e.target.value) })} />
      </label>
      <label className="studio-field">
        <span>Notifications</span>
        <select value={settings.notifyMode} disabled={pending} onChange={e => onChange({ notifyMode: e.target.value as MonitorSettings['notifyMode'] })}>
          <option value="NONE">Aucune</option>
          <option value="IMPORTANT_ONLY">Importantes uniquement</option>
          <option value="ALL_ANOMALIES">Toutes les anomalies</option>
        </select>
      </label>
      <label className="studio-field studio-field--checkbox">
        <input type="checkbox" checked={settings.autostart} disabled={pending}
          onChange={e => onChange({ autostart: e.target.checked })} />
        <span>Démarrer Observateur avec Docteur</span>
      </label>
      <label className="studio-field studio-field--checkbox">
        <input type="checkbox" checked={settings.ollamaEnabled} disabled={pending}
          onChange={e => onChange({ ollamaEnabled: e.target.checked })} />
        <span>Synthèse Ollama dans les rapports (informative uniquement)</span>
      </label>
      <label className="studio-field studio-field--checkbox">
        <input type="checkbox" checked={settings.cloudAiEnabled} disabled readOnly title="Envoi cloud non implémenté en V1" />
        <span>IA cloud (désactivé — non implémenté en V1)</span>
      </label>
      <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Observateur ne collecte que des métadonnées (application, destination, protocole, port, volume approximatif,
        horodatage) — jamais de mots de passe, cookies, jetons ou contenu de communication.
      </p>
    </div>
  );
}
