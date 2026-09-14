import { Hono } from 'hono';
import { getModelStatuses, getCloudProviderStatuses, clearProviderCooldown } from '../lib/router.js';
import { recordSuccess, recordFailure } from '../lib/provider-state.js';
import { ErrorCategory } from '../lib/provider-errors.js';
import {
  getRouterSettings, getRouterStats, setRouterSettings,
  getCloudKeys, setCloudKey, getCloudKeysMasked, getCloudKeyStatuses, getCloudStatsThisMonth,
  getSiteShortcuts, setSiteShortcut, deleteSiteShortcut,
  getMeta, setMeta,
} from '../lib/sqlite.js';
import { getPersonaSettings, updatePersonaSettings } from '../lib/persona.js';
import { testKey as testGemini }     from '../lib/providers/gemini.js';
import { testKey as testGroq }       from '../lib/providers/groq.js';
import { testKey as testOpenRouter } from '../lib/providers/openrouter.js';
import { testKey as testAnthropic }  from '../lib/providers/anthropic.js';
import { testKey as testOpenAI }     from '../lib/providers/openai.js';
import * as freellmapiProvider       from '../lib/providers/freellmapi.js';
import { testKey as testPAIR }       from '../lib/providers/pair.js';
import { testKey as testClaudeOAuth, claudeOAuthProvider } from '../lib/providers/claude-oauth.js';
import { testKey as testCodex, codexProvider }      from '../lib/providers/codex.js';

const TESTERS = {
  gemini:     testGemini,
  groq:       testGroq,
  openrouter: testOpenRouter,
  anthropic:  testAnthropic,
  openai:     testOpenAI,
  freellmapi: async (apiKey) => {
    const result = await freellmapiProvider.testConnection({ ...getRouterSettings().freellmapi, apiKey });
    if (!result.ok) {
      const error = new Error(result.error || 'FreeLLMAPI connection failed');
      error.category = result.status === 'auth_required' ? ErrorCategory.AUTH_FAILED
        : result.status === 'rate_limited' ? ErrorCategory.RATE_LIMITED
        : result.status === 'timeout' ? ErrorCategory.TIMEOUT
        : ErrorCategory.PROVIDER_UNAVAILABLE;
      throw error;
    }
    return result;
  },
  pair:       testPAIR,
  'claude-oauth': testClaudeOAuth,
  codex:      testCodex,
};

// Default model shown in the Settings UI per provider — matches each
// provider module's own DEFAULT_MODEL/FREE_MODEL constant.
const DEFAULT_MODELS = {
  gemini:     'gemini-3.1-flash-lite',
  groq:       'openai/gpt-oss-120b',
  openrouter: 'nvidia/nemotron-3-super-120b-a12b:free',
  anthropic:  'claude-haiku-4-5-20251001',
  openai:     'gpt-4o-mini',
  freellmapi: 'auto',
  pair:       'llama3.2:3b', // Modèle par défaut pour PAIR (dépend de l'endpoint)
  'claude-oauth': 'claude-haiku-4-5-20251001',
  // Derived from codexProvider.defaultModels[0] below (not hardcoded here)
  // — 'gpt-4o' was a previous hardcoded guess that drifted out of sync with
  // the provider and is actively rejected by ChatGPT-subscription auth ("not
  // supported when using Codex with a ChatGPT account"; see the verified
  // comment on codexProvider's defaultModels in lib/providers/codex.js).
  codex:      codexProvider.defaultModels[0],
};

const PROVIDER_LABELS = {
  gemini:     'Google Gemini',
  groq:       'Groq',
  openrouter: 'OpenRouter',
  anthropic:  'Anthropic (Claude API)',
  openai:     'OpenAI API',
  freellmapi: 'FreeLLMAPI',
  pair:       'NVIDIA PAIR',
  'claude-oauth': 'Claude Code (OAuth)',
  codex:      'Codex (OpenAI)',
};

