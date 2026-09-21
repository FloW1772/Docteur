// MAÎTRE Studio — incident response / defensive security UI (MA-11).
// Exposes ONLY capabilities already certified MA-2→MA-10: passive
// evidence review, proposal/approval/execution of a fixed, closed set
// of semantic actions. No action ever executes without an explicit
// user click through PROPOSE → APPROVAL → EXECUTE; LEVEL 3
// (HOST_ISOLATION/RESTORE_HOST_NETWORK) additionally requires a
// distinct, explicit "strengthened confirmation" checkbox the user must
// actively tick — never inferred from opening a modal, hovering a
// button, or a previous unrelated confirmation.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, ShieldAlert, CheckCircle, XCircle } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import StudioTabs from '../studio/StudioTabs';
import StudioStatus, { type StudioStatusTone } from '../studio/StudioStatus';
import StudioEmptyState from '../studio/StudioEmptyState';
import StudioToolbar from '../studio/StudioToolbar';
import {
  type MaitreOverview, type MaitreIncident, type MaitreIncidentDetail, type MaitreSecurityEvent,
  type MaitreProcess, type MaitrePersistenceItem, type MaitreDefenderStatus, type MaitreDefenderDetection,
  type MaitreActionProposal, type MaitreSeverity, type MaitreAnalystResult,
  getMaitreOverview, listMaitreIncidents, getMaitreIncidentDetail, analyzeMaitreIncident,
  listMaitreEvents, listMaitreProcesses, getMaitrePersistence,
  getMaitreDefenderStatus, getMaitreDefenderDetections, getMaitreIsolationStatus,
  proposeMaitreAction, requestMaitreApproval, approveMaitreAction, rejectMaitreAction, executeMaitreAction,
  sortIncidentsBySeverity,
} from '../../lib/maitre-studio';

interface Props {
  onClose: () => void;
  initialTab?: Tab;
  initialIncidentId?: string;
}

type Tab = 'OVERVIEW' | 'INCIDENTS' | 'EVENTS' | 'PROCESSES' | 'PERSISTENCE' | 'DEFENDER' | 'ACTIONS';
const TABS: readonly Tab[] = ['OVERVIEW', 'INCIDENTS', 'EVENTS', 'PROCESSES', 'PERSISTENCE', 'DEFENDER', 'ACTIONS'];

const SEVERITY_TONE: Record<MaitreSeverity, StudioStatusTone> = {
  INFO: 'neutral', OBSERVATION: 'neutral', SUSPICIOUS: 'warning', HIGH: 'warning', CRITICAL: 'error',
};
const SEVERITY_LABEL: Record<MaitreSeverity, string> = {
  INFO: 'Info', OBSERVATION: 'Observation', SUSPICIOUS: 'Suspect', HIGH: 'Élevé', CRITICAL: 'Critique',
};

const POLL_MS = 15_000; // MAÎTRE data changes less often than Observateur's live connections

