// EETF V1 — EETF-8 pieces shown INSIDE the Media Reader (the reader stays the single viewer):
//   EetfAssetViewer        an EETF asset: native PNG / JPEG / WebP, or an honest stand-in for TIFF / EXR / HDR (an
//                          existing derived PNG, or a button that asks the EETF job system for one) + its metadata.
//   EetfNeuronImageStrip   a Neurone image (Docteur image store): its EETF provenance, and "use as EETF source".
// Every text is React text (escaped). No path, SQL, stack or policy internal is ever shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { eetfAssetUrl, eetfClient, type EetfAssetDetails, type EetfJob, type EetfLink } from '../../lib/eetf/client';
import { assetDetails, createPngPreview, sendNeuronImageToEetf, toIntegrationError } from '../../lib/eetf/bridges';
import { classificationLabel, dynamicRangeLabel, linkLabel, roleLabel } from '../../lib/eetf/integration-model';
import { progressInfo } from '../../lib/eetf/ui-model';
import type { ReaderEvent } from '../../lib/media/media-resource';
import './eetf.css';

const sizeLabel = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const short = (id: string | null | undefined) => (id ? `${id.slice(0, 8)}…` : '—');

export interface EetfReaderInfo { native: boolean; format: string; previewAssetId: string | null }

export function EetfAssetMetadata({ details, previewAssetId }: { details: EetfAssetDetails; previewAssetId: string | null }) {
  const { asset, source, integration } = details;
  const operation = source.operation ?? (source.jobKind === 'GENERATE' ? 'GENERATE' : asset.role === 'SOURCE' ? 'IMPORT' : null);
  return (
    <section className="eetf-card eetf-reader-meta" aria-label="Métadonnées EETF" data-testid="eetf-reader-meta">
      <h3>Asset EETF</h3>
      <dl className="eetf-meta">
        <dt>Statut</dt><dd><span className="eetf-badge" data-testid="eetf-reader-role">{asset.role}</span> {roleLabel(asset.role)}</dd>
        <dt>Format</dt><dd data-testid="eetf-reader-format">{asset.format} — {integration.preview.native ? 'affiché nativement' : (previewAssetId ? 'non affichable nativement : aperçu PNG dérivé affiché' : 'non affichable nativement')}</dd>
        <dt>Dimensions</dt><dd data-testid="eetf-reader-dimensions">{asset.width} × {asset.height}{asset.hasAlpha ? ' · canal alpha' : ''} · {sizeLabel(asset.sizeBytes)}</dd>
        <dt>Plage dynamique</dt><dd data-testid="eetf-reader-dynamic-range">{dynamicRangeLabel(asset.dynamicRange)}</dd>
        <dt>Provenance</dt>
        <dd data-testid="eetf-reader-provenance">
          {operation ?? '—'}{source.jobKind ? ` · tâche ${short(asset.sourceJobId)}` : ''}{source.provider ? ` · ${source.provider}${source.model ? ` (${source.model})` : ''}` : ''}
          {source.derivedFrom.length > 0 && <> · dérivé de {source.derivedFrom.map(short).join(', ')}</>} · créé le {asset.createdAt}
        </dd>
        <dt>Empreinte</dt><dd className="eetf-mono" title={asset.sha256}>SHA-256 {asset.sha256.slice(0, 16)}…</dd>
        <dt>Classification</dt>
        <dd data-testid="eetf-reader-classification">{integration.classification.length ? integration.classification.map(classificationLabel).join(' · ') : 'Aucune utilisation texture / environnement enregistrée'}</dd>
        <dt>Échanges</dt>
        <dd data-testid="eetf-reader-links">
          {integration.links.length === 0 ? 'Aucun' : (
            <ul className="eetf-links">{integration.links.map(l => <li key={l.id}>{linkLabel(l)}</li>)}</ul>
          )}
        </dd>
      </dl>
    </section>
  );
}

