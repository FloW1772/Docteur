import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Ban, Pencil, Trash2, Archive, RotateCcw, Search, Send, ShieldAlert, X, Plus, GitMerge } from 'lucide-react';
import { cortexClient, MemoryApiError } from '../../lib/cortex/client';
import type {
  MemoryItem, MemoryStatus, MemoryConflict, MemorySuggestion, MemoryProject, MemoryEvidence, MemoryRevision, MemoryWriteInput, MemoryScopeKind,
  MemorySensitivity, MemoryRetention, MemoryAnswer, AiCandidate,
} from '../../lib/cortex/client';

// NB-5 — DOCTEUR MEMORY. STRICT LOCAL. The memory holds ONLY what a human explicitly approved:
//   • a NB-4 candidate is a proposal, never memory — approving it here is a deliberate, single-item action (no "approve all");
//   • memory is CONTEXT for the local assistant, never an instruction: it cannot run anything or reach any other module;
//   • supersession and conflict resolution are always confirmed by the user, never applied silently.
// Every server-provided string (statements, evidence quotes, titles…) is rendered as a React text node — never as HTML.

type Tab = 'candidates' | 'approved' | 'conflicts' | 'superseded' | 'revoked' | 'ask' | 'new';
const TYPES = ['PROJECT_FACT', 'DECISION', 'REQUIREMENT', 'PREFERENCE', 'TECHNICAL_DISCOVERY', 'RESOLVED_QUESTION', 'OPEN_QUESTION', 'WORKFLOW', 'CONSTRAINT', 'PERSONAL_NOTE'];
const MAX = 400;
const SENS_LABEL: Record<MemorySensitivity, string> = { NORMAL: 'Normal', SENSITIVE: 'Sensible', HIGHLY_SENSITIVE: 'Très sensible' };
const RET_LABEL: Record<MemoryRetention, string> = { KEEP: 'Conserver', MANUAL: 'Manuelle', DELETE_AFTER: 'Supprimer après…', SESSION_ONLY: 'Session uniquement' };

const btn: React.CSSProperties = { background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 6, color: '#a78bfa', padding: '5px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 };
const small: React.CSSProperties = { fontSize: 10, padding: '3px 8px' };
const ghost: React.CSSProperties = { ...btn, background: 'none', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8' };
const danger: React.CSSProperties = { ...btn, background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.35)', color: '#ff4d58' };
const input: React.CSSProperties = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#e2e8f0', padding: '7px 10px', fontSize: 12, fontFamily: 'inherit', outline: 'none' };
const select: React.CSSProperties = { ...input, padding: '4px 6px', fontSize: 10, background: '#100c1d' };
const card: React.CSSProperties = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6 };
const fmtDate = (iso: string | null | undefined) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('fr-FR'); } catch { return iso; } };

function Badge({ text, color = '#94a3b8', testid }: { text: string; color?: string; testid?: string }) {
  return <span data-testid={testid} className="font-mono" style={{ fontSize: 9, color, border: `1px solid ${color}55`, borderRadius: 4, padding: '1px 5px', letterSpacing: '0.04em' }}>{text}</span>;
}
const scopeLabel = (m: MemoryItem) => (m.scopeKind === 'GLOBAL' ? 'GLOBAL' : m.scopeKind === 'PROJECT' ? `PROJET ${m.projectId}` : 'NOTEBOOK');
const errText = (e: unknown) => { const x = e as MemoryApiError; return x?.code && x.code !== 'MEMORY_HTTP' ? `${x.code} — ${x.message}` : ((e as Error)?.message ?? 'Erreur'); };

