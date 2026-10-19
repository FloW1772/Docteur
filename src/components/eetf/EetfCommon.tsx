// EETF V1 — EETF-7 shared UI pieces: provider status, asset picker, job list.
// All text is rendered as React text (escaped); no dangerouslySetInnerHTML anywhere in EETF.
import { useEffect, useRef, useState } from 'react';
import { eetfAssetUrl, eetfClient, eetfErrorMessage, messageOf, type CancelResult, type EetfAsset, type EetfJob, type EetfStatus } from '../../lib/eetf/client';
import { JOB_LABELS, progressInfo, providerStateLabel } from '../../lib/eetf/ui-model';
import './eetf.css';

const DISPLAYABLE = new Set(['PNG', 'JPEG', 'WEBP']);

export function EetfProviderStatus({ status, statusError }: { status: EetfStatus | null; statusError: string | null }) {
  const p = providerStateLabel(status);
  return (
    <div className="eetf-card" role="status" aria-live="polite" data-testid="eetf-provider-status">
      <div className="eetf-row">
        <span className={`eetf-badge ${p.tone}`} data-testid="eetf-provider-state">{status?.provider?.status ?? (status?.enabled === false ? 'DISABLED' : 'UNKNOWN')}</span>
        <span>{p.text}</span>
      </div>
      {statusError && <p className="eetf-error">{statusError}</p>}
      {status?.enabled && (
        <p className="eetf-muted">
          Opérations locales (FFmpeg) : {status.local?.ffmpeg.available ? 'disponibles' : 'indisponibles'} · Génération IA : {status.generation?.available ? 'possible (local)' : 'désactivée — aucun envoi cloud'}
        </p>
      )}
      {status?.enabled === false && <p className="eetf-muted">EETF reste désactivé jusqu’à sa certification ; l’onglet Image (générateur historique) n’est pas concerné.</p>}
    </div>
  );
}

