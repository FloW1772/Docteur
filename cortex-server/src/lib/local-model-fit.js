/**
 * Deterministic model-fit engine. Given a ModelCatalogEntry, a
 * ModelDistribution and a LocalHardwareProfile, estimates whether the
 * model can reasonably run on this machine.
 *
 * 100% deterministic (mission §27): no LLM, no ML, no network/web lookup,
 * no remote benchmark. Same input always produces the same output. This
 * module performs NO I/O of its own — hardware detection and catalog
 * lookup happen elsewhere and are passed in.
 */

import { getTotalVramBytes } from './local-hardware-profile.js';

export const FIT_RATINGS = Object.freeze(['EXCELLENT', 'GOOD', 'TIGHT', 'NOT_RECOMMENDED', 'UNKNOWN']);

// Disk margin above the artifact size before flagging NOT_RECOMMENDED —
// documented per mission §28. Covers Ollama's temp/blob overhead during
// a pull plus general headroom.
export const DISK_MARGIN_BYTES = 2 * 1_073_741_824; // 2 GiB

// RAM headroom the OS/other apps need beyond the model's own estimated
// requirement before a fit is called EXCELLENT rather than GOOD/TIGHT.
const RAM_COMFORTABLE_MARGIN_RATIO = 1.5; // available RAM >= 1.5x requirement -> comfortable
const RAM_TIGHT_MARGIN_RATIO = 1.05; // available RAM >= 1.05x requirement -> at least fits

const GIB = 1_073_741_824;

/**
 * @typedef {Object} FitResult
 * @property {'EXCELLENT'|'GOOD'|'TIGHT'|'NOT_RECOMMENDED'|'UNKNOWN'} rating
 * @property {string[]} reasons
 * @property {string[]} warnings
 * @property {{ramBytes: number|null, vramBytes: number|null, diskBytes: number|null}} estimates
 * @property {string} confidence - the weakest confidenceType feeding the rating
 */

function gib(bytes) {
  if (bytes == null) return 'unknown';
  return `${(bytes / GIB).toFixed(1)}GB`;
}

/**
 * @param {import('./local-ai-catalog.js').ModelCatalogEntry} model
 * @param {import('./local-ai-catalog.js').ModelDistribution} distribution
 * @param {import('./local-hardware-profile.js').LocalHardwareProfile} hardwareProfile
 * @returns {FitResult}
 */
