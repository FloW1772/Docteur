/**
 * Local AI model catalog — Docteur's internal registry of models and their
 * runnable distributions, per AI-2's schema design and AI-3's mission spec.
 *
 * Two separate structures, never conflated:
 *   - ModelCatalogEntry: the abstract model (license, params, capabilities)
 *   - ModelDistribution: a concrete runnable artifact (Ollama tag, GGUF, ...)
 *
 * Data here comes ONLY from reports/LOCAL_AI_CATALOG_RESEARCH_2026-09.md.
 * Unverified/unknown fields are `null`, never guessed. See that report for
 * per-field confidence tags and source URLs.
 *
 * This module performs NO network access and NO filesystem access beyond
 * its own static data. Catalog refresh is out of scope for AI-3 — see
 * mission §13/§14 (no automatic Internet).
 */

export const TRUST_LEVELS = Object.freeze(['OFFICIAL', 'VERIFIED_COMMUNITY', 'COMMUNITY', 'UNVERIFIED']);

export const EXECUTION_LOCATIONS = Object.freeze(['LOCAL', 'CLOUD']);

export const RUNTIMES = Object.freeze(['OLLAMA', 'LM_STUDIO', 'GGUF', 'LLAMA_CPP', 'TRANSFORMERS']);

export const REQUIREMENT_CONFIDENCE = Object.freeze([
  'OFFICIAL_REQUIREMENT',
  'COMMUNITY_ESTIMATE',
  'DERIVED_ESTIMATE',
  'UNKNOWN',
]);

export const LIFECYCLE_STATUSES = Object.freeze(['current', 'superseded', 'obsolete', 'unknown']);

export const PROVENANCE_TYPES = Object.freeze(['official', 'community_quant', 'community_modified']);

export const CAPABILITY_TAGS = Object.freeze([
  'GENERAL',
  'FAST',
  'LOW_RESOURCE',
  'BALANCED',
  'POWERFUL',
  'REASONING',
  'CODING',
  'MULTIMODAL',
  'VISION',
  'TOOL_CALLING',
  'LONG_CONTEXT',
]);

export const CATALOG_VERSION = '2026-09-ai3-seed-1';
export const CATALOG_GENERATED_AT = '2026-09-21T00:00:00.000Z';
// Beyond this age, isCatalogStale() reports true. Does NOT trigger any
// network call by itself — staleness is only ever a signal (mission §14).
export const CATALOG_STALE_AFTER_DAYS = 90;

const GIB = 1_073_741_824;

/**
 * @typedef {Object} ModelCatalogEntry
 * @property {string} canonicalId - stable, our own namespace, e.g. "qwen/qwen3.8-27b"
 * @property {string} name
 * @property {string} family
 * @property {string} publisher
 * @property {'official'|'community_quant'|'community_modified'} provenance
 * @property {'OFFICIAL'|'VERIFIED_COMMUNITY'|'COMMUNITY'|'UNVERIFIED'} trustLevel
 * @property {string|null} upstreamCanonicalId - set for community variants only
 * @property {string|null} officialSourceUrl
 * @property {string|null} huggingFaceUrl
 * @property {string|null} githubUrl
 * @property {string|null} releaseDate - ISO date, or null if UNKNOWN/disputed
 * @property {string} lastVerifiedAt - ISO date
 * @property {string|null} license - SPDX id or license name; null = UNKNOWN
 * @property {'unrestricted'|'conditional'|'non_commercial'|'unknown'} commercialUse
 * @property {string[]} additionalPolicies
 * @property {{type: 'dense'|'moe'|'unknown', totalParameters: number|null, activeParameters: number|null}} architecture
 * @property {{native: number|null, extended: number|null}|null} contextLength
 * @property {{reasoning: boolean, coding: boolean, toolCalling: boolean, vision: boolean, audio: boolean, video: boolean, multilingual: boolean}} capabilities
 * @property {string[]} modalities
 * @property {string[]} strengths
 * @property {string[]} limitations
 * @property {{status: 'current'|'superseded'|'obsolete'|'unknown', staleAfter: string|null, replacedBy: string|null}} lifecycle
 * @property {string[]} useCaseTags - from CAPABILITY_TAGS
 */

