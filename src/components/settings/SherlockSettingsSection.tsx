import { useEffect, useState, useCallback, useRef } from 'react';
import { UserSearch, RefreshCw, Download, Trash2, Search, ExternalLink, Plus, X } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { SherlockInstallState, SherlockSearchResult } from '../../lib/cortex/client';

const btnStyle: React.CSSProperties = {
  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
  borderRadius: 6, color: '#a78bfa', padding: '6px 12px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'monospace', display: 'inline-flex', alignItems: 'center', gap: 6,
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
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#e2e8f0', padding: '6px 10px', fontSize: 12, width: '100%',
  fontFamily: 'monospace', outline: 'none',
};

const STATUS_LABELS: Record<SherlockInstallState['status'], string> = {
  not_installed: 'Non installé',
  installed: 'Installé',
  error: 'Erreur',
};

// Paramètres → Sherlock OSINT (Phase 7, MASTER mission). Optional, local,
// user-installed tool (official https://github.com/sherlock-project/sherlock,
// MIT). Recherche par nom d'utilisateur public uniquement — jamais de
// cookie/mot de passe/compte privé/contournement d'authentification.
export function SherlockSettingsSection() {
  const [state, setState] = useState<SherlockInstallState | null>(null);
  const [busy, setBusy] = useState(false);
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [searchJobId, setSearchJobId] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const [results, setResults] = useState<SherlockSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try { setState(await cortexClient.getSherlockStatus()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  function pollJob(jobId: string, onDone: (job: Awaited<ReturnType<typeof cortexClient.getSherlockJob>>) => void) {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const job = await cortexClient.getSherlockJob(jobId);
        if (job.status !== 'running') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          onDone(job);
        }
      } catch {
        if (pollRef.current) window.clearInterval(pollRef.current);
      }
    }, 700);
  }

  async function handleInstall() {
    setBusy(true);
    setInstallMessage(null);
    try {
      const { jobId } = await cortexClient.installSherlock();
      setInstallJobId(jobId);
      pollJob(jobId, (job) => {
        setInstallJobId(null);
        setBusy(false);
        setInstallMessage(job.status === 'done' ? 'Sherlock installé avec succès.' : (job.summary?.error ?? 'Échec de l\'installation.'));
        void reload();
      });
    } catch (e) {
      setBusy(false);
      setInstallMessage((e as Error).message);
    }
  }

  async function handleUninstall() {
    if (!confirm('Désinstaller Sherlock OSINT ?')) return;
    setBusy(true);
    setInstallMessage(null);
    try {
      const { jobId } = await cortexClient.uninstallSherlock();
      pollJob(jobId, (job) => {
        setBusy(false);
        setInstallMessage(job.status === 'done' ? 'Sherlock désinstallé.' : (job.summary?.error ?? 'Échec de la désinstallation.'));
        void reload();
      });
    } catch (e) {
      setBusy(false);
      setInstallMessage((e as Error).message);
    }
  }

  async function handleTest() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await cortexClient.testSherlockInstall();
      setTestResult(r.installed ? `✓ Fonctionnel (${r.version ?? 'version inconnue'})` : '✕ Non détecté');
      void reload();
    } catch (e) {
      setTestResult(`Erreur : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSearch() {
    const u = username.trim();
    if (!u) return;
    setSearchError(null);
    setResults(null);
    setSearchStatus('running');
    try {
      const { jobId } = await cortexClient.searchSherlock(u);
      setSearchJobId(jobId);
      pollJob(jobId, (job) => {
        setSearchJobId(null);
        setSearchStatus(job.status);
        if (job.status === 'done') setResults(job.summary?.results ?? []);
        else setSearchError(job.summary?.error ?? 'Recherche interrompue.');
      });
    } catch (e) {
      setSearchStatus(null);
      setSearchError((e as Error).message);
    }
  }

  async function handleCancelSearch() {
    if (!searchJobId) return;
    await cortexClient.cancelSherlockSearch(searchJobId);
  }

  async function handleSaveAsNeuron(r: SherlockSearchResult) {
    try {
      await cortexClient.saveSherlockResultAsNeuron(username.trim(), r.site, r.url);
      setResults(prev => prev?.filter(x => x.url !== r.url) ?? null);
    } catch { /* leave the result visible so the user can retry */ }
  }

  function handleIgnore(r: SherlockSearchResult) {
    setResults(prev => prev?.filter(x => x.url !== r.url) ?? null);
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3 rounded" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <span className="font-grotesk font-semibold text-xs flex items-center gap-1.5" style={{ color: '#f0eaff' }}>
        <UserSearch size={12} /> Sherlock OSINT
      </span>
      <p className="font-mono" style={{ fontSize: 10, color: '#5a4a7a', lineHeight: 1.6 }}>
        Outil officiel <a href="https://github.com/sherlock-project/sherlock" target="_blank" rel="noopener noreferrer" style={{ color: '#5ee7ff' }}>sherlock-project</a> (MIT),
        exécuté localement. Recherche uniquement par nom d'utilisateur public sur des sites tiers —
        jamais de cookie, mot de passe, compte privé, force brute ni contournement de CAPTCHA/authentification.
        Non installé par défaut ; installation déclenchée uniquement par toi ci-dessous.
      </p>

      {state && (
        <p className="font-mono text-xs" style={{ color: state.status === 'installed' ? '#3dffaa' : state.status === 'error' ? '#ff4d58' : '#94a3b8' }}>
          État : {STATUS_LABELS[state.status]}{state.version ? ` (${state.version})` : ''}
          {state.lastError && <span style={{ color: '#ff4d58' }}> — {state.lastError}</span>}
        </p>
      )}

      <div className="flex gap-2 flex-wrap">
        {state?.status !== 'installed' ? (
          <button type="button" onClick={handleInstall} disabled={busy} style={btnStyle}>
            {installJobId ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />} Installer
          </button>
        ) : (
          <button type="button" onClick={handleUninstall} disabled={busy} style={btnDangerStyle}>
            <Trash2 size={11} /> Désinstaller
          </button>
        )}
        <button type="button" onClick={handleTest} disabled={busy} style={btnGhostStyle}>
          Tester
        </button>
      </div>
      {installMessage && <p className="font-mono text-xs" style={{ color: '#94a3b8' }}>{installMessage}</p>}
      {testResult && <p className="font-mono text-xs" style={{ color: '#94a3b8' }}>{testResult}</p>}

      {state?.status === 'installed' && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10, marginTop: 4 }}>
          <p className="font-mono mb-2" style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.05em' }}>RECHERCHE OSINT</p>
          <div className="flex gap-2">
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && searchStatus !== 'running' && handleSearch()}
              placeholder="Nom d'utilisateur public…"
              style={inputStyle}
            />
            {searchStatus === 'running' ? (
              <button type="button" onClick={handleCancelSearch} style={btnDangerStyle}><X size={11} /> Annuler</button>
            ) : (
              <button type="button" onClick={handleSearch} disabled={!username.trim()} style={btnStyle}><Search size={11} /> Rechercher</button>
            )}
          </div>

          {searchStatus === 'running' && <p className="font-mono text-xs mt-2" style={{ color: '#94a3b8' }}><RefreshCw size={11} className="animate-spin" style={{ display: 'inline', marginRight: 4 }} /> Recherche en cours…</p>}
          {searchError && <p className="font-mono text-xs mt-2" style={{ color: '#ff4d58' }}>{searchError}</p>}

          {results && (
            <div className="mt-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {results.length === 0 ? (
                <p className="font-mono text-xs" style={{ color: '#3d3060' }}>Aucun résultat trouvé.</p>
              ) : results.map(r => (
                <div key={r.url} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded mb-1" style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <span className="font-mono truncate" style={{ fontSize: 11, color: '#c0b0e0' }}>{r.site}</span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button type="button" onClick={() => window.open(r.url, '_blank', 'noopener,noreferrer')} title="Ouvrir" style={{ background: 'none', border: 'none', color: '#5ee7ff', cursor: 'pointer' }}>
                      <ExternalLink size={12} />
                    </button>
                    <button type="button" onClick={() => handleSaveAsNeuron(r)} title="Créer neurone" style={{ background: 'none', border: 'none', color: '#3dffaa', cursor: 'pointer' }}>
                      <Plus size={12} />
                    </button>
                    <button type="button" onClick={() => handleIgnore(r)} title="Ignorer" style={{ background: 'none', border: 'none', color: '#3d3060', cursor: 'pointer' }}>
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
