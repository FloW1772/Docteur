import { useEffect, useState } from 'react';
import { Eye, EyeOff, Save, Trash2, RefreshCw } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12, width: '100%',
  fontFamily: 'monospace', outline: 'none',
};
const btnGhostStyle: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6, color: '#94a3b8', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
};

// Paramètres → IA → Notebook → NotebookLM/Google (Phase 5B, MASTER mission).
// A key saved here makes ZERO calls to Google — see routes/notebooklm.js.
// This section exists purely to prepare for a possible future integration.
export function NotebookLmSettingsSection() {
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cortexClient.getNotebookLmStatus()
      .then(r => setKeyConfigured(r.key_configured))
      .catch(e => setError((e as Error).message));
  }, []);

  async function handleSave() {
    if (!keyDraft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const r = await cortexClient.saveNotebookLmKey(keyDraft.trim());
      setKeyConfigured(r.key_configured);
      setKeyDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setError(null);
    try {
      const r = await cortexClient.deleteNotebookLmKey();
      setKeyConfigured(r.key_configured);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <span className="font-grotesk font-semibold text-xs" style={{ color: '#f0eaff' }}>
        📓 NotebookLM / Google — préparation future
      </span>
      <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.6 }}>
        Le Notebook local de Docteur fonctionne entièrement sans Google. Cette section permet
        seulement d'enregistrer par avance une clé API NotebookLM pour une intégration
        future — <strong style={{ color: '#a78bfa' }}>aucun appel à l'API NotebookLM n'est
        effectué actuellement</strong>, même si une clé est enregistrée ici.
      </p>

      {error && <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error}</p>}

      {keyConfigured === null ? (
        <RefreshCw size={12} className="animate-spin" style={{ color: '#3d3060' }} />
      ) : keyConfigured ? (
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs" style={{ color: '#3dffaa' }}>✓ Clé enregistrée (jamais utilisée pour un appel)</span>
          <button type="button" onClick={handleDelete} disabled={saving} style={btnGhostStyle}>
            <Trash2 size={11} /> Supprimer
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyDraft}
              onChange={e => setKeyDraft(e.target.value)}
              placeholder="Clé API NotebookLM (Google)…"
              style={{ ...inputStyle, paddingRight: 30 }}
            />
            <button type="button" onClick={() => setShowKey(v => !v)} style={{ position: 'absolute', right: 6, top: 6, background: 'none', border: 'none', color: '#5a4a7a', cursor: 'pointer' }}>
              {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
          <button type="button" onClick={handleSave} disabled={saving || !keyDraft.trim()} style={btnGhostStyle}>
            <Save size={11} /> Enregistrer
          </button>
        </div>
      )}
    </div>
  );
}
