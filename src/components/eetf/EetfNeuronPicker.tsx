// EETF V1 — EETF-8 « Depuis EETF » inside an EMPTY Neurone image block.
// Uses the Neurone's own image contract unchanged: the block's onUploadImage(file) stores a copy in the Neurone image
// store (one file per image block: deleting the block deletes that file, so EETF never shares its own copy), then the
// block's content becomes that image id. EETF records the export after re-reading the Neurone copy (byte-identical
// check). Only PNG / JPEG / WebP ≤ 5 MB fit a neuron image; other formats show why.
import { useEffect, useRef, useState } from 'react';
import { eetfAssetUrl, eetfClient, type EetfAsset } from '../../lib/eetf/client';
import { eetfAssetAsNeuronFile, recordNeuronExport, toIntegrationError } from '../../lib/eetf/bridges';
import { INTEGRATION_MESSAGES, neuronCompatibility, roleLabel } from '../../lib/eetf/integration-model';
import './eetf.css';

const NATIVE = new Set(['PNG', 'JPEG', 'WEBP']);

export default function EetfNeuronPicker({ onUploadImage, onInserted, onClose }: {
  onUploadImage: (file: File) => Promise<string>; onInserted: (imageId: string) => void; onClose: () => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [assets, setAssets] = useState<EetfAsset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await eetfClient.status().catch(() => null);
      if (!alive) return;
      setEnabled(Boolean(s?.enabled));
      if (s?.enabled) { const list = await eetfClient.listAssets().catch(() => []); if (alive) setAssets(list); }
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => { root.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus(); }, [enabled, assets.length]);

  async function pick(a: EetfAsset) {
    setBusy(a.id); setMessage(null);
    try {
      const { file } = await eetfAssetAsNeuronFile(a.id);
      const imageId = await onUploadImage(file);   // the Neurone's existing image contract
      await recordNeuronExport(a.id, imageId);       // provenance on the EETF side (server re-reads the copy)
      onInserted(imageId);
    } catch (e) { setMessage(toIntegrationError(e).message); setBusy(null); }
  }

  return (
    <div ref={root} className="eetf-card" role="group" aria-label="Choisir une image EETF pour ce neurone" data-testid="eetf-neuron-picker"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} style={{ background: 'rgba(20,10,40,0.6)' }}>
      <div className="eetf-row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Images EETF</h3>
        <button type="button" className="eetf-btn ghost" onClick={onClose} aria-label="Fermer le choix EETF">Fermer</button>
      </div>
      {enabled === null && <p className="eetf-muted" role="status">Chargement…</p>}
      {enabled === false && <p className="eetf-reason" role="status" data-testid="eetf-neuron-picker-disabled">{INTEGRATION_MESSAGES.EETF_DISABLED}</p>}
      {enabled && assets.length === 0 && <p className="eetf-muted" role="status">Aucun asset EETF pour l’instant.</p>}
      {enabled && assets.length > 0 && (
        <ul className="eetf-assets" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
          {assets.map(a => {
            const compat = neuronCompatibility(a);
            const reasonId = `eetf-np-reason-${a.id}`;
            return (
              <li key={a.id} style={{ width: 120, flex: '0 0 auto' }}>
                <button type="button" className="eetf-asset" style={{ width: '100%' }} data-asset-id={a.id} disabled={!compat.ok || busy !== null}
                  aria-describedby={compat.ok ? undefined : reasonId}
                  aria-label={`Insérer ${a.displayName ?? a.format} (${a.role}, ${a.width}×${a.height})`} onClick={() => { void pick(a); }}>
                  {NATIVE.has(a.format) ? <img src={eetfAssetUrl(a.id)} alt="" loading="lazy" /> : <div className="eetf-thumb" aria-hidden="true" />}
                  <span>{busy === a.id ? 'Insertion…' : (a.displayName ?? a.format)}</span>
                  <span title={roleLabel(a.role)}>{a.role} · {a.format}</span>
                </button>
                {!compat.ok && <span id={reasonId} className="eetf-reason" style={{ display: 'block', fontSize: 10 }}>{compat.reason}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {message && <p className="eetf-error" role="alert" data-testid="eetf-neuron-picker-error">{message}</p>}
    </div>
  );
}
