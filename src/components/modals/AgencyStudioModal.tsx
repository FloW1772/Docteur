// [Agency V1] Agency Studio — objective → plan → agents → tasks (dependencies,
// parallelism) → artifacts → final synthesis, with approvals and STOP.
// All rules are enforced by the server (cortex-server/src/lib/agency.js); this
// view only displays the state and sends explicit user decisions.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Network, OctagonX, Play, RotateCcw, Ban, Check, X as XIcon, ShieldCheck } from 'lucide-react';
import StudioShell from '../studio/StudioShell';
import StudioStatus, { type StudioStatusTone } from '../studio/StudioStatus';
import StudioEmptyState from '../studio/StudioEmptyState';
import LoadingSpinner from '../loading/LoadingSpinner';
import { cortexClient } from '../../lib/cortex/client';
import type { AgencyRun, AgencyRunStatus, AgencySnapshot, AgencyTask, AgencyTaskStatus, AgencyError } from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
  /** Imports the outputs a human approved for saving (existing agent-outputs pipeline). */
  onOutputsSaved?: () => Promise<unknown> | void;
}

const RUN_LABEL: Record<AgencyRunStatus, [string, StudioStatusTone]> = {
  PLANNING: ['Planification', 'active'], QUEUED: ['Plan prêt', 'neutral'], RUNNING: ['En cours', 'active'],
  WAITING: ['En attente de votre décision', 'warning'], WAITING_APPROVAL: ['Approbation requise', 'warning'],
  COMPLETED: ['Terminé', 'success'], FAILED: ['Échec partiel', 'error'], CANCELLED: ['Annulé', 'neutral'], REVOKED: ['Arrêté (STOP)', 'error'],
};
const TASK_LABEL: Record<AgencyTaskStatus, [string, StudioStatusTone]> = {
  QUEUED: ['Prête', 'neutral'], WAITING: ['Attend ses dépendances', 'neutral'], RUNNING: ['En cours', 'active'],
  WAITING_APPROVAL: ['Approbation requise', 'warning'], COMPLETED: ['Terminée', 'success'], FAILED: ['Échec', 'error'],
  CANCELLED: ['Annulée', 'neutral'], REVOKED: ['Révoquée', 'error'], BLOCKED: ['Bloquée (dépendance)', 'warning'], UNKNOWN: ['Inconnue (redémarrage)', 'warning'],
};
const FINAL: AgencyRunStatus[] = ['COMPLETED', 'CANCELLED', 'REVOKED'];
const ACTIVE: AgencyRunStatus[] = ['PLANNING', 'RUNNING'];
const RETRYABLE: AgencyTaskStatus[] = ['FAILED', 'CANCELLED', 'BLOCKED', 'UNKNOWN'];
const CANCELLABLE: AgencyTaskStatus[] = ['QUEUED', 'WAITING', 'RUNNING', 'WAITING_APPROVAL'];

function errorText(err: unknown): string {
  const e = err as AgencyError;
  return e?.code ? `${e.code}` : (e?.message || 'Erreur inconnue');
}

