// YouTube Smart Discovery V2 — frontend input detection. The server (classifyDiscoveryInput) is the authority; this
// mirror only decides "is this a channel discovery request?" and predicts the mode for the very first paint.
import type { YouTubeDiscoveryMode, YouTubeSourceTab } from '../cortex/client';

export interface YouTubeDiscoveryInput {
  /** what is sent to the server (URL, or a bare @handle when context is 'youtube') */
  input: string;
  context?: 'youtube';
  mode: YouTubeDiscoveryMode;
  tab: YouTubeSourceTab | null;
  handle: string | null;
}

// explicit YouTube workflow prefixes: "chaine <url|@handle>", "yt …", "youtube …"
const WORKFLOW_PREFIX = /^(?:chaine|chaîne|yt|youtube)\s+(\S+)$/i;
const BARE_HANDLE     = /^\/?(@[^\s/?#]+)(?:\/(videos|shorts|streams))?\/?$/;
const CHANNEL_PATH    = /^\/(@[^/?#\s]+|channel\/[^/?#\s]+|c\/[^/?#\s]+|user\/[^/?#\s]+)(?:\/(videos|shorts|streams|featured|about))?\/?$/;

function modeFor(tab: string | null | undefined): { mode: YouTubeDiscoveryMode; tab: YouTubeSourceTab | null } {
  if (tab === 'videos')  return { mode: 'CHANNEL_VIDEOS_ONLY',  tab: 'videos' };
  if (tab === 'shorts')  return { mode: 'CHANNEL_SHORTS_ONLY',  tab: 'shorts' };
  if (tab === 'streams') return { mode: 'CHANNEL_STREAMS_ONLY', tab: 'streams' };
  return { mode: 'CHANNEL_ALL_MEDIA', tab: null };
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Returns the discovery request for a channel URL / explicit-workflow @handle, or null when the text is anything else
 * (single video, single Short, playlist, /live, unsupported tab, generic text, a bare @mention in a generic field…).
 */
export function detectYouTubeDiscoveryInput(raw: string): YouTubeDiscoveryInput | null {
  let text = raw.trim();
  let explicitYouTube = false;
  const prefixed = text.match(WORKFLOW_PREFIX);
  if (prefixed) { text = prefixed[1]; explicitYouTube = true; }

  const bare = text.match(BARE_HANDLE);
  if (bare && !/^https?:\/\//i.test(text)) {
    if (!explicitYouTube) return null; // a bare @handle is ambiguous in a generic field
    return { input: text, context: 'youtube', ...modeFor(bare[2]), handle: safeDecode(bare[1]) };
  }

  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;
    const match = url.pathname.match(CHANNEL_PATH);
    if (!match) return null;
    const handle = match[1].startsWith('@') ? safeDecode(match[1]) : null;
    return { input: text, ...modeFor(match[2]), handle };
  } catch {
    return null;
  }
}
