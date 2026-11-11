import { classifyMediaResource, type MediaDescriptor } from './media-resource';

export type VideoDownloadAvailability =
  | { status: 'available'; descriptor: MediaDescriptor; filename: string }
  | { status: 'unavailable'; descriptor: MediaDescriptor; reason: string }
  | { status: 'blocked'; descriptor: MediaDescriptor; reason: string }
  | null;

const EXTERNAL_VIDEO_HOSTS: Record<string, string> = {
  'dailymotion.com': 'Dailymotion',
  'vimeo.com': 'Vimeo',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
};

function externalVideoPlatform(host: string): string | null {
  const normalized = host.toLowerCase().replace(/^www\./, '');
  const match = Object.keys(EXTERNAL_VIDEO_HOSTS).find(base => normalized === base || normalized.endsWith(`.${base}`));
  return match ? EXTERNAL_VIDEO_HOSTS[match] : null;
}

export function safeVideoFilename(descriptor: MediaDescriptor): string {
  let name = descriptor.url;
  try {
    const url = new URL(descriptor.url);
    const decoded = decodeURIComponent(url.pathname).split('/').filter(Boolean).pop();
    if (decoded) name = decoded;
  } catch { /* classifyMediaResource already rejected malformed URLs */ }
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!name || name === '.' || name === '..') name = `video-${descriptor.host || 'download'}`;
  return name.slice(0, 120);
}

export function videoDownloadAvailability(url: string): VideoDownloadAvailability {
  const descriptor = classifyMediaResource({ url });
  if (descriptor.blocked) return { status: 'blocked', descriptor, reason: descriptor.blocked.message };
  if (descriptor.kind === 'video') return { status: 'available', descriptor, filename: safeVideoFilename(descriptor) };
  const platform = externalVideoPlatform(descriptor.host);
  if (platform) {
    return {
      status: 'unavailable',
      descriptor,
      reason: `Téléchargement non disponible ici : ${platform} ne fournit pas de fichier vidéo direct autorisé pour ce lien.`,
    };
  }
  return null;
}