function MemoryCard({ m, actions, children, testid = 'mem-item' }: { m: MemoryItem; actions?: React.ReactNode; children?: React.ReactNode; testid?: string }) {
  return (
    <li data-testid={testid} className="px-2.5 py-2" style={card}>
      <p className="font-mono flex items-center gap-2 flex-wrap" style={{ fontSize: 9 }}>
        <Badge text={m.type} color="#5ee7ff" /><Badge testid="mem-scope" text={scopeLabel(m)} color="#a78bfa" /><Badge text={m.status} color={m.status === 'APPROVED' ? '#3dffaa' : m.status === 'REVOKED' ? '#ff4d58' : '#f59e0b'} />
        {m.sensitivity !== 'NORMAL' && <Badge testid="mem-sensitivity" text={SENS_LABEL[m.sensitivity]} color="#ff4d58" />}
        <Badge text={m.trustLevel === 'USER_AUTHORED' ? 'écrit par toi' : m.trustLevel === 'PAST_AI_OUTPUT' ? 'ancienne sortie d\'IA, approuvée' : m.trustLevel} color={m.trustLevel === 'PAST_AI_OUTPUT' ? '#f59e0b' : '#3dffaa'} />
        {m.needsReview && <Badge testid="mem-needs-review" text="source supprimée — à revoir" color="#f59e0b" />}
        {m.injectionFlags.length > 0 && <Badge testid="mem-injection-flag" text="texte d'instruction (traité comme donnée)" color="#f59e0b" />}
        <span style={{ color: '#5a4a7a' }}>v{m.version} · depuis {fmtDate(m.effectiveFrom)}{m.effectiveUntil ? ` · jusqu'au ${fmtDate(m.effectiveUntil)}` : ''}{m.retention !== 'KEEP' ? ` · ${RET_LABEL[m.retention]}` : ''}</span>
      </p>
      <p className="font-mono mt-1" data-testid="mem-statement" style={{ fontSize: 12, color: '#e2e8f0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.statement}</p>
      {children}
      {actions && <div className="flex gap-1.5 mt-1.5 flex-wrap">{actions}</div>}
    </li>
  );
}

// ── Approval form (candidate promotion / manual creation / edit) ─────────────
interface FormState { statement: string; type: string; kind: MemoryScopeKind; projectId: string; sensitivity: MemorySensitivity; retention: MemoryRetention; duration: string; confirmGlobal: boolean; confirmSensitive: boolean; allowDuplicate: boolean; secretPolicy: 'block' | 'redact' }
function MemoryForm({ initial, projects, notebookId, submitLabel, onSubmit, onCancel, lockScope }: {
  initial: Partial<FormState> & { statement: string; type: string }; projects: MemoryProject[]; notebookId: string; submitLabel: string;
  onSubmit: (input: MemoryWriteInput) => Promise<void>; onCancel: () => void; lockScope?: boolean;
}) {
  const [f, setF] = useState<FormState>({ kind: initial.kind ?? (projects.length ? 'PROJECT' : 'NOTEBOOK'), projectId: initial.projectId ?? projects[0]?.projectId ?? '', sensitivity: 'NORMAL', retention: 'KEEP', duration: '24h', confirmGlobal: false, confirmSensitive: false, allowDuplicate: false, secretPolicy: 'block', ...initial });
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF(s => ({ ...s, [k]: v }));
  const remaining = MAX - f.statement.length;
  async function submit() {
    setBusy(true); setError(null);
    try {
      await onSubmit({
        statement: f.statement, type: f.type, sensitivity: f.sensitivity, retention: f.retention, ...(f.retention === 'DELETE_AFTER' ? { retentionDuration: f.duration } : {}),
        ...(lockScope ? {} : { scope: { kind: f.kind, projectId: f.kind === 'PROJECT' ? f.projectId : null, notebookId: f.kind === 'NOTEBOOK' ? notebookId : null } }),
        confirmGlobal: f.confirmGlobal, confirmSensitive: f.confirmSensitive, allowDuplicate: f.allowDuplicate, secretPolicy: f.secretPolicy,
      });
    } catch (e) { const x = e as MemoryApiError; setError({ code: x.code ?? 'ERROR', message: errText(e) }); } finally { setBusy(false); }
  }
  return (
    <div data-testid="mem-form" role="form" aria-label="Approbation d'un souvenir" className="flex flex-col gap-2 px-3 py-2 mt-2" style={{ ...card, borderColor: 'rgba(167,139,250,0.35)' }}>
      <label className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>Énoncé final (ce qui sera mémorisé — {remaining} caractères restants)
        <textarea data-testid="mem-form-statement" style={{ ...input, width: '100%', minHeight: 60, marginTop: 4, resize: 'vertical' }} maxLength={MAX + 50} value={f.statement} onChange={e => set('statement', e.target.value)} />
      </label>
      <div className="flex gap-2 flex-wrap font-mono" style={{ fontSize: 10, color: '#94a3b8' }}>
        <label>Type <select data-testid="mem-form-type" aria-label="Type de souvenir" style={select} value={f.type} onChange={e => set('type', e.target.value)}>{TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        {!lockScope && <label>Portée <select data-testid="mem-form-scope" aria-label="Portée" style={select} value={f.kind} onChange={e => set('kind', e.target.value as MemoryScopeKind)}><option value="PROJECT">PROJET</option><option value="NOTEBOOK">CE NOTEBOOK</option><option value="GLOBAL">GLOBAL (rare)</option></select></label>}
        {!lockScope && f.kind === 'PROJECT' && <label>Projet <select data-testid="mem-form-project" aria-label="Projet" style={select} value={f.projectId} onChange={e => set('projectId', e.target.value)}>{projects.length === 0 && <option value="">— aucun projet —</option>}{projects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}</select></label>}
        <label>Sensibilité <select data-testid="mem-form-sensitivity" aria-label="Sensibilité" style={select} value={f.sensitivity} onChange={e => set('sensitivity', e.target.value as MemorySensitivity)}>{(Object.keys(SENS_LABEL) as MemorySensitivity[]).map(s => <option key={s} value={s}>{SENS_LABEL[s]}</option>)}</select></label>
        {!lockScope && <label>Rétention <select data-testid="mem-form-retention" aria-label="Rétention" style={select} value={f.retention} onChange={e => set('retention', e.target.value as MemoryRetention)}>{(Object.keys(RET_LABEL) as MemoryRetention[]).map(r => <option key={r} value={r}>{RET_LABEL[r]}</option>)}</select></label>}
        {!lockScope && f.retention === 'DELETE_AFTER' && <input aria-label="Durée avant suppression" style={{ ...select, width: 60 }} value={f.duration} onChange={e => set('duration', e.target.value)} />}
      </div>
      {f.kind === 'GLOBAL' && !lockScope && <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}>GLOBAL s'applique à tous les projets : réservé aux préférences et contraintes transversales.</p>}
      {error && (
        <div role="alert" data-testid="mem-form-error" className="font-mono" style={{ fontSize: 11, color: '#ff4d58' }}>
          <p><ShieldAlert size={11} style={{ display: 'inline', marginRight: 4 }} />{error.message}</p>
          {error.code === 'APPROVAL_REQUIRED' && <>
            <label style={{ display: 'block', color: '#f59e0b' }}><input type="checkbox" data-testid="mem-confirm-sensitive" checked={f.confirmSensitive} onChange={e => set('confirmSensitive', e.target.checked)} /> Je confirme : contenu personnel/sensible enregistré volontairement</label>
            <label style={{ display: 'block', color: '#f59e0b' }}><input type="checkbox" data-testid="mem-confirm-global" checked={f.confirmGlobal} onChange={e => set('confirmGlobal', e.target.checked)} /> Je confirme : portée GLOBAL pour ce type</label>
          </>}
          {error.code === 'DUPLICATE_MEMORY' && <label style={{ display: 'block', color: '#f59e0b' }}><input type="checkbox" data-testid="mem-allow-duplicate" checked={f.allowDuplicate} onChange={e => set('allowDuplicate', e.target.checked)} /> Créer quand même (doublon assumé)</label>}
          {error.code === 'SECRET_DETECTED' && <label style={{ display: 'block', color: '#f59e0b' }}><input type="checkbox" data-testid="mem-redact" checked={f.secretPolicy === 'redact'} onChange={e => set('secretPolicy', e.target.checked ? 'redact' : 'block')} /> Masquer le secret (les clés privées restent bloquées)</label>}
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" data-testid="mem-form-submit" disabled={busy || f.statement.trim().length < 8 || f.statement.length > MAX} style={btn} onClick={() => void submit()}><Check size={11} /> {submitLabel}</button>
        <button type="button" style={ghost} onClick={onCancel}>Annuler</button>
      </div>
    </div>
  );
}

// ── Candidates (NB-4 proposals) ─────────────────────────────────────────────
function CandidatesSection({ notebookId, projects, onChanged }: { notebookId: string; projects: MemoryProject[]; onChanged: () => void }) {
  const [list, setList] = useState<AiCandidate[]>([]); const [open, setOpen] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const reload = useCallback(async () => { try { const r = await cortexClient.aiHistoryCandidates(notebookId, { limit: 100 }); setList(r.candidates.filter(c => c.status !== 'REJECTED' && c.status !== 'SUPERSEDED' && c.promotion !== 'MEMORY')); } catch (e) { setError((e as Error).message); } }, [notebookId]);
  useEffect(() => { void reload(); }, [reload]);
  return (
    <div className="p-3 flex flex-col gap-2" data-testid="mem-candidates">
      <p className="font-mono px-2.5 py-2" data-testid="mem-candidates-banner" style={{ ...card, fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>
        Un candidat est une <strong>proposition</strong>, pas un souvenir. Rien n'entre dans la mémoire de Docteur sans ton approbation, candidat par candidat (il n'existe pas de « tout approuver »). Tu peux modifier l'énoncé avant d'approuver ; les preuves d'origine restent liées.
      </p>
      {error && <p className="font-mono" role="alert" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      {notice && <p className="font-mono" role="status" data-testid="mem-notice" style={{ fontSize: 11, color: '#3dffaa' }}>{notice}</p>}
      <ul className="flex flex-col gap-1.5" style={{ listStyle: 'none', padding: 0 }} aria-label="Candidats à promouvoir">
        {list.length === 0 && <li className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucun candidat en attente dans ce Notebook.</li>}
        {list.map(c => (
          <li key={c.candidateId} data-testid="mem-candidate" className="px-2.5 py-2" style={card}>
            <p className="font-mono flex gap-2 flex-wrap" style={{ fontSize: 9 }}><Badge text={c.type} color="#5ee7ff" /><Badge text="CANDIDAT — pas encore un souvenir" color="#f59e0b" /><span style={{ color: '#5a4a7a' }}>{c.evidenceCount ?? 0} preuve(s) · confiance {Math.round(c.confidence * 100)} %</span></p>
            <p className="font-mono mt-1" style={{ fontSize: 12, color: '#e2e8f0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.statement}</p>
            {open === c.candidateId ? (
              <MemoryForm notebookId={notebookId} projects={projects} initial={{ statement: c.statement, type: TYPES.includes(c.type) ? c.type : 'TECHNICAL_DISCOVERY', sensitivity: 'NORMAL' }} submitLabel="Approuver ce souvenir"
                onCancel={() => setOpen(null)}
                onSubmit={async (input) => { await cortexClient.memoryApproveCandidate(notebookId, c.candidateId, input); setOpen(null); setNotice('Souvenir approuvé. Le candidat d\'origine et ses preuves restent liés.'); await reload(); onChanged(); }} />
            ) : <div className="mt-1.5"><button type="button" data-testid="mem-approve-open" style={{ ...btn, ...small }} onClick={() => setOpen(c.candidateId)}><Check size={10} /> Approuver comme souvenir…</button></div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Approved / Superseded / Revoked lists ───────────────────────────────────
function MemoryList({ status, notebookId, projects, onChanged, refreshKey }: { status: MemoryStatus; notebookId: string; projects: MemoryProject[]; onChanged: () => void; refreshKey: number }) {
  const [items, setItems] = useState<MemoryItem[]>([]); const [sugg, setSugg] = useState<MemorySuggestion[]>([]); const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); const [detail, setDetail] = useState<{ id: string; evidence: MemoryEvidence[]; revisions: MemoryRevision[]; usage: number } | null>(null); const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  const reload = useCallback(async () => {
    try {
      const r = await cortexClient.memoryList({ status }); if (alive.current) setItems(r.items);
      if (status === 'SUPERSEDED' || status === 'APPROVED') { const s = await cortexClient.memorySuggestions(); if (alive.current) setSugg(s.suggestions); }
    } catch (e) { if (alive.current) setError(errText(e)); }
  }, [status]);
  useEffect(() => { void reload(); }, [reload, refreshKey]);
  async function run(fn: () => Promise<unknown>) { setError(null); try { await fn(); await reload(); onChanged(); } catch (e) { setError(errText(e)); } }
  async function showDetail(id: string) { try { const [g, r] = await Promise.all([cortexClient.memoryGet(id), cortexClient.memoryRevisions(id)]); setDetail({ id, evidence: g.evidence, revisions: r.revisions, usage: g.usageCount }); } catch (e) { setError(errText(e)); } }
  const byId = new Map(items.map(i => [i.memoryId, i]));
  return (
    <div className="p-3 flex flex-col gap-2" data-testid={`mem-list-${status.toLowerCase()}`}>
      {error && <p className="font-mono" role="alert" data-testid="mem-error" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      {(status === 'SUPERSEDED' || status === 'APPROVED') && sugg.length > 0 && (
        <div data-testid="mem-suggestions" role="region" aria-label="Remplacements suggérés" className="px-2.5 py-2" style={{ ...card, borderColor: 'rgba(245,158,11,0.4)' }}>
          <p className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}><GitMerge size={10} style={{ display: 'inline', marginRight: 4 }} />Remplacements possibles — rien n'est appliqué sans ta confirmation</p>
          {sugg.map(s => (
            <div key={s.suggestionId} data-testid="mem-suggestion" className="font-mono mt-1.5" style={{ fontSize: 11, color: '#c0b0e0' }}>
              <p>{s.ambiguous ? 'Ambigu — à vérifier' : 'Formulation explicite'} : {s.detail}</p>
              <p style={{ color: '#94a3b8' }}>Ancien ({fmtDate(s.oldMemory?.effectiveFrom)}) : {s.oldMemory?.statement}</p>
              <p style={{ color: '#e2e8f0' }}>Nouveau ({fmtDate(s.newMemory?.effectiveFrom)}) : {s.newMemory?.statement}</p>
              <div className="flex gap-1.5 mt-1"><button type="button" data-testid="mem-supersede-confirm" style={{ ...btn, ...small }} onClick={() => void run(() => cortexClient.memorySupersede(s.newId, s.oldId, s.oldMemory?.version))}><Check size={10} /> Confirmer : le nouveau remplace l'ancien</button>
                <button type="button" data-testid="mem-supersede-dismiss" style={{ ...ghost, ...small }} onClick={() => void run(() => cortexClient.memoryDismissSupersede(s.newId, s.oldId))}>Ignorer</button></div>
            </div>
          ))}
        </div>
      )}
      <ul className="flex flex-col gap-1.5" style={{ listStyle: 'none', padding: 0 }} aria-label={`Souvenirs ${status}`}>
        {items.length === 0 && <li className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>{status === 'APPROVED' ? 'Aucun souvenir approuvé.' : status === 'SUPERSEDED' ? 'Aucun souvenir remplacé.' : 'Aucun souvenir révoqué.'}</li>}
        {items.map(m => (
          <MemoryCard key={m.memoryId} m={m}
            actions={<>
              {status === 'APPROVED' && <button type="button" data-testid="mem-edit" style={{ ...ghost, ...small }} onClick={() => setEditing(editing === m.memoryId ? null : m.memoryId)}><Pencil size={10} /> Modifier</button>}
              {status === 'APPROVED' && <button type="button" data-testid="mem-revoke" style={{ ...ghost, ...small }} onClick={() => void run(() => cortexClient.memoryRevoke(m.memoryId, m.version))}><Ban size={10} /> Révoquer</button>}
              {status === 'APPROVED' && <button type="button" data-testid="mem-archive" style={{ ...ghost, ...small }} onClick={() => void run(() => cortexClient.memoryArchive(m.memoryId, m.version))}><Archive size={10} /> Archiver</button>}
              <button type="button" data-testid="mem-detail" style={{ ...ghost, ...small }} onClick={() => void showDetail(m.memoryId)}>Preuves &amp; historique</button>
              {confirmDelete === m.memoryId
                ? <><button type="button" data-testid="mem-delete-confirm" style={{ ...danger, ...small }} onClick={() => { setConfirmDelete(null); void run(() => cortexClient.memoryDelete(m.memoryId, m.version)); }}><Trash2 size={10} /> Confirmer la suppression définitive</button><button type="button" style={{ ...ghost, ...small }} onClick={() => setConfirmDelete(null)}>Annuler</button></>
                : <button type="button" data-testid="mem-delete" style={{ ...danger, ...small }} onClick={() => setConfirmDelete(m.memoryId)}><Trash2 size={10} /> Supprimer</button>}
            </>}>
            {m.supersededBy && <p className="font-mono mt-1" data-testid="mem-superseded-by" style={{ fontSize: 10, color: '#f59e0b' }}>Remplacé par : {byId.get(m.supersededBy)?.statement ?? m.supersededBy}</p>}
            {editing === m.memoryId && <MemoryForm notebookId={notebookId} projects={projects} lockScope initial={{ statement: m.statement, type: m.type, sensitivity: m.sensitivity }} submitLabel="Enregistrer la modification" onCancel={() => setEditing(null)}
              onSubmit={async (input) => { await cortexClient.memoryEdit(m.memoryId, { ...input, expectedVersion: m.version }); setEditing(null); await reload(); onChanged(); }} />}
            {detail?.id === m.memoryId && (
              <div data-testid="mem-detail-panel" role="region" aria-label="Preuves et historique" className="px-2 py-2 mt-2" style={card}>
                <p className="font-mono" style={{ fontSize: 10, color: '#c0b0e0' }}>Preuves ({detail.evidence.length}) — liens vers les sources, pas des copies · utilisé {detail.usage} fois</p>
                {detail.evidence.length === 0 && <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>{m.provenanceStatus === 'MANUAL' ? 'Note manuelle : aucune source requise.' : 'Aucune preuve restante.'}</p>}
                {detail.evidence.map(e => <p key={`${e.kind}${e.ref}`} data-testid="mem-evidence" className="font-mono" style={{ fontSize: 10, color: e.status === 'OK' ? '#94a3b8' : '#f59e0b' }}>{e.status === 'OK' ? '' : '[source supprimée] '}{e.provider ?? ''} · {e.role ?? ''} · {fmtDate(e.ts)} — « {e.quote} »</p>)}
                <p className="font-mono mt-1" style={{ fontSize: 10, color: '#c0b0e0' }}>Historique des révisions</p>
                {detail.revisions.map(r => <p key={r.revisionId} data-testid="mem-revision" className="font-mono" style={{ fontSize: 10, color: '#94a3b8' }}>v{r.version} · {r.action} · {fmtDate(r.at)}{r.oldStatement ? ` — avant : « ${r.oldStatement} »` : ''}{r.reason ? ` (${r.reason})` : ''}</p>)}
                {m.originalStatement && m.editedBeforeApproval && <p className="font-mono" style={{ fontSize: 10, color: '#94a3b8' }}>Énoncé original du candidat : « {m.originalStatement} »</p>}
                <button type="button" style={{ ...ghost, ...small, marginTop: 6 }} onClick={() => setDetail(null)}><X size={10} /> Fermer</button>
              </div>
            )}
            {status === 'REVOKED' && <p className="font-mono mt-1" style={{ fontSize: 10, color: '#5a4a7a' }}>Révoqué : plus jamais utilisé par l'assistant.</p>}
            {status === 'ARCHIVED' && <button type="button" style={{ ...ghost, ...small }} onClick={() => void run(() => cortexClient.memoryRestore(m.memoryId, m.version))}><RotateCcw size={10} /> Restaurer</button>}
          </MemoryCard>
        ))}
      </ul>
    </div>
  );
}

// ── Conflicts ───────────────────────────────────────────────────────────────
function ConflictsSection({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const [list, setList] = useState<MemoryConflict[]>([]); const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { try { setList((await cortexClient.memoryConflicts()).conflicts); } catch (e) { setError(errText(e)); } }, []);
  useEffect(() => { void reload(); }, [reload, refreshKey]);
  async function act(id: string, action: Parameters<typeof cortexClient.memoryResolveConflict>[1]) { setError(null); try { await cortexClient.memoryResolveConflict(id, action); await reload(); onChanged(); } catch (e) { setError(errText(e)); } }
  return (
    <div className="p-3 flex flex-col gap-2" data-testid="mem-conflicts">
      <p className="font-mono px-2.5 py-2" style={{ ...card, fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>Deux souvenirs actifs qui semblent se contredire (heuristique locale : des faux positifs sont possibles). Docteur ne tranche jamais seul : l'assistant reçoit les deux positions tant que tu n'as pas décidé.</p>
      {error && <p className="font-mono" role="alert" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      <ul className="flex flex-col gap-1.5" style={{ listStyle: 'none', padding: 0 }} aria-label="Conflits de mémoire">
        {list.length === 0 && <li className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucun conflit ouvert.</li>}
        {list.map(c => (
          <li key={c.conflictId} data-testid="mem-conflict" className="px-2.5 py-2" style={{ ...card, borderColor: 'rgba(245,158,11,0.4)' }}>
            <p className="font-mono" style={{ fontSize: 9, color: '#f59e0b' }}>CONFLIT POSSIBLE · {c.kind}</p>
            <p className="font-mono mt-1" style={{ fontSize: 12, color: '#e2e8f0' }}><strong>A</strong> ({fmtDate(c.a?.effectiveFrom)}) : {c.a?.statement}</p>
            <p className="font-mono mt-1" style={{ fontSize: 12, color: '#e2e8f0' }}><strong>B</strong> ({fmtDate(c.b?.effectiveFrom)}) : {c.b?.statement}</p>
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              <button type="button" data-testid="mem-conflict-keep" style={{ ...btn, ...small }} onClick={() => void act(c.conflictId, 'KEEP_BOTH')}>Garder les deux</button>
              <button type="button" data-testid="mem-conflict-b-wins" style={{ ...ghost, ...small }} onClick={() => void act(c.conflictId, 'B_SUPERSEDES_A')}>B remplace A</button>
              <button type="button" style={{ ...ghost, ...small }} onClick={() => void act(c.conflictId, 'A_SUPERSEDES_B')}>A remplace B</button>
              <button type="button" style={{ ...danger, ...small }} onClick={() => void act(c.conflictId, 'REVOKE_A')}>Révoquer A</button>
              <button type="button" style={{ ...danger, ...small }} onClick={() => void act(c.conflictId, 'REVOKE_B')}>Révoquer B</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Ask / retrieval test with « Docteur a utilisé N souvenirs » ──────────────
function AskSection({ notebookId, projectId }: { notebookId: string; projectId: string | null }) {
  const [q, setQ] = useState(''); const [historical, setHistorical] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<MemoryAnswer | null>(null); const [found, setFound] = useState<{ results: MemoryItem[]; notice: string | null; mode: string } | null>(null);
  const ctx = { activeProject: projectId, activeNotebook: notebookId, includeHistorical: historical };
  async function search() { setBusy(true); setError(null); setAnswer(null); try { const r = await cortexClient.memoryRetrieve(q, ctx); setFound({ results: r.results, notice: r.notice, mode: r.retrievalMode }); } catch (e) { setError(errText(e)); } finally { setBusy(false); } }
  async function ask() { setBusy(true); setError(null); setFound(null); try { setAnswer(await cortexClient.memoryAnswer(q, ctx)); } catch (e) { setError(errText(e)); } finally { setBusy(false); } }
  const used = answer?.memoryUsed ?? found?.results.map((r, i) => ({ marker: `M${i + 1}`, memoryId: r.memoryId, type: r.type, scope: r.scope, status: r.status, statement: r.statement })) ?? [];
  return (
    <div className="p-3 flex flex-col gap-2" data-testid="mem-ask-panel">
      <p className="font-mono px-2.5 py-2" style={{ ...card, fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>
        Contexte actif : {projectId ? <strong data-testid="mem-active-project">projet « {projectId} »</strong> : <strong data-testid="mem-active-project">aucun projet résolu</strong>} — sans projet explicite, aucun souvenir de projet n'est injecté (le projet n'est jamais deviné). Les souvenirs sont du contexte, jamais des instructions.
      </p>
      <div className="flex gap-2"><input data-testid="mem-ask-input" aria-label="Question" style={{ ...input, flex: 1 }} value={q} placeholder="Pose une question ou teste la récupération…" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && q.trim() && !busy) void ask(); }} />
        <button type="button" data-testid="mem-search" style={btn} disabled={busy || !q.trim()} onClick={() => void search()}><Search size={11} /> Rechercher</button>
        <button type="button" data-testid="mem-ask" style={btn} disabled={busy || !q.trim()} onClick={() => void ask()}><Send size={11} /> Demander</button></div>
      <label className="font-mono" style={{ fontSize: 10, color: '#94a3b8' }}><input type="checkbox" data-testid="mem-historical" checked={historical} onChange={e => setHistorical(e.target.checked)} /> Inclure les souvenirs remplacés / archivés (« qu'utilisions-nous avant ? »)</label>
      {error && <p className="font-mono" role="alert" data-testid="mem-ask-error" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      {answer && <div data-testid="mem-answer" className="px-3 py-2 font-mono" style={{ ...card, fontSize: 12, color: '#e2e8f0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{answer.answer}</div>}
      {(answer || found) && (
        <details data-testid="mem-used" className="px-3 py-2" style={card}>
          <summary className="font-mono" data-testid="mem-used-summary" style={{ fontSize: 11, color: '#3dffaa', cursor: 'pointer' }}>Docteur a utilisé {used.length} souvenir{used.length > 1 ? 's' : ''}</summary>
          {used.length === 0 && <p className="font-mono mt-1" style={{ fontSize: 10, color: '#5a4a7a' }}>Aucun souvenir pertinent : la réponse ne s'appuie sur aucune mémoire{(answer?.notice ?? found?.notice) === 'PROJECT_UNRESOLVED_NO_PROJECT_MEMORY' ? ' (projet non résolu)' : ''}.</p>}
          {used.map(u => <p key={u.memoryId} data-testid="mem-used-item" className="font-mono mt-1" style={{ fontSize: 11, color: '#c0b0e0', overflowWrap: 'anywhere' }}><Badge text={u.marker} color="#5ee7ff" /> <Badge text={u.scope.kind} color="#a78bfa" /> {u.status !== 'APPROVED' && <Badge text={`HISTORIQUE · ${u.status}`} color="#f59e0b" />} {u.statement}</p>)}
          {(answer?.conflicts.length ?? 0) > 0 && <p className="font-mono mt-1" data-testid="mem-used-conflict" style={{ fontSize: 10, color: '#f59e0b' }}>Conflit possible entre deux souvenirs : l'assistant a reçu les deux positions.</p>}
        </details>
      )}
    </div>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────
export default function NotebookMemoryPanel({ notebookId, onChanged }: { notebookId: string; onChanged?: () => void }) {
  const [tab, setTab] = useState<Tab>('approved');
  const [projects, setProjects] = useState<MemoryProject[]>([]); const [projectId, setProjectId] = useState<string | null>(null); const [counts, setCounts] = useState<{ approved: number; superseded: number; revoked: number; archived: number } | null>(null);
  const [newProject, setNewProject] = useState(''); const [error, setError] = useState<string | null>(null); const [refresh, setRefresh] = useState(0);
  const [needsReindex, setNeedsReindex] = useState(false); const [reindexMsg, setReindexMsg] = useState<string | null>(null);
  const [chatOn, setChatOn] = useState(true); // NB-7: global switch « Docteur Memory dans le chat principal »
  const [newForm, setNewForm] = useState(false); const [created, setCreated] = useState<string | null>(null);
  const changed = useRef(onChanged); changed.current = onChanged;
  const loadStatus = useCallback(async () => {
    try { const s = await cortexClient.memoryStatus(); setProjects(s.projects); setCounts(s.counts); setNeedsReindex(s.vector.needsReindex); const p = await cortexClient.memoryNotebookProject(notebookId); setProjectId(p.projectId); await cortexClient.memoryChatSettings().then(cs => setChatOn(cs.settings.enabled)).catch(() => { /* older server: keep default */ }); } catch (e) { setError(errText(e)); }
  }, [notebookId]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  const bump = useCallback(() => { setRefresh(n => n + 1); void loadStatus(); changed.current?.(); }, [loadStatus]);

  async function chooseProject(id: string) { setError(null); try { await cortexClient.memorySetNotebookProject(notebookId, id || null); setProjectId(id || null); } catch (e) { setError(errText(e)); } }
  async function addProject() {
    const name = newProject.trim(); if (!name) return; setError(null);
    const id = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || `projet-${Date.now()}`;
    try { await cortexClient.memoryCreateProject(id, name); setNewProject(''); await loadStatus(); } catch (e) { setError(errText(e)); }
  }
  async function reindex() { setReindexMsg(null); try { const r = await cortexClient.memoryReindex(); setReindexMsg(r.ok ? `${r.reindexed} souvenir(s) réindexé(s).` : `Réindexation incomplète (${r.failed} échec — vecteurs indisponibles, la recherche texte reste active).`); await loadStatus(); } catch (e) { setReindexMsg(errText(e)); } }

  const TABS: Array<[Tab, string]> = [['candidates', 'Candidats'], ['approved', `Approuvés${counts ? ` (${counts.approved})` : ''}`], ['conflicts', 'Conflits'], ['superseded', `Remplacés${counts ? ` (${counts.superseded})` : ''}`], ['revoked', `Révoqués${counts ? ` (${counts.revoked})` : ''}`], ['ask', 'Tester / demander'], ['new', 'Nouveau souvenir']];
  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="memory-panel">
      <div className="px-3 pt-2 flex flex-col gap-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <p className="font-mono" data-testid="mem-banner" style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>
          MÉMOIRE DE DOCTEUR — uniquement ce que tu as approuvé. 100 % local ; un souvenir est du contexte, jamais une instruction, et ne peut rien déclencher.
        </p>
        <div className="flex gap-2 items-center flex-wrap font-mono" style={{ fontSize: 10, color: '#94a3b8' }}>
          <label>Projet de ce Notebook <select data-testid="mem-project-select" aria-label="Projet de ce Notebook" style={select} value={projectId ?? ''} onChange={e => void chooseProject(e.target.value)}><option value="">— non défini (aucune mémoire de projet) —</option>{projects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}</select></label>
          <input data-testid="mem-project-new" aria-label="Nouveau projet" placeholder="Nouveau projet…" style={{ ...select, width: 130 }} value={newProject} onChange={e => setNewProject(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addProject(); }} />
          <button type="button" data-testid="mem-project-add" style={{ ...ghost, ...small }} onClick={() => void addProject()}><Plus size={10} /> Ajouter</button>
          <label data-testid="mem-chat-switch-label"><input type="checkbox" data-testid="mem-chat-switch" checked={chatOn} onChange={e => { const v = e.target.checked; setChatOn(v); void cortexClient.setMemoryChatSettings(v).catch(err => { setChatOn(!v); setError(errText(err)); }); }} /> Utiliser la mémoire dans le chat principal (affichée sous chaque réponse)</label>
          {needsReindex && <button type="button" data-testid="mem-reindex" style={{ ...ghost, ...small, color: '#f59e0b' }} onClick={() => void reindex()}>Réindexer les souvenirs (modèle changé)</button>}
        </div>
        {reindexMsg && <p className="font-mono" role="status" style={{ fontSize: 10, color: '#3dffaa' }}>{reindexMsg}</p>}
        {error && <p className="font-mono" role="alert" data-testid="mem-panel-error" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
        <div role="tablist" aria-label="Mémoire" className="flex flex-wrap">
          {TABS.map(([t, label]) => (
            <button key={t} type="button" role="tab" id={`mem-tab-${t}`} aria-selected={tab === t} aria-controls={`mem-panel-${t}`} data-testid={`mem-tab-${t}`} onClick={() => setTab(t)}
              onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const i = TABS.findIndex(x => x[0] === tab); const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]; setTab(n); document.getElementById(`mem-tab-${n}`)?.focus(); } }}
              className="font-mono py-2 px-3" style={{ fontSize: 10, color: tab === t ? '#3dffaa' : '#5a4a7a', background: 'none', border: 'none', borderBottom: tab === t ? '2px solid #3dffaa' : '2px solid transparent', cursor: 'pointer' }}>{label}</button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto" role="tabpanel" id={`mem-panel-${tab}`} aria-labelledby={`mem-tab-${tab}`}>
        {tab === 'candidates' && <CandidatesSection notebookId={notebookId} projects={projects} onChanged={bump} />}
        {tab === 'approved' && <MemoryList status="APPROVED" notebookId={notebookId} projects={projects} onChanged={bump} refreshKey={refresh} />}
        {tab === 'conflicts' && <ConflictsSection onChanged={bump} refreshKey={refresh} />}
        {tab === 'superseded' && <MemoryList status="SUPERSEDED" notebookId={notebookId} projects={projects} onChanged={bump} refreshKey={refresh} />}
        {tab === 'revoked' && <MemoryList status="REVOKED" notebookId={notebookId} projects={projects} onChanged={bump} refreshKey={refresh} />}
        {tab === 'ask' && <AskSection notebookId={notebookId} projectId={projectId} />}
        {tab === 'new' && (
          <div className="p-3" data-testid="mem-new">
            <p className="font-mono px-2.5 py-2" style={{ ...card, fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>Note écrite par toi : aucune source requise, mais aucun secret (clé, mot de passe, jeton…) — il serait refusé. 400 caractères maximum : un souvenir est une phrase, pas une conversation.</p>
            {created && <p className="font-mono mt-2" role="status" data-testid="mem-created" style={{ fontSize: 11, color: '#3dffaa' }}>{created}</p>}
            {!newForm
              ? <button type="button" data-testid="mem-new-open" style={{ ...btn, marginTop: 8 }} onClick={() => { setNewForm(true); setCreated(null); }}><Plus size={11} /> Écrire un souvenir</button>
              : <MemoryForm notebookId={notebookId} projects={projects} initial={{ statement: '', type: 'PROJECT_FACT' }} submitLabel="Enregistrer ce souvenir" onCancel={() => setNewForm(false)}
                onSubmit={async (input) => { const r = await cortexClient.memoryCreateManual(input); setNewForm(false); setCreated(`Souvenir enregistré${r.suggestions ? ` — ${r.suggestions} remplacement(s) possible(s) à confirmer` : ''}${r.conflicts ? ` — ${r.conflicts} conflit(s) à examiner` : ''}.`); bump(); }} />}
          </div>
        )}
      </div>
    </div>
  );
}
