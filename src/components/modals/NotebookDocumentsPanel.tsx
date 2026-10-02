import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Lock, Send, RefreshCw, FileText, Search, ShieldAlert, X, AlertTriangle, Clock } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  NotebookDocument, NotebookDocStatus, NotebookDocSearchHit, NotebookDocCitation, NotebookDocImportResult,
  NotebookDocAnswer, NotebookVectorStatus, NotebookRetention, NotebookTrustFilter, NotebookCitationPreview,
} from '../../lib/cortex/client';

// NB-2/NB-3 — raw documents for a Notebook. STRICT LOCAL only: there is no cloud
// control anywhere in this panel. Status chips never show READY before the
// backend reports indexing finished (polling reads the persisted status).
// All server-provided strings (titles, headings, excerpts, filenames…) are rendered
// as React text nodes — never as HTML.

const IN_PROGRESS: NotebookDocStatus[] = ['QUEUED', 'SCANNING', 'PARSING', 'CHUNKING', 'INDEXING'];
const TRUST_LEVELS = ['USER_AUTHORED', 'PRIMARY_SOURCE', 'VERIFIED_EXTERNAL', 'SECONDARY_SOURCE', 'PAST_AI_OUTPUT', 'UNVERIFIED_WEB', 'UNKNOWN'] as const;

const STATUS_COLOR: Record<NotebookDocStatus, string> = {
  QUEUED: '#94a3b8', SCANNING: '#5ee7ff', PARSING: '#5ee7ff', CHUNKING: '#5ee7ff', INDEXING: '#5ee7ff',
  READY: '#3dffaa', FAILED: '#ff4d58', SECURITY_BLOCKED: '#f59e0b',
};

const ERROR_LABEL: Record<string, string> = {
  UNSUPPORTED_FORMAT: 'Format non supporté',
  FILE_TOO_LARGE: 'Fichier trop volumineux',
  PARSER_FAILED: 'Lecture du fichier impossible',
  SECURITY_BLOCKED: 'Bloqué par la sécurité',
  SECRET_DETECTED: 'Secret détecté',
  EMBEDDING_UNAVAILABLE: 'Embeddings indisponibles',
  INDEX_FAILED: 'Indexation échouée',
  SOURCE_DELETED: 'Source supprimée',
  QUEUE_FULL: 'File d\'import pleine',
  INVALID_OPTION: 'Option invalide',
};

const CONFIDENCE_LABEL: Record<string, string> = { HIGH: 'confiance élevée', MEDIUM: 'confiance moyenne', LOW: 'confiance faible', NONE: 'aucune source' };

const btn: React.CSSProperties = {
  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 6, color: '#a78bfa',
  padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const ghost: React.CSSProperties = { ...btn, background: 'none', border: '1px solid rgba(255,255,255,0.12)', color: '#94a3b8' };
const input: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#e2e8f0',
  padding: '7px 10px', fontSize: 12, width: '100%', fontFamily: 'inherit', outline: 'none',
};
const select: React.CSSProperties = { ...input, width: 'auto', padding: '4px 6px', fontSize: 10, background: '#100c1d' };

function StatusChip({ doc }: { doc: NotebookDocument }) {
  const label = doc.status === 'SECURITY_BLOCKED' || doc.status === 'FAILED'
    ? `${doc.status}${doc.errorCode ? ` · ${ERROR_LABEL[doc.errorCode] ?? doc.errorCode}` : ''}`
    : doc.status;
  return (
    <span data-testid="nb-doc-status" data-status={doc.status} className="font-mono" style={{ fontSize: 9, color: STATUS_COLOR[doc.status], letterSpacing: '0.05em' }}>
      {IN_PROGRESS.includes(doc.status) && <RefreshCw size={8} className="animate-spin" style={{ display: 'inline', marginRight: 3 }} />}
      {label}
    </span>
  );
}