export function evaluateModelFit(model, distribution, hardwareProfile) {
  const reasons = [];
  const warnings = [];

  // --- Cloud distributions are never "locally fit" (mission §38) ---
  if (distribution.executionLocation === 'CLOUD') {
    return {
      rating: 'NOT_RECOMMENDED',
      reasons: [],
      warnings: ['This distribution runs in the cloud, not locally — excluded from local hardware fit by design.'],
      estimates: { ramBytes: null, vramBytes: null, diskBytes: null },
      confidence: 'UNKNOWN',
    };
  }

  // --- Community/unverified distributions get an explicit caution, but ---
  // --- this does not by itself downgrade the rating (mission §34: fit ---
  // --- rates hardware compatibility, not trustworthiness/quality). ---
  if (distribution.verified === false) {
    warnings.push('This exact distribution/tag has not been individually verified — do not treat as confirmed installable.');
  }
  if (model.provenance === 'community_modified') {
    warnings.push('Community-modified model (e.g. abliterated/uncensored). Not vetted, license provenance may be broken.');
  }

  const req = distribution.estimatedRequirements;
  const totalRam = hardwareProfile.totalRamBytes ?? null;
  const availableRam = hardwareProfile.freeRamBytes ?? totalRam;
  const totalVram = getTotalVramBytes(hardwareProfile);
  const freeDisk = hardwareProfile.freeDiskBytes ?? null;
  const artifactSize = distribution.artifactSizeBytes ?? null;

  const estimates = {
    ramBytes: req?.ramBytes ?? null,
    vramBytes: req?.vramBytes ?? null,
    diskBytes: req?.diskBytes ?? artifactSize,
  };

  // --- Disk check first: a hard blocker regardless of RAM/VRAM (mission §28) ---
  if (artifactSize != null && freeDisk != null) {
    if (freeDisk < artifactSize + DISK_MARGIN_BYTES) {
      reasons.push(`Insufficient disk space: ${gib(freeDisk)} free, need ~${gib(artifactSize)} plus ${gib(DISK_MARGIN_BYTES)} margin.`);
      return {
        rating: 'NOT_RECOMMENDED',
        reasons,
        warnings,
        estimates,
        confidence: 'DERIVED_ESTIMATE',
      };
    }
    reasons.push(`${gib(freeDisk)} free disk available for a ~${gib(artifactSize)} download.`);
  } else if (artifactSize == null) {
    warnings.push('Artifact size unknown — disk fit cannot be checked.');
  } else {
    warnings.push('Free disk space unknown — disk fit cannot be checked.');
  }

  // --- Long-context warning (mission §32/§49) — never claim full-context fit ---
  const nativeCtx = model.contextLength?.native ?? null;
  const extendedCtx = model.contextLength?.extended ?? null;
  const maxCtx = extendedCtx ?? nativeCtx;
  if (maxCtx != null && maxCtx >= 128_000) {
    warnings.push('LONG_CONTEXT_MEMORY_NOT_INCLUDED: KV-cache cost at long context is not estimated and can exceed the base memory requirement.');
  }

  // --- No requirement data at all: conservative UNKNOWN (mission §29) ---
  if (!req || (req.ramBytes == null && req.vramBytes == null)) {
    warnings.push('No memory requirement estimate available for this distribution.');
    if (totalRam == null) {
      warnings.push('Local RAM could not be detected either.');
    }
    return {
      rating: 'UNKNOWN',
      reasons,
      warnings,
      estimates,
      confidence: 'UNKNOWN',
    };
  }

  const confidence = req.confidenceType ?? 'UNKNOWN';

  // --- MoE note: active params affect compute/speed, never memory (mission §31) ---
  if (model.architecture?.type === 'moe' && model.architecture.activeParameters != null && model.architecture.totalParameters != null) {
    reasons.push(
      `MoE model: ${(model.architecture.totalParameters / 1e9).toFixed(1)}B total / ${(model.architecture.activeParameters / 1e9).toFixed(1)}B active parameters. ` +
      `Active parameters affect compute speed only — full memory footprint still applies.`
    );
  }

  // --- VRAM path: prefer full-GPU-fit reasoning if VRAM is known ---
  let ramPath = 'CPU_RAM_FIT';
  if (req.vramBytes != null && totalVram != null) {
    if (totalVram >= req.vramBytes) {
      ramPath = 'FULL_GPU_FIT';
      reasons.push(`${gib(totalVram)} VRAM detected, fits the estimated ${gib(req.vramBytes)} requirement.`);
    } else if (totalVram > 0) {
      ramPath = 'PARTIAL_GPU_OFFLOAD';
      reasons.push(`${gib(totalVram)} VRAM detected, below the estimated ${gib(req.vramBytes)} requirement — partial GPU offload likely, with CPU/RAM covering the rest.`);
    }
  } else if (req.vramBytes != null && totalVram == null) {
    warnings.push('GPU/VRAM not detected — assuming CPU/RAM-only execution, which will be slower.');
  }

  // --- RAM sufficiency, using whichever requirement figure applies ---
  const effectiveRequirement = req.ramBytes ?? req.vramBytes;
  if (effectiveRequirement == null || availableRam == null) {
    warnings.push('Could not compare requirement against available RAM.');
    return {
      rating: 'UNKNOWN',
      reasons,
      warnings,
      estimates,
      confidence,
    };
  }

  if (availableRam < effectiveRequirement) {
    reasons.push(`Available RAM (${gib(availableRam)}) is below the estimated requirement (${gib(effectiveRequirement)}).`);
    return {
      rating: 'NOT_RECOMMENDED',
      reasons,
      warnings,
      estimates,
      confidence,
    };
  }

  const ratio = availableRam / effectiveRequirement;
  let rating;
  if (ratio >= RAM_COMFORTABLE_MARGIN_RATIO && (ramPath === 'FULL_GPU_FIT' || ramPath === 'CPU_RAM_FIT')) {
    rating = 'EXCELLENT';
    reasons.push(`Comfortable headroom: ${gib(availableRam)} available vs ${gib(effectiveRequirement)} estimated requirement.`);
  } else if (ratio >= RAM_TIGHT_MARGIN_RATIO) {
    rating = ramPath === 'PARTIAL_GPU_OFFLOAD' ? 'GOOD' : 'GOOD';
    reasons.push(`Adequate headroom: ${gib(availableRam)} available vs ${gib(effectiveRequirement)} estimated requirement.`);
  } else {
    rating = 'TIGHT';
    reasons.push(`Marginal headroom: ${gib(availableRam)} available vs ${gib(effectiveRequirement)} estimated requirement — close to the limit.`);
    warnings.push('MEMORY_TIGHT: this model may run slowly or risk out-of-memory conditions under load.');
  }

  if (confidence === 'UNKNOWN' || confidence === 'COMMUNITY_ESTIMATE') {
    warnings.push(`Memory requirement confidence is ${confidence} — treat the rating above as indicative, not exact.`);
  }

  return { rating, reasons, warnings, estimates, confidence };
}

