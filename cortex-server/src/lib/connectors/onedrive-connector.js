// Microsoft OneDrive connector — official Microsoft Graph API, OAuth 2.0.
//
// SCOPE: official Microsoft identity platform OAuth consent only — never a
// cookie, never a password, never a browser session token. Read-only file
// access (Files.Read), nothing else requested.
//
// FORMAT SUPPORT: initially limited to formats Docteur can actually parse
// today — .md and .txt (no parsing needed), .pdf (routes/cv-import.js already
// uses pdf-parse), and .xlsx (lib/files.js already uses exceljs). NOT .docx:
// no docx-parsing dependency exists in this codebase yet (checked
// package.json — no mammoth/docx library installed), so it is intentionally
// left out rather than announced and silently failing. Anything unsupported
// is listed but skipped at import time with a clear reason — never silently
// claimed as "imported".
//
// All tokens are stored via secret-store.js (DPAPI). This module never
// persists a raw token to SQLite, disk, or logs.

import { getSecret, setSecret, deleteSecret } from '../secret-store.js';
import {
  upsertConnectorState, getConnectorState, disconnectConnector,
  upsertConnectorSyncItem, getConnectorSyncItem, getConnectorDeltaToken, setConnectorDeltaToken,
} from '../sqlite.js';
import { MAX_FILE_SIZE_BYTES } from '../files.js';
import { downloadWithSizeLimit } from './download-limits.js';

export const PROVIDER_ID = 'onedrive';

// Files.Read = read-only access to the user's own files (not Files.Read.All,
// which would also cover files shared with them by others — out of scope
// for a personal-notes connector). offline_access is required to receive a
// refresh_token.
export const SCOPES = ['Files.Read', 'offline_access'];

const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Batch A (audit finding F1): every outbound fetch() in this module must
// carry a timeout — without one, a hung Microsoft endpoint could block
// /connectors/:provider/sync or /callback indefinitely. Matches the pattern
// already used in lib/providers/comfyui.js (AbortSignal.timeout(...)).
const FETCH_TIMEOUT_MS = 15_000;

// Formats Docteur can actually parse today. Anything outside this set is
// reported, not imported, per mission requirement: "ne pas annoncer import
// PDF générique si non présent" (do not overclaim). .docx is intentionally
// absent — no parsing dependency for it exists in this codebase.
export const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.xlsx']);

// Batch D (Connector Center / PKCE): codeChallenge/codeChallengeMethod are
// only added to the authorize URL when provided — additive, backward
// compatible with any caller that doesn't pass them.
export function buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES, codeChallenge, codeChallengeMethod }) {
  if (!clientId || !redirectUri) throw new Error('OneDrive: clientId et redirectUri requis');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: scopes.join(' '),
    ...(state ? { state } : {}),
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
  });
  return `${MS_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code, codeVerifier }) {
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
      scope: SCOPES.join(' '),
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OneDrive OAuth: échange du code échoué (${res.status}): ${body?.error_description ?? body?.error ?? 'erreur inconnue'}`);
  return body; // { access_token, refresh_token, expires_in, scope, token_type }
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken, signal }) {
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    }),
    signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OneDrive OAuth: rafraîchissement du token échoué (${res.status}): ${body?.error_description ?? body?.error ?? 'erreur inconnue'}`);
  return body;
}

let _accessTokenCache = null; // { token, expiresAt }
let generation = 0;

export async function connect({ clientId, clientSecret, redirectUri, code, accountLabel, codeVerifier }) {
  const version = generation;
  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code, codeVerifier });
  if (version !== generation) throw new Error('OneDrive: connexion annulée');
  if (!tokens.refresh_token) {
    throw new Error('OneDrive OAuth: aucun refresh_token reçu — vérifie que le scope offline_access est bien accordé.');
  }
  setSecret('onedrive_oauth_refresh_token', tokens.refresh_token);
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
  deleteSecret('onedrive_oauth_refresh_token');
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
  const refreshToken = getSecret('onedrive_oauth_refresh_token', { migrateLegacy: false });
  if (!refreshToken) throw new Error('OneDrive: non connecté (aucun refresh_token stocké)');
  const version = generation;
  const refreshed = await refreshAccessToken({ clientId, clientSecret, refreshToken, signal });
  signal?.throwIfAborted();
  if (version !== generation) throw new Error('OneDrive: connexion annulée');
  _accessTokenCache = { token: refreshed.access_token, expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000 - 30_000 };
  return _accessTokenCache.token;
}

function extOf(name) {
  const m = /\.[^./\\]+$/.exec(name ?? '');
  return m ? m[0].toLowerCase() : '';
}

// Lists files under a folder (default: root), or performs an incremental
// delta query when a delta token is available (Microsoft Graph delta query
// — see https://learn.microsoft.com/graph/api/driveitem-delta).
export async function listChanges({ clientId, clientSecret, folderPath = null, signal }) {
  const accessToken = await getValidAccessToken({ clientId, clientSecret, signal });
  const deltaToken = getConnectorDeltaToken(PROVIDER_ID);
  const basePath = folderPath ? `/me/drive/root:/${encodeURIComponent(folderPath)}:` : '/me/drive/root';
  const url = deltaToken
    ? `${GRAPH_BASE}${basePath}/delta?token=${encodeURIComponent(deltaToken)}`
    : `${GRAPH_BASE}${basePath}/delta`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OneDrive Graph ${res.status}: ${body?.error?.message ?? 'erreur inconnue'}`);

  const items = (body.value ?? []).filter(item => !item.folder && !item.deleted);
  const skipped = items.filter(item => !SUPPORTED_EXTENSIONS.has(extOf(item.name)));
  const supported = items.filter(item => SUPPORTED_EXTENSIONS.has(extOf(item.name)));

  const nextLink = body['@odata.nextLink'];
  const deltaLink = body['@odata.deltaLink'];
  if (deltaLink) {
    const nextToken = new URL(deltaLink).searchParams.get('token');
    if (nextToken) setConnectorDeltaToken(PROVIDER_ID, nextToken);
  }

  return {
    supported: supported.map(item => ({
      externalId: item.id,
      title: item.name,
      size: item.size,
      lastModified: item.lastModifiedDateTime,
      contentHash: item.file?.hashes?.quickXorHash ?? item.eTag ?? null,
      downloadUrl: item['@microsoft.graph.downloadUrl'] ?? null,
      ext: extOf(item.name),
    })),
    skipped: skipped.map(item => ({ title: item.name, ext: extOf(item.name), reason: 'format non pris en charge' })),
    hasMore: !!nextLink,
  };
}

