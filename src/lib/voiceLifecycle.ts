export type UnifiedVoiceState = 'IDLE' | 'LISTENING' | 'HEARING_SPEECH' | 'TRANSCRIBING' | 'UNDERSTANDING' | 'CONFIRMING' | 'EXECUTING' | 'SPEAKING' | 'CANCELLING' | 'ERROR';
type Interrupt = 'cancel' | 'capture' | 'speech';
const transitions: Record<UnifiedVoiceState, readonly UnifiedVoiceState[]> = {
  IDLE: ['LISTENING', 'UNDERSTANDING', 'SPEAKING'],
  LISTENING: ['HEARING_SPEECH', 'TRANSCRIBING', 'IDLE'],
  HEARING_SPEECH: ['TRANSCRIBING', 'IDLE'],
  TRANSCRIBING: ['CONFIRMING', 'UNDERSTANDING', 'IDLE'],
  UNDERSTANDING: ['CONFIRMING', 'EXECUTING', 'IDLE'],
  CONFIRMING: ['UNDERSTANDING', 'EXECUTING', 'IDLE', 'SPEAKING'],
  EXECUTING: ['IDLE', 'SPEAKING'],
  SPEAKING: ['IDLE', 'CONFIRMING'],
  CANCELLING: ['IDLE'],
  ERROR: ['IDLE'],
};

export const VOICE_STATE_LABEL: Record<UnifiedVoiceState, string> = {
  IDLE: 'Arrêté', LISTENING: 'En écoute', HEARING_SPEECH: 'Je vous entends',
  TRANSCRIBING: 'Transcription…', UNDERSTANDING: 'Compréhension…',
  CONFIRMING: 'Confirmation requise', EXECUTING: 'Exécution…',
  SPEAKING: 'Lecture…', CANCELLING: 'Annulation…', ERROR: 'Erreur vocale — réessayez',
};

/** Application coordinator. Technical states never independently drive the HUD. */
export class VoiceLifecycle {
  private state: UnifiedVoiceState = 'IDLE';
  private generation = 0;
  private listeners = new Set<() => void>();
  private owners = new Set<(reason: Interrupt) => void>();
  get sessionId() { return this.generation; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onInterrupt = (owner: (reason: Interrupt) => void) => { this.owners.add(owner); return () => { this.owners.delete(owner); }; };
  isCurrent = (session: number) => session === this.generation;
  captureResponseGuard = () => {
    const session = this.generation;
    return () => this.isCurrent(session) && (this.state === 'IDLE' || this.state === 'EXECUTING');
  };
  transition(next: UnifiedVoiceState, session = this.generation): boolean {
    if (!this.isCurrent(session)) return false;
    if (next === this.state) return true;
    if (next !== 'ERROR' && next !== 'CANCELLING' && !transitions[this.state].includes(next)) return false;
    this.state = next;
    this.listeners.forEach(listener => listener());
    return true;
  }
  private interrupt(reason: Interrupt) {
    ++this.generation; // Invalidate before any owner can synchronously invoke a callback.
    this.transition('CANCELLING');
    this.owners.forEach(owner => owner(reason));
    this.transition('IDLE');
  }
  beginCapture() { this.interrupt('capture'); this.transition('LISTENING'); return this.generation; }
  beginSpeech() { this.interrupt('speech'); this.transition('SPEAKING'); return this.generation; }
  cancelVoiceInteraction = () => { this.interrupt('cancel'); };
}
