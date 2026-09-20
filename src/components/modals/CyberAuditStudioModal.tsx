// Cyber Audit Studio (SENTINEL V1, CA-8). No scan logic lives here — every
// action calls the existing semantic API (cyber-audit-studio.ts ->
// /api/cyber-audit/missions/...) which is itself backed by the
// orchestrator's state machine (CA-7), bounded crawler (CA-6), detectors
// (CA-4), rate-limited gateway (CA-7.1). This file only renders state and
// forwards user intent — it never fetches a target URL, never runs a
// detector, never bypasses the backend's authorization/scope gates.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import StudioTabs from '../studio/StudioTabs';
import StudioStatus, { type StudioStatusTone } from '../studio/StudioStatus';
import StudioEmptyState from '../studio/StudioEmptyState';
import StudioErrorState from '../studio/StudioErrorState';
import StudioToolbar from '../studio/StudioToolbar';
import { startJobPolling } from '../../lib/video-job-polling';
import {
  type CyberMission, type CyberFinding, type CyberEvidence, type CyberMissionMode, type CyberScopeInput,
  listCyberMissions, getCyberMission, createCyberMission, startCyberMission, cancelCyberMission,
  getCyberFindings, getCyberEvidence, cyberReportUrl, validateScopeForWizard, ALLOWED_CYBER_MODES,
  sortFindingsBySeverity, remediationPriority,
} from '../../lib/cyber-audit-studio';
import { studioRequestError } from '../../lib/studio-errors';

interface Props {
  onClose: () => void;
  onMissionUpdate?: (missionId: string) => void;
  /** When true, renders only the panel body (no StudioShell backdrop/dialog
   * chrome) — used by ObservateurStudioModal to embed this exact,
   * behavior-unchanged panel as its WEB AUDIT tab. Standalone callers
   * (default, false) keep the original full-modal behavior verified by the
   * existing 25 Playwright tests. */
  bare?: boolean;
}

type Tab = 'OVERVIEW' | 'SCOPE' | 'SCAN' | 'FINDINGS' | 'EVIDENCE' | 'REMEDIATION' | 'REPORT' | 'HISTORY';
const TABS: readonly Tab[] = ['OVERVIEW', 'SCOPE', 'SCAN', 'FINDINGS', 'EVIDENCE', 'REMEDIATION', 'REPORT', 'HISTORY'];

type WizardStep = 'MISSION' | 'AUTHORIZATION' | 'SCOPE' | 'MODE' | 'LIMITS' | 'REVIEW';
const WIZARD_STEPS: readonly WizardStep[] = ['MISSION', 'AUTHORIZATION', 'SCOPE', 'MODE', 'LIMITS', 'REVIEW'];

const STATUS_TONE: Record<CyberMission['status'], StudioStatusTone> = {
  CREATED: 'neutral', READY: 'neutral', RUNNING: 'active', COMPLETED: 'success',
  CANCELLED: 'warning', FAILED: 'error', BLOCKED_BY_POLICY: 'error',
};
const STATUS_LABEL: Record<CyberMission['status'], string> = {
  CREATED: 'Créée', READY: 'Prête', RUNNING: 'En cours', COMPLETED: 'Terminée',
  CANCELLED: 'Annulée', FAILED: 'Échouée', BLOCKED_BY_POLICY: 'Bloquée par la politique',
};
const SEVERITY_TONE: Record<CyberFinding['severity'], StudioStatusTone> = {
  CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'neutral', INFO: 'neutral',
};

const TERMINAL_STATUSES = new Set<CyberMission['status']>(['COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED_BY_POLICY']);

interface WizardState {
  title: string;
  clientName: string;
  authorizationReference: string;
  authorizationConfirmed: boolean;
  hostsText: string;
  portsText: string;
  protocols: Array<'http:' | 'https:'>;
  allowedPathsText: string;
  excludedPathsText: string;
  followSubdomains: boolean;
  maxDepth: number;
  mode: CyberMissionMode;
  maxRequests: number;
  requestsPerSecond: number;
  maxConcurrentRequests: number; // display-only in V1 (server-enforced sequential dispatch); see LIMITS UI note
  timeoutMs: number;
}

const INITIAL_WIZARD: WizardState = {
  title: '', clientName: '', authorizationReference: '', authorizationConfirmed: false,
  hostsText: '', portsText: '443', protocols: ['https:'], allowedPathsText: '', excludedPathsText: '',
  followSubdomains: false, maxDepth: 1, mode: 'PASSIVE', maxRequests: 50, requestsPerSecond: 1,
  maxConcurrentRequests: 1, timeoutMs: 10000,
};

