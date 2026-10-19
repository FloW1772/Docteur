// EETF V1 — EETF-7 Environments surface: BACKGROUND / SCENE_REFERENCE / PANORAMA_REFERENCE + SKYBOX_PREVIEW.
// Environment IMAGES only: no HDRI, no certified equirectangular, no cubemap, no 3D scene.
import { useState } from 'react';
import { eetfAssetUrl, eetfClient, messageOf, type EetfEnvironment, type EnvironmentType } from '../../lib/eetf/client';
import { warningLabel } from '../../lib/eetf/ui-model';
import { EetfAssetPicker, EetfGenerateBlock, EetfJobList, EetfProviderStatus } from './EetfCommon';
import EetfSkyboxViewer, { clampView, type ViewParams } from './EetfSkyboxViewer';
import EetfIntegrationPanel from './EetfIntegrationPanel'; // [EETF-8] Media Reader / Media Studio / Neurone
import type { EetfData } from './useEetfData';
import './eetf.css';

const TYPES: { value: Exclude<EnvironmentType, 'SKYBOX_PREVIEW'>; label: string }[] = [
  { value: 'BACKGROUND', label: 'Arrière-plan (BACKGROUND)' },
  { value: 'SCENE_REFERENCE', label: 'Référence de scène (SCENE_REFERENCE)' },
  { value: 'PANORAMA_REFERENCE', label: 'Panorama de référence (PANORAMA_REFERENCE)' },
];
const INTERACTIVE = new Set(['PNG', 'JPEG', 'WEBP']);
const num = (v: unknown, d = 4) => (typeof v === 'number' ? String(Math.round(v * 10 ** d) / 10 ** d) : '—');

function Slider({ id, label, min, max, value, onChange }: { id: string; label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="eetf-label" htmlFor={id}>{label} ({min}…{max})</label>
      <input id={id} type="range" min={min} max={max} step={1} value={value} onChange={e => onChange(Number(e.target.value))} />
      <input className="eetf-input" type="number" min={min} max={max} step={1} value={value} aria-label={`${label} valeur`} style={{ width: 80 }}
        onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }} />
    </div>
  );
}

