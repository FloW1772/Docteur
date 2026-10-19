// EETF V1 — EETF-7 pure view model (labels / statuses) shared by the EETF UI. No React, no network.
// Single place where wording is decided, so that no surface can say "PBR complete", "seamless",
// "HDRI", "cubemap" or "3D scene" for a V1 result.
import type { EetfJob, EetfStatus, MaterialMap, MapStatus } from './client.ts';

export const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  BASE_COLOR: 'Base Color', NORMAL: 'Normal', ROUGHNESS: 'Roughness', METALLIC: 'Metallic',
  HEIGHT: 'Height', AMBIENT_OCCLUSION: 'AO', OPACITY: 'Opacity', EMISSIVE: 'Emissive',
});
export const MAP_ORDER = ['baseColor', 'normal', 'roughness', 'metallic', 'height', 'ao', 'opacity', 'emissive'] as const;

const STATUS_TEXT: Record<MapStatus, string> = {
  GENERATED: 'GENERATED', DERIVED: 'DERIVED', ESTIMATED: 'ESTIMATED', USER_CONSTANT: 'USER_CONSTANT', FROM_SOURCE_ALPHA: 'FROM_SOURCE_ALPHA', UNSUPPORTED: 'UNSUPPORTED',
};
export function mapStatusLabel(status: string): string { return (STATUS_TEXT as Record<string, string>)[status] ?? 'UNSUPPORTED'; }

export function mapDetail(m: MaterialMap): string {
  switch (m.status) {
    case 'UNSUPPORTED': return 'Non pris en charge en V1 — aucune carte produite.';
    case 'USER_CONSTANT': return `Constante utilisateur : ${Array.isArray(m.value) ? m.value.map(v => v.toFixed(2)).join(', ') : Number(m.value).toFixed(2)} (pas une carte générée).`;
    case 'FROM_SOURCE_ALPHA': return 'Canal alpha réel de la base color (pas de fichier séparé).';
    case 'GENERATED': return `Généré par ${m.source?.provider ?? 'un fournisseur local'}${m.source?.model ? ` (${m.source.model})` : ''}.`;
    case 'DERIVED': return `Dérivé localement (${m.source?.operation ?? 'opération locale'}) depuis l’image source.`;
    default: return 'Estimation non prise en charge en V1.';
  }
}

/** V1 material statuses. Anything else (e.g. a "PBR complete" value) is shown as refused, never as a capability. */
export function materialStatusLabel(status: string): string {
  switch (status) {
    case 'PARTIAL_MATERIAL': return 'Matériau partiel';
    case 'BASE_COLOR_ONLY': return 'Base color seule';
    case 'EMPTY': return 'Matériau vide';
    default: return 'Statut non reconnu (refusé en V1)';
  }
}

export function seamStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'LOW_SEAM': return 'LOW_SEAM — raccord faible mesuré (pas une garantie)';
    case 'HIGH_SEAM': return 'HIGH_SEAM — raccord marqué';
    case 'MEASURED': return 'MEASURED — raccord intermédiaire';
    default: return 'UNKNOWN — non mesuré';
  }
}

const WARNING_TEXT: Record<string, string> = {
  NOT_CERTIFIED_EQUIRECTANGULAR: 'NOT_CERTIFIED_EQUIRECTANGULAR — projection non vérifiée',
  NOT_EXACT_2_TO_1: 'NOT_EXACT_2_TO_1 — ratio proche mais pas exact',
  HIGH_HORIZONTAL_SEAM: 'HIGH_HORIZONTAL_SEAM — raccord gauche/droite marqué',
  HORIZONTAL_SEAM_NOT_LOW: 'HORIZONTAL_SEAM_NOT_LOW — raccord gauche/droite non faible',
  POLE_ROWS_NOT_UNIFORM: 'POLE_ROWS_NOT_UNIFORM — pôles non uniformes',
  HAS_TRANSPARENCY: 'HAS_TRANSPARENCY — image avec transparence',
  LDR_CONTENT_IN_HDR_CONTAINER: 'LDR_CONTENT_IN_HDR_CONTAINER — contenu LDR, pas un HDRI',
  PREVIEW_ONLY: 'PREVIEW_ONLY — aperçu, pas une caméra de scène',
  NOT_SEAM_VERIFIED: 'NOT_SEAM_VERIFIED — raccord non mesuré',
  LOW_HORIZONTAL_SEAM_MEASURED: 'LOW_HORIZONTAL_SEAM_MEASURED — mesure, pas une garantie',
};
export function warningLabel(code: string): string { return WARNING_TEXT[code] ?? code.replace(/[^A-Z0-9_]/g, '').slice(0, 60); }

export const JOB_LABELS: Readonly<Record<string, string>> = Object.freeze({ QUEUED: 'En file d’attente', RUNNING: 'En cours', COMPLETED: 'Terminé', FAILED: 'Échec', CANCELLED: 'Annulé' });

/** Honest progress: a percentage only while RUNNING with a reported value; otherwise indeterminate. */
export function progressInfo(job: Pick<EetfJob, 'status' | 'progress'>): { determinate: boolean; percent: number | null; text: string } {
  if (job.status === 'COMPLETED') return { determinate: true, percent: 100, text: 'Terminé' };
  if (job.status === 'RUNNING' && job.progress > 0) { const p = Math.round(job.progress * 100); return { determinate: true, percent: p, text: `En cours — ${p} %` }; }
  if (job.status === 'RUNNING') return { determinate: false, percent: null, text: 'En cours — progression inconnue' };
  return { determinate: false, percent: null, text: JOB_LABELS[job.status] ?? job.status };
}

export function providerStateLabel(status: EetfStatus | null): { tone: 'ok' | 'warn' | 'off'; text: string } {
  const p = status?.provider;
  if (!status?.enabled) return { tone: 'off', text: 'EETF désactivé (certification en cours)' };
  if (!p) return { tone: 'off', text: 'État du moteur inconnu' };
  switch (p.status) {
    case 'AVAILABLE': return { tone: 'ok', text: `${p.displayName} disponible` };
    case 'UNAVAILABLE': return { tone: 'warn', text: 'ComfyUI local non disponible' };
    case 'DEGRADED': return { tone: 'warn', text: 'ComfyUI local répond mais n’est pas prêt (modèle ou nœud manquant)' };
    case 'MISCONFIGURED': return { tone: 'warn', text: 'ComfyUI local mal configuré' };
    case 'REFUSED': return { tone: 'warn', text: 'ComfyUI refusé (endpoint non local ou politique de sécurité)' };
    default: return { tone: 'off', text: 'État du moteur inconnu' };
  }
}

/** Why the AI generation button is disabled, or null when it may be enabled. */
export function generationBlockedReason(status: EetfStatus | null): string | null {
  if (!status?.enabled) return 'EETF_DISABLED';
  if (status.generation?.available) return null;
  return status.generation?.reason ?? 'LOCAL_PROVIDER_UNAVAILABLE';
}

/** Words that must never describe a V1 result in the UI (tests scan rendered text with this). */
export const FORBIDDEN_CLAIMS = Object.freeze(['PBR_COMPLETE', 'PBR complet', 'PBR COMPLETE', 'SEAMLESS', 'Seamless', 'HDRI disponible', 'cubemap certifiée', 'scène 3D générée']);
