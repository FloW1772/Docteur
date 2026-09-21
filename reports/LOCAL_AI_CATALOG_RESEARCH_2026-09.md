# Local AI Model Catalog & Free LLM API Research — September 2026

**Deliverable for:** Docteur `ModelCatalogEntry` design phase
**Status:** RESEARCH ONLY — no code written, no repository files modified other than this report.

---

## 1. Research date and methodology

**Research performed:** 2026-09-21 (single session).

**Method.** All substantive claims in this report were gathered via live web search and live page fetches performed on 2026-09-21. The assistant's own training data (cutoff May 2026) was explicitly treated as **stale and untrustworthy** for this domain, and this proved correct: several major releases in this report (Gemma 4, Qwen 3.6/3.8, DeepSeek V4, Meta Muse Glimmer, Kimi K3, GLM-5.3, the GitHub Models retirement) either post-date or contradict pre-session assumptions.

**Source priority ladder used:**

1. **Tier 1 — Official first-party.** Developer's own site/blog, official GitHub repo, official Hugging Face organization, official API documentation (`ai.google.dev`, `console.groq.com`, `openrouter.ai/docs`, `mistral.ai/news`, `github.com/zai-org`, `lmstudio.ai/docs`).
2. **Tier 2 — Official distribution channel.** `ollama.com/library/*` pages. These are authoritative for *pull names, tag sizes in GB, context length as configured, and capability flags*, which is exactly what Docteur needs. They are frequently **silent on license**, so license was cross-checked at Tier 1.
3. **Tier 3 — Community/secondary.** Blogs, aggregator sites, news write-ups. Used **only** for corroboration, for signalling that something exists so it could then be verified at Tier 1/2, or where explicitly labelled below as COMMUNITY_ESTIMATE.

**Confidence tagging convention used throughout:**

| Tag | Meaning |
|---|---|
| `OFFICIAL` | Stated by a Tier 1 first-party source fetched this session. |
| `OFFICIAL_DISTRIBUTION` | Stated on the official Ollama library page fetched this session. |
| `OFFICIAL_REQUIREMENT` | A hardware/memory figure stated by the model's own developer. |
| `COMMUNITY_ESTIMATE` | Stated by a non-first-party source; treat as indicative only. |
| `DERIVED_ESTIMATE` | Computed by me from a verified artifact size (e.g. Ollama GB figure + overhead). Not a measurement. |
| `UNKNOWN` | Not found in any source fetched this session. **Never guessed.** |

**Known methodological weakness.** Release *dates* were the least reliable field across all sources and are flagged individually. See §15.

---

## 2. Sources reviewed

Pages fetched directly this session:

- https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/providers.json — the catalog Docteur's Free AI Finder already consumes (v2.9.0, generated 2026-08-14)
- https://ollama.com/library — full library listing (~200 entries captured)
- https://ollama.com/library/gemma4
- https://ollama.com/library/qwen3.8
- https://ollama.com/library/qwen3.6
- https://ollama.com/library/qwen3.5
- https://ollama.com/library/gpt-oss
- https://ollama.com/library/muse-glimmer
- https://ollama.com/library/granite4.2
- https://ollama.com/library/lfm2.5
- https://ollama.com/library/nemotron-3.5-lightning
- https://ai.google.dev/gemma/docs/core/model_card_4 — official Gemma 4 model card
- https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/ — official Gemma 4 announcement
- https://huggingface.co/Qwen — official Qwen HF org listing
- https://huggingface.co/Qwen/Qwen3.8-27B — official model card
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash — official model card
- https://huggingface.co/meta-models/Muse-Glimmer-30B — official model card
- https://huggingface.co/microsoft — official Microsoft HF org listing
- https://huggingface.co/blog/state-of-open-models-summer-2026 — Hugging Face ecosystem overview
- https://github.com/zai-org/GLM-5 — official GLM-5 repo
- https://mistral.ai/news/mistral-3/ — official Mistral 3 announcement
- https://console.groq.com/docs/rate-limits — official Groq rate limits
- https://ai.google.dev/gemini-api/docs/rate-limits — official Gemini rate limits
- https://openrouter.ai/docs/api-reference/limits — official OpenRouter limits
- https://lmstudio.ai/docs/app/api — official LM Studio API docs

Searches run (results used for discovery, then verified where possible): Qwen 2026 releases; Gemma 4; gpt-oss successor; Phi 2026; Mistral 2026; DeepSeek V4; Meta open weights 2026; GLM-5.x; MiniMax M3 / Kimi K3; InternLM / Shanghai AI Lab; Cohere open weights; LM Studio 2026; abliterated models 2026; Groq / Cerebras / Cloudflare / GitHub Models / Together / HF Inference free tiers.

**Not reachable.** `https://qwen.ai/blog?id=...` and `https://qwen.ai/research/` returned only the string "Qwen" — the site is client-side rendered and does not yield content to a fetcher. Qwen data below therefore comes from the **Hugging Face org + official model cards + Ollama library**, which are all first-party or official-distribution.

---

## 3. Model families reviewed — current status

The single most important finding of this research: **Docteur's current hardcoded list of 11 Ollama models is comprehensively obsolete.** Every one of the 11 belongs to a generation that has been superseded one to three times over.

