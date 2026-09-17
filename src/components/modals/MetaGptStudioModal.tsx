import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { X, Code2 } from 'lucide-react';
import { startJobPolling } from '../../lib/video-job-polling';
import { metagptRequest, canApprove, canApply, type Mission, type Artifacts } from '../../lib/metagpt-studio';

const field: CSSProperties = { display: 'block', width: '100%', background: '#171c27', border: '1px solid #455066', borderRadius: 6, padding: 9, color: '#e2e8f0', margin: '6px 0 14px' };
const button: CSSProperties = { background: '#283750', color: '#e2e8f0', border: '1px solid #536687', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' };
const running = new Set(['PLANNING', 'GENERATING', 'PREPARING_DIFF', 'APPLYING']);
const finished = new Set(['APPLIED', 'FAILED', 'CANCELLED', 'BLOCKED_BY_POLICY', 'APPROVAL_INVALIDATED']);
const steps = ['CREATED', 'PLANNING', 'PRD_READY', 'DESIGN_READY', 'TASKS_READY', 'GENERATING', 'CODE_READY', 'PREPARING_DIFF', 'AWAITING_APPROVAL', 'APPLYING', 'APPLIED'];
const remembered = () => { try { return localStorage.getItem('metagpt-mission') || ''; } catch { return ''; } };
function TextArtifact({ title, content }: { title: string; content: string | null | undefined }) {
  return content ? <details open><summary>{title}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, background: '#090d15', fontSize: 12 }}>{content}</pre></details> : null;
}
export default function MetaGptStudioModal({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState(remembered);
  const [history, setHistory] = useState<Mission[]>([]);
  const [mission, setMission] = useState<Mission | null>(null);
  const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [mode, setMode] = useState('PLAN_ONLY');
  const [files, setFiles] = useState('sample.js');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeId = useRef(id); activeId.current = id;
  const updateHistory = useCallback(async () => {
    const result = await metagptRequest<{ missions: Mission[] }>(); setHistory(result.missions);
  }, []);
  useEffect(() => { void updateHistory().catch(e => setError(e.message)); }, [updateHistory]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    try { if (id) localStorage.setItem('metagpt-mission', id); else localStorage.removeItem('metagpt-mission'); } catch { /* Optional preference storage. */ }
    setMission(null); setArtifacts(null);
    if (!id) return;
    return startJobPolling(async () => {
      try {
        const [detail, content] = await Promise.all([
          metagptRequest<{ mission: Mission }>(`/${id}`), metagptRequest<Artifacts>(`/${id}/artifacts`),
        ]);
        return { ...detail, content };
      } catch (e) { if (activeId.current === id) setError((e as Error).message); throw e; }
    }, detail => busy || running.has(detail.mission.current_state) ? 'running' : 'completed', detail => {
      setMission(detail.mission); setArtifacts(detail.content);
    }, () => {}, { intervalMs: 1000 });
  }, [id, busy]);
  async function action(name: string) {
    if (!id) return;
    setBusy(true); setError('');
    try {
      await metagptRequest(`/${id}/${name}`, name === 'generate' ? { files: files.split(/[\n,]/).map(f => f.trim()).filter(Boolean) } : name === 'approve' ? {
        diff_sha256: mission?.metadata.prepare_apply?.diff_sha256,
        files: mission?.metadata.prepare_apply?.files.map(f => f.destination),
      } : undefined, 'POST');
      await updateHistory();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError('');
    try {
      const result = await metagptRequest<{ id: string }>('', { title, requirement, mode }, 'POST');
      setId(result.id); await updateHistory();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const state = mission?.current_state || '';
  const diff = mission?.metadata.prepare_apply;
  const locked = busy || running.has(state);
  return <div className="modal-backdrop" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="Studio MetaGPT" onClick={e => e.stopPropagation()} style={{ width: 'min(960px, calc(100vw - 24px))', maxHeight: '90vh', overflowY: 'auto', background: '#0d0f14', color: '#e2e8f0', border: '1px solid #455066', borderRadius: 12, padding: 22 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Code2 /><h2 style={{ flex: 1 }}>Studio MetaGPT</h2><button style={button} aria-label="Fermer Studio MetaGPT" onClick={onClose}><X size={18} /></button></header>
      <p>MetaGPT ne modifie pas Docteur tant que vous n’approuvez pas ce diff.</p>
      <p style={{ color: '#a9b6ce', fontSize: 13 }}>Ollama local · code conservé comme texte · application V1 dans un sample isolé.</p>
      <div style={{ display: 'flex', gap: 10 }}><button style={button} disabled={locked} onClick={() => { setId(''); setError(''); }}>Nouvelle mission</button>
        <select aria-label="Missions enregistrées" style={{ ...field, width: 'auto', flex: 1 }} disabled={locked} value={id} onChange={e => setId(e.target.value)}><option value="">Choisir une mission</option>{history.map(m => <option key={m.id} value={m.id}>{m.title} — {m.current_state}</option>)}</select></div>
      {error && <p role="alert" style={{ color: '#ffaaaa' }}>{error}</p>}
      {!id ? <form onSubmit={e => { e.preventDefault(); void create(); }}>
        <label>Titre<input style={field} required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>Requirement<textarea style={field} required maxLength={4000} rows={5} value={requirement} onChange={e => setRequirement(e.target.value)} /></label>
        <label>Mode<select aria-label="Mode" style={field} value={mode} onChange={e => setMode(e.target.value)}><option value="PLAN_ONLY">PLAN_ONLY</option><option value="PLAN_AND_CODE_TEXT_ONLY">PLAN_AND_CODE_TEXT_ONLY</option></select></label>
        <button style={button} disabled={busy} type="submit">Créer la mission</button>
      </form> : mission ? <>
        <h3>{mission.title}</h3><p role="status">État : {state}</p>
        <progress aria-label="Progression mission" max={10} value={Math.max(0, steps.indexOf(state))} style={{ width: '100%' }} />
        {mission.error_message && <p role="alert" style={{ color: '#ffaaaa' }}>{mission.error_message}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '16px 0' }}>
          {state === 'CREATED' && <button style={button} disabled={locked} onClick={() => void action('plan')}>Démarrer</button>}
          {state === 'CODE_READY' && <button style={button} disabled={locked} onClick={() => void action('prepare-apply')}>Préparer le diff</button>}
          {diff && <><button style={button} disabled={locked || !canApprove(mission, diff) || mission.approved} onClick={() => void action('approve')}>Approuver CE diff</button><button style={button} disabled={locked || !canApply(mission, diff)} onClick={() => void action('apply')}>Appliquer</button></>}
          {!finished.has(state) && state !== 'APPLYING' && <button style={button} onClick={() => void action('cancel')}>Annuler</button>}
        </div>
        {state === 'TASKS_READY' && mission.mode === 'PLAN_AND_CODE_TEXT_ONLY' && <div><label>Fichiers à générer (un par ligne)<textarea style={field} value={files} onChange={e => setFiles(e.target.value)} /></label><button style={button} disabled={locked || !files.trim()} onClick={() => void action('generate')}>Générer le code texte</button></div>}
        <TextArtifact title="PRD" content={artifacts?.planning.prd} /><TextArtifact title="Design" content={artifacts?.planning.design} /><TextArtifact title="Tasks" content={artifacts?.planning.tasks} />
        {artifacts?.codegen.map(f => <TextArtifact key={f.path} title={`Code — ${f.path}`} content={f.content} />)}
        {diff && <><h3>Revue du diff</h3><p style={{ overflowWrap: 'anywhere' }}>DIFF_SHA256 : <code>{diff.diff_sha256}</code></p><ul>{diff.files?.map(f => <li key={f.destination}>{f.operation} — {f.destination}</li>)}</ul><TextArtifact title="Diff complet" content={diff.diff_text} /><h4>Dependency requests</h4><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(diff.dependency_requests || [], null, 2)}</pre><h4>Security findings</h4><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(diff.security_findings || [], null, 2)}</pre>{mission.approved && <p>Ce diff a été approuvé. L’application reste une action séparée.</p>}</>}
        <details><summary>Historique des transitions</summary><ol>{mission.events?.map(e => <li key={e.id}>{e.to_state}</li>)}</ol></details>
      </> : <p role="status">Chargement de la mission…</p>}
    </section>
  </div>;
}
