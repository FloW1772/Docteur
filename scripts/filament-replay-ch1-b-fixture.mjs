// [ARCADE-SAFE-REPLAY CH1-B 2026-10-23] Declarative fixture for scripts/filament-replay-ch1-b.mjs — data only, no
// imports, no code path runs at module evaluation except the two geometry helpers and the freeze below.
//
// Provenance (read-only extraction, nothing of the design tooling is imported or executed):
//   * level geometry: chapter 1, key "b", from .tmp/filament-design-preserved-2026-10-22/ch1.mjs
//     (SHA-256 ee21a65e7ba8a3a4eda87af4e63f59e89d340a9a98a7a4d6a939d902689ee7ec). Its orb is written there as
//     pend(300, 60, 170, -70) and its walls as seg(…): both helpers are copied below VERBATIM so the orb start is the
//     very same floating-point value. The file holds `stars: []`;
//   * stars + solution: printed by the design run of 2026-10-22 20:39:40Z (session d88e16ff, same command as CH1-A,
//     after the last write of ch1.mjs and after the last change of physics.ts at 20:35:12Z). That driver version
//     replayed exactly these stars and this solution with the lab's run() (= engine replay(), 4 800-tick cap):
//       combo 92 → WON stars 3 · stars (411,255) (469,291) (523,340) · solution tick 92 CUT thread 0
//       · recorded timing tolerance −4 / +6 ticks (the cut must land on the swing's lowest point);
//   * engine: src/arcade/filament/physics.ts, SHA-256 below. The replay refuses to run on any other engine.
//
// NOT recorded by the design run: the tick of the win. Estimate only (never a pass criterion): the recorded stars sit
// at 25 / 50 / 78 % of the flight path that starts 10 ticks after the cut, 68 and 73 units apart, so the whole flight
// is ≈ 273 units; at ≈ 450–600 units/s that is ≈ 55–75 ticks, i.e. a win near tick 160–180. The 600-step cap is the
// hard limit; a run still playing at 600 is UNRESOLVED and fails (exit 30), it is never extended.

const pend = (ax, ay, L, deg) => ({ x: ax + L * Math.sin(deg * Math.PI / 180), y: ay + L * Math.cos(deg * Math.PI / 180) });
const seg = (x1, y1, x2, y2, kind = 'wall') => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, kind });

const deepFreeze = (value) => {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
};

export const FIXTURE = deepFreeze({
  id: 'filament-ch1-b-single-cut',
  engineFile: 'src/arcade/filament/physics.ts',
  engineSha256: '733fd8352dfd09ee2cfea66163bded689ec69ac976603d54889d43f9d9b31b59',
  level: {
    orb: pend(300, 60, 170, -70),
    threads: [{ anchor: { x: 300, y: 60 }, length: 170 }],
    goal: { x: 590, y: 410, r: 34 },
    segments: [seg(515, 345, 562, 425), seg(665, 345, 618, 425)],
    stars: [{ x: 411, y: 255 }, { x: 469, y: 291 }, { x: 523, y: 340 }],
  },
  actions: [{ tick: 92, action: { type: 'CUT', thread: 0 } }],
  /** recorded by the design run (the only pass criteria besides the budget checks) */
  recorded: { outcome: 'WON', stars: 3 },
  /** documentation only, see above */
  estimate: { winTickRange: [160, 180] },
});
