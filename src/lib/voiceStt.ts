export type SttProvider = 'local' | 'groq';
export type SttMode = 'LOCAL' | 'CLOUD';
export type SttErrorCode = 'STT_UNAVAILABLE' | 'STT_TIMEOUT' | 'STT_CANCELLED' | 'STT_PROVIDER_ERROR' | 'STT_INVALID_AUDIO' | 'STT_EMPTY_RESULT';

export interface TranscribeAudioOptions {
  audio: Blob;
  provider: SttProvider;
  language?: string;
  model?: string;
  signal?: AbortSignal;
  endpoint?: string;
}

export interface TranscriptionResult {
  text: string;
  provider: SttProvider;
  mode: SttMode;
  language?: string;
  durationMs: number;
  latencyMs: number;
}

export class SttError extends Error {
  readonly code: SttErrorCode;
  readonly provider: SttProvider;

  constructor(code: SttErrorCode, provider: SttProvider, message: string) {
    super(message);
    this.name = 'SttError';
    this.code = code;
    this.provider = provider;
  }
}

function modeFor(provider: SttProvider): SttMode {
  return provider === 'groq' ? 'CLOUD' : 'LOCAL';
}

function normalizeError(error: unknown, provider: SttProvider): SttError {
  if (error instanceof SttError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new SttError('STT_CANCELLED', provider, 'Transcription annulée.');
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new SttError('STT_TIMEOUT', provider, 'La transcription a dépassé le délai autorisé.');
  }
  return new SttError('STT_PROVIDER_ERROR', provider, 'Le service de transcription est indisponible.');
}

export async function transcribeAudio({ audio, provider, language = 'fr', model = 'small', signal, endpoint }: TranscribeAudioOptions): Promise<TranscriptionResult> {
  if (!audio || audio.size < 256) throw new SttError('STT_INVALID_AUDIO', provider, 'Aucune parole détectée.');
  const startedAt = performance.now();
  const form = new FormData();
  form.append('audio', audio, 'voice.webm');
  form.append('provider', provider);
  form.append('model', model);
  form.append('language', language);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const response = await fetch(endpoint ?? `${window.location.protocol}//${window.location.hostname}:3001/api/voice/transcribe`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 408 || response.status === 504) throw new SttError('STT_TIMEOUT', provider, 'La transcription a dépassé le délai autorisé.');
      throw new SttError('STT_PROVIDER_ERROR', provider, 'Le service de transcription a refusé la demande.');
    }
    const data = await response.json() as { text?: string; language?: string; provider?: SttProvider };
    if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
    const text = (data.text ?? '').trim();
    const resultProvider = data.provider ?? provider;
    return {
      text,
      provider: resultProvider,
      mode: modeFor(resultProvider),
      language: data.language,
      durationMs: performance.now() - startedAt,
      latencyMs: performance.now() - startedAt,
    };
  } catch (error) {
    throw normalizeError(error, provider);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
