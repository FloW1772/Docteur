// YouTube Data API v3 connector — official OAuth 2.0, read-only scopes.
//
// SCOPE: this connector uses the OFFICIAL YouTube Data API with the user's
// own OAuth consent — never cookies, never a scraped session, never a
// password. It is a DIFFERENT feature from lib/ytdlp.js (which downloads
// PUBLIC video/channel content via yt-dlp for the existing "veille" capture
// flow) — this connector reads the signed-in user's OWN account data
// (uploaded videos, playlists, liked videos) that only OAuth can see.
//
// KNOWN API LIMITATION (documented, not worked around): the YouTube Data API
// does NOT expose a user's watch history — Google removed that endpoint
// years ago for privacy reasons, and there is no official replacement. This
// connector therefore never claims to sync "watch history". It can only
// sync what the API actually exposes: the user's own uploaded videos, their
// playlists (and playlist items), and (if the 'youtube.readonly' scope is
// granted) liked videos via the special "LL" playlist alias.
//
// All tokens are stored via secret-store.js (DPAPI). This module never
// persists a raw token to SQLite, disk, or logs.

import { getSecret, setSecret, deleteSecret } from '../secret-store.js';
import { upsertConnectorState, getConnectorState, disconnectConnector, upsertConnectorSyncItem, getConnectorSyncItem } from '../sqlite.js';

export const PROVIDER_ID = 'youtube';

// Minimal read-only scope: https://www.googleapis.com/auth/youtube.readonly
// grants read access to the account's uploads, playlists and playlist items.
// We deliberately do NOT request the broader 'youtube' (read/write) scope.
export const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Batch A (audit finding F1): every outbound fetch() in this module must
// carry a timeout — without one, a hung Google endpoint could block
// /connectors/:provider/sync or /callback indefinitely. Matches the pattern
// already used in lib/providers/comfyui.js (AbortSignal.timeout(...)).
const FETCH_TIMEOUT_MS = 15_000;

// Data types the user can choose to sync — each maps to a real, officially
// supported YouTube Data API endpoint. Nothing here is aspirational.
export const AVAILABLE_DATA_TYPES = Object.freeze({
  uploaded_videos: { label: 'Mes vidéos publiées', endpoint: 'uploads' },
  playlists:       { label: 'Mes playlists',        endpoint: 'playlists' },
  liked_videos:    { label: 'Vidéos "J\'aime"',      endpoint: 'liked' },
});

export function buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES, codeChallenge }) {
  if (!clientId || !redirectUri) throw new Error('YouTube: clientId et redirectUri requis');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    ...(state ? { state } : {}),
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code, codeVerifier }) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube OAuth: échange du code échoué (${res.status}): ${body?.error_description ?? body?.error ?? 'erreur inconnue'}`);
  return body; // { access_token, refresh_token, expires_in, scope, token_type }
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken, signal }) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube OAuth: rafraîchissement du token échoué (${res.status}): ${body?.error_description ?? body?.error ?? 'erreur inconnue'}`);
  return body; // { access_token, expires_in, ... }
}

// Persists tokens after a successful authorization — access token cached
// in-memory with its expiry, refresh token in the secret store.
let _accessTokenCache = null; // { token, expiresAt }
let generation = 0;

export async function connect({ clientId, clientSecret, redirectUri, code, accountLabel, codeVerifier }) {
  const version = generation;
  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code, codeVerifier });
  if (version !== generation) throw new Error('YouTube: connexion annulée');
  if (!tokens.refresh_token) {
    throw new Error('YouTube OAuth: aucun refresh_token reçu — révoque l\'accès existant dans ton compte Google puis réessaie (prompt=consent requis à la première connexion).');
  }
  setSecret('youtube_oauth_refresh_token', tokens.refresh_token);
  _accessTokenCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 - 30_000 };
  upsertConnectorState(PROVIDER_ID, {
    connected: true,
    account_label: accountLabel ?? null,
    scopes: SCOPES,
    connected_at: new Date().toISOString(),
  });
  return { connected: true, account_label: accountLabel ?? null };
}

export function disconnect({ deleteSyncedData = false } = {}) {
  generation++;
  deleteSecret('youtube_oauth_refresh_token');
  _accessTokenCache = null;
  disconnectConnector(PROVIDER_ID);
  return { disconnected: true, deleteSyncedData };
}

export function isConnected() {
  return getConnectorState(PROVIDER_ID)?.connected === true;
}

