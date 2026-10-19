// EETF V1 — EETF-7 client for /api/image-generation/eetf (separate from lib/cortex/client.ts on purpose).
// Asset URLs are built ONLY from a validated asset id (never file:, javascript:, data: or a remote URL).

const BASE = `${window.location.protocol}//${window.location.hostname}:3001/api/image-generation/eetf`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type JobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type MapStatus = 'GENERATED' | 'DERIVED' | 'ESTIMATED' | 'USER_CONSTANT' | 'FROM_SOURCE_ALPHA' | 'UNSUPPORTED';
export type ProviderState = 'UNAVAILABLE' | 'AVAILABLE' | 'DEGRADED' | 'MISCONFIGURED' | 'REFUSED';
export type EnvironmentType = 'BACKGROUND' | 'SCENE_REFERENCE' | 'PANORAMA_REFERENCE' | 'SKYBOX_PREVIEW';

export interface EetfStatus {
  enabled: boolean;
  reason?: string;
  provider?: { id: string; displayName: string; locality: string; status: ProviderState; reason: string | null; capabilities: string[]; models: string[]; engineVersion: string | null };
  generation?: { available: boolean; reason: string | null };
  local?: { ffmpeg: { available: boolean; version: string | null } };
  contract?: { mapStatuses: Record<string, MapStatus[]>; environmentTypes: EnvironmentType[]; unsupportedEnvironmentTypes: string[]; pbrCompleteReachable: false; seamlessClaims: false };
  limits?: { maxFileSize: number; maxImportSide: number; maxGenerationSide: number; previewFov: [number, number]; panoramaMinWidth: number; panoramaRatioTolerance: number };
}
export interface EetfAsset { id: string; role: 'SOURCE' | 'GENERATED' | 'DERIVED'; format: string; mime: string; width: number; height: number; hasAlpha: boolean; dynamicRange: string; sizeBytes: number; displayName: string | null; sourceJobId: string | null; createdAt: string; sha256: string }
export interface EetfJob { id: string; kind: 'GENERATE' | 'DERIVE' | 'EXPORT'; status: JobStatus; provider: string | null; model: string | null; params: Record<string, unknown>; progress: number; error: { code: string; message: string | null } | null; retryOf: string | null; attempt: number; createdAt: string; startedAt: string | null; completedAt: string | null; failedAt: string | null; cancelledAt: string | null; outputAssetIds: string[] }
export interface AssetSource { assetId: string; role: string; format: string; width: number; height: number; hasAlpha: boolean; createdAt: string; sourceJobId: string | null; jobKind: string | null; operation: string | null; provider: string | null; model: string | null; engineVersion: string | null; derivedFrom: string[]; parameters: Record<string, unknown> | null }
export interface MaterialMap { role: string; status: MapStatus; exists: boolean; source?: AssetSource; value?: number | number[]; decidedBy?: string | null; reason?: string | null; decidedAt?: string | null; colorSpace?: string; channel?: string;
  tile?: { status: string; method?: string; version?: number; horizontalScore?: number; verticalScore?: number; seamScore?: number };
  alpha?: { alphaClass: string } | null; variants?: { variantId: string; assetId: string; operation: string; params: Record<string, unknown> }[] }
export interface EetfMaterial { materialId: string; textureSetId: string; name: string; status: string; createdAt: string;
  baseColor: MaterialMap; normal: MaterialMap; roughness: MaterialMap; metallic: MaterialMap; height: MaterialMap; ao: MaterialMap; opacity: MaterialMap; emissive: MaterialMap;
  preview: { assetId: string; purpose: string } | null; claims: { pbrComplete: false; seamless: false; seamlessTextureCapability: false } }
export interface EetfEnvironment { id: string; assetId: string; type: EnvironmentType; projection: string; dynamicRange: string; labels: string[]; claims: Record<string, false>; createdAt: string; basedOnEnvironmentId: string | null;
  report: (Record<string, unknown> & { warnings?: string[]; previewAssetId?: string | null; preview?: { yaw: number; pitch: number; fov: number; width: number; height: number } }) | null;
  asset: { assetId: string; role: string; format: string; width: number; height: number; dynamicRange: string; createdAt: string };
  provenance: { provider: string; model: string | null; prompt: string | null; seed: number | null; width: number | null; height: number | null; operation: string | null; jobKind: string | null; createdAt: string } | null }
