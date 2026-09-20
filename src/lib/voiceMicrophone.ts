export type VoicePermission = 'unknown' | 'prompt' | 'granted' | 'denied';

export interface VoiceInputDevice {
  deviceId: string;
  label: string;
  groupId?: string;
  isDefault: boolean;
}

export interface VoiceRequestedProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface VoiceActualSettings {
  deviceId?: string;
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export const VOICE_DEVICE_STORAGE_KEY = 'docteur.voice.inputDeviceId';

export const REQUESTED_VOICE_PROCESSING: VoiceRequestedProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export function getStoredVoiceDeviceId(): string | null {
  try {
    return localStorage.getItem(VOICE_DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeVoiceDeviceId(deviceId: string | null): void {
  try {
    if (deviceId) localStorage.setItem(VOICE_DEVICE_STORAGE_KEY, deviceId);
    else localStorage.removeItem(VOICE_DEVICE_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
}

export function getVoiceAudioConstraints(deviceId?: string | null): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

export async function getVoicePermission(): Promise<VoicePermission> {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (status.state === 'granted') return 'granted';
    if (status.state === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unknown';
  }
}

export async function enumerateVoiceInputDevices(): Promise<VoiceInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(device => device.kind === 'audioinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label,
      groupId: device.groupId || undefined,
      isDefault: device.deviceId === 'default' || index === 0,
    }));
}

export function readVoiceTrackSettings(track: MediaStreamTrack): VoiceActualSettings {
  const settings = track.getSettings();
  return {
    deviceId: settings.deviceId,
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
  };
}

export function describeVoiceCaptureError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError': return 'Autorisation microphone refusée.';
    case 'NotFoundError': return 'Aucun microphone disponible.';
    case 'NotReadableError': return 'Le microphone est utilisé ou inaccessible.';
    case 'OverconstrainedError': return 'Le microphone sélectionné n’est plus disponible.';
    case 'AbortError': return 'La capture microphone a été interrompue.';
    default: return 'Microphone inaccessible. Réessayez.';
  }
}

export function isVoiceDeviceUnavailable(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === 'OverconstrainedError' || error.name === 'NotFoundError';
}
