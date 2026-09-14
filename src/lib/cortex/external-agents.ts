export type ExternalProvider = 'auto' | 'codex' | 'claude' | 'none';
export interface ExternalClient { installed: boolean; ready: boolean; reason: string; version: string | null }
export interface ExternalSettings { allowedRoots: string[]; strictLocal: boolean; features: string[]; limitations: string[] }
export interface ExternalJob {
  id: string; provider: ExternalProvider; task: string; workspace: string; status: string;
  created_at: string; started_at: string | null; duration: number; exit_code: number | null;
  output: string; error: string | null; review: string; tests: string; summary?: string;
  changes: { path: string; kind: string; diff: string }[];
  scope: { prompt?: string; files: string[]; bytes: number };
}
const BASE = `${window.location.protocol}//${window.location.hostname}:3001/api/external-agents`;
export const externalAgentUrl = (path: string) => `${BASE}${path}`;
export async function externalAgentRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(externalAgentUrl(path), {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'external_agent_error');
  return result;
}
export const externalAgentMessages: Record<string, string> = {
  ready: 'Prêt', authentication_required: 'Connexion requise dans le client officiel.',
  not_installed: 'Client non installé', unsupported_version: 'Version non compatible avec les protections requises.',
  timeout: 'Délai maximal atteint', error: 'Client indisponible', quota_exhausted: 'Quota du client officiel atteint.',
  strict_local: 'Le mode strictement local bloque les agents externes.',
  local_access_required: 'Disponible uniquement depuis cet ordinateur (localhost).',
  dangerous_action_denied: 'Action dangereuse bloquée. Les commandes shell et les opérations Git en écriture sont indisponibles.',
  secret_or_credentials_denied: 'Le prompt contient un secret potentiel ou vise des identifiants.',
  file_contains_secret: 'Un fichier sélectionné contient un secret potentiel. Il ne sera pas envoyé.',
  context_changed: 'Les fichiers ont changé depuis la prévisualisation. Préparez une nouvelle tâche.',
  review_conflict: 'Un fichier du projet a changé. Application ou retour arrière refusé pour préserver votre travail.',
  path_denied: 'Chemin refusé', sensitive_path: 'Fichier sensible ou format non autorisé',
  symlink_denied: 'Lien symbolique, junction ou lien physique refusé',
  mode_unsupported: 'Ce mode nécessite un contrôle de commandes qui n’est pas encore disponible.',
  workspace_not_authorized: 'Dossier non autorisé', permission_denied: 'Le client officiel a refusé une permission.',
  cleanup_unconfirmed: 'Windows n’a pas confirmé l’arrêt du processus. Le workspace reste bloqué ; vérifiez le client dans le Gestionnaire des tâches.',
};
