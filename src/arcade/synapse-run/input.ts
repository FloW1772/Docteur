// [GAME-4] Synapse Run — keyboard → discrete commands. Only keydown events that reach this (focused) game document
// are seen, so Docteur's own shortcuts are never intercepted. Auto-repeat and modifier chords are ignored: holding a
// key produces one command, whatever the OS repeat rate. Commands are queued and consumed by the next tick.
import type { Command } from './simulation.ts';

export type InputAction = Command | 'CONFIRM';

const KEYS: Readonly<Record<string, InputAction>> = {
  ArrowLeft: 'LEFT', KeyA: 'LEFT',
  ArrowRight: 'RIGHT', KeyD: 'RIGHT',
  ArrowUp: 'JUMP', KeyW: 'JUMP', Space: 'JUMP',
  ArrowDown: 'SLIDE', KeyS: 'SLIDE',
  Enter: 'CONFIRM', NumpadEnter: 'CONFIRM',
};

/** Maps a key event to an action, or null (unmapped key, auto-repeat, Ctrl/Alt/Meta chord). */
export function actionForKey(event: { code: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): InputAction | null {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return null;
  return Object.prototype.hasOwnProperty.call(KEYS, event.code) ? KEYS[event.code] : null;
}

export interface CommandQueue {
  push(command: Command): void;
  /** Returns and clears the commands for the next tick. */
  take(): Command[];
  clear(): void;
}

/** Bounded so a flood of key events cannot grow memory; extra commands within one tick are dropped. */
export const MAX_COMMANDS_PER_TICK = 8;

export function createCommandQueue(): CommandQueue {
  let pending: Command[] = [];
  return {
    push(command) { if (pending.length < MAX_COMMANDS_PER_TICK) pending.push(command); },
    take() { const out = pending; pending = []; return out; },
    clear() { pending = []; },
  };
}