export default function AgencyStudioModal({ onClose, onOutputsSaved }: Props) {
  const [runs, setRuns] = useState<AgencyRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AgencySnapshot | null>(null);
  const [objective, setObjective] = useState('');
  const [strictLocal, setStrictLocal] = useState(true);
  const [concurrency, setConcurrency] = useState(2);
  const [saveResult, setSaveResult] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshRuns = useCallback(async () => {
    try { setRuns((await cortexClient.agencyListRuns()).runs); } catch (err) { setError(errorText(err)); }
  }, []);
  const refreshRun = useCallback(async (id: string) => {
    try {
      const next = await cortexClient.agencyGetRun(id);
      if (selectedRef.current === id) setSnapshot(next);
    } catch (err) { setError(errorText(err)); }
  }, []);

  useEffect(() => { void refreshRuns(); }, [refreshRuns]);
  useEffect(() => { if (selectedId) void refreshRun(selectedId); else setSnapshot(null); }, [selectedId, refreshRun]);

  // Poll while the selected run is planning or running.
  const status = snapshot?.run.status;
  useEffect(() => {
    if (!selectedId || !status || !ACTIVE.includes(status)) return undefined;
    const id = window.setInterval(() => { void refreshRun(selectedId); void refreshRuns(); }, 1_500);
    return () => window.clearInterval(id);
  }, [selectedId, status, refreshRun, refreshRuns]);

  async function act(label: string, fn: () => Promise<AgencySnapshot | unknown>) {
    setBusy(label);
    setError(null);
    try {
      const result = await fn();
      if (result && typeof result === 'object' && 'run' in (result as AgencySnapshot)) {
        const snap = result as AgencySnapshot;
        if (selectedRef.current === snap.run.id) setSnapshot(snap);
      }
      await refreshRuns();
      return result;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createRun() {
    const snap = await act('create', () => cortexClient.agencyCreateRun({ objective: objective.trim(), strictLocal, maxConcurrency: concurrency, saveResult }));
    if (snap && typeof snap === 'object' && 'run' in (snap as AgencySnapshot)) {
      setSelectedId((snap as AgencySnapshot).run.id);
      setSnapshot(snap as AgencySnapshot);
      setObjective('');
    }
  }

  async function stopAll() {
    const result = await act('stop-all', () => cortexClient.agencyStopAll()) as { stopped?: number } | null;
    if (result) setNotice(`STOP : ${result.stopped ?? 0} exécution(s) arrêtée(s).`);
    if (selectedId) await refreshRun(selectedId);
  }

  async function decide(approvalId: string, accepted: boolean, digest: string) {
    const snap = await act(accepted ? 'approve' : 'reject', () => cortexClient.agencyDecideApproval(approvalId, accepted, digest));
    if (snap && accepted) {
      setNotice('Enregistrement approuvé : le neurone est créé.');
      await onOutputsSaved?.();
    }
  }

  const run = snapshot?.run ?? null;
  const tasks = snapshot?.tasks ?? [];
  const byKey = useMemo(() => new Map(tasks.map(t => [t.key, t])), [tasks]);
  const done = tasks.filter(t => t.status === 'COMPLETED').length;
  const pendingApproval = snapshot?.approvals.find(a => a.status === 'PENDING') ?? null;
  const objectiveValid = objective.trim().length >= 8;

  return (
    <StudioShell
      icon={<Network size={18} />}
      title="Agency"
      onClose={onClose}
      subtitle={<>Orchestration d’agents. Aucun outil shell, fichier, réseau ou processus. Enregistrer un résultat exige votre approbation. Strict Local par défaut.</>}
    >
      <div className="agency-layout">
        <aside className="agency-side" aria-label="Exécutions Agency">
          <button type="button" className="agency-stop-all" onClick={() => { void stopAll(); }} disabled={busy === 'stop-all'}>
            <OctagonX size={14} aria-hidden="true" /> STOP — tout arrêter
          </button>
          <form className="agency-new" onSubmit={e => { e.preventDefault(); if (objectiveValid) void createRun(); }}>
            <label htmlFor="agency-objective" className="agency-label">Objectif</label>
            <textarea id="agency-objective" value={objective} onChange={e => setObjective(e.target.value)} rows={4} maxLength={4000} placeholder="Ex. : Préparer une synthèse de ce que je sais sur la cosmologie, avec les points à approfondir." />
            <label className="agency-check"><input type="checkbox" checked={strictLocal} onChange={e => setStrictLocal(e.target.checked)} /> Strict Local (aucun cloud)</label>
            <label className="agency-check"><input type="checkbox" checked={saveResult} onChange={e => setSaveResult(e.target.checked)} /> Proposer d’enregistrer la synthèse comme neurone (approbation requise)</label>
            <label className="agency-check" htmlFor="agency-concurrency">Tâches en parallèle (max)
              <select id="agency-concurrency" value={concurrency} onChange={e => setConcurrency(Number(e.target.value))}>
                {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {!strictLocal && <p className="agency-warning" role="note">Cloud autorisé pour cette exécution : les réglages du routeur et du mode Strict Local global s’appliquent toujours.</p>}
            <button type="submit" className="agency-btn agency-btn--primary" disabled={!objectiveValid || busy === 'create'}>Planifier</button>
          </form>
          <ul className="agency-runs">
            {runs.map(r => (
              <li key={r.id}>
                <button type="button" className={`agency-run-item${r.id === selectedId ? ' is-selected' : ''}`} aria-current={r.id === selectedId ? 'true' : undefined} onClick={() => setSelectedId(r.id)}>
                  <span className="agency-run-objective">{r.objective}</span>
                  <StudioStatus label={RUN_LABEL[r.status][0]} tone={RUN_LABEL[r.status][1]} compact />
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="agency-main" aria-label="Détail de l’exécution">
          {error && <p className="agency-error" role="alert">Erreur : {error}</p>}
          {notice && <p className="agency-notice" role="status">{notice}</p>}
          {!run ? (
            <StudioEmptyState message="Formulez un objectif : Agency propose un plan, vous le lancez, et vous gardez la main sur ce qui est enregistré." />
          ) : (
            <>
              <header className="agency-run-head">
                <h3 className="agency-run-title">{run.objective}</h3>
                <StudioStatus label={RUN_LABEL[run.status][0]} tone={RUN_LABEL[run.status][1]} />
                <span className="agency-badge">{run.strictLocal ? 'Strict Local' : 'Cloud autorisé'}</span>
                <span className="agency-badge">Parallèle ≤ {run.maxConcurrency}</span>
              </header>
              <div className="agency-actions">
                {run.status === 'QUEUED' && <button type="button" className="agency-btn agency-btn--primary" onClick={() => { void act('start', () => cortexClient.agencyStartRun(run.id)); }}><Play size={13} aria-hidden="true" /> Démarrer</button>}
                {run.status === 'WAITING' && <button type="button" className="agency-btn" onClick={() => { void act('resume', () => cortexClient.agencyResumeRun(run.id)); }}><Play size={13} aria-hidden="true" /> Reprendre</button>}
                {!FINAL.includes(run.status) && <button type="button" className="agency-btn" onClick={() => { void act('cancel', () => cortexClient.agencyCancelRun(run.id)); }}><Ban size={13} aria-hidden="true" /> Annuler l’exécution</button>}
                {!FINAL.includes(run.status) && <button type="button" className="agency-btn agency-btn--danger" onClick={() => { void act('stop', () => cortexClient.agencyStopRun(run.id)); }}><OctagonX size={13} aria-hidden="true" /> STOP</button>}
              </div>
              {run.status === 'PLANNING' && <LoadingSpinner label="Planification de l’objectif…" />}
              {run.error && <p className="agency-error" role="alert">{run.error}</p>}
              {run.plan.source === 'fallback' && <p className="agency-warning" role="note">Plan de secours utilisé (proposition du modèle refusée : {(run.plan.warnings ?? []).join(', ') || 'indisponible'}).</p>}

              {tasks.length > 0 && (
                <div className="agency-progress">
                  <div className="dl-bar" role="progressbar" aria-label="Progression de l’exécution" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={done} aria-valuetext={`${done} tâche(s) terminée(s) sur ${tasks.length}`}>
                    <span className="dl-bar-fill" style={{ width: `${Math.round((done / tasks.length) * 100)}%` }} />
                  </div>
                  <span className="agency-progress-text">{done}/{tasks.length} tâches terminées</span>
                </div>
              )}

              {pendingApproval && (
                <div className="agency-approval" role="region" aria-label="Approbation requise">
                  <p className="agency-approval-title"><ShieldCheck size={14} aria-hidden="true" /> Enregistrer comme neurone : « {pendingApproval.summary.title} »</p>
                  <p className="agency-approval-excerpt">{pendingApproval.summary.excerpt}{(pendingApproval.summary.chars ?? 0) > (pendingApproval.summary.excerpt?.length ?? 0) ? '…' : ''}</p>
                  <p className="agency-approval-meta">{pendingApproval.summary.chars} caractères · empreinte {pendingApproval.digest.slice(0, 12)} · expire le {new Date(pendingApproval.expiresAt).toLocaleString('fr-FR')}</p>
                  <div className="agency-actions">
                    <button type="button" className="agency-btn agency-btn--primary" onClick={() => { void decide(pendingApproval.id, true, pendingApproval.digest); }} disabled={busy !== null}><Check size={13} aria-hidden="true" /> Approuver l’enregistrement</button>
                    <button type="button" className="agency-btn" onClick={() => { void decide(pendingApproval.id, false, pendingApproval.digest); }} disabled={busy !== null}><XIcon size={13} aria-hidden="true" /> Refuser</button>
                  </div>
                </div>
              )}

              <ol className="agency-tasks" aria-label="Tâches">
                {tasks.map(task => <TaskItem key={task.id} task={task} snapshot={snapshot!} byKey={byKey} busy={busy} act={act} />)}
              </ol>

              {run.synthesis && (
                <section className="agency-synthesis" aria-label="Synthèse finale">
                  <h4>Synthèse finale</h4>
                  <div className="agency-text">{run.synthesis}</div>
                </section>
              )}

              {snapshot!.events.length > 0 && (
                <details className="agency-events">
                  <summary>Journal ({snapshot!.events.length})</summary>
                  <ul>{snapshot!.events.slice(-30).map(e => <li key={e.id}><time>{new Date(e.at).toLocaleTimeString('fr-FR')}</time> {e.type}</li>)}</ul>
                </details>
              )}
            </>
          )}
        </section>
      </div>
    </StudioShell>
  );
}

function TaskItem({ task, snapshot, byKey, busy, act }: {
  task: AgencyTask; snapshot: AgencySnapshot; byKey: Map<string, AgencyTask>; busy: string | null;
  act: (label: string, fn: () => Promise<unknown>) => Promise<unknown>;
}) {
  const agent = snapshot.agents[task.agent];
  const [label, tone] = TASK_LABEL[task.status];
  return (
    <li className={`agency-task agency-task--${task.status.toLowerCase()}`} data-task-key={task.key}>
      <div className="agency-task-head">
        <span className="agency-task-title">{task.title}</span>
        <StudioStatus label={label} tone={tone} compact />
      </div>
      <p className="agency-task-meta">
        Agent : <strong>{agent?.label ?? task.agent}</strong> · Outils : {task.tools.join(', ') || 'aucun'}
        {task.dependsOn.length > 0 && <> · Dépend de : {task.dependsOn.map(k => byKey.get(k)?.title ?? k).join(', ')}</>}
        {task.attempt > 1 && <> · Tentative {task.attempt}/{task.maxAttempts}</>}
      </p>
      {task.status === 'RUNNING' && <LoadingSpinner label="En cours…" />}
      {task.error && task.status !== 'COMPLETED' && <p className="agency-task-error">{task.error}</p>}
      {task.result && task.status === 'COMPLETED' && (
        <details className="agency-task-result"><summary>Résultat</summary><div className="agency-text">{task.result}</div></details>
      )}
      <div className="agency-actions">
        {RETRYABLE.includes(task.status) && !['CANCELLED', 'REVOKED', 'COMPLETED'].includes(snapshot.run.status) && (
          <button type="button" className="agency-btn" disabled={busy !== null} onClick={() => { void act('retry', () => cortexClient.agencyRetryTask(task.id)); }}><RotateCcw size={12} aria-hidden="true" /> Réessayer</button>
        )}
        {CANCELLABLE.includes(task.status) && !['CANCELLED', 'REVOKED', 'COMPLETED'].includes(snapshot.run.status) && (
          <button type="button" className="agency-btn" disabled={busy !== null} onClick={() => { void act('cancel-task', () => cortexClient.agencyCancelTask(task.id)); }} aria-label={`Annuler la tâche ${task.title}`}><Ban size={12} aria-hidden="true" /> Annuler</button>
        )}
      </div>
    </li>
  );
}