| Family | Status as of 2026-09 | Notes |
|---|---|---|
| **Qwen** | **ACTIVE — ecosystem leader** | Now at Qwen3.8. Qwen2.5 (in Docteur's list) is ~2 years old and **OBSOLETE**. Hugging Face reports Qwen has 151,448 derivatives, 2.6× Meta's footprint. |
| **Google Gemma** | **ACTIVE — Gemma 4 shipped** | Gemma 4 exists and is on Ollama with 25.4M pulls. Gemma 2 (in Docteur's list) is **OBSOLETE**; Gemma 3 is superseded but still widely used. |
| **OpenAI gpt-oss** | **ACTIVE but STATIC** | Still gpt-oss-20b / gpt-oss-120b from Aug 2025. **No gpt-oss-2 successor found.** Only additions are the `gpt-oss-safeguard` variants. Still highly relevant — Apache 2.0, strong reasoning, runs in 16GB. |
| **Microsoft Phi** | **SEMI-DORMANT** | Latest first-party release found is `Phi-4-reasoning-vision-15B`. **No Phi-5 exists** despite third-party blogs claiming otherwise (see §15 — this is a confirmed hallucination-in-the-wild). Microsoft's HF org is now dominated by speech/vision models, not Phi LLMs. Declining relevance. |
| **Mistral / Ministral** | **ACTIVE** | Mistral 3 generation (Mistral Large 3, Ministral 3 at 14B/8B/3B), Devstral 2, Magistral, Mistral Medium 3.5. Mistral 7B and Mistral NeMo (both in Docteur's list) are **OBSOLETE**. |
| **DeepSeek** | **ACTIVE — at V4** | V4-Pro (1.6T/49B) and V4-Flash (284B/13B), MIT licensed. V3 and R1 are superseded; R1 distills remain popular for small local use. |
| **Meta Llama** | **BRAND EFFECTIVELY RETIRED** | Meta's 2026 open release is **not** called Llama — it is **Muse Glimmer 30B** (Apache 2.0, Aug 2026), from the restructured Superintelligence Labs org. **No Llama 5.** Llama 3.1/3.2 (in Docteur's list) are legacy. |
| **GLM (Z.ai / Zhipu)** | **ACTIVE — major player** | GLM-5, 5.1, 5.2, 5.3 (744B/40B) plus GLM-5.3-Flash (320B/18B), Apache 2.0. Also `glm-4.7-flash`, `glm-5.3-flash` on Ollama. |
| **MiniMax** | **ACTIVE** | MiniMax M3 (428B/~23B, 1M context, multimodal), custom `minimax-community` license. `minimax-m3` and `minimax-m2.7` on Ollama. |
| **Moonshot / Kimi** | **ACTIVE — frontier** | Kimi K3 (2.8T/104B) open-weighted July 2026 under a **custom revenue-gated license**, not MIT. |
| **InternLM** | **REBRANDED / LOW LOCAL RELEVANCE** | Shanghai AI Lab's 2026 output is `Intern-S1-Pro` (1T), `Agents-A1` (35B MoE, Apache 2.0), `Atria Dawn Preview` (744B, MIT) — not "InternLM 4". The InternLM line proper appears dormant. Only `internlm2` on Ollama, 2 years old. **Effectively obsolete for local use.** |
| **Cohere** | **ACTIVE — and now genuinely local** | **This overturns the old "Cohere is API-only" assumption.** `North-Mini-Code-1.0` (30B total / 3B active MoE) is Apache 2.0 open weights and on Ollama. |
| **NVIDIA Nemotron** | **ACTIVE — significant** | Nemotron 3 Nano/Super/Ultra, Nemotron 3.5 Lightning (30B/3B, 1M context). A major family entirely absent from Docteur's catalog. |
| **IBM Granite** | **ACTIVE** | Granite 4.1 / 4.2, Apache 2.0, 3B–30B. Strong enterprise/tool-calling niche. |
| **Liquid AI LFM** | **ACTIVE — edge niche** | LFM2, LFM2.5, LFM2.5-Thinking. Purpose-built for on-device. |
| **Poolside Laguna** | **ACTIVE — new entrant (2026)** | `laguna-xs-2.1` (33B MoE / 3B active), `laguna-s-2.1`. Agentic coding. |
| **DeepReinforce Ornith** | **ACTIVE — new entrant (2026)** | Ornith-1.5 at 397B / 35B / 9B, MIT. |
| **Yi (01.AI)** | **OBSOLETE for local** | Only `yi` and `yi-coder`, both 2 years old on Ollama. No 2026 activity found. |
| **Baichuan** | **NO OLLAMA PRESENCE** | Not in the Ollama library at all. Not relevant to Docteur. |
| **LLaVA** | **OBSOLETE** | `llava:7b` (in Docteur's list) is 2 years old. Superseded by native-vision models (Qwen3.x, Gemma 4, Muse Glimmer) and by MiniCPM-V 4.5/4.6. |
| **nomic-embed-text** | **AGED BUT STILL VALID** | 2 years old but still the most-pulled embedding model (86.6M). `nomic-embed-text-v2-moe` and `embeddinggemma` are newer options. |

---

## 4. Per-model data tables

> Field legend per §1. Where the Ollama library page states a figure, it is `OFFICIAL_DISTRIBUTION`. Where a first-party model card states it, `OFFICIAL`.

### 4.1 Qwen (Alibaba)

**Official HF org:** https://huggingface.co/Qwen · **Ollama:** `qwen3.8`, `qwen3.6`, `qwen3.5`, `qwen3-coder-next`, `qwen3.8-flash-next`

#### Qwen3.8-27B — the flagship local candidate

| Field | Value | Confidence |
|---|---|---|
| Official source | https://huggingface.co/Qwen/Qwen3.8-27B | OFFICIAL |
| Ollama page | https://ollama.com/library/qwen3.8 | OFFICIAL_DISTRIBUTION |
| Pull name | `ollama pull qwen3.8:27b` (also `qwen3.8:latest`, `qwen3.8:27b-mlx`) | OFFICIAL_DISTRIBUTION |
| Release date | August 2026 | OFFICIAL (model card citation date; exact day UNKNOWN) |
| License | **Apache 2.0** | OFFICIAL |
| Architecture | **Dense** (not MoE) + vision encoder; 64 layers, hybrid `Gated DeltaNet → FFN` / `Gated Attention → FFN` blocks | OFFICIAL |
| Total params | 27B | OFFICIAL |
| Active params | 27B (dense — all active) | OFFICIAL |
| Context | 262,144 native, extensible to 1,000,000 | OFFICIAL |
| Modalities | Text + image + video in, text out | OFFICIAL |
| Capabilities | Reasoning (`reasoning_effort` control), coding, agentic long-horizon, tool calling, multilingual | OFFICIAL |
| Quantizations | 1,188 community quantized repos listed on HF; explicit llama.cpp / Ollama / LM Studio / Jan support | OFFICIAL |
| Ollama artifact size | 18GB | OFFICIAL_DISTRIBUTION |
| RAM/VRAM | ~20–24GB to run the 18GB Ollama artifact with KV cache | **DERIVED_ESTIMATE** — no official figure published |
| trust_remote_code | Not required; standard Transformers integration | OFFICIAL |

#### Qwen3.8-2.4T-A95B — flagship, not locally runnable

| Field | Value | Confidence |
|---|---|---|
| HF | https://huggingface.co/Qwen (org listing shows `Qwen3.8-2.4T-A95B`, updated Aug 12) | OFFICIAL |
| Total / active | 2.4T total / ~95B active | COMMUNITY_ESTIMATE (name encodes it; not read from a first-party card this session) |
| License | **Custom "Qwen3.8-Max License"** — NOT Apache. Free for most commercial use, with (a) UI attribution required above 100M MAU or $20M monthly revenue, (b) separate Alibaba license required for MaaS/AI-work-assistant businesses above ~US$50M/12mo revenue | COMMUNITY_ESTIMATE — **must be verified at Tier 1 before any product decision** |
| Local viability | **None for Docteur.** No Ollama entry. | OFFICIAL_DISTRIBUTION (absent from library) |

#### Qwen3.6 family

| Field | Value | Confidence |
|---|---|---|
| Pull names | `qwen3.6:27b` (18GB), `qwen3.6:35b` (23GB, = `latest`), `qwen3.6:27b-mlx`, `qwen3.6:35b-mlx` | OFFICIAL_DISTRIBUTION |
| Total / active | 27B dense; **35B total / 3B active MoE** for the 35b | COMMUNITY_ESTIMATE for the 35B active count — Ollama page does not state active params |
| Context | 256K | OFFICIAL_DISTRIBUTION |
| Modalities | Text + image | OFFICIAL_DISTRIBUTION |
| Release date | April 2026 | COMMUNITY_ESTIMATE |
| License | UNKNOWN (Ollama page silent; qwen.ai unreachable) | UNKNOWN |

#### Qwen3.5 family — **the best-covered size ladder for Docteur**

| Pull name | Ollama size | Context | Modalities | Confidence |
|---|---|---|---|---|
| `qwen3.5:0.8b` | 1.0GB | 256K | text+image | OFFICIAL_DISTRIBUTION |
| `qwen3.5:2b` | 2.7GB | 256K | text+image | OFFICIAL_DISTRIBUTION |
| `qwen3.5:4b` | 3.4GB | 256K | text+image | OFFICIAL_DISTRIBUTION |
| `qwen3.5:9b` | 6.6GB | 256K | text+image | OFFICIAL_DISTRIBUTION |
| `qwen3.5:27b` | 17GB | 256K | text+image | OFFICIAL_DISTRIBUTION |
| `qwen3.5:35b` | 24GB | 256K | text+image | OFFICIAL_DISTRIBUTION |
| `qwen3.5:122b` | 81GB | 256K | text+image | OFFICIAL_DISTRIBUTION |

Architecture: "Gated Delta Networks combined with sparse Mixture-of-Experts", unified vision-language early-fusion, 201 languages (OFFICIAL_DISTRIBUTION). **Per-variant total/active split: UNKNOWN.** License: UNKNOWN.

#### Qwen legacy — status for Docteur's existing entries

| Docteur's current entry | Status |
|---|---|
| `qwen2.5:7b`, `qwen2.5:14b`, `qwen2.5:14b-instruct-q3_K_M` | **OBSOLETE** — `qwen2.5` last updated 2 years ago |
| `qwen2.5-coder:7b` | **OBSOLETE** — superseded by `qwen3-coder`, `qwen3-coder-next` |

---

### 4.2 Google Gemma

**Official:** https://ai.google.dev/gemma/docs/core/model_card_4 · **Ollama:** `gemma4`

**License for the entire Gemma 4 family: Apache 2.0** (OFFICIAL, confirmed on both the model card and the blog). This is a **significant change from Gemma 2/3**, which shipped under the custom restrictive "Gemma Terms of Use" with a use-policy and MAU considerations. The announcement explicitly states "no monthly active user caps, no acceptable-use policy enforcement, full commercial freedom."

| Variant | Pull name | Ollama size | Total params | Active params | Context | Modalities | Confidence |
|---|---|---|---|---|---|---|---|
| E2B | `gemma4:e2b` | 7.2GB | 2.3B effective (5.1B w/ embeddings) | dense | 128K | text+image+**audio** | OFFICIAL |
| E4B | `gemma4:e4b` | 9.6GB | 4.5B effective (8B w/ embeddings) | dense | 128K | text+image+**audio** | OFFICIAL |
| 12B Unified | `gemma4:12b` | 7.6GB | 11.95B | dense | 256K | text+image+**audio** | OFFICIAL |
| 26B A4B MoE | `gemma4:26b` | 19GB | **25.2B total** | **3.8B active** (8 of 128 experts) | 256K | text+image | OFFICIAL |
| 31B Dense | `gemma4:31b` | 20GB | 30.7B | dense | 256K | text+image | OFFICIAL |
| 31B cloud | `gemma4:31b-cloud` | n/a (hosted) | 30.7B | dense | 256K | text+image | OFFICIAL_DISTRIBUTION |

- Capabilities: reasoning with configurable thinking modes (`<|think|>` token control), long context, image + video understanding, interleaved multimodal input, function calling, coding, 140+ languages (OFFICIAL).
- **Release date: CONFLICTED.** The official model card says **July 30, 2026**; the official Google blog post says **April 2, 2026**. Both are Tier 1 Google sources. Most plausible reconciliation: April = initial launch, July = model card revision or a refreshed checkpoint. **Treat as UNKNOWN pending resolution** — see §15.
- Hardware: model card gives **no** explicit memory figures, only "high-end phones to laptops and servers" (OFFICIAL). Any VRAM number for Gemma 4 is DERIVED_ESTIMATE.
- trust_remote_code: UNKNOWN (not stated).

**Docteur's `gemma2:9b` is OBSOLETE** (2 years old, restrictive license).

---

### 4.3 OpenAI gpt-oss

**Official:** https://openai.com/index/introducing-gpt-oss/ · **Ollama:** `gpt-oss`

| Field | gpt-oss-20b | gpt-oss-120b | Confidence |
|---|---|---|---|
| Pull name | `ollama pull gpt-oss:20b` (= `latest`) | `ollama pull gpt-oss:120b` | OFFICIAL_DISTRIBUTION |
| Ollama size | 14GB | 65GB | OFFICIAL_DISTRIBUTION |
| Release date | 2025-08-05 | 2025-08-05 | OFFICIAL |
| License | **Apache 2.0** | **Apache 2.0** | OFFICIAL |
| Architecture | MoE | MoE | OFFICIAL |
| Total params | 21B | 117B | OFFICIAL |
| Active params | **UNKNOWN** — widely reported but not confirmed at Tier 1 this session | **UNKNOWN** — same | UNKNOWN |
| Context | 128K | 128K | OFFICIAL_DISTRIBUTION |
| Modalities | Text only | Text only | OFFICIAL |
| Capabilities | Reasoning (configurable effort), function calling, structured outputs, Python tool calls, agentic, fine-tunable | same | OFFICIAL_DISTRIBUTION |
| Quantization | **MXFP4, 4.25 bits/param** (native, not a community quant) | MXFP4 | OFFICIAL_DISTRIBUTION |
| Memory | **"runs within 16GB"** | **"fits on a single 80GB GPU"** | **OFFICIAL_REQUIREMENT** |
| trust_remote_code | Not required | Not required | OFFICIAL_DISTRIBUTION (implied by first-class Ollama/llama.cpp support) |

Also available: `gpt-oss-safeguard:20b` / `:120b` — safety-reasoning variants (OFFICIAL_DISTRIBUTION), and cloud tags `gpt-oss:20b-cloud` / `:120b-cloud`.

**Notable:** gpt-oss-20b is one of the very few models in this report with a **first-party stated memory requirement**. That makes it unusually safe to surface in a UI resource estimate.

---

### 4.4 Microsoft Phi

| Field | Value | Confidence |
|---|---|---|
| Latest first-party model | `Phi-4-reasoning-vision-15B` — https://huggingface.co/microsoft/Phi-4-reasoning-vision-15B | OFFICIAL (visible on Microsoft's HF org, updated ~21 days before 2026-09-21) |
| Release date | March 2026 (reported 2026-03-04) | COMMUNITY_ESTIMATE |
| Params | 15B | OFFICIAL |
| License | MIT (consistent with the Phi family) | COMMUNITY_ESTIMATE for this specific model |
| Modalities | Image-text-to-text | OFFICIAL |
| Ollama | **No official `phi4-reasoning-vision` entry found.** Library has `phi4` (14B), `phi4-mini` (3.8B), `phi4-reasoning` (14B), `phi4-mini-reasoning` (3.8B), `phi3`, `phi3.5`, `phi` | OFFICIAL_DISTRIBUTION |

**Phi-5 DOES NOT EXIST.** Multiple third-party blogs (e.g. a Spheron "Deploy Microsoft Phi-5" guide with specific VRAM numbers) describe a Phi-5 in detail. It is **absent from Microsoft's own Hugging Face organization** and from any Microsoft announcement found. This is a concrete example of AI-generated SEO content fabricating a model. **Do not put Phi-5 in the catalog.**

Existing verified Phi Ollama pulls: `phi4:14b`, `phi4-mini:3.8b`, `phi4-reasoning:14b`, `phi4-mini-reasoning:3.8b`. All ~1 year old. Family relevance is **declining**.

---

### 4.5 Mistral / Ministral

**Official:** https://mistral.ai/news/mistral-3/

| Model | Params | License | Release | Confidence |
|---|---|---|---|---|
| Mistral Large 3 | **675B total / 41B active** MoE | Apache 2.0 | 2025-12-02 | OFFICIAL |
| Ministral 3 14B | 14B dense | Apache 2.0 | 2025-12-02 | OFFICIAL |
| Ministral 3 8B | 8B dense | Apache 2.0 | 2025-12-02 | OFFICIAL |
| Ministral 3 3B | 3B dense | Apache 2.0 | 2025-12-02 | OFFICIAL |

- Ministral 3 modalities: text + image understanding, 40+ languages; base/instruct/reasoning variants each (OFFICIAL).
- Mistral Large 3 context: **UNKNOWN from the announcement** (a secondary source says 256K — COMMUNITY_ESTIMATE).
- Ministral 3 context: **UNKNOWN** (not stated in the announcement).

**Verified Ollama pulls (sizes from library listing):**

| Pull name | Sizes | Note | Confidence |
|---|---|---|---|
| `ministral-3` | 3B–14B | Edge deployment family | OFFICIAL_DISTRIBUTION |
| `devstral-small-2` | 24B | Tool use + code exploration | OFFICIAL_DISTRIBUTION |
| `devstral-2` | 123B | | OFFICIAL_DISTRIBUTION |
| `mistral-large-3` | — | Multimodal MoE | OFFICIAL_DISTRIBUTION |
| `mistral-medium-3.5` | 128B | | OFFICIAL_DISTRIBUTION |
| `magistral` | 24B | Reasoning | OFFICIAL_DISTRIBUTION |
| `mistral-small3.2` | 24B | | OFFICIAL_DISTRIBUTION |

Devstral Small 2 hardware: **"comfortably fits a single RTX 4090 or a 32GB Apple Silicon Mac"** — COMMUNITY_ESTIMATE (secondary source, not read from Mistral's own page).

**Docteur's `mistral:7b` and `mistral-nemo:12b-instruct-2407-q4_K_M` are both OBSOLETE.**

---

### 4.6 DeepSeek

**Official:** https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash

#### DeepSeek-V4-Flash

| Field | Value | Confidence |
|---|---|---|
| Total / active | **284B total / 13B active** | OFFICIAL |
| Architecture | MoE, hybrid attention (Compressed Sparse Attention + Heavily Compressed Attention) | OFFICIAL |
| Context | 1,000,000 tokens | OFFICIAL |
| License | **MIT** | OFFICIAL |
| Release | April 2026 (preview); V4-Flash-0731 GA checkpoint 2026-07-31 | OFFICIAL (preview) / COMMUNITY_ESTIMATE (GA date) |
| Modalities | **Text only** | OFFICIAL |
| Capabilities | Coding, math, reasoning, long context; **three reasoning modes** (Non-think / Think High / Think Max) | OFFICIAL |
| Precision | Native **FP4 + FP8 mixed** (MoE experts FP4, rest FP8) | OFFICIAL |
| Training | 32T+ tokens | OFFICIAL |
| trust_remote_code | Not mentioned as required | OFFICIAL (absence) |
| Hardware | No VRAM figure. Only: ≥384K context window recommended for Think Max | OFFICIAL (partial) |
| Ollama | `deepseek-v4-flash`, and `deepseek-v4.1-flash` (newer, updated ~1 week before 2026-09-21) | OFFICIAL_DISTRIBUTION |

#### DeepSeek-V4-Pro

| Field | Value | Confidence |
|---|---|---|
| Total / active | 1.6T total / 49B active | COMMUNITY_ESTIMATE |
| Context | 1M, 384K max output | COMMUNITY_ESTIMATE |
| License | MIT | COMMUNITY_ESTIMATE |
| GA | 2026-08-12/13 | COMMUNITY_ESTIMATE |
| Local viability | **None for Docteur** at 1.6T | — |

#### DeepSeek legacy still relevant locally

`deepseek-r1` (1.5B–671B, 93M pulls — **the 2nd most-pulled model on Ollama overall**) and its distills remain the practical local reasoning option. `deepseek-v3`, `deepseek-v3.1` (671B) are not consumer-runnable. `deepseek-ocr` (3B) is a useful narrow tool.

---

### 4.7 Meta

**The Llama brand has no 2026 successor.** Meta's current open release is:

#### Muse Glimmer 30B

| Field | Value | Confidence |
|---|---|---|
| Official | https://huggingface.co/meta-models/Muse-Glimmer-30B ; https://developer.meta.com/ai/models/muse-glimmer/ | OFFICIAL |
| Ollama | `ollama pull muse-glimmer:30b` (= `latest`, 18GB); `muse-glimmer:30b-mlx` (19GB) | OFFICIAL_DISTRIBUTION |
| Release | August 2026 (HF upload reported 2026-08-10) | OFFICIAL (month) / COMMUNITY_ESTIMATE (day) |
| License | **Apache 2.0** | OFFICIAL |
| Architecture | **Dense** causal transformer + ViT-G/14 perception encoder. Explicitly *not* MoE. | OFFICIAL |
| Total / active | ~29.6B / all active (dense) | OFFICIAL |
| Context | 131,072+ (Ollama page states 128K) | OFFICIAL / OFFICIAL_DISTRIBUTION |
| Modalities | Text + image in, text out; 100+ languages | OFFICIAL |
| Capabilities | Agentic task completion, tool use/function calling, multi-step reasoning, failure recovery, multimodal | OFFICIAL |
| Quantizations | BF16 full; 4-bit variants (K-Quant-Dynamic, K-Quant-17GB) | OFFICIAL |
| **Hardware** | **Full precision 64GB VRAM; 4-bit quantized 24–32GB VRAM** | **OFFICIAL_REQUIREMENT** (stated on the model card) |
| Special | Ships `DFlash`, a bundled speculative-decoding drafter checkpoint (~3.1× speedup claimed) | OFFICIAL |
| Knowledge cutoff | 2026-01-04 | COMMUNITY_ESTIMATE |
| trust_remote_code | Not mentioned | UNKNOWN |

Legacy: `llama3.1` (119.7M pulls, still #1 on Ollama by volume), `llama3.2`, `llama3.3:70b`, `llama4` (16x17B–128x17B). Docteur's `llama3.2:3b` and `llama3.1:8b` still work but are a generation behind.

---

### 4.8 GLM (Z.ai / Zhipu)

**Official:** https://github.com/zai-org/GLM-5 — **License: Apache-2.0** (OFFICIAL, repo-level)

| Model | Total / active | Precision offered | Confidence |
|---|---|---|---|
| GLM-5.3 | 744B / 40B | FP8, BF16 | OFFICIAL |
| GLM-5.3-Flash | **320B / 18B** | FP8, BF16 | OFFICIAL |
| GLM-5.2 | 744B / 40B | FP8, BF16 | OFFICIAL |
| GLM-5.1 | 744B / 40B | FP8, BF16 | OFFICIAL |
| GLM-5 | 744B / 40B | FP8, BF16 | OFFICIAL |

- GLM-5.3-Flash architecture: hybrid sparse + linear attention (OFFICIAL).
- Context: GLM-5.2 "1M-token context" (OFFICIAL). Per-model context otherwise UNKNOWN.
- Modalities: multimodal text+vision (OFFICIAL, repo-level statement).
- Release dates: **not in the repo.** GLM-5.3 API launch reported 2026-08-14 with weights ~2 weeks later (~2026-08-28) — COMMUNITY_ESTIMATE.
- Ollama: `glm-5.3`, `glm-5.3-flash` (18B active, "first natively multimodal"), `glm-5.2`, `glm-5.1`, `glm-4.7-flash` (30B class), `glm4:9b`, `glm-ocr` — OFFICIAL_DISTRIBUTION.
- **Local viability:** the 744B models are not consumer-runnable. `glm-4.7-flash` (30B class) and `glm-5.3-flash` are the plausible local candidates.

---

### 4.9 MiniMax

| Field | Value | Confidence |
|---|---|---|
| Official | https://huggingface.co/MiniMaxAI/MiniMax-M3 ; https://www.minimax.io/models/text/m3 | OFFICIAL (URL) — card not fetched this session |
| Total / active | 428B total / ~23B active | COMMUNITY_ESTIMATE |
| Architecture | MoE + grouped-query attention with MiniMax Sparse Attention (MSA) | COMMUNITY_ESTIMATE |
| Context | 1M | COMMUNITY_ESTIMATE |
| Modalities | Text + image + video (mixed-modality training from step 0) | COMMUNITY_ESTIMATE |
| License | **Custom `minimax-community` license** — NOT Apache/MIT | COMMUNITY_ESTIMATE — **verify before use** |
| Release | 2026-06-01, weights on HF by 2026-06-07 | COMMUNITY_ESTIMATE |
| Ollama | `minimax-m3`, `minimax-m2.7` | OFFICIAL_DISTRIBUTION |
| Local viability | Poor at 428B | — |

---

### 4.10 Moonshot / Kimi

| Field | Value | Confidence |
|---|---|---|
| Model | Kimi K3 | — |
| Total / active | 2.8T total / 104B active | COMMUNITY_ESTIMATE |
| Context | 1M, native vision | COMMUNITY_ESTIMATE |
| Release | 2026-07-26 (weights) | COMMUNITY_ESTIMATE |
| License | **Custom "Kimi K3 License"** — revenue-gated. Separate agreement required for MaaS businesses >$20M/12mo revenue; UI attribution required >100M MAU or >$20M monthly revenue. **Not MIT, not Apache.** | COMMUNITY_ESTIMATE — **must verify at Tier 1** |
| Ollama | `kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code` | OFFICIAL_DISTRIBUTION |
| Local viability | **None** at 2.8T | — |

---

### 4.11 Cohere — now has a local option

| Field | Value | Confidence |
|---|---|---|
| Model | North-Mini-Code-1.0 | — |
| Official | https://huggingface.co/CohereLabs/North-Mini-Code-1.0 ; https://cohere.com/blog/north-mini-code | OFFICIAL (URL) |
| Ollama | `ollama pull north-mini-code-1.0` — https://ollama.com/library/north-mini-code-1.0 | OFFICIAL_DISTRIBUTION |
| Total / active | **30B total / 3B active** MoE, 128 experts / 8 activated per token | COMMUNITY_ESTIMATE (consistent across multiple sources incl. Cohere docs summary) |
| Context | 256K input / 64K max output | COMMUNITY_ESTIMATE |
| License | **Apache 2.0** + Cohere Labs Acceptable Use Policy | COMMUNITY_ESTIMATE |
| Release | 2026-06-09 | COMMUNITY_ESTIMATE |
| Weight formats | bf16, fp8, w4a16 (official CohereLabs repos for each) | COMMUNITY_ESTIMATE |
| Capabilities | Agentic coding, terminal tasks, interleaved reasoning + tool use via JSON schema | COMMUNITY_ESTIMATE |

**Note the licensing subtlety:** Apache 2.0 *plus* a separate Acceptable Use Policy is **not** plain Apache 2.0 in practice. Docteur's schema should be able to express "base license + additional policy" (see §13).

Older Cohere Ollama entries (`command-r:35b`, `command-r-plus:104b`, `command-a:111b`, `command-r7b`) are CC-BY-NC / non-commercial research licenses historically — **license for these: UNKNOWN this session, verify individually.**

---

### 4.12 NVIDIA Nemotron — major family missing from Docteur

| Pull name | Params | Context | Confidence |
|---|---|---|---|
| `nemotron-3.5-lightning:30b` | **30B total / 3B active** MoE | **1M** (MLX variant 256K) | OFFICIAL_DISTRIBUTION |
| `nemotron-3-nano` | 4B, 30B | UNKNOWN | OFFICIAL_DISTRIBUTION |
| `nemotron-3-super` | 120B MoE / 12B active | UNKNOWN | OFFICIAL_DISTRIBUTION |
| `nemotron-3-ultra` | 561B (reported) | UNKNOWN | OFFICIAL_DISTRIBUTION / COMMUNITY_ESTIMATE |
| `nemotron3` | 33B, multimodal (video/audio/image/text) | UNKNOWN | OFFICIAL_DISTRIBUTION |
| `nemotron-cascade-2` | 30B / 3B active | UNKNOWN | OFFICIAL_DISTRIBUTION |

nemotron-3.5-lightning Ollama size: 25GB; capability tags `tools`, `thinking`; claims 4× throughput vs peers (OFFICIAL_DISTRIBUTION). **License: UNKNOWN** — NVIDIA typically uses the NVIDIA Open Model License, which is *not* Apache/MIT. Must verify.

---

### 4.13 IBM Granite

| Pull name | Ollama size | Context | Confidence |
|---|---|---|---|
| `granite4.2:3b` | 2.2GB | 128K | OFFICIAL_DISTRIBUTION |
| `granite4.2:8b` | 5.3GB (= `latest`) | 128K | OFFICIAL_DISTRIBUTION |
| `granite4.2:30b` | 18GB | 128K | OFFICIAL_DISTRIBUTION |

License **Apache 2.0** (OFFICIAL_DISTRIBUTION — stated on the Ollama page). Dense decoder-only. Capabilities: summarization, classification, code, function calling, RAG, 12 languages, thinking mode with `/set think high`, structured JSON output. Exact parameter counts per tag: **UNKNOWN** (page gives sizes, not param counts). Also `granite4.1`, `granite4.1-guardian:8b`, `granite-embedding`.

---

### 4.14 Liquid AI LFM — edge specialist

| Pull name | Ollama size | Context | Params | Confidence |
|---|---|---|---|---|
| `lfm2.5:8b` | 5.2GB (= `latest`) | 125K | 8B | OFFICIAL_DISTRIBUTION |
| `lfm2.5-thinking` | — | UNKNOWN | 1.2B | OFFICIAL_DISTRIBUTION |
| `lfm2` | — | UNKNOWN | 24B | OFFICIAL_DISTRIBUTION |

Positioned for "rapid, dependable function calling on standard consumer devices", "fastest in its size class on both CPU and GPU inference" (OFFICIAL_DISTRIBUTION). **License: UNKNOWN** — Liquid AI has historically used a custom LFM Open License. Verify.

---

### 4.15 New 2026 entrants

| Family | Pull names | Params | License | Confidence |
|---|---|---|---|---|
| **Ornith** (DeepReinforce) | `ornith:9b`, `ornith:35b`, `ornith-1.5` (9B–397B) | 9B / 35B / 397B | **MIT** | COMMUNITY_ESTIMATE |
| **Laguna** (Poolside) | `laguna-xs-2.1`, `laguna-xs.2`, `laguna-s-2.1` | 33B MoE / 3B active | UNKNOWN | COMMUNITY_ESTIMATE (params) / UNKNOWN (license) |
| **Agents-A1** (Shanghai AI Lab) | Not on Ollama | 35B MoE, 256K ctx | Apache 2.0 | COMMUNITY_ESTIMATE |
| **Atria Dawn Preview** (Shanghai AI Lab) | Not on Ollama | 744B | MIT | COMMUNITY_ESTIMATE |

---

### 4.16 Vision / multimodal specialists

| Pull name | Params | Note | Confidence |
|---|---|---|---|
| `minicpm-v4.5` | 8B | "GPT-4o level 8B MLLM for multi-image/video" | OFFICIAL_DISTRIBUTION |
| `minicpm-v4.6` | 1B | "Pocket-sized MLLM for phones" | OFFICIAL_DISTRIBUTION |
| `qwen3-vl` | 2B–235B | "Most powerful vision-language in Qwen family" (10 months old) | OFFICIAL_DISTRIBUTION |
| `deepseek-ocr` | 3B | Token-efficient OCR | OFFICIAL_DISTRIBUTION |
| `glm-ocr` | — | Document understanding OCR | OFFICIAL_DISTRIBUTION |
| `moondream` | 1.8B | Small edge VLM | OFFICIAL_DISTRIBUTION |
| `llava` / `llava-llama3` / `llava-phi3` | 7B–34B | **OBSOLETE, 2 years old** | OFFICIAL_DISTRIBUTION |

---

### 4.17 Embeddings

| Pull name | Params | Note | Confidence |
|---|---|---|---|
| `nomic-embed-text` | — | 86.6M pulls, 2 years old, still the default | OFFICIAL_DISTRIBUTION |
| `nomic-embed-text-v2-moe` | — | Multilingual MoE, 9 months old | OFFICIAL_DISTRIBUTION |
| `embeddinggemma` | 300M | Google | OFFICIAL_DISTRIBUTION |
| `qwen3-embedding` | 0.6B–8B | | OFFICIAL_DISTRIBUTION |
| `bge-m3` | 567M | Multi-lingual/granularity | OFFICIAL_DISTRIBUTION |
| `mxbai-embed-large` | 335M | | OFFICIAL_DISTRIBUTION |
| `snowflake-arctic-embed2` | 568M | | OFFICIAL_DISTRIBUTION |

---

## 5. Ollama compatibility findings

**Verification method:** the full `https://ollama.com/library` listing was fetched, then individual model pages were fetched to confirm exact tag strings. **No pull name in this report was invented.**

### 5.1 Verified official library entries (confirmed by fetching the model page)

| Exact command | Artifact size | Context |
|---|---|---|
| `ollama pull gemma4:e2b` | 7.2GB | 128K |
| `ollama pull gemma4:e4b` | 9.6GB | 128K |
| `ollama pull gemma4:12b` | 7.6GB | 256K |
| `ollama pull gemma4:26b` | 19GB | 256K |
| `ollama pull gemma4:31b` | 20GB | 256K |
| `ollama pull qwen3.8:27b` | 18GB | 256K |
| `ollama pull qwen3.6:27b` | 18GB | 256K |
| `ollama pull qwen3.6:35b` | 23GB | 256K |
| `ollama pull qwen3.5:0.8b` | 1.0GB | 256K |
| `ollama pull qwen3.5:2b` | 2.7GB | 256K |
| `ollama pull qwen3.5:4b` | 3.4GB | 256K |
| `ollama pull qwen3.5:9b` | 6.6GB | 256K |
| `ollama pull qwen3.5:27b` | 17GB | 256K |
| `ollama pull qwen3.5:35b` | 24GB | 256K |
| `ollama pull qwen3.5:122b` | 81GB | 256K |
| `ollama pull gpt-oss:20b` | 14GB | 128K |
| `ollama pull gpt-oss:120b` | 65GB | 128K |
| `ollama pull muse-glimmer:30b` | 18GB | 128K |
| `ollama pull granite4.2:3b` | 2.2GB | 128K |
| `ollama pull granite4.2:8b` | 5.3GB | 128K |
| `ollama pull granite4.2:30b` | 18GB | 128K |
| `ollama pull lfm2.5:8b` | 5.2GB | 125K |
| `ollama pull nemotron-3.5-lightning:30b` | 25GB | 1M |

### 5.2 Official library entries seen in the listing but whose individual pages were NOT fetched

Tag strings for these are **NOT yet verified** — the base name is confirmed to exist, the `:tag` suffix is not. Do not hardcode a tag without fetching the page.

`deepseek-r1`, `deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-ocr`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-4.7-flash`, `glm-ocr`, `minimax-m3`, `minimax-m2.7`, `kimi-k3`, `kimi-k2.7-code`, `north-mini-code-1.0`, `ministral-3`, `devstral-small-2`, `devstral-2`, `mistral-large-3`, `mistral-medium-3.5`, `magistral`, `mistral-small3.2`, `ornith`, `ornith-1.5`, `laguna-xs-2.1`, `laguna-s-2.1`, `nemotron-3-nano`, `nemotron-3-super`, `nemotron-3-ultra`, `nemotron3`, `nemotron-cascade-2`, `granite4.1`, `minicpm-v4.5`, `minicpm-v4.6`, `qwen3-vl`, `qwen3-coder`, `qwen3-coder-next`, `qwen3.8-flash-next`, `lfm2`, `lfm2.5-thinking`, `olmo-3`, `olmo-3.1`, `phi4`, `phi4-mini`, `phi4-reasoning`, `phi4-mini-reasoning`, `medgemma`, `medgemma1.5`, `translategemma`, `embeddinggemma`, `functiongemma`, `gemma3`, `gemma3n`, `nomic-embed-text`, `nomic-embed-text-v2-moe`, `bge-m3`, `mxbai-embed-large`, `snowflake-arctic-embed2`, `qwen3-embedding`, `gpt-oss-safeguard`, `cogito-2.1`, `granite4.1-guardian`, `moondream`.

### 5.3 Models with NO Ollama support

- **Qwen3.8-2.4T-A95B** — flagship, HF only.
- **Phi-4-reasoning-vision-15B** — Microsoft's newest Phi is not in the Ollama library.
- **Intern-S1-Pro / Atria Dawn Preview / Agents-A1** (Shanghai AI Lab) — HF only.
- **Baichuan** — no presence at all.
- **Cohere Transcribe** — not an Ollama-shaped model.

### 5.4 Cross-cutting Ollama observations relevant to schema design

1. **Ollama now has "cloud" tags.** `gemma4:31b-cloud`, `gpt-oss:20b-cloud`, `qwen3.5:cloud`, `qwen3.5:397b-cloud`. These **are not local** despite living in the Ollama namespace. Docteur's catalog **must** distinguish these — a user clicking "install" on a `-cloud` tag expecting local/private inference would be a privacy regression given Docteur's local-first positioning.
2. **Ollama now has `-mlx` tags** (Apple Silicon MLX runtime) alongside GGUF. `qwen3.8:27b-mlx`, `muse-glimmer:30b-mlx`, `qwen3.6:35b-mlx`, `nemotron-3.5-lightning:30b-mlx`. These must not be offered on Windows. **Docteur runs on Windows 11**, so MLX tags should be filtered out entirely for this platform.
3. **Ollama library pages very often omit the license.** Of the 11 pages fetched, only `gpt-oss`, `muse-glimmer` and `granite4.2` stated one. License must come from the HF card, not Ollama.
4. **Ollama states artifact size in GB, not parameter count or quantization level.** The GB figure is the most reliable resource signal available and is the right basis for a disk/RAM estimate.

---

## 6. LM Studio research findings

**Research only — no implementation, per brief.**

**Source:** https://lmstudio.ai/docs/app/api (fetched) + corroborating search.

### What it exposes

| Aspect | Finding | Confidence |
|---|---|---|
| Default port | **`localhost:1234`** | OFFICIAL |
| OpenAI compatibility | Yes — chat, responses, embeddings, "other familiar OpenAI-style endpoints", drop-in replacement for OpenAI clients | OFFICIAL |
| **Anthropic compatibility** | **Yes** — "Claude-style Messages API flows against your local LM Studio server". This is notable and **not** something Ollama offers. | OFFICIAL |
| Native REST API | Yes, separate from the OpenAI shim: stateful chats, model management, streaming events | OFFICIAL |
| Model formats | **GGUF and MLX**. GGUF broadly compatible; MLX Apple-Silicon-only. | COMMUNITY_ESTIMATE (version-specific detail) |
| Engines bundled | llama.cpp + MLX | COMMUNITY_ESTIMATE |
| Model catalog | Pulled **directly from Hugging Face** — not a curated first-party list | COMMUNITY_ESTIMATE |
| CLI | `lms` — `lms server start --port N`, `lms get <model>`, `lms daemon up` | OFFICIAL |
| Headless mode | `lms daemon up`; a daemon (`llmster`) for server/cloud deployments | OFFICIAL / COMMUNITY_ESTIMATE |
| Platforms | macOS 14+ Apple Silicon, Windows, Linux | COMMUNITY_ESTIMATE (v0.4.23, Aug 2026) |
| Server default state | **Off.** User must toggle "Start server" in the Developer tab or run `lms server start`. | OFFICIAL |

### How detection would work

The docs **do not document a detection mechanism** (OFFICIAL — explicit absence). The practical approach would be a probe of `http://localhost:1234/v1/models` (OpenAI-shim list endpoint) with a short timeout, treating any 200 with a JSON model list as "LM Studio present". Caveats to design around:

- The port is **user-configurable**, so a fixed 1234 probe produces false negatives.
- The server is **off by default**, so a false negative is the common case even when LM Studio is installed. Docteur could not honestly report "LM Studio not installed" from a failed probe — only "LM Studio server not reachable".
- `localhost:1234` is a generic port; a 200 from something else is a possible false positive. Response shape should be validated, not just the status code.
- WebFetch cannot reach localhost, so this must be a backend HTTP call.

### Pros / cons vs Ollama for a future integration decision

**LM Studio advantages**
- Anthropic Messages API compatibility in addition to OpenAI — useful if Docteur ever standardizes on an Anthropic-shaped internal interface.
- MLX engine gives materially better Apple Silicon performance (irrelevant to Docteur's Windows target today, relevant if it ships on Mac).
- Direct Hugging Face catalog access means access to the full quant ecosystem, including community quants Ollama never packages — notably the abliterated/uncensored models in §8.
- Users who already have LM Studio have models on disk that Docteur could use with zero download.

**LM Studio disadvantages**
- **It is a GUI desktop app first.** Ollama is a background service by design; LM Studio's server is opt-in and off by default. For a local-first assistant that wants inference to "just work", this is the decisive drawback.
- No stable programmatic install/pull story equivalent to `ollama pull` — `lms get` exists but assumes the app is installed.
- Configurable port defeats reliable auto-detection.
- Catalog is HF-shaped (repo + quant file), not name-shaped (`model:tag`), so it will not deduplicate cleanly against Ollama entries without the canonical-id strategy in §14.
- Licensing of the LM Studio application itself: **UNKNOWN** — not investigated this session. Should be checked before bundling or deep integration.

**Assessment for Docteur:** LM Studio is best treated as an **optional secondary runtime detected opportunistically**, not a replacement for or peer of the Ollama integration. The canonical-id design in §14 is what makes that cheap to add later.

---

## 7. GGUF / llama.cpp ecosystem notes

- **GGUF remains the universal local quantization format.** Both Ollama and LM Studio run llama.cpp underneath; Qwen3.8-27B's official card explicitly names llama.cpp, Ollama, LM Studio and Jan as supported runtimes (OFFICIAL).
- **The quantization layer is what makes very large models locally viable at all.** Hugging Face's summer-2026 ecosystem review states the quantization layer — "particularly llama.cpp" — is what "enables trillion-parameter models to run locally, fundamentally changing deployment viability" (OFFICIAL, HF blog).
- **Scale of the community quant layer:** Qwen3.8-27B alone has **1,188 quantized derivative repos** on Hugging Face (OFFICIAL, from the model card). This is the core reason Docteur needs a canonical-id → many-distributions model (§14) rather than a flat list.
- **New wrinkle: native low-precision formats.** Two models in this report ship natively sub-8-bit from the vendor, not as a community afterthought:
  - `gpt-oss` — **MXFP4, 4.25 bits/parameter**, native (OFFICIAL).
  - `DeepSeek-V4-Flash` — **FP4 + FP8 mixed**, MoE experts in FP4 (OFFICIAL).
  This breaks the assumption that "Q4 = lossy community quant". A schema that models quantization as a lossy add-on will mis-describe these. Distinguish `native_precision` from `quantization`.
- **MLX is now a first-class parallel format**, visible directly in the Ollama library as `-mlx` tags. Apple Silicon only.
- **Typical GGUF quant ladder** (community convention, not a standard): Q2_K, Q3_K_S/M/L, Q4_K_S/M, Q5_K_S/M, Q6_K, Q8_0, plus `i1-`/imatrix variants. Docteur's existing `qwen2.5:14b-instruct-q3_K_M` and `mistral-nemo:12b-instruct-2407-q4_K_M` entries follow this. **Ollama does not expose the quant level for most modern tags** — the library pages give GB only — so parsing the quant out of the tag name will fail for the current generation.
- **Notable community quantizers** (for provenance tracking): `unsloth`, `mradermacher`, `bartowski`. `unsloth/North-Mini-Code-1.0` appeared in search results alongside the official CohereLabs repo, illustrating that mirrors and originals are easily confused.
- **RAM sizing rule of thumb:** artifact size + KV cache + runtime overhead. KV cache scales with context, which now routinely means 256K–1M. **A 1M-context model's KV cache can dwarf the weights.** Any Docteur resource estimate that ignores the configured context will be badly wrong for the 2026 generation. All such estimates in this report are DERIVED_ESTIMATE.

---

## 8. Community / unrestricted model findings

> **Kept deliberately separate from §4. These are NOT recommended as superior to official models, and this report takes no position on whether Docteur should surface them at all.**

### What "abliteration" actually is

A **weight-modification** technique that orthogonalizes the "refusal direction" out of the residual stream, removing refusal behavior without retraining. Pioneered by FailSpy, popularized by mlabonne (COMMUNITY_ESTIMATE — technique description from secondary sources).

### Notable examples found

| Model | Upstream | Author/repo | License | Confidence |
|---|---|---|---|---|
| `Qwen3.8-Flash-Next-Uncensored-GGUF` | Qwen3.8-Flash-Next | `orcarouter` (HF) | **UNKNOWN** | COMMUNITY_ESTIMATE |
| `Qwen3.8-27B-Uncensored-GGUF` | Qwen3.8-27B | `orcarouter` (reported) | **UNKNOWN** | COMMUNITY_ESTIMATE |
| `Huihui-GLM-5.1-abliterated-GGUF` | GLM-5.1 (744B MoE) | `huihui-ai` | **UNKNOWN** | COMMUNITY_ESTIMATE |
| Gemma 4 31B abliterated (~17GB Q4_K_M) | Gemma 4 31B | multiple, incl. "Heretic" variants | **UNKNOWN** | COMMUNITY_ESTIMATE |
| Qwen3-14B abliterated (~9GB Q4_K_M) | Qwen3-14B | multiple | **UNKNOWN** | COMMUNITY_ESTIMATE |
| Llama3.1-8B abliterated (~5.7GB Q5_K_M) | Llama 3.1 8B | multiple; reportedly most-pulled abliterated Llama on Ollama | **UNKNOWN** | COMMUNITY_ESTIMATE |

Official Ollama library does carry some legacy uncensored entries: `llama2-uncensored`, `wizardlm-uncensored:13b`, `wizard-vicuna-uncensored`, `dolphin-mixtral`, `dolphin-mistral`, `dolphin3:8b`, `dolphin-phi`, `everythinglm:13b` (OFFICIAL_DISTRIBUTION — these base names exist in the library). Most are 1–2 years old and built on obsolete bases.

### Trust caveats — all material

1. **License provenance is broken.** Abliterated derivatives inherit the upstream license, but the derivative repos frequently do not state it. An "uncensored Qwen3.8-27B" inherits Apache 2.0; an "uncensored Kimi K3" inherits Kimi's revenue-gated custom license. **Docteur cannot assume a derivative is as permissive as it looks.** License for every model in the table above is UNKNOWN.
2. **No supply-chain guarantee.** These are arbitrary weights from unvetted uploaders. Nothing verifies that the only modification was refusal removal.
3. **Capability regression is real and undocumented.** Abliteration degrades general capability to an amount nobody publishes per-model.
4. **Naming is not evidence.** "Uncensored" in a repo name is a marketing claim, not a verified property.
5. **`orcarouter` appeared as both a model publisher and a blog publisher** in search results (`huggingface.co/orcarouter/...` and `orcarouter.ai/blog/...`), which is self-promotional content — weak corroboration, not independent.

### Recommendation

If Docteur surfaces these at all, treat them as a distinct `provenance: "community_modified"` class, never mixed into default/recommended lists, with license displayed as explicitly UNKNOWN rather than inherited-by-assumption.

---

## 9. Models requiring remote code

**Finding: none of the models researched this session were documented as requiring `trust_remote_code=true`.**

| Model | trust_remote_code | Basis |
|---|---|---|
| Qwen3.8-27B | Not required — "standard Transformers library integration" | OFFICIAL (explicit) |
| DeepSeek-V4-Flash | Not mentioned as required | OFFICIAL (explicit absence from card) |
| Muse Glimmer 30B | Not mentioned | UNKNOWN |
| Gemma 4 (all) | Not mentioned | UNKNOWN |
| gpt-oss 20b/120b | Not required (first-class llama.cpp/Ollama support implies native arch support) | INFERRED |
| GLM-5.x | UNKNOWN | UNKNOWN |
| MiniMax M3 | UNKNOWN | UNKNOWN |
| Kimi K3 | UNKNOWN | UNKNOWN |
| Nemotron 3.5 Lightning | UNKNOWN | UNKNOWN |
| LFM2.5 | UNKNOWN | UNKNOWN |

**Important scoping note.** `trust_remote_code` is a **Hugging Face Transformers** concern. It is **structurally not applicable to the Ollama path**, which consumes converted GGUF and never executes Python from the model repo. Since Docteur's integration is Ollama-based, this field is currently informational only. It becomes load-bearing **only** if Docteur ever adds a direct-Transformers or direct-HF loading path.

Absence of evidence here is weak evidence of absence — the field simply isn't prominent on modern cards. Treat all UNKNOWNs as genuinely unknown.

---

## 10. Licensing summary table

| Model / family | License | Commercial use | Confidence |
|---|---|---|---|
| **Gemma 4** (all variants) | **Apache 2.0** | Unrestricted — explicitly no MAU cap, no AUP enforcement | OFFICIAL |
| **Qwen3.8-27B** | **Apache 2.0** | Unrestricted | OFFICIAL |
| **Qwen3.8-2.4T-A95B** | Custom "Qwen3.8-Max License" | Free for most; UI attribution >100M MAU / >$20M monthly rev; separate license for MaaS >$50M/12mo | COMMUNITY_ESTIMATE |
| **Qwen3.5 / Qwen3.6** | **UNKNOWN** | — | UNKNOWN |
| **gpt-oss 20b/120b** | **Apache 2.0** | Unrestricted | OFFICIAL |
| **Mistral Large 3** | **Apache 2.0** | Unrestricted | OFFICIAL |
| **Ministral 3 (3B/8B/14B)** | **Apache 2.0** | Unrestricted | OFFICIAL |
| **DeepSeek-V4-Flash** | **MIT** | Unrestricted | OFFICIAL |
| **DeepSeek-V4-Pro** | MIT | Unrestricted | COMMUNITY_ESTIMATE |
| **Meta Muse Glimmer 30B** | **Apache 2.0** | Unrestricted | OFFICIAL |
| **GLM-5 / 5.1 / 5.2 / 5.3 / 5.3-Flash** | **Apache 2.0** | Unrestricted | OFFICIAL (repo-level) |
| **Cohere North-Mini-Code-1.0** | Apache 2.0 **+ Cohere Labs Acceptable Use Policy** | Permissive but AUP-bound — **not plain Apache in practice** | COMMUNITY_ESTIMATE |
| **IBM Granite 4.2** | **Apache 2.0** | Unrestricted | OFFICIAL_DISTRIBUTION |
| **Kimi K3** | Custom "Kimi K3 License" | Revenue-gated: separate agreement for MaaS >$20M/12mo; UI attribution >100M MAU / >$20M monthly | COMMUNITY_ESTIMATE |
| **MiniMax M3** | Custom `minimax-community` | Restrictions UNKNOWN | COMMUNITY_ESTIMATE |
| **Phi-4 family** | MIT | Unrestricted | COMMUNITY_ESTIMATE |
| **Nemotron (all)** | **UNKNOWN** — likely NVIDIA Open Model License, not Apache/MIT | — | UNKNOWN |
| **LFM2.5** | **UNKNOWN** — Liquid AI historically custom | — | UNKNOWN |
| **Laguna (Poolside)** | **UNKNOWN** | — | UNKNOWN |
| **Ornith-1.5** | MIT | Unrestricted | COMMUNITY_ESTIMATE |
| **Cohere Command-R / R+ / A** | **UNKNOWN** — historically CC-BY-NC (non-commercial) | Verify individually | UNKNOWN |
| **Gemma 2 / Gemma 3** | Custom Gemma Terms of Use (restrictive) | Verify | COMMUNITY_ESTIMATE |
| **Llama 3.x / 4** | Llama Community License (custom, MAU-conditioned) | Verify | COMMUNITY_ESTIMATE |
| **All abliterated/uncensored derivatives** | **UNKNOWN** | Do not assume inheritance | UNKNOWN |

### The licensing trend that matters most

Hugging Face's summer-2026 review documents a **bifurcation** (OFFICIAL):

- Chinese releases **above 20B**: 59% Apache 2.0, 22% MIT — genuinely permissive at the mid-size range Docteur cares about.
- American labs: only **29%** Apache/MIT; **41% custom terms**.
- **But the largest frontier models are moving the other way.** Qwen3.8-Max and Kimi K3 both added revenue-share / separate-agreement clauses to previously permissive lineages.

**Practical implication for Docteur:** the sweet spot for *both* local viability and clean licensing is the **3B–35B tier**, which is overwhelmingly Apache 2.0 / MIT. The restrictive licenses cluster at 600B+ — sizes Docteur cannot run locally anyway. This is a fortunate alignment.

---

## 11. Shortlists

> **Unordered. Not ranked. Not "best."** Inclusion means "plausible candidate worth evaluating", nothing more. All memory figures are DERIVED_ESTIMATE from verified Ollama artifact sizes unless marked OFFICIAL_REQUIREMENT. Real usage will exceed these at long context (§7).

### LOW_RESOURCE (roughly ≤8GB artifact)

| Model | Pull | Artifact | Why |
|---|---|---|---|
| Qwen3.5 0.8B | `qwen3.5:0.8b` | 1.0GB | Smallest verified modern entry, 256K ctx, vision |
| Qwen3.5 2B | `qwen3.5:2b` | 2.7GB | |
| Qwen3.5 4B | `qwen3.5:4b` | 3.4GB | |
| Granite 4.2 3B | `granite4.2:3b` | 2.2GB | Apache 2.0 confirmed, tool calling, thinking mode |
| Qwen3.5 9B | `qwen3.5:9b` | 6.6GB | |
| Gemma 4 E2B | `gemma4:e2b` | 7.2GB | Apache 2.0, text+image+**audio**, built for edge |
| Granite 4.2 8B | `granite4.2:8b` | 5.3GB | Apache 2.0 confirmed |
| LFM2.5 8B | `lfm2.5:8b` | 5.2GB | Purpose-built for on-device function calling; license UNKNOWN |
| Gemma 4 12B | `gemma4:12b` | 7.6GB | Unusually small artifact for 12B; 256K ctx; audio |

### BALANCED (roughly 9–20GB)

| Model | Pull | Artifact | Why |
|---|---|---|---|
| Gemma 4 E4B | `gemma4:e4b` | 9.6GB | Apache 2.0, audio+vision |
| gpt-oss 20B | `gpt-oss:20b` | 14GB | **OFFICIAL_REQUIREMENT: 16GB**. Apache 2.0. Rare case of a vendor-stated figure. |
| Qwen3.5 27B | `qwen3.5:27b` | 17GB | |
| Qwen3.8 27B | `qwen3.8:27b` | 18GB | Apache 2.0 OFFICIAL, 262K→1M ctx, vision+video |
| Gemma 4 26B MoE | `gemma4:26b` | 19GB | 25.2B total / **3.8B active** — MoE efficiency at mid-size |
| Gemma 4 31B | `gemma4:31b` | 20GB | Apache 2.0, dense, strongest Gemma 4 |
| Muse Glimmer 30B | `muse-glimmer:30b` | 18GB | Apache 2.0, **OFFICIAL_REQUIREMENT: 24–32GB VRAM at 4-bit** |
| Granite 4.2 30B | `granite4.2:30b` | 18GB | Apache 2.0 confirmed |
| Qwen3.6 27B | `qwen3.6:27b` | 18GB | License UNKNOWN |

### POWERFUL (locally runnable only on high-end hardware)

| Model | Pull | Artifact | Why |
|---|---|---|---|
| Qwen3.6 35B | `qwen3.6:35b` | 23GB | |
| Qwen3.5 35B | `qwen3.5:35b` | 24GB | |
| Nemotron 3.5 Lightning | `nemotron-3.5-lightning:30b` | 25GB | 30B/**3B active**, **1M context**; license UNKNOWN |
| gpt-oss 120B | `gpt-oss:120b` | 65GB | **OFFICIAL_REQUIREMENT: single 80GB GPU.** Not consumer hardware. |
| Qwen3.5 122B | `qwen3.5:122b` | 81GB | Workstation/server class |
| Muse Glimmer 30B (BF16) | — | — | **OFFICIAL_REQUIREMENT: 64GB VRAM** full precision |

*Deliberately excluded as not locally runnable:* Qwen3.8-Max (2.4T), Kimi K3 (2.8T), DeepSeek V4-Pro (1.6T), GLM-5.x (744B), MiniMax M3 (428B), Mistral Large 3 (675B).

### CODING

| Model | Pull | Notes |
|---|---|---|
| Cohere North Mini Code | `north-mini-code-1.0` | 30B/3B active, Apache 2.0 + AUP, 256K in / 64K out |
| Qwen3 Coder Next | `qwen3-coder-next` | Agentic coding; tag UNVERIFIED |
| Qwen3 Coder | `qwen3-coder` | 30B, 480B sizes |
| Devstral Small 2 | `devstral-small-2` | 24B; "fits a single RTX 4090" (COMMUNITY_ESTIMATE) |
| Qwen3.8 27B | `qwen3.8:27b` | Card leads with coding + software engineering |
| Qwen3.6 27B | `qwen3.6:27b` | "flagship-level coding in a 27B dense model" |
| Ornith 9B / 35B | `ornith` | MIT (COMMUNITY_ESTIMATE); Terminal-Bench focused |
| Laguna XS 2.1 | `laguna-xs-2.1` | 33B/3B active agentic coding; license UNKNOWN |
| Muse Glimmer 30B | `muse-glimmer:30b` | Agentic + tool use + failure recovery |

### REASONING

| Model | Pull | Notes |
|---|---|---|
| gpt-oss 20B | `gpt-oss:20b` | Configurable reasoning effort, Apache 2.0, 16GB stated |
| Qwen3.8 27B | `qwen3.8:27b` | `reasoning_effort` control, OFFICIAL |
| Gemma 4 31B | `gemma4:31b` | Configurable thinking via `<|think|>` |
| Gemma 4 26B MoE | `gemma4:26b` | Same thinking control, cheaper active compute |
| Granite 4.2 (3B/8B/30B) | `granite4.2:*` | `/set think high` effort levels, Apache 2.0 |
| Magistral | `magistral` | 24B, Mistral's reasoning model, Apache 2.0 |
| DeepSeek R1 (distills) | `deepseek-r1` | 1.5B–671B; the small distills remain the accessible option |
| Nemotron 3.5 Lightning | `nemotron-3.5-lightning:30b` | `thinking` capability tag |
| Phi-4 Reasoning | `phi4-reasoning` | 14B; family is aging |

### MULTIMODAL

| Model | Pull | Modalities |
|---|---|---|
| Gemma 4 E2B | `gemma4:e2b` | text + image + **audio** — only family here with audio at this size |
| Gemma 4 E4B | `gemma4:e4b` | text + image + **audio** |
| Gemma 4 12B | `gemma4:12b` | text + image + **audio** |
| Qwen3.8 27B | `qwen3.8:27b` | text + image + **video** (hour-scale), OFFICIAL |
| Qwen3.5 (0.8B–122B) | `qwen3.5:*` | text + image across the whole ladder |
| Muse Glimmer 30B | `muse-glimmer:30b` | text + image (ViT-G/14) |
| MiniCPM-V 4.5 | `minicpm-v4.5` | 8B, multi-image + video |
| MiniCPM-V 4.6 | `minicpm-v4.6` | 1B, phone-class |
| Qwen3-VL | `qwen3-vl` | 2B–235B |
| DeepSeek OCR | `deepseek-ocr` | 3B, narrow OCR |

---

## 12. Free LLM API provider findings

### 12.1 The catalog Docteur already consumes

`https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/providers.json` — **fetched successfully.** v2.9.0, generated **2026-08-14**, 80+ providers, with per-provider `verified` dates. It is well-structured and current. **Recommendation: keep using it as the primary source**, but see the critical caveat in §12.4.

### 12.2 Verified against official first-party documentation

#### Groq — https://console.groq.com/docs/rate-limits (fetched 2026-09-21)

**The free tier has tightened substantially and the hub's data is now stale on this point.**

| Model | RPM | RPD | TPM | TPD |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | 30 | **1K** | 8K | 200K |
| `openai/gpt-oss-20b` | 30 | **1K** | 8K | 200K |
| `openai/gpt-oss-safeguard-20b` | 30 | 1K | 8K | 200K |
| `qwen/qwen3.8-27b` | 30 | **1K** | 8K | 200K |
| `whisper-large-v3` | 20 | 2K | — | — |
| `whisper-large-v3-turbo` | 20 | 2K | — | — |
| `meta-llama/llama-prompt-guard-2-*` | 30 | 14.4K | 15K | 500K |
| `canopylabs/orpheus-*` | 10 | 100 | 1.2K | 3.6K |

- **The free-llm-api-hub entry (verified 2026-08-02) lists "30 RPM / 14.4K RPD / 12K TPM" and models `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`. Neither the limits nor the model list match Groq's own current docs.** The 14.4K RPD now applies only to tiny prompt-guard classifiers. Real chat models are at **1K RPD / 200K TPD**.
- Groq's current free chat lineup is **gpt-oss + Qwen3.8-27B** — the Llama models are gone from the free rate-limit table.
- Auth: API key from console.groq.com/keys, email only. Phone verification reported (COMMUNITY_ESTIMATE). No card.
- Adding a card (zero minimum spend) reportedly unlocks ~10× limits (COMMUNITY_ESTIMATE).
- **Reputation: strong.** Lowest-latency inference, first-party docs are clear and current. **Recommended.**

#### OpenRouter — https://openrouter.ai/docs/api-reference/limits (fetched 2026-09-21)

| Limit | Value |
|---|---|
| RPM (all `:free` models) | **20** |
| RPD, <$10 lifetime credits purchased | **50** |
| RPD, ≥$10 lifetime credits purchased | **1,000** |

- Free models identified by an ID ending in `:free` (OFFICIAL).
- **Limits are governed globally per account, not per key** — extra accounts/keys explicitly do not help (OFFICIAL).
- Quota is introspectable at `GET /api/v1/key` → `free_model_daily_requests` (used / limit / remaining, UTC day) (OFFICIAL). **This is the single most integration-friendly feature found in this research** — Docteur could show a live remaining-quota indicator without guessing.
- Free model set rotates (~14 models per the hub, 2026-08-02).
- **Reputation: strong.** Excellent docs, honest limits, no card required for the 50/day tier. **Recommended.**

#### Google Gemini / AI Studio — https://ai.google.dev/gemini-api/docs/rate-limits (fetched 2026-09-21)

- **The official rate-limits page no longer publishes concrete free-tier numbers.** It states limits "depend on a variety of factors (such as your usage tier) and can be viewed in Google AI Studio", directing users to https://aistudio.google.com/rate-limit (OFFICIAL).
- Confirmed: Free tier qualifies with an "active project or free trial"; no spend-based limits; no billing-tier cap; "rate limits are more restricted for experimental and preview models" (OFFICIAL).
- The hub (verified 2026-08-02) reports 5–30 RPM, 15–1,000 RPD across gemini-2.5-flash / flash-lite / pro, no phone or card — COMMUNITY_ESTIMATE, and **not currently confirmable from Google's own docs**.
- The hub calls it "the only frontier-class model with a genuine free tier". That characterization looks defensible.
- **Caveat not resolvable this session:** Google has historically used free-tier data for model improvement. The rate-limits page does not address data usage. **UNKNOWN — must be checked against the Gemini API terms before Docteur routes any user data here**, which matters given Docteur's local-first privacy positioning.
- **Reputation: strong, but numbers are no longer statically documented** — meaning any hardcoded limit in Docteur will silently drift.

### 12.3 Providers characterized from secondary sources

| Provider | Free tier | Auth | Verified | Confidence |
|---|---|---|---|---|
| **Cerebras** | Conflicting. Hub (2026-08-02): 5 RPM / 30K TPM / 1M TPD, **payment method required**, **expires 30 days**. Search: "1M tokens/day, no credit card", 8,192-token context cap. **These directly contradict.** | Disputed | 2026-08-02 | **LOW — resolve before use** |
| **Cloudflare Workers AI** | **10,000 Neurons/day**, resets 00:00 UTC, ongoing (not a one-time credit). Beyond: $0.011/1K Neurons. ~30–80 models (Llama, Mistral, Qwen, Gemma, GPT-OSS, DeepSeek-R1 distills, FLUX, Whisper, BGE). | No phone/card | 2026-08-02 | COMMUNITY_ESTIMATE |
| **Z.ai (Zhipu/GLM)** | `glm-4.7-flash`, `glm-4.5-flash`, `glm-4.6v-flash`. Permanent $0, commercial use permitted. Concrete RPM/TPM **not specified**. | No phone/card | 2026-08-13 | COMMUNITY_ESTIMATE |
| **SiliconFlow** | 1,000–10,000 RPM, 50K–5M TPM. Unusually high. | **SMS phone verification** | 2026-08-13 | COMMUNITY_ESTIMATE |
| **Vercel AI Gateway** | **$5/month recurring credit**, ~50 models | No card | 2026-08-14 | COMMUNITY_ESTIMATE |
| **AI Horde** | Crowdsourced volunteer compute, kudos-priority queue, no fixed quota. Anonymous key `0000000000`. | Optional | 2026-08-14 | COMMUNITY_ESTIMATE |
| **Novita AI** | $100 sandbox credits, 90 days | No card | 2026-08-10 | COMMUNITY_ESTIMATE |
| **Nebius** | $1 trial, 30 days | **Bank card** | 2026-08-13 | COMMUNITY_ESTIMATE |
| **AI21 Labs** | $10 trial, 3 months | No card for trial | 2026-08-03 | COMMUNITY_ESTIMATE |
| **Together AI** | **Free trial credits retired (July 2025).** Now requires $5 minimum purchase. Startup program up to $50K separately. | Card | 2026-09 | COMMUNITY_ESTIMATE |
| **HuggingFace Inference** | **$0.10/month credit** — effectively a token amount, not a usable free tier. PRO ($9/mo) = 2M credits. | Account | 2026-09 | COMMUNITY_ESTIMATE |
| **Cohere** | 1K API calls/month, **trial key, evaluation only** — not for production | Account | 2026-08 | COMMUNITY_ESTIMATE |
| **ModelScope** | ~2K calls/day, **non-commercial** | Alibaba account + **real-name verification** | 2026-08-14 | COMMUNITY_ESTIMATE |
| **Tencent Hunyuan** | 1M tokens, 1 year | **Mainland-China real-name ID** — practical blocker for most users | 2026-08-14 | COMMUNITY_ESTIMATE |

### 12.4 ⚠ Provider that no longer exists — GitHub Models

**GitHub Models was fully retired on 2026-07-30.** Confirmed via GitHub's own changelog:

- https://github.blog/changelog/2026-06-16-github-models-is-no-longer-available-to-new-customers/
- https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/
- https://github.blog/changelog/2026-07-30-github-models-is-now-retired/

(OFFICIAL.) The playground, model catalog, inference API and BYOK are all gone, for existing customers too. Brownouts ran 2026-07-16 and 2026-07-23. Migration path: Microsoft Foundry or GitHub Copilot.

**Direct action item for Docteur:** the Free AI Finder must not surface GitHub Models. An aggregator issue was found (`robhunter/agentdeals` issue #1672) complaining that a competing list still recommends GitHub Models with rate limits ~2 months after retirement. **Dead providers persist in these catalogs.** Docteur should not treat catalog presence as proof of liveness.

### 12.5 Summary judgement

**Most solid for Docteur (official docs, no card, clear limits):**
- **OpenRouter** — best integration story by a wide margin, thanks to the programmatic quota endpoint.
- **Groq** — excellent latency, official current limits, but **much tighter than the hub reports** (1K RPD, not 14.4K).
- **Google Gemini** — best model quality free; limits no longer statically documented; **data-usage policy UNKNOWN and worth checking given Docteur's privacy stance**.
- **Cloudflare Workers AI** — highest sustained daily volume for a real side project.

**Risky / needs care:**
- **Cerebras** — sources directly contradict on whether a card is required and whether it expires after 30 days. **Do not present as "free, no card" without first-party verification.**
- **Tencent Hunyuan, ModelScope** — identity-verification requirements make them unusable for most Docteur users.
- **Cohere, ElevenLabs, Mistral free tiers** — evaluation-only; using them in a shipped product may breach terms.
- **AI Horde** — genuinely free but crowdsourced; unpredictable latency and **third parties process the prompts**, which conflicts with a local-first privacy promise.
- **Anything labelled "trial credits"** (Nebius, Novita, AI21) — these expire and will produce broken-feature reports from users. Model them as a distinct type, not as "free tier".

**Never claim "free unlimited" for any provider in this report.** None of the verified sources support that.

---

## 13. Proposed `ModelCatalogEntry` schema (design only)

Design notes, not code. Driven by the specific failure modes this research exposed.

### Core principle

**Separate the *model* (an abstract thing with a license and a parameter count) from the *distribution* (a concrete runnable artifact with a pull name and a byte size).** One model has many distributions. This is forced by real data: Qwen3.8-27B is one model but is a `qwen3.8:27b` Ollama tag, a `qwen3.8:27b-mlx` MLX tag, an official HF repo, and ~1,188 community quant repos.

### `ModelCatalogEntry` (the model)

**Identity**
- `canonicalId` — stable, runtime-independent, our own namespace (e.g. `qwen/qwen3.8-27b`). Never a pull name.
- `displayName`, `family` (e.g. `qwen`), `generation` (e.g. `3.8`), `developer`

**Provenance**
- `officialUrl`, `huggingFaceUrl`, `githubUrl`
- `provenance`: `official` | `community_modified` | `community_quant` — §8 requires this to be first-class
- `upstreamCanonicalId` — for derivatives, points at what they were modified from

**Lifecycle**
- `releaseDate` + **`releaseDateConfidence`** — mandatory pairing. The Gemma 4 April-vs-July conflict between two Google sources makes a bare date field actively misleading.
- `status`: `current` | `superseded` | `obsolete` | `unknown`
- `supersededBy` — `canonicalId` of the successor

**Licensing**
- `licenseId` — SPDX where applicable (`Apache-2.0`, `MIT`), else `custom`
- `licenseName` — e.g. "Qwen3.8-Max License", "Kimi K3 License"
- `licenseUrl`
- `additionalPolicies[]` — **required.** Cohere North Mini Code is "Apache 2.0 + Acceptable Use Policy"; collapsing that to `Apache-2.0` misrepresents it.
- `commercialUse`: `unrestricted` | `conditional` | `non_commercial` | `unknown`
- `commercialConditions` — free text, e.g. revenue thresholds, MAU attribution triggers
- `licenseConfidence`

**Architecture**
- `architecture`: `dense` | `moe` | `unknown`
- `totalParams` (nullable), `activeParams` (nullable) — **must be independently nullable.** Ollama states neither for most tags; Gemma 4 states both; Qwen3.5 states neither.
- `paramsConfidence`
- `effectiveParams` — Gemma 4 distinguishes "2.3B effective / 5.1B with embeddings". Do not conflate.
- `moeExpertsTotal`, `moeExpertsActive` — Gemma 4 (8/128) and North Mini Code (8/128) both publish these

**Context & modality**
- `contextNative`, `contextExtended` (Qwen3.8-27B: 262,144 native → 1,000,000 extended)
- `inputModalities[]`: text | image | video | audio · `outputModalities[]`
- Do **not** use a single `multimodal` boolean. Gemma 4's audio support varies *within* the family (E2B/E4B/12B yes, 26B/31B no).

**Capabilities**
- `capabilities[]`: `reasoning` | `coding` | `tool_calling` | `vision` | `agentic` | `multilingual` | `embedding` | `ocr`
- `reasoningControl` — how thinking is toggled, and it is **not standardized**: Qwen `reasoning_effort`, Gemma `<|think|>`, Granite `/set think high`
- `languageCount`

**Requirements**
- `memoryRequirement` — `{ valueGb, basis: 'official' | 'derived' | 'community' | 'unknown', sourceUrl, atQuantization, atContext }`. **A bare number is not acceptable.** Only gpt-oss and Muse Glimmer have vendor-stated figures; everything else is derived.
- `requiresTrustRemoteCode`: `true` | `false` | `unknown` | `not_applicable` — `not_applicable` is the correct value on the Ollama path (§9)

### `ModelDistribution` (the runnable artifact)

- `distributionId`, `canonicalId` (FK)
- `runtime`: `ollama` | `lmstudio` | `llamacpp` | `mlx` | `transformers`
- `pullName` — the exact verified string, e.g. `qwen3.8:27b`
- `pullNameVerified` (bool) + `pullNameVerifiedAt` — §5.2 exists because many names are listing-level only
- `artifactSizeBytes` — the Ollama GB figure; the most reliable resource signal available
- `quantization` — e.g. `Q4_K_M`, or null (Ollama does not expose it for modern tags)
- `nativePrecision` — `MXFP4`, `FP4+FP8`, `BF16`, `FP8`. **Distinct from `quantization`** — gpt-oss and DeepSeek V4 ship natively sub-8-bit from the vendor (§7)
- **`executionLocation`: `local` | `cloud`** — **non-negotiable.** `gemma4:31b-cloud` and `gpt-oss:20b-cloud` live in the Ollama namespace but are remote. Mislabeling one as local is a privacy bug in a local-first product.
- `platforms[]` — `windows` | `macos` | `linux`; MLX tags are macOS-only and must be filtered on Docteur's Windows target
- `configuredContext` — Ollama's configured context, which can differ from the model's native max (nemotron-3.5-lightning: 1M standard vs 256K MLX)

### Cross-cutting rule

**Every factual field should carry, or inherit, a confidence tag and a source URL.** This research produced far more UNKNOWNs than hard facts. A schema that cannot represent "we don't know" will get filled with guesses.

---

## 14. Canonical model / distribution deduplication strategy

### The problem, concretely

Qwen3.8-27B appears as: `qwen3.8:latest`, `qwen3.8:27b`, `qwen3.8:27b-mlx`, `Qwen/Qwen3.8-27B` (HF), ~1,188 community quant repos, and `qwen/qwen3.8-27b` on Groq's API. A flat list shows the user six "different models" that are one model.

### Proposed approach

**1. One `canonicalId` per (model, size) pair, in our own namespace.**
Format: `<developer>/<family><generation>-<size>` → `qwen/qwen3.8-27b`, `google/gemma4-26b-a4b`, `meta/muse-glimmer-30b`.
Never derive it from a pull name — pull names are runtime-specific and change.

**2. Size variants are separate canonical entries, not one entry with a size list.**
`gemma4:e2b` and `gemma4:31b` differ in modality (audio vs not), context (128K vs 256K), architecture and memory. They are not variants of one thing.

**3. `latest` is an alias, never a canonical entry.**
Resolve `qwen3.8:latest` → `qwen3.8:27b`. Store the alias, surface the resolved tag. `latest` silently changes meaning over time.

**4. `-mlx` and `-cloud` are distributions of the same canonical model, not separate models.**
`qwen3.8:27b` and `qwen3.8:27b-mlx` share `canonicalId` and differ by `runtime`/`platforms`. `gemma4:31b` and `gemma4:31b-cloud` share `canonicalId` and differ by `executionLocation`. This keeps the UI honest: one model card, with a clear indicator of where it runs.

**5. Community quants attach to the canonical model, never replace it.**
A `bartowski/Qwen3.8-27B-GGUF` repo is a distribution with `provenance: community_quant` pointing at `qwen/qwen3.8-27b`. It inherits the model's license.

**6. Abliterated/modified models get their OWN canonicalId with an `upstreamCanonicalId` link.**
These are genuinely different models — weights were altered, capability changed, license provenance is broken (§8). `community/qwen3.8-27b-abliterated` with `upstream: qwen/qwen3.8-27b`, `provenance: community_modified`, `licenseConfidence: unknown`. **Never merge into the official entry.**

**7. Cross-runtime dedup is by `canonicalId`.**
If LM Studio is added later, its HF-repo-shaped models map to the same `canonicalId` as the Ollama tags. The user sees one Qwen3.8-27B with two ways to run it. **This is the main reason to build the canonical layer now** rather than after an LM Studio integration forces it.

**8. Free API providers reuse the same `canonicalId` space where models overlap.**
Groq serves `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` — both also locally installable. Mapping remote endpoints onto the same canonical ids lets Docteur present "run locally or via Groq free tier" as one choice. This is a real UX opportunity created by the overlap.

**9. Matching heuristic for ingestion, in priority order.**
(a) exact known-alias table (hand-maintained, authoritative) → (b) normalized name match (lowercase, strip `:latest`/`-mlx`/`-cloud`/`-instruct`/`-fp8`, normalize separators) → (c) HF repo id match → (d) **leave unmatched and flag for review**. Never auto-merge on fuzzy similarity — `qwen3.5:27b`, `qwen3.6:27b` and `qwen3.8:27b` are three distinct models that fuzzy-match strongly.

**10. Staleness is a first-class field.**
Every entry carries `lastVerifiedAt`. §3 shows a catalog can go comprehensively obsolete in roughly a year; §12.4 shows a provider can vanish entirely while aggregators still list it. Entries past a staleness threshold should be visibly marked, not silently trusted.

---

## 15. Known limitations / what remains unverified

**Honest accounting of this report's weaknesses.**

### Confirmed contradictions I could not resolve

1. **Gemma 4 release date.** The official model card (https://ai.google.dev/gemma/docs/core/model_card_4) says **July 30, 2026**. The official Google blog (https://blog.google/.../gemma-4/) says **April 2, 2026**. Both Tier 1 Google sources. Unresolved. Possibly launch date vs card revision, possibly a refreshed checkpoint.
2. **Gemma 4 variant list.** The blog describes four variants (E2B, E4B, 26B MoE, 31B Dense); the model card and Ollama both show **five**, including a 12B Unified. The 12B is probably a later addition. Searches also surfaced a "gemma-4-31b" on Cerebras, consistent with the 31B.
3. **Cerebras free tier.** free-llm-api-hub (2026-08-02) says payment method required, expires 30 days. Search results say 1M tokens/day, no credit card, renews daily. **These cannot both be true.** Not resolved against Cerebras's own docs.

### Known-bad third-party information encountered

4. **Phi-5 does not exist** but is described in detail — with specific VRAM figures — by at least one third-party "deployment guide". Absent from Microsoft's HF org. A clean example of fabricated SEO content in this space. Any future automated catalog ingestion **must** prefer first-party sources or it will ingest models that were never released.
5. **GitHub Models is still recommended by aggregator lists** ~2 months after its 2026-07-30 retirement.

### Significant gaps

6. **qwen.ai is unfetchable** (client-side rendered; returns only "Qwen"). Qwen release dates and per-model licenses for Qwen3.5 and Qwen3.6 are consequently **UNKNOWN**. This is a notable hole — Qwen3.5 provides the best small-model size ladder in the entire report and **its license is unverified.**
7. **~60 Ollama pull names in §5.2 are listing-level only.** Base names confirmed; `:tag` suffixes not. Must be page-verified individually before hardcoding.
8. **Active-parameter counts are missing for most MoE models.** Ollama almost never states them. Confirmed only for Gemma 4 26B (25.2B/3.8B), DeepSeek V4-Flash (284B/13B), GLM-5.x (744B/40B, 320B/18B), Nemotron 3.5 Lightning (30B/3B), Mistral Large 3 (675B/41B). **Even gpt-oss's active-param count is UNKNOWN at Tier 1.**
9. **Memory requirements are almost entirely absent from official sources.** Only gpt-oss ("within 16GB" / "single 80GB GPU") and Muse Glimmer ("64GB BF16 / 24–32GB 4-bit") publish figures. Every other number in this report is DERIVED_ESTIMATE from artifact size and **should not be shown to users as fact**.
10. **Context-length impact on memory is entirely unquantified.** With 256K–1M contexts now routine, KV cache may exceed weight size. No source gave a formula. §11's estimates will understate real usage at long context, possibly severely.
11. **Licenses unverified for:** Qwen3.5, Qwen3.6, all Nemotron, LFM2.5, Laguna, Ollama's `command-r*` entries, and every community/abliterated model in §8.
12. **Custom-license terms were read from secondary sources only** for Qwen3.8-Max, Kimi K3 and MiniMax M3. The revenue thresholds quoted ($20M, $50M, 100M MAU) are COMMUNITY_ESTIMATE. **Do not rely on them for any legal or product decision without reading the actual license files.**
13. **MiniMax M3, Kimi K3, GLM-5.3 and Cohere North Mini Code model cards were not fetched directly** — characterized from search plus, for GLM, the official GitHub repo.
14. **Google Gemini free-tier data-usage policy: UNKNOWN.** Not addressed on the rate-limits page. Given Docteur's local-first privacy positioning, this should be resolved before routing user data to Gemini's free tier.
15. **Benchmark claims were deliberately not collected.** Every "outperforms X" claim encountered came from vendor marketing or SEO content. None is in this report, and none should enter the catalog.
16. **The LM Studio application's own license was not investigated.**
17. **No model was actually downloaded or run.** Nothing here is empirically measured. Every figure is a published claim.

### Structural caveat

18. **This space moves fast enough to invalidate this report quickly.** Between Docteur's 11-model list and today, essentially every family turned over. Qwen shipped 3.5, 3.6, 3.7 and 3.8 within roughly a year. **The implementation should fetch and verify at runtime rather than embedding this report's contents as a static list** — and the `lastVerifiedAt` field in §13 exists specifically to make that staleness visible.
