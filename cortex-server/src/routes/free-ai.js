import { Hono } from 'hono';
import { getCatalog, getCachedCatalogOnly, clearCatalogCache, getCacheInfo, NATIVE_PROVIDER_MAP, CATALOG_META } from '../lib/free-ai-catalog.js';
import { assertCloudAllowed, isStrictLocalMode } from '../lib/strict-local.js';
import { getCloudKeyStatuses, getRouterSettings, getCloudKeys } from '../lib/sqlite.js';

const STRICT_LOCAL_MESSAGE = 'Mode strictement local activé — l\'actualisation Internet du catalogue IA gratuites est désactivée. Les données affichées proviennent du dernier cache local.';

// Attaches live, Docteur-local state (never catalog data) to each normalized
// provider: whether it maps to a native Docteur provider and, if so, whether
// it's actually configured (via secret-store status only — never a key
// value), plus whether it's plausibly reachable through FreeLLMAPI.
function attachDocteurState(provider) {
  const nativeId = provider.nativeDocteurProvider;
  const keyStatuses = getCloudKeyStatuses();
  const configuredInDocteur = nativeId ? keyStatuses[nativeId] === 'valid' : false;

  // "Available via FreeLLMAPI" can only be asserted when FreeLLMAPI itself is
  // configured and reachable — the actual upstream-provider identity of a
  // FreeLLMAPI model is not reliably knowable (see /router/freellmapi/models),
  // so this never claims a *specific* free-ai-catalog provider is present
  // there — only that FreeLLMAPI, as a generic gateway, is an option.
  const freellmapiSettings = getRouterSettings()?.freellmapi ?? {};
  const freellmapiConfigured = !!freellmapiSettings.baseUrl && !!getCloudKeys().freellmapi_key;

  let docteurState;
  if (configuredInDocteur) docteurState = 'configured';
  else if (nativeId) docteurState = 'native_not_configured';
  else if (freellmapiConfigured) docteurState = 'maybe_via_freellmapi';
  else docteurState = 'not_integrated';

  return {
    ...provider,
    configuredInDocteur,
    availableViaFreeLLMAPI: docteurState === 'maybe_via_freellmapi',
    docteurState,
  };
}

function verificationFreshness(lastVerified) {
  if (!lastVerified) return 'unknown';
  const then = new Date(lastVerified).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const ageDays = (Date.now() - then) / (24 * 60 * 60 * 1000);
  if (ageDays > 90) return 'recheck'; // "À revérifier avant utilisation"
  if (ageDays > 30) return 'aging';   // "Informations potentiellement anciennes"
  return 'fresh';
}

export function createFreeAiRoute({ logger }) {
  const route = new Hono();

  // GET /api/free-ai/providers — normalized, Docteur-annotated catalog.
  // Query: ?refresh=1 forces a fetch attempt (still subject to Strict Local).
  route.get('/free-ai/providers', async (c) => {
    const wantsRefresh = c.req.query('refresh') === '1';
    const strictLocal = isStrictLocalMode();

    // GET always degrades gracefully under Strict Local — it serves the
    // cache instead of erroring, even when ?refresh=1 was requested. Only
    // the explicit POST /free-ai/refresh action (below) returns a hard 503,
    // since that endpoint's entire purpose is to force a network fetch.
    const effectiveForce = wantsRefresh && !strictLocal;

    try {
      // Under Strict Local, never let getCatalog() attempt a network fetch —
      // not even to populate an initially empty cache. cacheOnly here means
      // "return whatever is cached (possibly nothing), full stop."
      const { result, stale, fromCache, error } = strictLocal
        ? getCachedCatalogOnly()
        : await getCatalog({ force: effectiveForce });
      const providers = result.providers
        .map(attachDocteurState)
        .map(p => ({ ...p, verificationFreshness: verificationFreshness(p.lastVerified) }));

      if (logger) {
        logger.info({
          providerCount: providers.length,
          cacheHit: fromCache,
          sourceVersion: result.version,
        }, 'FREE_AI_CATALOG_SERVED');
      }

      return c.json({
        providers,
        source: result.source,
        sourceRepo: result.sourceRepo,
        catalogVersion: result.version,
        catalogGenerated: result.generated,
        fetchedAt: result.fetchedAt,
        stale,
        strictLocalActive: strictLocal,
        strictLocalBlockedRefresh: strictLocal && wantsRefresh,
        warning: error ?? (strictLocal && providers.length === 0 ? 'Aucun catalogue hors ligne disponible.' : null),
      });
    } catch (error) {
      if (logger) logger.error({ err: error.message }, 'FREE_AI_CATALOG_FETCH_FAILED');
      // No cache at all and the fetch failed — clean empty state, never a 500
      // that would break the rest of Settings.
      return c.json({
        providers: [],
        source: CATALOG_META.source,
        sourceRepo: CATALOG_META.repo,
        catalogVersion: null,
        catalogGenerated: null,
        fetchedAt: null,
        stale: false,
        strictLocalActive: strictLocal,
        strictLocalBlockedRefresh: strictLocal && wantsRefresh,
        warning: strictLocal ? STRICT_LOCAL_MESSAGE : (error.message ?? 'Catalogue indisponible'),
      }, strictLocal ? 200 : 502);
    }
  });

  // POST /api/free-ai/refresh — explicit manual refresh action.
  route.post('/free-ai/refresh', async (c) => {
    const blocked = assertCloudAllowed(c, STRICT_LOCAL_MESSAGE);
    if (blocked) return blocked;

    try {
      const { result, stale, error } = await getCatalog({ force: true });
      const providers = result.providers
        .map(attachDocteurState)
        .map(p => ({ ...p, verificationFreshness: verificationFreshness(p.lastVerified) }));

      if (logger) {
        logger.info({ providerCount: providers.length, cacheHit: false, sourceVersion: result.version }, 'FREE_AI_CATALOG_REFRESHED');
      }

      return c.json({
        ok: true,
        providers,
        source: result.source,
        catalogVersion: result.version,
        catalogGenerated: result.generated,
        fetchedAt: result.fetchedAt,
        stale,
        warning: error ?? null,
      });
    } catch (error) {
      if (logger) logger.error({ err: error.message }, 'FREE_AI_CATALOG_REFRESH_FAILED');
      return c.json({ ok: false, error: error.message }, 502);
    }
  });

  // GET /api/free-ai/cache-info — small helper for the UI's "actualisé il y a…" label.
  route.get('/free-ai/cache-info', (c) => c.json(getCacheInfo()));

  return route;
}

// Exposed for tests only.
export const __testables = { NATIVE_PROVIDER_MAP, clearCatalogCache };