function retentionLabel(d: NotebookDocument): string | null {
  if (!d.retention || d.retention === 'KEEP') return null;
  if (d.retention === 'DELETE_AFTER' && d.expiresAt) return `supprimé le ${new Date(d.expiresAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
  if (d.retention === 'SESSION_ONLY') return 'session uniquement';
  return 'conservation manuelle';
}

function retrievalLabel(mode?: string, vector?: string): { text: string; warn: boolean } {
  if (mode === 'FTS_ONLY' || vector === 'VECTOR_UNAVAILABLE' || vector === 'VECTOR_STALE') {
    const why = vector === 'VECTOR_STALE' ? 'VECTOR_STALE — réindexation requise' : vector === 'VECTOR_UNAVAILABLE' ? 'VECTOR_UNAVAILABLE' : '';
    return { text: `Recherche texte locale${why ? ` · ${why}` : ''}`, warn: true };
  }
  if (vector === 'VECTOR_PARTIAL') return { text: 'Recherche hybride locale · vecteurs partiels (réindexation conseillée)', warn: true };
  if (mode === 'HYBRID') return { text: 'Recherche hybride locale (texte + vecteurs)', warn: false };
  return { text: '', warn: false };
}

export default function NotebookDocumentsPanel({ notebookId, onChanged }: { notebookId: string; onChanged?: () => void }) {
  const [docs, setDocs] = useState<NotebookDocument[]>([]);
  const [formats, setFormats] = useState<string[]>([]);
  const [vector, setVector] = useState<NotebookVectorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [pastAi, setPastAi] = useState(false);
  const [retention, setRetention] = useState<NotebookRetention>('KEEP');
  const [duration, setDuration] = useState('24h');
  const [blocked, setBlocked] = useState<{ file?: File; text?: string; title?: string; originKind?: 'file' | 'past_ai_output' | 'manual_text'; findings: string[] } | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [trustFilter, setTrustFilter] = useState<NotebookTrustFilter | 'selected'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [historical, setHistorical] = useState(false);
  const [broad, setBroad] = useState(false);
  const [allowOutside, setAllowOutside] = useState(false);
  const [hits, setHits] = useState<NotebookDocSearchHit[] | null>(null);
  const [retrievalMode, setRetrievalMode] = useState<string | undefined>();
  const [vectorState, setVectorState] = useState<string | undefined>();
  const [answer, setAnswer] = useState<NotebookDocAnswer | null>(null);
  const [preview, setPreview] = useState<NotebookCitationPreview | { error: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged; // stable reload: a fresh inline callback must not retrigger loading

  useEffect(() => () => { mounted.current = false; }, []);

  const reload = useCallback(async () => {
    try {
      const r = await cortexClient.listNotebookDocuments(notebookId);
      if (!mounted.current) return;
      setDocs(r.documents);
      setFormats(r.formats);
      setVector(r.vector ?? null);
      onChangedRef.current?.();
    } catch (e) { if (mounted.current) setError((e as Error).message); }
  }, [notebookId]);

  useEffect(() => { void reload(); }, [reload]);

  // Poll only while something is still importing.
  const hasActive = docs.some(d => IN_PROGRESS.includes(d.status));
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => { void reload(); }, 1500);
    return () => clearInterval(t);
  }, [hasActive, reload]);

  useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview]);

  const importOptions = () => ({ retention, ...(retention === 'DELETE_AFTER' ? { retentionDuration: duration } : {}) });

  function handleImportResult(r: NotebookDocImportResult, src: { file?: File; text?: string; title?: string; originKind?: 'file' | 'past_ai_output' | 'manual_text' }) {
    if (r.duplicate) setNotice('Document déjà importé (contenu identique) — aucune duplication.');
    else setNotice(null);
    if (r.status === 'SECURITY_BLOCKED' && r.errorCode === 'SECRET_DETECTED') {
      setBlocked({ ...src, findings: (r.findings ?? []).map(f => `${f.kind} ×${f.count}`) });
    }
  }

  async function importFile(file: File, secretPolicy: 'block' | 'redact' = 'block', originKind: 'file' | 'past_ai_output' = 'file') {
    setError(null); setBusy(true);
    try {
      const r = await cortexClient.importNotebookDocument(notebookId, { file, secretPolicy, originKind, ...importOptions() });
      handleImportResult(r, { file, originKind });
      await reload();
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(`${err.code ? `${ERROR_LABEL[err.code] ?? err.code} — ` : ''}${err.message}`);
    } finally { setBusy(false); }
  }

  async function importText(secretPolicy: 'block' | 'redact' = 'block', override?: { title: string; text: string; originKind: 'manual_text' | 'past_ai_output' }) {
    const title = override?.title ?? (pasteTitle.trim() || 'Texte collé');
    const text = override?.text ?? pasteText;
    const originKind = override?.originKind ?? (pastAi ? 'past_ai_output' : 'manual_text');
    if (!text.trim()) return;
    setError(null); setBusy(true);
    try {
      const r = await cortexClient.importNotebookDocument(notebookId, { text, title, originKind, secretPolicy, ...importOptions() });
      handleImportResult(r, { text, title, originKind });
      if (r.status !== 'SECURITY_BLOCKED') { setPasting(false); setPasteText(''); setPasteTitle(''); setPastAi(false); }
      await reload();
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(`${err.code ? `${ERROR_LABEL[err.code] ?? err.code} — ` : ''}${err.message}`);
    } finally { setBusy(false); }
  }

  async function confirmRedact() {
    const b = blocked;
    setBlocked(null);
    if (!b) return;
    if (b.file) await importFile(b.file, 'redact', b.originKind === 'past_ai_output' ? 'past_ai_output' : 'file');
    else if (b.text !== undefined) await importText('redact', { title: b.title ?? 'Texte collé', text: b.text, originKind: b.originKind === 'past_ai_output' ? 'past_ai_output' : 'manual_text' });
  }

  async function handleDelete(doc: NotebookDocument) {
    setConfirmDelete(null);
    try {
      await cortexClient.deleteNotebookDocument(notebookId, doc.documentId);
      setHits(null); setAnswer(null); setPreview(null);
      setSelected(s => s.filter(id => id !== doc.documentId));
      await reload();
    } catch (e) { setError((e as Error).message); }
  }

  async function handleTrust(doc: NotebookDocument, level: string) {
    try { await cortexClient.setNotebookDocumentTrust(notebookId, doc.documentId, level); await reload(); } catch (e) { setError((e as Error).message); }
  }

  async function handleReindex() {
    setBusy(true); setError(null);
    try {
      const r = await cortexClient.reindexNotebookDocuments(notebookId);
      setNotice(r.ok ? `Réindexation terminée : ${r.reindexed} segment(s) sur ${r.documents} document(s).` : `Réindexation incomplète (${r.failed} échec(s)) — Ollama local disponible ?`);
      await reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const retrievalOptions = () => ({
    trustFilter: (trustFilter === 'selected' ? 'all' : trustFilter) as NotebookTrustFilter,
    ...(trustFilter === 'selected' ? { documentIds: selected } : {}),
    includeHistorical: historical,
    profile: (broad ? 'broad' : 'precise') as 'broad' | 'precise',
  });

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    setBusy(true); setError(null); setAnswer(null); setPreview(null);
    try {
      const r = await cortexClient.searchNotebookDocuments(notebookId, q, retrievalOptions());
      setHits(r.results); setRetrievalMode(r.retrieval_mode); setVectorState(r.vector_status);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function handleAsk() {
    const q = query.trim();
    if (!q) return;
    setBusy(true); setError(null); setHits(null); setPreview(null);
    try {
      const r = await cortexClient.askNotebookDocuments(notebookId, q, { ...retrievalOptions(), allowOutsideNotebook: allowOutside });
      setAnswer(r); setRetrievalMode(r.retrieval_mode); setVectorState(r.vector_status);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function openPreview(chunkId: string, trigger: HTMLElement | null) {
    previewTrigger.current = trigger;
    try { setPreview(await cortexClient.previewNotebookCitation(notebookId, chunkId)); }
    catch (e) { setPreview({ error: (e as Error).message }); }
  }
  function closePreview() { setPreview(null); previewTrigger.current?.focus(); }

  const ready = docs.filter(d => d.status === 'READY').length;
  const label = retrievalLabel(retrievalMode ?? (vector && vector.total > 0 && vector.compatible === 0 ? 'FTS_ONLY' : undefined), vectorState ?? vector?.status);
  const needsReindex = !!vector?.needsReindex && vector.total > 0;
  const results = answer ? answer.citations : (hits ?? []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="nb-docs-panel">
      <div className="p-3 flex flex-wrap items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <input ref={fileRef} type="file" hidden accept={formats.join(',') || '.txt,.md,.pdf,.html,.json'} data-testid="nb-doc-file-input"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        <button type="button" data-testid="nb-doc-add" style={btn} disabled={busy} onClick={() => fileRef.current?.click()}><Plus size={12} /> Ajouter un fichier</button>
        <button type="button" data-testid="nb-doc-paste" style={ghost} onClick={() => setPasting(p => !p)}><FileText size={12} /> Coller du texte</button>
        <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}>
          Conservation
          <select data-testid="nb-doc-retention" aria-label="Conservation des prochains documents" style={select} value={retention} onChange={e => setRetention(e.target.value as NotebookRetention)}>
            <option value="KEEP">Conserver</option>
            <option value="MANUAL">Manuelle</option>
            <option value="DELETE_AFTER">Supprimer après…</option>
            <option value="SESSION_ONLY">Session uniquement</option>
          </select>
        </label>
        {retention === 'DELETE_AFTER' && (
          <select data-testid="nb-doc-duration" aria-label="Durée avant suppression" style={select} value={duration} onChange={e => setDuration(e.target.value)}>
            <option value="1h">1 h</option><option value="24h">24 h</option><option value="7d">7 j</option>
          </select>
        )}
        <span className="font-mono ml-auto" style={{ fontSize: 9, color: '#5a4a7a' }}>
          {formats.join(' ')} · {ready}/{docs.length} prêt{ready !== 1 ? 's' : ''} · rien ne quitte cette machine
        </span>
      </div>

      {(label.text || needsReindex) && (
        <div className="px-3 py-1.5 flex items-center gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          {label.text && <span data-testid="nb-retrieval-mode" role="status" className="font-mono" style={{ fontSize: 10, color: label.warn ? '#f59e0b' : '#3dffaa' }}>{label.text}</span>}
          {needsReindex && (
            <button type="button" data-testid="nb-doc-reindex" style={{ ...ghost, fontSize: 10, padding: '3px 8px' }} disabled={busy} onClick={() => void handleReindex()}>
              <RefreshCw size={10} /> Réindexer les vecteurs
            </button>
          )}
        </div>
      )}

      {pasting && (
        <div className="p-3 flex flex-col gap-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <input style={input} aria-label="Titre" placeholder="Titre" value={pasteTitle} onChange={e => setPasteTitle(e.target.value)} />
          <textarea style={{ ...input, minHeight: 80, resize: 'vertical' }} aria-label="Texte à indexer" placeholder="Texte à indexer…" value={pasteText} onChange={e => setPasteText(e.target.value)} />
          <label className="font-mono flex items-center gap-2" style={{ fontSize: 10, color: '#94a3b8' }}>
            <input type="checkbox" checked={pastAi} onChange={e => setPastAi(e.target.checked)} />
            Ce texte vient d'une IA (marqué PAST_AI_OUTPUT — non vérifié)
          </label>
          <div className="flex gap-2">
            <button type="button" style={btn} disabled={busy || !pasteText.trim()} onClick={() => void importText()}>Indexer</button>
            <button type="button" style={ghost} onClick={() => setPasting(false)}>Annuler</button>
          </div>
        </div>
      )}

      {blocked && (
        <div data-testid="nb-secret-blocked" role="alert" className="m-3 px-3 py-2 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
          <p className="font-mono flex items-center gap-1.5" style={{ fontSize: 11, color: '#f59e0b' }}>
            <ShieldAlert size={12} /> SECRET_DETECTED — import bloqué ({blocked.findings.join(', ')})
          </p>
          <p className="font-mono mt-1" style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>
            Les valeurs ne sont jamais affichées. Tu peux indexer une version où les secrets sont remplacés par [SECRET_REDACTED], ou annuler.
          </p>
          <div className="flex gap-2 mt-2">
            <button type="button" style={{ ...btn, fontSize: 10 }} onClick={() => void confirmRedact()}>Indexer en masquant les secrets</button>
            <button type="button" style={{ ...ghost, fontSize: 10 }} onClick={() => setBlocked(null)}>Annuler</button>
          </div>
        </div>
      )}

      {error && <p className="font-mono px-3 pt-2" role="alert" data-testid="nb-doc-error" style={{ fontSize: 11, color: '#ff4d58' }}>{error}</p>}
      {notice && <p className="font-mono px-3 pt-2" role="status" style={{ fontSize: 11, color: '#5ee7ff' }}>{notice}</p>}

      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-1.5 mb-4" data-testid="nb-doc-list">
          {docs.length === 0 && <p className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucun document. Ajoute un fichier TXT, Markdown, PDF, HTML ou JSON — il est analysé, découpé et indexé localement.</p>}
          {docs.map(d => {
            const rl = retentionLabel(d);
            return (
              <div key={d.documentId} data-testid="nb-doc-row" className="flex items-center justify-between gap-2 px-2.5 py-2 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ minWidth: 0 }}>
                  <p className="font-mono truncate" style={{ fontSize: 12, color: '#c0b0e0' }} title={d.title}>
                    {trustFilter === 'selected' && (
                      <input type="checkbox" aria-label={`Inclure ${d.title}`} data-testid="nb-doc-select" checked={selected.includes(d.documentId)}
                        onChange={e => setSelected(s => e.target.checked ? [...s, d.documentId] : s.filter(id => id !== d.documentId))} style={{ marginRight: 6 }} />
                    )}
                    <Lock size={9} style={{ display: 'inline', marginRight: 4, color: '#f87171' }} />{d.title}
                  </p>
                  <p className="font-mono flex items-center gap-2 flex-wrap" style={{ fontSize: 9, color: '#5a4a7a' }}>
                    <span>{Math.max(1, Math.round(d.size / 1024))} Ko{d.language ? ` · ${d.language}` : ''}</span>
                    <select data-testid="nb-doc-trust" aria-label={`Niveau de confiance de ${d.title}`} value={d.trustLevel} style={{ ...select, color: d.trustLevel === 'PAST_AI_OUTPUT' ? '#f59e0b' : '#94a3b8' }}
                      onChange={e => void handleTrust(d, e.target.value)}>
                      {TRUST_LEVELS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {rl && <span data-testid="nb-doc-retention-badge" style={{ color: '#f59e0b' }}><Clock size={8} style={{ display: 'inline', marginRight: 2 }} />{rl}</span>}
                    <StatusChip doc={d} />
                  </p>
                </div>
                {confirmDelete === d.documentId ? (
                  <span className="flex items-center gap-1 flex-shrink-0" role="group" aria-label={`Confirmer la suppression de ${d.title}`}>
                    <button type="button" data-testid="nb-doc-delete-confirm" autoFocus style={{ ...btn, color: '#ff4d58', borderColor: 'rgba(255,77,88,0.4)', fontSize: 10, padding: '3px 8px' }} onClick={() => void handleDelete(d)}>Supprimer</button>
                    <button type="button" data-testid="nb-doc-delete-cancel" style={{ ...ghost, fontSize: 10, padding: '3px 8px' }} onClick={() => setConfirmDelete(null)}>Annuler</button>
                  </span>
                ) : (
                  <button type="button" aria-label={`Supprimer ${d.title}`} data-testid="nb-doc-delete" onClick={() => setConfirmDelete(d.documentId)} style={{ background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer', flexShrink: 0 }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {(hits || answer) && (
          <div data-testid="nb-doc-results" aria-live="polite">
            {(label.text || vectorState) && (
              <p className="font-mono mb-2" style={{ fontSize: 9, color: label.warn ? '#f59e0b' : '#3d3060' }}>
                {label.text || `mode ${retrievalMode ?? ''}`}{vectorState === 'VECTOR_UNAVAILABLE' && !label.text.includes('VECTOR_UNAVAILABLE') ? ' · VECTOR_UNAVAILABLE' : ''}
              </p>
            )}
            {answer && (
              <div className="mb-3">
                {answer.status === 'NO_RELEVANT_SOURCE' && <p data-testid="nb-no-source" className="font-mono flex items-center gap-1.5" style={{ fontSize: 12, color: '#f59e0b' }}><AlertTriangle size={12} /> NO_RELEVANT_SOURCE — aucune source pertinente dans ce Notebook.</p>}
                {answer.status === 'OUTSIDE_NOTEBOOK' && <p data-testid="nb-outside" className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}>HORS NOTEBOOK — réponse générale, sans source ni citation.</p>}
                {answer.status !== 'NO_RELEVANT_SOURCE' && <p className="font-mono text-sm whitespace-pre-wrap" style={{ color: '#e2e8f0', lineHeight: 1.6, fontSize: 12 }}>{answer.answer}</p>}
                <p className="font-mono mt-1" data-testid="nb-confidence" style={{ fontSize: 9, color: '#5a4a7a' }}>{CONFIDENCE_LABEL[answer.confidence] ?? answer.confidence}</p>
                {answer.source_conflicts.length > 0 && (
                  <div data-testid="nb-conflicts" role="alert" className="mt-2 px-2.5 py-2 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                    <p className="font-mono flex items-center gap-1.5" style={{ fontSize: 10, color: '#f59e0b' }}><AlertTriangle size={11} /> Sources en conflit possible ({answer.source_conflicts.length}) — détection heuristique, non fusionnées</p>
                    {answer.source_conflicts.map((c, i) => (
                      <div key={`${c.a.chunkId}-${c.b.chunkId}-${i}`} data-testid="nb-conflict" className="mt-1.5" style={{ fontSize: 10, color: '#c0b0e0' }}>
                        <span className="font-mono">{c.type} :</span>
                        {[c.a, c.b].map((s, j) => (
                          <p key={j} className="font-mono" style={{ paddingLeft: 8, color: '#94a3b8' }}>
                            {s.citationId != null ? `[${s.citationId}] ` : ''}{s.sourceTitle} · v{s.documentVersion}{s.importedAt ? ` · ${new Date(s.importedAt).toLocaleDateString('fr-FR')}` : ''}{s.page != null ? ` · page ${s.page}` : ''} — « {s.excerpt} »
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {answer.uncertainties.filter(u => u.code !== 'SOURCE_CONFLICT').length > 0 && (
                  <ul data-testid="nb-uncertainties" className="mt-2 font-mono" style={{ fontSize: 9, color: '#94a3b8', listStyle: 'disc', paddingLeft: 16 }}>
                    {answer.uncertainties.filter(u => u.code !== 'SOURCE_CONFLICT').map(u => <li key={u.code}>{u.message}</li>)}
                  </ul>
                )}
              </div>
            )}
            {results.length === 0 && !answer && <p className="font-mono" style={{ fontSize: 11, color: '#3d3060' }}>Aucun extrait pertinent trouvé.</p>}
            {answer && answer.citations.map(c => (
              <div key={c.chunkId} data-testid="nb-doc-citation" className="px-2.5 py-2 rounded mb-1.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <button type="button" data-testid="nb-doc-citation-open" aria-label={`Ouvrir la citation ${c.ref} : ${c.sourceTitle}`} onClick={e => void openPreview(c.chunkId, e.currentTarget)}
                  className="font-mono" style={{ fontSize: 10, color: '#5ee7ff', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                  [{c.ref}] {c.sourceTitle} · v{c.documentVersion}{c.page != null ? ` · page ${c.page}` : ''}{c.superseded ? ' · version remplacée' : ''}{c.assertionType === 'PAST_AI_ASSERTION' ? ' · ancienne sortie IA (non vérifiée)' : ''}
                </button>
                <p className="font-mono mt-1" style={{ fontSize: 10, color: '#7a6c9a' }}>{c.passage}</p>
              </div>
            ))}
            {!answer && (hits ?? []).map(h => (
              <div key={h.chunkId} data-testid="nb-doc-hit" className="px-2.5 py-2 rounded mb-1.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <button type="button" data-testid="nb-doc-hit-open" aria-label={`Ouvrir l'extrait de ${h.sourceTitle}`} onClick={e => void openPreview(h.chunkId, e.currentTarget)}
                  className="font-mono" style={{ fontSize: 10, color: '#5ee7ff', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                  {h.sourceTitle} · v{h.documentVersion}{h.page != null ? ` · page ${h.page}` : ''} · {h.trustLevel}
                </button>
                {h.injectionFlags.length > 0 && <span className="font-mono" style={{ fontSize: 10, color: '#f59e0b' }}> · ⚠ texte d'instruction détecté (traité comme donnée)</span>}
                <p className="font-mono mt-1" style={{ fontSize: 10, color: '#7a6c9a' }}>{h.text}</p>
              </div>
            ))}
          </div>
        )}

        {preview && (
          <div ref={previewRef} tabIndex={-1} role="dialog" aria-label="Aperçu de la citation" data-testid="nb-citation-preview"
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closePreview(); } }}
            className="mt-3 px-3 py-2 rounded" style={{ background: 'rgba(94,231,255,0.05)', border: '1px solid rgba(94,231,255,0.25)', outline: 'none' }}>
            {'error' in preview ? (
              <p className="font-mono" style={{ fontSize: 11, color: '#ff4d58' }}>{preview.error}</p>
            ) : (
              <>
                <p className="font-mono" data-testid="nb-preview-meta" style={{ fontSize: 10, color: '#5ee7ff' }}>
                  {preview.sourceTitle} · version {preview.documentVersion}{preview.page != null ? ` · page ${preview.page}` : ''}
                  {preview.headingPath.length > 0 ? ` · ${preview.headingPath.join(' › ')}` : ''}
                  {preview.startOffset != null ? ` · offsets ${preview.startOffset}–${preview.endOffset}` : ''}
                  {preview.superseded ? ' · version remplacée' : ''} · {preview.trustLevel}
                </p>
                <p className="font-mono mt-2 whitespace-pre-wrap" data-testid="nb-preview-text" style={{ fontSize: 11, color: '#e2e8f0', lineHeight: 1.6 }}>{preview.text}</p>
              </>
            )}
            <button type="button" data-testid="nb-preview-close" aria-label="Fermer l'aperçu" style={{ ...ghost, marginTop: 8, fontSize: 10, padding: '3px 8px' }} onClick={closePreview}><X size={10} /> Fermer</button>
          </div>
        )}
      </div>

      <div className="px-3 pt-2 flex flex-wrap items-center gap-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}>
          Sources
          <select data-testid="nb-filter-trust" aria-label="Filtre de sources" style={select} value={trustFilter} onChange={e => setTrustFilter(e.target.value as NotebookTrustFilter | 'selected')}>
            <option value="all">Toutes</option><option value="trusted">De confiance</option><option value="user_authored">Rédigées par moi</option><option value="selected">Sélection…</option>
          </select>
        </label>
        <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}>
          <input type="checkbox" data-testid="nb-filter-historical" checked={historical} onChange={e => setHistorical(e.target.checked)} /> Anciennes versions
        </label>
        <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }} title="Seuils plus larges : plus de rappel, moins de précision">
          <input type="checkbox" data-testid="nb-filter-broad" checked={broad} onChange={e => setBroad(e.target.checked)} /> Recherche large
        </label>
        <label className="font-mono flex items-center gap-1" style={{ fontSize: 10, color: '#94a3b8' }}>
          <input type="checkbox" data-testid="nb-allow-outside" checked={allowOutside} onChange={e => setAllowOutside(e.target.checked)} /> Autoriser une réponse hors Notebook
        </label>
      </div>
      <div className="p-3 flex gap-2">
        <input data-testid="nb-doc-query" aria-label="Question ou recherche" style={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="Chercher ou poser une question sur les documents…"
          onKeyDown={e => { if (e.key === 'Enter' && !busy) void handleAsk(); }} disabled={ready === 0} />
        <button type="button" data-testid="nb-doc-search" aria-label="Rechercher (sans LLM)" title="Rechercher (sans LLM)" style={ghost} disabled={busy || ready === 0} onClick={() => void handleSearch()}><Search size={13} /></button>
        <button type="button" data-testid="nb-doc-ask" aria-label="Poser la question (LLM local)" title="Poser la question (LLM local)" style={btn} disabled={busy || ready === 0} onClick={() => void handleAsk()}>
          {busy ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
        </button>
      </div>
    </div>
  );
}
