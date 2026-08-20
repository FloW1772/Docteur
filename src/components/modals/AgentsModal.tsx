import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ChevronLeft, Clock, Play, Plus, Trash2, X } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type {
  Agent, AgentCreate, AgentRun, AgentRunOutput, AgentTypeInfo,
} from '../../lib/cortex/client';

interface Props {
  onClose:         () => void;
  onAgentOutput:   (output: AgentRunOutput) => Promise<void>;
}

type View = 'list' | 'new' | 'edit' | 'history';

const FREQ_LABELS: Record<string, string> = {
  daily:  'Quotidien',
  weekly: 'Hebdomadaire',
};

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Agent form ─────────────────────────────────────────────────────────────────

function AgentForm({
  types, initial, onSave, onCancel, busy,
}: {
  types:    AgentTypeInfo[];
  initial?: Partial<AgentCreate>;
  onSave:   (data: AgentCreate) => void;
  onCancel: () => void;
  busy:     boolean;
}) {
  const [name,        setName]        = useState(initial?.name        ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [type,        setType]        = useState(initial?.type        ?? types[0]?.key ?? '');
  const [params,      setParams]      = useState<Record<string, string>>(initial?.params ?? {});
  const [triggerType, setTriggerType] = useState<'manual' | 'scheduled'>(initial?.trigger_type ?? 'manual');
  const [frequency,   setFrequency]   = useState(initial?.schedule?.frequency ?? 'daily');

  const selectedType = types.find(t => t.key === type);

  function setParam(key: string, val: string) {
    setParams(prev => ({ ...prev, [key]: val }));
  }

  function handleTypeChange(newType: string) {
    setType(newType);
    setParams({}); // reset params when type changes
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name: name.trim(),
      description: description.trim(),
      type,
      params,
      trigger_type: triggerType,
      schedule:     triggerType === 'scheduled' ? { frequency: frequency as 'daily' | 'weekly' } : null,
      active:       true,
    });
  }

  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 13, width: '100%',
    fontFamily: 'inherit', outline: 'none',
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
  const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 0, flex: 1, overflow: 'auto' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

        {/* Type */}
        <div style={sectionStyle}>
          <label style={labelStyle}>TYPE D'AGENT</label>
          <select value={type} onChange={e => handleTypeChange(e.target.value)} style={inputStyle}>
            {types.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {selectedType && (
            <span style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{selectedType.description}</span>
          )}
        </div>

        {/* Name */}
        <div style={sectionStyle}>
          <label style={labelStyle}>NOM DE L'AGENT</label>
          <input
            type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder="ex : Veille IA quotidienne" style={inputStyle} required maxLength={100}
          />
        </div>

        {/* Type-specific params */}
        {selectedType?.paramsSchema.map(field => (
          <div key={field.key} style={sectionStyle}>
            <label style={labelStyle}>{field.label.toUpperCase()}{field.required ? ' *' : ''}</label>
            {field.type === 'select' ? (
              <select
                value={params[field.key] ?? field.default ?? ''}
                onChange={e => setParam(field.key, e.target.value)}
                style={inputStyle}
              >
                {field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                type="text"
                value={params[field.key] ?? ''}
                onChange={e => setParam(field.key, e.target.value)}
                placeholder={field.placeholder ?? ''}
                style={inputStyle}
                required={field.required}
                maxLength={500}
              />
            )}
          </div>
        ))}

        {/* Trigger */}
        <div style={sectionStyle}>
          <label style={labelStyle}>DÉCLENCHEUR</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['manual', 'scheduled'] as const).map(t => (
              <button
                key={t} type="button" onClick={() => setTriggerType(t)}
                style={{
                  flex: 1, padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  border: triggerType === t ? '1px solid #5ee7ff' : '1px solid rgba(255,255,255,0.1)',
                  background: triggerType === t ? 'rgba(94,231,255,0.08)' : 'rgba(255,255,255,0.03)',
                  color: triggerType === t ? '#5ee7ff' : '#94a3b8', fontFamily: 'monospace',
                }}
              >
                {t === 'manual' ? 'Manuel' : 'Planifié'}
              </button>
            ))}
          </div>
          {triggerType === 'scheduled' && (
            <div style={{ marginTop: 8 }}>
              <label style={labelStyle}>FRÉQUENCE</label>
              <select value={frequency} onChange={e => setFrequency(e.target.value as 'daily' | 'weekly')} style={inputStyle}>
                <option value="daily">Quotidien</option>
                <option value="weekly">Hebdomadaire</option>
              </select>
              <span style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'block' }}>
                Les agents ne s'exécutent que lorsque Docteur est démarré.
                Si le PC était éteint à l'heure prévue, l'agent s'exécutera au prochain démarrage (une seule fois, pas de rattrapage en boucle).
              </span>
            </div>
          )}
        </div>

        {/* Description (optional) */}
        <div style={sectionStyle}>
          <label style={labelStyle}>DESCRIPTION (optionnel)</label>
          <input
            type="text" value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Note personnelle sur cet agent" style={inputStyle} maxLength={200}
          />
        </div>
      </div>

      {/* Footer buttons */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button" onClick={onCancel} disabled={busy}
          style={{ padding: '6px 16px', borderRadius: 6, fontSize: 12, cursor: busy ? 'default' : 'pointer', border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#94a3b8', fontFamily: 'monospace' }}
        >
          Annuler
        </button>
        <button
          type="submit" disabled={busy || !name.trim()}
          style={{ padding: '6px 16px', borderRadius: 6, fontSize: 12, cursor: (busy || !name.trim()) ? 'default' : 'pointer', border: '1px solid rgba(94,231,255,0.3)', background: 'rgba(94,231,255,0.08)', color: busy ? '#94a3b8' : '#5ee7ff', fontFamily: 'monospace' }}
        >
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </form>
  );
}

// ── History panel ─────────────────────────────────────────────────────────────

function HistoryPanel({ agent, onBack }: { agent: Agent; onBack: () => void }) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    cortexClient.getAgentRuns(agent.id).then(r => { setRuns(r); setLoading(false); }).catch(() => setLoading(false));
  }, [agent.id]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5ee7ff', display: 'flex', padding: 2 }}>
          <ChevronLeft size={14} />
        </button>
        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' }}>HISTORIQUE — {agent.name}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
        {loading && <span style={{ fontSize: 12, color: '#64748b' }}>Chargement…</span>}
        {!loading && runs.length === 0 && <span style={{ fontSize: 12, color: '#64748b' }}>Aucune exécution enregistrée.</span>}
        {runs.map(run => (
          <div key={run.id} style={{ padding: '10px 12px', marginBottom: 8, borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{
                fontSize: 10, fontFamily: 'monospace', fontWeight: 600, letterSpacing: '0.06em',
                color: run.status === 'success' ? '#3dffaa' : run.status === 'error' ? '#ff4d58' : '#ffb547',
              }}>
                {run.status === 'success' ? '✓ SUCCÈS' : run.status === 'error' ? '✗ ÉCHEC' : '⟳ EN COURS'}
              </span>
              <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
                {run.triggered_by === 'schedule' ? '⏰ planifié' : run.triggered_by === 'catchup' ? '↩ rattrapage' : '▶ manuel'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{formatDate(run.started_at)}</div>
            {run.output_title && <div style={{ fontSize: 12, color: '#e2e8f0' }}>{run.output_title}</div>}
            {run.error_message && <div style={{ fontSize: 11, color: '#ff4d58', marginTop: 4 }}>{run.error_message}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function AgentsModal({ onClose, onAgentOutput }: Props) {
  const [view,       setView]       = useState<View>('list');
  const [agents,     setAgents]     = useState<Agent[]>([]);
  const [types,      setTypes]      = useState<AgentTypeInfo[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [formBusy,   setFormBusy]   = useState(false);
  const [runningId,  setRunningId]  = useState<string | null>(null);
  const [editAgent,  setEditAgent]  = useState<Agent | null>(null);
  const [histAgent,  setHistAgent]  = useState<Agent | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [toast,      setToast]      = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    Promise.all([cortexClient.listAgents(), cortexClient.listAgentTypes()])
      .then(([ag, tp]) => { setAgents(ag); setTypes(tp); setLoading(false); })
      .catch(() => { setError('Impossible de charger les agents (cortex off ?)'); setLoading(false); });
  }, []);

  async function handleCreate(data: AgentCreate) {
    setFormBusy(true);
    setError(null);
    try {
      const created = await cortexClient.createAgent(data);
      setAgents(prev => [...prev, created]);
      setView('list');
      showToast('Agent créé.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur création');
    } finally {
      setFormBusy(false);
    }
  }

  async function handleEdit(data: AgentCreate) {
    if (!editAgent) return;
    setFormBusy(true);
    setError(null);
    try {
      const updated = await cortexClient.updateAgent(editAgent.id, data);
      setAgents(prev => prev.map(a => a.id === updated.id ? updated : a));
      setView('list');
      setEditAgent(null);
      showToast('Agent mis à jour.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur mise à jour');
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDelete(agent: Agent) {
    if (!confirm(`Supprimer l'agent "${agent.name}" et tout son historique ?`)) return;
    try {
      await cortexClient.deleteAgent(agent.id);
      setAgents(prev => prev.filter(a => a.id !== agent.id));
      showToast('Agent supprimé.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur suppression');
    }
  }

  async function handleToggleActive(agent: Agent) {
    try {
      const updated = await cortexClient.updateAgent(agent.id, { active: !agent.active });
      setAgents(prev => prev.map(a => a.id === updated.id ? updated : a));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur');
    }
  }

  async function handleRun(agent: Agent) {
    setRunningId(agent.id);
    setError(null);
    try {
      const result = await cortexClient.runAgent(agent.id);
      await onAgentOutput(result);
      showToast(`Exécution terminée — neurone "${result.title}" créé.`);
      // Refresh runs implicitly (user can open history)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erreur exécution';
      setError(msg);
    } finally {
      setRunningId(null);
    }
  }

  const modalStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
  };
  const panelStyle: React.CSSProperties = {
    width: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    background: '#0d0f14', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
  };

  function renderHeader(title: string, showBack = false, backFn?: () => void) {
    return (
      <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
        {showBack && (
          <button type="button" onClick={backFn} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5ee7ff', display: 'flex', padding: 2 }}>
            <ChevronLeft size={14} />
          </button>
        )}
        <Bot size={14} style={{ color: '#5ee7ff', flexShrink: 0 }} />
        <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#e2e8f0', fontWeight: 600, flex: 1 }}>{title}</span>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', display: 'flex' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────
  function renderList() {
    return (
      <>
        {renderHeader('AGENTS')}
        {error && <div style={{ padding: '8px 20px', fontSize: 12, color: '#ff4d58', background: 'rgba(255,77,88,0.08)', borderBottom: '1px solid rgba(255,77,88,0.15)' }}>{error}</div>}
        {toast && <div style={{ padding: '8px 20px', fontSize: 12, color: '#3dffaa', background: 'rgba(61,255,170,0.06)', borderBottom: '1px solid rgba(61,255,170,0.12)' }}>{toast}</div>}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {loading && <div style={{ fontSize: 12, color: '#64748b' }}>Chargement…</div>}
          {!loading && agents.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: '#64748b', fontSize: 13 }}>
              <Bot size={28} style={{ opacity: 0.3, margin: '0 auto 12px' }} />
              <div>Aucun agent défini.</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>Crée ton premier agent pour automatiser des tâches.</div>
            </div>
          )}
          {agents.map(agent => {
            const typeInfo = types.find(t => t.key === agent.type);
            const isRunning = runningId === agent.id;
            return (
              <div key={agent.id} style={{ padding: '12px 14px', marginBottom: 8, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: `1px solid ${agent.active ? 'rgba(94,231,255,0.12)' : 'rgba(255,255,255,0.06)'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  {/* Active toggle */}
                  <button
                    type="button" title={agent.active ? 'Désactiver' : 'Activer'} onClick={() => handleToggleActive(agent)}
                    style={{ width: 28, height: 16, borderRadius: 8, border: 'none', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0,
                      background: agent.active ? 'rgba(61,255,170,0.5)' : 'rgba(255,255,255,0.1)' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
                      {typeInfo?.label ?? agent.type}
                      {agent.params.subject ? ` · ${agent.params.subject}` : ''}
                      {agent.trigger_type === 'scheduled' && agent.schedule ? ` · ${FREQ_LABELS[agent.schedule.frequency] ?? agent.schedule.frequency}` : ' · Manuel'}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button type="button" title="Historique" onClick={() => { setHistAgent(agent); setView('history'); }}
                      style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, cursor: 'pointer', padding: '3px 6px', color: '#64748b', display: 'flex' }}>
                      <Clock size={12} />
                    </button>
                    <button type="button" title="Modifier" onClick={() => { setEditAgent(agent); setView('edit'); }}
                      style={{ background: 'none', border: '1px solid rgba(94,231,255,0.2)', borderRadius: 5, cursor: 'pointer', padding: '3px 6px', color: '#5ee7ff', display: 'flex', fontSize: 11, fontFamily: 'monospace' }}>
                      ✎
                    </button>
                    <button type="button" title={isRunning ? 'En cours…' : 'Exécuter maintenant'} disabled={isRunning || !agent.active} onClick={() => handleRun(agent)}
                      style={{ background: isRunning ? 'rgba(61,255,170,0.04)' : 'rgba(61,255,170,0.08)', border: `1px solid ${isRunning ? 'rgba(61,255,170,0.1)' : 'rgba(61,255,170,0.25)'}`, borderRadius: 5, cursor: (isRunning || !agent.active) ? 'default' : 'pointer', padding: '3px 7px', color: (isRunning || !agent.active) ? '#3dffaa55' : '#3dffaa', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontFamily: 'monospace' }}>
                      <Play size={10} className={isRunning ? 'animate-pulse' : ''} />
                      {isRunning ? '…' : '▶'}
                    </button>
                    <button type="button" title="Supprimer" onClick={() => handleDelete(agent)}
                      style={{ background: 'none', border: '1px solid rgba(255,77,88,0.2)', borderRadius: 5, cursor: 'pointer', padding: '3px 6px', color: '#ff4d58', display: 'flex' }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                {agent.description && <div style={{ fontSize: 11, color: '#475569', marginLeft: 36 }}>{agent.description}</div>}
              </div>
            );
          })}
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#475569', fontFamily: 'monospace' }}>
            {agents.length}/10 agents
          </span>
          <button
            type="button" onClick={() => { setEditAgent(null); setError(null); setView('new'); }} disabled={agents.length >= 10}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: agents.length >= 10 ? 'default' : 'pointer', border: '1px solid rgba(94,231,255,0.25)', background: 'rgba(94,231,255,0.06)', color: agents.length >= 10 ? '#5ee7ff55' : '#5ee7ff', fontFamily: 'monospace' }}
          >
            <Plus size={12} /> Nouvel agent
          </button>
        </div>
      </>
    );
  }

  return (
    <div style={modalStyle} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panelStyle}>
        {view === 'list' && renderList()}

        {(view === 'new' || view === 'edit') && (
          <>
            {renderHeader(
              view === 'new' ? 'NOUVEL AGENT' : `MODIFIER — ${editAgent?.name ?? ''}`,
              true,
              () => { setView('list'); setEditAgent(null); setError(null); },
            )}
            {error && <div style={{ padding: '8px 20px', fontSize: 12, color: '#ff4d58', background: 'rgba(255,77,88,0.08)', borderBottom: '1px solid rgba(255,77,88,0.15)' }}>{error}</div>}
            {types.length > 0 && (
              <AgentForm
                types={types}
                initial={editAgent ? {
                  name:         editAgent.name,
                  description:  editAgent.description,
                  type:         editAgent.type,
                  params:       editAgent.params,
                  trigger_type: editAgent.trigger_type,
                  schedule:     editAgent.schedule,
                } : undefined}
                onSave={view === 'new' ? handleCreate : handleEdit}
                onCancel={() => { setView('list'); setEditAgent(null); setError(null); }}
                busy={formBusy}
              />
            )}
          </>
        )}

        {view === 'history' && histAgent && (
          <HistoryPanel agent={histAgent} onBack={() => { setView('list'); setHistAgent(null); }} />
        )}
      </div>
    </div>
  );
}