// Server caps — mirrors cortex-server/src/lib/cyber-policy.js LIMITS.
// Never allow the UI to submit a value beyond these; the backend would
// reject it anyway, but the wizard should say so immediately rather than
// let a submission round-trip fail silently confusing.
const SERVER_CAPS = { maxRequests: 200, requestsPerSecond: 2, maxDepth: 3, maxConcurrentRequests: 4 };

function parseList(text: string): string[] {
  return text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

function buildScope(w: WizardState): CyberScopeInput {
  return {
    allowedHosts: parseList(w.hostsText),
    allowedPorts: parseList(w.portsText).map(Number).filter(n => Number.isInteger(n) && n > 0),
    allowedProtocols: w.protocols,
    allowedPaths: w.allowedPathsText.trim() ? parseList(w.allowedPathsText) : undefined,
    excludedPaths: w.excludedPathsText.trim() ? parseList(w.excludedPathsText) : undefined,
    followSubdomains: w.followSubdomains,
    maxDepth: w.maxDepth,
    maxRequests: w.maxRequests,
    requestsPerSecond: w.requestsPerSecond,
    timeoutMs: w.timeoutMs,
  };
}

export default function CyberAuditStudioModal({ onClose, onMissionUpdate, bare = false }: Props) {
  const [tab, setTab] = useState<Tab>('OVERVIEW');
  const [mission, setMission] = useState<CyberMission | null>(null);
  const [findings, setFindings] = useState<CyberFinding[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('MISSION');
  const [wizard, setWizard] = useState<WizardState>(INITIAL_WIZARD);
  const [history, setHistory] = useState<CyberMission[]>([]);
  const [selectedFinding, setSelectedFinding] = useState<CyberFinding | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<Record<string, CyberEvidence>>({});
  const [severityFilter, setSeverityFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const loadHistory = useCallback(async () => {
    try {
      const { missions } = await listCyberMissions();
      setHistory(missions);
    } catch { /* history is best-effort — never blocks the main flow */ }
  }, []);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const refreshFindings = useCallback(async (missionId: string) => {
    try {
      const { findings: list } = await getCyberFindings(missionId);
      setFindings(list);
    } catch { /* keep last-known findings on transient error */ }
  }, []);

  const pollMission = useCallback((missionId: string) => {
    return startJobPolling(
      () => getCyberMission(missionId),
      // startJobPolling's terminal check (isTerminalVideoStatus) only
      // recognizes lowercase 'done'/'completed'/'failed'/'error'/
      // 'cancelled' — SENTINEL's own states are uppercase and include
      // BLOCKED_BY_POLICY, which that list doesn't have at all. Map to a
      // status string that IS in the recognized terminal set once the
      // mission has actually reached any of its own terminal states, so
      // polling stops correctly instead of running forever past completion.
      detail => (TERMINAL_STATUSES.has(detail.mission.status) ? 'done' : detail.mission.status),
      detail => {
        setMission(detail.mission);
        onMissionUpdate?.(missionId);
        void refreshFindings(missionId);
      },
      () => { void loadHistory(); },
      { intervalMs: 1500 },
    );
  }, [onMissionUpdate, refreshFindings, loadHistory]);

  useEffect(() => {
    if (!mission || TERMINAL_STATUSES.has(mission.status)) return undefined;
    const stop = pollMission(mission.id);
    return stop;
  }, [mission?.id, mission?.status, pollMission]);

  const openWizard = () => { setWizard(INITIAL_WIZARD); setWizardStep('MISSION'); setWizardOpen(true); setError(''); };

  const scopeError = useMemo(() => validateScopeForWizard(buildScope(wizard)), [wizard]);

  const canAdvance = useMemo(() => {
    switch (wizardStep) {
      case 'MISSION': return wizard.title.trim().length > 0 && wizard.clientName.trim().length > 0;
      case 'AUTHORIZATION': return wizard.authorizationConfirmed === true;
      case 'SCOPE': return scopeError === null;
      case 'MODE': return ALLOWED_CYBER_MODES.includes(wizard.mode);
      case 'LIMITS':
        return wizard.maxRequests > 0 && wizard.maxRequests <= SERVER_CAPS.maxRequests
          && wizard.requestsPerSecond > 0 && wizard.requestsPerSecond <= SERVER_CAPS.requestsPerSecond
          && wizard.maxDepth >= 0 && wizard.maxDepth <= SERVER_CAPS.maxDepth
          && wizard.timeoutMs >= 1000;
      default: return true;
    }
  }, [wizard, wizardStep, scopeError]);

  const startAuditFromReview = async () => {
    setPending(true);
    setError('');
    try {
      const { mission: created } = await createCyberMission({
        title: wizard.title.trim(),
        clientName: wizard.clientName.trim(),
        authorizationConfirmed: wizard.authorizationConfirmed,
        authorizationReference: wizard.authorizationReference.trim() || undefined,
        scope: buildScope(wizard),
        mode: wizard.mode,
      });
      const { mission: started } = await startCyberMission(created.id);
      setMission(started);
      setFindings([]);
      setWizardOpen(false);
      setTab('SCAN');
      onMissionUpdate?.(started.id);
      void loadHistory();
    } catch (err) {
      setError(studioRequestError(err));
    } finally {
      setPending(false);
    }
  };

  const cancelAudit = async () => {
    if (!mission) return;
    setPending(true);
    try {
      const { mission: cancelled } = await cancelCyberMission(mission.id);
      setMission(cancelled);
    } catch (err) {
      setError(studioRequestError(err));
    } finally {
      setPending(false);
    }
  };

  const openMissionFromHistory = async (id: string) => {
    setPending(true);
    setError('');
    try {
      const { mission: loaded } = await getCyberMission(id);
      setMission(loaded);
      await refreshFindings(id);
      setTab('OVERVIEW');
    } catch (err) {
      setError(studioRequestError(err));
    } finally {
      setPending(false);
    }
  };

  const loadEvidenceForFinding = async (finding: CyberFinding) => {
    if (!mission) return;
    for (const evId of finding.evidenceIds) {
      if (selectedEvidence[evId]) continue;
      try {
        const { evidence } = await getCyberEvidence(mission.id, evId);
        setSelectedEvidence(prev => ({ ...prev, [evId]: evidence }));
      } catch { /* evidence fetch failure shown inline per-item, not fatal */ }
    }
  };

  const openFindingDetail = (finding: CyberFinding) => {
    setSelectedFinding(finding);
    void loadEvidenceForFinding(finding);
  };

  const copyEvidence = async (evidence: CyberEvidence) => {
    const text = [
      `URL: ${evidence.url}`, `Method: ${evidence.method}`, `Timestamp: ${evidence.timestamp}`,
      `Response status: ${evidence.responseStatus ?? 'N/A'}`,
      `Relevant headers: ${JSON.stringify(evidence.relevantHeaders)}`,
      `Excerpt: ${evidence.excerpt}`, `SHA256: ${evidence.sha256}`,
    ].join('\n');
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard may be unavailable — no crash */ }
  };

  const filteredFindings = useMemo(() => {
    return sortFindingsBySeverity(findings).filter(f =>
      (severityFilter === 'all' || f.severity === severityFilter)
      && (categoryFilter === 'all' || f.category === categoryFilter)
      && (statusFilter === 'all' || f.status === statusFilter));
  }, [findings, severityFilter, categoryFilter, statusFilter]);

  const categories = useMemo(() => Array.from(new Set(findings.map(f => f.category))), [findings]);
  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    return counts;
  }, [findings]);

  const remediationGroups = useMemo(() => {
    const groups: Record<'QUICK_WINS' | 'SHORT_TERM' | 'LONG_TERM', CyberFinding[]> = { QUICK_WINS: [], SHORT_TERM: [], LONG_TERM: [] };
    for (const f of findings) groups[remediationPriority(f)].push(f);
    return groups;
  }, [findings]);

  const badges = { FINDINGS: findings.length || undefined };

  const body = (
    <>
      {error && <StudioErrorState message={error} />}

      {!mission && !wizardOpen && (
        <StudioEmptyState
          message="Aucune mission active. Créez un nouvel audit autorisé pour commencer."
          action={<button type="button" className="studio-button studio-button--primary" onClick={openWizard}>Nouvel audit</button>}
        />
      )}

      {wizardOpen && (
        <CyberAuditWizard
          step={wizardStep}
          wizard={wizard}
          setWizard={setWizard}
          canAdvance={canAdvance}
          scopeError={scopeError}
          pending={pending}
          onBack={() => {
            const idx = WIZARD_STEPS.indexOf(wizardStep);
            if (idx === 0) { setWizardOpen(false); return; }
            setWizardStep(WIZARD_STEPS[idx - 1]);
          }}
          onNext={() => {
            const idx = WIZARD_STEPS.indexOf(wizardStep);
            if (idx === WIZARD_STEPS.length - 1) { void startAuditFromReview(); return; }
            setWizardStep(WIZARD_STEPS[idx + 1]);
          }}
        />
      )}

      {mission && !wizardOpen && (
        <>
          <div className="studio-filter-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StudioStatus label={STATUS_LABEL[mission.status]} tone={STATUS_TONE[mission.status]} />
              <strong>{mission.title}</strong>
              <span style={{ color: 'var(--text-dim)' }}>({mission.clientName})</span>
            </div>
            <button type="button" className="studio-button" onClick={openWizard}>Nouvel audit</button>
          </div>

          <StudioTabs tabs={TABS} active={tab} onChange={setTab} badges={badges} />

          {tab === 'OVERVIEW' && <OverviewTab mission={mission} severityCounts={severityCounts} />}
          {tab === 'SCOPE' && <ScopeTab mission={mission} />}
          {tab === 'SCAN' && (
            <ScanTab mission={mission} onCancel={cancelAudit} pending={pending} />
          )}
          {tab === 'FINDINGS' && (
            <FindingsTab
              findings={filteredFindings} categories={categories}
              severityFilter={severityFilter} setSeverityFilter={setSeverityFilter}
              categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter}
              statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              onOpenDetail={openFindingDetail}
            />
          )}
          {tab === 'EVIDENCE' && (
            <EvidenceTab findings={findings} evidenceById={selectedEvidence} onLoadFinding={loadEvidenceForFinding} onCopy={copyEvidence} />
          )}
          {tab === 'REMEDIATION' && <RemediationTab groups={remediationGroups} />}
          {tab === 'REPORT' && <ReportTab missionId={mission.id} />}
          {tab === 'HISTORY' && <HistoryTab missions={history} onOpen={openMissionFromHistory} />}
        </>
      )}

      {!mission && wizardOpen === false && history.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <HistoryTab missions={history} onOpen={openMissionFromHistory} />
        </div>
      )}

      {selectedFinding && (
        <FindingDetailOverlay
          finding={selectedFinding}
          evidence={selectedFinding.evidenceIds.map(id => selectedEvidence[id]).filter(Boolean) as CyberEvidence[]}
          onClose={() => setSelectedFinding(null)}
          onCopyEvidence={copyEvidence}
        />
      )}
    </>
  );

  if (bare) return body;

  return (
    <StudioShell
      icon={<ShieldCheck size={20} />}
      title="Audit Web — Observateur"
      onClose={onClose}
      subtitle="Audit externe, automatisé, autorisé et non destructif. Aucune exploitation, aucun brute force, aucun scan de ports."
    >
      {body}
    </StudioShell>
  );
}

