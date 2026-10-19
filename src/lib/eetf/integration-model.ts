// EETF V1 — EETF-8 pure integration model (Media Studio, Media Reader, Neurone). No React, no network.
// Decides what each surface may receive and how an integration failure is told to the user. Wording follows the
// V1 contract: an EXR / HDR file holds LDR content ("LDR dans un conteneur HDR"), never "HDR" / "HDRI"; a 2:1 image
// stays a panorama REFERENCE.
import type { EetfAsset, EetfLink } from './client.ts';

/** Product error vocabulary of the integrations. */
export const INTEGRATION_CODES = Object.freeze([
  'UNSUPPORTED_MEDIA', 'INVALID_SOURCE', 'ASSET_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'PIXEL_LIMIT', 'FORMAT_UNSUPPORTED', 'ENGINE_BUSY', 'EETF_DISABLED',
] as const);
export type IntegrationCode = typeof INTEGRATION_CODES[number];

export const INTEGRATION_MESSAGES: Readonly<Record<IntegrationCode, string>> = Object.freeze({
  UNSUPPORTED_MEDIA: 'Média non pris en charge : le contenu n’est pas une image acceptée (vérifié sur les octets, pas sur le nom ni l’extension).',
  INVALID_SOURCE: 'Source invalide ou modifiée : son contenu ne correspond plus à l’original enregistré.',
  ASSET_NOT_FOUND: 'Asset introuvable.',
  SOURCE_UNAVAILABLE: 'Source indisponible : le fichier d’origine a été supprimé ou déplacé.',
  PIXEL_LIMIT: 'Image trop grande pour cette surface (taille ou nombre de pixels).',
  FORMAT_UNSUPPORTED: 'Format non accepté par cette surface : créez d’abord un aperçu PNG (nouvel asset dérivé, l’original reste intact).',
  ENGINE_BUSY: 'Une opération est déjà en cours ; réessayez dans un instant.',
  EETF_DISABLED: 'EETF est désactivé tant que sa certification n’est pas terminée.',
});

const FOLD: Readonly<Record<string, IntegrationCode>> = Object.freeze({
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA', UNSUPPORTED_MIME: 'UNSUPPORTED_MEDIA', UNSUPPORTED_FORMAT: 'UNSUPPORTED_MEDIA', MIME_MISMATCH: 'UNSUPPORTED_MEDIA',
  MALFORMED_IMAGE: 'UNSUPPORTED_MEDIA', EMPTY_FILE: 'UNSUPPORTED_MEDIA', CORRUPT_MEDIA: 'UNSUPPORTED_MEDIA',
  INVALID_SOURCE: 'INVALID_SOURCE', EETF_SOURCE_MISMATCH: 'INVALID_SOURCE', CHECKSUM_MISMATCH: 'INVALID_SOURCE', LINK_CONTENT_MISMATCH: 'INVALID_SOURCE', INVALID_ORIGIN: 'INVALID_SOURCE',
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND', NOT_FOUND: 'ASSET_NOT_FOUND', PROJECT_NOT_FOUND: 'ASSET_NOT_FOUND', HTTP_404: 'ASSET_NOT_FOUND',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE', ASSET_FILE_MISSING: 'SOURCE_UNAVAILABLE',
  PIXEL_LIMIT: 'PIXEL_LIMIT', IMAGE_TOO_LARGE: 'PIXEL_LIMIT', FILE_TOO_LARGE: 'PIXEL_LIMIT',
  FORMAT_UNSUPPORTED: 'FORMAT_UNSUPPORTED',
  ENGINE_BUSY: 'ENGINE_BUSY',
  EETF_DISABLED: 'EETF_DISABLED', HTTP_503: 'EETF_DISABLED',
});

/** Any backend / bridge code → one product code (null = not an integration code: the caller keeps its own message). */
export function integrationCode(raw: string | null | undefined): IntegrationCode | null {
  if (!raw) return null;
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 64);
  return FOLD[code] ?? FOLD[code.replace(/^EETF_/, '')] ?? null;
}
export function integrationMessage(raw: string | null | undefined, fallback = 'Opération impossible.'): string {
  const c = integrationCode(raw);
  return c ? INTEGRATION_MESSAGES[c] : fallback;
}

/** Formats every Docteur surface shows natively in an <img>. TIFF / EXR / HDR need a derived PNG preview. */
export const BROWSER_NATIVE = Object.freeze(['PNG', 'JPEG', 'WEBP']);
/** Neurone image store contract (lib/image.js): PNG / JPEG / WebP (GIF too, but EETF never produces GIF), ≤ 5 MB. */
export const NEURON_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const NEURON_MIME: Readonly<Record<string, string>> = Object.freeze({ PNG: 'image/png', JPEG: 'image/jpeg', WEBP: 'image/webp' });