// [EETF-8] integrations (Media Studio, Media Reader, Neurone)
export type LinkSystem = 'MEDIA_STUDIO' | 'NEURON_IMAGE';
export interface EetfLink { id: string; assetId?: string; direction: 'IMPORT' | 'EXPORT'; system: LinkSystem; ref: { projectId?: string; mediaAssetId?: string; imageId?: string }; verification: 'SERVER_RESOLVED' | 'CONTENT_SHA256_MATCH'; createdAt: string }
export interface EetfAssetIntegration {
  links: EetfLink[];
  usages: { textureMaps: { textureSetId: string; role: string; status: string }[]; environments: { environmentId: string; type: string; projection: string; dynamicRange: string }[]; derivedFrom: { assetId: string; operation: string }[] };
  classification: string[];
  preview: { native: boolean; variant: { assetId: string; operation: string } | null };
}
export interface EetfAssetDetails { asset: EetfAsset; source: AssetSource; integration: EetfAssetIntegration }
export interface ImportResult { asset: EetfAsset; existed: boolean; link: EetfLink; linkExisted: boolean }
export interface CancelResult { job: EetfJob; interruptRequired: boolean; gpuStopGuaranteed: boolean | null; note: string | null }

export class EetfApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.name = 'EetfApiError'; this.code = code; this.status = status; }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, init); } catch { throw new EetfApiError('NETWORK', 'Serveur Docteur injoignable.', 0); }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty / non-JSON body */ }
  if (!res.ok) {
    const b = (body ?? {}) as { error_code?: string; message?: string };
    throw new EetfApiError(typeof b.error_code === 'string' ? b.error_code : `HTTP_${res.status}`, typeof b.message === 'string' ? b.message : '', res.status);
  }
  return body as T;
}
const post = <T>(path: string, data: unknown) => call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** Browsers report no MIME type for .exr / .hdr: declare it from the extension (the server still sniffs the content). */
export function uploadMime(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return ({ exr: 'image/x-exr', hdr: 'image/vnd.radiance', tif: 'image/tiff', tiff: 'image/tiff', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

export function isAssetId(id: unknown): id is string { return typeof id === 'string' && UUID_RE.test(id); }
/** [EETF-8] An EETF asset file URL (exactly the route built by eetfAssetUrl, on the EETF API origin) → its asset id. */
export function eetfAssetIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    const base = new URL(BASE);
    if (u.origin !== base.origin || u.search || u.hash) return null;
    const m = /^\/api\/image-generation\/eetf\/assets\/([0-9a-f-]{36})\/file$/.exec(u.pathname);
    return m && isAssetId(m[1]) ? m[1] : null;
  } catch { return null; }
}
/** The only way the UI builds an image URL for an EETF asset. */
export function eetfAssetUrl(id: string): string {
  if (!isAssetId(id)) throw new EetfApiError('INVALID_ID', 'identifiant d’asset invalide', 0);
  return `${BASE}/assets/${id}/file`;
}

export const eetfClient = {
  status: (refresh = false) => call<EetfStatus>(`/status${refresh ? '?refresh=1' : ''}`),
  listAssets: () => call<{ assets: EetfAsset[] }>('/assets?limit=60').then(r => r.assets),
  uploadAsset: (file: File) => call<{ asset: EetfAsset; existed: boolean }>(`/assets?name=${encodeURIComponent(file.name.slice(0, 120))}`, { method: 'POST', headers: { 'Content-Type': uploadMime(file) }, body: file }),
  listJobs: () => call<{ jobs: EetfJob[] }>('/jobs?limit=30').then(r => r.jobs),
  cancelJob: (id: string) => post<CancelResult>(`/jobs/${encodeURIComponent(id)}/cancel`, {}),
  derive: (req: { sourceAssetId: string; operation: 'RESIZE' | 'CROP' | 'THUMBNAIL' | 'CONVERT' | 'TILE_PREVIEW'; [k: string]: unknown }) => post<{ job: EetfJob }>('/derive', req).then(r => r.job),
  generate: (req: Record<string, unknown>) => post<{ job: EetfJob }>('/generate', req).then(r => r.job),
  createMaterial: (req: { name: string; baseColorAssetId: string; roughness?: { value: number; reason?: string } | null; metallic?: { value: number; reason?: string } | null; opacity?: 'FROM_SOURCE_ALPHA' | 'NONE'; preview?: false | { grid: 2 | 3 } }) => post<{ material: EetfMaterial }>('/materials', req).then(r => r.material),
  createEnvironment: (type: EnvironmentType, assetId: string) => post<{ environment: EetfEnvironment }>('/environments', { type, assetId }).then(r => r.environment),
  // [EETF-8]
  assetDetails: (id: string) => { if (!isAssetId(id)) throw new EetfApiError('INVALID_ID', 'identifiant d’asset invalide', 0); return call<EetfAssetDetails>(`/assets/${id}`); },
  getJob: (id: string) => call<{ job: EetfJob }>(`/jobs/${encodeURIComponent(id)}`).then(r => r.job),
  importNeuronImage: (imageId: string) => post<ImportResult>('/imports/neuron-image', { imageId }),
  importMediaStudio: (blob: Blob, meta: { projectId: string; mediaAssetId: string; sha256: string; name: string; mime: string }) => {
    const q = new URLSearchParams({ projectId: meta.projectId, mediaAssetId: meta.mediaAssetId, sha256: meta.sha256, name: meta.name.slice(0, 120) });
    return call<ImportResult>(`/imports/media-studio?${q.toString()}`, { method: 'POST', headers: { 'Content-Type': meta.mime }, body: blob });
  },
  recordExport: (assetId: string, body: { system: LinkSystem; ref: EetfLink['ref']; sha256?: string }) => post<{ link: EetfLink; existed: boolean }>(`/assets/${encodeURIComponent(assetId)}/exports`, body),
  linksForNeuronImage: (imageId: string) => call<{ links: EetfLink[] }>(`/links?${new URLSearchParams({ system: 'NEURON_IMAGE', imageId }).toString()}`).then(r => r.links),
  createSkybox: (panoramaId: string, params: { yaw: number; pitch: number; fov: number; width?: number; height?: number; renderView?: boolean }) => post<{ environment: EetfEnvironment }>(`/environments/${encodeURIComponent(panoramaId)}/skybox`, params).then(r => r.environment),
};

/** Technical code → useful French message (never a stack, path, SQL or policy internals). */
const MESSAGES: Record<string, string> = {
  EETF_DISABLED: 'EETF est désactivé tant que sa certification n’est pas terminée.',
  LOCAL_PROVIDER_UNAVAILABLE: 'ComfyUI local non disponible : la génération IA est désactivée (aucun envoi cloud).',
  PROVIDER_UNAVAILABLE: 'ComfyUI local non disponible.',
  PROVIDER_REFUSED: 'Fournisseur refusé (endpoint non local ou refus de la politique de sécurité).',
  PROVIDER_TIMEOUT: 'Le moteur local n’a pas répondu à temps.',
  PROVIDER_NOT_READY: 'Le moteur local répond mais n’est pas prêt (modèle ou nœud manquant).',
  CAPABILITY_UNSUPPORTED: 'Le moteur local ne propose pas cette capacité.',
  MODEL_NOT_FOUND: 'Modèle introuvable dans la liste fournie par le moteur.',
  VRAM_GUARD: 'Demande trop lourde pour la mémoire GPU (estimation provisoire).',
  WORKFLOW_INVALID: 'Paramètres de génération refusés.',
  PIXEL_LIMIT: 'Image trop grande pour le budget de pixels.',
  IMAGE_TOO_LARGE: 'Image trop grande pour le budget de pixels.',
  FILE_TOO_LARGE: 'Fichier trop volumineux.',
  DISK_LIMIT: 'Espace disque insuffisant.',
  TEMP_QUOTA: 'Quota temporaire dépassé : réessayez après la fin des tâches en cours.',
  INVALID_SOURCE: 'Image source invalide ou modifiée.',
  OUTPUT_INVALID: 'Le résultat produit est invalide et a été refusé.',
  OUTPUT_MISSING: 'Aucun résultat produit.',
  TRANSCODE_FAILED: 'L’image n’a pas pu être lue ou convertie.',
  MIME_MISMATCH: 'Le type du fichier ne correspond pas à son contenu.',
  UNSUPPORTED_FORMAT: 'Format non pris en charge (PNG, JPEG, WebP, TIFF, EXR, HDR).',
  UNSUPPORTED_MIME: 'Format non pris en charge (PNG, JPEG, WebP, TIFF, EXR, HDR).',
  MALFORMED_IMAGE: 'Image corrompue ou illisible.',
  ENGINE_BUSY: 'Une opération est déjà en cours ; réessayez dans un instant.',
  CANCELLED: 'Opération annulée.',
  CANCELLED_BY_USER: 'Opération annulée.',
  TIMEOUT: 'Opération trop longue : arrêtée.',
  NO_SOURCE_ALPHA: 'La base color n’a pas de transparence réelle : l’opacité reste non prise en charge.',
  PANORAMA_ASPECT: 'Un panorama de référence doit être proche du 2:1.',
  PANORAMA_TOO_SMALL: 'Panorama trop petit (largeur minimale insuffisante).',
  ENVIRONMENT_TYPE_UNSUPPORTED: 'Type non pris en charge en V1 (HDRI, équirectangulaire certifié, cubemap, scène 3D).',
  INVALID_PREVIEW: 'Paramètres d’aperçu hors bornes.',
  INVALID_CONSTANT: 'Valeur invalide : un nombre entre 0 et 1 est attendu.',
  NETWORK: 'Serveur Docteur injoignable.',
  // [EETF-8] integration vocabulary
  UNSUPPORTED_MEDIA: 'Média non pris en charge : le contenu n’est pas une image PNG, JPEG, WebP, TIFF, EXR ou HDR valide (vérifié sur les octets).',
  ASSET_NOT_FOUND: 'Asset EETF introuvable.',
  SOURCE_UNAVAILABLE: 'Source indisponible : le fichier d’origine a été supprimé ou déplacé.',
  FORMAT_UNSUPPORTED: 'Format non accepté par cette surface : créez d’abord un aperçu PNG (nouvel asset dérivé).',
  LINK_CONTENT_MISMATCH: 'La copie ne correspond pas octet pour octet à l’asset EETF.',
  INVALID_LINK: 'Référence d’intégration invalide.',
  INVALID_ID: 'Identifiant invalide.',
  // [EETF-CERT]
  NORMALISATION_IDENTICAL: 'Cette image est déjà identique à sa forme normalisée : passez-la d’abord par une dérivation (conversion) pour l’utiliser comme base color.',
  FFMPEG_UNAVAILABLE: 'FFmpeg local indisponible : le fichier ne peut pas être vérifié ni traité.',
  ROOT_POLICY_DENIED: 'Opération refusée par la politique de sécurité locale.',
  EETF_SOURCE_MISMATCH: 'Le fichier reçu ne correspond pas à l’asset EETF (empreinte SHA-256 différente).',
};
export function eetfErrorMessage(code: string | null | undefined): string {
  if (!code) return 'Erreur inconnue.';
  return MESSAGES[code] ?? MESSAGES[code.replace(/^EETF_/, '')] ?? `Opération refusée (${code.replace(/[^A-Z0-9_]/g, '').slice(0, 40)}).`;
}
export function messageOf(e: unknown): string { return e instanceof EetfApiError ? eetfErrorMessage(e.code) : 'Erreur inattendue.'; }
