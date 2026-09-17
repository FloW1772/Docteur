import { useEffect, useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { InstalledBrowser } from '../../lib/cortex/client';

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

// Paramètres → Navigateur (Phase 6, MASTER mission). Docteur is a web app,
// not a desktop app — this choice controls which browser the BACKEND spawns
// to open external links (e.g. documentation URLs), independent of whatever
// browser is currently displaying Docteur itself.
export function BrowserSettingsSection() {
  const [browsers, setBrowsers] = useState<InstalledBrowser[] | null>(null);
  const [selected, setSelected] = useState<string>('system');
  const [customPath, setCustomPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([cortexClient.getInstalledBrowsers(), cortexClient.getBrowserSettings()])
      .then(([b, s]) => {
        setBrowsers(b.browsers);
        setSelected(s.selected);
        if (s.customPath) setCustomPath(s.customPath);
      })
      .catch(e => setError((e as Error).message));
  }, []);

  async function handleSelect(id: string) {
    if (id === 'custom') { setSelected('custom'); return; }
    setSaving(true);
    setError(null);
    try {
      const s = await cortexClient.updateBrowserSettings(id);
      setSelected(s.selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveCustomPath() {
    if (!customPath.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const s = await cortexClient.updateBrowserSettings('custom', customPath.trim());
      setSelected(s.selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <span className="font-grotesk font-semibold text-xs flex items-center gap-1.5" style={{ color: '#f0eaff' }}>
        <Globe size={12} /> Navigateur
      </span>
      <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.6 }}>
        Navigateur utilisé pour ouvrir les liens externes (documentation, etc.) depuis
        Docteur — indépendant du navigateur dans lequel Docteur s'affiche lui-même.
      </p>

      {error && <p className="font-mono text-xs" style={{ color: '#ff4d58' }}>{error}</p>}

      {browsers === null ? (
        <RefreshCw size={12} className="animate-spin" style={{ color: '#3d3060' }} />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {browsers.map(b => (
              <button
                key={b.id}
                type="button"
                disabled={saving}
                onClick={() => handleSelect(b.id)}
                className="font-mono px-2.5 py-1.5 rounded"
                style={{
                  fontSize: 10, color: selected === b.id ? '#3dffaa' : '#94a3b8',
                  border: `1px solid ${selected === b.id ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.1)'}`,
                  background: 'rgba(255,255,255,0.03)', cursor: saving ? 'default' : 'pointer',
                }}
              >
                {b.label}
              </button>
            ))}
            <button
              type="button"
              disabled={saving}
              onClick={() => handleSelect('custom')}
              className="font-mono px-2.5 py-1.5 rounded"
              style={{
                fontSize: 10, color: selected === 'custom' ? '#3dffaa' : '#94a3b8',
                border: `1px solid ${selected === 'custom' ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.1)'}`,
                background: 'rgba(255,255,255,0.03)', cursor: saving ? 'default' : 'pointer',
              }}
            >
              Personnalisé…
            </button>
          </div>

          {selected === 'custom' && (
            <div className="flex gap-2 mt-1">
              <input
                value={customPath}
                onChange={e => setCustomPath(e.target.value)}
                placeholder="Chemin absolu vers l'exécutable .exe…"
                style={inputStyle}
              />
              <button type="button" onClick={handleSaveCustomPath} disabled={saving || !customPath.trim()} style={btnGhostStyle}>
                Enregistrer
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
