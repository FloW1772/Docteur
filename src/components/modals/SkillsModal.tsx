import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Plus, Play, Edit2, Trash2, Copy, Download, Upload, ChevronLeft, RefreshCw, History, Wand2, AlertTriangle, CheckCircle, Bookmark, BookmarkCheck } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { Skill, SkillRun, SkillsListResult } from '../../lib/cortex/client';
import { MarkdownContent } from '../../lib/renderMd';
import { KIND_META } from '../../lib/types';
import type { PageKind } from '../../lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

type View =
  | { type: 'list' }
  | { type: 'create' }
  | { type: 'edit'; skill: Skill }
  | { type: 'run'; skill: Skill }
  | { type: 'history'; skill: Skill };

// ── Constants ─────────────────────────────────────────────────────────────────

const INPUT_TYPES  = [
  { value: 'text',   label: 'Texte collé' },
  { value: 'neuron', label: 'Neurone sélectionné' },
  { value: 'file',   label: 'Fichier déposé' },
] as const;

const OUTPUT_TYPES = [
  { value: 'display', label: 'Afficher le résultat' },
  { value: 'neuron',  label: 'Créer un neurone' },
] as const;

const KINDS = Object.keys(KIND_META) as PageKind[];

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeDate(iso: string | null): string {
  if (!iso) return 'jamais';
  const d   = new Date(iso);
  const now = Date.now();
  const s   = Math.floor((now - d.getTime()) / 1000);
  if (s < 60)    return 'à l\'instant';
  if (s < 3600)  return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

// ── Sub-component: SkillCard ──────────────────────────────────────────────────

function SkillCard({
  skill,
  onRun, onEdit, onHistory, onDuplicate, onExport, onDelete,
}: {
  skill:       Skill;
  onRun:       () => void;
  onEdit:      () => void;
  onHistory:   () => void;
  onDuplicate: () => void;
  onExport:    () => void;
  onDelete:    () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div style={{
      padding:      '14px 16px',
      borderRadius:  10,
      border:       `1px solid ${skill.private ? 'rgba(244,114,182,0.2)' : 'rgba(61,255,170,0.1)'}`,
      background:    skill.private ? 'rgba(244,114,182,0.03)' : 'rgba(61,255,170,0.02)',
      transition:   'border-color 0.15s',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="font-grotesk font-semibold" style={{ color: '#f0eaff', fontSize: 14 }}>
              {skill.name}
            </span>
            {skill.private && (
              <span className="font-mono" style={{ fontSize: 9, color: '#f472b6', background: 'rgba(244,114,182,0.1)', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.1em' }}>
                🔒 PRIVÉ
              </span>
            )}
            {skill.model === 'cloud' && (
              <span className="font-mono" style={{ fontSize: 9, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.1em' }}>
                ☁ CLOUD
              </span>
            )}
            {!skill.active && (
              <span className="font-mono" style={{ fontSize: 9, color: '#5a4a7a', background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: 4 }}>
                désactivé
              </span>
            )}
          </div>
          {skill.description && (
            <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 11, marginTop: 3, lineHeight: 1.5 }}>
              {skill.description}
            </p>
          )}
        </div>
        <span className="font-mono" style={{ fontSize: 9, color: '#2e2555', whiteSpace: 'nowrap', marginTop: 2 }}>
          {relativeDate(skill.last_run_at)} · {skill.run_count} exec
        </span>
      </div>

      {/* Instruction preview */}
      <p className="font-mono" style={{
        color: '#3d3060', fontSize: 11, lineHeight: 1.5,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        marginBottom: 10,
      }}>
        › {skill.instruction || '(aucune instruction)'}
      </p>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onRun}
          disabled={!skill.active}
          className="font-mono"
          style={{
            fontSize: 11, padding: '5px 14px', borderRadius: 7,
            border: '1px solid rgba(61,255,170,0.35)', background: 'rgba(61,255,170,0.08)',
            color: skill.active ? '#3dffaa' : '#2a5040', cursor: skill.active ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', gap: 5,
          }}
        >
          <Play size={10} /> Exécuter
        </button>
        <IconBtn title="Modifier" onClick={onEdit}><Edit2 size={12} /></IconBtn>
        <IconBtn title="Historique" onClick={onHistory}><History size={12} /></IconBtn>
        <IconBtn title="Dupliquer" onClick={onDuplicate}><Copy size={12} /></IconBtn>
        <IconBtn title="Exporter (JSON)" onClick={onExport}><Download size={12} /></IconBtn>
        {confirmDelete ? (
          <>
            <button type="button" onClick={onDelete} className="font-mono"
              style={{ fontSize: 10, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(255,77,88,0.5)', background: 'rgba(255,77,88,0.12)', color: '#ff4d58', cursor: 'pointer' }}>
              Confirmer
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="font-mono"
              style={{ fontSize: 10, padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(61,45,90,0.4)', background: 'transparent', color: '#5a4a7a', cursor: 'pointer' }}>
              Annuler
            </button>
          </>
        ) : (
          <IconBtn title="Supprimer" onClick={() => setConfirmDelete(true)} danger><Trash2 size={12} /></IconBtn>
        )}
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick, danger = false }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        width: 28, height: 28, borderRadius: 7,
        border:     `1px solid ${danger ? 'rgba(255,77,88,0.2)' : 'rgba(61,45,90,0.4)'}`,
        background: 'transparent',
        color:      danger ? '#ff4d58' : '#5a4a7a',
        cursor:     'pointer',
        display:    'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = danger ? 'rgba(255,77,88,0.5)' : 'rgba(61,255,170,0.3)'; e.currentTarget.style.color = danger ? '#ff6060' : '#3dffaa'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = danger ? 'rgba(255,77,88,0.2)' : 'rgba(61,45,90,0.4)'; e.currentTarget.style.color = danger ? '#ff4d58' : '#5a4a7a'; }}
    >
      {children}
    </button>
  );
}

// ── Sub-component: SkillForm (Create or Edit) ─────────────────────────────────

interface SkillFormState {
  name:        string;
  description: string;
  instruction: string;
  input_type:  'text' | 'neuron' | 'file';
  output_type: 'display' | 'neuron';
  output_kind: string;
  model:       'local' | 'cloud';
  private:     boolean;
}

function emptyForm(): SkillFormState {
  return { name: '', description: '', instruction: '', input_type: 'text', output_type: 'display', output_kind: 'note', model: 'local', private: false };
}

function skillToForm(s: Skill): SkillFormState {
  return { name: s.name, description: s.description, instruction: s.instruction, input_type: s.input_type as SkillFormState['input_type'], output_type: s.output_type as SkillFormState['output_type'], output_kind: s.output_kind, model: s.model, private: s.private };
}

function SkillForm({
  initial,
  editingSkill,
  onSave,
  onCancel,
}: {
  initial:      SkillFormState;
  editingSkill: Skill | null;
  onSave:       (form: SkillFormState) => Promise<void>;
  onCancel:     () => void;
}) {
  const [form, setForm]           = useState<SkillFormState>(initial);
  const [wizardDesc, setWizardDesc] = useState('');
  const [wizardMode, setWizardMode] = useState<'none' | 'generating' | 'done'>('none');
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [testInput, setTestInput]   = useState('');
  const [testResult, setTestResult] = useState<{ output: string; model: string; ms: number } | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError]   = useState<string | null>(null);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [refineMode, setRefineMode] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState('');
  const [refining, setRefining]     = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const set = (k: keyof SkillFormState, v: unknown) =>
    setForm(prev => ({ ...prev, [k]: v }));

  // If private, force local
  const effectiveModel = form.private ? 'local' : form.model;

  async function handleGenerate() {
    if (!wizardDesc.trim()) return;
    setWizardMode('generating');
    setWizardError(null);
    try {
      const res = await cortexClient.generateSkillInstruction(wizardDesc.trim());
      setForm(prev => ({
        ...prev,
        instruction: res.instruction,
        name:        prev.name || res.suggested_name,
      }));
      setWizardMode('done');
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : 'Erreur');
      setWizardMode('none');
    }
  }

  async function handleTest() {
    if (!form.instruction.trim() || !testInput.trim()) return;
    setTestLoading(true);
    setTestResult(null);
    setTestError(null);
    // Use a temp run without saving — run against a throw-away skill via the generate endpoint trick
    // Actually we create a temporary skill, run it, then delete it. Or better: just call generate with a special param.
    // Simpler: POST /api/skills with temp=true. Instead, since the server validates skill existence,
    // use a client-side simulation by calling generate with instruction+content as user message.
    // We'll do it the clean way: save the skill (or update), run, then present result.
    // For "test before save", we temporarily call runSkill on an existing edit, or if new, we create+run+delete.
    try {
      let tempId: string | null = null;
      if (editingSkill) {
        // Update instruction temporarily
        await cortexClient.updateSkill(editingSkill.id, { instruction: form.instruction });
        const r = await cortexClient.runSkill(editingSkill.id, testInput);
        setTestResult({ output: r.output, model: r.model_used, ms: r.latency_ms });
        // Restore original instruction if user cancels
      } else {
        // Create temp skill, run, delete
        const tmp = await cortexClient.createSkill({ ...form, model: effectiveModel, name: form.name || '__temp__' });
        tempId = tmp.id;
        try {
          const r = await cortexClient.runSkill(tmp.id, testInput);
          setTestResult({ output: r.output, model: r.model_used, ms: r.latency_ms });
        } finally {
          await cortexClient.deleteSkill(tempId);
        }
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setTestLoading(false);
    }
  }

  async function handleRefine() {
    if (!refineFeedback.trim() || !editingSkill) return;
    setRefining(true);
    try {
      const res = await cortexClient.refineSkillInstruction(editingSkill.id, refineFeedback, testResult?.output);
      setForm(prev => ({ ...prev, instruction: res.instruction }));
      setRefineFeedback('');
      setRefineMode(false);
      setTestResult(null);
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : 'Erreur affinage');
    } finally {
      setRefining(false);
    }
  }

  async function handleSave() {
    if (!form.name.trim() || !form.instruction.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ ...form, model: effectiveModel });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Erreur sauvegarde');
    } finally {
      setSaving(false);
    }
  }

  const isValid = form.name.trim().length > 0 && form.instruction.trim().length > 0;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: 8, boxSizing: 'border-box',
    border: '1px solid rgba(61,45,90,0.5)', background: 'rgba(255,255,255,0.03)',
    color: '#e0d8ff', fontSize: 13, fontFamily: 'IBM Plex Mono, monospace',
    outline: 'none', caretColor: '#3dffaa',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Wizard (generate from description) ── */}
      <div style={{ padding: '14px 16px', background: 'rgba(167,139,250,0.04)', border: '1px solid rgba(167,139,250,0.15)', borderRadius: 10 }}>
        <p className="font-mono" style={{ color: '#a78bfa', fontSize: 10, letterSpacing: '0.14em', marginBottom: 8 }}>
          ✦ ASSISTANT DE CRÉATION — décrire en langage naturel
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            value={wizardDesc}
            onChange={e => setWizardDesc(e.target.value)}
            placeholder={'ex : "transformer mes notes de réunion en compte-rendu avec participants, décisions et actions"'}
            rows={2}
            style={{ ...inputStyle, flex: 1, resize: 'vertical', minHeight: 54 }}
          />
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!wizardDesc.trim() || wizardMode === 'generating'}
            className="font-mono"
            style={{
              fontSize: 11, padding: '9px 14px', borderRadius: 8, flexShrink: 0, alignSelf: 'stretch',
              border: '1px solid rgba(167,139,250,0.4)', background: 'rgba(167,139,250,0.1)',
              color: '#a78bfa', cursor: wizardDesc.trim() && wizardMode !== 'generating' ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {wizardMode === 'generating'
              ? <><RefreshCw size={11} className="animate-spin" /> Génération…</>
              : <><Wand2 size={11} /> Générer</>}
          </button>
        </div>
        {wizardError && <p className="font-mono" style={{ color: '#ff4d58', fontSize: 11, marginTop: 6 }}>{wizardError}</p>}
        {wizardMode === 'done' && <p className="font-mono" style={{ color: '#3dffaa', fontSize: 10, marginTop: 6 }}>✓ Instruction générée — modifiez-la ci-dessous si nécessaire</p>}
      </div>

      {/* ── Core fields ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', display: 'block', marginBottom: 5 }}>NOM *</label>
          <input type="text" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Nom de la compétence" style={inputStyle} maxLength={80} />
        </div>
        <div>
          <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', display: 'block', marginBottom: 5 }}>DESCRIPTION</label>
          <input type="text" value={form.description} onChange={e => set('description', e.target.value)} placeholder="Décrit ce que fait cette compétence…" style={inputStyle} maxLength={300} />
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
          <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em' }}>INSTRUCTION * (appliquée au contenu fourni)</label>
          {editingSkill && editingSkill.instruction_history.length > 0 && (
            <button type="button" onClick={() => setHistoryOpen(v => !v)} className="font-mono"
              style={{ fontSize: 9, color: '#4a3a6a', cursor: 'pointer', background: 'none', border: 'none', textDecoration: 'underline' }}>
              {historyOpen ? 'Masquer' : `${editingSkill.instruction_history.length} version(s) précédente(s)`}
            </button>
          )}
        </div>
        <textarea
          value={form.instruction}
          onChange={e => set('instruction', e.target.value)}
          placeholder="Transforme le texte suivant en… / Extrais les… / Résume en…"
          rows={5}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 96 }}
        />
        {historyOpen && editingSkill && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {editingSkill.instruction_history.map((h, i) => (
              <div key={i} style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid rgba(61,45,90,0.3)', background: 'rgba(0,0,0,0.15)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>v{h.version} — {new Date(h.saved_at).toLocaleString('fr-FR')}</span>
                  <button type="button" onClick={() => set('instruction', h.instruction)} className="font-mono"
                    style={{ fontSize: 9, color: '#5ee7ff', cursor: 'pointer', background: 'none', border: 'none', textDecoration: 'underline' }}>
                    Restaurer
                  </button>
                </div>
                <p className="font-mono" style={{ color: '#4a3a6a', fontSize: 11, lineHeight: 1.5, margin: 0 }}>{h.instruction.slice(0, 120)}{h.instruction.length > 120 ? '…' : ''}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Config row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', display: 'block', marginBottom: 5 }}>ENTRÉE</label>
          <select value={form.input_type} onChange={e => set('input_type', e.target.value)} style={{ ...inputStyle, appearance: 'auto' }}>
            {INPUT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', display: 'block', marginBottom: 5 }}>SORTIE</label>
          <select value={form.output_type} onChange={e => set('output_type', e.target.value as 'display' | 'neurone')} style={{ ...inputStyle, appearance: 'auto' }}>
            {OUTPUT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', display: 'block', marginBottom: 5 }}>MODÈLE</label>
          <select value={effectiveModel} onChange={e => set('model', e.target.value)} disabled={form.private} style={{ ...inputStyle, appearance: 'auto', opacity: form.private ? 0.5 : 1 }}>
            <option value="local">Local (défaut)</option>
            <option value="cloud">Cloud</option>
          </select>
        </div>
      </div>

      {form.output_type === 'neuron' && (
        <div>
          <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', display: 'block', marginBottom: 5 }}>TYPE DU NEURONE CRÉÉ</label>
          <select value={form.output_kind} onChange={e => set('output_kind', e.target.value)} style={{ ...inputStyle, appearance: 'auto' }}>
            {KINDS.map(k => <option key={k} value={k}>{KIND_META[k].icon} {KIND_META[k].label}</option>)}
          </select>
        </div>
      )}

      {/* ── Private toggle ── */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={form.private} onChange={e => set('private', e.target.checked)}
          style={{ accentColor: '#f472b6', width: 14, height: 14 }} />
        <span className="font-mono" style={{ fontSize: 12, color: form.private ? '#f472b6' : '#5a4a7a' }}>
          🔒 Compétence privée — modèle local imposé, verrou de sortie actif
        </span>
      </label>
      {form.model === 'cloud' && !form.private && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 7, border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.05)' }}>
          <AlertTriangle size={13} style={{ color: '#f59e0b', flexShrink: 0 }} />
          <span className="font-mono" style={{ fontSize: 11, color: '#f59e0b' }}>Le contenu traité sera envoyé au fournisseur cloud sélectionné.</span>
        </div>
      )}

      {/* ── Test area ── */}
      <div style={{ padding: '14px 16px', background: 'rgba(94,231,255,0.03)', border: '1px solid rgba(94,231,255,0.12)', borderRadius: 10 }}>
        <p className="font-mono" style={{ color: '#5ee7ff', fontSize: 10, letterSpacing: '0.14em', marginBottom: 8 }}>TESTER AVANT DE SAUVEGARDER</p>
        <textarea
          value={testInput}
          onChange={e => setTestInput(e.target.value)}
          placeholder="Colle un exemple de contenu à traiter…"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 64, marginBottom: 8 }}
        />
        <button
          type="button"
          onClick={handleTest}
          disabled={!form.instruction.trim() || !testInput.trim() || testLoading}
          className="font-mono"
          style={{
            fontSize: 11, padding: '7px 16px', borderRadius: 7,
            border: '1px solid rgba(94,231,255,0.3)', background: 'rgba(94,231,255,0.07)',
            color: '#5ee7ff', cursor: (form.instruction.trim() && testInput.trim() && !testLoading) ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          {testLoading ? <><RefreshCw size={11} className="animate-spin" /> Exécution…</> : <><Play size={11} /> Tester sur cet exemple</>}
        </button>
        {testError && <p className="font-mono" style={{ color: '#ff4d58', fontSize: 11, marginTop: 8 }}>{testError}</p>}
        {testResult && (
          <div style={{ marginTop: 10 }}>
            <p className="font-mono" style={{ color: '#2e2555', fontSize: 9, marginBottom: 6, letterSpacing: '0.08em' }}>
              RÉSULTAT · {testResult.model.split(':')[0]} · {(testResult.ms / 1000).toFixed(1)}s
            </p>
            <MarkdownContent text={testResult.output} textStyle={{ fontSize: 12, color: '#c8b8e8', lineHeight: 1.7 }} />
            {/* Refine button after test */}
            {editingSkill && (
              <div style={{ marginTop: 10 }}>
                {!refineMode ? (
                  <button type="button" onClick={() => setRefineMode(true)} className="font-mono"
                    style={{ fontSize: 10, padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.3)', background: 'transparent', color: '#f59e0b', cursor: 'pointer' }}>
                    ↺ Affiner l'instruction
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="text" value={refineFeedback} onChange={e => setRefineFeedback(e.target.value)}
                      placeholder="Ce qui n'allait pas / amélioration souhaitée…"
                      onKeyDown={e => { if (e.key === 'Enter') handleRefine(); }}
                      style={{ ...inputStyle, flex: 1 }} />
                    <button type="button" onClick={handleRefine} disabled={!refineFeedback.trim() || refining} className="font-mono"
                      style={{ fontSize: 11, padding: '7px 12px', borderRadius: 7, border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.08)', color: '#f59e0b', cursor: !refineFeedback.trim() || refining ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                      {refining ? <RefreshCw size={11} className="animate-spin" /> : '↺ Affiner'}
                    </button>
                    <button type="button" onClick={() => setRefineMode(false)} className="font-mono"
                      style={{ fontSize: 11, padding: '7px 10px', borderRadius: 7, border: '1px solid rgba(61,45,90,0.4)', background: 'transparent', color: '#5a4a7a', cursor: 'pointer' }}>
                      ✕
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Actions ── */}
      {saveError && <p className="font-mono" style={{ color: '#ff4d58', fontSize: 12 }}>{saveError}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isValid || saving}
          className="font-mono"
          style={{
            flex: 1, padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 12,
            border: '1px solid rgba(61,255,170,0.4)', background: isValid && !saving ? 'rgba(61,255,170,0.1)' : 'rgba(30,40,30,0.3)',
            color: isValid && !saving ? '#3dffaa' : '#2a5040', cursor: isValid && !saving ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          {saving ? <><RefreshCw size={12} className="animate-spin" /> Sauvegarde…</> : <><CheckCircle size={12} /> Sauvegarder la compétence</>}
        </button>
        <button type="button" onClick={onCancel} className="font-mono"
          style={{ padding: '10px 16px', borderRadius: 8, fontSize: 12, border: '1px solid rgba(61,45,90,0.4)', background: 'transparent', color: '#5a4a7a', cursor: 'pointer' }}>
          Annuler
        </button>
      </div>
    </div>
  );
}

// ── Sub-component: RunPanel ───────────────────────────────────────────────────

function RunPanel({ skill, onBack, onSaveNeuron }: { skill: Skill; onBack: () => void; onSaveNeuron: (content: string, kind: string) => Promise<void> }) {
  const [input, setInput]       = useState('');
  const [output, setOutput]     = useState<{ text: string; model: string; ms: number } | null>(null);
  const [running, setRunning]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [copied, setCopied]     = useState(false);

  async function handleRun() {
    if (!input.trim() || running) return;
    setRunning(true);
    setOutput(null);
    setError(null);
    setSaved(false);
    try {
      const r = await cortexClient.runSkill(skill.id, input);
      setOutput({ text: r.output, model: r.model_used, ms: r.latency_ms });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setRunning(false);
    }
  }

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  async function handleSave() {
    if (!output || saving || saved) return;
    setSaving(true);
    try {
      await onSaveNeuron(output.text, skill.output_kind);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: 8, boxSizing: 'border-box',
    border: '1px solid rgba(61,45,90,0.5)', background: 'rgba(255,255,255,0.03)',
    color: '#e0d8ff', fontSize: 13, fontFamily: 'IBM Plex Mono, monospace',
    outline: 'none', caretColor: '#3dffaa',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ padding: '10px 14px', background: 'rgba(61,255,170,0.04)', border: '1px solid rgba(61,255,170,0.12)', borderRadius: 8 }}>
        <p className="font-grotesk font-semibold" style={{ color: '#f0eaff', fontSize: 14, marginBottom: 2 }}>{skill.name}</p>
        <p className="font-mono" style={{ color: '#3d3060', fontSize: 11 }}>› {skill.instruction.slice(0, 100)}{skill.instruction.length > 100 ? '…' : ''}</p>
      </div>

      <div>
        <label className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>CONTENU À TRAITER</label>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Colle ton texte ici…"
          rows={8}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 120 }}
        />
        <p className="font-mono" style={{ color: '#2e2555', fontSize: 9, marginTop: 4 }}>{input.length.toLocaleString()} / 12 000 caractères max</p>
      </div>

      <button
        type="button"
        onClick={handleRun}
        disabled={!input.trim() || running}
        className="font-mono"
        style={{
          width: '100%', padding: '11px', borderRadius: 8, fontWeight: 600, fontSize: 12,
          border: '1px solid rgba(61,255,170,0.4)', background: input.trim() && !running ? 'rgba(61,255,170,0.1)' : 'rgba(30,40,30,0.3)',
          color: input.trim() && !running ? '#3dffaa' : '#2a5040', cursor: input.trim() && !running ? 'pointer' : 'not-allowed',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        {running ? <><RefreshCw size={13} className="animate-spin" /> Exécution en cours…</> : <><Play size={13} /> Exécuter la compétence</>}
      </button>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,77,88,0.3)', background: 'rgba(255,77,88,0.05)' }}>
          <p className="font-mono" style={{ color: '#ff4d58', fontSize: 12 }}>{error}</p>
        </div>
      )}

      {output && (
        <div style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid rgba(94,231,255,0.15)', background: 'rgba(94,231,255,0.03)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <p className="font-mono" style={{ color: '#2e2555', fontSize: 9, letterSpacing: '0.08em' }}>
              RÉSULTAT · {output.model.split(':')[0]} · {(output.ms / 1000).toFixed(1)}s
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={handleCopy} className="font-mono"
                style={{ fontSize: 10, padding: '3px 10px', borderRadius: 6, border: '1px solid rgba(94,231,255,0.25)', background: 'transparent', color: copied ? '#3dffaa' : '#5ee7ff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Copy size={9} /> {copied ? 'Copié !' : 'Copier'}
              </button>
              {skill.output_type === 'neuron' && (
                <button type="button" onClick={handleSave} disabled={saved || saving} className="font-mono"
                  style={{ fontSize: 10, padding: '3px 10px', borderRadius: 6, border: `1px solid ${saved ? 'rgba(0,212,177,0.3)' : 'rgba(61,255,170,0.25)'}`, background: saved ? 'rgba(0,212,177,0.08)' : 'transparent', color: saved ? '#00d4b1' : '#3dffaa', cursor: saved || saving ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {saved ? <><BookmarkCheck size={9} /> Sauvegardé</> : saving ? <><RefreshCw size={9} className="animate-spin" /> …</> : <><Bookmark size={9} /> Sauvegarder</>}
                </button>
              )}
            </div>
          </div>
          <MarkdownContent text={output.text} textStyle={{ fontSize: 13, color: '#c8b8e8', lineHeight: 1.75 }} />
        </div>
      )}
    </div>
  );
}

// ── Sub-component: HistoryPanel ───────────────────────────────────────────────

function HistoryPanel({ skill, onBack }: { skill: Skill; onBack: () => void }) {
  const [runs, setRuns]       = useState<SkillRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    cortexClient.getSkillRuns(skill.id).then(setRuns).catch(() => setRuns([])).finally(() => setLoading(false));
  }, [skill.id]);

  return (
    <div>
      {loading ? (
        <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 12, padding: '20px 0' }}>Chargement…</p>
      ) : runs.length === 0 ? (
        <p className="font-mono" style={{ color: '#3d3060', fontSize: 12, padding: '20px 0' }}>Aucune exécution enregistrée.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {runs.map(run => (
            <div key={run.id} style={{
              padding: '10px 14px', borderRadius: 8,
              border: `1px solid ${run.status === 'done' ? 'rgba(61,255,170,0.12)' : run.status === 'error' ? 'rgba(255,77,88,0.2)' : 'rgba(61,45,90,0.3)'}`,
              background: 'rgba(0,0,0,0.15)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12 }}>{run.status === 'done' ? '✓' : run.status === 'error' ? '✗' : '…'}</span>
                  <span className="font-mono" style={{ fontSize: 11, color: '#c8b8e8' }}>{run.input_preview.slice(0, 60)}{run.input_preview.length > 60 ? '…' : ''}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="font-mono" style={{ fontSize: 9, color: '#3d3060' }}>
                    {new Date(run.started_at).toLocaleString('fr-FR')}
                    {run.latency_ms ? ` · ${(run.latency_ms / 1000).toFixed(1)}s` : ''}
                  </span>
                  {run.output && (
                    <button type="button" onClick={() => setExpanded(expanded === run.id ? null : run.id)} className="font-mono"
                      style={{ fontSize: 9, color: '#5ee7ff', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                      {expanded === run.id ? 'Masquer' : 'Voir'}
                    </button>
                  )}
                </div>
              </div>
              {run.error_message && <p className="font-mono" style={{ color: '#ff4d58', fontSize: 11 }}>{run.error_message}</p>}
              {expanded === run.id && run.output && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(61,45,90,0.3)' }}>
                  <MarkdownContent text={run.output} textStyle={{ fontSize: 12, color: '#a090c0', lineHeight: 1.6 }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main SkillsModal ──────────────────────────────────────────────────────────

interface Props {
  isOpen:         boolean;
  onClose:        () => void;
  onCreateNeuron: (title: string, content: string, kind: string) => Promise<void>;
}

export default function SkillsModal({ isOpen, onClose, onCreateNeuron }: Props) {
  const [view, setView]           = useState<View>({ type: 'list' });
  const [data, setData]           = useState<SkillsListResult | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const importRef                 = useRef<HTMLInputElement>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await cortexClient.listSkills());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Serveur indisponible');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) { setView({ type: 'list' }); loadSkills(); }
  }, [isOpen, loadSkills]);

  async function handleSaveForm(form: SkillFormState, editingSkill: Skill | null) {
    if (editingSkill) {
      await cortexClient.updateSkill(editingSkill.id, form);
    } else {
      await cortexClient.createSkill(form);
    }
    await loadSkills();
    setView({ type: 'list' });
  }

  async function handleDelete(id: string) {
    await cortexClient.deleteSkill(id);
    await loadSkills();
  }

  async function handleDuplicate(skill: Skill) {
    if ((data?.count ?? 0) >= (data?.max ?? 30)) { alert(`Limite de ${data?.max ?? 30} compétences atteinte`); return; }
    await cortexClient.createSkill({ ...skill, name: `${skill.name} (copie)` });
    await loadSkills();
  }

  function handleExport(skill: Skill) {
    const url = cortexClient.getSkillExportUrl(skill.id);
    const a   = document.createElement('a');
    a.href    = url;
    a.download = `skill-${skill.name.replace(/[^a-z0-9]/gi, '-')}.json`;
    a.click();
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await cortexClient.importSkill(data);
      await loadSkills();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Fichier invalide');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  }

  if (!isOpen) return null;

  const title =
    view.type === 'list'    ? 'COMPÉTENCES' :
    view.type === 'create'  ? 'NOUVELLE COMPÉTENCE' :
    view.type === 'edit'    ? `MODIFIER — ${view.skill.name}` :
    view.type === 'run'     ? `EXÉCUTER — ${view.skill.name}` :
    view.type === 'history' ? `HISTORIQUE — ${view.skill.name}` : '';

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(8,6,18,0.93)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        zIndex: 150, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '5vh', animation: 'modal-fade-in 0.16s ease-out',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 760, margin: '0 16px',
        background: 'rgba(10,8,20,0.99)', border: '1px solid rgba(61,255,170,0.18)',
        borderRadius: 14, overflow: 'hidden', animation: 'modal-scale-in 0.16s ease-out',
        display: 'flex', flexDirection: 'column', maxHeight: '88vh',
        boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid rgba(61,255,170,0.1)', flexShrink: 0 }}>
          {view.type !== 'list' && (
            <button type="button" onClick={() => { setView({ type: 'list' }); loadSkills(); }}
              style={{ color: '#5a4a7a', cursor: 'pointer', padding: 4, lineHeight: 0, background: 'none', border: 'none' }}>
              <ChevronLeft size={16} />
            </button>
          )}
          <span className="font-grotesk font-semibold" style={{ color: '#3dffaa', fontSize: 11, letterSpacing: '0.2em', flex: 1 }}>
            ⚡ {title}
          </span>
          {view.type === 'list' && (
            <>
              <span className="font-mono" style={{ fontSize: 10, color: '#2e2555' }}>
                {data?.count ?? 0}/{data?.max ?? 30}
              </span>
              <button type="button" onClick={() => importRef.current?.click()} title="Importer une compétence (JSON)"
                style={{ color: '#5a4a7a', cursor: 'pointer', padding: 4, lineHeight: 0, background: 'none', border: 'none' }}>
                <Upload size={14} />
              </button>
              <input ref={importRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
              <button
                type="button"
                onClick={() => setView({ type: 'create' })}
                disabled={(data?.count ?? 0) >= (data?.max ?? 30)}
                className="font-mono"
                style={{
                  fontSize: 11, padding: '5px 12px', borderRadius: 7,
                  border: '1px solid rgba(61,255,170,0.35)', background: 'rgba(61,255,170,0.08)',
                  color: '#3dffaa', cursor: (data?.count ?? 0) < (data?.max ?? 30) ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                <Plus size={11} /> Créer
              </button>
            </>
          )}
          <button type="button" onClick={onClose} style={{ color: '#3d3060', cursor: 'pointer', lineHeight: 0, padding: 2, background: 'none', border: 'none' }}>
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {view.type === 'list' && (
            <>
              {loading && <p className="font-mono" style={{ color: '#5a4a7a', fontSize: 12 }}>Chargement…</p>}
              {error && (
                <div style={{ padding: '12px 16px', borderRadius: 8, border: '1px solid rgba(255,77,88,0.2)', background: 'rgba(255,77,88,0.04)', marginBottom: 16 }}>
                  <p className="font-mono" style={{ color: '#ff4d58', fontSize: 12 }}>{error}</p>
                </div>
              )}
              {!loading && data && data.skills.length === 0 && (
                <div style={{ padding: '40px 0', textAlign: 'center' }}>
                  <p className="font-mono" style={{ color: '#2a2040', fontSize: 12, lineHeight: 2 }}>
                    Aucune compétence créée.<br />
                    <span style={{ color: '#1e1535', fontSize: 11 }}>
                      Clique sur «&nbsp;Créer&nbsp;» et décris ton besoin en langage naturel.
                    </span>
                  </p>
                </div>
              )}
              {data && data.skills.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {data.skills.map(skill => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      onRun={()     => setView({ type: 'run',     skill })}
                      onEdit={()    => setView({ type: 'edit',    skill })}
                      onHistory={()=> setView({ type: 'history',  skill })}
                      onDuplicate={()=> handleDuplicate(skill)}
                      onExport={()  => handleExport(skill)}
                      onDelete={()  => handleDelete(skill.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {view.type === 'create' && (
            <SkillForm
              initial={emptyForm()}
              editingSkill={null}
              onSave={form => handleSaveForm(form, null)}
              onCancel={() => setView({ type: 'list' })}
            />
          )}

          {view.type === 'edit' && (
            <SkillForm
              initial={skillToForm(view.skill)}
              editingSkill={view.skill}
              onSave={form => handleSaveForm(form, view.skill)}
              onCancel={() => setView({ type: 'list' })}
            />
          )}

          {view.type === 'run' && (
            <RunPanel
              skill={view.skill}
              onBack={() => setView({ type: 'list' })}
              onSaveNeuron={async (content, kind) => {
                await onCreateNeuron(view.skill.name, content, kind);
              }}
            />
          )}

          {view.type === 'history' && (
            <HistoryPanel
              skill={view.skill}
              onBack={() => setView({ type: 'list' })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
