// [GAME-2] Docteur Arcade — fixed game registry. The list below IS the catalogue: application code, no filesystem
// scan, no external manifest, no arbitrary URL, no command field. A game is only ever loaded from its own static
// page under /arcade/<id>/ inside the sandboxed host (src/components/arcade/ArcadeGameHost.tsx).

export type ArcadeGameId = 'synapse-run';

/** FOUNDATION_ONLY = the sandboxed page and the host protocol exist, there is no gameplay yet. */
export type ArcadeGameStatus = 'FOUNDATION_ONLY';

/** What the player can expect next; COMING_NEXT = announced, not playable. */
export type ArcadeGameAvailability = 'COMING_NEXT';

/** What the page may do with the host. Nothing here grants network, storage or Docteur data. */
export type ArcadeGameCapability = 'HOST_PROTOCOL_V1' | 'PAUSE_RESUME' | 'REDUCED_MOTION';

export interface ArcadeGameEntry {
  readonly id: ArcadeGameId;
  readonly title: string;
  readonly description: string;
  readonly route: string;
  readonly status: ArcadeGameStatus;
  readonly availability: ArcadeGameAvailability;
  readonly nextMilestone: string;
  readonly capabilities: readonly ArcadeGameCapability[];
}

/** Same-site static page path: /arcade/<id>/index.html, nothing else (no scheme, host, query or fragment). */
export const ARCADE_ROUTE_PATTERN = /^\/arcade\/([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.html$/;

export const ARCADE_GAMES: readonly ArcadeGameEntry[] = Object.freeze([
  Object.freeze({
    id: 'synapse-run',
    title: 'Synapse Run',
    description: 'Course sans fin en 3D low-poly, projet original de Docteur. Seule la fondation technique est en place : le bac à sable démarre, le jeu n’est pas encore jouable.',
    route: '/arcade/synapse-run/index.html',
    status: 'FOUNDATION_ONLY',
    availability: 'COMING_NEXT',
    nextMilestone: 'GAME-4',
    capabilities: Object.freeze(['HOST_PROTOCOL_V1', 'PAUSE_RESUME', 'REDUCED_MOTION'] as const),
  }),
]);

export function getArcadeGame(id: unknown): ArcadeGameEntry | null {
  if (typeof id !== 'string') return null;
  return ARCADE_GAMES.find(game => game.id === id) ?? null;
}