export default function MaitreStudioModal({ onClose, initialTab = 'OVERVIEW', initialIncidentId }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [overview, setOverview] = useState<MaitreOverview | null>(null);
  const [incidents, setIncidents] = useState<MaitreIncident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(initialIncidentId ?? null);
  const [incidentDetail, setIncidentDetail] = useState<MaitreIncidentDetail | null>(null);
  const [events, setEvents] = useState<MaitreSecurityEvent[]>([]);
  const [processes, setProcesses] = useState<{ processes?: MaitreProcess[]; available?: boolean; reason?: string } | null>(null);
  const [persistence, setPersistence] = useState<{ items: MaitrePersistenceItem[] } | null>(null);
  const [defenderStatus, setDefenderStatus] = useState<MaitreDefenderStatus | null>(null);
  const [defenderDetections, setDefenderDetections] = useState<MaitreDefenderDetection[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshOverview = useCallback(async () => {
    try { const { overview: o } = await getMaitreOverview(); setOverview(o); } catch (e) { setError((e as Error).message); }
  }, []);
  const refreshIncidents = useCallback(async () => {
    try { const { incidents: i } = await listMaitreIncidents({ limit: 100 }); setIncidents(sortIncidentsBySeverity(i)); } catch (e) { setError((e as Error).message); }
  }, []);
  const refreshEvents = useCallback(async () => {
    try { const { events: e } = await listMaitreEvents({ limit: 100 }); setEvents(e); } catch (e) { setError((e as Error).message); }
  }, []);
  const refreshProcesses = useCallback(async () => {
    try { const result = await listMaitreProcesses(); setProcesses(result); } catch (e) { setError((e as Error).message); }
  }, []);
  const refreshPersistence = useCallback(async () => {
    try { const result = await getMaitrePersistence(); setPersistence(result); } catch (e) { setError((e as Error).message); }
  }, []);
  const refreshDefender = useCallback(async () => {
    try {
      const [{ status: s }, { detections: d }] = await Promise.all([getMaitreDefenderStatus(), getMaitreDefenderDetections()]);
      setDefenderStatus(s);
      setDefenderDetections(d);
    } catch (e) { setError((e as Error).message); }
  }, []);
  const refreshIncidentDetail = useCallback(async (id: string) => {
    try { const detail = await getMaitreIncidentDetail(id); setIncidentDetail(detail); } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void refreshOverview(); void refreshIncidents(); }, [refreshOverview, refreshIncidents]);

  useEffect(() => {
    const id = setInterval(() => { void refreshOverview(); }, POLL_MS);
    return () => clearInterval(id);
  }, [refreshOverview]);

  useEffect(() => {
    if (tab === 'EVENTS') void refreshEvents();
    if (tab === 'PROCESSES') void refreshProcesses();
    if (tab === 'PERSISTENCE') void refreshPersistence();
    if (tab === 'DEFENDER') void refreshDefender();
  }, [tab, refreshEvents, refreshProcesses, refreshPersistence, refreshDefender]);

  useEffect(() => {
    if (selectedIncidentId) void refreshIncidentDetail(selectedIncidentId);
  }, [selectedIncidentId, refreshIncidentDetail]);

  const openIncidentCount = overview?.openIncidentCount ?? 0;
  const pendingApprovalCount = overview?.pendingApprovalCount ?? 0;

  const badges = useMemo(() => ({
    INCIDENTS: openIncidentCount || undefined,
    ACTIONS: pendingApprovalCount || undefined,
  }), [openIncidentCount, pendingApprovalCount]);

  const overallTone: StudioStatusTone = overview?.isolationStatus === 'ISOLATION_ACTIVE' ? 'error'
    : overview?.highestActiveSeverity === 'CRITICAL' ? 'error'
      : overview?.highestActiveSeverity === 'HIGH' ? 'warning'
        : overview?.openIncidentCount ? 'warning' : 'success';
  const overallLabel = overview?.isolationStatus === 'ISOLATION_ACTIVE' ? 'Isolé'
    : overview?.highestActiveSeverity ? SEVERITY_LABEL[overview.highestActiveSeverity]
      : 'Sain';

  return (
    <StudioShell
      icon={<Shield size={20} />}
      title="MAÎTRE"
      onClose={onClose}
      subtitle="Réponse aux incidents locale — toute action nécessite une proposition, une approbation explicite, puis une exécution. Aucune action automatique."
    >
      {error && <p className="studio-error" role="alert">{error}</p>}

      <div className="studio-filter-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StudioStatus label={overallLabel} tone={overallTone} />
          {overview?.isolationStatus === 'ISOLATION_ACTIVE' && <StudioStatus label="ISOLATION RÉSEAU ACTIVE" tone="error" />}
          {overview?.isolationStatus === 'PARTIAL_FAILURE' && <StudioStatus label="ISOLATION PARTIELLE" tone="warning" />}
        </div>
      </div>

      <StudioTabs tabs={TABS} active={tab} onChange={setTab} badges={badges} />

      {tab === 'OVERVIEW' && <OverviewTab overview={overview} onOpenIncidents={() => setTab('INCIDENTS')} />}
      {tab === 'INCIDENTS' && (
        <IncidentsTab
          incidents={incidents}
          selectedId={selectedIncidentId}
          detail={incidentDetail}
          onSelect={setSelectedIncidentId}
          onRefreshDetail={() => selectedIncidentId && refreshIncidentDetail(selectedIncidentId)}
          onRefreshIncidents={refreshIncidents}
          onError={setError}
        />
      )}
      {tab === 'EVENTS' && <EventsTab events={events} />}
      {tab === 'PROCESSES' && <ProcessesTab result={processes} />}
      {tab === 'PERSISTENCE' && <PersistenceTab result={persistence} />}
      {tab === 'DEFENDER' && <DefenderTab status={defenderStatus} detections={defenderDetections} />}
      {tab === 'ACTIONS' && (
        <ActionsTab
          incidents={incidents}
          onOpenIncident={(id) => { setSelectedIncidentId(id); setTab('INCIDENTS'); }}
        />
      )}
    </StudioShell>
  );
}

// ── Overview ────────────────────────────────────────────────────────────

function OverviewTab({ overview, onOpenIncidents }: { overview: MaitreOverview | null; onOpenIncidents: () => void }) {
  if (!overview) return <StudioEmptyState message="Chargement…" />;
  return (
    <div className="studio-grid">
      <div className="studio-card"><h4>Incidents ouverts</h4><p>{overview.openIncidentCount}</p></div>
      <div className="studio-card"><h4>Sévérité la plus élevée</h4><p>{overview.highestActiveSeverity ? SEVERITY_LABEL[overview.highestActiveSeverity] : 'Aucune'}</p></div>
      <div className="studio-card"><h4>Defender disponible</h4><p>{overview.defenderAvailable ? 'Oui' : 'Non'}</p></div>
      <div className="studio-card"><h4>Approbations en attente</h4><p>{overview.pendingApprovalCount}</p></div>
      <div className="studio-card"><h4>État isolation réseau</h4><p>{isolationStatusLabel(overview.isolationStatus)}</p></div>
      <button type="button" className="studio-button" onClick={onOpenIncidents}>Voir les incidents</button>
      {overview.recentEvents.length > 0 && (
        <div className="studio-card" style={{ gridColumn: '1 / -1' }}>
          <h4>Événements récents</h4>
          <ul>
            {overview.recentEvents.slice(0, 5).map(e => (
              <li key={e.id}>{e.source} / {e.category} — {SEVERITY_LABEL[e.severity]} — {new Date(e.occurredAt).toLocaleString('fr-FR')}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function eventSubjectLabel(subject: MaitreSecurityEvent['subject']): string {
  const name = (subject as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name : '';
}

function isolationStatusLabel(status: MaitreOverview['isolationStatus']): string {
  switch (status) {
    case 'NOT_ISOLATED': return 'Non isolé';
    case 'ISOLATION_ACTIVE': return 'Isolation active';
    case 'PARTIAL_FAILURE': return 'Échec partiel — révision requise';
    case 'RESTORE_AVAILABLE': return 'Restauration disponible';
    case 'MANUAL_REVIEW': return 'Révision manuelle requise';
    default: return status;
  }
}

// ── Incidents ───────────────────────────────────────────────────────────

function IncidentsTab({ incidents, selectedId, detail, onSelect, onRefreshDetail, onRefreshIncidents, onError }: {
  incidents: MaitreIncident[]; selectedId: string | null; detail: MaitreIncidentDetail | null;
  onSelect: (id: string) => void; onRefreshDetail: () => void; onRefreshIncidents: () => void;
  onError: (msg: string) => void;
}) {
  if (selectedId && detail) {
    return <IncidentDetailView detail={detail} onBack={() => onSelect('')} onRefresh={onRefreshDetail} onError={onError} />;
  }
  if (incidents.length === 0) return <StudioEmptyState message="Aucun incident." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Sévérité</th><th>Titre</th><th>Statut</th><th>Événements</th><th>Preuves</th><th>Créé le</th></tr></thead>
      <tbody>
        {incidents.map(inc => (
          <tr key={inc.id} onClick={() => onSelect(inc.id)} style={{ cursor: 'pointer' }}>
            <td><StudioStatus label={SEVERITY_LABEL[inc.severity]} tone={SEVERITY_TONE[inc.severity]} compact /></td>
            <td>{inc.title}</td>
            <td>{inc.status}</td>
            <td>{inc.eventRefs.length}</td>
            <td>{inc.evidenceRefs.length}</td>
            <td>{new Date(inc.createdAt).toLocaleString('fr-FR')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IncidentDetailView({ detail, onBack, onRefresh, onError }: {
  detail: MaitreIncidentDetail; onBack: () => void; onRefresh: () => void; onError: (msg: string) => void;
}) {
  const [analysis, setAnalysis] = useState<MaitreAnalystResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<MaitreActionProposal | null>(null);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      const result = await analyzeMaitreIncident(detail.incident.id);
      setAnalysis(result);
    } catch (e) { onError((e as Error).message); } finally { setAnalyzing(false); }
  }, [detail.incident.id, onError]);

  return (
    <div className="studio-form">
      <button type="button" className="studio-button" onClick={onBack}>← Retour</button>
      <h3>{detail.incident.title}</h3>
      <p>{detail.incident.summary}</p>
      <div className="studio-grid">
        <div className="studio-card"><h4>Sévérité</h4><p>{SEVERITY_LABEL[detail.incident.severity]}</p></div>
        <div className="studio-card"><h4>Statut</h4><p>{detail.incident.status}</p></div>
      </div>

      <h4>Chronologie</h4>
      {detail.incident.timeline.length === 0 ? <StudioEmptyState message="Aucune entrée." /> : (
        <ul>
          {detail.incident.timeline.map((t, i) => <li key={i}>{new Date(t.at).toLocaleString('fr-FR')} — {t.type}{t.ruleId ? ` (${t.ruleId})` : ''}</li>)}
        </ul>
      )}

      <h4>Événements liés ({detail.events.length})</h4>
      {detail.events.length === 0 ? <StudioEmptyState message="Aucun événement." /> : (
        <ul>
          {detail.events.map(e => (
            <li key={e.id}>
              {e.source} / {e.category} — {SEVERITY_LABEL[e.severity]}
              {eventSubjectLabel(e.subject) ? ` — ${eventSubjectLabel(e.subject)}` : ''}
            </li>
          ))}
        </ul>
      )}

      <h4>Preuves ({detail.evidence.length})</h4>
      {detail.evidence.length === 0 ? <StudioEmptyState message="Aucune preuve." /> : (
        <ul>
          {detail.evidence.map(ev => <li key={ev.id}>{ev.type} — {ev.source}{ev.sha256 ? ` — SHA-256: ${ev.sha256.slice(0, 16)}…` : ''}</li>)}
        </ul>
      )}

      <h4>Analyse locale</h4>
      <button type="button" className="studio-button" onClick={handleAnalyze} disabled={analyzing}>
        {analyzing ? 'Analyse en cours…' : 'Analyser localement'}
      </button>
      {analysis && (
        <div className="studio-card">
          <StudioStatus label={analysis.provenance.source === 'OLLAMA_LOCAL' ? 'OLLAMA_LOCAL' : 'DETERMINISTIC'} tone={analysis.provenance.source === 'OLLAMA_LOCAL' ? 'active' : 'neutral'} compact />
          <p>{analysis.result.summary}</p>
          {analysis.result.observedFacts.length > 0 && (
            <><h5>Faits observés</h5><ul>{analysis.result.observedFacts.map((f, i) => <li key={i}>{f}</li>)}</ul></>
          )}
          {analysis.result.hypotheses.length > 0 && (
            <><h5>Hypothèses (non prouvées)</h5><ul>{analysis.result.hypotheses.map((h, i) => <li key={i}>{h}</li>)}</ul></>
          )}
          {analysis.result.unknowns.length > 0 && (
            <><h5>Inconnues</h5><ul>{analysis.result.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul></>
          )}
          {analysis.result.reviewSuggestions.length > 0 && (
            <><h5>Suggestions de révision (jamais des commandes)</h5><ul>{analysis.result.reviewSuggestions.map((s, i) => <li key={i}>{s}</li>)}</ul></>
          )}
        </div>
      )}

      <h4>Actions proposées</h4>
      {detail.actions.length === 0 ? <StudioEmptyState message="Aucune action proposée." /> : (
        <div className="studio-list">
          {detail.actions.map(a => (
            <ActionRow key={a.id} action={a} onOpenConfirm={() => setConfirmAction(a)} onError={onError} onChanged={onRefresh} />
          ))}
        </div>
      )}

      {confirmAction && (
        <ActionConfirmDialog
          action={confirmAction}
          onClose={() => setConfirmAction(null)}
          onCompleted={() => { setConfirmAction(null); onRefresh(); }}
          onError={onError}
        />
      )}
    </div>
  );
}

// ── Action row + confirmation dialog (mission §12/§27/§28/§29) ────────────

function ActionRow({ action, onOpenConfirm, onError, onChanged }: {
  action: MaitreActionProposal; onOpenConfirm: () => void; onError: (msg: string) => void; onChanged: () => void;
}) {
  const isNotSupported = action.actionType === 'QUARANTINE_WITH_DEFENDER';
  return (
    <div className="studio-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{action.actionType} <em>(LEVEL {action.level})</em></span>
        <StudioStatus label={action.status} tone={action.status === 'REJECTED' || action.status === 'EXPIRED' ? 'error' : action.status === 'CONSUMED' ? 'success' : 'neutral'} compact />
      </div>
      {action.reason && <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>{action.reason}</p>}
      {isNotSupported ? (
        <p style={{ fontSize: 12, color: 'var(--text-dim)' }} title="Non pris en charge en toute sécurité sur ce système/V1">
          Non pris en charge en toute sécurité sur ce système/V1
        </p>
      ) : action.status === 'AWAITING_APPROVAL' || action.status === 'READY' ? (
        <button type="button" className="studio-button studio-button--primary" onClick={onOpenConfirm}>
          Examiner et {action.status === 'READY' ? 'exécuter' : 'approuver'}
        </button>
      ) : null}
    </div>
  );
}

type ConfirmStep = 'PREVIEW' | 'REQUESTING' | 'AWAITING_CONFIRM' | 'EXECUTING' | 'DONE';

function ActionConfirmDialog({ action, onClose, onCompleted, onError }: {
  action: MaitreActionProposal; onClose: () => void; onCompleted: () => void; onError: (msg: string) => void;
}) {
  const [step, setStep] = useState<ConfirmStep>('PREVIEW');
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [strengthened, setStrengthened] = useState(false);
  const [resultStatus, setResultStatus] = useState<string | null>(null);
  const isLevel3 = action.level === 3;
  const requiresStrengthened = !!action.policyResult?.requirements?.includes('strengthened_confirmation');

  const handleApproveAndExecute = useCallback(async () => {
    setStep('REQUESTING');
    try {
      let currentApprovalId = approvalId;
      if (action.status === 'AWAITING_APPROVAL') {
        const req = await requestMaitreApproval(action.id);
        currentApprovalId = req.approval.id;
        setApprovalId(currentApprovalId);
        await approveMaitreAction(currentApprovalId, requiresStrengthened ? strengthened : undefined);
      }
      setStep('EXECUTING');
      const run = await executeMaitreAction(action.id, currentApprovalId ?? undefined);
      setResultStatus(run.run.status);
      setStep('DONE');
    } catch (e) {
      onError((e as Error).message);
      setStep('PREVIEW');
    }
  }, [action, approvalId, strengthened, requiresStrengthened, onError]);

  const handleReject = useCallback(async () => {
    try {
      if (action.status === 'AWAITING_APPROVAL') {
        const req = await requestMaitreApproval(action.id);
        await rejectMaitreAction(req.approval.id, 'Rejeté depuis MAÎTRE Studio');
      }
      onCompleted();
    } catch (e) { onError((e as Error).message); }
  }, [action, onCompleted, onError]);

  const canConfirm = !requiresStrengthened || strengthened;

  return (
    <div role="dialog" aria-modal="true" aria-label="Confirmer l'action" className="studio-card" style={{ border: '2px solid var(--accent, #5ee7ff)', marginTop: 12 }}>
      {isLevel3 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ff4d58' }}>
          <ShieldAlert size={16} /> <strong>Action de niveau élevé (LEVEL 3)</strong>
        </div>
      )}
      <h4>Aperçu de l'action</h4>
      <ul>
        <li>Type : {action.actionType}</li>
        <li>Cible : {JSON.stringify(action.target)}</li>
        <li>Raison : {action.reason || '—'}</li>
        <li>Niveau : LEVEL {action.level}</li>
        <li>Effet attendu : {actionEffectDescription(action.actionType)}</li>
        {action.actionType === 'HOST_ISOLATION' && (
          <>
            <li>Restauration disponible via une action RESTORE_HOST_NETWORK distincte, avec approbation.</li>
            <li>127.0.0.1 / accès local à Docteur restent préservés par construction.</li>
            <li>Peut nécessiter des privilèges administrateur — sinon, l'action échoue proprement (access_denied), sans contournement automatique.</li>
          </>
        )}
        {requiresStrengthened && <li>Confirmation renforcée explicite requise ci-dessous.</li>}
      </ul>

      {requiresStrengthened && step === 'PREVIEW' && (
        <label className="studio-field studio-field--checkbox">
          <input type="checkbox" checked={strengthened} onChange={e => setStrengthened(e.target.checked)} />
          <span>Je comprends l'impact de cette action et je confirme explicitement vouloir l'exécuter.</span>
        </label>
      )}

      {step === 'PREVIEW' && (
        <StudioToolbar destructive={<button type="button" className="studio-button" onClick={onClose}>Annuler</button>}>
          <button type="button" className="studio-button studio-button--primary" onClick={handleApproveAndExecute} disabled={!canConfirm}>
            Approuver et exécuter
          </button>
          <button type="button" className="studio-button" onClick={handleReject}>Rejeter</button>
        </StudioToolbar>
      )}
      {(step === 'REQUESTING' || step === 'EXECUTING') && <p>En cours…</p>}
      {step === 'DONE' && (
        <>
          <p style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {resultStatus === 'SUCCEEDED' ? <CheckCircle size={16} color="#3dffaa" /> : <XCircle size={16} color="#ff4d58" />}
            {resultStatusLabel(resultStatus)}
          </p>
          <button type="button" className="studio-button" onClick={onCompleted}>Fermer</button>
        </>
      )}
    </div>
  );
}

function resultStatusLabel(status: string | null): string {
  switch (status) {
    case 'SUCCEEDED': return 'Réussi';
    case 'FAILED': return 'Échec';
    case 'PARTIAL_FAILURE': return 'Échec partiel — restauration disponible';
    case 'NOT_SUPPORTED': return 'Non pris en charge en toute sécurité sur ce système/V1';
    case 'MANUAL_REVIEW': return 'Révision manuelle requise';
    default: return status ?? '—';
  }
}

function actionEffectDescription(type: MaitreActionProposal['actionType']): string {
  switch (type) {
    case 'COLLECT_EVIDENCE': return 'Collecte des métadonnées déjà accessibles, sans modification système.';
    case 'SCAN_WITH_DEFENDER': return "Lance une analyse Defender ciblée sur un seul fichier.";
    case 'TERMINATE_PROCESS': return 'Arrête un processus précis (jamais un processus système/Docteur critique).';
    case 'QUARANTINE_WITH_DEFENDER': return 'Non pris en charge en toute sécurité sur ce système/V1.';
    case 'BLOCK_REMOTE_IP': return "Crée une règle pare-feu MAÎTRE ciblée bloquant une adresse IP précise.";
    case 'DISABLE_PERSISTENCE_ENTRY': return 'Désactive une entrée de démarrage automatique précise (réversible).';
    case 'HOST_ISOLATION': return "Bloque le trafic réseau sortant/entrant hors boucle locale via des règles pare-feu MAÎTRE dédiées. N'est pas un air-gap.";
    case 'RESTORE_HOST_NETWORK': return "Supprime uniquement les règles pare-feu créées par l'isolation MAÎTRE ciblée.";
    default: return '—';
  }
}

// ── Events ──────────────────────────────────────────────────────────────

function EventsTab({ events }: { events: MaitreSecurityEvent[] }) {
  const [severityFilter, setSeverityFilter] = useState<MaitreSeverity | 'ALL'>('ALL');
  const [sourceFilter, setSourceFilter] = useState<string>('ALL');

  const sources = useMemo(() => [...new Set(events.map(e => e.source))], [events]);
  const filtered = useMemo(() => events.filter(e => (severityFilter === 'ALL' || e.severity === severityFilter) && (sourceFilter === 'ALL' || e.source === sourceFilter)), [events, severityFilter, sourceFilter]);

  return (
    <div>
      <div className="studio-filter-row">
        <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value as MaitreSeverity | 'ALL')}>
          <option value="ALL">Toutes sévérités</option>
          {Object.entries(SEVERITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="ALL">Toutes sources</option>
          {sources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {filtered.length === 0 ? <StudioEmptyState message="Aucun événement." /> : (
        <table className="studio-table">
          <thead><tr><th>Source</th><th>Catégorie</th><th>Sévérité</th><th>Confiance</th><th>Sujet</th><th>Horodatage</th></tr></thead>
          <tbody>
            {filtered.slice(0, 200).map(e => (
              <tr key={e.id}>
                <td>{e.source}</td>
                <td>{e.category}</td>
                <td><StudioStatus label={SEVERITY_LABEL[e.severity]} tone={SEVERITY_TONE[e.severity]} compact /></td>
                <td>{e.confidence}</td>
                <td>{eventSubjectLabel(e.subject) || '—'}</td>
                <td>{new Date(e.occurredAt).toLocaleString('fr-FR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Processes ───────────────────────────────────────────────────────────

function ProcessesTab({ result }: { result: { processes?: MaitreProcess[]; available?: boolean; reason?: string } | null }) {
  if (!result) return <StudioEmptyState message="Chargement…" />;
  if (result.available === false) return <StudioEmptyState message={`Indisponible : ${result.reason ?? 'inconnu'}`} />;
  const processes = result.processes ?? [];
  if (processes.length === 0) return <StudioEmptyState message="Aucun processus." />;
  return (
    <table className="studio-table">
      <thead><tr><th>PID</th><th>Nom</th><th>Chemin</th><th>Parent</th><th>Démarré</th><th>Criticité</th></tr></thead>
      <tbody>
        {processes.map(p => (
          <tr key={p.pid}>
            <td>{p.pid}</td>
            <td>{p.name}</td>
            <td>{p.executablePath ?? '—'}</td>
            <td>{p.parentPid ?? '—'}</td>
            <td>{p.startTime ? new Date(p.startTime).toLocaleString('fr-FR') : '—'}</td>
            <td>
              {p.criticality !== 'NORMAL' ? (
                <StudioStatus label={p.criticality === 'SYSTEM_CRITICAL' ? 'Système protégé' : 'Docteur protégé'} tone="warning" compact />
              ) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Persistence ─────────────────────────────────────────────────────────

function PersistenceTab({ result }: { result: { items: MaitrePersistenceItem[] } | null }) {
  if (!result) return <StudioEmptyState message="Chargement…" />;
  if (result.items.length === 0) return <StudioEmptyState message="Aucune entrée de démarrage automatique détectée." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Type</th><th>Portée</th><th>Nom</th><th>Cible</th><th>Statut</th></tr></thead>
      <tbody>
        {result.items.map(item => (
          <tr key={item.id}>
            <td>{item.type}</td>
            <td>{item.scope}</td>
            <td>{item.name}</td>
            <td>{item.target}</td>
            <td>{item.changeStatus ?? 'UNCHANGED'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Defender ────────────────────────────────────────────────────────────

function DefenderTab({ status, detections }: { status: MaitreDefenderStatus | null; detections: MaitreDefenderDetection[] }) {
  return (
    <div>
      <div className="studio-grid">
        <div className="studio-card"><h4>Disponibilité</h4><p>{status?.available ? 'Disponible' : 'Indisponible'}</p></div>
        {status?.available && (
          <>
            <div className="studio-card"><h4>Protection en temps réel</h4><p>{status.realTimeProtectionEnabled ? 'Activée' : 'Désactivée'}</p></div>
            <div className="studio-card"><h4>Antivirus</h4><p>{status.antivirusEnabled ? 'Activé' : 'Désactivé'}</p></div>
          </>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Analyse ciblée sur un seul fichier uniquement (CustomScan). Analyse rapide/complète : non pris en charge en toute sécurité sur ce système/V1.
      </p>
      <h4>Détections récentes</h4>
      {detections.length === 0 ? <StudioEmptyState message="Aucune détection." /> : (
        <table className="studio-table">
          <thead><tr><th>Menace</th><th>Sévérité</th><th>Chemin</th><th>Action</th><th>Détecté le</th></tr></thead>
          <tbody>
            {detections.map((d, i) => (
              <tr key={i}>
                <td>{d.threatName}</td>
                <td>{d.severity ?? '—'}</td>
                <td>{d.path ?? '—'}</td>
                <td>{d.actionTaken ?? '—'}</td>
                <td>{d.detectedAt ? new Date(d.detectedAt).toLocaleString('fr-FR') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Actions / History ───────────────────────────────────────────────────

function ActionsTab({ incidents, onOpenIncident }: { incidents: MaitreIncident[]; onOpenIncident: (id: string) => void }) {
  const incidentsWithActivity = incidents.filter(i => i.status === 'AWAITING_APPROVAL' || i.status === 'CONTAINED' || i.status === 'INVESTIGATING');
  if (incidentsWithActivity.length === 0) return <StudioEmptyState message="Aucune action en cours." />;
  return (
    <table className="studio-table">
      <thead><tr><th>Incident</th><th>Statut</th><th>Sévérité</th><th /></tr></thead>
      <tbody>
        {incidentsWithActivity.map(inc => (
          <tr key={inc.id}>
            <td>{inc.title}</td>
            <td>{inc.status}</td>
            <td><StudioStatus label={SEVERITY_LABEL[inc.severity]} tone={SEVERITY_TONE[inc.severity]} compact /></td>
            <td><button type="button" className="studio-button" onClick={() => onOpenIncident(inc.id)}>Ouvrir</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
