// Backend only: explicit file IDs already granted to this app with drive.file.
// No files.list, no global readonly scope, no simulated Picker.
import { getSecret, setSecret, deleteSecret } from '../secret-store.js';
import { getConnectorState, upsertConnectorState, disconnectConnector, getConnectorSyncItem, upsertConnectorSyncItem } from '../sqlite.js';
import { MAX_FILE_SIZE_BYTES, parseOriginalFile } from '../files.js';
import { downloadWithSizeLimit } from './download-limits.js';
import { fetchWithDriveRetry } from './google-drive-rate-limit.js';

export const PROVIDER_ID = 'google_drive';
export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
export const GOOGLE_DRIVE_MAX_DOWNLOAD_BYTES = MAX_FILE_SIZE_BYTES;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files/';
const REFRESH_KEY = 'google_drive_oauth_refresh_token';
let accessTokenCache = null;
let generation = 0;

export class GoogleDriveFileTooLargeError extends Error {
  constructor(message, { declaredSize = null, receivedBytes = null } = {}) {
    super(message);
    this.name = 'GoogleDriveFileTooLargeError';
    this.code = 'GOOGLE_DRIVE_FILE_TOO_LARGE';
    this.declaredSize = declaredSize;
    this.receivedBytes = receivedBytes;
  }
}

export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
    response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state,
    code_challenge: codeChallenge, code_challenge_method: 'S256' });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(params, signal) {
  const res = await fetch(TOKEN_URL, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('Google Drive: échange OAuth échoué');
  return body;
}

function cacheToken(tokens) {
  accessTokenCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 - 30_000 };
}

export async function connect({ clientId, clientSecret, redirectUri, code, codeVerifier, accountLabel }) {
  if (!codeVerifier) throw new Error('Google Drive: PKCE requis');
  const version = generation;
  const tokens = await tokenRequest({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
    code, code_verifier: codeVerifier, grant_type: 'authorization_code' });
  if (version !== generation) throw new Error('Google Drive: connexion annulée');
  if (!tokens.refresh_token) throw new Error('Google Drive: aucun refresh_token reçu');
  setSecret(REFRESH_KEY, tokens.refresh_token);
  cacheToken(tokens);
  upsertConnectorState(PROVIDER_ID, { connected: true, account_label: accountLabel ?? null, scopes: SCOPES, connected_at: new Date().toISOString() });
  return { connected: true, account_label: accountLabel ?? null };
}

export function disconnect() {
  generation++;
  accessTokenCache = null;
  deleteSecret(REFRESH_KEY);
  disconnectConnector(PROVIDER_ID);
}

export function isConnected() { return getConnectorState(PROVIDER_ID)?.connected === true; }

async function getAccessToken({ clientId, clientSecret, signal }) {
  signal?.throwIfAborted();
  if (accessTokenCache?.expiresAt > Date.now()) return accessTokenCache.token;
  const refreshToken = getSecret(REFRESH_KEY, { migrateLegacy: false });
  if (!refreshToken) throw new Error('Google Drive: non connecté');
  const version = generation;
  const tokens = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, signal);
  signal?.throwIfAborted();
  if (version !== generation) throw new Error('Google Drive: connexion annulée');
  if (tokens.refresh_token) setSecret(REFRESH_KEY, tokens.refresh_token);
  cacheToken(tokens);
  return tokens.access_token;
}

export function validateFileIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) {
    throw new Error('Google Drive: file_ids doit contenir 1 à 50 identifiants explicites');
  }
  return [...new Set(ids)];
}

export async function downloadFileContent(fileId, { accessToken, signal, maxBytes = GOOGLE_DRIVE_MAX_DOWNLOAD_BYTES, mimeType } = {}) {
  validateFileIds([fileId]);
  const suffix = mimeType === 'application/vnd.google-apps.document' ? '/export?mimeType=text%2Fplain' : '?alt=media';
  return downloadWithSizeLimit(`${FILES_URL}${encodeURIComponent(fileId)}${suffix}`, {
    maxBytes, ErrorClass: GoogleDriveFileTooLargeError, fetchImpl: fetchWithDriveRetry,
    fetchOptions: { headers: { Authorization: `Bearer ${accessToken}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) },
    buildNetworkErrorMessage: () => 'Google Drive: téléchargement annulé ou échoué',
    buildHttpErrorMessage: status => `Google Drive: téléchargement échoué (${status})`,
  });
}

export async function readFile(fileId, credentials) {
  validateFileIds([fileId]);
  const { signal } = credentials;
  const accessToken = await getAccessToken(credentials);
  const url = `${FILES_URL}${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,md5Checksum,trashed`;
  const bytes = await downloadWithSizeLimit(url, { maxBytes: 64 * 1024, ErrorClass: Error, fetchImpl: fetchWithDriveRetry,
    fetchOptions: { headers: { Authorization: `Bearer ${accessToken}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) } });
  const meta = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (meta.trashed) return { skipped: true, title: meta.name, reason: 'fichier supprimé' };
  const ext = /\.[^./\\]+$/.exec(meta.name ?? '')?.[0].toLowerCase();
  const googleDoc = meta.mimeType === 'application/vnd.google-apps.document';
  if (!googleDoc && (meta.mimeType?.startsWith('application/vnd.google-apps.') || !['.txt', '.md', '.pdf', '.xlsx'].includes(ext))) {
    return { skipped: true, title: meta.name, reason: 'format non pris en charge' };
  }
  if (Number(meta.size) > GOOGLE_DRIVE_MAX_DOWNLOAD_BYTES) throw new GoogleDriveFileTooLargeError('Google Drive: fichier trop volumineux', { declaredSize: Number(meta.size), receivedBytes: 0 });
  const buffer = Buffer.from(await downloadFileContent(fileId, { accessToken, signal, mimeType: meta.mimeType }));
  signal?.throwIfAborted();
  let content;
  if (ext === '.pdf' && !googleDoc) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try { content = (await parser.getText()).text; } finally { await parser.destroy(); }
  } else if (ext === '.xlsx' && !googleDoc) {
    const parsed = await parseOriginalFile(buffer, meta.name);
    content = JSON.stringify(parsed.summary);
  } else { content = buffer.toString('utf8'); }
  signal?.throwIfAborted();
  return { externalId: fileId, title: meta.name, description: content, contentHash: meta.md5Checksum ?? null };
}

export function isAlreadySynced(id) { return !!getConnectorSyncItem(PROVIDER_ID, id); }
export function markSynced(id, pageId, contentHash) { upsertConnectorSyncItem(PROVIDER_ID, id, { pageId, contentHash }); }