/**
 * Pure helper: filters/sorts catalog (model, distribution) pairs for a
 * given hardware profile and optional criteria. Does not build any UI.
 *
 * @param {import('./local-ai-catalog.js').ModelCatalogEntry[]} models
 * @param {import('./local-ai-catalog.js').ModelDistribution[]} distributions
 * @param {import('./local-hardware-profile.js').LocalHardwareProfile} hardwareProfile
 * @param {{ capability?: string, localOnly?: boolean, minRating?: string }} [criteria]
 */
export function filterCatalogForHardware(models, distributions, hardwareProfile, criteria = {}) {
  const { capability, localOnly = true, minRating } = criteria;
  const ratingOrder = ['NOT_RECOMMENDED', 'UNKNOWN', 'TIGHT', 'GOOD', 'EXCELLENT'];
  const minRatingIndex = minRating ? ratingOrder.indexOf(minRating) : 0;

  const results = [];
  for (const model of models) {
    if (capability && !model.useCaseTags.includes(capability)) continue;

    const modelDistributions = distributions.filter(d => d.canonicalId === model.canonicalId);
    for (const distribution of modelDistributions) {
      if (localOnly && distribution.executionLocation !== 'LOCAL') continue;

      const fit = evaluateModelFit(model, distribution, hardwareProfile);
      if (ratingOrder.indexOf(fit.rating) < minRatingIndex) continue;

      results.push({ model, distribution, fit });
    }
  }

  // Deterministic ordering per mission §37: execution location (already
  // filtered), hardware fit, trust level, freshness. Never sorts by size.
  const trustOrder = ['OFFICIAL', 'VERIFIED_COMMUNITY', 'COMMUNITY', 'UNVERIFIED'];
  results.sort((a, b) => {
    const fitDiff = ratingOrder.indexOf(b.fit.rating) - ratingOrder.indexOf(a.fit.rating);
    if (fitDiff !== 0) return fitDiff;
    const trustDiff = trustOrder.indexOf(a.model.trustLevel) - trustOrder.indexOf(b.model.trustLevel);
    if (trustDiff !== 0) return trustDiff;
    return new Date(b.model.lastVerifiedAt).getTime() - new Date(a.model.lastVerifiedAt).getTime();
  });

  return results;
}
