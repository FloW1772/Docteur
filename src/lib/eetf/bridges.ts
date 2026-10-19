// EETF V1 — EETF-8 bridges between EETF and the existing surfaces (Media Studio, Neurone image blocks, Media Reader).
// Only Docteur's own routes are read (EETF asset by validated id, Media Studio asset route, Neurone image store):
// never a remote URL, a file: / data: / javascript: URL or a local path. Every receiving side re-checks the bytes
// (EETF and Media Studio sniff + hash server-side). Sources are only read, never modified.
import { cortexClient, type MediaAsset, type MediaProjectView } from '../cortex/client';
import { EetfApiError, eetfAssetUrl, eetfClient, isAssetId, type EetfAssetDetails, type EetfJob, type ImportResult } from './client';
import {
  INTEGRATION_MESSAGES, integrationCode, mediaStudioCompatibility, neuronCompatibility, studioAssetToEetfCompatibility, studioFileMime, studioOriginOf,
  NEURON_MIME, type IntegrationCode,
} from './integration-model';

export class IntegrationError extends Error {
  readonly code: IntegrationCode | 'OTHER';
  constructor(code: IntegrationCode | 'OTHER', message: string) { super(message); this.name = 'IntegrationError'; this.code = code; }
}
/** Any failure (EETF API, Media Studio API, fetch) → a product code + a clear French message. */
export function toIntegrationError(e: unknown): IntegrationError {
  if (e instanceof IntegrationError) return e;
  if ((e as Error)?.name === 'AbortError') return new IntegrationError('OTHER', 'Opération annulée.');
  const raw = e instanceof EetfApiError ? e.code : (e as { code?: string })?.code;
  const code = integrationCode(raw);
  if (code) return new IntegrationError(code, INTEGRATION_MESSAGES[code]);
  if (e instanceof EetfApiError && e.code === 'NETWORK') return new IntegrationError('OTHER', 'Serveur Docteur injoignable.');
  return new IntegrationError('OTHER', (e as Error)?.message && !(e instanceof EetfApiError) ? String((e as Error).message).slice(0, 200) : 'Opération impossible.');
}
const fail = (code: IntegrationCode, message?: string): never => { throw new IntegrationError(code, message ?? INTEGRATION_MESSAGES[code]); };

/** Reads one of Docteur's own files; a JSON error body is turned into its code (never shown raw). */
async function readOwnFile(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error_code?: string; error?: { code?: string } } | null;
    throw toIntegrationError({ code: body?.error_code ?? body?.error?.code ?? `HTTP_${res.status}` });
  }
  return res.blob();
}
async function sha256Hex(blob: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
const EXT: Record<string, string> = { PNG: 'png', JPEG: 'jpg', WEBP: 'webp' };
const fileNameOf = (d: EetfAssetDetails) => {
  const base = (d.asset.displayName ?? `eetf-${d.asset.id.slice(0, 8)}`).replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 100) || 'eetf';
  return `${base}.${EXT[d.asset.format] ?? 'png'}`;
};

export async function assetDetails(assetId: string): Promise<EetfAssetDetails> {
  if (!isAssetId(assetId)) fail('ASSET_NOT_FOUND');
  try { return await eetfClient.assetDetails(assetId); } catch (e) { throw toIntegrationError(e); }
}

// ── EETF → Media Studio ─────────────────────────────────────────────────────────────────────────────────────────────

export interface StudioSendResult { projectId: string; projectName: string; mediaAsset: MediaAsset; existed: boolean; linkRecorded: boolean }

/**
 * Copies an EETF image into a Media Studio project (the studio owns its project files). Same bytes already in that
 * project → the existing studio asset is reused, nothing is uploaded. The studio re-hashes the bytes against the
 * EETF SHA-256 and keeps the EETF provenance on its asset; EETF records the export link.
 */
