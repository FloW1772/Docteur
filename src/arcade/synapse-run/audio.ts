// [GAME-6] Synapse Run — original sound effects synthesised with the Web Audio API (oscillators + gain envelopes):
// no audio files, no network, no third-party sound. Rules:
//   * silent until unlock() is called from a real user gesture inside the game (no AudioContext before that, so no
//     autoplay warning); at most MAX_UNLOCK_ATTEMPTS resume attempts, then audio stays off for the session
//   * no AudioContext (or a constructor that throws) → permanently silent, the game is unaffected
//   * every voice is an oscillator → gain → master chain that is stopped and disconnected when it ends; at most
//     MAX_VOICES voices at once: extra effects are dropped (never queued), except the important ones (mission,
//     crash), which stop the oldest voices to make room
//   * mute is session-only (no save-schema change) and silences future effects at once
//   * sound is never the only signal: every effect has a visual / text equivalent in main.ts
export type SoundEffect = 'lane' | 'jump' | 'slide' | 'shard' | 'crash' | 'mission' | 'ui';
export type AudioState = 'locked' | 'running' | 'blocked' | 'unavailable' | 'closed';

export const MAX_VOICES = 12;
export const MAX_UNLOCK_ATTEMPTS = 3;
export const DEFAULT_VOLUME = 0.5;
export const HISTORY_LENGTH = 20;
const PRIORITY_EFFECTS: ReadonlySet<SoundEffect> = new Set<SoundEffect>(['mission', 'crash']);

/** The slice of the Web Audio API used here (real AudioContext in the browser, a fake in unit tests). */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}
interface ParamLike { value: number; setValueAtTime(v: number, t: number): unknown; linearRampToValueAtTime(v: number, t: number): unknown; exponentialRampToValueAtTime(v: number, t: number): unknown }
interface NodeLike { connect(target: unknown): unknown; disconnect(): void }
interface OscillatorLike extends NodeLike { type: string; frequency: ParamLike; start(t?: number): void; stop(t?: number): void; onended: (() => void) | null }
interface GainLike extends NodeLike { gain: ParamLike }

/** One tone segment: waveform, start → end frequency (Hz), duration (s), peak level, delay (s). */
interface Tone { wave: 'sine' | 'triangle' | 'square' | 'sawtooth'; from: number; to: number; duration: number; peak: number; delay?: number }

const EFFECTS: Readonly<Record<SoundEffect, readonly Tone[]>> = {
  lane: [{ wave: 'triangle', from: 520, to: 600, duration: 0.07, peak: 0.25 }],
  jump: [{ wave: 'square', from: 320, to: 760, duration: 0.16, peak: 0.12 }],
  slide: [{ wave: 'sawtooth', from: 420, to: 150, duration: 0.2, peak: 0.08 }],
  shard: [{ wave: 'sine', from: 880, to: 880, duration: 0.07, peak: 0.25 }, { wave: 'sine', from: 1320, to: 1320, duration: 0.1, peak: 0.22, delay: 0.06 }],
  crash: [{ wave: 'sawtooth', from: 180, to: 45, duration: 0.45, peak: 0.22 }, { wave: 'square', from: 90, to: 40, duration: 0.35, peak: 0.08 }],
  mission: [{ wave: 'triangle', from: 523, to: 523, duration: 0.11, peak: 0.22 }, { wave: 'triangle', from: 659, to: 659, duration: 0.11, peak: 0.22, delay: 0.1 }, { wave: 'triangle', from: 784, to: 784, duration: 0.2, peak: 0.24, delay: 0.2 }],
  ui: [{ wave: 'sine', from: 660, to: 660, duration: 0.04, peak: 0.15 }],
};

export interface AudioEngine {
  readonly state: AudioState;
  readonly muted: boolean;
  /** voices currently connected (tests / leak checks) */
  readonly activeVoices: number;
  readonly played: number;
  /** resume attempts made so far (≤ MAX_UNLOCK_ATTEMPTS) */
  readonly unlockAttempts: number;
  /** names of the last HISTORY_LENGTH effects actually played (tests; no audio data) */
  history(): SoundEffect[];
  /** call from a user-gesture handler; idempotent */
  unlock(): void;
  setMuted(value: boolean): void;
  play(effect: SoundEffect): boolean;
  dispose(): void;
}

