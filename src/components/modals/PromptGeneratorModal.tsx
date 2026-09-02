import { useEffect, useState, useCallback } from 'react';
import { Wand2, X, Copy, Check, RefreshCw, Trash2, Star, Search } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { GeneratedPrompt, PromptGeneratorModelOption, PromptOutcome } from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
  strictLocalMode: boolean;
}

const OUTCOME_LABELS: Record<PromptOutcome, string> = {
  untested: 'Non testé',
  worked:   'A fonctionné',
  half:     'Partiellement',
  broken:   'Échoué',
};

const OUTCOME_COLORS: Record<PromptOutcome, string> = {
  untested: '#94a3b8',
  worked:   '#3dffaa',
  half:     '#ffb547',
  broken:   '#ff4d58',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const modalStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
};
const panelStyle: React.CSSProperties = {
  width: 760, maxWidth: 'calc(100vw - 24px)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: '#0d0f14', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12, width: '100%',
  fontFamily: 'inherit', outline: 'none',
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(94,231,255,0.1)', border: '1px solid rgba(94,231,255,0.3)',
  borderRadius: 6, color: '#5ee7ff', padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', padding: 4,
};

function ModelPicker({
  label, options, value, onChange, disabled,
}: {
  label: string;
  options: { id: string; provider: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ flex: 1 }}>
      <span style={labelStyle}>{label}</span>
      <select
        style={selectStyle}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">— choisir —</option>
        {options.map(o => (
          <option key={`${o.provider}:${o.id}`} value={`${o.provider}:${o.id}`}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      style={{ ...btnStyle, padding: '4px 10px' }}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copié' : 'Copier'}
    </button>
  );
}

export default function PromptGeneratorModal({ onClose, strictLocalMode }: Props) {
  const [request, setRequest]     = useState('');
  const [localModels, setLocalModels] = useState<PromptGeneratorModelOption[]>([]);
  const [cloudModels, setCloudModels] = useState<PromptGeneratorModelOption[]>([]);
  const [draftChoice, setDraftChoice]   = useState(''); // "provider:id"
  const [reviewChoice, setReviewChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<GeneratedPrompt | null>(null);

  const [history, setHistory] = useState<GeneratedPrompt[]>([]);
  const [search, setSearch] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');

  const allModels = [...localModels, ...cloudModels];

  const loadModels = useCallback(async () => {
    try {
      const res = await cortexClient.getPromptGeneratorModels();
      setLocalModels(res.local);
      setCloudModels(res.cloud);
      const settings = await cortexClient.getPromptGeneratorSettings();
      if (settings.default_draft_model && settings.default_draft_provider) {
        setDraftChoice(`${settings.default_draft_provider}:${settings.default_draft_model}`);
      } else if (res.local[0]) {
        setDraftChoice(`local:${res.local[0].id}`);
      }
      if (settings.default_review_model && settings.default_review_provider) {
        setReviewChoice(`${settings.default_review_provider}:${settings.default_review_model}`);
      } else if (res.local[1]) {
        setReviewChoice(`local:${res.local[1].id}`);
      } else if (res.local[0]) {
        setReviewChoice(`local:${res.local[0].id}`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await cortexClient.listGeneratedPrompts({
        q: search || undefined,
        outcome: outcomeFilter || undefined,
        model: modelFilter || undefined,
      });
      setHistory(res.prompts);
    } catch { /* silent */ }
  }, [search, outcomeFilter, modelFilter]);

  useEffect(() => { void loadModels(); }, [loadModels]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function parseChoice(choice: string): { provider: string; id: string } | null {
    const idx = choice.indexOf(':');
    if (idx === -1) return null;
    return { provider: choice.slice(0, idx), id: choice.slice(idx + 1) };
  }

  const draftParsed  = parseChoice(draftChoice);
  const reviewParsed = parseChoice(reviewChoice);
  const bothCloud = !!draftParsed && draftParsed.provider !== 'local' && !!reviewParsed && reviewParsed.provider !== 'local';

  async function handleGenerate() {
    if (!request.trim() || !draftParsed || !reviewParsed) return;
    setBusy(true);
    setError(null);
    try {
      const prompt = await cortexClient.generatePrompt({
        request: request.trim(),
        draft_model: draftParsed.id,
        draft_provider: draftParsed.provider,
        review_model: reviewParsed.id,
        review_provider: reviewParsed.provider,
      });
      setCurrent(prompt);
      await cortexClient.setPromptGeneratorSettings({
        default_draft_model: draftParsed.id,
        default_draft_provider: draftParsed.provider,
        default_review_model: reviewParsed.id,
        default_review_provider: reviewParsed.provider,
      });
      void loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(promptId: string, version: 'draft' | 'reviewed', text: string) {
    void navigator.clipboard.writeText(text);
    try {
      const updated = await cortexClient.updateGeneratedPrompt(promptId, { kept_version: version });
      if (current?.id === promptId) setCurrent(updated);
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleOutcome(promptId: string, outcome: PromptOutcome) {
    try {
      const updated = await cortexClient.updateGeneratedPrompt(promptId, { outcome });
      if (current?.id === promptId) setCurrent(updated);
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleTemplate(p: GeneratedPrompt) {
    try {
      await cortexClient.updateGeneratedPrompt(p.id, { is_template: !p.is_template });
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      await cortexClient.deleteGeneratedPrompt(id);
      if (current?.id === id) setCurrent(null);
      void loadHistory();
    } catch { /* ignore */ }
  }

  async function handleRegenerate(p: GeneratedPrompt) {
    setBusy(true);
    setError(null);
    try {
      const prompt = await cortexClient.regeneratePrompt(p.id);
      setCurrent(prompt);
      void loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function loadFromHistory(p: GeneratedPrompt) {
    setCurrent(p);
    setRequest(p.request);
  }

  return (
    <div style={modalStyle} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panelStyle}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wand2 size={14} color="#5ee7ff" />
          <span style={{ fontFamily: 'monospace', fontSize: 13, letterSpacing: '0.05em', color: '#e2e8f0', flex: 1 }}>GÉNÉRATEUR DE PROMPTS</span>
          <button type="button" onClick={onClose} style={iconBtnStyle}><X size={16} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {strictLocalMode && (
            <div style={{ fontSize: 11, color: '#ffb547', background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.2)', borderRadius: 6, padding: '6px 10px' }}>
              Mode strictement local actif — seuls les modèles locaux sont proposés.
            </div>
          )}

          {/* ── Request input ── */}
          <div>
            <span style={labelStyle}>DEMANDE</span>
            <textarea
              value={request}
              onChange={e => setRequest(e.target.value)}
              placeholder='prompt [ce que je veux obtenir]'
              rows={3}
              style={{ ...selectStyle, resize: 'vertical', fontSize: 13 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <ModelPicker label="MODÈLE RÉDACTION" options={allModels} value={draftChoice} onChange={setDraftChoice} />
            <ModelPicker label="MODÈLE RELECTURE" options={allModels} value={reviewChoice} onChange={setReviewChoice} />
          </div>

          {bothCloud && (
            <div style={{ fontSize: 11, color: '#ffb547', background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.2)', borderRadius: 6, padding: '6px 10px' }}>
              2 appels cloud (rédaction + relecture) — vérifiez vos quotas avant de lancer.
            </div>
          )}

          {error && (
            <div style={{ fontSize: 12, color: '#ff4d58', background: 'rgba(255,77,88,0.08)', border: '1px solid rgba(255,77,88,0.15)', borderRadius: 6, padding: '8px 10px' }}>
              {error}
            </div>
          )}

          <button
            type="button"
            style={{ ...btnStyle, justifyContent: 'center', opacity: busy || !request.trim() ? 0.5 : 1 }}
            disabled={busy || !request.trim() || !draftChoice || !reviewChoice}
            onClick={() => void handleGenerate()}
          >
            {busy ? 'Génération en cours…' : 'Générer'}
          </button>

          {/* ── Result ── */}
          {current && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>
                  {current.draft_model} → {current.review_model}
                  {current.unchanged && <span style={{ color: '#3dffaa', marginLeft: 8 }}>· relecture : aucun changement</span>}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['untested', 'worked', 'half', 'broken'] as PromptOutcome[]).map(o => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => void handleOutcome(current.id, o)}
                      style={{
                        fontSize: 10, padding: '3px 8px', borderRadius: 10, cursor: 'pointer',
                        border: `1px solid ${current.outcome === o ? OUTCOME_COLORS[o] : 'rgba(255,255,255,0.1)'}`,
                        background: current.outcome === o ? `${OUTCOME_COLORS[o]}22` : 'transparent',
                        color: current.outcome === o ? OUTCOME_COLORS[o] : '#94a3b8',
                      }}
                    >
                      {OUTCOME_LABELS[o]}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={labelStyle}>BROUILLON {current.kept_version === 'draft' && <Check size={11} color="#3dffaa" style={{ verticalAlign: 'middle', marginLeft: 4 }} />}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <CopyButton text={current.draft_text} />
                    <button type="button" style={btnStyle} onClick={() => void handleApply(current.id, 'draft', current.draft_text)}>Appliquer</button>
                  </div>
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, color: '#e2e8f0', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 10, margin: 0, maxHeight: 220, overflowY: 'auto' }}>
                  {current.draft_text}
                </pre>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={labelStyle}>RELECTURE {current.kept_version === 'reviewed' && <Check size={11} color="#3dffaa" style={{ verticalAlign: 'middle', marginLeft: 4 }} />}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <CopyButton text={current.reviewed_text} />
                    <button type="button" style={btnStyle} onClick={() => void handleApply(current.id, 'reviewed', current.reviewed_text)}>Appliquer</button>
                  </div>
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, color: '#e2e8f0', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 10, margin: 0, maxHeight: 220, overflowY: 'auto' }}>
                  {current.reviewed_text}
                </pre>
              </div>

              <div>
                <span style={labelStyle}>CHANGEMENTS EXPLIQUÉS</span>
                <div style={{ fontSize: 12, color: '#94a3b8', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6, padding: 10, whiteSpace: 'pre-wrap' }}>
                  {current.changes_explained || '—'}
                </div>
              </div>
            </div>
          )}

          {/* ── History ── */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Search size={12} color="#94a3b8" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Rechercher dans l'historique…"
                style={{ ...selectStyle, flex: 1 }}
              />
              <select style={{ ...selectStyle, width: 140 }} value={outcomeFilter} onChange={e => setOutcomeFilter(e.target.value)}>
                <option value="">Tous résultats</option>
                {(['untested', 'worked', 'half', 'broken'] as PromptOutcome[]).map(o => (
                  <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>
                ))}
              </select>
              <select style={{ ...selectStyle, width: 160 }} value={modelFilter} onChange={e => setModelFilter(e.target.value)}>
                <option value="">Tous modèles</option>
                {allModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
              {history.length === 0 && <div style={{ fontSize: 12, color: '#64748b', textAlign: 'center', padding: 12 }}>Aucun prompt généré.</div>}
              {history.map(p => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => loadFromHistory(p)}>
                    <div style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.is_template && <Star size={10} color="#ffb547" style={{ verticalAlign: 'middle', marginRight: 4 }} fill="#ffb547" />}
                      {p.request}
                    </div>
                    <div style={{ fontSize: 10, color: '#64748b' }}>
                      {formatDate(p.created_at)} · {p.draft_model} → {p.review_model} · <span style={{ color: OUTCOME_COLORS[p.outcome] }}>{OUTCOME_LABELS[p.outcome]}</span>
                    </div>
                  </div>
                  <button type="button" title="Favori / modèle" style={iconBtnStyle} onClick={() => void handleTemplate(p)}>
                    <Star size={13} color={p.is_template ? '#ffb547' : '#64748b'} fill={p.is_template ? '#ffb547' : 'none'} />
                  </button>
                  <button type="button" title="Régénérer" style={iconBtnStyle} onClick={() => void handleRegenerate(p)}>
                    <RefreshCw size={13} />
                  </button>
                  <button type="button" title="Supprimer" style={iconBtnStyle} onClick={() => void handleDelete(p.id)}>
                    <Trash2 size={13} color="#ff4d58" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
