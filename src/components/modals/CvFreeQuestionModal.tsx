import { useEffect, useState, useCallback } from 'react';
import { X, Send, Copy, Save, RefreshCw, MessageSquarePlus, RotateCcw, Trash2, Pencil, Check, GripVertical, Library } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { CandidatureSavedPrompt } from '../../lib/cortex/client';

interface ChainTurn {
  question: string;
  answer: string;
}

interface Props {
  cvTitle: string;
  onAsk: (params: { question: string; chainHistory: ChainTurn[]; powerful: boolean }) => Promise<{
    answer: string;
    model_used: string;
    context_tokens_estimate: number;
    context_warning: boolean;
  }>;
  onSaveResult: (params: { question: string; answer: string; modelUsed: string }) => Promise<void>;
  onClose: () => void;
}

const modalStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
};
const panelStyle: React.CSSProperties = {
  width: 820, maxWidth: 'calc(100vw - 24px)', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
  background: '#130f1e', border: '1px solid rgba(244,114,182,0.15)',
  borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(244,114,182,0.12)', border: '1px solid rgba(244,114,182,0.35)',
  borderRadius: 6, color: '#f472b6', padding: '7px 14px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6,
};
const btnGhostStyle: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6,
};
const textareaStyle: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8, padding: '10px 12px', color: '#e2d9f3', fontSize: 12.5, fontFamily: 'monospace',
  outline: 'none', resize: 'vertical', lineHeight: 1.5,
};

type Tab = 'question' | 'bibliotheque';

