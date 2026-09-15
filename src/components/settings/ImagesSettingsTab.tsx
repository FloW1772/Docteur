import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, RefreshCw, Download, Play, Square, Trash2, FolderOpen, Link2, Unlink, XCircle } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { ImageGenProvidersStatus, ImageGenSettingsResult, ComfyUiInstallState, ImageModelCatalogEntry, ComfyUiReleaseInfo, ServerJob } from '../../lib/cortex/client';

const sectionLabelStyle: React.CSSProperties = { fontFamily: 'monospace', fontSize: 10, color: '#3d3060', letterSpacing: '0.1em' };
const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
};
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

const INSTALL_STATUS_LABELS: Record<ComfyUiInstallState['status'], string> = {
  not_installed: 'Non installé',
  installed:     'Installé',
  stopped:       'Arrêté',
  starting:      'Démarrage…',
  running:       'Prêt',
  incomplete:    'Installation incomplète',
  error:         'Erreur',
};

const CLOUD_KEY_FIELDS: Array<{ id: 'cloudflare_account_id' | 'cloudflare_api_token' | 'huggingface_token' | 'pollinations_key'; label: string; group: string }> = [
  { id: 'cloudflare_account_id', label: 'Account ID', group: 'Cloudflare' },
  { id: 'cloudflare_api_token',  label: 'API Token',  group: 'Cloudflare' },
  { id: 'huggingface_token',     label: 'Token',       group: 'Hugging Face' },
  { id: 'pollinations_key',      label: 'API Key',     group: 'Pollinations' },
];

