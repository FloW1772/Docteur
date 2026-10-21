// [GAME-5] Synapse Run — pause reasons. The simulation advances only when NO reason is active, so the player's own
// pause and Docteur's host pause (ARCADE_PAUSE / ARCADE_RESUME) can never cancel each other:
//   PLAYER  Échap / P / the pause button; removed only by the player (Reprendre)
//   HOST    ARCADE_PAUSE from Docteur; removed only by ARCADE_RESUME
//   HIDDEN  the page became hidden. Hiding also sets PLAYER, so returning to the page never resumes a run by
//           itself: the pause menu is waiting for an explicit "Reprendre".
export type PauseReason = 'PLAYER' | 'HOST' | 'HIDDEN';

export interface PauseState {
  add(reason: PauseReason): boolean;
  remove(reason: PauseReason): boolean;
  has(reason: PauseReason): boolean;
  readonly paused: boolean;
  /** sorted, for display and tests */
  reasons(): PauseReason[];
  clear(): void;
}

export function createPauseState(): PauseState {
  const active = new Set<PauseReason>();
  return {
    add(reason) { const had = active.has(reason); active.add(reason); return !had; },
    remove(reason) { return active.delete(reason); },
    has(reason) { return active.has(reason); },
    get paused() { return active.size > 0; },
    reasons() { return [...active].sort(); },
    clear() { active.clear(); },
  };
}