export function EetfAssetPicker({ assets, selected, onSelect, onUploaded, disabled, label = 'Image source' }: {
  assets: EetfAsset[]; selected: string | null; onSelect: (id: string) => void; onUploaded: (a: EetfAsset) => void; disabled: boolean; label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useRef(`eetf-upload-${Math.random().toString(36).slice(2, 8)}`).current;
  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null);
    try { const r = await eetfClient.uploadAsset(file); onUploaded(r.asset); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return (
    <div className="eetf-card" aria-busy={busy}>
      <h3>{label}</h3>
      <div className="eetf-row">
        <label className="eetf-btn ghost" htmlFor={inputId} aria-disabled={disabled}>Importer une image…</label>
        <input id={inputId} className="eetf-sr" type="file" accept="image/png,image/jpeg,image/webp,image/tiff,image/x-exr,.exr,.hdr" disabled={disabled}
          aria-label="Importer une image (PNG, JPEG, WebP, TIFF, EXR, HDR)" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        <span className="eetf-muted">Le fichier d’origine n’est jamais modifié.</span>
      </div>
      {error && <p className="eetf-error" role="alert">{error}</p>}
      {assets.length === 0
        ? <p className="eetf-muted" data-testid="eetf-assets-empty">Aucune image pour l’instant.</p>
        : (
          <div className="eetf-assets" role="group" aria-label={label}>
            {assets.map(a => (
              <button key={a.id} type="button" className="eetf-asset" aria-pressed={selected === a.id} disabled={disabled} onClick={() => onSelect(a.id)}
                title={`${a.displayName ?? a.id} — ${a.role} ${a.format} ${a.width}×${a.height}`} data-asset-id={a.id}>
                {DISPLAYABLE.has(a.format) ? <img src={eetfAssetUrl(a.id)} alt="" loading="lazy" /> : <div className="eetf-thumb" aria-hidden="true" />}
                <span>{a.displayName ?? a.format}</span>
                <span>{a.role} · {a.width}×{a.height}</span>
              </button>
            ))}
          </div>
        )}
    </div>
  );
}

function jobTitle(j: EetfJob): string {
  if (j.kind === 'GENERATE') return 'Génération IA (locale)';
  const op = String(j.params.operation ?? '');
  return ({ THUMBNAIL: 'Miniature', TILE_PREVIEW: 'Aperçu mosaïque', CONVERT: 'Conversion', RESIZE: 'Redimensionnement', CROP: 'Recadrage' } as Record<string, string>)[op] ?? 'Dérivation';
}

export function EetfJobList({ jobs, onChanged }: { jobs: EetfJob[]; onChanged: () => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState('');
  const last = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const j of jobs) {
      if (last.current[j.id] && last.current[j.id] !== j.status) setAnnounce(`${jobTitle(j)} : ${JOB_LABELS[j.status] ?? j.status}`);
      last.current[j.id] = j.status;
    }
  }, [jobs]);
  async function cancel(j: EetfJob) {
    try {
      const r: CancelResult = await eetfClient.cancelJob(j.id);
      setNotes(n => ({ ...n, [j.id]: r.gpuStopGuaranteed === false && r.interruptRequired ? 'Interruption demandée — l’arrêt du GPU n’est pas garanti.' : 'Annulé.' }));
    } catch (e) { setNotes(n => ({ ...n, [j.id]: messageOf(e) })); }
    onChanged();
  }
  return (
    <div className="eetf-card" data-testid="eetf-jobs">
      <h3>Tâches</h3>
      <p className="eetf-sr" aria-live="polite" data-testid="eetf-jobs-live">{announce}</p>
      {jobs.length === 0 ? <p className="eetf-muted">Aucune tâche.</p> : (
        <ul className="eetf-jobs">
          {jobs.slice(0, 8).map(j => {
            const p = progressInfo(j);
            const active = j.status === 'QUEUED' || j.status === 'RUNNING';
            return (
              <li key={j.id} data-job-id={j.id} data-job-status={j.status}>
                <div>
                  <div className="eetf-row"><span className="eetf-badge">{j.status}</span><span>{jobTitle(j)}</span></div>
                  <div className={`eetf-progress${p.determinate ? '' : ' indeterminate'}`} role="progressbar" aria-label={`${jobTitle(j)} — ${p.text}`}
                    aria-valuemin={0} aria-valuemax={100} {...(p.determinate ? { 'aria-valuenow': p.percent ?? 0 } : { 'aria-valuetext': p.text })} aria-busy={active}>
                    <span style={p.determinate ? { width: `${p.percent}%` } : undefined} />
                  </div>
                  <div className="eetf-muted">{p.text}</div>
                  {j.error && j.status !== 'CANCELLED' && <div className="eetf-error">{eetfErrorMessage(j.error.code)}</div>}
                  {notes[j.id] && <div className="eetf-reason">{notes[j.id]}</div>}
                </div>
                {active && <button type="button" className="eetf-btn ghost" onClick={() => { void cancel(j); }} aria-label={`Annuler : ${jobTitle(j)}`}>Annuler</button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** AI generation block: the action is disabled (with a readable reason) when no local provider can run it. */
export function EetfGenerateBlock({ status, onGenerate, placeholder, idPrefix }: { status: EetfStatus | null; onGenerate: (prompt: string) => Promise<void>; placeholder: string; idPrefix: string }) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = !status?.enabled ? 'EETF_DISABLED' : status.generation?.available ? null : (status.generation?.reason ?? 'LOCAL_PROVIDER_UNAVAILABLE');
  const reasonId = `${idPrefix}-gen-reason`;
  return (
    <div className="eetf-card" aria-busy={busy}>
      <h3>Génération IA locale</h3>
      <label className="eetf-label" htmlFor={`${idPrefix}-prompt`}>Prompt</label>
      <textarea id={`${idPrefix}-prompt`} className="eetf-input" style={{ width: '100%', minHeight: 54 }} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={placeholder} maxLength={4000} />
      <div className="eetf-row" style={{ marginTop: 8 }}>
        <button type="button" className="eetf-btn" disabled={Boolean(blocked) || !prompt.trim() || busy} aria-describedby={blocked ? reasonId : undefined}
          onClick={async () => { setBusy(true); setError(null); try { await onGenerate(prompt.trim()); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }}>
          Générer (IA locale)
        </button>
        {blocked && <span id={reasonId} className="eetf-reason" data-testid={`${idPrefix}-gen-blocked`}>{blocked} — {eetfErrorMessage(blocked)}</span>}
      </div>
      {error && <p className="eetf-error" role="alert">{error}</p>}
    </div>
  );
}
