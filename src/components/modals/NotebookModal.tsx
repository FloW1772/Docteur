import { useEffect, useState, useCallback } from 'react';
import { NotebookText, X, Plus, Trash2, Lock, Send, RefreshCw, ArrowLeft, Search } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { Notebook, NotebookSource, NotebookCitation, SearchResult } from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
}

const modalStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
};
const panelStyle: React.CSSProperties = {
  width: 1100, maxWidth: 'calc(100vw - 24px)', height: '86vh', display: 'flex', flexDirection: 'column',
  background: '#0d0f14', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
  borderRadius: 6, color: '#a78bfa', padding: '7px 14px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const btnGhostStyle: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '8px 10px', fontSize: 13, width: '100%',
  fontFamily: 'inherit', outline: 'none',
};

// Matches the backend's own default page size (routes/notebook.js,
// GET /notebooks/:id/sources — capped at 500). Batch B (finding F5): sources
// used to be fetched as one fixed 200-row page with no way to see the rest
// of a larger notebook.
const SOURCES_PAGE_SIZE = 100;

function formatDate(iso: string) {
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }); } catch { return iso; }
}

// ── Notebook list (landing view) ────────────────────────────────────────────

function NotebookList({ onOpen }: { onOpen: (id: string) => void }) {
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await cortexClient.listNotebooks();
      setNotebooks(r.notebooks);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function handleCreate() {
    const title = newTitle.trim();
    if (!title) return;
    try {
      const r = await cortexClient.createNotebook(title);
      setNewTitle('');
      setCreating(false);
      await reload();
      onOpen(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Supprimer ce Notebook ? Les sources (neurones, documents) ne seront pas supprimées.')) return;
    try {
      await cortexClient.deleteNotebook(id);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="p-4 flex-1 overflow-y-auto">
      {error && <p className="font-mono text-xs mb-3" style={{ color: '#ff4d58' }}>{error}</p>}

      {creating ? (
        <div className="flex gap-2 mb-4">
          <input
            autoFocus
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="Titre du Notebook…"
            style={inputStyle}
          />
          <button type="button" onClick={handleCreate} style={btnStyle}>Créer</button>
          <button type="button" onClick={() => setCreating(false)} style={btnGhostStyle}>Annuler</button>
        </div>
      ) : (
        <button type="button" onClick={() => setCreating(true)} style={{ ...btnStyle, marginBottom: 16 }}>
          <Plus size={13} /> Nouveau Notebook
        </button>
      )}

      {notebooks === null ? (
        <div className="flex items-center justify-center py-12"><RefreshCw size={16} className="animate-spin" style={{ color: '#3d3060' }} /></div>
      ) : notebooks.length === 0 ? (
        <p className="font-mono text-xs" style={{ color: '#5a4a7a' }}>Aucun Notebook pour l'instant. Crée-en un pour regrouper des sources (neurones, documents, recherches) et poser des questions dessus.</p>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {notebooks.map(nb => (
            <div
              key={nb.id}
              onClick={() => onOpen(nb.id)}
              className="p-3 rounded cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>{nb.title}</span>
                <div className="flex items-center gap-1.5">
                  {nb.privacy && <Lock size={11} style={{ color: '#f87171' }} />}
                  <button type="button" onClick={e => handleDelete(nb.id, e)} style={{ background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer', padding: 2 }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>
                {nb.source_count ?? 0} source{(nb.source_count ?? 0) !== 1 ? 's' : ''} · {formatDate(nb.updated_at)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Notebook detail (3-column: sources | chat | summary) ───────────────────

function NotebookDetail({ notebookId, onBack }: { notebookId: string; onBack: () => void }) {
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [sources, setSources] = useState<NotebookSource[]>([]);
  const [sourcesTotal, setSourcesTotal] = useState(0);
  const [loadingMoreSources, setLoadingMoreSources] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult['results']>([]);
  const [searching, setSearching] = useState(false);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<NotebookCitation[]>([]);
  const [askError, setAskError] = useState<string | null>(null);

  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [rightTab, setRightTab] = useState<'summary' | 'soon'>('summary');
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportNeedsConfirm, setExportNeedsConfirm] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [nb, src] = await Promise.all([
        cortexClient.getNotebook(notebookId),
        cortexClient.listNotebookSources(notebookId, SOURCES_PAGE_SIZE),
      ]);
      setNotebook(nb.notebook);
      setSources(src.sources);
      setSourcesTotal(src.total);
    } catch { /* surfaced via empty state */ }
  }, [notebookId]);

  useEffect(() => { void reload(); }, [reload]);

  async function loadMoreSources() {
    if (loadingMoreSources) return;
    setLoadingMoreSources(true);
    try {
      const next = await cortexClient.listNotebookSources(notebookId, SOURCES_PAGE_SIZE, sources.length);
      setSources(prev => [...prev, ...next.sources]);
      setSourcesTotal(next.total);
    } catch { /* keep the already-loaded page visible on failure */ }
    finally { setLoadingMoreSources(false); }
  }

  async function handleSearch() {
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const r = await cortexClient.search(q, { limit: 15 });
      setSearchResults(r.results);
    } catch { setSearchResults([]); }
    finally { setSearching(false); }
  }

  async function handleAddSource(result: SearchResult['results'][number]) {
    try {
      await cortexClient.addNotebookSource(notebookId, { source_id: result.id, title: result.title, kind: result.kind });
      setSearchResults(prev => prev.filter(r => r.id !== result.id));
      await reload();
    } catch { /* ignore — user can retry */ }
  }

  async function handleRemoveSource(sourceRowId: string) {
    try {
      await cortexClient.removeNotebookSource(notebookId, sourceRowId);
      await reload();
    } catch { /* ignore */ }
  }

  async function handleAsk() {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    setCitations([]);
    try {
      const r = await cortexClient.askNotebook(notebookId, q);
      setAnswer(r.answer);
      setCitations(r.citations);
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }

  async function loadSummary() {
    setSummaryLoading(true);
    try {
      const r = await cortexClient.getNotebookSummary(notebookId);
      setSummary(r.content || 'Aucune source dans ce Notebook — ajoute des sources pour générer un résumé.');
    } catch (e) {
      setSummary(`Erreur : ${(e as Error).message}`);
    } finally {
      setSummaryLoading(false);
    }
  }

  async function handleExportForNotebookLm(confirm = false) {
    setExporting(true);
    setExportResult(null);
    setExportNeedsConfirm(false);
    try {
      const r = await cortexClient.exportNotebookForNotebookLm(notebookId, confirm);
      setExportResult(`${r.notice} (${r.filename}, ${r.source_count} source${r.source_count !== 1 ? 's' : ''})`);
    } catch (e) {
      const err = e as Error & { requiresConfirmation?: boolean };
      if (err.requiresConfirmation) setExportNeedsConfirm(true);
      else setExportResult(`Erreur : ${err.message}`);
    } finally {
      setExporting(false);
    }
  }

  if (!notebook) {
    return <div className="flex-1 flex items-center justify-center"><RefreshCw size={16} className="animate-spin" style={{ color: '#3d3060' }} /></div>;
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* LEFT — Sources */}
      <div className="flex flex-col" style={{ width: 260, borderRight: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div className="p-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <button type="button" onClick={onBack} className="flex items-center gap-1 font-mono mb-2" style={{ fontSize: 11, color: '#5a4a7a', background: 'none', border: 'none', cursor: 'pointer' }}>
            <ArrowLeft size={11} /> Notebooks
          </button>
          <div className="flex items-center gap-1.5">
            {notebook.privacy && <Lock size={12} style={{ color: '#f87171' }} />}
            <span className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>{notebook.title}</span>
          </div>
          <p className="font-mono mt-1" style={{ fontSize: 10, color: '#5a4a7a' }}>
            {sourcesTotal} source{sourcesTotal !== 1 ? 's' : ''}{notebook.privacy ? ' · local uniquement' : ''}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {sources.map(s => (
            <div key={s.id} className="flex items-center justify-between gap-1 px-2 py-1.5 rounded mb-1" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <span className="font-mono truncate" style={{ fontSize: 11, color: '#c0b0e0' }} title={s.title}>
                {s.privacy && <Lock size={9} style={{ display: 'inline', marginRight: 4, color: '#f87171' }} />}
                {s.title}
              </span>
              <button type="button" onClick={() => handleRemoveSource(s.id)} style={{ background: 'none', border: 'none', color: '#3d3060', cursor: 'pointer', flexShrink: 0 }}>
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          {sources.length === 0 && <p className="font-mono px-2" style={{ fontSize: 10, color: '#3d3060' }}>Aucune source. Ajoute des neurones existants ci-dessous.</p>}
          {sources.length < sourcesTotal && (
            <button
              type="button"
              onClick={() => void loadMoreSources()}
              disabled={loadingMoreSources}
              className="flex items-center justify-center gap-1.5 w-full font-mono mt-1 py-1.5"
              style={{ fontSize: 10, color: '#5a4a7a', background: 'none', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 6, cursor: loadingMoreSources ? 'not-allowed' : 'pointer' }}
            >
              {loadingMoreSources
                ? <RefreshCw size={10} className="animate-spin" />
                : `Charger plus (${sources.length}/${sourcesTotal})`}
            </button>
          )}
        </div>

        <div className="p-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {addingSource ? (
            <div>
              <div className="flex gap-1 mb-2">
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder="Rechercher un neurone…"
                  style={{ ...inputStyle, fontSize: 11, padding: '5px 8px' }}
                />
                <button type="button" onClick={handleSearch} style={{ ...btnGhostStyle, padding: '5px 8px' }}><Search size={11} /></button>
              </div>
              <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                {searching && <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a' }}>Recherche…</p>}
                {searchResults.map(r => (
                  <div key={r.id} className="flex items-center justify-between gap-1 px-1.5 py-1 rounded mb-1" style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <span className="font-mono truncate" style={{ fontSize: 10, color: '#c0b0e0' }}>{r.title}</span>
                    <button type="button" onClick={() => handleAddSource(r)} style={{ background: 'none', border: 'none', color: '#3dffaa', cursor: 'pointer', flexShrink: 0 }}>
                      <Plus size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => { setAddingSource(false); setSearchResults([]); setSearchQuery(''); }} style={{ ...btnGhostStyle, marginTop: 6, width: '100%', justifyContent: 'center' }}>Fermer</button>
            </div>
          ) : (
            <button type="button" onClick={() => setAddingSource(true)} style={{ ...btnStyle, width: '100%', justifyContent: 'center' }}>
              <Plus size={12} /> Ajouter une source
            </button>
          )}
        </div>
      </div>

      {/* CENTER — Chat / Q&A with citations */}
      <div className="flex-1 flex flex-col" style={{ borderRight: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex-1 overflow-y-auto p-4">
          {askError && <p className="font-mono text-xs mb-3" style={{ color: '#ff4d58' }}>{askError}</p>}
          {answer && (
            <div className="mb-4">
              <p className="font-mono text-sm whitespace-pre-wrap" style={{ color: '#e2e8f0', lineHeight: 1.6 }}>{answer}</p>
              {citations.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5">
                  <span className="font-mono" style={{ fontSize: 9, color: '#3d3060', letterSpacing: '0.08em' }}>CITATIONS</span>
                  {citations.map(c => (
                    <div key={c.chunkId} className="px-2.5 py-2 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <span className="font-mono" style={{ fontSize: 10, color: '#5ee7ff' }}>[{c.ref}] {c.sourceTitle}</span>
                      <p className="font-mono mt-1" style={{ fontSize: 10, color: '#7a6c9a' }}>{c.passage}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!answer && !askError && (
            <p className="font-mono text-xs" style={{ color: '#3d3060' }}>
              Pose une question sur les sources de ce Notebook. La réponse cite uniquement les extraits réellement retrouvés — jamais une source inventée.
            </p>
          )}
        </div>
        <div className="p-3 flex gap-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !asking && handleAsk()}
            placeholder="Poser une question sur ce Notebook…"
            style={inputStyle}
            disabled={sources.length === 0}
          />
          <button type="button" onClick={handleAsk} disabled={asking || sources.length === 0} style={{ ...btnStyle, cursor: asking || sources.length === 0 ? 'not-allowed' : 'pointer' }}>
            {asking ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
          </button>
        </div>
      </div>

      {/* RIGHT — Summary / FAQ / flashcards etc. */}
      <div className="flex flex-col" style={{ width: 300, overflow: 'hidden' }}>
        <div className="flex" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <button type="button" onClick={() => { setRightTab('summary'); if (!summary) void loadSummary(); }}
            className="flex-1 font-mono py-2" style={{ fontSize: 10, color: rightTab === 'summary' ? '#3dffaa' : '#5a4a7a', background: 'none', border: 'none', borderBottom: rightTab === 'summary' ? '2px solid #3dffaa' : '2px solid transparent', cursor: 'pointer', letterSpacing: '0.05em' }}>
            RÉSUMÉ
          </button>
          <button type="button" onClick={() => setRightTab('soon')}
            className="flex-1 font-mono py-2" style={{ fontSize: 10, color: rightTab === 'soon' ? '#3dffaa' : '#5a4a7a', background: 'none', border: 'none', borderBottom: rightTab === 'soon' ? '2px solid #3dffaa' : '2px solid transparent', cursor: 'pointer', letterSpacing: '0.05em' }}>
            OUTILS
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {rightTab === 'summary' && (
            summaryLoading ? (
              <div className="flex items-center justify-center py-8"><RefreshCw size={14} className="animate-spin" style={{ color: '#3d3060' }} /></div>
            ) : summary ? (
              <p className="font-mono whitespace-pre-wrap" style={{ fontSize: 11, color: '#c0b0e0', lineHeight: 1.6 }}>{summary}</p>
            ) : (
              <button type="button" onClick={loadSummary} style={{ ...btnGhostStyle, width: '100%', justifyContent: 'center' }} disabled={sources.length === 0}>
                Générer le résumé
              </button>
            )
          )}
          {rightTab === 'soon' && (
            <div className="flex flex-col gap-3">
              <p className="font-mono" style={{ fontSize: 11, color: '#5a4a7a', lineHeight: 1.6 }}>
                Points clés, FAQ, fiche d'étude, questions de révision, flashcards, chronologie,
                glossaire et comparaison de sources ne sont pas encore implémentés dans cette phase —
                seuls le résumé global et les questions/réponses avec citations sont disponibles pour
                le moment. Ces outils supplémentaires nécessitent leur propre conception (format de
                données, prompts dédiés) et sont prévus pour un incrément futur.
              </p>

              <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.05em' }}>EXPORT MANUEL</p>
                <p className="font-mono mb-2" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.5 }}>
                  Crée un fichier Markdown local à partir des sources de ce Notebook. N'appelle
                  jamais Google ni NotebookLM — c'est un export manuel que tu importes toi-même
                  où tu le souhaites.
                </p>
                {exportNeedsConfirm && (
                  <div className="mb-2 px-2.5 py-2 rounded" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
                    <p className="font-mono mb-2" style={{ fontSize: 10, color: '#f59e0b' }}>
                      Ce Notebook contient des sources locales/privées. Confirmer l'export quand même ?
                    </p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => handleExportForNotebookLm(true)} style={{ ...btnStyle, fontSize: 10 }}>Confirmer</button>
                      <button type="button" onClick={() => setExportNeedsConfirm(false)} style={{ ...btnGhostStyle, fontSize: 10 }}>Annuler</button>
                    </div>
                  </div>
                )}
                {!exportNeedsConfirm && (
                  <button type="button" onClick={() => handleExportForNotebookLm(false)} disabled={exporting || sources.length === 0} style={{ ...btnGhostStyle, width: '100%', justifyContent: 'center' }}>
                    {exporting ? <RefreshCw size={11} className="animate-spin" /> : 'Préparer pour NotebookLM'}
                  </button>
                )}
                {exportResult && <p className="font-mono mt-2" style={{ fontSize: 10, color: '#3dffaa', lineHeight: 1.5 }}>{exportResult}</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function NotebookModal({ onClose }: Props) {
  const [openNotebookId, setOpenNotebookId] = useState<string | null>(null);

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex items-center gap-2">
            <NotebookText size={15} style={{ color: '#a78bfa' }} />
            <span className="font-grotesk font-semibold text-sm" style={{ color: '#f0eaff' }}>Notebook local</span>
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {openNotebookId ? (
          <NotebookDetail notebookId={openNotebookId} onBack={() => setOpenNotebookId(null)} />
        ) : (
          <NotebookList onOpen={setOpenNotebookId} />
        )}
      </div>
    </div>
  );
}
