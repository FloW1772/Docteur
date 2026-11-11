// [GAME-2] Docteur Arcade — fixed game registry. The list below IS the catalogue: application code, no filesystem
// scan, no external manifest, no arbitrary URL, no command field. A game is only ever loaded from its own static
// page under /arcade/<id>/ inside the sandboxed host (src/components/arcade/ArcadeGameHost.tsx).

export type ArcadeGameId = 'synapse-run' | 'filament';

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
 * HOST_EXIT_REQUEST [FILAMENT-1] lets the page ask the host to close it (its own "Retour à l'Arcade" button); the host
 * then does exactly what its own Stop button does, nothing more. Games without it are never closed by a request.
 */
export type ArcadeGameCapability = 'HOST_PROTOCOL_V1' | 'PAUSE_RESUME' | 'REDUCED_MOTION' | 'LOCAL_SAVE_V1' | 'HOST_EXIT_REQUEST';

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
  /** [FILAMENT-1] host-side help line under the game frame (host-owned text, never supplied by the page) */
  readonly controlsHint: string;
}

/** Same-site static page path: /arcade/<id>/index.html, nothing else (no scheme, host, query or fragment). */
export const ARCADE_ROUTE_PATTERN = /^\/arcade\/([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.html$/;

export const ARCADE_GAMES: readonly ArcadeGameEntry[] = Object.freeze([
  Object.freeze({
    id: 'synapse-run',
    title: 'Synapse Run',
    description: 'Jeu de course 3D local, projet original de Docteur : trois couloirs, sauts, glissades et éclats à ramasser. Commandes clavier et tactiles, audio synthétisé, trois missions et progression sauvegardée sur cet appareil.',
    route: '/arcade/synapse-run/index.html',
    status: 'PLAYABLE_CORE',
    availability: 'PLAYABLE_PREVIEW',
    nextMilestone: 'MAINTENANCE',
    capabilities: Object.freeze(['HOST_PROTOCOL_V1', 'PAUSE_RESUME', 'REDUCED_MOTION', 'LOCAL_SAVE_V1'] as const),
    save: Object.freeze({ currentVersion: 1, minSupportedVersion: 1 }),
    controlsHint: 'Clavier : cliquez dans le jeu ou atteignez-le avec Tab, puis ← → (ou A D) pour changer de couloir, ↑ / W / Espace pour sauter, ↓ / S pour glisser, Entrée pour démarrer ou rejouer. Tab en ressort.',
  }),
  // [FILAMENT-1] first playable slice, manually validated in the browser by the user (2 levels). [FILAMENT-2] chapter 1
  // grows to 8 levels, each replayed under the supervised lab (src/arcade/filament/chapter1.ts); the new levels and the
  // new art are not yet seen in a browser: nextMilestone says so. [FILAMENT-2 tried by the user: 8 levels OK.]
  // [FILAMENT-6] 24 levels in 4 chapters, all played by the user (2026-10-24); keys: F first fan, G second fan
  Object.freeze({
    id: 'filament',
    title: 'Filament',
    description: 'Jeu de réflexion 2D local, projet original de Docteur : coupez les fils au bon moment pour guider une bille lumineuse jusqu’au halo en cueillant des étoiles. 24 niveaux répartis en 4 chapitres (Jardins de l’Aube, Courants d’Altitude, Vergers Stellaires, Lisière du Crépuscule), souris, tactile et clavier, étoiles et niveaux réussis sauvegardés sur cet appareil.',
    route: '/arcade/filament/index.html',
    status: 'PLAYABLE_CORE',
    availability: 'PLAYABLE_PREVIEW',
    nextMilestone: 'VALIDATION VISUELLE',
    // [FILAMENT-3] progression saved through the same host-owned GAME-3 store as Synapse Run (key arcade:v1:filament);
    // saveVersion 1 = { format: 'filament-progress-v1', levels } (src/arcade/filament/progress.ts)
    capabilities: Object.freeze(['HOST_PROTOCOL_V1', 'PAUSE_RESUME', 'REDUCED_MOTION', 'HOST_EXIT_REQUEST', 'LOCAL_SAVE_V1'] as const),
    save: Object.freeze({ currentVersion: 1, minSupportedVersion: 1 }),
    controlsHint: 'Souris : cliquez sur un fil ou tracez un trait à travers pour le couper. Tactile : touchez ou glissez. Clavier : cliquez dans le jeu ou atteignez-le avec Tab, puis Espace (ou 1 à 8) pour couper, F pour le ventilateur (G pour le second quand il y en a deux), P ou Échap pour la pause, R pour recommencer. Tab en ressort.',
  }),
]);

export function getArcadeGame(id: unknown): ArcadeGameEntry | null {
  if (typeof id !== 'string') return null;
  return ARCADE_GAMES.find(game => game.id === id) ?? null;
}
