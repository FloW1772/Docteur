// EETF V1 — EETF-7 Textures / Materials surface. Mirrors the backend contract: V1 maps are honest
// (NORMAL / HEIGHT / AO / EMISSIVE UNSUPPORTED; ROUGHNESS / METALLIC USER_CONSTANT; OPACITY only from a real alpha).
import { useState } from 'react';
import { eetfAssetUrl, eetfClient, messageOf, type EetfMaterial } from '../../lib/eetf/client';
import { MAP_ORDER, ROLE_LABELS, mapDetail, mapStatusLabel, materialStatusLabel, seamStatusLabel } from '../../lib/eetf/ui-model';
import { EetfAssetPicker, EetfGenerateBlock, EetfJobList, EetfProviderStatus } from './EetfCommon';
import EetfIntegrationPanel from './EetfIntegrationPanel'; // [EETF-8] Media Reader / Media Studio / Neurone
import type { EetfData } from './useEetfData';
import './eetf.css';

function ConstantControl({ id, label, enabled, value, onEnabled, onValue }: { id: string; label: string; enabled: boolean; value: number; onEnabled: (b: boolean) => void; onValue: (v: number) => void }) {
  return (
    <fieldset className="eetf-card" style={{ margin: 0 }}>
      <legend className="eetf-label">{label} — USER_CONSTANT</legend>
      <label className="eetf-row"><input type="checkbox" checked={enabled} onChange={e => onEnabled(e.target.checked)} /> Définir une valeur constante (pas une carte générée)</label>
      <div className="eetf-row">
        <input id={`${id}-range`} type="range" min={0} max={1} step={0.01} value={value} disabled={!enabled} aria-label={`${label} (constante 0 à 1)`} onChange={e => onValue(Number(e.target.value))} style={{ flex: 1, minWidth: 0 }} />
        <input id={`${id}-num`} className="eetf-input" type="number" min={0} max={1} step={0.01} value={value} disabled={!enabled} aria-label={`${label} valeur numérique`} style={{ width: 80 }}
          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onValue(Math.min(1, Math.max(0, v))); }} />
      </div>
    </fieldset>
  );
}

