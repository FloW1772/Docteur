import { useState, useEffect, useRef } from 'react';
import { X, Check, AlertTriangle, RefreshCw, Bookmark, BookmarkCheck, Columns2, List } from 'lucide-react';
import { cortexClient, type CompareEvent, type CompareModelResult } from '../../lib/cortex/client';
import { MarkdownContent } from '../../lib/renderMd';

// ── Model display metadata ─────────────────────────────────────────────────────

interface ModelMeta { label: string; provider: string; cost: string; local: boolean }

const CLOUD_META: Record<string, ModelMeta> = {
  gemini:     { label: 'Gemini',     provider: 'Google',     cost: 'gratuit', local: false },
  groq:       { label: 'Groq',       provider: 'Groq',       cost: 'gratuit', local: false },
  openrouter: { label: 'OpenRouter', provider: 'OpenRouter', cost: 'gratuit', local: false },
};

function modelMeta(id: string): ModelMeta {
  if (CLOUD_META[id]) return CLOUD_META[id];
  return { label: id, provider: 'Ollama', cost: 'gratuit', local: true };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ModelStatus = 'pending' | 'running' | 'done' | 'error' | 'blocked';

interface ModelState {
  id:      string;
  status:  ModelStatus;
  result?: CompareModelResult;
  error?:  string;
}

interface Props {
  question:         string;
  onClose:          () => void;
  onSaveResponse:   (question: string, answer: string, modelId: string, modelUsed: string) => Promise<void>;
  onSaveComparison: (question: string, results: CompareModelResult[]) => Promise<void>;
}

const SELECTION_KEY = 'docteur.compareSelection';
const MAX_MODELS    = 5;
const CLOUD_IDS     = new Set(['gemini', 'groq', 'openrouter']);

// ── Component ─────────────────────────────────────────────────────────────────

export default function CompareModal({ question, onClose, onSaveResponse, onSaveComparison }: Props) {
  // Available models state
  const [localModels,  setLocalModels]  = useState<string[]>([]);
  const [cloudActive,  setCloudActive]  = useState<Record<string, boolean>>({});
  const [strictLocal,  setStrictLocal]  = useState(false);
  const [loadingSetup, setLoadingSetup] = useState(true);

  // Selection (persisted)
  const [selected, setSelected] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '[]') as string[]); }
    catch { return new Set(); }
  });

  // Execution state
  const [phase,    setPhase]    = useState<'select' | 'running' | 'done'>('select');
  const [models,   setModels]   = useState<ModelState[]>([]);
  const [hasPrivate, setHasPrivate] = useState(false);
  const [activeTab, setActiveTab]  = useState('');
  const [sideBySide, setSideBySide] = useState(false);

  // Save state
  const [savedIds,        setSavedIds]        = useState<Set<string>>(new Set());
  const [savingId,        setSavingId]        = useState<string | null>(null);
  const [savedComparison, setSavedComparison] = useState(false);
  const [savingComparison, setSavingComparison] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // Load available models + cloud keys on open
  useEffect(() => {
    void (async () => {
      try {
        const [ollama, keys, routerSettings] = await Promise.all([
          cortexClient.ollamaModels().catch(() => ({ models: [] as { name: string }[] })),
          cortexClient.getCloudKeys().catch(() => null),
          cortexClient.routerSettings().catch(() => null),
        ]);
        setLocalModels((ollama.models ?? []).map((m: { name: string }) => m.name));
        setCloudActive({
          gemini:     keys?.gemini_active     ?? false,
          groq:       keys?.groq_active       ?? false,
          openrouter: keys?.openrouter_active ?? false,
        });
        setStrictLocal(routerSettings?.strict_local_mode === true);
      } finally {
        setLoadingSetup(false);
      }
    })();
  }, []);

  // Restore selection: remove models that are no longer available
  useEffect(() => {
    if (loadingSetup) return;
    const available = new Set([...localModels, ...Object.keys(cloudActive).filter(k => cloudActive[k])]);
    setSelected(prev => {
      const pruned = new Set([...prev].filter(id => available.has(id)));
      if (pruned.size !== prev.size) localStorage.setItem(SELECTION_KEY, JSON.stringify([...pruned]));
      return pruned;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingSetup]);

  function toggleModel(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else if (next.size < MAX_MODELS) { next.add(id); }
      localStorage.setItem(SELECTION_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  async function handleStart() {
    const modelIds = [...selected];
    setModels(modelIds.map(id => ({ id, status: 'pending' })));
    setPhase('running');
    setActiveTab(modelIds[0] ?? '');

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await cortexClient.compareModels(
        { question, models: modelIds, max_context: 5 },
        (evt: CompareEvent) => {
          if (evt.type === 'ready') {
            const priv = evt.has_private_sources ?? false;
            setHasPrivate(priv);
            if (priv) {
              setModels(prev => prev.map(m =>
                CLOUD_IDS.has(m.id)
                  ? { ...m, status: 'blocked', error: 'Neurones privés détectés — cloud désactivé pour cette question' }
                  : m
              ));
            }
          } else if (evt.type === 'progress') {
            setModels(prev => prev.map(m => m.id === evt.model_id ? { ...m, status: 'running' } : m));
          } else if (evt.type === 'result') {
            const result: CompareModelResult = {
              model_id:   evt.model_id   ?? '',
              answer:     evt.answer     ?? '',
              model_used: evt.model_used ?? evt.model_id ?? '',
              provider:   evt.provider   ?? '',
              latency_ms: evt.latency_ms ?? 0,
              sources:    evt.sources    ?? [],
            };
            setModels(prev => prev.map(m => m.id === result.model_id ? { ...m, status: 'done', result } : m));
          } else if (evt.type === 'error') {
            setModels(prev => prev.map(m =>
              m.id === evt.model_id ? { ...m, status: 'error', error: evt.error } : m
            ));
          } else if (evt.type === 'done') {
            setPhase('done');
          }
        },
        ctrl.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setPhase('done');
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
    setPhase('done');
  }

  async function handleSaveResponse(m: ModelState) {
    if (!m.result) return;
    setSavingId(m.id);
    try {
      await onSaveResponse(question, m.result.answer, m.id, m.result.model_used);
      setSavedIds(prev => new Set(prev).add(m.id));
    } finally {
      setSavingId(null);
    }
  }

  async function handleSaveComparison() {
    const done = models.filter(m => m.status === 'done' && m.result).map(m => m.result!);
    if (done.length === 0) return;
    setSavingComparison(true);
    try {
      await onSaveComparison(question, done);
      setSavedComparison(true);
    } finally {
      setSavingComparison(false);
    }
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1300,
    background: 'rgba(5,0,15,0.88)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  };
  const box: React.CSSProperties = {
    background: '#0a0618',
    border: '1px solid rgba(94,231,255,0.12)',
    borderRadius: 14,
    width: '100%', maxWidth: sideBySide ? 980 : 640,
    maxHeight: 'calc(100vh - 32px)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'IBM Plex Mono, monospace',
    color: '#c0b0e0',
    boxShadow: '0 40px 100px rgba(0,0,0,0.6)',
    transition: 'max-width 0.25s ease',
  };

  const doneResults = models.filter(m => m.status === 'done' && m.result);
  const canSideBySide = doneResults.length >= 2;
  const activeModel  = models.find(m => m.id === activeTab);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={box}>
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '16px 20px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: '#5ee7ff', letterSpacing: '0.1em', marginBottom: 6 }}>
              ⊞ COMPARAISON MULTI-MODÈLES
            </div>
            <p style={{ fontSize: 13, color: '#e0d8ff', margin: 0, lineHeight: 1.5, wordBreak: 'break-word' }}>
              {question}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {canSideBySide && (
              <button
                type="button"
                title={sideBySide ? 'Vue onglets' : 'Vue côte à côte'}
                onClick={() => setSideBySide(s => !s)}
                style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: sideBySide ? '#5ee7ff' : '#5a4a7a', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}
              >
                {sideBySide ? <List size={14} /> : <Columns2 size={14} />}
              </button>
            )}
            <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer', padding: 4 }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Body (scrollable) ────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

          {/* ── SELECT PHASE ────────────────────────────────────────────────── */}
          {phase === 'select' && (
            <div style={{ padding: '20px 20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
              {loadingSetup ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#5a4a7a', fontSize: 12 }}>
                  <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
                  Chargement des modèles…
                </div>
              ) : (
                <>
                  {/* Local models */}
                  <div>
                    <div style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', marginBottom: 10 }}>
                      LOCAUX — {localModels.length} modèle{localModels.length !== 1 ? 's' : ''} installé{localModels.length !== 1 ? 's' : ''}
                    </div>
                    {localModels.length === 0 ? (
                      <p style={{ fontSize: 11, color: '#5a4a7a' }}>Aucun modèle Ollama installé.</p>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {localModels.map(id => {
                          const on = selected.has(id);
                          const full = !on && selected.size >= MAX_MODELS;
                          return (
                            <button
                              key={id}
                              type="button"
                              disabled={full}
                              onClick={() => toggleModel(id)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                padding: '7px 12px', borderRadius: 8,
                                border: `1px solid ${on ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.08)'}`,
                                background: on ? 'rgba(61,255,170,0.08)' : 'transparent',
                                color: full ? '#3d3060' : on ? '#3dffaa' : '#c0b0e0',
                                cursor: full ? 'not-allowed' : 'pointer',
                                fontSize: 11,
                              }}
                            >
                              {on && <Check size={10} />}
                              {id}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Cloud models */}
                  <div>
                    <div style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', marginBottom: 10 }}>
                      CLOUD {strictLocal ? '— mode local actif' : ''}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {(['gemini', 'groq', 'openrouter'] as const).map(id => {
                        const active = cloudActive[id] && !strictLocal;
                        const meta   = CLOUD_META[id];
                        const on     = selected.has(id);
                        const full   = !on && selected.size >= MAX_MODELS;
                        const reason = !cloudActive[id]
                          ? 'clé non configurée'
                          : strictLocal ? 'mode strictement local' : '';
                        return (
                          <button
                            key={id}
                            type="button"
                            disabled={!active || full}
                            onClick={() => active && toggleModel(id)}
                            title={reason || undefined}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6,
                              padding: '7px 12px', borderRadius: 8,
                              border: `1px solid ${on ? 'rgba(94,231,255,0.4)' : active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)'}`,
                              background: on ? 'rgba(94,231,255,0.08)' : 'transparent',
                              color: !active ? '#3d3060' : full ? '#3d3060' : on ? '#5ee7ff' : '#c0b0e0',
                              cursor: active && !full ? 'pointer' : 'not-allowed',
                              fontSize: 11,
                            }}
                          >
                            {on && <Check size={10} />}
                            {meta.label}
                            {!active && <span style={{ fontSize: 9, color: '#3d3060', marginLeft: 2 }}>({reason})</span>}
                          </button>
                        );
                      })}
                    </div>
                    {strictLocal && (
                      <p style={{ fontSize: 10, color: '#ffb547', marginTop: 8 }}>
                        🔒 Mode strictement local — les options cloud sont désactivées.
                      </p>
                    )}
                  </div>

                  {/* Selection count + cost */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: '#5a4a7a' }}>
                    <span>{selected.size} / {MAX_MODELS} modèle{selected.size > 1 ? 's' : ''} sélectionné{selected.size > 1 ? 's' : ''}</span>
                    {selected.size > 0 && (
                      <span>
                        Coût estimé : {[...selected].map(id => {
                          const m = modelMeta(id);
                          return `${m.label} (${m.cost})`;
                        }).join(' · ')}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button type="button" onClick={onClose}
                      style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '7px 16px', fontSize: 11, color: '#7a6c9a', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace' }}>
                      Annuler
                    </button>
                    <button
                      type="button"
                      disabled={selected.size === 0}
                      onClick={handleStart}
                      style={{
                        background: selected.size > 0 ? 'rgba(94,231,255,0.12)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${selected.size > 0 ? 'rgba(94,231,255,0.3)' : 'rgba(255,255,255,0.06)'}`,
                        borderRadius: 6, padding: '7px 16px', fontSize: 11,
                        color: selected.size > 0 ? '#5ee7ff' : '#3d3060',
                        cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
                        fontFamily: 'IBM Plex Mono, monospace',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      Comparer →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── RUNNING / DONE PHASE ────────────────────────────────────────── */}
          {(phase === 'running' || phase === 'done') && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {/* Status row */}
              <div style={{
                display: 'flex', gap: 6, padding: '12px 20px 10px',
                flexWrap: 'wrap', borderBottom: '1px solid rgba(255,255,255,0.04)',
                flexShrink: 0,
              }}>
                {models.map(m => {
                  const meta = modelMeta(m.id);
                  const dot = m.status === 'running'
                    ? { color: '#5ee7ff', icon: <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} /> }
                    : m.status === 'done'
                    ? { color: '#3dffaa', icon: <Check size={10} /> }
                    : m.status === 'error' || m.status === 'blocked'
                    ? { color: '#ff4d58', icon: <AlertTriangle size={10} /> }
                    : { color: '#3d3060', icon: null };

                  const isActive = activeTab === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setActiveTab(m.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '5px 12px', borderRadius: 8, fontSize: 11,
                        border: `1px solid ${isActive ? 'rgba(94,231,255,0.3)' : 'rgba(255,255,255,0.06)'}`,
                        background: isActive ? 'rgba(94,231,255,0.07)' : 'transparent',
                        color: isActive ? '#e0d8ff' : '#5a4a7a',
                        cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace',
                        transition: 'all 0.15s',
                      }}
                    >
                      <span style={{ color: dot.color }}>{dot.icon}</span>
                      {meta.label}
                      {m.status === 'done' && m.result && (
                        <span style={{ fontSize: 9, color: '#3d3060' }}>
                          {(m.result.latency_ms / 1000).toFixed(1)}s
                        </span>
                      )}
                    </button>
                  );
                })}
                {phase === 'running' && (
                  <button
                    type="button"
                    onClick={handleAbort}
                    style={{
                      marginLeft: 'auto', padding: '5px 12px', borderRadius: 8, fontSize: 11,
                      border: '1px solid rgba(255,77,88,0.2)', background: 'rgba(255,77,88,0.06)',
                      color: '#ff4d58', cursor: 'pointer', fontFamily: 'IBM Plex Mono, monospace',
                    }}
                  >
                    Annuler
                  </button>
                )}
              </div>

              {/* Privacy notice */}
              {hasPrivate && (
                <div style={{
                  margin: '10px 20px 0',
                  padding: '8px 12px', borderRadius: 8, fontSize: 11,
                  background: 'rgba(244,114,182,0.07)', border: '1px solid rgba(244,114,182,0.2)',
                  color: '#f472b6', display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span>🔒</span>
                  Neurones privés détectés — les modèles cloud ont été désactivés pour cette question.
                </div>
              )}

              {/* Side-by-side layout */}
              {sideBySide && canSideBySide ? (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${Math.min(doneResults.length, 2)}, 1fr)`,
                  gap: 0, flex: 1,
                }}>
                  {doneResults.map(m => (
                    <ResultPane
                      key={m.id}
                      m={m}
                      saved={savedIds.has(m.id)}
                      saving={savingId === m.id}
                      onSave={() => handleSaveResponse(m)}
                      bordered
                    />
                  ))}
                </div>
              ) : (
                /* Tab layout */
                <>
                  {activeModel && (
                    <div key={activeModel.id}>
                      {activeModel.status === 'pending' && (
                        <div style={{ padding: '32px 20px', color: '#3d3060', fontSize: 12, textAlign: 'center' }}>En attente…</div>
                      )}
                      {activeModel.status === 'running' && (
                        <div style={{ padding: '32px 20px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#5ee7ff', fontSize: 12 }}>
                          <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                          Génération en cours…
                        </div>
                      )}
                      {(activeModel.status === 'error' || activeModel.status === 'blocked') && (
                        <div style={{ padding: '20px', margin: '12px 20px', borderRadius: 8, background: 'rgba(255,77,88,0.07)', border: '1px solid rgba(255,77,88,0.2)', color: '#ff4d58', fontSize: 12 }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>Erreur</div>
                          {activeModel.error}
                        </div>
                      )}
                      {activeModel.status === 'done' && activeModel.result && (
                        <ResultPane
                          m={activeModel}
                          saved={savedIds.has(activeModel.id)}
                          saving={savingId === activeModel.id}
                          onSave={() => handleSaveResponse(activeModel)}
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Footer: save comparison ─────────────────────────────────────── */}
        {(phase === 'running' || phase === 'done') && doneResults.length > 0 && (
          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.05)',
            padding: '10px 20px',
            flexShrink: 0,
            display: 'flex', justifyContent: 'flex-end',
          }}>
            <button
              type="button"
              disabled={savedComparison || savingComparison}
              onClick={handleSaveComparison}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 14px', borderRadius: 6, fontSize: 11,
                border: savedComparison ? '1px solid rgba(61,255,170,0.2)' : '1px solid rgba(255,255,255,0.1)',
                background: savedComparison ? 'rgba(61,255,170,0.06)' : 'transparent',
                color: savedComparison ? '#3dffaa' : '#7a6c9a',
                cursor: savedComparison ? 'default' : 'pointer',
                fontFamily: 'IBM Plex Mono, monospace',
              }}
            >
              {savingComparison ? <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} /> :
               savedComparison  ? <BookmarkCheck size={10} /> : <Bookmark size={10} />}
              {savedComparison ? 'Comparaison sauvegardée' : 'Sauvegarder la comparaison'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ResultPane sub-component ───────────────────────────────────────────────────

interface ResultPaneProps {
  m:       ModelState;
  saved:   boolean;
  saving:  boolean;
  onSave:  () => void;
  bordered?: boolean;
}

function ResultPane({ m, saved, saving, onSave, bordered }: ResultPaneProps) {
  const meta = modelMeta(m.id);
  if (!m.result) return null;
  const r = m.result;

  return (
    <div style={{
      padding: '16px 20px 20px',
      borderLeft: bordered ? '1px solid rgba(255,255,255,0.04)' : undefined,
    }}>
      {/* Model info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: '#5ee7ff', fontFamily: 'IBM Plex Mono, monospace' }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 9, color: '#3d3060', fontFamily: 'IBM Plex Mono, monospace' }}>
          {meta.provider}
        </span>
        <span style={{ fontSize: 9, color: '#5a4a7a', fontFamily: 'IBM Plex Mono, monospace', marginLeft: 'auto' }}>
          {(r.latency_ms / 1000).toFixed(1)}s · {r.sources.length} neurone{r.sources.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Answer */}
      <div style={{ fontSize: 13, lineHeight: 1.7, color: '#e0d8ff' }}>
        <MarkdownContent text={r.answer} />
      </div>

      {/* Sources */}
      {r.sources.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {r.sources.map(s => (
            <span key={s.id} style={{
              fontSize: 9, padding: '2px 6px', borderRadius: 4,
              background: 'rgba(255,255,255,0.04)', color: '#5a4a7a',
              fontFamily: 'IBM Plex Mono, monospace',
            }}>
              {s.title}
            </span>
          ))}
        </div>
      )}

      {/* Save this response */}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={saved || saving}
          onClick={onSave}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 12px', borderRadius: 6, fontSize: 10,
            border: saved ? '1px solid rgba(61,255,170,0.2)' : '1px solid rgba(255,255,255,0.1)',
            background: saved ? 'rgba(61,255,170,0.06)' : 'transparent',
            color: saved ? '#3dffaa' : '#5a4a7a',
            cursor: saved ? 'default' : 'pointer',
            fontFamily: 'IBM Plex Mono, monospace',
          }}
        >
          {saving ? <RefreshCw size={9} style={{ animation: 'spin 1s linear infinite' }} /> :
           saved   ? <BookmarkCheck size={9} /> : <Bookmark size={9} />}
          {saved ? 'Sauvegardé' : 'Sauvegarder cette réponse'}
        </button>
      </div>
    </div>
  );
}
