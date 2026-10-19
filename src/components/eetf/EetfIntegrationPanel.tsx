// EETF V1 — EETF-8 integration panel for the selected asset (Textures / Environments tabs):
//   open it in the Media Reader (the same reader component as the rest of Docteur), copy it into a Media Studio project,
//   ask for a PNG preview when the browser cannot show the format, and show its provenance / exchanges.
// The Neurone side inserts EETF images from the neuron itself (image block → « Depuis EETF »): only the neuron editor
// may change a neuron, so nothing here writes to a neuron.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import MediaReader, { type MediaReaderRequest } from '../media/MediaReader';
import { cortexClient, type MediaProjectSummary } from '../../lib/cortex/client';
import { eetfAssetUrl, type EetfAssetDetails } from '../../lib/eetf/client';
import { assetDetails, createPngPreview, sendEetfAssetToMediaStudio, toIntegrationError } from '../../lib/eetf/bridges';
import { mediaStudioCompatibility, neuronCompatibility } from '../../lib/eetf/integration-model';
import { EetfAssetMetadata } from './EetfReaderPanel';
import type { EetfData } from './useEetfData';
import './eetf.css';

/** The Media Reader above the generator dialog: portal + focus kept inside + focus restored on close. */
function EetfReaderHost({ request, onClose, onSendToMediaStudio }: { request: MediaReaderRequest; onClose: () => void; onSendToMediaStudio: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = host.current;
    window.setTimeout(() => el?.querySelector<HTMLElement>('[data-testid="media-reader-close"]')?.focus(), 0);
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')).filter(x => x.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el?.addEventListener('keydown', trap);
    return () => { el?.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(
    <div ref={host} data-testid="eetf-reader-host">
      <MediaReader request={request} onClose={onClose} onSendToMediaStudio={onSendToMediaStudio} />
    </div>,
    document.body,
  );
}

export default function EetfIntegrationPanel({ assetId, data }: { assetId: string | null; data: EetfData }) {
  const enabled = Boolean(data.status?.enabled);
  const [details, setDetails] = useState<EetfAssetDetails | null>(null);
  const [projects, setProjects] = useState<MediaProjectSummary[] | null>(null);
  const [projectId, setProjectId] = useState<string>('');
  const [reader, setReader] = useState<MediaReaderRequest | null>(null);
  const [busy, setBusy] = useState<null | 'studio' | 'preview'>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!assetId || !enabled) { setDetails(null); return; }
    try { setDetails(await assetDetails(assetId)); } catch (e) { setDetails(null); setMessage({ text: toIntegrationError(e).message, error: true }); }
  }, [assetId, enabled]);
  useEffect(() => { setMessage(null); void reload(); }, [reload]);
  useEffect(() => {
    if (!enabled || projects) return;
    cortexClient.mediaStudioListProjects().then(r => setProjects(r.projects)).catch(() => setProjects([]));
  }, [enabled, projects]);

  if (!assetId) return null;
  const a = details?.asset ?? null;
  const studio = a ? mediaStudioCompatibility(a) : null;
  const neuron = a ? neuronCompatibility(a) : null;
  const native = details?.integration.preview.native ?? true;
  const hasPreview = Boolean(details?.integration.preview.variant);
  const disabledReason = !enabled ? 'EETF désactivé (certification en cours).' : null;

  async function toStudio() {
    if (!assetId) return;
    setBusy('studio'); setMessage(null);
    try {
      const r = await sendEetfAssetToMediaStudio(assetId, { projectId: projectId || null });
      setMessage({ text: `${r.existed ? 'Déjà présent dans' : 'Copié dans'} le projet « ${r.projectName} » du Media Studio${r.linkRecorded ? '' : ' (provenance EETF non enregistrée)'}. Ouvrez le Media Studio pour le monter.` });
      const list = await cortexClient.mediaStudioListProjects().catch(() => null);
      if (list) setProjects(list.projects);
      setProjectId(r.projectId);
      await reload();
    } catch (e) { setMessage({ text: toIntegrationError(e).message, error: true }); } finally { setBusy(null); }
  }
  async function preview() {
    if (!assetId) return;
    setBusy('preview'); setMessage(null);
    try {
      await createPngPreview(assetId);
      setMessage({ text: 'Aperçu PNG créé : nouvel asset dérivé (l’original n’est pas modifié).' });
      await Promise.all([reload(), data.refreshAssets(), data.refreshJobs()]);
    } catch (e) { setMessage({ text: toIntegrationError(e).message, error: true }); } finally { setBusy(null); }
  }

  return (
    <section className="eetf-card eetf-integrations" aria-label="Utiliser cet asset dans Docteur" data-testid="eetf-integrations" aria-busy={busy !== null}>
      <h3>Utiliser cet asset dans Docteur</h3>
      {disabledReason && <p className="eetf-reason" id="eetf-int-disabled">{disabledReason}</p>}
      <div className="eetf-row">
        <button type="button" className="eetf-btn" data-testid="eetf-open-reader" disabled={!enabled || !a} aria-describedby={disabledReason ? 'eetf-int-disabled' : undefined}
          onClick={() => { seq.current += 1; setReader({ requestId: seq.current, url: eetfAssetUrl(assetId), title: a?.displayName ?? `Asset ${assetId.slice(0, 8)}`, mimeType: a?.mime ?? null }); }}>
          Ouvrir dans le lecteur Docteur
        </button>
        {!native && !hasPreview && (
          <button type="button" className="eetf-btn ghost" data-testid="eetf-create-preview" disabled={!enabled || busy !== null} onClick={() => { void preview(); }}>
            Créer un aperçu PNG (tâche)
          </button>
        )}
      </div>
      <div className="eetf-row" style={{ marginTop: 8 }}>
        <label className="eetf-label" htmlFor="eetf-int-project" style={{ margin: 0 }}>Projet Media Studio</label>
        <select id="eetf-int-project" className="eetf-input" value={projectId} disabled={!enabled || busy !== null} onChange={e => setProjectId(e.target.value)}>
          <option value="">{projects?.length ? 'Projet le plus récent' : 'Nouveau projet « Projet — EETF »'}</option>
          {(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button type="button" className="eetf-btn" data-testid="eetf-send-studio" disabled={!enabled || !a || !studio?.ok || busy !== null}
          aria-describedby={studio && !studio.ok ? 'eetf-int-studio-reason' : disabledReason ? 'eetf-int-disabled' : undefined} onClick={() => { void toStudio(); }}>
          Envoyer au Media Studio
        </button>
        {studio && !studio.ok && <span id="eetf-int-studio-reason" className="eetf-reason" data-testid="eetf-studio-reason">{studio.reason}</span>}
      </div>
      <p className="eetf-muted" style={{ marginTop: 8 }} data-testid="eetf-neuron-hint">
        Neurone : dans un neurone, ajoutez un bloc Image puis « Depuis EETF ». {neuron && !neuron.ok ? `Cet asset n’est pas utilisable tel quel : ${neuron.reason}` : 'Cet asset est compatible (PNG, JPEG ou WebP, 5 Mo max).'}
      </p>
      <p role="status" aria-live="polite" className={message?.error ? 'eetf-error' : 'eetf-muted'} data-testid="eetf-integration-status">{message?.text ?? ''}</p>
      {details && <EetfAssetMetadata details={details} previewAssetId={details.integration.preview.variant?.assetId ?? null} />}
      {reader && (
        <EetfReaderHost request={reader} onClose={() => setReader(null)} onSendToMediaStudio={() => { setReader(null); void toStudio(); }} />
      )}
    </section>
  );
}