export default function EetfTexturesTab({ data }: { data: EetfData }) {
  const { status } = data;
  const enabled = Boolean(status?.enabled);
  const [source, setSource] = useState<string | null>(null);
  const [name, setName] = useState('Matériau');
  const [rough, setRough] = useState({ on: true, v: 0.7 });
  const [metal, setMetal] = useState({ on: true, v: 0 });
  const [opacity, setOpacity] = useState(false);
  const [grid, setGrid] = useState<2 | 3>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [material, setMaterial] = useState<EetfMaterial | null>(null);
  const selected = data.assets.find(a => a.id === source) ?? null;

  async function create() {
    if (!source) return;
    setBusy(true); setError(null);
    try {
      setMaterial(await eetfClient.createMaterial({
        name, baseColorAssetId: source, roughness: rough.on ? { value: rough.v } : null, metallic: metal.on ? { value: metal.v } : null,
        opacity: opacity ? 'FROM_SOURCE_ALPHA' : 'NONE', preview: { grid },
      }));
      await data.refreshAssets();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function derive(operation: 'THUMBNAIL' | 'TILE_PREVIEW') {
    if (!source) return;
    setError(null);
    try { await eetfClient.derive(operation === 'TILE_PREVIEW' ? { sourceAssetId: source, operation, grid: 3, maxSide: 768 } : { sourceAssetId: source, operation, maxSide: 256 }); await data.refreshJobs(); }
    catch (e) { setError(messageOf(e)); }
  }

  return (
    <div className="eetf-root" data-testid="eetf-textures">
      <EetfProviderStatus status={status} statusError={data.statusError} />
      <EetfAssetPicker assets={data.assets} selected={source} onSelect={setSource} disabled={!enabled}
        onUploaded={(a) => { setSource(a.id); void data.refreshAssets(); }} label="Image de base (Base Color)" />
      <EetfIntegrationPanel assetId={source} data={data} />

      <div className="eetf-card" aria-busy={busy}>
        <h3>Matériau V1 (opérations locales)</h3>
        {!selected && <p className="eetf-muted" data-testid="eetf-no-asset">Choisissez ou importez une image de base.</p>}
        <div className="eetf-grid2">
          <div>
            <label className="eetf-label" htmlFor="eetf-mat-name">Nom</label>
            <input id="eetf-mat-name" className="eetf-input" style={{ width: '100%' }} value={name} maxLength={120} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="eetf-label" htmlFor="eetf-grid">Aperçu mosaïque</label>
            <select id="eetf-grid" className="eetf-input" value={grid} onChange={e => setGrid(Number(e.target.value) as 2 | 3)}>
              <option value={2}>2 × 2</option><option value={3}>3 × 3</option>
            </select>
          </div>
        </div>
        <div className="eetf-grid2" style={{ marginTop: 10 }}>
          <ConstantControl id="eetf-rough" label="Roughness" enabled={rough.on} value={rough.v} onEnabled={b => setRough(r => ({ ...r, on: b }))} onValue={v => setRough(r => ({ ...r, v }))} />
          <ConstantControl id="eetf-metal" label="Metallic" enabled={metal.on} value={metal.v} onEnabled={b => setMetal(r => ({ ...r, on: b }))} onValue={v => setMetal(r => ({ ...r, v }))} />
        </div>
        <label className="eetf-row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={opacity} onChange={e => setOpacity(e.target.checked)} disabled={selected ? !selected.hasAlpha : true} />
          Opacité depuis le canal alpha de la base color {selected && !selected.hasAlpha ? '(cette image n’a pas de canal alpha)' : '(seulement si la transparence est réelle)'}
        </label>
        <div className="eetf-row" style={{ marginTop: 10 }}>
          <button type="button" className="eetf-btn" disabled={!enabled || !selected || busy} onClick={() => { void create(); }}>Créer le matériau</button>
          <button type="button" className="eetf-btn ghost" disabled={!enabled || !selected} onClick={() => { void derive('THUMBNAIL'); }}>Miniature (tâche)</button>
          <button type="button" className="eetf-btn ghost" disabled={!enabled || !selected} onClick={() => { void derive('TILE_PREVIEW'); }}>Mosaïque 3×3 (tâche)</button>
        </div>
        <p className="eetf-muted">Normal, Height, AO et Emissive ne sont pas produits en V1 ; aucun badge « PBR » n’est affiché.</p>
        {busy && <p className="eetf-muted" role="status">Création du matériau en cours…</p>}
        {error && <p className="eetf-error" role="alert">{error}</p>}
      </div>

      {material && (
        <div className="eetf-card" data-testid="eetf-material">
          <h3>{material.name}</h3>
          <div className="eetf-row"><span className="eetf-badge" data-testid="eetf-material-status">{materialStatusLabel(material.status)}</span></div>
          <table className="eetf-table" aria-label="Cartes du matériau">
            <thead><tr><th scope="col">Carte</th><th scope="col">Statut</th><th scope="col">Détail</th></tr></thead>
            <tbody>
              {MAP_ORDER.map(k => {
                const m = material[k];
                return (
                  <tr key={k} data-map={m.role} data-status={m.status}>
                    <th scope="row">{ROLE_LABELS[m.role] ?? m.role}</th>
                    <td><span className={`eetf-badge ${m.status === 'UNSUPPORTED' ? 'off' : 'ok'}`}>{mapStatusLabel(m.status)}</span></td>
                    <td>{mapDetail(m)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {material.baseColor.tile && (
            <div className="eetf-card" style={{ marginTop: 10 }} data-testid="eetf-seam">
              <h3>Raccords (tuilage)</h3>
              <div className="eetf-row"><span className="eetf-badge">{seamStatusLabel(material.baseColor.tile.status)}</span></div>
              <p className="eetf-muted">
                Horizontal : {material.baseColor.tile.horizontalScore ?? '—'} · Vertical : {material.baseColor.tile.verticalScore ?? '—'} · Méthode : {material.baseColor.tile.method ?? '—'} v{material.baseColor.tile.version ?? '—'}
              </p>
            </div>
          )}
          {material.preview && material.baseColor.source && (
            <div className="eetf-preview-pair" style={{ marginTop: 10 }} data-testid="eetf-tiling">
              <figure><img src={eetfAssetUrl(material.baseColor.source.assetId)} alt="Base color (source normalisée)" /><figcaption>Source</figcaption></figure>
              <figure><img src={eetfAssetUrl(material.preview.assetId)} alt="Aperçu mosaïque (inspection uniquement)" /><figcaption>Aperçu mosaïque — inspection uniquement, la source n’est pas modifiée</figcaption></figure>
            </div>
          )}
          {material.baseColor.source && (
            <dl className="eetf-table" style={{ marginTop: 10 }} data-testid="eetf-provenance">
              <div className="eetf-row"><dt className="eetf-label">Origine</dt><dd>{material.baseColor.status} · {material.baseColor.source.role}</dd></div>
              <div className="eetf-row"><dt className="eetf-label">Moteur</dt><dd>{material.baseColor.source.provider ?? '—'} {material.baseColor.source.model ? `· ${material.baseColor.source.model}` : ''} {material.baseColor.source.engineVersion ? `· ${material.baseColor.source.engineVersion}` : ''}</dd></div>
              <div className="eetf-row"><dt className="eetf-label">Opération</dt><dd>{material.baseColor.source.operation ?? material.baseColor.source.jobKind ?? '—'}</dd></div>
              <div className="eetf-row"><dt className="eetf-label">Dimensions</dt><dd>{material.baseColor.source.width}×{material.baseColor.source.height}</dd></div>
              <div className="eetf-row"><dt className="eetf-label">Créé le</dt><dd>{material.baseColor.source.createdAt}</dd></div>
              <div className="eetf-row"><dt className="eetf-label">Espace colorimétrique</dt><dd>{material.baseColor.colorSpace ?? '—'}</dd></div>
            </dl>
          )}
        </div>
      )}

      <EetfGenerateBlock status={status} idPrefix="eetf-tex" placeholder="Pavés de pierre moussus, vue de dessus, éclairage neutre"
        onGenerate={async (prompt) => {
          const model = status?.provider?.models[0];
          await eetfClient.generate({ prompt, width: 512, height: 512, target: 'TEXTURE', textureRole: 'BASE_COLOR', ...(model ? { model } : {}) });
          await data.refreshJobs();
        }} />
      <EetfJobList jobs={data.jobs} onChanged={() => { void data.refreshJobs(); }} />
    </div>
  );
}
