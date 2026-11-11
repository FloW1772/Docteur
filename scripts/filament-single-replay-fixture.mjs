// [ARCADE-SAFE-REPLAY 2026-10-23] Declarative fixture for scripts/filament-single-replay.mjs — data only, no imports,
// no code path runs at module evaluation except the freeze below.
//
// Provenance (read-only extraction, nothing of the design tooling is imported or executed):
//   * level geometry: chapter 1, key "a", copied verbatim from .tmp/filament-design-preserved-2026-10-22/ch1.mjs
//     (SHA-256 ee21a65e7ba8a3a4eda87af4e63f59e89d340a9a98a7a4d6a939d902689ee7ec). That file holds `stars: []`;
//   * stars + solution: printed by the design run of 2026-10-22 20:39:40Z (session d88e16ff, "design" command for
//     chapter 1, after the last write of ch1.mjs and after the last change of physics.ts at 20:35:12Z):
//       combo 4 → WON stars 3 · stars (400,239) (400,291) (400,349) · solution tick 4 CUT thread 0
//       · recorded timing tolerance ±120 ticks (the orb hangs still, so the cut moment barely matters);
//   * engine: src/arcade/filament/physics.ts, SHA-256 below (unchanged since that run, also recorded in the
//     SAFE_HARDENING_V2 / handshake reports). The replay refuses to run on any other engine.
//
// Analytic cross-check (independent of the simulation): the orb hangs straight under its anchor, so after the cut
// it falls with semi-implicit Euler, Δy after k free steps = g·dt²·k(k+1)/2 = 0.0625·k(k+1)/2 world units.
//   star (y 239) needs y > 206 → k = 29 → tick 33 · star (y 291) needs y > 258 → k = 50 → tick 54
//   star (y 349) needs y > 316 → k = 66 → tick 70 · goal (y 430, r 34) needs y > 396 → k = 83 → tick 87
//   speed at the goal 83 × 7.5 = 622.5 < MAX_SPEED 1300; nearest threshold margin 0.6 unit ≫ float error.

const deepFreeze = (value) => {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
};

export const FIXTURE = deepFreeze({
  id: 'filament-ch1-a-single-cut',
  engineFile: 'src/arcade/filament/physics.ts',
  engineSha256: '733fd8352dfd09ee2cfea66163bded689ec69ac976603d54889d43f9d9b31b59',
  level: {
    orb: { x: 400, y: 180 },
    threads: [{ anchor: { x: 400, y: 70 }, length: 110 }],
    goal: { x: 400, y: 430, r: 34 },
    stars: [{ x: 400, y: 239 }, { x: 400, y: 291 }, { x: 400, y: 349 }],
  },
  actions: [{ tick: 4, action: { type: 'CUT', thread: 0 } }],
  /** recorded by the design run */
  recorded: { outcome: 'WON', stars: 3 },
  /** derived above, by hand */
  analytic: { loss: null, tick: 87, starAt: [33, 54, 70] },
});
