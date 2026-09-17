import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Trash2, Eye, RotateCcw, Lock } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { MemorySettings, MemoryItemsResult, MemoryItem } from '../../lib/cortex/client';

const sectionLabelStyle: React.CSSProperties = { fontFamily: 'monospace', fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' };
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
};
const btnGhostStyle: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const btnDangerStyle: React.CSSProperties = {
  background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
  borderRadius: 6, color: '#f87171', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div style={rowStyle}>
      <div>
        <div className="font-mono text-xs" style={{ color: '#e2e8f0' }}>{label}</div>
        {hint && <div className="font-mono text-xs mt-0.5" style={{ color: '#5a4a7a' }}>{hint}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        style={{
          width: 36, height: 20, borderRadius: 10, position: 'relative', cursor: 'pointer',
          background: checked ? 'rgba(61,255,170,0.25)' : 'rgba(255,255,255,0.08)',
          border: `1px solid ${checked ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.15)'}`,
        }}
      >
        <span style={{
          position: 'absolute', top: 1, left: checked ? 17 : 1, width: 16, height: 16, borderRadius: 8,
          background: checked ? '#3dffaa' : '#8a7fae', transition: 'left 0.15s',
        }} />
      </button>
    </div>
  );
}

const BUDGET_LABELS: Record<MemorySettings['budget'], string> = { low: 'Faible', normal: 'Normal', extended: 'Étendu' };

function MemoryItemRow({ item, onDelete }: { item: MemoryItem; onDelete: () => void }) {
  return (
    <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="font-mono text-xs" style={{ color: '#e2e8f0', wordBreak: 'break-word' }}>
          {item.privacy && <Lock size={10} style={{ display: 'inline', marginRight: 4, color: '#f87171' }} />}
          {item.text}
        </div>
        <div className="font-mono text-xs mt-0.5" style={{ color: '#5a4a7a' }}>
          {item.tier === 'long_term' ? 'Profil long-terme' : 'Épisodique'} · {item.category} · utilisée {item.usage_count}× · {item.egress_policy === 'local_only' ? 'local uniquement' : 'cloud autorisé'}
        </div>
      </div>
      <button type="button" onClick={onDelete} style={{ ...btnGhostStyle, padding: '4px 8px', marginLeft: 8 }}>
        <Trash2 size={11} />
      </button>
    </div>
  );
}

