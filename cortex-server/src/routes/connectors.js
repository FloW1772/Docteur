// YouTube, Google Drive (Drive API v3), Microsoft OneDrive (Graph) — OAuth
// officiel uniquement (jamais cookie/session navigateur/mot de passe).
//
// Tout contenu importé par ces connecteurs est marqué source=<provider>_private,
// privacy=true, egress_policy='local_only' — propagé au neurone ET à la page.
// Aucun contenu importé par ces connecteurs n'est jamais transmis à un provider
// cloud (voir guardCloudCall dans lib/privacy-guard.js et le marquage
// markPrivate() appliqué par server.js au moment de construire les messages).
//
// Le frontend ne reçoit JAMAIS un token : uniquement connected/account_label/
// scopes/last_sync_at/auto_sync (voir getAllConnectorStates()).

import { Hono } from 'hono';
import crypto from 'node:crypto';
import {
  getAllConnectorStates, getConnectorState, upsertConnectorState,
  recordConnectorSyncResult, deleteConnectorSyncItems, getConnectorSyncItemsCount,
  savePageToStore, getPageFromStore, deletePageFromStore,
} from '../lib/sqlite.js';
import { getSecret, setSecret, hasSecret, deleteSecret } from '../lib/secret-store.js';
import * as youtube from '../lib/connectors/youtube-connector.js';
import * as onedrive from '../lib/connectors/onedrive-connector.js';
import * as googleDrive from '../lib/connectors/google-drive-connector.js';
import { listConnectorDefinitions, isActiveConnector } from '../lib/connector-registry.js';
import { generateCodeVerifier, deriveCodeChallenge, PKCE_METHOD } from '../lib/pkce.js';

const CONNECTORS = Object.assign(Object.create(null), { youtube, onedrive, google_drive: googleDrive });

// Batch A (audit finding F17): a raw provider/OAuth error message (e.g.
// Google/Microsoft's own error_description string) must never reach the
// HTTP client verbatim — only a fixed, generic message. Batch D also keeps
// upstream error bodies out of logs and persisted status: both can contain
// provider-supplied URLs/tokens, and status is returned to the frontend.
function sanitizeProviderError(provider) {
  return `Échec de la communication avec ${provider} — voir les journaux serveur pour le détail.`;
}

// OAuth client id/secret are app registration credentials (Google Cloud /
// Azure), not per-user secrets — but they are still sensitive, so they go
// through the same DPAPI secret store as everything else, keyed
// 'oauth_client_<provider>_id' / 'oauth_client_<provider>_secret'.
function getClientCredentials(provider) {
  return {
    clientId: getSecret(`oauth_client_${provider}_id`, { migrateLegacy: false }),
    clientSecret: getSecret(`oauth_client_${provider}_secret`, { migrateLegacy: false }),
  };
}

// In-memory only (per-process), short-lived: binds an OAuth `state` value to
// the redirect_uri used to start the flow, so the callback can validate it
// without persisting anything. Cleared after use or after 10 minutes.
const STATE_TTL_MS = 10 * 60 * 1000;

function cleanupPendingStates(pendingStates) {
  const now = Date.now();
  for (const [state, entry] of pendingStates) if (entry.expiresAt <= now) pendingStates.delete(state);
}

function textToBlocks(text) {
  return [{ id: crypto.randomUUID(), type: 'paragraph', content: text }];
}

async function ingestItem({ services, provider, item, connector, dataTypeLabel, signal }) {
  signal?.throwIfAborted();
  const externalId = item.externalId;
  if (connector.isAlreadySynced(externalId)) return { imported: false, reason: 'already_synced' };

  const now = Date.now();
  const pageId = `${provider}-${externalId}`;
  const title = item.title ?? '(sans titre)';
  const contentParts = [title];
  if (item.description) contentParts.push(item.description);
  if (item.url) contentParts.push(item.url);
  const content = contentParts.join('\n\n');

  const metadata = {
    source: `${provider}_private`,
    egress_policy: 'local_only',
    private: true,
    privacy: true,
    external_id: externalId,
    data_type: dataTypeLabel,
    imported_at: now,
    ...(item.url ? { source_url: item.url } : {}),
    ...(item.publishedAt ? { published_at: item.publishedAt } : {}),
  };

  await services.indexNeuron({ id: pageId, kind: 'connector', title, content, private: true, metadata });
  signal?.throwIfAborted();
  savePageToStore({
    id: pageId, title, kind: 'connector', blocks: textToBlocks(content),
    private: true, // connector-imported content is always private by default (mission requirement)
    createdAt: now, updatedAt: now, metadata,
  });
  connector.markSynced(externalId, pageId, item.contentHash ?? null);
  return { imported: true };
}

