import { useEffect, useState, useCallback } from 'react';
import { GraduationCap, X, Plus, Trash2, ArrowLeft, ArrowRight, Check, RefreshCw, Settings } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  TeacherSettings, TeacherQuotaInfo, TeacherRegister, LearningPath, LearningPathStep,
  LearningPlanStep, ReviewItem, TeacherStats, TeacherAvailableModels,
} from '../../lib/cortex/client';

interface Props {
  onClose: () => void;
  strictLocalMode: boolean;
}

const REGISTER_LABELS: Record<TeacherRegister, string> = {
  enfant:     'Enfant',
  debutant:   'Débutant',
  standard:   'Standard',
  expert:     'Expert',
  socratique: 'Socratique',
};

const REGISTER_DESCRIPTIONS: Record<TeacherRegister, string> = {
  enfant:     'Analogies simples, vocabulaire courant, tout terme technique expliqué en image.',
  debutant:   'Tout est défini, progression lente et rassurante.',
  standard:   'Suppose une culture générale, va à l\'essentiel sans être sec.',
  expert:     'Suppose les bases acquises, nuances et détails techniques.',
  socratique: 'Ne donne jamais la réponse directement — te guide par des questions.',
};

type Tab = 'apprentissage' | 'revision' | 'stats' | 'reglages';

const modalStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
};
const panelStyle: React.CSSProperties = {
  width: 820, maxWidth: 'calc(100vw - 24px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
  background: '#0d0f14', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '8px 10px', fontSize: 13, width: '100%',
  fontFamily: 'inherit', outline: 'none',
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
const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8, padding: 12,
};
const tabBtnStyle = (active: boolean): React.CSSProperties => ({
  background: active ? 'rgba(167,139,250,0.12)' : 'none',
  border: 'none', borderBottom: active ? '2px solid #a78bfa' : '2px solid transparent',
  color: active ? '#a78bfa' : '#94a3b8', padding: '10px 14px', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit',
});

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Onglet Réglages ──────────────────────────────────────────────────────

