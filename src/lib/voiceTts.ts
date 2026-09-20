import type { VoiceLifecycle } from './voiceLifecycle';
export type TtsState = 'IDLE' | 'QUEUED' | 'SPEAKING' | 'PAUSED' | 'CANCELLED' | 'COMPLETED' | 'ERROR';

export interface TtsSettings {
  enabled: boolean;
  autoSpeak: boolean;
  voiceName: string;
  language: string;
  rate: number;
  volume: number;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: true,
  autoSpeak: false,
  voiceName: '',
  language: 'fr-FR',
  rate: 1,
  volume: 1,
};

export function getStoredTtsSettings(): TtsSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_TTS_SETTINGS;
  try { return { ...DEFAULT_TTS_SETTINGS, ...JSON.parse(localStorage.getItem('docteur.voice.tts') ?? '{}') }; }
  catch { return DEFAULT_TTS_SETTINGS; }
}

export function clampTtsRate(value: number): number { return Math.min(2, Math.max(0.5, value)); }
export function clampTtsVolume(value: number): number { return Math.min(1, Math.max(0, value)); }

export function listTtsVoices(): SpeechSynthesisVoice[] {
  return typeof window === 'undefined' || !('speechSynthesis' in window) ? [] : window.speechSynthesis.getVoices();
}

export class VoiceOutput {
  constructor(private lifecycle?: VoiceLifecycle) {}
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private session = 0;
  private current: SpeechSynthesisUtterance | null = null;
  private stateValue: TtsState = 'IDLE';
  private listeners = new Set<(state: TtsState) => void>();

  get state(): TtsState { return this.stateValue; }

  subscribe(listener: (state: TtsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  speakText(text: string, settings: TtsSettings = DEFAULT_TTS_SETTINGS): boolean {
    this.stopSpeaking();
    if (!settings.enabled || !text.trim() || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      this.setState('ERROR');
      this.lifecycle?.transition('ERROR');
      return false;
    }
    this.session = this.lifecycle?.beginSpeech() ?? 0;
    try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = settings.language || 'fr-FR';
    utterance.rate = clampTtsRate(settings.rate);
    utterance.volume = clampTtsVolume(settings.volume);
    const voice = listTtsVoices().find(candidate => candidate.name === settings.voiceName);
    if (voice) utterance.voice = voice;
    const isCurrent = () => this.current === utterance && (!this.lifecycle || this.lifecycle.isCurrent(this.session));
    utterance.onstart = () => { if (isCurrent()) this.setState('SPEAKING'); };
    utterance.onend = () => { if (isCurrent()) this.finish('COMPLETED'); };
    utterance.onerror = event => {
      if (isCurrent()) this.finish(event.error === 'canceled' ? 'CANCELLED' : 'ERROR');
    };
    this.current = utterance;
    this.setState('QUEUED');
    this.watchdog = setTimeout(() => {
      if (!isCurrent()) return;
      this.finish('ERROR');
      try { window.speechSynthesis.cancel(); } catch { /* state already cleaned */ }
    }, 120_000);
    window.speechSynthesis.speak(utterance);
    return true;
    } catch {
      this.finish('ERROR');
      try { window.speechSynthesis.cancel(); } catch { /* state already cleaned */ }
      return false;
    }
  }

  stopSpeaking(): void {
    this.finish('CANCELLED'); // detach before cancel: browsers may invoke callbacks synchronously
    try { if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* no active utterance remains */ }
  }

  private finish(state: TtsState): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.current) {
      this.current.onstart = null;
      this.current.onend = null;
      this.current.onerror = null;
    }
    this.current = null;
    this.setState(state);
    if (this.lifecycle?.getSnapshot() === 'SPEAKING') this.lifecycle.transition(state === 'ERROR' ? 'ERROR' : 'IDLE', this.session);
  }

  private setState(state: TtsState): void {
    this.stateValue = state;
    this.listeners.forEach(listener => listener(state));
  }
}
