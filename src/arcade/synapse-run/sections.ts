// GAME-7: distance alone controls difficulty. Rendering and frame rate have no authority here.
export const MAX_SPEED = 24;
export const REACTION_FLOOR = 0.95;
export const SECTIONS = [
  { name: 'Signal Deck', start: 0, speed: 12, reaction: 1.65, doubles: 0.2, background: 0x080f21, accent: 0x5ee7ff },
  { name: 'Data Tunnels', start: 500, speed: 15, reaction: 1.45, doubles: 0.4, background: 0x12102c, accent: 0xa58bff },
  { name: 'Synaptic Garden', start: 1200, speed: 18, reaction: 1.25, doubles: 0.55, background: 0x071c23, accent: 0x48efb7 },
  { name: 'Core Transit', start: 2200, speed: 21, reaction: 1.1, doubles: 0.7, background: 0x231221, accent: 0xffbf70 },
  { name: 'Overdrive', start: 3500, speed: MAX_SPEED, reaction: REACTION_FLOOR, doubles: 0.8, background: 0x210c2c, accent: 0xff79dc },
] as const;

export function sectionIndex(distance: number): number {
  for (let i = SECTIONS.length - 1; i > 0; i--) if (distance >= SECTIONS[i].start) return i;
  return 0;
}

export function difficultyAt(distance: number) {
  const tier = sectionIndex(distance), section = SECTIONS[tier], next = SECTIONS[Math.min(tier + 1, 4)];
  const t = next === section ? 0 : Math.max(0, Math.min(1, (distance - section.start) / (next.start - section.start)));
  // Hold the first 120 m at 12 m/s so the introduction remains gentle.
  const speedT = tier === 0 ? Math.max(0, (distance - 120) / 380) : t;
  return { tier, speed: section.speed + (next.speed - section.speed) * speedT,
    reaction: section.reaction + (next.reaction - section.reaction) * t,
    doubles: section.doubles + (next.doubles - section.doubles) * t };
}

/** Global speed cap makes this conservative even when a gap crosses a tier boundary.
 * 1.8 m reserves both collision envelopes; remaining time permits a reaction AND two lane changes.
 */
export function rowGap(distance: number, variation: number): number {
  return Math.ceil(MAX_SPEED * (difficultyAt(distance).reaction + Math.max(0, Math.min(1, variation)) * 0.3) + 1.8);
}