export async function sendEetfAssetToMediaStudio(assetId: string, { projectId = null, signal, onStep }: { projectId?: string | null; signal?: AbortSignal; onStep?: (s: string) => void } = {}): Promise<StudioSendResult> {
  try {
    const d = await assetDetails(assetId);
    const compat = mediaStudioCompatibility(d.asset);
    if (!compat.ok) fail(compat.code, compat.reason);
    let view: MediaProjectView;
    if (projectId) view = await cortexClient.mediaStudioGetProject(projectId);
    else {
      const list = (await cortexClient.mediaStudioListProjects()).projects;
      view = list[0] ? await cortexClient.mediaStudioGetProject(list[0].id) : await cortexClient.mediaStudioCreateProject('Projet — EETF');
    }
    const pid = view.project.id;
    let mediaAsset = view.project.assets.find(a => a.sha256 === d.asset.sha256) ?? null;
    let existed = Boolean(mediaAsset);
    if (!mediaAsset) {
      onStep?.('Lecture de l’asset EETF…');
      const blob = await readOwnFile(eetfAssetUrl(assetId), signal);
      onStep?.('Copie dans le Media Studio…');
      // client.ts (a file shared with the staged KG work) types only the Media Reader origin: the EETF origin is
      // validated by the studio server (ids / hash / enums) and the bytes are re-hashed against it.
      const origin = studioOriginOf(d.asset, d.source) as unknown as { type: 'media-reader'; url: string };
      const r = await cortexClient.mediaStudioUpload(pid, blob, fileNameOf(d), { signal, origin }) as MediaProjectView & { asset: MediaAsset; existed?: boolean };
      mediaAsset = r.asset;
      existed = r.existed === true;
      view = r;
    }
    let linkRecorded = true;
    try { await eetfClient.recordExport(assetId, { system: 'MEDIA_STUDIO', ref: { projectId: pid, mediaAssetId: mediaAsset.id }, sha256: mediaAsset.sha256 }); } catch { linkRecorded = false; }
    return { projectId: pid, projectName: view.project.name, mediaAsset, existed, linkRecorded };
  } catch (e) { throw toIntegrationError(e); }
}

// ── Media Studio → EETF ─────────────────────────────────────────────────────────────────────────────────────────────

/** A Media Studio image becomes an EETF SOURCE asset (content-addressed: same bytes → the existing asset + a new link). */
export async function sendStudioAssetToEetf(projectId: string, a: MediaAsset, { signal }: { signal?: AbortSignal } = {}): Promise<ImportResult> {
  try {
    const compat = studioAssetToEetfCompatibility(a);
    if (!compat.ok) fail(compat.code, compat.reason);
    const mime = studioFileMime(a.file);
    if (!mime) fail('UNSUPPORTED_MEDIA');
    const blob = await readOwnFile(cortexClient.mediaStudioAssetUrl(projectId, a.id), signal);
    return await eetfClient.importMediaStudio(blob, { projectId, mediaAssetId: a.id, sha256: a.sha256, name: a.name, mime: mime as string });
  } catch (e) { throw toIntegrationError(e); }
}

// ── EETF → Neurone image block ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Prepares an EETF image for the Neurone image block contract (`onUploadImage(file)` → image id). The bytes are
 * checked against the asset SHA-256 before leaving EETF. The caller inserts the returned id, then calls
 * recordNeuronExport (the server re-reads the Neurone copy and checks it is byte-identical).
 */
export async function eetfAssetAsNeuronFile(assetId: string, { signal }: { signal?: AbortSignal } = {}): Promise<{ file: File; details: EetfAssetDetails }> {
  try {
    const d = await assetDetails(assetId);
    const compat = neuronCompatibility(d.asset);
    if (!compat.ok) fail(compat.code, compat.reason);
    const blob = await readOwnFile(eetfAssetUrl(assetId), signal);
    const hash = await sha256Hex(blob);
    if (hash !== null && hash !== d.asset.sha256) fail('INVALID_SOURCE');
    return { file: new File([blob], fileNameOf(d), { type: NEURON_MIME[d.asset.format] }), details: d };
  } catch (e) { throw toIntegrationError(e); }
}
export async function recordNeuronExport(assetId: string, imageId: string): Promise<boolean> {
  try { await eetfClient.recordExport(assetId, { system: 'NEURON_IMAGE', ref: { imageId } }); return true; } catch { return false; }
}

// ── Neurone image → EETF ────────────────────────────────────────────────────────────────────────────────────────────

export async function sendNeuronImageToEetf(imageId: string): Promise<ImportResult> {
  try { return await eetfClient.importNeuronImage(imageId); } catch (e) { throw toIntegrationError(e); }
}

// ── previews for formats the browser cannot show (TIFF / EXR / HDR) ────────────────────────────────────────────────

/** Submits a CONVERT → PNG job through the existing EETF job system and waits for it (new DERIVED asset; source untouched). */
export async function createPngPreview(assetId: string, { signal, timeoutMs = 90_000, onJob }: { signal?: AbortSignal; timeoutMs?: number; onJob?: (j: EetfJob) => void } = {}): Promise<string> {
  try {
    let job = await eetfClient.derive({ sourceAssetId: assetId, operation: 'CONVERT', format: 'PNG' });
    onJob?.(job);
    const started = Date.now();
    while (job.status === 'QUEUED' || job.status === 'RUNNING') {
      if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
      if (Date.now() - started > timeoutMs) throw new IntegrationError('OTHER', 'Aperçu trop long à produire : consultez la liste des tâches EETF.');
      await new Promise(r => setTimeout(r, 400));
      job = await eetfClient.getJob(job.id);
      onJob?.(job);
    }
    if (job.status !== 'COMPLETED' || !job.outputAssetIds[0]) throw toIntegrationError({ code: job.error?.code ?? 'INVALID_SOURCE' });
    return job.outputAssetIds[0];
  } catch (e) { throw toIntegrationError(e); }
}