export default function CvFreeQuestionModal({ cvTitle, onAsk, onSaveResult, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('question');
  const [question, setQuestion] = useState('');
  const [powerful, setPowerful] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chainHistory, setChainHistory] = useState<ChainTurn[]>([]);
  const [lastAnswer, setLastAnswer] = useState<{ question: string; answer: string; model: string } | null>(null);
  const [contextWarning, setContextWarning] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const [prompts, setPrompts] = useState<CandidatureSavedPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editText, setEditText] = useState('');
  const [newPromptOpen, setNewPromptOpen] = useState(false);
  const [newPromptName, setNewPromptName] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);

  const loadPrompts = useCallback(async () => {
    setPromptsLoading(true);
    try {
      const { prompts: list } = await cortexClient.cvGetSavedPrompts();
      setPrompts(list);
    } catch {
      /* silent — library is a convenience, not critical path */
    } finally {
      setPromptsLoading(false);
    }
  }, []);

  useEffect(() => { void loadPrompts(); }, [loadPrompts]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleAsk() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onAsk({ question: q, chainHistory, powerful });
      setLastAnswer({ question: q, answer: result.answer, model: result.model_used });
      setContextTokens(result.context_tokens_estimate);
      setContextWarning(result.context_warning);
      setSaved(false);
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  }

  function handleFollowUp() {
    if (!lastAnswer) return;
    setChainHistory(h => [...h, { question: lastAnswer.question, answer: lastAnswer.answer }]);
    setQuestion('');
    setLastAnswer(null);
    setError(null);
  }

  function handleNewAnalysis() {
    setChainHistory([]);
    setQuestion('');
    setLastAnswer(null);
    setContextWarning(false);
    setContextTokens(0);
    setError(null);
  }

  async function handleCopy() {
    if (!lastAnswer) return;
    await navigator.clipboard.writeText(lastAnswer.answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function handleSave() {
    if (!lastAnswer) return;
    await onSaveResult({ question: lastAnswer.question, answer: lastAnswer.answer, modelUsed: lastAnswer.model });
    setSaved(true);
  }

  function loadPromptIntoQuestion(p: CandidatureSavedPrompt) {
    setQuestion(p.prompt_text);
    setTab('question');
    void cortexClient.cvTouchSavedPrompt(p.id).then(() => { void loadPrompts(); }).catch(() => {});
  }

  async function handleCreatePrompt() {
    const name = newPromptName.trim();
    const text = question.trim();
    if (!name || !text) return;
    try {
      await cortexClient.cvCreateSavedPrompt(name, text);
      setNewPromptName('');
      setNewPromptOpen(false);
      await loadPrompts();
    } catch {
      /* silent */
    }
  }

  function startEdit(p: CandidatureSavedPrompt) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditText(p.prompt_text);
  }

  async function saveEdit() {
    if (!editingId) return;
    try {
      await cortexClient.cvUpdateSavedPrompt(editingId, { name: editName.trim(), promptText: editText.trim() });
      setEditingId(null);
      await loadPrompts();
    } catch {
      /* silent */
    }
  }

  async function duplicatePrompt(p: CandidatureSavedPrompt) {
    try {
      await cortexClient.cvCreateSavedPrompt(`${p.name} (copie)`, p.prompt_text);
      await loadPrompts();
    } catch {
      /* silent */
    }
  }

  async function deletePrompt(id: string) {
    try {
      await cortexClient.cvDeleteSavedPrompt(id);
      await loadPrompts();
    } catch {
      /* silent */
    }
  }

  async function handleReorder(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = prompts.map(p => p.id);
    const from = ids.indexOf(dragId);
    const to   = ids.indexOf(targetId);
    if (from === -1 || to === -1) { setDragId(null); return; }
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(null);
    try {
      const { prompts: reordered } = await cortexClient.cvReorderSavedPrompts(ids);
      setPrompts(reordered);
    } catch {
      /* silent */
    }
  }

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: 15, fontFamily: 'monospace', color: '#f472b6', fontWeight: 600, margin: 0 }}>Question libre — {cvTitle}</h2>
            <p style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', margin: '3px 0 0' }}>🔒 100% local · aucun envoi cloud</p>
          </div>
          <button type="button" onClick={onClose} style={{ color: '#7a6c9a', background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}><X size={18} /></button>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '10px 20px 0' }}>
          <button type="button" onClick={() => setTab('question')}
            style={{ ...btnGhostStyle, color: tab === 'question' ? '#f472b6' : '#7a6c9a', borderColor: tab === 'question' ? 'rgba(244,114,182,0.4)' : 'rgba(255,255,255,0.12)' }}>
            Question
          </button>
          <button type="button" onClick={() => setTab('bibliotheque')}
            style={{ ...btnGhostStyle, color: tab === 'bibliotheque' ? '#f472b6' : '#7a6c9a', borderColor: tab === 'bibliotheque' ? 'rgba(244,114,182,0.4)' : 'rgba(255,255,255,0.12)' }}>
            <Library size={12} /> Bibliothèque de prompts
          </button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {tab === 'question' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <p style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#fbbf24', margin: 0, lineHeight: 1.5 }}>
                  ⚠ Analyse locale — un modèle local reste limité. Ce résultat est une base de réflexion, pas un bilan professionnel.
                </p>
              </div>

              {chainHistory.length > 0 && (
                <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(94,231,255,0.05)', border: '1px solid rgba(94,231,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#5ee7ff' }}>
                    {chainHistory.length} échange{chainHistory.length > 1 ? 's' : ''} précédent{chainHistory.length > 1 ? 's' : ''} dans la conversation
                  </span>
                  <button type="button" onClick={handleNewAnalysis} style={{ ...btnGhostStyle, padding: '4px 10px', fontSize: 10.5 }}>
                    <RotateCcw size={11} /> Nouvelle analyse
                  </button>
                </div>
              )}

              {contextWarning && (
                <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)' }}>
                  <p style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#f87171', margin: 0, lineHeight: 1.5 }}>
                    ⚠ Contexte volumineux (~{contextTokens} tokens estimés). La qualité de réponse peut se dégrader.
                    Envisage de redémarrer une nouvelle analyse depuis le CV seul.
                  </p>
                </div>
              )}

              <div>
                <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'block', marginBottom: 4 }}>
                  VOTRE QUESTION {chainHistory.length > 0 ? '(suivi de la conversation)' : '(le contenu du CV est automatiquement joint)'}
                </label>
                <textarea
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  placeholder="Pose une question libre et structurée sur ce CV…"
                  rows={10}
                  style={textareaStyle}
                  autoFocus
                />
              </div>

              <label style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={powerful} onChange={e => setPowerful(e.target.checked)} />
                Modèle puissant (qwen2.5:14b quantized) — résultat plus fin, nettement plus lent
              </label>

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={busy || !question.trim()} onClick={() => { void handleAsk(); }}
                  style={{ ...btnStyle, opacity: busy || !question.trim() ? 0.5 : 1, cursor: busy || !question.trim() ? 'default' : 'pointer' }}>
                  {busy ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
                  {busy ? 'Analyse en cours…' : 'Poser la question'}
                </button>
                {!newPromptOpen && question.trim() && (
                  <button type="button" onClick={() => setNewPromptOpen(true)} style={btnGhostStyle}>
                    <Save size={12} /> Sauvegarder ce prompt
                  </button>
                )}
              </div>

              {newPromptOpen && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={newPromptName}
                    onChange={e => setNewPromptName(e.target.value)}
                    placeholder="Nom du prompt…"
                    style={{ ...textareaStyle, flex: 1, padding: '6px 10px' }}
                  />
                  <button type="button" onClick={() => { void handleCreatePrompt(); }} style={btnStyle}>
                    <Check size={12} /> Enregistrer
                  </button>
                  <button type="button" onClick={() => setNewPromptOpen(false)} style={btnGhostStyle}>Annuler</button>
                </div>
              )}

              {error && (
                <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)' }}>
                  <p style={{ fontSize: 11, fontFamily: 'monospace', color: '#f87171', margin: 0 }}>{error}</p>
                </div>
              )}

              {lastAnswer && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
                  <p style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', margin: 0 }}>
                    RÉPONSE · {lastAnswer.model}
                  </p>
                  <div style={{ padding: 14, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'pre-wrap', fontSize: 12.5, fontFamily: 'monospace', color: '#e2d9f3', lineHeight: 1.6, maxHeight: 320, overflowY: 'auto' }}>
                    {lastAnswer.answer}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => { void handleCopy(); }} style={btnGhostStyle}>
                      <Copy size={12} /> {copied ? 'Copié !' : 'Copier le résultat'}
                    </button>
                    <button type="button" onClick={() => { void handleSave(); }} disabled={saved} style={{ ...btnStyle, opacity: saved ? 0.6 : 1 }}>
                      <Save size={12} /> {saved ? 'Sauvegardé' : 'Sauvegarder'}
                    </button>
                    <button type="button" onClick={handleFollowUp} style={btnGhostStyle}>
                      <MessageSquarePlus size={12} /> Question de suivi
                    </button>
                    <button type="button" onClick={handleNewAnalysis} style={btnGhostStyle}>
                      <RotateCcw size={12} /> Nouvelle analyse
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'bibliotheque' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ fontSize: 10, color: '#7a6c9a', fontFamily: 'monospace', margin: '0 0 4px' }}>
                {promptsLoading ? 'Chargement…' : `${prompts.length} prompt${prompts.length > 1 ? 's' : ''} — clique pour charger dans l'onglet Question, glisse pour réordonner`}
              </p>
              {prompts.map(p => (
                <div
                  key={p.id}
                  draggable
                  onDragStart={() => setDragId(p.id)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => { void handleReorder(p.id); }}
                  style={{ padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  {editingId === p.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input type="text" value={editName} onChange={e => setEditName(e.target.value)} style={{ ...textareaStyle, padding: '5px 8px' }} />
                      <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={4} style={textareaStyle} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" onClick={() => { void saveEdit(); }} style={{ ...btnStyle, padding: '4px 10px', fontSize: 11 }}><Check size={11} /> Valider</button>
                        <button type="button" onClick={() => setEditingId(null)} style={{ ...btnGhostStyle, padding: '4px 10px', fontSize: 11 }}>Annuler</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <GripVertical size={12} color="#5a4a7a" style={{ cursor: 'grab', flexShrink: 0 }} />
                        <button type="button" onClick={() => loadPromptIntoQuestion(p)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                          <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#e2d9f3', fontWeight: 600 }}>{p.name}</span>
                        </button>
                        <button type="button" title="Modifier" onClick={() => startEdit(p)} style={{ background: 'none', border: 'none', color: '#7a6c9a', cursor: 'pointer', padding: 4 }}><Pencil size={12} /></button>
                        <button type="button" title="Dupliquer" onClick={() => { void duplicatePrompt(p); }} style={{ background: 'none', border: 'none', color: '#7a6c9a', cursor: 'pointer', padding: 4 }}><Copy size={12} /></button>
                        <button type="button" title="Supprimer" onClick={() => { void deletePrompt(p.id); }} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', padding: 4 }}><Trash2 size={12} /></button>
                      </div>
                      <button type="button" onClick={() => loadPromptIntoQuestion(p)} style={{ textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <p style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#7a6c9a', margin: 0, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                          {p.prompt_text}
                        </p>
                        <p style={{ fontSize: 9.5, fontFamily: 'monospace', color: '#5a4a7a', margin: '4px 0 0' }}>
                          {p.last_used_at ? `Dernière utilisation : ${new Date(p.last_used_at).toLocaleDateString('fr-FR')}` : 'Jamais utilisé'}
                        </p>
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