export function MemorySettingsTab() {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [items, setItems] = useState<MemoryItemsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [showItems, setShowItems] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([cortexClient.getMemorySettings(), cortexClient.getMemoryItems()]);
      setSettings(s);
      setItems(i);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function updateSetting(patch: Partial<MemorySettings>) {
    if (!settings) return;
    const optimistic = { ...settings, ...patch };
    setSettings(optimistic);
    try {
      const saved = await cortexClient.updateMemorySettings(patch);
      setSettings(saved);
      // Budget limits (shown via items.budget) depend on the saved setting —
      // refresh so "Actuel : jusqu'à N mémoires…" reflects the new level
      // immediately instead of the stale value from the initial load.
      if (patch.budget) {
        const freshItems = await cortexClient.getMemoryItems();
        setItems(freshItems);
      }
    } catch (e) {
      setError((e as Error).message);
      void reload();
    }
  }

  async function handleDelete(tier: 'long_term' | 'episodic', id: string) {
    try {
      await cortexClient.deleteMemoryItem(tier, id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleReset() {
    try {
      await cortexClient.resetAdaptiveMemory();
      setConfirmingReset(false);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="animate-spin" style={{ color: '#3d3060' }} />
      </div>
    );
  }

  if (!settings || !items) {
    return <p className="font-mono text-xs p-4" style={{ color: '#ff4d58' }}>{error ?? 'Erreur de chargement'}</p>;
  }

  return (
    <div className="p-4" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error}</p>}

      <div>
        <div style={sectionLabelStyle}>MÉMOIRE / CONTEXTE</div>
        <p className="font-mono text-xs mt-2 mb-2" style={{ color: '#5a4a7a', lineHeight: 1.6 }}>
          Docteur peut apprendre progressivement de tes recherches, neurones et corrections —
          100% local (règles + Ollama), jamais envoyé à un provider cloud pour décider quoi
          retenir. Une mémoire extraite d'une source privée (OneDrive/YouTube privé, CV,
          neurone privé, OSINT) reste toujours locale, même si l'apprentissage est actif.
        </p>
        <Toggle checked={settings.enabled} onChange={(v) => updateSetting({ enabled: v })} label="Apprentissage contextuel local" hint="Interrupteur général — désactive les 3 sources ci-dessous si coupé" />
        <Toggle checked={settings.learn_from_searches} onChange={(v) => updateSetting({ learn_from_searches: v })} label="Apprendre de mes recherches" />
        <Toggle checked={settings.learn_from_neurons} onChange={(v) => updateSetting({ learn_from_neurons: v })} label="Apprendre de mes neurones" />
        <Toggle checked={settings.learn_from_corrections} onChange={(v) => updateSetting({ learn_from_corrections: v })} label="Apprendre de mes corrections" />
      </div>

      <div style={{ borderTop: '1px solid rgba(61,255,170,0.08)', paddingTop: 16 }}>
        <div style={sectionLabelStyle}>BUDGET DE CONTEXTE</div>
        <p className="font-mono text-xs mt-2 mb-2" style={{ color: '#5a4a7a' }}>
          Nombre maximum de mémoires injectées par question (jamais toute la mémoire à la fois).
        </p>
        <div className="flex gap-2">
          {(['low', 'normal', 'extended'] as const).map(b => (
            <button
              key={b}
              type="button"
              onClick={() => updateSetting({ budget: b })}
              className="font-mono text-xs px-3 py-1.5 rounded"
              style={{
                background: settings.budget === b ? 'rgba(61,255,170,0.12)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${settings.budget === b ? 'rgba(61,255,170,0.35)' : 'rgba(255,255,255,0.1)'}`,
                color: settings.budget === b ? '#3dffaa' : '#94a3b8',
              }}
            >
              {BUDGET_LABELS[b]}
            </button>
          ))}
        </div>
        <p className="font-mono text-xs mt-2" style={{ color: '#5a4a7a' }}>
          Actuel : jusqu'à {items.budget.maxMemories} mémoires et {items.budget.maxChunks} extraits par question.
        </p>
      </div>

      <div style={{ borderTop: '1px solid rgba(61,255,170,0.08)', paddingTop: 16 }}>
        <div className="flex items-center justify-between mb-2">
          <div style={sectionLabelStyle}>
            MÉMOIRE ACTUELLE ({items.long_term.length + items.episodic.length} / {items.episodic_total} épisodiques au total)
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowItems(v => !v)} style={btnGhostStyle}>
              <Eye size={11} /> {showItems ? 'Masquer' : 'Voir la mémoire'}
            </button>
            {confirmingReset ? (
              <>
                <button type="button" onClick={handleReset} style={btnDangerStyle}>Confirmer la réinitialisation</button>
                <button type="button" onClick={() => setConfirmingReset(false)} style={btnGhostStyle}>Annuler</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmingReset(true)} style={btnGhostStyle}>
                <RotateCcw size={11} /> Réinitialiser mémoire adaptative
              </button>
            )}
          </div>
        </div>
        <p className="font-mono text-xs mb-2" style={{ color: '#5a4a7a' }}>
          La réinitialisation efface la mémoire épisodique (apprise automatiquement) mais
          conserve tes faits enregistrés manuellement dans les préférences de conversation.
        </p>
        {showItems && (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {items.long_term.length === 0 && items.episodic.length === 0 ? (
              <p className="font-mono text-xs py-4 text-center" style={{ color: '#3d3060' }}>Aucune mémoire enregistrée pour l'instant.</p>
            ) : (
              <>
                {items.long_term.map(item => (
                  <MemoryItemRow key={item.id} item={item} onDelete={() => handleDelete('long_term', item.id)} />
                ))}
                {items.episodic.map(item => (
                  <MemoryItemRow key={item.id} item={item} onDelete={() => handleDelete('episodic', item.id)} />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
