import { Hono } from 'hono';
import {
  MODEL_CATALOG,
  MODEL_DISTRIBUTIONS,
  getCatalogMeta,
  getDistributionById,
  getVerifiedLocalDistributions,
} from '../lib/local-ai-catalog.js';
import { detectLocalHardwareProfile } from '../lib/local-hardware-profile.js';
import { evaluateModelFit, filterCatalogForHardware } from '../lib/local-model-fit.js';

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function buildBaseUrl(baseUrl) {
  return String(baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
}

async function getInstalledModelNames(ollamaUrl) {
  try {
    const response = await fetch(`${buildBaseUrl(ollamaUrl)}/api/tags`, { method: 'GET' });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models.map((m) => String(m?.name ?? m?.model ?? '').trim()).filter(Boolean);
  } catch {
    // Ollama unreachable — treat as "no installed models known", never throw.
    // This keeps the /api/local-ai/* surface resilient even if Ollama is down.
    return [];
  }
}

function normalizeComparableName(name) {
  return String(name ?? '').trim().split('@')[0];
}

function isInstalled(pullName, installedNames) {
  if (!pullName) return false;
  const target = normalizeComparableName(pullName);
  return installedNames.some((n) => normalizeComparableName(n) === target);
}

/**
 * Local AI catalog/hardware/recommendation API. Every response here is
 * built from AI-3's static local catalog + a local hardware read + the
 * existing Ollama localhost proxy — never an outbound Internet call, never
 * an LLM call (mission AI-4 §4/§42).
 */
export function createLocalAiRoute({ services }) {
  const route = new Hono();
  // Injectable for tests (mission §41: no CI test may depend on real
  // hardware). Production wiring never passes this override, so
  // detectLocalHardwareProfile (real CPU/RAM/GPU/disk read) is always used.
  const detectHardware = services.detectLocalHardwareProfile ?? detectLocalHardwareProfile;

  // GET /api/local-ai/catalog — static local catalog + validation/meta.
  // No network access of any kind.
  route.get('/local-ai/catalog', (c) => {
    return c.json({
      models: MODEL_CATALOG,
      distributions: MODEL_DISTRIBUTIONS,
      meta: getCatalogMeta(),
    });
  });

  // GET /api/local-ai/hardware — local hardware read only (CPU/RAM/GPU/disk).
  // Never sent anywhere; see local-hardware-profile.js.
  route.get('/local-ai/hardware', async (c) => {
    const forceRefresh = c.req.query('refresh') === '1';
    const profile = await detectHardware({ forceRefresh });
    return c.json({ profile });
  });

  // GET /api/local-ai/recommendations — batches hardware detection + fit
  // evaluation once, so the UI never triggers N per-card backend calls.
  route.get('/local-ai/recommendations', async (c) => {
    const capability = c.req.query('capability') || undefined;
    const localOnly = c.req.query('localOnly') !== '0';

    const [profile, installedNames] = await Promise.all([
      detectHardware({}),
      getInstalledModelNames(services.ollamaUrl),
    ]);

    const results = filterCatalogForHardware(MODEL_CATALOG, MODEL_DISTRIBUTIONS, profile, {
      capability,
      localOnly,
    }).map(({ model, distribution, fit }) => ({
      model,
      distribution,
      fit,
      installed: isInstalled(distribution.ollamaPullName, installedNames),
    }));

    return c.json({
      results,
      hardwareProfile: profile,
      catalogMeta: getCatalogMeta(),
    });
  });

  // GET /api/local-ai/installed — which catalog distributions are actually
  // present in Ollama right now. "Installed" is always derived from what
  // Ollama itself reports, never inferred from the catalog (mission §5).
  route.get('/local-ai/installed', async (c) => {
    const installedNames = await getInstalledModelNames(services.ollamaUrl);
    const matches = getVerifiedLocalDistributions()
      .filter((d) => isInstalled(d.ollamaPullName, installedNames))
      .map((d) => ({ distributionId: d.id, canonicalId: d.canonicalId, ollamaPullName: d.ollamaPullName }));
    return c.json({ installedOllamaModels: installedNames, matchedCatalogDistributions: matches });
  });

  // POST /api/local-ai/install-preview — the ONLY place a distributionId is
  // resolved to a pull name. Backend is the trust boundary (mission §38/39):
  // a client can send a distributionId, never an arbitrary pull name, and
  // this endpoint re-derives and re-validates everything server-side before
  // telling the UI it's safe to show an install button.
  route.post('/local-ai/install-preview', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const distributionId = String(body?.distributionId ?? '').trim();

    const distribution = getDistributionById(distributionId);
    if (!distribution) {
      return c.json({ ok: false, error: 'Unknown distribution id.' }, 404);
    }
    const model = MODEL_CATALOG.find((m) => m.canonicalId === distribution.canonicalId);
    if (!model) {
      return c.json({ ok: false, error: 'Distribution has no matching catalog model.' }, 500);
    }

    // Every gate mission §16 requires, re-checked server-side:
    if (distribution.executionLocation !== 'LOCAL') {
      return c.json({ ok: false, error: 'This distribution runs in the cloud and cannot be installed locally.' }, 400);
    }
    if (distribution.verified !== true) {
      return c.json({ ok: false, error: 'This distribution has not been individually verified and cannot be installed yet.' }, 400);
    }
    if (distribution.runtime !== 'OLLAMA' || !distribution.ollamaPullName) {
      return c.json({ ok: false, error: 'This distribution has no installable Ollama runtime.' }, 400);
    }
    if (!MODEL_NAME_PATTERN.test(distribution.ollamaPullName)) {
      return c.json({ ok: false, error: 'Distribution pull name failed validation.' }, 400);
    }
    if (distribution.requiresRemoteCode === true) {
      return c.json({ ok: false, error: 'This distribution requires remote code execution and is not installable from this UI.' }, 400);
    }

    const [profile, installedNames] = await Promise.all([
      detectHardware({}),
      getInstalledModelNames(services.ollamaUrl),
    ]);
    const fit = evaluateModelFit(model, distribution, profile);

    if (fit.rating === 'NOT_RECOMMENDED') {
      return c.json({
        ok: false,
        error: 'This model is not recommended for this machine\'s hardware.',
        fit,
      }, 400);
    }

    return c.json({
      ok: true,
      model,
      distribution,
      fit,
      hardwareProfile: profile,
      alreadyInstalled: isInstalled(distribution.ollamaPullName, installedNames),
      // The frontend must use exactly this string with the existing
      // POST /api/ollama/pull endpoint — never one it constructed itself.
      verifiedOllamaPullName: distribution.ollamaPullName,
    });
  });

  return route;
}