export type Compatibility = { ok: true } | { ok: false; code: IntegrationCode; reason: string };
const no = (code: IntegrationCode, reason: string): Compatibility => ({ ok: false, code, reason });

/** Can this EETF asset become a Neurone image block (copy into the Neurone image store)? */
export function neuronCompatibility(a: Pick<EetfAsset, 'format' | 'sizeBytes'>): Compatibility {
  if (!BROWSER_NATIVE.includes(a.format)) return no('FORMAT_UNSUPPORTED', `${a.format} n’est pas une image de neurone (PNG, JPEG, WebP) : créez d’abord un aperçu PNG.`);
  if (a.sizeBytes > NEURON_IMAGE_MAX_BYTES) return no('PIXEL_LIMIT', 'Plus de 5 Mo : au-delà de la limite des images de neurone.');
  return { ok: true };
}
/** Can this EETF asset be sent to the Media Studio (its importer accepts PNG / JPEG / WebP / GIF images)? */
export function mediaStudioCompatibility(a: Pick<EetfAsset, 'format'>): Compatibility {
  return BROWSER_NATIVE.includes(a.format) ? { ok: true } : no('FORMAT_UNSUPPORTED', `Le Media Studio n’accepte pas le ${a.format} : envoyez un aperçu PNG dérivé.`);
}
/** Can a Media Studio asset become an EETF source? (kind decided by the studio from the bytes; GIF is not an EETF format) */
export function studioAssetToEetfCompatibility(a: { kind: string; file: string }): Compatibility {
  if (a.kind !== 'image') return no('UNSUPPORTED_MEDIA', 'Seules les images peuvent servir de source de texture ou d’environnement.');
  const ext = a.file.split('.').pop()?.toLowerCase() ?? '';
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return no('UNSUPPORTED_MEDIA', 'GIF non pris en charge par EETF (PNG, JPEG, WebP).');
  return { ok: true };
}
/** MIME of a Media Studio image file (its extension was chosen by the studio from the sniffed bytes). */
export function studioFileMime(file: string): string | null {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext] ?? null;
}

export function roleLabel(role: string): string {
  return ({ SOURCE: 'SOURCE — image importée', GENERATED: 'GENERATED — générée par IA locale', DERIVED: 'DERIVED — dérivée localement' } as Record<string, string>)[role] ?? 'Rôle inconnu';
}
export function dynamicRangeLabel(dr: string): string {
  return dr === 'LDR_CONTENT_IN_HDR_CONTAINER' ? 'LDR_CONTENT_IN_HDR_CONTAINER — contenu LDR dans un conteneur HDR (pas un HDRI)' : 'LDR';
}
const CLASS_TEXT: Record<string, string> = {
  TEXTURE_BASE_COLOR: 'Texture — Base Color', TEXTURE_OPACITY: 'Texture — Opacity (alpha de la base color)',
  ENVIRONMENT_BACKGROUND: 'Environnement — arrière-plan', ENVIRONMENT_SCENE_REFERENCE: 'Environnement — référence de scène',
  ENVIRONMENT_PANORAMA_REFERENCE: 'Environnement — panorama de référence (projection non certifiée)', ENVIRONMENT_SKYBOX_PREVIEW: 'Environnement — aperçu skybox (aperçu uniquement)',
};
export function classificationLabel(c: string): string { return CLASS_TEXT[c] ?? c.replace(/[^A-Z0-9_]/g, '').slice(0, 60); }

const short = (id?: string) => (id ? id.slice(0, 8) : '?');
export function linkLabel(l: Pick<EetfLink, 'direction' | 'system' | 'ref' | 'verification'>): string {
  const where = l.system === 'MEDIA_STUDIO' ? `Media Studio (projet ${short(l.ref.projectId)}…, média ${short(l.ref.mediaAssetId)}…)` : `image de neurone ${short(l.ref.imageId)}…`;
  const proof = l.verification === 'SERVER_RESOLVED' ? 'lu et vérifié par Docteur' : 'empreinte SHA-256 identique';
  return `${l.direction === 'IMPORT' ? 'Importé depuis' : 'Copié vers'} ${where} — ${proof}`;
}

/** Provenance handed to the Media Studio with an EETF asset (ids / hash / enums only). */
export function studioOriginOf(a: { id: string; sha256: string; role: string; format: string; sourceJobId: string | null; createdAt: string }, source: { operation: string | null; derivedFrom: string[] } | null) {
  return { type: 'eetf' as const, assetId: a.id, sha256: a.sha256, role: a.role, format: a.format, jobId: a.sourceJobId, operation: source?.operation ?? null, createdAt: a.createdAt, derivedFrom: (source?.derivedFrom ?? []).slice(0, 8) };
}