export function EetfAssetViewer({ assetId, title, dispatch, onInfo }: { assetId: string; title: string; dispatch: (e: ReaderEvent) => void; onInfo?: (i: EetfReaderInfo) => void }) {
  const [details, setDetails] = useState<EetfAssetDetails | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [job, setJob] = useState<EetfJob | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const alive = useRef(true);
  const preview = useRef<AbortController | null>(null);
  useEffect(() => () => { alive.current = false; preview.current?.abort(); }, []);

  const load = useCallback(async () => {
    try {
      const d = await assetDetails(assetId);
      if (!alive.current) return;
      const variant = d.integration.preview.variant?.assetId ?? null;
      setDetails(d); setPreviewId(variant);
      onInfo?.({ native: d.integration.preview.native, format: d.asset.format, previewAssetId: variant });
      if (!d.integration.preview.native && !variant) dispatch({ type: 'ready' }); // nothing to load: the panel explains why
    } catch (e) {
      if (!alive.current) return;
      const err = toIntegrationError(e);
      if (err.code === 'EETF_DISABLED') dispatch({ type: 'unsupported', message: `${err.message} Cet asset ne peut pas être affiché pour l’instant.` });
      else dispatch({ type: 'error', message: err.message });
    }
  }, [assetId, dispatch, onInfo]);
  useEffect(() => { void load(); }, [load]);

  async function makePreview() {
    setBusy(true); setNote(null);
    preview.current = new AbortController();
    try {
      const id = await createPngPreview(assetId, { signal: preview.current.signal, onJob: j => { if (alive.current) setJob(j); } });
      if (!alive.current) return;
      setPreviewId(id);
      await load();
      setNote('Aperçu PNG créé : nouvel asset dérivé, l’original n’est pas modifié.');
    } catch (e) { if (alive.current) setNote(toIntegrationError(e).message); } finally { if (alive.current) setBusy(false); }
  }

  if (!details) return null;
  const native = details.integration.preview.native;
  const shownId = native ? assetId : previewId;
  const p = job ? progressInfo(job) : null;
  return (
    <div className="eetf-reader" data-testid="eetf-reader-viewer" data-native={native ? 'yes' : 'no'} data-format={details.asset.format}>
      {shownId ? (
        <div className="eetf-reader-image" style={{ overflow: actualSize ? 'auto' : 'hidden' }}>
          <img
            data-testid="eetf-reader-image"
            data-shown-asset={shownId}
            src={eetfAssetUrl(shownId)}
            alt={native ? title : `Aperçu PNG dérivé de ${title}`}
            referrerPolicy="no-referrer"
            onLoad={() => dispatch({ type: 'ready' })}
            onError={() => dispatch({ type: 'error', message: 'Fichier de l’asset illisible ou supprimé : source indisponible.' })}
            onClick={() => setActualSize(v => !v)}
            style={actualSize ? { maxWidth: 'none', maxHeight: 'none', cursor: 'zoom-out' } : { maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain', cursor: 'zoom-in', display: 'block', margin: '0 auto' }}
          />
          <button type="button" className="eetf-btn ghost eetf-reader-zoom" onClick={() => setActualSize(v => !v)} aria-label={actualSize ? 'Ajuster à la fenêtre' : 'Taille réelle'}>
            {actualSize ? 'Ajuster' : 'Taille réelle'}
          </button>
        </div>
      ) : null}
      {!native && (
        <div className="eetf-card" role="note" data-testid="eetf-reader-preview-note">
          <p className="eetf-reason">
            Le {details.asset.format} n’est pas affiché nativement par le lecteur{previewId ? ' : l’image ci-dessus est un aperçu PNG 8 bits dérivé (inspection uniquement).' : '.'}
          </p>
          {!previewId && (
            <div className="eetf-row">
              <button type="button" className="eetf-btn" data-testid="eetf-reader-create-preview" disabled={busy} aria-describedby="eetf-reader-preview-hint" onClick={() => { void makePreview(); }}>
                Créer un aperçu PNG (tâche EETF)
              </button>
              <span id="eetf-reader-preview-hint" className="eetf-muted">Conversion locale FFmpeg : un nouvel asset dérivé, l’original reste intact.</span>
            </div>
          )}
          {p && busy && <p className="eetf-muted" role="status">{p.text}</p>}
          {note && <p className={note.startsWith('Aperçu PNG créé') ? 'eetf-muted' : 'eetf-error'} role="status" data-testid="eetf-reader-preview-status">{note}</p>}
        </div>
      )}
      <EetfAssetMetadata details={details} previewAssetId={previewId} />
    </div>
  );
}

/** Below a Neurone image opened in the reader: EETF provenance + "use as EETF source" (never automatic). */
export function EetfNeuronImageStrip({ imageId }: { imageId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [links, setLinks] = useState<EetfLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const gif = /\.gif$/i.test(imageId);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await eetfClient.status().catch(() => null);
      if (!alive) return;
      setEnabled(Boolean(s?.enabled));
      if (s?.enabled) { const l = await eetfClient.linksForNeuronImage(imageId).catch(() => []); if (alive) setLinks(l); }
    })();
    return () => { alive = false; };
  }, [imageId]);
  const reason = enabled === false ? 'EETF désactivé (certification en cours) : envoi indisponible.' : gif ? 'GIF non pris en charge par EETF (PNG, JPEG, WebP).' : null;
  async function send() {
    setBusy(true); setMessage(null);
    try {
      const r = await sendNeuronImageToEetf(imageId);
      setMessage({ text: `Image ${r.existed ? 'déjà présente dans' : 'ajoutée à'} EETF comme source (asset ${short(r.asset.id)}). Ouvrez le générateur d’images → Textures ou Environnements pour l’utiliser.` });
      setLinks(await eetfClient.linksForNeuronImage(imageId).catch(() => links));
    } catch (e) { setMessage({ text: toIntegrationError(e).message, error: true }); } finally { setBusy(false); }
  }
  return (
    <div className="eetf-strip" role="region" aria-label="EETF — textures et environnements" data-testid="eetf-neuron-strip" data-enabled={enabled === null ? 'unknown' : String(enabled)}>
      {links.filter(l => l.direction === 'EXPORT').map(l => (
        <span key={l.id} className="eetf-muted" data-testid="eetf-neuron-provenance">Copie de l’asset EETF {short(l.assetId)} — {l.verification === 'SERVER_RESOLVED' ? 'octets vérifiés par Docteur' : 'empreinte identique'}</span>
      ))}
      <button type="button" className="eetf-btn" data-testid="eetf-neuron-send" disabled={busy || enabled !== true || gif} aria-describedby={reason ? 'eetf-neuron-reason' : undefined} onClick={() => { void send(); }}>
        Utiliser comme source EETF
      </button>
      {reason && <span id="eetf-neuron-reason" className="eetf-reason" data-testid="eetf-neuron-reason">{reason}</span>}
      <span role="status" aria-live="polite" className={message?.error ? 'eetf-error' : 'eetf-muted'} data-testid="eetf-neuron-status">{message?.text ?? ''}</span>
    </div>
  );
}
