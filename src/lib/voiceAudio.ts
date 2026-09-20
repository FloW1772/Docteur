export type VoiceActivityState = 'SILENCE' | 'VOICE_START' | 'VOICE_ACTIVE' | 'VOICE_END';
export type ClippingStatus = 'NO CLIPPING DETECTED' | 'OCCASIONAL CLIPPING' | 'FREQUENT CLIPPING';

export const CLIPPING_THRESHOLD = 0.98;
export const MIN_VAD_THRESHOLD = 0.012;
export const MAX_VAD_THRESHOLD = 0.12;
export const INITIAL_VAD_THRESHOLD = 0.035;
export const VAD_START_FRAMES = 3;
export const VAD_HANGOVER_MS = 600;
export const NOISE_FLOOR_ALPHA = 0.1;
export const VAD_CALIBRATION_FRAMES = 8;

export interface AudioFrameMetrics {
  rms: number;
  peak: number;
  clippingRatio: number;
  dbfs: number;
}

export interface VadFrameResult {
  state: VoiceActivityState;
  event: VoiceActivityState | null;
  threshold: number;
  noiseFloor: number | null;
}

export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] ** 2;
  return Math.sqrt(sum / samples.length);
}

export function peak(samples: ArrayLike<number>): number {
  let maximum = 0;
  for (let index = 0; index < samples.length; index += 1) maximum = Math.max(maximum, Math.abs(samples[index]));
  return maximum;
}

export function clippingRatio(samples: ArrayLike<number>, threshold = CLIPPING_THRESHOLD): number {
  if (samples.length === 0) return 0;
  let clipped = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) >= threshold) clipped += 1;
  }
  return clipped / samples.length;
}

export function dbfsFromRms(value: number): number {
  return value <= 0 ? -Infinity : 20 * Math.log10(value);
}

export function classifyClipping(ratio: number): ClippingStatus {
  if (ratio >= 0.01) return 'FREQUENT CLIPPING';
  if (ratio > 0) return 'OCCASIONAL CLIPPING';
  return 'NO CLIPPING DETECTED';
}

export function frameMetrics(samples: ArrayLike<number>): AudioFrameMetrics {
  const frameRms = rms(samples);
  return {
    rms: frameRms,
    peak: peak(samples),
    clippingRatio: clippingRatio(samples),
    dbfs: dbfsFromRms(frameRms),
  };
}

export function byteTimeDomainToSamples(data: ArrayLike<number>): Float32Array {
  const samples = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 1) samples[index] = (data[index] - 128) / 128;
  return samples;
}

export function boundedVadThreshold(noiseFloor: number | null): number {
  if (noiseFloor === null) return INITIAL_VAD_THRESHOLD;
  return Math.min(MAX_VAD_THRESHOLD, Math.max(MIN_VAD_THRESHOLD, noiseFloor + 0.02));
}

export function updateNoiseFloor(previous: number | null, silenceRms: number, alpha = NOISE_FLOOR_ALPHA): number {
  if (previous === null) return silenceRms;
  return previous + alpha * (silenceRms - previous);
}

export class VoiceActivityDetector {
  private activityState: VoiceActivityState = 'SILENCE';
  private noiseFloorValue: number | null = null;
  private aboveThresholdFrames = 0;
  private belowThresholdSince: number | null = null;
  private calibrationFrames = 0;

  get state(): VoiceActivityState { return this.activityState; }
  get noiseFloor(): number | null { return this.noiseFloorValue; }
  get threshold(): number { return boundedVadThreshold(this.noiseFloorValue); }

  process(frameRms: number, timestampMs: number): VadFrameResult {
    let event: VoiceActivityState | null = null;
    const threshold = this.threshold;

    if (this.activityState === 'VOICE_ACTIVE') {
      if (frameRms >= threshold) {
        this.belowThresholdSince = null;
        return this.result('VOICE_ACTIVE', threshold);
      }
      this.belowThresholdSince ??= timestampMs;
      if (timestampMs - this.belowThresholdSince < VAD_HANGOVER_MS) {
        return this.result('VOICE_ACTIVE', threshold);
      }
      this.activityState = 'VOICE_END';
      this.aboveThresholdFrames = 0;
      this.belowThresholdSince = null;
      event = 'VOICE_END';
      return this.result(event, threshold, event);
    }

    if (this.calibrationFrames < VAD_CALIBRATION_FRAMES) {
      this.noiseFloorValue = updateNoiseFloor(this.noiseFloorValue, frameRms);
      this.calibrationFrames += 1;
      return this.result('SILENCE', this.threshold);
    }

    if (this.activityState === 'VOICE_END') this.activityState = 'SILENCE';
    if (frameRms >= threshold) {
      this.aboveThresholdFrames += 1;
      if (this.aboveThresholdFrames >= VAD_START_FRAMES) {
        this.activityState = 'VOICE_ACTIVE';
        this.aboveThresholdFrames = 0;
        event = 'VOICE_START';
        return this.result('VOICE_ACTIVE', this.threshold, event);
      }
      return this.result('VOICE_START', this.threshold);
    }

    this.aboveThresholdFrames = 0;
    this.noiseFloorValue = updateNoiseFloor(this.noiseFloorValue, frameRms);
    return this.result('SILENCE', this.threshold);
  }

  private result(state: VoiceActivityState, threshold: number, event: VoiceActivityState | null = null): VadFrameResult {
    this.activityState = state;
    return { state, event, threshold, noiseFloor: this.noiseFloorValue };
  }
}