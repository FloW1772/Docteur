import { useCallback, useEffect, useRef, useState } from 'react';
import { Code2 } from 'lucide-react';
import { startJobPolling } from '../../lib/video-job-polling';
import { metagptRequest, canApprove, canApply, type Mission, type Artifacts, type MissionEvent } from '../../lib/metagpt-studio';
import StudioShell from '../studio/StudioShell';
import StudioTabs from '../studio/StudioTabs';
import StudioStatus, { type StudioStatusTone } from '../studio/StudioStatus';
import StudioToolbar from '../studio/StudioToolbar';
import StudioEmptyState from '../studio/StudioEmptyState';
import StudioErrorState from '../studio/StudioErrorState';
import StudioArtifactViewer from '../studio/StudioArtifactViewer';
import StudioTimeline from '../studio/StudioTimeline';
import StudioSplitPane from '../studio/StudioSplitPane';
import StudioCodeFiles from '../studio/StudioCodeFiles';
import { studioRequestError } from '../../lib/studio-errors';

const RUNNING = new Set(['PLANNING', 'GENERATING', 'PREPARING_DIFF', 'APPLYING']);
const FINISHED = new Set(['APPLIED', 'FAILED', 'CANCELLED', 'BLOCKED_BY_POLICY', 'APPROVAL_INVALIDATED']);
const ERROR_STATES = new Set(['FAILED', 'BLOCKED_BY_POLICY', 'APPROVAL_INVALIDATED']);

// Pipeline stepper: nominal path only (error states are shown separately via
// StudioStatus, never collapsed into this stepper — this fixes the previous
// bug where an error state made indexOf() return -1 and the progress bar
// silently reset to the very start).
const PIPELINE_STEPS = [
  { state: 'CREATED', label: 'Brief' },
  { state: 'TASKS_READY', label: 'PRD / Design / Tasks' },
  { state: 'CODE_READY', label: 'Code' },
  { state: 'AWAITING_APPROVAL', label: 'Diff' },
  { state: 'APPLIED', label: 'Apply' },
] as const;

// Maps the full state machine onto the 5 stepper checkpoints above, so
// intermediate states (PLANNING, GENERATING, PREPARING_DIFF, APPLYING) still
// show progress toward their next checkpoint instead of vanishing between steps.
const STEP_INDEX: Record<string, number> = {
  CREATED: 0,
  PLANNING: 0,
  PRD_READY: 1, DESIGN_READY: 1, TASKS_READY: 1,
  GENERATING: 1, CODE_READY: 2,
  PREPARING_DIFF: 2, AWAITING_APPROVAL: 3,
  APPLYING: 3, APPLIED: 4,
};

const STATUS_TONE: Record<string, StudioStatusTone> = {
  CREATED: 'neutral',
  PLANNING: 'active', GENERATING: 'active', PREPARING_DIFF: 'active', APPLYING: 'active',
  PRD_READY: 'neutral', DESIGN_READY: 'neutral', TASKS_READY: 'neutral', CODE_READY: 'neutral',
  AWAITING_APPROVAL: 'warning',
  APPLIED: 'success',
  FAILED: 'error', CANCELLED: 'error', BLOCKED_BY_POLICY: 'error', APPROVAL_INVALIDATED: 'error',
};

const TABS = ['OVERVIEW', 'PRD', 'DESIGN', 'TASKS', 'CODE', 'DIFF', 'SECURITY', 'DEPENDENCIES', 'ACTIVITY'] as const;
type Tab = typeof TABS[number];

const remembered = () => { try { return localStorage.getItem('metagpt-mission') || ''; } catch { return ''; } };