async function getValidAccessToken({ clientId, clientSecret, signal }) {
  signal?.throwIfAborted();
  if (_accessTokenCache && _accessTokenCache.expiresAt > Date.now()) return _accessTokenCache.token;
  const refreshToken = getSecret('youtube_oauth_refresh_token', { migrateLegacy: false });
  if (!refreshToken) throw new Error('YouTube: non connecté (aucun refresh_token stocké)');
  const version = generation;
  const refreshed = await refreshAccessToken({ clientId, clientSecret, refreshToken, signal });
  signal?.throwIfAborted();
  if (version !== generation) throw new Error('YouTube: connexion annulée');
  _accessTokenCache = { token: refreshed.access_token, expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000 - 30_000 };
  return _accessTokenCache.token;
}

async function apiGet(path, { accessToken, params = {}, signal }) {
  signal?.throwIfAborted();
  const url = new URL(`${YOUTUBE_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${body?.error?.message ?? 'erreur inconnue'}`);
  return body;
}

// Fetches the current user's uploaded-videos playlist id (every channel has
// an implicit "uploads" playlist), then lists its items. This is the only
// officially supported way to list "my videos".
async function fetchUploadedVideos({ accessToken, maxResults = 50, signal }) {
  const channels = await apiGet('/channels', { accessToken, signal, params: { part: 'contentDetails', mine: 'true' } });
  const uploadsPlaylistId = channels?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];
  return fetchPlaylistItems({ accessToken, playlistId: uploadsPlaylistId, maxResults, signal });
}

async function fetchLikedVideos({ accessToken, maxResults = 50, signal }) {
  // The special playlist id "LL" is the officially documented alias for the
  // authenticated user's liked-videos list (requires youtube.readonly).
  return fetchPlaylistItems({ accessToken, playlistId: 'LL', maxResults, signal });
}

async function fetchPlaylistItems({ accessToken, playlistId, maxResults = 50, signal }) {
  const data = await apiGet('/playlistItems', {
    accessToken, signal,
    params: { part: 'snippet,contentDetails', playlistId, maxResults },
  });
  return (data.items ?? []).map(item => ({
    externalId: item.contentDetails?.videoId ?? item.id,
    title: item.snippet?.title ?? '(sans titre)',
    description: item.snippet?.description ?? '',
    publishedAt: item.snippet?.publishedAt ?? item.contentDetails?.videoPublishedAt ?? null,
    url: item.contentDetails?.videoId ? `https://www.youtube.com/watch?v=${item.contentDetails.videoId}` : null,
  }));
}

async function fetchPlaylists({ accessToken, maxResults = 50, signal }) {
  const data = await apiGet('/playlists', { accessToken, signal, params: { part: 'snippet,contentDetails', mine: 'true', maxResults } });
  return (data.items ?? []).map(item => ({
    externalId: item.id,
    title: item.snippet?.title ?? '(sans titre)',
    description: item.snippet?.description ?? '',
    itemCount: item.contentDetails?.itemCount ?? 0,
    publishedAt: item.snippet?.publishedAt ?? null,
    url: `https://www.youtube.com/playlist?list=${item.id}`,
  }));
}

// Returns items for the requested data types. Never touches privacy: caller
// (routes/connectors.js) is responsible for tagging every returned item
// source='youtube_private', privacy=true, egress_policy='local_only'.
export async function fetchItems({ clientId, clientSecret, dataTypes = ['uploaded_videos'], signal }) {
  const accessToken = await getValidAccessToken({ clientId, clientSecret, signal });
  const results = [];
  for (const type of dataTypes) {
    signal?.throwIfAborted();
    if (type === 'uploaded_videos') results.push(...(await fetchUploadedVideos({ accessToken, signal })).map(i => ({ ...i, dataType: type })));
    else if (type === 'playlists') results.push(...(await fetchPlaylists({ accessToken, signal })).map(i => ({ ...i, dataType: type })));
    else if (type === 'liked_videos') results.push(...(await fetchLikedVideos({ accessToken, signal })).map(i => ({ ...i, dataType: type })));
  }
  return results;
}

export function isAlreadySynced(externalId) {
  return !!getConnectorSyncItem(PROVIDER_ID, externalId);
}

export function markSynced(externalId, pageId, contentHash) {
  upsertConnectorSyncItem(PROVIDER_ID, externalId, { pageId, contentHash });
}