// Longer timeout than FETCH_TIMEOUT_MS: this downloads a file body (not a
// small JSON API response), so 15s would be too aggressive for a legitimate
// multi-MB file.
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Batch C (audit finding F2): same ceiling as a directly-uploaded file
// (lib/files.js) — a OneDrive file has no reason to be treated more
// permissively than one the user drags into Docteur themselves, and every
// format this connector supports (.md/.txt/.pdf/.xlsx) is realistically well
// under this size for a personal-notes use case.
export const ONEDRIVE_MAX_DOWNLOAD_BYTES = MAX_FILE_SIZE_BYTES;

export class OneDriveFileTooLargeError extends Error {
  constructor(message, { declaredSize = null, receivedBytes = null } = {}) {
    super(message);
    this.name = 'OneDriveFileTooLargeError';
    this.code = 'ONEDRIVE_FILE_TOO_LARGE';
    this.declaredSize = declaredSize;
    this.receivedBytes = receivedBytes;
  }
}

// Batch D: the actual streaming/size-limit enforcement now lives in the
// shared helper (lib/connectors/download-limits.js, extracted from this
// exact logic so Google Drive gets identical protection). No code path here
// buffers an unbounded amount of data — a response with no streamable body
// is treated as an error, never read via an unbounded res.arrayBuffer().
// downloadUrl is a Microsoft-issued pre-authenticated URL (no Authorization
// header needed/sent here), and any error thrown below never includes it,
// any header, or a raw stack — only a fixed code + byte counts.
export async function downloadFileContent(downloadUrl, { maxBytes = ONEDRIVE_MAX_DOWNLOAD_BYTES, signal } = {}) {
  return downloadWithSizeLimit(downloadUrl, {
    maxBytes,
    ErrorClass: OneDriveFileTooLargeError,
    fetchOptions: { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
    buildTooLargeMessage: ({ declaredSize, maxBytes: limit }) => `OneDrive: fichier trop volumineux (${declaredSize} octets, limite ${limit})`,
    buildStreamingTooLargeMessage: ({ maxBytes: limit }) => `OneDrive: fichier trop volumineux (dépassement en cours de lecture, > ${limit} octets)`,
    buildNetworkErrorMessage: () => 'OneDrive: téléchargement échoué (réseau ou délai dépassé)',
    buildHttpErrorMessage: (status) => `OneDrive: téléchargement échoué (${status})`,
    buildNoBodyErrorMessage: () => 'OneDrive: téléchargement échoué (réponse sans corps exploitable)',
  });
}

export function isAlreadySynced(externalId) {
  return !!getConnectorSyncItem(PROVIDER_ID, externalId);
}

export function markSynced(externalId, pageId, contentHash) {
  upsertConnectorSyncItem(PROVIDER_ID, externalId, { pageId, contentHash });
}