function SettingsTab({ strictLocalMode }: { strictLocalMode: boolean }) {
  const [settings, setSettings] = useState<TeacherSettings | null>(null);
  const [quota, setQuota] = useState<TeacherQuotaInfo | null>(null);
  const [available, setAvailable] = useState<TeacherAvailableModels | null>(null);
  const [modelInput, setModelInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [validateMsg, setValidateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reloadModels = useCallback(async () => {
    setRefreshing(true);
    try {
      setAvailable(await cortexClient.getTeacherAvailableModels());
    } finally {
      setRefreshing(false);
    }
  }, []);

  const reload = useCallback(async () => {
    const [s, q] = await Promise.all([cortexClient.getTeacherSettings(), cortexClient.getTeacherQuota()]);
    setSettings(s);
    setModelInput(s.model);
    setQuota(q);
    await reloadModels();
  }, [reloadModels]);

  useEffect(() => { void reload(); }, [reload]);

  async function handleSave() {
    if (!settings) return;
    const model = modelInput.trim() || 'local';
    setSaving(true);
    setValidateMsg(null);
    try {
      const result = await cortexClient.validateTeacherModel(model);
      if (!result.ok) {
        setValidateMsg({ ok: false, text: result.error ?? 'Échec de la validation — modèle non enregistré.' });
        return;
      }
      const updated = await cortexClient.setTeacherSettings({ model });
      setSettings(updated);
      setQuota(await cortexClient.getTeacherQuota());
      setValidateMsg({ ok: true, text: 'Modèle validé et enregistré.' });
    } catch (err) {
      setValidateMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleRegisterChange(register: TeacherRegister) {
    const updated = await cortexClient.setTeacherSettings({ defaultRegister: register });
    setSettings(updated);
  }

  if (!settings) return <div style={{ color: '#64748b', fontSize: 12 }}>Chargement…</div>;

  const isLocal = settings.model === 'local' || !/^(groq|gemini|openrouter):/.test(settings.model);
  const groq = available?.cloud.groq;
  const gemini = available?.cloud.gemini;
  const openrouter = available?.cloud.openrouter;
  const cloudProviders: { key: string; label: string; data: typeof groq }[] = [
    { key: 'groq', label: 'Groq', data: groq },
    { key: 'gemini', label: 'Gemini', data: gemini },
    { key: 'openrouter', label: 'OpenRouter', data: openrouter },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={labelStyle}>MODÈLE PROFESSEUR DÉDIÉ</span>
          <button type="button" style={btnGhostStyle} onClick={() => void reloadModels()} disabled={refreshing}>
            <RefreshCw size={12} className={refreshing ? 'spin' : ''} /> Rafraîchir la liste
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
          Indépendant du modèle utilisé ailleurs dans Docteur — les quotas Groq sont par modèle, pas par clé.
        </div>

        <select
          style={inputStyle}
          value={modelInput}
          onChange={e => setModelInput(e.target.value)}
          disabled={strictLocalMode}
        >
          <optgroup label="Modèles locaux installés">
            <option value="local">local (suit le modèle du routeur général)</option>
            {available?.local.available
              ? available.local.models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.id}{m.size_label ? ` — ${m.size_label}` : ''}
                  </option>
                ))
              : <option value="local" disabled>{available ? `Ollama injoignable — ${available.local.reason}` : 'Chargement…'}</option>}
          </optgroup>
          {cloudProviders.map(({ key, label, data }) => (
            <optgroup key={key} label={`Modèles cloud — ${label}`}>
              {(data?.models ?? []).map(m => {
                const value = m.id.includes(':') ? m.id : `${key}:${m.id}`;
                return (
                  <option key={m.id} value={value} disabled={!!m.disabled_reason}>
                    {m.id}
                    {m.disabled_reason ? ` — ${m.disabled_reason}` : ''}
                    {!m.disabled_reason && m.limit != null ? ` — ${m.remaining}/${m.limit} restants aujourd'hui` : ''}
                  </option>
                );
              })}
              {(!data || data.models.length === 0) && (
                <option value={`${key}:__unavailable`} disabled>
                  {data ? `Aucun modèle ${label} disponible` : 'Chargement…'}
                </option>
              )}
            </optgroup>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" style={btnStyle} onClick={() => void handleSave()} disabled={saving || strictLocalMode}>
            {saving ? <RefreshCw size={13} className="spin" /> : <Check size={13} />} {saving ? 'Test en cours…' : 'Valider et enregistrer'}
          </button>
        </div>

        {validateMsg && (
          <div style={{ fontSize: 11, color: validateMsg.ok ? '#3dffaa' : '#ff4d58', marginTop: 8 }}>
            {validateMsg.text}
          </div>
        )}

        {strictLocalMode && (
          <div style={{ fontSize: 11, color: '#ffb547', marginTop: 8 }}>
            Mode strictement local actif — les modèles cloud sont grisés et le Professeur utilisera un modèle local quel que soit ce réglage.
          </div>
        )}
        {isLocal && !strictLocalMode && (
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
            Modèle local : qualité pédagogique variable selon le sujet.
          </div>
        )}
        {cloudProviders.filter(({ data }) => data && !data.configured).map(({ key, label }) => (
          <div key={key} style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            {label} : clé non configurée — ajoute-la dans Paramètres &gt; Fournisseurs cloud pour débloquer les modèles cloud.
          </div>
        ))}
      </div>

      {quota && (
        <div style={cardStyle}>
          <span style={labelStyle}>QUOTA</span>
          {quota.unlimited_local ? (
            <div style={{ fontSize: 12, color: '#3dffaa' }}>Illimité (local)</div>
          ) : (
            <div style={{ fontSize: 12, color: '#e2e8f0' }}>
              {quota.used_today} appel(s) aujourd'hui
              {quota.limit != null
                ? ` · ${quota.remaining} / ${quota.limit} restants`
                : ' · limite non vérifiée pour ce modèle — compteur affiché seulement.'}
            </div>
          )}
        </div>
      )}

      <div style={cardStyle}>
        <span style={labelStyle}>REGISTRE PAR DÉFAUT</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {(Object.keys(REGISTER_LABELS) as TeacherRegister[]).map(r => (
            <label key={r} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12 }}>
              <input type="radio" checked={settings.defaultRegister === r} onChange={() => void handleRegisterChange(r)} style={{ marginTop: 3 }} />
              <span>
                <strong style={{ color: '#e2e8f0' }}>{REGISTER_LABELS[r]}</strong>
                <div style={{ color: '#64748b', fontSize: 11 }}>{REGISTER_DESCRIPTIONS[r]}</div>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Édition du plan avant démarrage ──────────────────────────────────────

function PlanEditor({ path, onStarted, onCancel }: { path: LearningPath; onStarted: (p: LearningPath, steps: LearningPathStep[]) => void; onCancel: () => void }) {
  const [plan, setPlan] = useState<LearningPlanStep[]>(path.plan);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateStep(i: number, field: 'title' | 'summary', value: string) {
    setPlan(p => p.map((s, idx) => idx === i ? { ...s, [field]: value } : s));
  }
  function removeStep(i: number) {
    setPlan(p => p.filter((_, idx) => idx !== i));
  }
  function moveStep(i: number, dir: -1 | 1) {
    setPlan(p => {
      const j = i + dir;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function addStep() {
    setPlan(p => [...p, { title: 'Nouvelle étape', summary: '' }]);
  }

  async function handleStart() {
    setError(null);
    setStarting(true);
    try {
      await cortexClient.updateLearningPathPlan(path.id, plan);
      const { path: started, steps } = await cortexClient.startLearningPath(path.id);
      onStarted(started, steps);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, color: '#e2e8f0' }}>
        Plan proposé pour <strong>{path.subject}</strong> — modifie-le avant de commencer si besoin.
      </div>
      {plan.map((step, i) => (
        <div key={i} style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: '#64748b', fontSize: 11, width: 20 }}>{i + 1}.</span>
            <input style={inputStyle} value={step.title} onChange={e => updateStep(i, 'title', e.target.value)} />
            <button type="button" style={btnGhostStyle} onClick={() => moveStep(i, -1)} disabled={i === 0}><ArrowLeft size={12} style={{ transform: 'rotate(90deg)' }} /></button>
            <button type="button" style={btnGhostStyle} onClick={() => moveStep(i, 1)} disabled={i === plan.length - 1}><ArrowRight size={12} style={{ transform: 'rotate(90deg)' }} /></button>
            <button type="button" style={btnGhostStyle} onClick={() => removeStep(i)}><Trash2 size={12} /></button>
          </div>
          <input style={{ ...inputStyle, fontSize: 11, color: '#94a3b8' }} value={step.summary} onChange={e => updateStep(i, 'summary', e.target.value)} placeholder="Résumé de l'étape" />
        </div>
      ))}
      <button type="button" style={btnGhostStyle} onClick={addStep}><Plus size={13} /> Ajouter une étape</button>

      {error && <div style={{ fontSize: 12, color: '#ff4d58' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
        <button type="button" style={btnGhostStyle} onClick={onCancel}>Annuler</button>
        <button type="button" style={btnStyle} onClick={() => void handleStart()} disabled={starting || plan.length === 0}>
          {starting ? <RefreshCw size={13} className="spin" /> : <Check size={13} />} Commencer
        </button>
      </div>
    </div>
  );
}

// ── Leçon pas-à-pas ────────────────────────────────────────────────────────

function LessonView({ path, steps, onRefresh, onFinished }: {
  path: LearningPath;
  steps: LearningPathStep[];
  onRefresh: (p: LearningPath, s: LearningPathStep[]) => void;
  onFinished: (p: LearningPath) => void;
}) {
  const activeStep = steps.find(s => s.step_index === path.current_step_index) ?? steps[0];
  const [loadingExplain, setLoadingExplain] = useState(false);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sources, setSources] = useState<{ id: string; title: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadExplanation = useCallback(async (stepId: string) => {
    setLoadingExplain(true);
    setError(null);
    try {
      const { step, sources_used } = await cortexClient.explainStep(path.id, stepId);
      setSources(sources_used ?? []);
      onRefresh(path, steps.map(s => s.id === step.id ? step : s));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingExplain(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.id]);

  useEffect(() => {
    if (activeStep && !activeStep.content) void loadExplanation(activeStep.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep?.id]);

  if (!activeStep) return <div style={{ color: '#64748b', fontSize: 12 }}>Aucune étape.</div>;

  const lastExchange = activeStep.comprehension_check[activeStep.comprehension_check.length - 1];

  async function handleSubmitAnswer() {
    if (!answer.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { step, validated } = await cortexClient.answerStepQuestion(path.id, activeStep.id, answer.trim());
      onRefresh(path, steps.map(s => s.id === step.id ? step : s));
      setAnswer('');
      if (validated) {
        const { path: newPath, steps: newSteps, finished } = await cortexClient.advanceStep(path.id, activeStep.id);
        if (finished) onFinished(newPath);
        else onRefresh(newPath, newSteps);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBack() {
    try {
      const { path: newPath, steps: newSteps } = await cortexClient.backStep(path.id, activeStep.id);
      onRefresh(newPath, newSteps);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: '#e2e8f0' }}>
          Étape {activeStep.step_index + 1} / {steps.length} — <strong>{activeStep.title}</strong>
        </div>
        <button type="button" style={btnGhostStyle} onClick={() => void handleBack()} disabled={activeStep.step_index === 0}>
          <ArrowLeft size={12} /> Revenir en arrière
        </button>
      </div>

      <div style={{ ...cardStyle, whiteSpace: 'pre-wrap', fontSize: 13, color: '#e2e8f0', lineHeight: 1.6 }}>
        {loadingExplain ? <span style={{ color: '#64748b' }}>Génération de l'explication…</span> : (activeStep.content || '—')}
      </div>

      {sources.length > 0 && (
        <div style={{ fontSize: 11, color: '#64748b' }}>
          Sources citées : {sources.map(s => s.title).join(', ')}
        </div>
      )}

      {activeStep.comprehension_check.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {activeStep.comprehension_check.map((ex, i) => (
            <div key={i} style={{ fontSize: 12, color: '#94a3b8', paddingLeft: 10, borderLeft: '2px solid rgba(255,255,255,0.08)' }}>
              <div><strong style={{ color: '#e2e8f0' }}>Toi :</strong> {ex.answer}</div>
              <div><strong style={{ color: '#a78bfa' }}>Prof :</strong> {ex.evaluation}</div>
            </div>
          ))}
        </div>
      )}

      {activeStep.status !== 'done' && !loadingExplain && activeStep.content && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>{lastExchange ? 'TA RÉPONSE (SUITE)' : 'TA RÉPONSE À LA QUESTION'}</span>
          <textarea
            style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
            value={answer}
            onChange={e => setAnswer(e.target.value)}
            placeholder="Écris ta réponse…"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" style={btnStyle} onClick={() => void handleSubmitAnswer()} disabled={submitting || !answer.trim()}>
              {submitting ? <RefreshCw size={13} className="spin" /> : <Check size={13} />} Envoyer
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: '#ff4d58' }}>{error}</div>}
    </div>
  );
}

// ── Onglet Apprentissage (liste + création + vue active) ────────────────

function LearningTab({ defaultRegister }: { defaultRegister: TeacherRegister }) {
  const [paths, setPaths] = useState<LearningPath[]>([]);
  const [openPath, setOpenPath] = useState<{ path: LearningPath; steps: LearningPathStep[] } | null>(null);
  const [subject, setSubject] = useState('');
  const [register, setRegister] = useState<TeacherRegister>(defaultRegister);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recapNotice, setRecapNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { paths: list } = await cortexClient.listLearningPaths();
    setPaths(list);
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { setRegister(defaultRegister); }, [defaultRegister]);

  async function handleCreate() {
    if (!subject.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { path } = await cortexClient.createLearningPath(subject.trim(), register);
      setSubject('');
      await reload();
      setOpenPath({ path, steps: [] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleOpen(p: LearningPath) {
    const { path, steps } = await cortexClient.getLearningPath(p.id);
    setOpenPath({ path, steps });
  }

  async function handleDelete(id: string) {
    await cortexClient.deleteLearningPath(id);
    if (openPath?.path.id === id) setOpenPath(null);
    await reload();
  }

  async function handleAbandon(id: string) {
    await cortexClient.abandonLearningPath(id);
    if (openPath?.path.id === id) setOpenPath(null);
    await reload();
  }

  async function handleCreateRecap(pathId: string) {
    try {
      const result = await cortexClient.createRecapNeuron(pathId);
      setRecapNotice(`Fiche de synthèse créée (${result.review_items_created} question(s) de révision ajoutée(s)).`);
      await reload();
      if (openPath?.path.id === pathId) await handleOpen(result.path);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (openPath) {
    const { path, steps } = openPath;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button type="button" style={btnGhostStyle} onClick={() => setOpenPath(null)}><ArrowLeft size={12} /> Retour à la liste</button>

        {path.status === 'planning' && (
          <PlanEditor
            path={path}
            onStarted={(p, s) => setOpenPath({ path: p, steps: s })}
            onCancel={() => setOpenPath(null)}
          />
        )}

        {path.status === 'active' && (
          <LessonView
            path={path}
            steps={steps}
            onRefresh={(p, s) => setOpenPath({ path: p, steps: s })}
            onFinished={(p) => setOpenPath({ path: p, steps })}
          />
        )}

        {path.status === 'completed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#3dffaa' }}>Parcours terminé — {path.subject}</div>
            {path.recap_neuron_id ? (
              <div style={{ fontSize: 12, color: '#64748b' }}>Fiche de synthèse déjà créée.</div>
            ) : (
              <button type="button" style={btnStyle} onClick={() => void handleCreateRecap(path.id)}>
                Créer une fiche de synthèse (neurone)
              </button>
            )}
            {recapNotice && <div style={{ fontSize: 12, color: '#3dffaa' }}>{recapNotice}</div>}
          </div>
        )}

        {path.status === 'abandoned' && (
          <div style={{ fontSize: 13, color: '#94a3b8' }}>Parcours abandonné.</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={cardStyle}>
        <span style={labelStyle}>APPRENDS-MOI…</span>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input
            style={inputStyle}
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="ex: les bases de la thermodynamique"
            onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); }}
          />
          <select style={{ ...inputStyle, width: 160 }} value={register} onChange={e => setRegister(e.target.value as TeacherRegister)}>
            {(Object.keys(REGISTER_LABELS) as TeacherRegister[]).map(r => (
              <option key={r} value={r}>{REGISTER_LABELS[r]}</option>
            ))}
          </select>
          <button type="button" style={btnStyle} onClick={() => void handleCreate()} disabled={creating || !subject.trim()}>
            {creating ? <RefreshCw size={13} className="spin" /> : <Plus size={13} />} Créer le plan
          </button>
        </div>
        {error && <div style={{ fontSize: 12, color: '#ff4d58', marginTop: 6 }}>{error}</div>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {paths.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>Aucun parcours pour l'instant.</div>}
        {paths.map(p => (
          <div key={p.id} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => void handleOpen(p)}>
              <div style={{ fontSize: 13, color: '#e2e8f0' }}>{p.subject}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {REGISTER_LABELS[p.register]} · {p.status} · maj {formatDate(p.updated_at)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {p.status === 'active' && (
                <button type="button" style={btnGhostStyle} onClick={() => void handleAbandon(p.id)}>Abandonner</button>
              )}
              <button type="button" style={btnGhostStyle} onClick={() => void handleDelete(p.id)}><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Onglet Révision espacée ───────────────────────────────────────────────

function ReviewTab() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [countDue, setCountDue] = useState(0);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<{ correct: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { items: due, count_due } = await cortexClient.getDueReviewItems(10);
    setItems(due);
    setCountDue(count_due);
    setIdx(0);
    setFeedback(null);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const current = items[idx];

  async function handleSubmit() {
    if (!current || !answer.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await cortexClient.answerReviewItem(current.id, answer.trim());
      setFeedback({ correct: result.correct, text: `${result.feedback} (prochaine révision dans ${result.interval_days} jour(s))` });
      setAnswer('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleNext() {
    setFeedback(null);
    setIdx(i => i + 1);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13, color: '#e2e8f0' }}>{countDue} question(s) en attente</div>

      {!current && (
        <div style={{ fontSize: 12, color: '#64748b' }}>Rien à réviser pour l'instant — reviens plus tard.</div>
      )}

      {current && (
        <div style={cardStyle}>
          <div style={{ fontSize: 13, color: '#e2e8f0', marginBottom: 10 }}>{current.question}</div>

          {!feedback ? (
            <>
              <textarea
                style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                placeholder="Ta réponse…"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button type="button" style={btnStyle} onClick={() => void handleSubmit()} disabled={submitting || !answer.trim()}>
                  {submitting ? <RefreshCw size={13} className="spin" /> : <Check size={13} />} Valider
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, color: feedback.correct ? '#3dffaa' : '#ffb547', marginBottom: 10 }}>
                {feedback.correct ? 'Correct — ' : 'À revoir — '}{feedback.text}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" style={btnStyle} onClick={handleNext}>
                  <ArrowRight size={13} /> Suivant
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: '#ff4d58' }}>{error}</div>}
    </div>
  );
}

// ── Onglet Stats ───────────────────────────────────────────────────────

function StatsTab() {
  const [stats, setStats] = useState<TeacherStats | null>(null);

  useEffect(() => { void cortexClient.getTeacherStats().then(setStats); }, []);

  if (!stats) return <div style={{ color: '#64748b', fontSize: 12 }}>Chargement…</div>;

  const rows: [string, string | number][] = [
    ['Parcours en cours', stats.paths_in_progress],
    ['Parcours en planification', stats.paths_planning],
    ['Parcours terminés', stats.paths_completed],
    ['Parcours abandonnés', stats.paths_abandoned],
    ['Sujets étudiés (terminés)', stats.subjects_studied],
    ['Questions de révision en attente', stats.due_now],
    ['Tentatives de révision', stats.total_attempts],
    ['Taux de réussite', `${Math.round(stats.success_rate * 100)}%`],
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={cardStyle}>
          <div style={{ fontSize: 11, color: '#64748b' }}>{label}</div>
          <div style={{ fontSize: 20, color: '#e2e8f0', marginTop: 4 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Modal racine ──────────────────────────────────────────────────────────

export default function TeacherModal({ onClose, strictLocalMode }: Props) {
  const [tab, setTab] = useState<Tab>('apprentissage');
  const [defaultRegister, setDefaultRegister] = useState<TeacherRegister>('standard');

  useEffect(() => {
    void cortexClient.getTeacherSettings().then(s => setDefaultRegister(s.defaultRegister));
  }, []);

  return (
    <div style={modalStyle} onClick={onClose}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <GraduationCap size={18} color="#a78bfa" />
            <span style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600 }}>Professeur</span>
          </div>
          <button type="button" style={{ ...btnGhostStyle, padding: 6 }} onClick={onClose}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <button type="button" style={tabBtnStyle(tab === 'apprentissage')} onClick={() => setTab('apprentissage')}>Apprentissage</button>
          <button type="button" style={tabBtnStyle(tab === 'revision')} onClick={() => setTab('revision')}>Révision</button>
          <button type="button" style={tabBtnStyle(tab === 'stats')} onClick={() => setTab('stats')}>Stats</button>
          <button type="button" style={tabBtnStyle(tab === 'reglages')} onClick={() => setTab('reglages')}><Settings size={12} style={{ marginRight: 4 }} />Réglages</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {tab === 'apprentissage' && <LearningTab defaultRegister={defaultRegister} />}
          {tab === 'revision' && <ReviewTab />}
          {tab === 'stats' && <StatsTab />}
          {tab === 'reglages' && <SettingsTab strictLocalMode={strictLocalMode} />}
        </div>
      </div>
    </div>
  );
}
