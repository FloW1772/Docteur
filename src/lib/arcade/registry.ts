// [GAME-2] Docteur Arcade — fixed game registry. The list below IS the catalogue: application code, no filesystem
// scan, no external manifest, no arbitrary URL, no command field. A game is only ever loaded from its own static
// page under /arcade/<id>/ inside the sandboxed host (src/components/arcade/ArcadeGameHost.tsx).

export type ArcadeGameId = 'synapse-run';

/**
 * FOUNDATION_ONLY = the sandboxed page and the host protocol exist, no gameplay.
 * PLAYABLE_CORE [GAME-4] = a real run can be played (keyboard), without progression or saved results yet.
 */
export type ArcadeGameStatus = 'FOUNDATION_ONLY' | 'PLAYABLE_CORE';

/** What the player can expect; COMING_NEXT = announced, not playable; PLAYABLE_PREVIEW = playable early version. */
export type ArcadeGameAvailability = 'COMING_NEXT' | 'PLAYABLE_PREVIEW';

/**
 * What the page may do with the host. Nothing here grants network or Docteur data. LOCAL_SAVE_V1 [GAME-3] lets the
 * page ask the host to load / write / delete ITS OWN bounded save record; the host owns the storage (saves.ts).
 */
export type ArcadeGameCapability = 'HOST_PROTOCOL_V1' | 'PAUSE_RESUME' | 'REDUCED_MOTION' | 'LOCAL_SAVE_V1';

/** [GAME-3] Per-game saveVersion window the host accepts (the game migrates older versions itself). */
export interface ArcadeGameSavePolicy {
  readonly currentVersion: number;
  readonly minSupportedVersion: number;
}

export interface ArcadeGameEntry {
  readonly id: ArcadeGameId;
  readonly title: string;
  readonly description: string;
  readonly route: string;
  readonly status: ArcadeGameStatus;
  readonly availability: ArcadeGameAvailability;
  readonly nextMilestone: string;
  readonly capabilities: readonly ArcadeGameCapability[];
  /** null = no local save for this game */
  readonly save: ArcadeGameSavePolicy | null;
}

/** Same-site static page path: /arcade/<id>/index.html, nothing else (no scheme, host, query or fragment). */
export const ARCADE_ROUTE_PATTERN = /^\/arcade\/([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.html$/;

export const ARCADE_GAMES: readonly ArcadeGameEntry[] = Object.freeze([
  Object.freeze({
    id: 'synapse-run',
    title: 'Synapse Run',
    description: 'Course sans fin en 3D low-poly, projet original de Docteur : trois couloirs, sauts, glissades, éclats à ramasser. Clavier ou écran tactile, pause, trois missions et records conservés sur cet appareil. Version préliminaire : ni son ni finitions pour l’instant.',
    route: '/arcade/synapse-run/index.html',
    status: 'PLAYABLE_CORE',
    availability: 'PLAYABLE_PREVIEW',
    nextMilestone: 'GAME-6',
    capabilities: Object.freeze(['HOST_PROTOCOL_V1', 'PAUSE_RESUME', 'REDUCED_MOTION', 'LOCAL_SAVE_V1'] as const),
    save: Object.freeze({ currentVersion: 1, minSupportedVersion: 1 }),
  }),
]);

export function getArcadeGame(id: unknown): ArcadeGameEntry | null {
  if (typeof id !== 'string') return null;
  return ARCADE_GAMES.find(game => game.id === id) ?? null;
}