export function createConnectorsRoute({ services, logger }) {
  const route = new Hono();
  const pendingStates = new Map();
  const activeSyncs = new Map();
  function invalidate(provider) {
    for (const [state, entry] of pendingStates) if (entry.provider === provider) pendingStates.delete(state);
    activeSyncs.get(provider)?.abort();
  }

  route.use('/connectors/:provider/*', async (c, next) => {
    if (!isActiveConnector(c.req.param('provider'))) return c.json({ error: 'Connecteur inconnu ou indisponible' }, 404);
    await next();
  });

  // GET /api/connectors — status for every connector, no tokens
  route.get('/connectors', (c) => {
    const states = getAllConnectorStates();
    const byProvider = Object.fromEntries(states.map(s => [s.provider, s]));
    return c.json({
      connectors: listConnectorDefinitions().map(definition => {
        const provider = definition.id;
        const state = byProvider[provider];
        return {
          provider,
          ...definition,
          connected: state?.connected ?? false,
          account_label: state?.account_label ?? null,
          scopes: state?.scopes ?? [],
          auto_sync: state?.auto_sync ?? false,
          last_sync_at: state?.last_sync_at ?? null,
          last_sync_status: state?.last_sync_status ?? null,
          last_sync_error: state?.last_sync_error ?? null,
          synced_items_count: getConnectorSyncItemsCount(provider),
          client_configured: hasSecret(`oauth_client_${provider}_id`, { migrateLegacy: false }) && hasSecret(`oauth_client_${provider}_secret`, { migrateLegacy: false }),
        };
      }),
    });
  });

  // POST /api/connectors/:provider/client-credentials — store the app's own
  // OAuth client id/secret (from the user's Google Cloud / Azure app
  // registration). Never echoed back in plaintext.
  route.post('/connectors/:provider/client-credentials', async (c) => {
    const provider = c.req.param('provider');
    if (!CONNECTORS[provider]) return c.json({ error: 'Connecteur inconnu' }, 404);
    const body = await c.req.json().catch(() => null);
    const clientId = String(body?.client_id ?? '').trim();
    const clientSecret = String(body?.client_secret ?? '').trim();
    if (!clientId || !clientSecret) return c.json({ error: 'client_id et client_secret requis' }, 400);
    invalidate(provider);
    CONNECTORS[provider].disconnect();
    setSecret(`oauth_client_${provider}_id`, clientId);
    setSecret(`oauth_client_${provider}_secret`, clientSecret);
    return c.json({ ok: true, client_configured: true });
  });

  route.delete('/connectors/:provider/client-credentials', (c) => {
    const provider = c.req.param('provider');
    if (!CONNECTORS[provider]) return c.json({ error: 'Connecteur inconnu' }, 404);
    invalidate(provider);
    CONNECTORS[provider].disconnect();
    deleteSecret(`oauth_client_${provider}_id`);
    deleteSecret(`oauth_client_${provider}_secret`);
    return c.json({ ok: true, client_configured: false });
  });

  // GET /api/connectors/:provider/auth-url — builds the consent screen URL
  route.get('/connectors/:provider/auth-url', (c) => {
    const provider = c.req.param('provider');
    const connector = CONNECTORS[provider];
    if (!connector) return c.json({ error: 'Connecteur inconnu' }, 404);
    const { clientId } = getClientCredentials(provider);
    if (!clientId) return c.json({ error: `Aucun client OAuth ${provider} configuré.` }, 400);

    const redirectUri = c.req.query('redirect_uri');
    if (!redirectUri) return c.json({ error: 'redirect_uri requis' }, 400);

    cleanupPendingStates(pendingStates);
    if (pendingStates.size >= 1000) return c.json({ error: 'Trop de connexions en attente' }, 429);
    const state = crypto.randomUUID();
    const codeVerifier = generateCodeVerifier();
    pendingStates.set(state, { redirectUri, provider, codeVerifier, expiresAt: Date.now() + STATE_TTL_MS });

    const url = connector.buildAuthUrl({ clientId, redirectUri, state, codeChallenge: deriveCodeChallenge(codeVerifier), codeChallengeMethod: PKCE_METHOD });
    return c.json({ auth_url: url, state });
  });

  // POST /api/connectors/:provider/callback — exchanges the authorization
  // code for tokens. Called by the frontend once the OAuth redirect lands.
  route.post('/connectors/:provider/callback', async (c) => {
    const provider = c.req.param('provider');
    const connector = CONNECTORS[provider];
    if (!connector) return c.json({ error: 'Connecteur inconnu' }, 404);

    const body = await c.req.json().catch(() => null);
    const { code, state, redirect_uri: redirectUri, account_label: accountLabel } = body ?? {};
    if (!code || !state || !redirectUri) return c.json({ error: 'code, state et redirect_uri requis' }, 400);

    cleanupPendingStates(pendingStates);
    const pending = pendingStates.get(state);
    if (!pending || pending.provider !== provider || pending.redirectUri !== redirectUri) {
      return c.json({ error: 'state OAuth invalide ou expiré — relance la connexion.' }, 400);
    }
    pendingStates.delete(state);

    const { clientId, clientSecret } = getClientCredentials(provider);
    if (!clientId || !clientSecret) return c.json({ error: `Aucun client OAuth ${provider} configuré.` }, 400);

    try {
      const result = await connector.connect({ clientId, clientSecret, redirectUri, code, accountLabel, codeVerifier: pending.codeVerifier });
      logger?.info({ provider, account_label: result.account_label }, 'CONNECTOR_CONNECTED');
      return c.json({ ok: true, ...result });
    } catch (error) {
      logger?.warn({ provider }, 'CONNECTOR_CONNECT_FAILED');
      return c.json({ error: sanitizeProviderError(provider) }, 502);
    }
  });

  // POST /api/connectors/:provider/disconnect — always removes OAuth
  // credentials; synced data deletion requires an explicit separate flag
  // (mission requirement: default is to KEEP synced Docteur data).
  route.post('/connectors/:provider/disconnect', async (c) => {
    const provider = c.req.param('provider');
    const connector = CONNECTORS[provider];
    if (!connector) return c.json({ error: 'Connecteur inconnu' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const deleteSyncedData = body?.delete_synced_data === true;

    invalidate(provider);
    connector.disconnect({ deleteSyncedData });

    let deletedPages = 0;
    if (deleteSyncedData) {
      const pageIds = deleteConnectorSyncItems(provider);
      for (const pageId of pageIds) {
        try { deletePageFromStore(pageId); deletedPages++; } catch { /* best-effort */ }
      }
    }

    logger?.info({ provider, delete_synced_data: deleteSyncedData, deleted_pages: deletedPages }, 'CONNECTOR_DISCONNECTED');
    return c.json({ ok: true, disconnected: true, deleted_pages: deletedPages });
  });

  route.post('/connectors/:provider/cancel', (c) => {
    const controller = activeSyncs.get(c.req.param('provider'));
    controller?.abort();
    return c.json({ ok: true, cancelled: !!controller });
  });

  // POST /api/connectors/:provider/sync — manual sync (default). auto_sync
  // toggle is stored but this route is the only thing that ever triggers a
  // real sync in this phase — no background scheduler.
  route.post('/connectors/:provider/sync', async (c) => {
    const provider = c.req.param('provider');
    const connector = CONNECTORS[provider];
    if (!connector) return c.json({ error: 'Connecteur inconnu' }, 404);

    const state = getConnectorState(provider);
    if (!state?.connected) return c.json({ error: `${provider} n'est pas connecté.` }, 400);

    const { clientId, clientSecret } = getClientCredentials(provider);
    const body = await c.req.json().catch(() => ({}));
    let fileIds;
    if (provider === 'google_drive') {
      try { fileIds = googleDrive.validateFileIds(body?.file_ids); }
      catch (error) { return c.json({ error: error.message }, 400); }
    }
    if (activeSyncs.has(provider)) return c.json({ error: 'Synchronisation déjà en cours' }, 409);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
    activeSyncs.set(provider, controller);

    try {
      let imported = 0, skipped = 0, alreadySynced = 0;
      const skippedReasons = [];

      if (provider === 'youtube') {
        const dataTypes = Array.isArray(body?.data_types) && body.data_types.length > 0
          ? body.data_types
          : ['uploaded_videos'];
        const items = await youtube.fetchItems({ clientId, clientSecret, dataTypes, signal });
        for (const item of items) {
          const result = await ingestItem({ services, provider, item, connector: youtube, dataTypeLabel: item.dataType, signal });
          if (result.imported) imported++;
          else alreadySynced++;
        }
      } else if (provider === 'onedrive') {
        const { supported, skipped: skippedItems } = await onedrive.listChanges({ clientId, clientSecret, folderPath: body?.folder_path ?? null, signal });
        skipped = skippedItems.length;
        skippedReasons.push(...skippedItems);
        for (const item of supported) {
          signal.throwIfAborted();
          if (onedrive.isAlreadySynced(item.externalId)) { alreadySynced++; continue; }
          // Content extraction for .pdf/.xlsx reuses the existing ingestion
          // pipeline via a title+metadata placeholder in this phase — full
          // binary download/parse wiring is left for the sync route once a
          // real Microsoft app registration is available to test against
          // (see MASTER_PHASE_2_CONNECTORS.md, PARTIEL section).
          const result = await ingestItem({
            services, provider,
            item: { externalId: item.externalId, title: item.title, description: `Fichier OneDrive (${item.ext}, ${item.size ?? 0} octets)` },
            connector: onedrive, dataTypeLabel: 'file', signal,
          });
          if (result.imported) imported++;
          else alreadySynced++;
        }
      } else if (provider === 'google_drive') {
        for (const fileId of fileIds) {
          signal.throwIfAborted();
          if (googleDrive.isAlreadySynced(fileId)) { alreadySynced++; continue; }
          const item = await googleDrive.readFile(fileId, { clientId, clientSecret, signal });
          if (item.skipped) { skipped++; skippedReasons.push(item); continue; }
          const result = await ingestItem({ services, provider, item, connector: googleDrive, dataTypeLabel: 'file', signal });
          if (result.imported) imported++;
          else alreadySynced++;
        }
      }

      signal.throwIfAborted();
      recordConnectorSyncResult(provider, { status: 'ok' });
      logger?.info({ provider, imported, already_synced: alreadySynced, skipped }, 'CONNECTOR_SYNC_OK');
      return c.json({ ok: true, imported, already_synced: alreadySynced, skipped, skipped_items: skippedReasons });
    } catch (error) {
      const message = signal.aborted ? 'Synchronisation annulée' : sanitizeProviderError(provider);
      recordConnectorSyncResult(provider, { status: signal.aborted ? 'cancelled' : 'error', error: message });
      logger?.warn({ provider }, 'CONNECTOR_SYNC_FAILED');
      if (signal.aborted) return c.json({ error: message, cancelled: true }, 409);
      return c.json({ error: sanitizeProviderError(provider) }, 502);
    } finally {
      activeSyncs.delete(provider);
    }
  });

  // PUT /api/connectors/:provider/auto-sync — toggle only; no scheduler
  // exists yet, so this persists intent without changing runtime behavior.
  route.put('/connectors/:provider/auto-sync', async (c) => {
    const provider = c.req.param('provider');
    if (!CONNECTORS[provider]) return c.json({ error: 'Connecteur inconnu' }, 404);
    const body = await c.req.json().catch(() => ({}));
    upsertConnectorState(provider, { auto_sync: body?.enabled === true });
    return c.json({ ok: true, auto_sync: body?.enabled === true });
  });

  return route;
}