// ---------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------

const REQUIRED_AUTHORIZATION_TEXT = 'Je confirme être propriétaire de cette cible ou disposer d’une autorisation explicite pour effectuer cet audit.';

function CyberAuditWizard({ step, wizard, setWizard, canAdvance, scopeError, pending, onBack, onNext }: {
  step: WizardStep; wizard: WizardState; setWizard: (updater: (w: WizardState) => WizardState) => void;
  canAdvance: boolean; scopeError: string | null; pending: boolean; onBack: () => void; onNext: () => void;
}) {
  const set = <K extends keyof WizardState>(key: K, value: WizardState[K]) => setWizard(w => ({ ...w, [key]: value }));
  const stepIndex = WIZARD_STEPS.indexOf(step);

  return (
    <div>
      <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Étape {stepIndex + 1} / {WIZARD_STEPS.length} — {step}</p>

      {step === 'MISSION' && (
        <div>
          <label htmlFor="cyber-title">Titre de la mission</label>
          <input id="cyber-title" className="studio-field" value={wizard.title} onChange={e => set('title', e.target.value)} />
          <label htmlFor="cyber-client">Client</label>
          <input id="cyber-client" className="studio-field" value={wizard.clientName} onChange={e => set('clientName', e.target.value)} />
          <label htmlFor="cyber-authref">Référence d'autorisation (facultative)</label>
          <input id="cyber-authref" className="studio-field" value={wizard.authorizationReference} onChange={e => set('authorizationReference', e.target.value)} />
        </div>
      )}

      {step === 'AUTHORIZATION' && (
        <div>
          <p><ShieldAlert size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />Cette confirmation est obligatoire — aucun audit ne peut démarrer sans elle.</p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox" checked={wizard.authorizationConfirmed}
              onChange={e => set('authorizationConfirmed', e.target.checked)}
            />
            <span>{REQUIRED_AUTHORIZATION_TEXT}</span>
          </label>
        </div>
      )}

      {step === 'SCOPE' && (
        <div>
          <label htmlFor="cyber-hosts">Hôtes autorisés (un par ligne, pas de joker *)</label>
          <textarea id="cyber-hosts" className="studio-field" rows={2} value={wizard.hostsText} onChange={e => set('hostsText', e.target.value)} />
          <label htmlFor="cyber-ports">Ports autorisés</label>
          <input id="cyber-ports" className="studio-field" value={wizard.portsText} onChange={e => set('portsText', e.target.value)} />
          <label>Protocoles autorisés</label>
          <div className="studio-filter-row">
            {(['https:', 'http:'] as const).map(p => (
              <label key={p} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox" checked={wizard.protocols.includes(p)}
                  onChange={e => set('protocols', e.target.checked ? [...wizard.protocols, p] : wizard.protocols.filter(x => x !== p))}
                />
                {p}
              </label>
            ))}
          </div>
          <label htmlFor="cyber-allowed-paths">Chemins autorisés (facultatif)</label>
          <textarea id="cyber-allowed-paths" className="studio-field" rows={2} value={wizard.allowedPathsText} onChange={e => set('allowedPathsText', e.target.value)} />
          <label htmlFor="cyber-excluded-paths">Chemins exclus (facultatif)</label>
          <textarea id="cyber-excluded-paths" className="studio-field" rows={2} value={wizard.excludedPathsText} onChange={e => set('excludedPathsText', e.target.value)} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={wizard.followSubdomains} onChange={e => set('followSubdomains', e.target.checked)} />
            Suivre les sous-domaines
          </label>
          <label htmlFor="cyber-depth">Profondeur maximale (max {SERVER_CAPS.maxDepth})</label>
          <input id="cyber-depth" type="number" className="studio-field" min={0} max={SERVER_CAPS.maxDepth} value={wizard.maxDepth} onChange={e => set('maxDepth', Number(e.target.value))} />
          {scopeError && <StudioErrorState message={studioRequestError(scopeError)} />}
        </div>
      )}

      {step === 'MODE' && (
        <div>
          <label>Mode</label>
          <div className="studio-filter-row">
            {ALLOWED_CYBER_MODES.map(m => (
              <label key={m} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" name="cyber-mode" checked={wizard.mode === m} onChange={() => set('mode', m)} />
                {m}
              </label>
            ))}
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            Aucun mode AGGRESSIVE/EXPLOIT/PENTEST/FULL_ATTACK n'existe en V1 — SENTINEL reste non destructif et non exploitant quel que soit le mode choisi.
          </p>
        </div>
      )}

      {step === 'LIMITS' && (
        <div>
          <label htmlFor="cyber-max-requests">Requêtes maximales (max {SERVER_CAPS.maxRequests})</label>
          <input id="cyber-max-requests" type="number" className="studio-field" min={1} max={SERVER_CAPS.maxRequests} value={wizard.maxRequests} onChange={e => set('maxRequests', Number(e.target.value))} />
          <label htmlFor="cyber-rps">Requêtes par seconde (max {SERVER_CAPS.requestsPerSecond})</label>
          <input id="cyber-rps" type="number" step="0.1" className="studio-field" min={0.1} max={SERVER_CAPS.requestsPerSecond} value={wizard.requestsPerSecond} onChange={e => set('requestsPerSecond', Number(e.target.value))} />
          <label htmlFor="cyber-concurrency">Requêtes concurrentes maximales (informatif — serveur : {SERVER_CAPS.maxConcurrentRequests} max, exécution séquentielle en V1)</label>
          <input id="cyber-concurrency" type="number" className="studio-field" min={1} max={SERVER_CAPS.maxConcurrentRequests} value={wizard.maxConcurrentRequests} disabled />
          <label htmlFor="cyber-timeout">Délai d'expiration (ms)</label>
          <input id="cyber-timeout" type="number" className="studio-field" min={1000} max={10000} value={wizard.timeoutMs} onChange={e => set('timeoutMs', Number(e.target.value))} />
          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            Les valeurs saisies ici ne peuvent jamais dépasser les limites du serveur. Si le serveur refuse ou ajuste une valeur au démarrage, l'erreur exacte sera affichée — le rate limiting n'est présenté comme actif que si le backend le confirme.
          </p>
        </div>
      )}

      {step === 'REVIEW' && (
        <div>
          <table className="kv-table">
            <tbody>
              <tr><th>Mission</th><td>{wizard.title}</td></tr>
              <tr><th>Client</th><td>{wizard.clientName}</td></tr>
              <tr><th>Autorisation</th><td>{wizard.authorizationConfirmed ? 'Confirmée' : 'Non confirmée'}</td></tr>
              <tr><th>Cibles autorisées</th><td>{parseList(wizard.hostsText).join(', ') || '(aucune)'}</td></tr>
              <tr><th>Exclusions</th><td>{parseList(wizard.excludedPathsText).join(', ') || '(aucune)'}</td></tr>
              <tr><th>Mode</th><td>{wizard.mode}</td></tr>
              <tr><th>Requêtes maximales</th><td>{wizard.maxRequests}</td></tr>
              <tr><th>Débit</th><td>{wizard.requestsPerSecond} req/s</td></tr>
              <tr><th>Timeout</th><td>{wizard.timeoutMs} ms</td></tr>
            </tbody>
          </table>
        </div>
      )}

      <StudioToolbar>
        <button type="button" className="studio-button" onClick={onBack} disabled={pending}>Retour</button>
        <button
          type="button" className="studio-button studio-button--primary"
          onClick={onNext} disabled={!canAdvance || pending}
        >
          {step === 'REVIEW' ? 'START AUTHORIZED AUDIT' : 'Suivant'}
        </button>
      </StudioToolbar>
    </div>
  );
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

function OverviewTab({ mission, severityCounts }: { mission: CyberMission; severityCounts: Record<string, number> }) {
  return (
    <div>
      <table className="kv-table">
        <tbody>
          <tr><th>Statut</th><td>{STATUS_LABEL[mission.status]}</td></tr>
          <tr><th>Client</th><td>{mission.clientName}</td></tr>
          <tr><th>Créée</th><td>{mission.createdAt}</td></tr>
          <tr><th>Démarrée</th><td>{mission.startedAt ?? 'N/A'}</td></tr>
          <tr><th>Terminée</th><td>{mission.completedAt ?? 'N/A'}</td></tr>
          <tr><th>Requêtes</th><td>{mission.counts.requests}</td></tr>
          <tr><th>Pages</th><td>{mission.counts.pages}</td></tr>
          <tr><th>Findings</th><td>{mission.counts.findings}</td></tr>
        </tbody>
      </table>
      <div className="studio-filter-row">
        {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const).map(sev => (
          <StudioStatus key={sev} label={`${sev}: ${severityCounts[sev] ?? 0}`} tone={SEVERITY_TONE[sev]} compact />
        ))}
      </div>
    </div>
  );
}