export default function EetfEnvironmentsTab({ data }: { data: EetfData }) {
  const { status } = data;
  const enabled = Boolean(status?.enabled);
  const [source, setSource] = useState<string | null>(null);
  const [type, setType] = useState<Exclude<EnvironmentType, 'SKYBOX_PREVIEW'>>('PANORAMA_REFERENCE');
  const [env, setEnv] = useState<EetfEnvironment | null>(null);
  const [sky, setSky] = useState<EetfEnvironment | null>(null);
  const [view, setView] = useState<ViewParams>({ yaw: 0, pitch: 0, fov: 90 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = env?.report ?? null;

  async function analyse() {
    if (!source) return;
    setBusy(true); setError(null); setSky(null);
    try { setEnv(await eetfClient.createEnvironment(type, source)); await data.refreshAssets(); } catch (e) { setEnv(null); setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function renderServer() {
    if (!env) return;
    setBusy(true); setError(null);
    try { setSky(await eetfClient.createSkybox(env.id, { ...view, width: 512, height: 288 })); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }

  return (
    <div className="eetf-root" data-testid="eetf-environments">
      <EetfProviderStatus status={status} statusError={data.statusError} />
      <EetfAssetPicker assets={data.assets} selected={source} onSelect={setSource} disabled={!enabled} onUploaded={(a) => { setSource(a.id); void data.refreshAssets(); }} label="Image d’environnement" />
      <EetfIntegrationPanel assetId={source} data={data} />
      <div className="eetf-card" aria-busy={busy}>
        <h3>Type d’environnement</h3>
        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="eetf-sr">Type d’environnement</legend>
          {TYPES.map(t => (
            <label key={t.value} className="eetf-row"><input type="radio" name="eetf-env-type" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} /> {t.label}</label>
          ))}
        </fieldset>
        <p className="eetf-muted" data-testid="eetf-env-unsupported">Non pris en charge en V1 : {(status?.contract?.unsupportedEnvironmentTypes ?? ['HDRI', 'CERTIFIED_EQUIRECTANGULAR', 'CUBEMAP', '3D_SCENE']).join(', ')} — une image 2:1 n’est pas un panorama certifié, un EXR/HDR issu de LDR n’est pas un HDRI.</p>
        <button type="button" className="eetf-btn" disabled={!enabled || !source || busy} onClick={() => { void analyse(); }}>Analyser et créer</button>
        {!source && <p className="eetf-muted">Choisissez ou importez une image.</p>}
        {busy && <p className="eetf-muted" role="status">Analyse en cours…</p>}
        {error && <p className="eetf-error" role="alert">{error}</p>}
      </div>

      {env && (
        <div className="eetf-card" data-testid="eetf-env-result">
          <h3>{env.type}</h3>
          <div className="eetf-row">{env.labels.map(l => <span key={l} className="eetf-badge warn">{warningLabel(l)}</span>)}</div>
          <table className="eetf-table" aria-label="Analyse de l’environnement">
            <tbody>
              <tr><th scope="row">Dimensions</th><td>{env.asset.width}×{env.asset.height} · {env.asset.format}</td></tr>
              <tr><th scope="row">Plage dynamique</th><td>{env.dynamicRange}</td></tr>
              <tr><th scope="row">Origine</th><td>{env.asset.role}{env.provenance ? ` · ${env.provenance.provider}${env.provenance.model ? ` · ${env.provenance.model}` : ''}${env.provenance.seed !== null ? ` · seed ${env.provenance.seed}` : ''} · ${env.provenance.operation ?? env.provenance.jobKind ?? ''}` : ''}</td></tr>
              {env.type === 'PANORAMA_REFERENCE' && r && (<>
                <tr><th scope="row">Ratio</th><td>{num(r.aspectRatio)} (écart au 2:1 : {num(Number(r.ratio2to1Deviation) * 100, 2)} %)</td></tr>
                <tr><th scope="row">Raccord horizontal</th><td>{num(r.horizontalSeamScore)} · {String(r.horizontalSeamStatus ?? '—')} · {String(r.seamMethod ?? '')}</td></tr>
                <tr><th scope="row">Indice de pôles</th><td>haut {num((r.poleRowDeviation as { top?: number } | undefined)?.top, 2)} · bas {num((r.poleRowDeviation as { bottom?: number } | undefined)?.bottom, 2)}</td></tr>
              </>)}
              {env.type !== 'PANORAMA_REFERENCE' && <tr><th scope="row">Nature</th><td>Image de référence — pas une scène 3D (aucune caméra, aucune géométrie)</td></tr>}
            </tbody>
          </table>
          {r?.warnings && r.warnings.length > 0 && (
            <ul data-testid="eetf-env-warnings">{r.warnings.map(w => <li key={w}><span className="eetf-badge warn">{warningLabel(w)}</span></li>)}</ul>
          )}
        </div>
      )}

      {env?.type === 'PANORAMA_REFERENCE' && (
        <>
          <div className="eetf-card">
            <h3>Paramètres d’aperçu (pas une caméra de scène)</h3>
            <div className="eetf-sliders">
              <Slider id="eetf-yaw" label="Lacet (yaw)" min={-180} max={180} value={view.yaw} onChange={v => setView(clampView({ ...view, yaw: v }))} />
              <Slider id="eetf-pitch" label="Tangage (pitch)" min={-90} max={90} value={view.pitch} onChange={v => setView(clampView({ ...view, pitch: v }))} />
              <Slider id="eetf-fov" label="Champ (fov)" min={status?.limits?.previewFov[0] ?? 30} max={status?.limits?.previewFov[1] ?? 120} value={view.fov} onChange={v => setView(clampView({ ...view, fov: v }))} />
            </div>
          </div>
          {INTERACTIVE.has(env.asset.format)
            ? <EetfSkyboxViewer assetId={env.assetId} view={view} onView={setView} />
            : <p className="eetf-muted">Aperçu interactif indisponible pour un conteneur {env.asset.format} (contenu LDR) : utilisez le rendu serveur.</p>}
          <div className="eetf-card">
            <button type="button" className="eetf-btn" disabled={busy} onClick={() => { void renderServer(); }}>Rendu serveur (PREVIEW ONLY)</button>
            {sky?.report?.previewAssetId && (
              <figure className="eetf-view" data-testid="eetf-sky-view">
                <img src={eetfAssetUrl(sky.report.previewAssetId)} alt="Vue rendue de l’aperçu skybox" />
                <figcaption>PREVIEW_ONLY — yaw {sky.report.preview?.yaw}°, pitch {sky.report.preview?.pitch}°, fov {sky.report.preview?.fov}° · pas une caméra de scène, pas une cubemap</figcaption>
              </figure>
            )}
          </div>
        </>
      )}

      <EetfGenerateBlock status={status} idPrefix="eetf-env" placeholder="Ciel alpin à l’aube, panorama 2:1"
        onGenerate={async (prompt) => {
          const model = status?.provider?.models[0];
          await eetfClient.generate({ prompt, width: 1024, height: 512, target: 'ENVIRONMENT', environmentType: 'PANORAMA_REFERENCE', ...(model ? { model } : {}) });
          await data.refreshJobs();
        }} />
      <EetfJobList jobs={data.jobs} onChanged={() => { void data.refreshJobs(); }} />
    </div>
  );
}
