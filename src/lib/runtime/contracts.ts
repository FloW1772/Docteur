// Runtime Supervisor V1 — UI contract (mirrors the typed DTO of /api/runtime/services). Display helpers are pure.

export type RuntimeState = 'STOPPED' | 'STARTING' | 'HEALTHY' | 'DEGRADED' | 'CRASHED' | 'STOPPING' | 'RESTARTING' | 'BACKOFF' | 'BLOCKED';
export type OwnershipClass = 'DOCTEUR_OWNED' | 'DOCTEUR_MANAGED_OPTIONAL' | 'EXTERNAL_OBSERVED' | 'UNKNOWN';
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

export interface RuntimeServiceDto {
  serviceId: string;
  displayName: string;
  ownershipClass: OwnershipClass;
  kind: 'SELF' | 'OBSERVED' | 'SPAWN';
  optional: boolean;
  dependencies: string[];
  note: string | null;
  state: RuntimeState;
  health: { status: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE' | 'NOT_PROBED'; code: string };
  processRunning: boolean | null;
  portListening: boolean | null;
  pid: number | null;
  uptimeMs: number | null;
  lastExitCode: number | null;
  lastError: string | null;
  lastRestartAt: string | null;
  restartCount: number;
  crashCount: number;
  retryAt: string | null;
  operationInProgress: boolean;
  restart: { allowed: boolean; code: string };
}
export interface RuntimeEventDto { at: string; serviceId?: string; event?: string; from?: string; to?: string; reason?: string; pid?: number; exitCode?: number; actor?: string }
export interface RestartOptions { confirmInterrupt?: boolean; resetBlocked?: boolean }
export interface RuntimePort {
  list(): Promise<RuntimeServiceDto[]>;
  get(serviceId: string): Promise<{ service: RuntimeServiceDto; events: RuntimeEventDto[] }>;
  restart(serviceId: string, options?: RestartOptions): Promise<{ accepted: boolean; serviceId: string; state: RuntimeState }>;
}

export class RuntimeUiError extends Error {
  constructor(public code: string, message: string, public reason: string | null = null, public retryAt: string | null = null) { super(message); this.name = 'RuntimeUiError'; }
}

const STATES: Record<RuntimeState, { label: string; tone: Tone }> = {
  HEALTHY: { label: 'Sain', tone: 'ok' },
  DEGRADED: { label: 'Dégradé', tone: 'warn' },
  STOPPED: { label: 'Arrêté', tone: 'muted' },
  CRASHED: { label: 'Planté', tone: 'danger' },
  STARTING: { label: 'Démarrage…', tone: 'info' },
  STOPPING: { label: 'Arrêt…', tone: 'info' },
  RESTARTING: { label: 'Relance…', tone: 'info' },
  BACKOFF: { label: 'En attente', tone: 'warn' },
  BLOCKED: { label: 'Bloqué', tone: 'danger' },
};
export function stateBadge(state: unknown): { label: string; tone: Tone } {
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(STATES, state) ? STATES[state as RuntimeState] : { label: 'Inconnu', tone: 'muted' };
}

const OWNERSHIP: Record<OwnershipClass, string> = {
  DOCTEUR_OWNED: 'Docteur (propriétaire)',
  DOCTEUR_MANAGED_OPTIONAL: 'Géré par un module Docteur',
  EXTERNAL_OBSERVED: 'Externe — observé seulement',
  UNKNOWN: 'Propriétaire inconnu',
};
export const ownershipLabel = (c: unknown): string => (typeof c === 'string' && Object.prototype.hasOwnProperty.call(OWNERSHIP, c) ? OWNERSHIP[c as OwnershipClass] : OWNERSHIP.UNKNOWN);

const HEALTH_CODES: Record<string, string> = {
  OK: 'contrôle de santé réussi', IN_PROCESS: 'en cours d’exécution (ce serveur)', HTTP_OK: 'répond', API_OK: 'API locale répond',
  PORT_NOT_LISTENING: 'aucun service à l’écoute', NOT_RUNNING: 'non démarré', NOT_INSTALLED: 'non installé', NOT_STARTED: 'pas encore démarré',
  HEALTH_TIMEOUT: 'ne répond pas à temps', HEALTH_HTTP_ERROR: 'répond en erreur', HEALTH_FAILED: 'contrôle de santé en échec',
  IDENTITY_MISMATCH: 'un autre programme occupe son port', START_TIMEOUT: 'démarrage trop long', PORT_IN_USE: 'port déjà occupé',
  PROCESS_EXITED: 'processus arrêté de façon inattendue', NON_LOOPBACK_ENDPOINT: 'adresse non locale : non contrôlée', OBSERVE_FAILED: 'état illisible',
};
export const healthLabel = (code: unknown): string => (typeof code === 'string' && HEALTH_CODES[code]) || 'état non détaillé';

const ERRORS: Record<string, string> = {
  PROCESS_EXITED: 'Le processus s’est arrêté de façon inattendue.', STOP_FAILED: 'Arrêt impossible du processus.', PORT_IN_USE: 'Le port est déjà occupé par un autre programme.',
  SPAWN_FAILED: 'Le lancement a échoué.', START_TIMEOUT: 'Le service n’est pas devenu sain à temps.', HEALTH_TIMEOUT: 'Le contrôle de santé ne répond pas.',
  HEALTH_HTTP_ERROR: 'Le contrôle de santé renvoie une erreur.', IDENTITY_MISMATCH: 'Le port répond, mais pas avec ce service.', KIWIX_REPORTED_ERROR: 'Le module Kiwix signale une erreur.',
  INTERNAL: 'Erreur interne du superviseur.',
};
export const errorLabel = (code: unknown): string | null => (code === null || code === undefined ? null : (typeof code === 'string' && ERRORS[code]) || 'Erreur non détaillée.');

const RESTART_REASONS: Record<string, string> = {
  SELF_RESTART_UNSUPPORTED: 'Le serveur Docteur ne peut pas se relancer lui-même.',
  NOT_DOCTEUR_OWNED: 'Service non détenu par Docteur : surveillance seulement.',
  MANAGED_BY_OWN_MODULE: 'Géré par son propre module Docteur (ou le lanceur) : à démarrer ou arrêter depuis ses réglages.',
  LAUNCHER_UNAVAILABLE: 'Aucun lanceur Docteur n’est enregistré pour ce service.',
  OPERATION_IN_PROGRESS: 'Une opération est déjà en cours.',
  ROOT_POLICY_APPROVAL_REQUIRED: 'Root Policy : une approbation locale est requise et n’est pas encore disponible.',
  ROOT_POLICY_DENIED: 'Root Policy : relance refusée.',
  RESTART_BACKOFF: 'Relance suspendue quelques instants après un plantage.',
};
export const restartReasonLabel = (code: unknown): string => (typeof code === 'string' && RESTART_REASONS[code]) || 'Relance indisponible.';

export function formatUptime(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} j`;
}
export const isBusy = (s: RuntimeServiceDto): boolean => s.operationInProgress || s.state === 'RESTARTING' || s.state === 'STARTING' || s.state === 'STOPPING';