export function createAudioEngine(factory: () => AudioContextLike | null): AudioEngine {
  let state: AudioState = 'locked';
  let muted = false;
  let context: AudioContextLike | null = null;
  let master: GainLike | null = null;
  let attempts = 0;
  let played = 0;
  const recent: SoundEffect[] = [];
  const voices = new Set<{ osc: OscillatorLike; gain: GainLike }>();

  const release = (voice: { osc: OscillatorLike; gain: GainLike }) => {
    if (!voices.delete(voice)) return;
    voice.osc.onended = null;
    try { voice.osc.disconnect(); } catch { /* already disconnected */ }
    try { voice.gain.disconnect(); } catch { /* already disconnected */ }
  };
  const silenceAll = () => {
    for (const voice of [...voices]) {
      try { voice.osc.stop(); } catch { /* not started or already stopped */ }
      release(voice);
    }
  };

  return {
    get state() { return state; },
    get muted() { return muted; },
    get activeVoices() { return voices.size; },
    get played() { return played; },
    get unlockAttempts() { return attempts; },
    history() { return [...recent]; },
    unlock() {
      if (state === 'running' || state === 'unavailable' || state === 'closed') return;
      if (attempts >= MAX_UNLOCK_ATTEMPTS) { state = 'blocked'; return; }
      attempts += 1;
      if (!context) {
        try { context = factory(); } catch { context = null; }
        if (!context) { state = 'unavailable'; return; }
        try {
          master = context.createGain();
          master.gain.value = DEFAULT_VOLUME;
          master.connect(context.destination);
        } catch { context = null; master = null; state = 'unavailable'; return; }
      }
      const current = context;
      let resumed: Promise<void>;
      try { resumed = current.resume(); } catch { state = 'blocked'; return; }
      // still 'locked' (silent) until resume() settles; a rejection marks it blocked (retried on a later gesture, bounded)
      if (current.state === 'running') state = 'running';
      resumed.then(() => { if (state !== 'closed' && context === current) state = 'running'; }, () => { if (state !== 'closed') state = 'blocked'; });
    },
    setMuted(value) {
      muted = value === true;
      if (muted) silenceAll();
    },
    play(effect) {
      if (muted || state !== 'running' || !context || !master) return false;
      const tones = EFFECTS[effect];
      if (!tones) return false;
      if (voices.size + tones.length > MAX_VOICES) {
        if (!PRIORITY_EFFECTS.has(effect)) return false;
        for (const voice of [...voices].slice(0, voices.size + tones.length - MAX_VOICES)) {
          try { voice.osc.stop(); } catch { /* already stopped */ }
          release(voice);
        }
      }
      const now = context.currentTime;
      for (const tone of tones) {
        try {
          const osc = context.createOscillator();
          const gain = context.createGain();
          const start = now + (tone.delay ?? 0), end = start + tone.duration;
          osc.type = tone.wave;
          osc.frequency.setValueAtTime(tone.from, start);
          if (tone.to !== tone.from) osc.frequency.exponentialRampToValueAtTime(tone.to, end);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.linearRampToValueAtTime(tone.peak, start + Math.min(0.012, tone.duration / 4));
          gain.gain.exponentialRampToValueAtTime(0.0001, end);
          osc.connect(gain);
          gain.connect(master);
          const voice = { osc, gain };
          voices.add(voice);
          osc.onended = () => release(voice);
          osc.start(start);
          osc.stop(end + 0.02);
        } catch {
          return false; // a failing audio graph never affects the game
        }
      }
      played += 1;
      recent.push(effect);
      if (recent.length > HISTORY_LENGTH) recent.shift();
      return true;
    },
    dispose() {
      silenceAll();
      try { master?.disconnect(); } catch { /* ignore */ }
      master = null;
      const closing = context;
      context = null;
      state = 'closed';
      if (closing) closing.close().catch(() => { /* already closed */ });
    },
  };
}

/** Browser factory: the standard AudioContext when present (never the prefixed or offline variants). */
export function browserAudioFactory(): AudioContextLike | null {
  const Ctor = (globalThis as unknown as { AudioContext?: new () => AudioContextLike }).AudioContext;
  return typeof Ctor === 'function' ? new Ctor() : null;
}