function ScopeTab({ mission }: { mission: CyberMission }) {
  if (!mission.scope) return <StudioEmptyState message="Aucun périmètre disponible pour cette mission." />;
  return (
    <table className="kv-table">
      <tbody>
        <tr><th>AUTHORIZED HOSTS</th><td>{mission.scope.allowedHosts.join(', ')}</td></tr>
        <tr><th>AUTHORIZED PORTS</th><td>{mission.scope.allowedPorts.join(', ')}</td></tr>
        <tr><th>AUTHORIZED PROTOCOLS</th><td>{mission.scope.allowedProtocols.join(', ')}</td></tr>
        <tr><th>MAX DEPTH</th><td>{mission.scope.maxDepth}</td></tr>
        <tr><th>MAX REQUESTS</th><td>{mission.scope.maxRequests}</td></tr>
      </tbody>
    </table>
  );
}

function ScanTab({ mission, onCancel, pending }: { mission: CyberMission; onCancel: () => void; pending: boolean }) {
  const running = mission.status === 'RUNNING';
  const elapsed = mission.startedAt
    ? Math.max(0, Math.round((Date.now() - new Date(mission.startedAt).getTime()) / 1000))
    : null;
  return (
    <div>
      <div className="studio-filter-row" style={{ alignItems: 'center' }}>
        <StudioStatus label={STATUS_LABEL[mission.status]} tone={STATUS_TONE[mission.status]} />
        {elapsed !== null && <span>Temps écoulé : {elapsed} s</span>}
      </div>
      <table className="kv-table">
        <tbody>
          <tr><th>Requêtes</th><td>{mission.counts.requests}</td></tr>
          <tr><th>Pages analysées</th><td>{mission.counts.pages} pages analysées</td></tr>
          <tr><th>Findings</th><td>{mission.counts.findings}</td></tr>
        </tbody>
      </table>
      {running && (
        <StudioToolbar destructive={
          <button type="button" className="studio-button studio-button--danger" onClick={onCancel} disabled={pending}>
            STOP AUDIT
          </button>
        }>
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>L'audit est en cours — le nombre de pages restantes n'est pas connu à l'avance.</span>
        </StudioToolbar>
      )}
      {!running && <StudioEmptyState message="Cette mission n'est plus en cours d'exécution." />}
    </div>
  );
}