export function createRouterRoute({ services }) {
  const route = new Hono();

  // GET /api/router/status
  route.get('/router/status', async (c) => {
    try {
      const ollama = await services.ollamaHealth();
      const installedNames = ollama.models.map(m => m.name);
      const statuses = getModelStatuses(installedNames);
      const settings = getRouterSettings();
      return c.json({
        statuses,
        settings,
        ollama_connected: ollama.connected,
        cloud_keys: getCloudKeysMasked(),
      });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/router/settings
  route.get('/router/settings', (c) => c.json(getRouterSettings()));

  // POST /api/router/settings
  route.post('/router/settings', async (c) => {
    try {
      const body = await c.req.json();
      setRouterSettings(body);
      return c.json({ ok: true, settings: getRouterSettings() });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/router/cloud-keys — returns masked keys only
  route.get('/router/cloud-keys', (c) => {
    return c.json(getCloudKeysMasked());
  });

  // POST /api/router/cloud-keys — save a key for one provider
  // Body: { provider: 'gemini' | 'groq' | 'openrouter' | 'anthropic' | 'openai', key: string }
  route.post('/router/cloud-keys', async (c) => {
    try {
      const { provider, key } = await c.req.json();
      // Seuls les providers API key peuvent avoir des clés
      const apiKeyProviders = ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'freellmapi'];
      if (!apiKeyProviders.includes(provider)) {
        return c.json({ error: 'provider invalide pour API key' }, 400);
      }
      setCloudKey(provider, key ?? '');
      return c.json({ ok: true, masked: getCloudKeysMasked() });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/router/pair-settings — configure PAIR endpoint
  // Body: { endpoint: string }
  route.post('/router/pair-settings', async (c) => {
    try {
      const { endpoint } = await c.req.json();
      const { pairProvider } = await import('../lib/providers/pair.js');
      pairProvider.setEndpoint(endpoint);
      setMeta('pair_endpoint', endpoint || 'http://localhost:8080');
      return c.json({ ok: true, endpoint: pairProvider.endpoint });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/router/pair-settings
  route.get('/router/pair-settings', async (c) => {
    try {
      const storedEndpoint = getMeta('pair_endpoint', 'http://localhost:8080');
      const { pairProvider } = await import('../lib/providers/pair.js');
      return c.json({ endpoint: pairProvider.endpoint || storedEndpoint });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // POST /api/router/test/pair — test PAIR connection specifically
  route.post('/router/test/pair', async (c) => {
    try {
      const { pairProvider } = await import('../lib/providers/pair.js');
      const result = await pairProvider.testConnection();
      if (result.ok) {
        recordSuccess('pair');
        return c.json({ ok: true, model: result.model });
      } else {
        const entry = recordFailure('pair', new Error(result.error || 'PAIR connection failed'));
        return c.json({ ok: false, error: result.error, state: entry.state });
      }
    } catch (error) {
      const entry = recordFailure('pair', error);
      return c.json({ ok: false, error: error.message, state: entry.state });
    }
  });

  // POST /api/router/test/:provider — validates a key with a real mini-call.
  // A manual test always clears any existing cooldown first ("Retester
  // maintenant" must bypass cooldown immediately, per fallback policy) and
  // records the real outcome into provider-state so the router's next
  // automatic selection reflects it too.
  const OAUTH_TEST_PROVIDERS = new Set(['claude-oauth', 'codex']);

  route.post('/router/test/:provider', async (c) => {
    const provider = c.req.param('provider');
    const tester = TESTERS[provider];
    if (!tester) return c.json({ error: 'provider inconnu' }, 400);

    clearProviderCooldown(provider);

    // OAuth/CLI-session providers (claude-oauth, codex) have no API key —
    // their tester() does a real CLI invocation directly. Never fall through
    // to the "Aucune clé configurée" branch below for these.
    if (OAUTH_TEST_PROVIDERS.has(provider)) {
      try {
        const result = await tester();
        recordSuccess(provider);
        return c.json({ ok: true, model: result.model, authMode: result.authMode, state: 'ready' });
      } catch (error) {
        const entry = recordFailure(provider, error);
        return c.json({ ok: false, error: error.message, authMode: error.authMode ?? 'none', state: entry.state, category: error.category ?? ErrorCategory.UNKNOWN });
      }
    }

    let apiKey;
    try {
      const { key } = await c.req.json().catch(() => ({}));
      apiKey = key || getCloudKeys()[`${provider}_key`];
      if (!apiKey) {
        // A blob may exist but be undecryptable (corrupted / wrong Windows
        // user-machine) — report that distinctly from "never configured" so
        // the Tester button and Settings UI point the user at the right fix.
        if (!key && getCloudKeyStatuses()[provider] === 'invalid') {
          return c.json({ ok: false, error: 'Identifiant invalide ou illisible — veuillez ressaisir la clé.', state: 'credential_invalid' }, 400);
        }
        return c.json({ ok: false, error: 'Aucune clé configurée', state: 'auth_required' }, 400);
      }

      const groqModel = provider === 'groq' ? getRouterSettings().groq_model : undefined;
      const result = await tester(apiKey, groqModel);
      recordSuccess(provider);
      return c.json({ ok: true, model: result.model, state: 'ready' });
    } catch (error) {
      const entry = recordFailure(provider, error);
      // Never expose the key in the error message — providers sometimes echo
      // the submitted (invalid) key back verbatim in their own error text
      // (e.g. OpenAI's "Incorrect API key provided: <key>"), so strip both
      // the key=... pattern AND the literal apiKey value we just sent, not
      // just what the upstream provider happened to mask itself.
      let safe = String(error.message ?? 'Erreur inconnue').replace(/key=[A-Za-z0-9_-]+/gi, 'key=***');
      if (apiKey) {
        safe = safe.split(apiKey).join('***');
        // Some providers echo the key back partially masked themselves (e.g.
        // OpenAI's "Incorrect API key provided: sk-Xy****...***-abcd"), so an
        // exact full-value match above can miss it. Fall back to stripping
        // the key's own prefix/suffix (6+ chars — long enough to be
        // identifying, short enough to survive partial upstream masking).
        // Providers commonly mask to "first ~8 chars ... last ~4 chars" —
        // strip any substring of the key 4+ chars long so partial echoes
        // (in either position, any masking style) can't survive.
        const MIN_FRAGMENT = 4;
        for (let len = Math.min(apiKey.length, 12); len >= MIN_FRAGMENT; len--) {
          for (let start = 0; start + len <= apiKey.length; start++) {
            const fragment = apiKey.slice(start, start + len);
            if (safe.includes(fragment)) safe = safe.split(fragment).join('***');
          }
        }
      }
      return c.json({ ok: false, error: safe, state: entry.state, category: error.category ?? ErrorCategory.UNKNOWN });
    }
  });

  route.get('/router/freellmapi/models', async (c) => {
    const settings = getRouterSettings().freellmapi ?? {};
    const key = getCloudKeys().freellmapi_key;
    if (!settings.baseUrl || !key) return c.json({ configured: false, models: [] });
    try { return c.json({ configured: true, models: await freellmapiProvider.listModels({ ...settings, apiKey: key }, { force: c.req.query('force') === '1' }) }); }
    catch (error) { return c.json({ configured: true, models: [], error: error.message }, 502); }
  });

  route.get('/router/freellmapi/health', async (c) => {
    const settings = getRouterSettings().freellmapi ?? {};
    const key = getCloudKeys().freellmapi_key;
    return c.json(await freellmapiProvider.getHealth({ ...settings, apiKey: key }));
  });

  route.post('/router/freellmapi/test', async (c) => {
    const settings = getRouterSettings().freellmapi ?? {};
    const body = await c.req.json().catch(() => ({}));
    const key = body.key || getCloudKeys().freellmapi_key;
    const result = await freellmapiProvider.testConnection({ ...settings, ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}), apiKey: key });
    return c.json({ ...result, configured: !!key && !!(body.baseUrl || settings.baseUrl) });
  });

  // GET /api/router/providers — full provider overview for Settings > IA/Providers.
  // Frontend-safe: never includes the actual API key, only configured/status/model.
  route.get('/router/providers', async (c) => {
    const keyStatuses    = getCloudKeyStatuses(); // 'absent' | 'valid' | 'invalid' — never a secret value
    const settings       = getRouterSettings();
    const masked         = getCloudKeysMasked();
    const statuses       = getCloudProviderStatuses();

    let ollama = { connected: false, models: [] };
    try { ollama = await services.ollamaHealth(); } catch { /* offline */ }

    // Séparer les providers en API-key et OAuth
    const apiKeyProviders = ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'freellmapi'];
    const oauthProviders = ['claude-oauth', 'codex'];
    const localProvidersList = ['ollama', 'pair'];

    // Traiter les providers API key
    const apiKeyProviderResults = apiKeyProviders.map(id => {
      const keyStatus = keyStatuses[id];
      const credentialInvalid = keyStatus === 'invalid';
      const configured = keyStatus === 'valid';
      const status = statuses[id];
      const isPaid = id === 'anthropic' || id === 'openai';
      const freeConfig = id === 'freellmapi' ? (settings.freellmapi ?? {}) : null;

      let effectiveStatus;
      if (credentialInvalid) effectiveStatus = 'credential_invalid';
      else if (configured) effectiveStatus = status.state;
      else effectiveStatus = 'auth_required';

      // Anthropic/OpenAI each have a sibling subscription provider
      // (claude-oauth/codex) — mutually exclusive by mode. Only relevant to
      // report here for those two; other API-key providers have no sibling.
      const mode = id === 'anthropic' ? (settings?.claude_mode ?? 'subscription')
                 : id === 'openai'    ? (settings?.openai_mode ?? 'subscription')
                 : undefined;
      const modeGatesThis = mode !== undefined ? mode === 'api' : true;

      return {
        id,
        label: PROVIDER_LABELS[id],
        kind: 'cloud',
        authType: 'api-key',
        ...(mode !== undefined ? { mode } : {}),
        paid: isPaid,
        enabled: configured && !credentialInvalid && modeGatesThis && (!isPaid || settings?.paying_apis_enabled === true) && (id !== 'freellmapi' || (freeConfig.enabled === true && !!freeConfig.baseUrl)),
        configured,
        credential_invalid: credentialInvalid,
        status: effectiveStatus,
        in_cooldown: configured ? status.in_cooldown : false,
        cooldown_remaining_ms: configured ? status.cooldown_remaining_ms : 0,
        default_model: id === 'groq' ? (settings?.groq_model || DEFAULT_MODELS.groq) : id === 'freellmapi' ? (freeConfig.textModel || DEFAULT_MODELS[id]) : DEFAULT_MODELS[id],
        masked_key: masked[`${id}_key`],
        ...(id === 'freellmapi' ? { endpoint: freeConfig.baseUrl || null } : {}),
      };
    });

    // Traiter les providers OAuth (Claude Code / Codex — mode abonnement,
    // aucun coût API pour Docteur, donc jamais gaté par paying_apis_enabled).
    const OAUTH_PROVIDER_INSTANCES = { 'claude-oauth': claudeOAuthProvider, codex: codexProvider };
    const oauthProviderResults = [];
    for (const id of oauthProviders) {
      const tester = TESTERS[id];
      const instance = OAUTH_PROVIDER_INSTANCES[id];
      let configured = false;
      let credentialInvalid = false;
      let effectiveStatus = 'not_configured';
      let status = { state: 'auth_required', in_cooldown: false, cooldown_remaining_ms: 0 };
      let authMode = 'none';
      const cliInstalled = await instance.isCliInstalled().catch(() => false);

      // Tester si le provider est configuré (CLI installé + authentifié)
      try {
        // Appeler testKey pour vérifier l'authentification
        const result = await tester({});
        configured = true;
        effectiveStatus = 'ready';
        status = { state: 'ready', in_cooldown: false, cooldown_remaining_ms: 0 };
        authMode = result?.authMode ?? 'cli_session';
      } catch (error) {
        authMode = error?.authMode ?? 'none';
        // Le provider n'est pas configuré
        if (error.message?.includes('non authentifié') || error.message?.includes('authentication') || error.message?.includes('CLI non trouvé')) {
          effectiveStatus = 'auth_required';
        } else {
          effectiveStatus = 'unavailable';
        }
      }

      const modeSetting = id === 'claude-oauth' ? (settings?.claude_mode ?? 'subscription') : (settings?.openai_mode ?? 'subscription');

      oauthProviderResults.push({
        id,
        label: PROVIDER_LABELS[id],
        kind: 'cloud',
        authType: 'oauth-token',
        // mode: which backend this provider's counterpart pair currently uses
        // — 'subscription' (this CLI provider) or 'api' (the sibling API-key
        // provider). Purely informational here; the router enforces
        // exclusivity independently in cloudCandidates().
        mode: modeSetting,
        // authMode: which of the two auth mechanisms is actually in effect —
        // 'setup_token' (CLAUDE_CODE_OAUTH_TOKEN), 'cli_session' (`claude auth
        // login` / `codex login`), or 'none'. Never includes the token value.
        authMode,
        cli_installed: cliInstalled,
        paid: false, // subscription — no per-call API cost to Docteur
        // Subscription mode never depends on paying_apis_enabled — that
        // toggle exists to gate *billed API* usage only.
        enabled: configured && modeSetting === 'subscription',
        configured,
        credential_invalid: credentialInvalid,
        status: effectiveStatus,
        in_cooldown: status.in_cooldown,
        cooldown_remaining_ms: status.cooldown_remaining_ms,
        default_model: DEFAULT_MODELS[id],
        masked_key: null, // Pas de clé API masquée pour OAuth
      });
    }

    // Traiter les providers locaux
    const localProviderResults = [];
    
    // Ollama
    localProviderResults.push({
      id: 'ollama',
      label: 'Ollama (local)',
      kind: 'local',
      authType: 'none',
      paid: false,
      enabled: true,
      configured: true,
      status: ollama.connected ? 'ready' : 'offline',
      in_cooldown: false,
      cooldown_remaining_ms: 0,
      default_model: settings?.chat_model ?? null,
      available_models: ollama.models?.map(m => m.name) ?? [],
    });
    
    // PAIR
    try {
      // Importer pairProvider pour tester la connexion
      const { pairProvider } = await import('../lib/providers/pair.js');
      const isConfigured = await pairProvider.isConfigured();
      const health = await pairProvider.getHealth();
      
      localProviderResults.push({
        id: 'pair',
        label: 'NVIDIA PAIR',
        kind: 'local',
        authType: 'none',
        paid: false,
        enabled: isConfigured,
        configured: isConfigured,
        status: health.status === 'connected' ? 'ready' : health.status,
        in_cooldown: false,
        cooldown_remaining_ms: 0,
        default_model: DEFAULT_MODELS.pair,
        available_models: [],
        endpoint: pairProvider.endpoint,
      });
    } catch {
      localProviderResults.push({
        id: 'pair',
        label: 'NVIDIA PAIR',
        kind: 'local',
        authType: 'none',
        paid: false,
        enabled: false,
        configured: false,
        status: 'unavailable',
        in_cooldown: false,
        cooldown_remaining_ms: 0,
        default_model: DEFAULT_MODELS.pair,
        available_models: [],
        endpoint: 'http://localhost:8080',
      });
    }

    const cloudProviders = [...apiKeyProviderResults, ...oauthProviderResults];
    const localProviders = localProviderResults;

    return c.json({
      providers: [...localProviders, ...cloudProviders],
      paying_apis_enabled: settings?.paying_apis_enabled === true,
      strict_local_mode: settings?.strict_local_mode === true,
    });
  });

  // GET /api/router/gemini-rpm
  route.get('/router/gemini-rpm', (c) => {
    const settings = getRouterSettings();
    return c.json({ rpm: settings.gemini_rpm ?? 10 });
  });

  // POST /api/router/gemini-rpm — body: { rpm: number }
  route.post('/router/gemini-rpm', async (c) => {
    try {
      const { rpm } = await c.req.json();
      const n = Math.max(1, Math.min(60, Number(rpm)));
      if (Number.isNaN(n)) return c.json({ error: 'rpm invalide' }, 400);
      setRouterSettings({ gemini_rpm: n });
      return c.json({ ok: true, rpm: n });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/router/stats
  route.get('/router/stats', (c) => {
    try {
      const stats      = getRouterStats();
      const cloudMonth = getCloudStatsThisMonth();
      return c.json({ stats, cloud_month: cloudMonth });
    } catch (error) {
      return c.json({ error: error.message }, 500);
    }
  });

  // ── Site shortcuts ──────────────────────────────────────────────────────────

  route.get('/shortcuts', (c) => {
    return c.json(getSiteShortcuts());
  });

  route.post('/shortcuts', async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = String(body?.name ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const url  = String(body?.url  ?? '').trim();

    if (!name || /\s/.test(name)) return c.json({ error: 'Nom invalide (pas d\'espace, non vide)' }, 400);

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: 'URL invalide' }, 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ error: 'URL invalide — uniquement http/https' }, 400);
    }

    setSiteShortcut(name, url);
    return c.json({ ok: true, shortcuts: getSiteShortcuts() });
  });

  route.delete('/shortcuts/:name', (c) => {
    const name = decodeURIComponent(c.req.param('name')).toLowerCase();
    deleteSiteShortcut(name);
    return c.json({ ok: true, shortcuts: getSiteShortcuts() });
  });

  // ── Persona settings ────────────────────────────────────────────────────────

  route.get('/persona/settings', (c) => {
    return c.json(getPersonaSettings());
  });

  route.post('/persona/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const updates = {};
    if (typeof body.vouvoiement === 'boolean') updates.vouvoiement = body.vouvoiement;
    const updated = updatePersonaSettings(updates);
    return c.json(updated);
  });

  return route;
}