function formatDuration(startIso?: string, endIso?: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}min ${seconds % 60}s`;
}

export default function MetaGptStudioModal({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState(remembered);
  const [history, setHistory] = useState<Mission[]>([]);
  const [mission, setMission] = useState<Mission | null>(null);
  const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
  const [tab, setTab] = useState<Tab>('OVERVIEW');
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [mode, setMode] = useState('PLAN_ONLY');
  const [targetScope, setTargetScope] = useState('');
  const [files, setFiles] = useState('sample.js');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeId = useRef(id); activeId.current = id;

  const updateHistory = useCallback(async () => {
    const result = await metagptRequest<{ missions: Mission[] }>();
    setHistory(result.missions);
  }, []);

  useEffect(() => { void updateHistory().catch(e => setError(e.message)); }, [updateHistory]);

  // Keyed only on `id` (not `busy`) — restarting this effect on every action's
  // busy toggle used to reset `tab`/`mission`/`artifacts` mid-flow (e.g. right
  // after clicking "Approuver", the tab would snap back to OVERVIEW before the
  // approval confirmation could ever be seen).
  useEffect(() => {
    try {
      if (id) localStorage.setItem('metagpt-mission', id);
      else localStorage.removeItem('metagpt-mission');
    } catch { /* Optional preference storage. */ }
    setMission(null); setArtifacts(null); setTab('OVERVIEW');
    if (!id) return;
    return startJobPolling(async () => {
      try {
        const [detail, content] = await Promise.all([
          metagptRequest<{ mission: Mission }>(`/${id}`),
          metagptRequest<Artifacts>(`/${id}/artifacts`),
        ]);
        return { ...detail, content };
      } catch (e) {
        if (activeId.current === id) setError((e as Error).message);
        throw e;
      }
    }, () => 'running', detail => {
      setMission(detail.mission); setArtifacts(detail.content);
    }, () => {}, { intervalMs: 1000 });
    // Always reports 'running' (never terminal) so this poll loop never
    // self-stops — the mission's own current_state (shown via StudioStatus)
    // is the real source of truth for "is this mission still active", not
    // the polling mechanism. Poll stops only when the modal/mission changes
    // (effect cleanup) or the component unmounts.
  }, [id]);

  async function action(name: string) {
    if (!id) return;
    setBusy(true); setError('');
    try {
      await metagptRequest(`/${id}/${name}`, name === 'generate'
        ? { files: files.split(/[\n,]/).map(f => f.trim()).filter(Boolean) }
        : name === 'approve'
          ? { diff_sha256: mission?.metadata.prepare_apply?.diff_sha256, files: mission?.metadata.prepare_apply?.files.map(f => f.destination) }
          : undefined, 'POST');
      await updateHistory();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function create() {
    setBusy(true); setError('');
    try {
      const result = await metagptRequest<{ id: string }>('', {
        title, requirement, mode, ...(targetScope.trim() ? { target_scope: targetScope.trim() } : {}),
      }, 'POST');
      setId(result.id); await updateHistory();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const state = mission?.current_state || '';
  const diff = mission?.metadata.prepare_apply;
  const locked = busy || RUNNING.has(state);
  const isError = ERROR_STATES.has(state);
  const stepIndex = STEP_INDEX[state] ?? 0;

  return (
    <StudioShell
      icon={<Code2 size={18} />}
      title="Studio MetaGPT"
      onClose={onClose}
      subtitle="MetaGPT ne modifie pas Docteur tant que vous n'approuvez pas ce diff — Ollama local, code conservé comme texte, application V1 dans un sample isolé."
    >
      <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
        <button type="button" className="studio-button" disabled={locked} onClick={() => { setId(''); setError(''); }}>
          Nouvelle mission
        </button>
        <select
          aria-label="Missions enregistrées"
          className="studio-field"
          style={{ width: 'auto', flex: 1, margin: 0 }}
          disabled={locked}
          value={id}
          onChange={e => setId(e.target.value)}
        >
          <option value="">Choisir une mission</option>
          {history.map(m => <option key={m.id} value={m.id}>{m.title} — {m.current_state}</option>)}
        </select>
      </div>

      {error && <StudioErrorState message={error} />}

      {!id ? (
        <form onSubmit={e => { e.preventDefault(); void create(); }}>
          <label>Titre
            <input className="studio-field" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} />
          </label>
          <label>Requirement
            <textarea className="studio-field" required maxLength={4000} rows={5} value={requirement} onChange={e => setRequirement(e.target.value)} />
          </label>
          <label>Périmètre cible (optionnel)
            <input className="studio-field" maxLength={200} placeholder="ex: module de facturation" value={targetScope} onChange={e => setTargetScope(e.target.value)} />
          </label>
          <label>Mode
            <select aria-label="Mode" className="studio-field" value={mode} onChange={e => setMode(e.target.value)}>
              <option value="PLAN_ONLY">PLAN_ONLY — planification uniquement (PRD/Design/Tasks)</option>
              <option value="PLAN_AND_CODE_TEXT_ONLY">PLAN_AND_CODE_TEXT_ONLY — planification puis génération de code texte</option>
            </select>
          </label>
          <button type="submit" className="studio-button studio-button--primary" disabled={busy}>Créer la mission</button>
        </form>
      ) : mission ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{mission.title}</h3>
            <StudioStatus label={`État : ${state}`} tone={STATUS_TONE[state] ?? 'neutral'} />
          </div>

          {/* Pipeline stepper — error states never collapse this to step 0; they're
              shown as a distinct StudioErrorState below instead. */}
          <ol className="studio-tabs" style={{ borderBottom: 'none', margin: '12px 0' }} aria-label="Progression du pipeline">
            {PIPELINE_STEPS.map((step, i) => (
              <li key={step.state} className={`studio-tab${i <= stepIndex && !isError ? ' studio-tab--active' : ''}`} style={{ cursor: 'default' }}>
                {step.label}{i < PIPELINE_STEPS.length - 1 ? ' →' : ''}
              </li>
            ))}
          </ol>

          {mission.error_message && (
            <StudioErrorState message={studioRequestError(mission.error_message)} />
          )}

          <StudioToolbar
            destructive={!FINISHED.has(state) && state !== 'APPLYING' && (
              <button type="button" className="studio-button studio-button--danger" onClick={() => void action('cancel')} disabled={busy}>
                Annuler
              </button>
            )}
          >
            {state === 'CREATED' && <button type="button" className="studio-button studio-button--primary" disabled={locked} onClick={() => void action('plan')}>Démarrer</button>}
            {state === 'CODE_READY' && <button type="button" className="studio-button studio-button--primary" disabled={locked} onClick={() => void action('prepare-apply')}>Préparer le diff</button>}
            {diff && (
              <>
                <button type="button" className="studio-button" disabled={locked || !canApprove(mission, diff) || mission.approved} onClick={() => void action('approve')}>Approuver CE diff</button>
                <button type="button" className="studio-button studio-button--primary" disabled={locked || !canApply(mission, diff)} onClick={() => void action('apply')}>Appliquer</button>
              </>
            )}
          </StudioToolbar>

          {state === 'TASKS_READY' && mission.mode === 'PLAN_AND_CODE_TEXT_ONLY' && (
            <div style={{ margin: '10px 0' }}>
              <label>Fichiers à générer (un par ligne)
                <textarea className="studio-field" value={files} onChange={e => setFiles(e.target.value)} />
              </label>
              <button type="button" className="studio-button studio-button--primary" disabled={locked || !files.trim()} onClick={() => void action('generate')}>Générer le code texte</button>
            </div>
          )}

          <StudioTabs tabs={TABS} active={tab} onChange={setTab}>

          {tab === 'OVERVIEW' && (
            <StudioSplitPane
              secondaryLabel="Propriétés de la mission"
              main={(
                <div>
                  <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>{mission.metadata.target_scope ? `Périmètre : ${mission.metadata.target_scope}` : 'Aucun périmètre cible renseigné.'}</p>
                  <p style={{ fontSize: 13 }}>Mode : <strong>{mission.mode}</strong></p>
                </div>
              )}
              secondary={(
                <dl style={{ fontSize: 12, margin: 0 }}>
                  <dt style={{ color: 'var(--text-dim)' }}>Modèle</dt>
                  <dd style={{ margin: '2px 0 10px' }}>{mission.model_used || '—'}</dd>
                  <dt style={{ color: 'var(--text-dim)' }}>Créée</dt>
                  <dd style={{ margin: '2px 0 10px' }}>{mission.created_at ? new Date(mission.created_at).toLocaleString() : '—'}</dd>
                  <dt style={{ color: 'var(--text-dim)' }}>Durée</dt>
                  <dd style={{ margin: '2px 0 10px' }}>{formatDuration(mission.created_at, mission.finished_at)}</dd>
                </dl>
              )}
            />
          )}

          {tab === 'PRD' && (artifacts?.planning.prd
            ? <StudioArtifactViewer title="PRD" content={artifacts.planning.prd} />
            : <StudioEmptyState message="PRD pas encore disponible — démarrez la planification." />)}

          {tab === 'DESIGN' && (artifacts?.planning.design
            ? <StudioArtifactViewer title="Design" content={artifacts.planning.design} />
            : <StudioEmptyState message="Design pas encore disponible — démarrez la planification." />)}

          {tab === 'TASKS' && (artifacts?.planning.tasks
            ? <StudioArtifactViewer title="Tasks" content={artifacts.planning.tasks} />
            : <StudioEmptyState message="Tasks pas encore disponibles — démarrez la planification." />)}

          {tab === 'CODE' && (
            (artifacts?.codegen?.length ?? 0) > 0
              ? <StudioCodeFiles key={mission.id} files={artifacts!.codegen} />
              : <StudioEmptyState message="Aucun fichier généré pour l'instant." />
          )}

          {tab === 'DIFF' && (diff ? (
            <div>
              <p>Mission : <code>{mission.id}</code> · {diff.files.length} fichier(s) · {diff.security_findings.length} signalement(s) · {diff.blocked_findings} bloquant(s)</p>
              <p>Approbation : {mission.approved ? (canApply(mission, diff) ? 'valide pour ce diff' : 'à revérifier') : 'non accordée'}</p>
              <p style={{ overflowWrap: 'anywhere', fontSize: 12 }}>DIFF_SHA256 : <code>{diff.diff_sha256}</code></p>
              {diff.apply_simulation && <p style={{ fontSize: 12 }}>Simulation d'application : <strong>{diff.apply_simulation}</strong></p>}
              <ul style={{ fontSize: 13 }}>
                {diff.files?.map(f => <li key={f.destination}>{f.operation} — {f.destination}</li>)}
              </ul>
              <StudioArtifactViewer title="Diff complet" content={diff.diff_text} />
              {mission.approved && <p style={{ color: 'var(--emerald)', fontSize: 13 }}>Ce diff a été approuvé. L'application reste une action séparée.</p>}
              {diff.source_manifest_sha256 && (
                <p style={{ fontSize: 11, color: 'var(--text-dim)' }}>Hash du manifeste source : <code>{diff.source_manifest_sha256}</code></p>
              )}
            </div>
          ) : <StudioEmptyState message="Aucun diff préparé pour l'instant." />)}

          {tab === 'SECURITY' && (
            (diff?.security_findings?.length ?? 0) > 0 ? (
              <ul style={{ fontSize: 13, paddingLeft: 16 }}>
                {diff!.security_findings.map((f, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    <StudioStatus compact label={f.classification} tone={f.classification === 'BLOCKED' ? 'error' : 'warning'} />
                    {' '}{f.file} — <code style={{ fontSize: 11 }}>{f.pattern}</code>
                  </li>
                ))}
              </ul>
            ) : <StudioEmptyState message="Aucun signalement de sécurité." />
          )}

          {tab === 'DEPENDENCIES' && (
            (diff?.dependency_requests?.length ?? 0) > 0 ? (
              <ul style={{ fontSize: 13, paddingLeft: 16 }}>
                {diff!.dependency_requests.map((d, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    <strong>{d.package}</strong>{d.reason ? ` — ${d.reason}` : ''}
                  </li>
                ))}
              </ul>
            ) : <StudioEmptyState message="Aucune dépendance demandée." />
          )}

          {tab === 'ACTIVITY' && (
            (mission.events?.length ?? 0) > 0 ? (
              <StudioTimeline
                entries={mission.events.map((e: MissionEvent) => ({
                  id: e.id,
                  kind: e.from_state ? `${e.from_state} → ${e.to_state}` : e.to_state,
                  when: e.created_at ? new Date(e.created_at).toLocaleString() : null,
                  title: null,
                }))}
              />
            ) : <StudioEmptyState message="Aucun événement enregistré." />
          )}
          </StudioTabs>
        </>
      ) : (
        <p role="status">Chargement de la mission…</p>
      )}
    </StudioShell>
  );
}