export function ImagesSettingsTab({ strictLocalMode }: { strictLocalMode: boolean }) {
  const [status, setStatus] = useState<ImageGenProvidersStatus | null>(null);
  const [settings, setSettings] = useState<ImageGenSettingsResult | null>(null);
  const [catalog, setCatalog] = useState<ImageModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [existingPath, setExistingPath] = useState('');
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [deleteModelsOnUninstall, setDeleteModelsOnUninstall] = useState(false);
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  const [installJob, setInstallJob] = useState<ServerJob | null>(null);
  const [modelJobId, setModelJobId] = useState<string | null>(null);
  const [modelJob, setModelJob] = useState<ServerJob | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, gs, c] = await Promise.all([
        cortexClient.getImageGenProvidersStatus(),
        cortexClient.getImageGenSettings(),
        cortexClient.getImageModelCatalog(),
      ]);
      setStatus(s);
      setSettings(gs);
      setCatalog(c.catalog ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const install = status?.providers.comfyui;
  // install state (kind/path/pid) is derived from the install-manager, not
  // from getComfyUiStatus — fetch it separately for lifecycle actions.
  const [installState, setInstallState] = useState<ComfyUiInstallState | null>(null);
  const [defaultManagedPath, setDefaultManagedPath] = useState<string>('');
  const [release, setRelease] = useState<ComfyUiReleaseInfo | null>(null);
  const reloadInstall = useCallback(async () => {
    try {
      const r = await cortexClient.getComfyUiInstall();
      setInstallState(r.install);
      setDefaultManagedPath(r.defaultManagedPath);
      setRelease(r.release);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void reloadInstall(); }, [reloadInstall]);

  // Poll job progress + install/status while an install/download is active,
  // or while ComfyUI is starting (waiting for the endpoint to answer).
  useEffect(() => {
    const active = installJobId || modelJobId || installState?.status === 'starting';
    if (!active) return;
    const timer = window.setInterval(async () => {
      try {
        const jobs = await cortexClient.getJobs();
        if (installJobId) {
          const j = jobs.find(x => x.id === installJobId) ?? null;
          setInstallJob(j);
          if (!j || j.status !== 'running') { setInstallJobId(null); await Promise.all([reload(), reloadInstall()]); }
        }
        if (modelJobId) {
          const j = jobs.find(x => x.id === modelJobId) ?? null;
          setModelJob(j);
          if (!j || j.status !== 'running') { setModelJobId(null); await reload(); }
        }
        if (installState?.status === 'starting') {
          await reloadInstall();
        }
      } catch { /* ignore transient poll errors */ }
    }, 800);
    return () => window.clearInterval(timer);
  }, [installJobId, modelJobId, installState?.status, reload, reloadInstall]);

  async function handleConfirmInstall() {
    setBusy(true);
    try {
      const r = await cortexClient.startComfyUiInstall();
      setInstallJobId(r.jobId);
      setConfirmingInstall(false);
      await Promise.all([reload(), reloadInstall()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelInstall() {
    if (!installJobId) return;
    try {
      await cortexClient.cancelComfyUiInstall(installJobId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleUseExisting() {
    if (!existingPath.trim()) return;
    setBusy(true);
    try {
      await cortexClient.useExistingComfyUiInstall(existingPath.trim());
      setExistingPath('');
      await Promise.all([reload(), reloadInstall()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDetach() {
    setBusy(true);
    try {
      await cortexClient.detachComfyUiInstall();
      await Promise.all([reload(), reloadInstall()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStartStop() {
    setBusy(true);
    try {
      if (installState?.status === 'running') await cortexClient.stopComfyUi();
      else await cortexClient.startComfyUi();
      await Promise.all([reload(), reloadInstall()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleUninstall() {
    setBusy(true);
    try {
      await cortexClient.uninstallComfyUi(deleteModelsOnUninstall);
      setConfirmingUninstall(false);
      await Promise.all([reload(), reloadInstall()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(id: string) {
    const value = keyDrafts[id] ?? '';
    if (!value) return;
    try {
      await cortexClient.setImageCloudKey(id, value);
      setKeyDrafts(d => ({ ...d, [id]: '' }));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeKey(id: string) {
    try {
      await cortexClient.setImageCloudKey(id, null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function updateSettings(updates: Partial<{ priority: 'local' | 'cloud'; free_cloud_only: boolean }>) {
    try {
      const r = await cortexClient.setImageGenSettings(updates);
      setSettings(s => s ? { ...s, settings: { ...s.settings, ...r.settings } } : s);
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

  const groupedByCloud: Record<string, typeof CLOUD_KEY_FIELDS> = {};
  for (const field of CLOUD_KEY_FIELDS) {
    (groupedByCloud[field.group] ??= []).push(field);
  }

  return (
    <div className="px-5 py-4 flex flex-col gap-5">
      {error && (
        <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.4)', color: '#f87171', fontSize: 11 }}>{error}</div>
      )}

      {/* ── A. IA locale — ComfyUI ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <p style={sectionLabelStyle}>IA LOCALE — COMFYUI</p>
        <div style={cardStyle}>
          <div className="flex items-center gap-2">
            <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>ComfyUI local</span>
            <span className="font-mono px-1.5 py-0.5 rounded" style={{
              fontSize: 9, letterSpacing: '0.08em',
              background: install?.available ? 'rgba(61,255,170,0.1)' : 'rgba(248,113,113,0.1)',
              color: install?.available ? '#3dffaa' : '#f87171',
              border: `1px solid ${install?.available ? 'rgba(61,255,170,0.2)' : 'rgba(248,113,113,0.2)'}`,
            }}>
              {installState ? INSTALL_STATUS_LABELS[installState.status] : '—'}
            </span>
          </div>

          <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Version : {install?.version ?? '—'}</span>
            <span>Chemin : {installState?.path ?? '—'}</span>
            <span>Endpoint : {install?.endpoint ?? '—'}</span>
            <span>GPU : {install?.gpu && install.gpu.length > 0 ? install.gpu.map(g => g.name).join(', ') : '—'}</span>
            <span>VRAM : {install?.gpu && install.gpu.length > 0 && install.gpu[0].vramFreeMb != null ? `${install.gpu[0].vramFreeMb} Mo libres / ${install.gpu[0].vramTotalMb} Mo` : '—'}</span>
            <span>Modèles détectés : {install?.checkpoints?.length ?? 0}</span>
          </div>

          {installState?.lastError && (
            <p style={{ fontSize: 11, color: '#f87171' }}>Dernière erreur : {installState.lastError}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {installState?.kind === 'none' && !confirmingInstall && !installJobId && (
              <button type="button" style={btnStyle} onClick={() => setConfirmingInstall(true)}>
                <Download size={12} /> Télécharger / Installer ComfyUI
              </button>
            )}
            {installState?.kind !== 'managed' && !installJobId && (
              <>
                <input
                  style={{ ...inputStyle, width: 220 }}
                  placeholder="Chemin d'une installation existante"
                  value={existingPath}
                  onChange={e => setExistingPath(e.target.value)}
                />
                <button type="button" style={btnGhostStyle} onClick={handleUseExisting} disabled={busy || !existingPath.trim()}>
                  <Link2 size={12} /> Utiliser une installation existante
                </button>
              </>
            )}
            {installState && installState.kind !== 'none' && !installJobId && (
              <>
                <button type="button" style={btnStyle} onClick={handleStartStop} disabled={busy || installState.status === 'starting'}>
                  {installState.status === 'running' ? <Square size={12} /> : <Play size={12} />}
                  {installState.status === 'running' ? 'Arrêter' : installState.status === 'starting' ? 'Démarrage…' : 'Démarrer'}
                </button>
                <button type="button" style={btnGhostStyle} disabled title="Ouvrir le dossier (bientôt)">
                  <FolderOpen size={12} /> Ouvrir le dossier
                </button>
              </>
            )}
            {installState?.kind === 'external' && !installJobId && (
              <button type="button" style={btnGhostStyle} onClick={handleDetach} disabled={busy}>
                <Unlink size={12} /> Dissocier
              </button>
            )}
            {installState?.kind === 'managed' && !confirmingUninstall && !installJobId && (
              <button type="button" style={btnDangerStyle} onClick={() => setConfirmingUninstall(true)}>
                <Trash2 size={12} /> Désinstaller ComfyUI
              </button>
            )}
          </div>

          {installJob && (
            <div style={{ ...cardStyle, borderColor: 'rgba(167,139,250,0.3)' }}>
              <p style={{ fontSize: 11, color: '#e2e8f0' }}>{installJob.currentLabel || 'Installation…'}</p>
              <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                <div style={{ width: `${installJob.current}%`, background: '#a78bfa', height: '100%' }} />
              </div>
              <button type="button" style={btnGhostStyle} onClick={handleCancelInstall}>
                <XCircle size={12} /> Annuler
              </button>
            </div>
          )}

          {confirmingInstall && (
            <div style={{ ...cardStyle, borderColor: 'rgba(167,139,250,0.3)' }}>
              <p style={{ fontSize: 11, color: '#e2e8f0' }}>
                Docteur va télécharger et installer ComfyUI localement. Aucun modèle de plusieurs Go ne sera téléchargé automatiquement.
              </p>
              {release && (
                <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>Source : {release.url}</span>
                  <span>Version : {release.tag}</span>
                  <span>Taille approximative : {(release.approxSizeBytes / 1024 / 1024 / 1024).toFixed(1)} Go</span>
                  <span style={{ color: '#f59e0b' }}>
                    {release.checksum ? `Checksum : ${release.checksum}` : 'Aucun checksum/signature publié par le projet ComfyUI pour cet asset — l\'intégrité n\'est vérifiée que par la taille du téléchargement.'}
                  </span>
                </div>
              )}
              <p style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>Destination : {defaultManagedPath}</p>
              <div className="flex gap-2">
                <button type="button" style={btnStyle} onClick={handleConfirmInstall} disabled={busy}>Installer</button>
                <button type="button" style={btnGhostStyle} onClick={() => setConfirmingInstall(false)} disabled={busy}>Annuler</button>
              </div>
            </div>
          )}

          {confirmingUninstall && (
            <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.3)' }}>
              <p style={{ fontSize: 11, color: '#e2e8f0' }}>Désinstaller ComfyUI ? Les images générées et les paramètres sont toujours conservés.</p>
              <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={deleteModelsOnUninstall} onChange={e => setDeleteModelsOnUninstall(e.target.checked)} />
                Supprimer également les modèles
              </label>
              <div className="flex gap-2">
                <button type="button" style={btnDangerStyle} onClick={handleUninstall} disabled={busy}>Confirmer la désinstallation</button>
                <button type="button" style={btnGhostStyle} onClick={() => setConfirmingUninstall(false)} disabled={busy}>Annuler</button>
              </div>
            </div>
          )}

          {install?.available && install.hasCompatibleModel === false && (
            <p style={{ fontSize: 11, color: '#fbbf24' }}>ComfyUI fonctionne mais aucun modèle compatible n'a été détecté.</p>
          )}
        </div>
      </div>

      {/* ── B. Modèles locaux ────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <p style={sectionLabelStyle}>MODÈLES LOCAUX</p>
        <div style={cardStyle}>
          {(install?.checkpoints ?? []).length === 0 && (
            <p style={{ fontSize: 11, color: '#94a3b8' }}>
              {install?.available ? 'Aucun modèle installé.' : 'ComfyUI doit être installé et démarré pour détecter les modèles.'}
            </p>
          )}
          {(install?.checkpoints ?? []).map(ckpt => (
            <div key={ckpt} className="flex items-center gap-2" style={{ fontSize: 11, color: '#e2e8f0', fontFamily: 'monospace' }}>
              <span className="flex-1">{ckpt}</span>
              <button
                type="button" style={btnDangerStyle}
                onClick={() => {
                  if (!window.confirm(`Supprimer ce modèle local (${ckpt}) ?`)) return;
                  cortexClient.deleteImageModel(ckpt).then(reload).catch(e => setError((e as Error).message));
                }}
              >
                <Trash2 size={12} /> Supprimer
              </button>
            </div>
          ))}
          <p style={{ fontSize: 10, color: '#3d3060', letterSpacing: '0.1em', marginTop: 4 }}>CATALOGUE DE MODÈLES (vérifiés)</p>
          {catalog.length === 0 && (
            <p style={{ fontSize: 11, color: '#94a3b8' }}>Aucun modèle recommandé configuré.</p>
          )}
          {catalog.map(m => (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#e2e8f0' }}>
              <div className="flex items-center gap-2">
                <span className="flex-1">{m.name} — {m.approxSizeGb} Go — VRAM conseillée {m.recommendedVramGb ?? '—'} Go</span>
                <button
                  type="button" style={btnStyle}
                  disabled={!!modelJobId}
                  onClick={() => cortexClient.downloadImageModel(m.id).then(r => setModelJobId(r.jobId)).catch(e => setError((e as Error).message))}
                >
                  <Download size={12} /> Télécharger
                </button>
              </div>
              <p style={{ fontSize: 10, color: '#94a3b8' }}>Source : {m.source} · Licence : {m.license ?? '—'}</p>
            </div>
          ))}
          {modelJob && (
            <div style={{ ...cardStyle, borderColor: 'rgba(167,139,250,0.3)' }}>
              <p style={{ fontSize: 11, color: '#e2e8f0' }}>{modelJob.currentLabel || 'Téléchargement…'}</p>
              <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                <div style={{ width: `${modelJob.current}%`, background: '#a78bfa', height: '100%' }} />
              </div>
              {modelJobId && (
                <button type="button" style={btnGhostStyle} onClick={() => cortexClient.cancelImageModelDownload(modelJobId).catch(e => setError((e as Error).message))}>
                  <XCircle size={12} /> Annuler
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── C. Fournisseurs cloud ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <p style={sectionLabelStyle}>FOURNISSEURS CLOUD</p>
        {strictLocalMode && (
          <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.3)', color: '#f87171', fontSize: 11 }}>
            Strict Local actif — fournisseurs cloud bloqués.
          </div>
        )}
        {Object.entries(groupedByCloud).map(([group, fields]) => {
          const providerId = group === 'Cloudflare' ? 'cloudflare' : group === 'Hugging Face' ? 'huggingface' : 'pollinations';
          const providerStatus = status?.providers[providerId as 'cloudflare' | 'huggingface' | 'pollinations'];
          return (
            <div key={group} style={cardStyle}>
              <div className="flex items-center gap-2">
                <span className="font-grotesk font-semibold text-xs flex-1" style={{ color: '#f0eaff' }}>{group}</span>
                <span className="font-mono px-1.5 py-0.5 rounded" style={{
                  fontSize: 9, letterSpacing: '0.08em',
                  background: providerStatus?.configured ? 'rgba(61,255,170,0.1)' : 'rgba(255,255,255,0.05)',
                  color: providerStatus?.configured ? '#3dffaa' : '#3d3060',
                  border: `1px solid ${providerStatus?.configured ? 'rgba(61,255,170,0.2)' : 'rgba(255,255,255,0.08)'}`,
                }}>
                  {providerStatus?.configured ? 'CONFIGURÉ' : 'NON CONFIGURÉ'}
                </span>
                <span className="font-mono px-1.5 py-0.5 rounded" style={{ fontSize: 9, background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.2)' }}>
                  {providerStatus?.classification === 'free_tier' ? 'FREE TIER' : providerStatus?.classification === 'credit' ? 'CRÉDIT' : 'QUOTA'}
                </span>
              </div>
              {providerStatus?.freeTierNote && (
                <p style={{ fontSize: 10, color: '#94a3b8' }}>{providerStatus.freeTierNote}</p>
              )}
              {providerStatus?.billingCaveat && (
                <p style={{ fontSize: 10, color: '#f59e0b' }}>{providerStatus.billingCaveat}</p>
              )}
              {fields.map(field => (
                <div key={field.id} className="flex items-center gap-2">
                  <span style={{ fontSize: 10, color: '#94a3b8', width: 90, flexShrink: 0 }}>{field.label}</span>
                  <input
                    style={inputStyle}
                    type="password"
                    placeholder={settings?.keys[field.id]?.configured ? 'Configuré ✓' : ''}
                    value={keyDrafts[field.id] ?? ''}
                    onChange={e => setKeyDrafts(d => ({ ...d, [field.id]: e.target.value }))}
                  />
                  <button type="button" style={btnStyle} onClick={() => saveKey(field.id)} disabled={!keyDrafts[field.id]}>Enregistrer</button>
                  <button
                    type="button" style={btnGhostStyle} disabled={strictLocalMode}
                    onClick={() => alert(`Ce test va contacter ${group}. (Aucun appel réel dans cette version.)`)}
                  >
                    Tester
                  </button>
                  {settings?.keys[field.id]?.configured && (
                    <button type="button" style={btnDangerStyle} onClick={() => removeKey(field.id)}>Supprimer</button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* ── D. Routage / confidentialité ───────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <p style={sectionLabelStyle}>ROUTAGE / CONFIDENTIALITÉ</p>
        <div style={cardStyle}>
          <div>
            <p style={{ fontSize: 11, color: '#e2e8f0', marginBottom: 4 }}>Priorité</p>
            <div className="flex gap-4">
              <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="radio" checked={settings?.settings.priority === 'local'} onChange={() => updateSettings({ priority: 'local' })} />
                Local d'abord
              </label>
              <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="radio" checked={settings?.settings.priority === 'cloud'} onChange={() => updateSettings({ priority: 'cloud' })} />
                Cloud gratuit d'abord
              </label>
            </div>
          </div>
          <label style={{ fontSize: 11, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={settings?.settings.free_cloud_only ?? true}
              onChange={e => updateSettings({ free_cloud_only: e.target.checked })}
            />
            Cloud image gratuit uniquement
          </label>
          <p style={{ fontSize: 10, color: '#94a3b8' }}>
            Docteur refuse un fournisseur ou modèle dont l'utilisation gratuite n'est pas confirmée.
          </p>
          {status?.strictLocal && (
            <p style={{ fontSize: 11, color: '#f87171', display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle size={12} /> Mode strictement local actif — le backend bloque tout appel cloud, quels que soient ces réglages.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