/**
 * @typedef {Object} ModelDistribution
 * @property {string} id
 * @property {string} canonicalId - FK to ModelCatalogEntry.canonicalId
 * @property {'OLLAMA'|'LM_STUDIO'|'GGUF'|'LLAMA_CPP'|'TRANSFORMERS'} runtime
 * @property {string} source - e.g. "ollama-library", "huggingface"
 * @property {string|null} sourceUrl
 * @property {string|null} ollamaPullName
 * @property {string|null} huggingFaceRepo
 * @property {string|null} localArtifactPath
 * @property {number|null} artifactSizeBytes
 * @property {string|null} precision - e.g. "MXFP4", "BF16"
 * @property {string|null} quantization - e.g. "Q4_K_M", null if not exposed
 * @property {'LOCAL'|'CLOUD'} executionLocation
 * @property {boolean} verified - true only if the exact pull/tag was individually confirmed in AI-2
 * @property {string} lastVerifiedAt
 * @property {boolean|'unknown'|'not_applicable'} requiresRemoteCode
 * @property {{ramBytes: number|null, vramBytes: number|null, diskBytes: number|null, confidenceType: string}|null} estimatedRequirements
 */

/** @type {ModelCatalogEntry[]} */
export const MODEL_CATALOG = Object.freeze([
  // ---- LOW_RESOURCE ----
  Object.freeze({
    canonicalId: 'google/gemma4-e2b',
    name: 'Gemma 4 E2B',
    family: 'gemma',
    publisher: 'Google',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://ai.google.dev/gemma/docs/core/model_card_4',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null, // disputed between two official sources (2026-04-02 vs 2026-07-30) — see AI-2 report §15
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: null, activeParameters: null },
    contextLength: { native: 128_000, extended: null },
    capabilities: {
      reasoning: true, coding: false, toolCalling: true,
      vision: true, audio: true, video: false, multilingual: true,
    },
    modalities: ['text', 'image', 'audio'],
    strengths: ['built for edge/low-resource devices', 'audio support at small size'],
    limitations: ['no official memory figure published'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['LOW_RESOURCE', 'MULTIMODAL', 'GENERAL'],
  }),
  Object.freeze({
    canonicalId: 'ibm/granite4.2-8b',
    name: 'Granite 4.2 8B',
    family: 'granite',
    publisher: 'IBM',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://ollama.com/library/granite4.2',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: null, activeParameters: null },
    contextLength: { native: 128_000, extended: null },
    capabilities: {
      reasoning: true, coding: true, toolCalling: true,
      vision: false, audio: false, video: false, multilingual: true,
    },
    modalities: ['text'],
    strengths: ['tool calling', 'configurable thinking effort', 'confirmed Apache 2.0'],
    limitations: ['exact parameter count not published (Ollama page gives size only)'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['LOW_RESOURCE', 'TOOL_CALLING', 'GENERAL'],
  }),
  Object.freeze({
    canonicalId: 'qwen/qwen3.5-4b',
    name: 'Qwen3.5 4B',
    family: 'qwen',
    publisher: 'Alibaba',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://ollama.com/library/qwen3.5',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: null, // UNKNOWN — qwen.ai unreachable per AI-2 §15
    commercialUse: 'unknown',
    additionalPolicies: [],
    architecture: { type: 'unknown', totalParameters: null, activeParameters: null },
    contextLength: { native: 256_000, extended: null },
    capabilities: {
      reasoning: false, coding: false, toolCalling: false,
      vision: true, audio: false, video: false, multilingual: true,
    },
    modalities: ['text', 'image'],
    strengths: ['very small artifact (3.4GB)', 'long context at small size'],
    limitations: ['license UNKNOWN — do not present as Apache/MIT'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['LOW_RESOURCE', 'FAST', 'VISION'],
  }),

  // ---- BALANCED ----
  Object.freeze({
    canonicalId: 'openai/gpt-oss-20b',
    name: 'gpt-oss-20b',
    family: 'gpt-oss',
    publisher: 'OpenAI',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://openai.com/index/introducing-gpt-oss/',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: '2025-08-05',
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'moe', totalParameters: 21_000_000_000, activeParameters: null },
    contextLength: { native: 128_000, extended: null },
    capabilities: {
      reasoning: true, coding: true, toolCalling: true,
      vision: false, audio: false, video: false, multilingual: false,
    },
    modalities: ['text'],
    strengths: ['rare vendor-stated memory requirement (fits in 16GB)', 'configurable reasoning effort', 'native MXFP4 low-precision'],
    limitations: ['active parameter count not confirmed at Tier 1 despite being MoE'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['BALANCED', 'REASONING', 'CODING'],
  }),
  Object.freeze({
    canonicalId: 'qwen/qwen3.8-27b',
    name: 'Qwen3.8-27B',
    family: 'qwen',
    publisher: 'Alibaba',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://huggingface.co/Qwen/Qwen3.8-27B',
    huggingFaceUrl: 'https://huggingface.co/Qwen/Qwen3.8-27B',
    githubUrl: null,
    releaseDate: '2026-08-14',
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: 27_000_000_000, activeParameters: 27_000_000_000 },
    contextLength: { native: 262_144, extended: 1_000_000 },
    capabilities: {
      reasoning: true, coding: true, toolCalling: true,
      vision: true, audio: false, video: true, multilingual: true,
    },
    modalities: ['text', 'image', 'video'],
    strengths: ['flagship local candidate per AI-2', 'huge verified context window', 'agentic long-horizon tasks'],
    limitations: ['no official RAM/VRAM figure — 20-24GB is a derived estimate'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['BALANCED', 'REASONING', 'CODING', 'MULTIMODAL', 'LONG_CONTEXT', 'TOOL_CALLING'],
  }),
  Object.freeze({
    canonicalId: 'google/gemma4-26b-a4b',
    name: 'Gemma 4 26B (MoE)',
    family: 'gemma',
    publisher: 'Google',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://ai.google.dev/gemma/docs/core/model_card_4',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'moe', totalParameters: 25_200_000_000, activeParameters: 3_800_000_000 },
    contextLength: { native: 256_000, extended: null },
    capabilities: {
      reasoning: true, coding: false, toolCalling: true,
      vision: true, audio: false, video: false, multilingual: true,
    },
    modalities: ['text', 'image'],
    strengths: ['MoE efficiency — 8 of 128 experts active', 'confirmed active/total params, rare for MoE'],
    limitations: ['no official memory figure', 'release date disputed between two Google sources'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['BALANCED', 'REASONING', 'MULTIMODAL'],
  }),
  Object.freeze({
    canonicalId: 'meta/muse-glimmer-30b',
    name: 'Muse Glimmer 30B',
    family: 'muse',
    publisher: 'Meta',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://huggingface.co/meta-models/Muse-Glimmer-30B',
    huggingFaceUrl: 'https://huggingface.co/meta-models/Muse-Glimmer-30B',
    githubUrl: null,
    releaseDate: '2026-08-10',
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: 29_600_000_000, activeParameters: 29_600_000_000 },
    contextLength: { native: 131_072, extended: null },
    capabilities: {
      reasoning: true, coding: true, toolCalling: true,
      vision: true, audio: false, video: false, multilingual: true,
    },
    modalities: ['text', 'image'],
    strengths: ['Meta\'s successor to Llama, agentic + tool use + failure recovery', 'vendor-stated VRAM requirement (rare)', 'ships bundled speculative-decoding drafter'],
    limitations: ['full precision needs 64GB VRAM; 4-bit needs 24-32GB VRAM — high floor even quantized'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['BALANCED', 'POWERFUL', 'CODING', 'TOOL_CALLING'],
  }),

  // ---- POWERFUL ----
  Object.freeze({
    canonicalId: 'openai/gpt-oss-120b',
    name: 'gpt-oss-120b',
    family: 'gpt-oss',
    publisher: 'OpenAI',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://openai.com/index/introducing-gpt-oss/',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: '2025-08-05',
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'moe', totalParameters: 117_000_000_000, activeParameters: null },
    contextLength: { native: 128_000, extended: null },
    capabilities: {
      reasoning: true, coding: true, toolCalling: true,
      vision: false, audio: false, video: false, multilingual: false,
    },
    modalities: ['text'],
    strengths: ['vendor-stated requirement: fits a single 80GB GPU'],
    limitations: ['not consumer hardware', 'active parameter count UNKNOWN'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['POWERFUL', 'REASONING', 'CODING'],
  }),
  Object.freeze({
    canonicalId: 'nvidia/nemotron-3.5-lightning-30b',
    name: 'Nemotron 3.5 Lightning 30B',
    family: 'nemotron',
    publisher: 'NVIDIA',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://ollama.com/library/nemotron-3.5-lightning',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: null, // UNKNOWN — likely NVIDIA Open Model License, not Apache/MIT (AI-2 §10)
    commercialUse: 'unknown',
    additionalPolicies: [],
    architecture: { type: 'moe', totalParameters: 30_000_000_000, activeParameters: 3_000_000_000 },
    contextLength: { native: 1_000_000, extended: null },
    capabilities: {
      reasoning: true, coding: false, toolCalling: true,
      vision: false, audio: false, video: false, multilingual: false,
    },
    modalities: ['text'],
    strengths: ['1M context', 'MoE efficiency, only 3B active of 30B total'],
    limitations: ['license UNKNOWN — must verify before commercial use', 'huge context implies large uncounted KV-cache cost'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['POWERFUL', 'REASONING', 'LONG_CONTEXT'],
  }),

  // ---- CODING ----
  Object.freeze({
    canonicalId: 'cohere/north-mini-code-1.0',
    name: 'North-Mini-Code-1.0',
    family: 'cohere',
    publisher: 'Cohere',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://huggingface.co/CohereLabs/North-Mini-Code-1.0',
    huggingFaceUrl: 'https://huggingface.co/CohereLabs/North-Mini-Code-1.0',
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'conditional',
    additionalPolicies: ['Cohere Labs Acceptable Use Policy'],
    architecture: { type: 'moe', totalParameters: 30_000_000_000, activeParameters: 3_000_000_000 },
    contextLength: { native: 256_000, extended: null },
    capabilities: {
      reasoning: true, coding: true, toolCalling: true,
      vision: false, audio: false, video: false, multilingual: false,
    },
    modalities: ['text'],
    strengths: ['agentic coding, terminal tasks', 'MoE efficiency for coding-specific use'],
    limitations: ['Apache 2.0 base license plus a separate AUP — not plain Apache 2.0 in practice'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['CODING', 'TOOL_CALLING'],
  }),
  Object.freeze({
    canonicalId: 'mistral/devstral-small-2',
    name: 'Devstral Small 2',
    family: 'mistral',
    publisher: 'Mistral AI',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://mistral.ai/news/mistral-3/',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: '2025-12-02',
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: 24_000_000_000, activeParameters: 24_000_000_000 },
    contextLength: null,
    capabilities: {
      reasoning: false, coding: true, toolCalling: true,
      vision: false, audio: false, video: false, multilingual: true,
    },
    modalities: ['text'],
    strengths: ['tool use + code exploration focus'],
    limitations: ['"fits a single RTX 4090" is a community estimate, not vendor-stated', 'context length not stated in announcement'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['CODING', 'TOOL_CALLING', 'BALANCED'],
  }),

  // ---- REASONING ----
  Object.freeze({
    canonicalId: 'mistral/magistral',
    name: 'Magistral',
    family: 'mistral',
    publisher: 'Mistral AI',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://mistral.ai/news/mistral-3/',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: 'Apache-2.0',
    commercialUse: 'unrestricted',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: 24_000_000_000, activeParameters: 24_000_000_000 },
    contextLength: null,
    capabilities: {
      reasoning: true, coding: false, toolCalling: false,
      vision: false, audio: false, video: false, multilingual: true,
    },
    modalities: ['text'],
    strengths: ['Mistral\'s dedicated reasoning model'],
    limitations: ['exact release date and context length not confirmed at Tier 1'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['REASONING', 'BALANCED'],
  }),
  Object.freeze({
    canonicalId: 'deepseek/deepseek-r1-distill',
    name: 'DeepSeek R1 (distilled)',
    family: 'deepseek',
    publisher: 'DeepSeek',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://ollama.com/library/deepseek-r1',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: null, // UNKNOWN for the distills specifically at this session
    commercialUse: 'unknown',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: null, activeParameters: null },
    contextLength: null,
    capabilities: {
      reasoning: true, coding: true, toolCalling: false,
      vision: false, audio: false, video: false, multilingual: true,
    },
    modalities: ['text'],
    strengths: ['2nd most-pulled model on Ollama overall (93M pulls)', 'wide size range from 1.5B to 671B'],
    limitations: ['this entry covers the small consumer-runnable distills only; full 671B model is not locally viable', 'license not verified this session'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    useCaseTags: ['REASONING', 'CODING', 'LOW_RESOURCE'],
  }),

  // ---- MULTIMODAL / VISION ----
  Object.freeze({
    canonicalId: 'openbmb/minicpm-v4.5',
    name: 'MiniCPM-V 4.5',
    family: 'minicpm-v',
    publisher: 'OpenBMB',
    provenance: 'official',
    trustLevel: 'OFFICIAL',
    upstreamCanonicalId: null,
    officialSourceUrl: 'https://ollama.com/library/minicpm-v4.5',
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: null, // UNKNOWN this session
    commercialUse: 'unknown',
    architecture: { type: 'dense', totalParameters: 8_000_000_000, activeParameters: 8_000_000_000 },
    contextLength: null,
    capabilities: {
      reasoning: false, coding: false, toolCalling: false,
      vision: true, audio: false, video: true, multilingual: false,
    },
    modalities: ['text', 'image', 'video'],
    strengths: ['multi-image and video understanding at a small 8B size'],
    limitations: ['license UNKNOWN'],
    lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
    additionalPolicies: [],
    useCaseTags: ['MULTIMODAL', 'VISION', 'LOW_RESOURCE'],
  }),

  // ---- COMMUNITY / UNRESTRICTED example (kept clearly separate) ----
  Object.freeze({
    canonicalId: 'community/llama3.1-8b-abliterated',
    name: 'Llama 3.1 8B (abliterated, community)',
    family: 'llama',
    publisher: 'community',
    provenance: 'community_modified',
    trustLevel: 'UNVERIFIED',
    upstreamCanonicalId: 'meta/llama3.1-8b',
    officialSourceUrl: null,
    huggingFaceUrl: null,
    githubUrl: null,
    releaseDate: null,
    lastVerifiedAt: '2026-09-21',
    license: null, // UNKNOWN — never assume it inherits Llama's license, per AI-2 §8
    commercialUse: 'unknown',
    additionalPolicies: [],
    architecture: { type: 'dense', totalParameters: 8_000_000_000, activeParameters: 8_000_000_000 },
    contextLength: null,
    capabilities: {
      reasoning: false, coding: false, toolCalling: false,
      vision: false, audio: false, video: false, multilingual: true,
    },
    modalities: ['text'],
    strengths: ['reportedly the most-pulled abliterated Llama variant on Ollama'],
    limitations: [
      'refusal-removal technique degrades general capability by an undocumented amount',
      'license provenance broken — do not assume inheritance from upstream Llama license',
      'no supply-chain guarantee on the weights',
    ],
    lifecycle: { status: 'unknown', staleAfter: null, replacedBy: null },
    useCaseTags: ['GENERAL'],
  }),
]);

/** @type {ModelDistribution[]} */
export const MODEL_DISTRIBUTIONS = Object.freeze([
  Object.freeze({
    id: 'gemma4-e2b-ollama',
    canonicalId: 'google/gemma4-e2b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/gemma4',
    ollamaPullName: 'gemma4:e2b',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: 7.2 * GIB,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: { ramBytes: null, vramBytes: null, diskBytes: Math.round(7.2 * GIB), confidenceType: 'DERIVED_ESTIMATE' },
  }),
  Object.freeze({
    id: 'granite4.2-8b-ollama',
    canonicalId: 'ibm/granite4.2-8b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/granite4.2',
    ollamaPullName: 'granite4.2:8b',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: 5.3 * GIB,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: { ramBytes: null, vramBytes: null, diskBytes: Math.round(5.3 * GIB), confidenceType: 'DERIVED_ESTIMATE' },
  }),
  Object.freeze({
    id: 'qwen3.5-4b-ollama',
    canonicalId: 'qwen/qwen3.5-4b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/qwen3.5',
    ollamaPullName: 'qwen3.5:4b',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: 3.4 * GIB,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: { ramBytes: null, vramBytes: null, diskBytes: Math.round(3.4 * GIB), confidenceType: 'DERIVED_ESTIMATE' },
  }),
  Object.freeze({
    id: 'gpt-oss-20b-ollama',
    canonicalId: 'openai/gpt-oss-20b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/gpt-oss',
    ollamaPullName: 'gpt-oss:20b',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: 14 * GIB,
    precision: 'MXFP4',
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: false,
    // Vendor-stated: "runs within 16GB" — the rare OFFICIAL_REQUIREMENT case.
    estimatedRequirements: { ramBytes: 16 * GIB, vramBytes: 16 * GIB, diskBytes: Math.round(14 * GIB), confidenceType: 'OFFICIAL_REQUIREMENT' },
  }),
  Object.freeze({
    id: 'gpt-oss-20b-cloud-ollama',
    canonicalId: 'openai/gpt-oss-20b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/gpt-oss',
    ollamaPullName: 'gpt-oss:20b-cloud',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: null,
    precision: 'MXFP4',
    quantization: null,
    // CRITICAL per mission §5/§38: a "-cloud" Ollama tag is NEVER local,
    // even though it lives in the same namespace as the local tag above.
    executionLocation: 'CLOUD',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'not_applicable',
    estimatedRequirements: null,
  }),
  Object.freeze({
    id: 'qwen3.8-27b-ollama',
    canonicalId: 'qwen/qwen3.8-27b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/qwen3.8',
    ollamaPullName: 'qwen3.8:27b',
    huggingFaceRepo: 'Qwen/Qwen3.8-27B',
    localArtifactPath: null,
    artifactSizeBytes: 18 * GIB,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: false,
    estimatedRequirements: { ramBytes: 22 * GIB, vramBytes: 22 * GIB, diskBytes: Math.round(18 * GIB), confidenceType: 'DERIVED_ESTIMATE' },
  }),
  Object.freeze({
    id: 'gemma4-26b-a4b-ollama',
    canonicalId: 'google/gemma4-26b-a4b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/gemma4',
    ollamaPullName: 'gemma4:26b',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: 19 * GIB,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: { ramBytes: null, vramBytes: null, diskBytes: Math.round(19 * GIB), confidenceType: 'DERIVED_ESTIMATE' },
  }),
  Object.freeze({
    id: 'muse-glimmer-30b-ollama',
    canonicalId: 'meta/muse-glimmer-30b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/muse-glimmer',
    ollamaPullName: 'muse-glimmer:30b',
    huggingFaceRepo: 'meta-models/Muse-Glimmer-30B',
    localArtifactPath: null,
    artifactSizeBytes: 18 * GIB,
    precision: null,
    quantization: '4-bit (K-Quant-Dynamic / K-Quant-17GB)',
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    // Vendor-stated: 4-bit quantized needs 24-32GB VRAM.
    estimatedRequirements: { ramBytes: 24 * GIB, vramBytes: 24 * GIB, diskBytes: Math.round(18 * GIB), confidenceType: 'OFFICIAL_REQUIREMENT' },
  }),
  Object.freeze({
    id: 'gpt-oss-120b-ollama',
    canonicalId: 'openai/gpt-oss-120b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/gpt-oss',
    ollamaPullName: 'gpt-oss:120b',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: 65 * GIB,
    precision: 'MXFP4',
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: false,
    // Vendor-stated: fits a single 80GB GPU.
    estimatedRequirements: { ramBytes: 80 * GIB, vramBytes: 80 * GIB, diskBytes: Math.round(65 * GIB), confidenceType: 'OFFICIAL_REQUIREMENT' },
  }),
  Object.freeze({
    id: 'nemotron-3.5-lightning-30b-ollama',
    canonicalId: 'nvidia/nemotron-3.5-lightning-30b',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/nemotron-3.5-lightning',
    ollamaPullName: 'nemotron-3.5-lightning:30b',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: 25 * GIB,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: true,
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: { ramBytes: null, vramBytes: null, diskBytes: Math.round(25 * GIB), confidenceType: 'DERIVED_ESTIMATE' },
  }),
  Object.freeze({
    id: 'north-mini-code-1.0-ollama',
    canonicalId: 'cohere/north-mini-code-1.0',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library/north-mini-code-1.0',
    ollamaPullName: 'north-mini-code-1.0',
    huggingFaceRepo: 'CohereLabs/North-Mini-Code-1.0',
    localArtifactPath: null,
    artifactSizeBytes: null, // base tag listed in library but individual page/size not fetched in AI-2
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: false, // AI-2 §5.2 — base name confirmed present, tag/size not individually verified
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: null,
  }),
  Object.freeze({
    id: 'devstral-small-2-ollama',
    canonicalId: 'mistral/devstral-small-2',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library',
    ollamaPullName: 'devstral-small-2',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: null,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: false, // listing-level only per AI-2 §5.2
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: { ramBytes: null, vramBytes: 24 * GIB, diskBytes: null, confidenceType: 'COMMUNITY_ESTIMATE' },
  }),
  Object.freeze({
    id: 'magistral-ollama',
    canonicalId: 'mistral/magistral',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library',
    ollamaPullName: 'magistral',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: null,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: false, // listing-level only per AI-2 §5.2
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: null,
  }),
  Object.freeze({
    id: 'deepseek-r1-distill-ollama',
    canonicalId: 'deepseek/deepseek-r1-distill',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library',
    ollamaPullName: 'deepseek-r1',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: null, // size varies hugely across the 1.5B-671B ladder; per-tag size not captured
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: false, // base name confirmed present in listing; specific small-distill tags not individually verified
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: null,
  }),
  Object.freeze({
    id: 'minicpm-v4.5-ollama',
    canonicalId: 'openbmb/minicpm-v4.5',
    runtime: 'OLLAMA',
    source: 'ollama-library',
    sourceUrl: 'https://ollama.com/library',
    ollamaPullName: 'minicpm-v4.5',
    huggingFaceRepo: null,
    localArtifactPath: null,
    artifactSizeBytes: null,
    precision: null,
    quantization: null,
    executionLocation: 'LOCAL',
    verified: false, // listing-level only per AI-2 §5.2
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: null,
  }),
  Object.freeze({
    id: 'llama3.1-8b-abliterated-community',
    canonicalId: 'community/llama3.1-8b-abliterated',
    runtime: 'GGUF',
    source: 'huggingface-community',
    sourceUrl: null,
    ollamaPullName: null,
    huggingFaceRepo: null, // upstream repo not individually confirmed in AI-2 — multiple candidate uploaders found
    localArtifactPath: null,
    artifactSizeBytes: Math.round(5.7 * GIB), // community-reported Q5_K_M size per AI-2 §8
    precision: null,
    quantization: 'Q5_K_M',
    executionLocation: 'LOCAL',
    verified: false, // community model — never treat as installable/verified by default
    lastVerifiedAt: '2026-09-21',
    requiresRemoteCode: 'unknown',
    estimatedRequirements: { ramBytes: null, vramBytes: null, diskBytes: Math.round(5.7 * GIB), confidenceType: 'COMMUNITY_ESTIMATE' },
  }),
]);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getModelByCanonicalId(canonicalId) {
  return MODEL_CATALOG.find(m => m.canonicalId === canonicalId) ?? null;
}

export function getDistributionsForModel(canonicalId) {
  return MODEL_DISTRIBUTIONS.filter(d => d.canonicalId === canonicalId);
}

export function getDistributionById(id) {
  return MODEL_DISTRIBUTIONS.find(d => d.id === id) ?? null;
}

/** Only distributions individually verified in AI-2 may ever be treated as installable. */
export function getVerifiedLocalDistributions() {
  return MODEL_DISTRIBUTIONS.filter(d => d.verified === true && d.executionLocation === 'LOCAL');
}

export function isCatalogStale(now = new Date()) {
  const generated = new Date(CATALOG_GENERATED_AT);
  const ageDays = (now.getTime() - generated.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > CATALOG_STALE_AFTER_DAYS;
}

export function getCatalogMeta() {
  return {
    catalogVersion: CATALOG_VERSION,
    generatedAt: CATALOG_GENERATED_AT,
    staleAfterDays: CATALOG_STALE_AFTER_DAYS,
    stale: isCatalogStale(),
    modelCount: MODEL_CATALOG.length,
    distributionCount: MODEL_DISTRIBUTIONS.length,
  };
}

// ---------------------------------------------------------------------------
// Validation — mission §15
// ---------------------------------------------------------------------------

/**
 * Strictly validates the catalog. Returns { valid, errors[] }. Pure, no I/O.
 */
export function validateCatalog(models = MODEL_CATALOG, distributions = MODEL_DISTRIBUTIONS) {
  const errors = [];
  const seenModelIds = new Set();
  const seenDistIds = new Set();

  for (const m of models) {
    if (seenModelIds.has(m.canonicalId)) {
      errors.push(`duplicate canonicalId: ${m.canonicalId}`);
    }
    seenModelIds.add(m.canonicalId);

    if (!TRUST_LEVELS.includes(m.trustLevel)) {
      errors.push(`invalid trustLevel "${m.trustLevel}" for ${m.canonicalId}`);
    }
    if (!m.publisher || !String(m.publisher).trim()) {
      errors.push(`empty publisher for ${m.canonicalId}`);
    }
    const { totalParameters, activeParameters } = m.architecture ?? {};
    if (totalParameters != null && activeParameters != null && activeParameters > totalParameters) {
      errors.push(`activeParameters > totalParameters for ${m.canonicalId}`);
    }
    if (m.releaseDate != null && Number.isNaN(Date.parse(m.releaseDate))) {
      errors.push(`invalid releaseDate for ${m.canonicalId}`);
    }
    if (Number.isNaN(Date.parse(m.lastVerifiedAt))) {
      errors.push(`invalid lastVerifiedAt for ${m.canonicalId}`);
    }
    if (m.provenance === 'community_modified' && !m.upstreamCanonicalId) {
      errors.push(`community_modified model missing upstreamCanonicalId: ${m.canonicalId}`);
    }
  }

  for (const d of distributions) {
    if (seenDistIds.has(d.id)) {
      errors.push(`duplicate distribution id: ${d.id}`);
    }
    seenDistIds.add(d.id);

    if (!seenModelIds.has(d.canonicalId)) {
      errors.push(`orphan distribution (no matching model): ${d.id} -> ${d.canonicalId}`);
    }
    if (!EXECUTION_LOCATIONS.includes(d.executionLocation)) {
      errors.push(`invalid executionLocation "${d.executionLocation}" for distribution ${d.id}`);
    }
    if (!RUNTIMES.includes(d.runtime)) {
      errors.push(`invalid runtime "${d.runtime}" for distribution ${d.id}`);
    }
    // Ambiguity guard: a pull name ending in "-cloud" must be marked CLOUD.
    if (d.ollamaPullName && /-cloud$/i.test(d.ollamaPullName) && d.executionLocation !== 'CLOUD') {
      errors.push(`unverified local/cloud ambiguity: "${d.ollamaPullName}" looks cloud-tagged but executionLocation is ${d.executionLocation}`);
    }
    if (Number.isNaN(Date.parse(d.lastVerifiedAt))) {
      errors.push(`invalid lastVerifiedAt for distribution ${d.id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