function FindingsTab({ findings, categories, severityFilter, setSeverityFilter, categoryFilter, setCategoryFilter, statusFilter, setStatusFilter, onOpenDetail }: {
  findings: CyberFinding[]; categories: string[];
  severityFilter: string; setSeverityFilter: (v: string) => void;
  categoryFilter: string; setCategoryFilter: (v: string) => void;
  statusFilter: string; setStatusFilter: (v: string) => void;
  onOpenDetail: (f: CyberFinding) => void;
}) {
  return (
    <div>
      <div className="studio-filter-row">
        <select className="studio-field" value={severityFilter} onChange={e => setSeverityFilter(e.target.value)} aria-label="Filtrer par sévérité">
          <option value="all">Toutes sévérités</option>
          {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="studio-field" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} aria-label="Filtrer par catégorie">
          <option value="all">Toutes catégories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="studio-field" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filtrer par statut">
          <option value="all">Tous statuts</option>
          {['OPEN', 'CONFIRMED', 'FALSE_POSITIVE', 'ACCEPTED_RISK', 'RESOLVED'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {findings.length === 0 ? (
        <StudioEmptyState message="Aucun constat ne correspond à ces filtres." />
      ) : (
        <table>
          <thead><tr><th>Severity</th><th>Finding</th><th>Asset</th><th>Confidence</th><th>Status</th></tr></thead>
          <tbody>
            {findings.map(f => (
              <tr key={f.id} className="studio-result-row" style={{ cursor: 'pointer' }} onClick={() => onOpenDetail(f)}>
                <td><StudioStatus label={f.severity} tone={SEVERITY_TONE[f.severity]} compact /></td>
                <td>{f.title}</td>
                <td>{f.asset}</td>
                <td>{f.confidence}</td>
                <td>{f.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FindingDetailOverlay({ finding, evidence, onClose, onCopyEvidence }: {
  finding: CyberFinding; evidence: CyberEvidence[]; onClose: () => void; onCopyEvidence: (e: CyberEvidence) => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 60 }}>
      <div role="dialog" aria-modal="true" aria-label={finding.title} className="studio-shell glass" style={{ width: 'min(720px, calc(100vw - 24px))' }} onClick={e => e.stopPropagation()}>
        <header className="studio-shell-header">
          <h2 className="studio-shell-title">{finding.title}</h2>
          <button type="button" className="studio-shell-close" aria-label="Fermer le détail" onClick={onClose}>×</button>
        </header>
        <div className="studio-shell-body">
          <table className="kv-table">
            <tbody>
              <tr><th>Severity</th><td><StudioStatus label={finding.severity} tone={SEVERITY_TONE[finding.severity]} compact /></td></tr>
              <tr><th>Confidence</th><td>{finding.confidence}</td></tr>
              <tr><th>Asset</th><td>{finding.asset}</td></tr>
              <tr><th>Status</th><td>{finding.status}</td></tr>
            </tbody>
          </table>
          <section>
            <h3>OBSERVED</h3>
            <p>{finding.description}</p>
          </section>
          <section>
            <h3>INTERPRETATION</h3>
            <p>{finding.impact || 'N/A'}</p>
          </section>
          <section>
            <h3>RECOMMENDATION</h3>
            <p>{finding.recommendation || 'N/A'}</p>
          </section>
          {finding.references.length > 0 && (
            <section>
              <h3>References</h3>
              <ul>{finding.references.map(r => <li key={r}>{r}</li>)}</ul>
            </section>
          )}
          <section>
            <h3>Evidence</h3>
            {evidence.length === 0 ? <p style={{ color: 'var(--text-dim)' }}>Chargement des preuves…</p> : evidence.map(ev => (
              <div key={ev.id} style={{ marginBottom: 10 }}>
                <table className="kv-table">
                  <tbody>
                    <tr><th>URL</th><td>{ev.url}</td></tr>
                    <tr><th>Method</th><td>{ev.method}</td></tr>
                    <tr><th>Timestamp</th><td>{ev.timestamp}</td></tr>
                    <tr><th>Response status</th><td>{ev.responseStatus ?? 'N/A'}</td></tr>
                    <tr><th>SHA256</th><td><code>{ev.sha256}</code></td></tr>
                  </tbody>
                </table>
                <button type="button" className="studio-button" onClick={() => onCopyEvidence(ev)}>COPY EVIDENCE</button>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function EvidenceTab({ findings, evidenceById, onLoadFinding, onCopy }: {
  findings: CyberFinding[]; evidenceById: Record<string, CyberEvidence>;
  onLoadFinding: (f: CyberFinding) => void; onCopy: (e: CyberEvidence) => void;
}) {
  useEffect(() => { findings.forEach(f => onLoadFinding(f)); }, [findings]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = findings.flatMap(f => f.evidenceIds.map(id => evidenceById[id]).filter(Boolean)) as CyberEvidence[];
  const unique = Array.from(new Map(items.map(e => [e.id, e])).values());
  if (unique.length === 0) return <StudioEmptyState message="Aucune preuve enregistrée pour cette mission." />;
  return (
    <div>
      {unique.map(ev => (
        <div key={ev.id} style={{ marginBottom: 14, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
          <table className="kv-table">
            <tbody>
              <tr><th>URL</th><td>{ev.url}</td></tr>
              <tr><th>Method</th><td>{ev.method}</td></tr>
              <tr><th>Timestamp</th><td>{ev.timestamp}</td></tr>
              <tr><th>Response status</th><td>{ev.responseStatus ?? 'N/A'}</td></tr>
              <tr><th>Relevant headers</th><td><pre>{JSON.stringify(ev.relevantHeaders, null, 2)}</pre></td></tr>
              <tr><th>Excerpt</th><td><pre>{ev.excerpt}</pre></td></tr>
              <tr><th>SHA256</th><td><code>{ev.sha256}</code></td></tr>
            </tbody>
          </table>
          <button type="button" className="studio-button" onClick={() => onCopy(ev)}>COPY EVIDENCE</button>
        </div>
      ))}
    </div>
  );
}

function RemediationTab({ groups }: { groups: Record<'QUICK_WINS' | 'SHORT_TERM' | 'LONG_TERM', CyberFinding[]> }) {
  const renderGroup = (label: string, items: CyberFinding[]) => (
    <div key={label} style={{ marginBottom: 16 }}>
      <h3>{label}</h3>
      {items.length === 0 ? <p style={{ color: 'var(--text-dim)' }}>Aucun élément.</p> : (
        <ul>{items.map(f => <li key={f.id}><strong>{f.title}</strong> ({f.asset}) — {f.recommendation || 'N/A'}</li>)}</ul>
      )}
    </div>
  );
  return (
    <div>
      <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        Priorité = fonction de la sévérité et de la confiance (règle explicite, identique au rapport exporté) — jamais une priorité opaque.
      </p>
      {renderGroup('Quick Wins', groups.QUICK_WINS)}
      {renderGroup('Court terme', groups.SHORT_TERM)}
      {renderGroup('Long terme', groups.LONG_TERM)}
    </div>
  );
}

function ReportTab({ missionId }: { missionId: string }) {
  return (
    <div>
      <p>Le rapport HTML est généré côté serveur à partir des données déjà persistées de cette mission (aucune donnée inventée, aucun script exécuté dans le rapport).</p>
      <StudioToolbar>
        <a className="studio-button studio-button--primary" href={cyberReportUrl(missionId, 'html')} target="_blank" rel="noreferrer">
          Ouvrir le rapport HTML
        </a>
        <a className="studio-button" href={cyberReportUrl(missionId, 'json')} target="_blank" rel="noreferrer">
          Exporter les findings (JSON)
        </a>
      </StudioToolbar>
      <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Export PDF : NOT IMPLEMENTED (aucune dépendance lourde ajoutée pour cette V1). Export CSV : non ajouté (V1).</p>
    </div>
  );
}

function HistoryTab({ missions, onOpen }: { missions: CyberMission[]; onOpen: (id: string) => void }) {
  if (missions.length === 0) return <StudioEmptyState message="Aucune mission persistée pour le moment." />;
  return (
    <div>
      <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>RE-SCAN : NOT IMPLEMENTED — chaque audit est une mission indépendante en V1.</p>
      <table>
        <thead><tr><th>Title</th><th>Client</th><th>Date</th><th>Status</th><th>Requests</th><th>Findings</th></tr></thead>
        <tbody>
          {missions.map(m => (
            <tr key={m.id} className="studio-result-row" style={{ cursor: 'pointer' }} onClick={() => onOpen(m.id)}>
              <td>{m.title}</td>
              <td>{m.clientName}</td>
              <td>{m.createdAt}</td>
              <td>{STATUS_LABEL[m.status]}</td>
              <td>{m.counts.requests}</td>
              <td>{m.counts.findings}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
