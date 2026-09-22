# DOCTEUR — MISTRAL API / QUOTA / BUDGET AUDIT

Research date: 2026-09-21
Scope: audit-only, per mission "PHASE 6 — MISTRAL API / QUOTA / BUDGET AUDIT". No code produced, no API key added, no paid API call made, no Pay-As-You-Go activation, no payment method change, no spending-limit change. This report contains no API key, secret, or sensitive account identifier.

---

## 1. Docteur provider architecture (audited before any Mistral-specific work)

### Registration is mechanical but not centralized
There is no single "register a provider" entry point in Docteur. Adding any new cloud provider — Mistral included — requires manual, consistent edits in **five separate places**, each already demonstrated by how Groq/OpenRouter/Gemini/Anthropic/OpenAI are wired today:

1. A new `cortex-server/src/lib/providers/mistral.js` module (plain functions `complete()`/`testKey()`, following groq.js's/openrouter.js's exact shape — not the `BaseProvider` class, which appears to be used only by the newer `claude-oauth.js`/`codex.js`/`pair.js` providers).
2. `cortex-server/src/lib/router.js` — four hardcoded spots: `CLOUD_PROVIDER_IDS` array, `PROVIDER_AUTH_MODE` map, a manual `if (keys.mistral_key) {...}` branch inside `cloudCandidates()`, and a `TASK_CAPABILITIES` entry.
3. `cortex-server/src/lib/sqlite.js` — add `'mistral'` to the `CLOUD_PROVIDERS` array (line ~2113) that drives `getCloudKeys()`/`getCloudKeysMasked()`.
4. `cortex-server/src/routes/router.js` — `TESTERS`, `DEFAULT_MODELS`, `PROVIDER_LABELS` maps.
5. `src/components/modals/SettingsModal.tsx` — a new entry in the frontend's own independently-hardcoded `CLOUD_PROVIDERS: ProviderDef[]` array, plus optional inline JSX for any Mistral-specific settings fields.

This is well-trodden, low-risk, mechanically repeatable work — but it is genuinely five separate edits, not one.

### Secret storage — DPAPI, confirmed safe pattern to reuse exactly
`POST /api/router/cloud-keys` validates only that the provider id is in a hardcoded whitelist (no key-format/shape validation) and calls `setCloudKey(provider, key)` → `secretStore.setSecret()`, which shells out to PowerShell (`ProtectedData.Protect`, `DataProtectionScope.CurrentUser`) with the plaintext passed as a base64 CLI arg specifically to avoid ever appearing on a process command line. Only `{ ciphertext: '<base64 DPAPI blob>' }` is ever written to SQLite (under the generic `metadata` table). **Plaintext never touches SQLite, never returns to the frontend** — the only read path (`getCloudKeysMasked()`) always masks to `first4••••last4`. The test-connection route even strips the raw key (and any ≥4-char substring of it) from upstream error text before returning it, specifically because some providers echo the submitted key back in error responses. **This exact pattern is directly reusable for Mistral with no modification needed.**

### Error normalization — shared module, confirmed reusable as-is
`cortex-server/src/lib/provider-errors.js` is an explicitly shared utility (its own header comment: "shared by every provider module and consumed by router.js for fallback/cooldown decisions"). `ErrorCategory` enum (`MODEL_UNAVAILABLE, QUOTA_EXCEEDED, RATE_LIMITED, AUTH_FAILED, PROVIDER_UNAVAILABLE, CONTEXT_TOO_LONG, CAPABILITY_UNSUPPORTED, TIMEOUT, NETWORK_ERROR, UNKNOWN`), `classifyHttpError()`, `classifyNetworkError()`, `parseRetryAfterMs()` are all imported identically by both Groq and OpenRouter's provider modules. **A Mistral provider should reuse this module exactly the same way** — this maps directly onto mission §28's requested error taxonomy (AUTH_ERROR→AUTH_FAILED, RATE_LIMIT→RATE_LIMITED, QUOTA_EXCEEDED→QUOTA_EXCEEDED, TIMEOUT→TIMEOUT, NETWORK_ERROR→NETWORK_ERROR, etc. — the categories already exist, nearly 1:1).

### Privacy guard — NOT centralized, must be called explicitly (critical finding)
`guardCloudCall()` (`cortex-server/src/lib/privacy-guard.js`) checks message content for a `PRIVATE_SENTINEL` marker (content tagged upstream, before it ever reaches a provider) and throws `PrivacyViolationError` if found. **Router.js does not call this anywhere** — `cloudCandidates()`, `routedCompletion()`, `tryCloudFallbackChain()`, and `runAiTask()` were all confirmed to contain zero references to `privacy-guard.js`. Instead, **each provider module calls `guardCloudCall()` itself, as the first statement inside its own `complete()`/`generate()` function** (confirmed in both groq.js and openrouter.js). **This means a Mistral provider does not get this protection for free — omitting the explicit `guardCloudCall({ messages, provider: 'mistral', functionCalled: 'complete' })` call at the top of `mistral.js`'s `complete()` function would silently create a privacy-guard gap**, with no backstop anywhere else in the call chain to catch it. This is the single most important architectural finding for mission §23/§24 (privacy/content boundary, local_only protection).

### Strict Local — confirmed hard gate, unaffected by a new provider
`isStrictLocalMode()`/`assertCloudAllowed()` (`cortex-server/src/lib/strict-local.js`) and `router.js`'s own "VERROU GLOBAL" comment (from a prior audit): when `strict_local_mode` is on, cloud is never reached, no fallback can bypass it, regardless of what providers are configured. Adding a Mistral entry to `CLOUD_PROVIDER_IDS` does not weaken this — the gate operates before any provider-specific branch is reached inside `cloudCandidates()`.

### `router_settings` — flexible JSON blob, no migration needed for new budget fields
`getRouterSettings()`/`setRouterSettings()` read/write a single JSON blob under one `metadata` table row (`getMeta('router_settings', {})`), merged shallowly onto `ROUTER_SETTINGS_DEFAULTS` at read time — explicitly designed so a settings row saved before a new field existed still reports that field's real default rather than `undefined`. **New fields (e.g. `mistral_model`, `mistral_budget_limit_usd`, `mistral_model_allowlist: []`) can be added with zero SQL migration.** A nested object (mirroring the existing `freellmapi: {...}` sub-object pattern) would need its own explicit partial-merge line if partial updates should be supported — otherwise a flat top-level field needs nothing extra.

### Usage/cost/budget tracking — confirmed absent for every provider, not just Mistral
A full sweep of `sqlite.js`'s 60+ tables found nothing resembling token/dollar cost tracking for **any** provider, cloud or local. The closest tables (`router_logs`, `whisper_logs`, `teacher_model_usage`) track call counts and character lengths (`String.length`), never token counts or currency amounts. **This generalizes and confirms the prior AI-phase audit's FreeLLMAPI-specific finding to the whole codebase: Docteur has no usage/cost/budget/quota accounting infrastructure at all today.** A Mistral integration's budget guard would be genuinely new ground — nothing to extend, only new tables/columns to design.

### Model catalog / allowlist — none exists for any cloud provider
`local-ai-catalog.js` is exclusively for **local, Ollama-run** models (hardware-fit, VRAM sizing) — it already has entries for Mistral-family local weights (`mistral/devstral-small-2`, `mistral/magistral`), but this is a completely separate concern from a cloud API integration. For cloud providers: OpenRouter enforces a narrow one-model allowlist (`assertFreeModel()`, must end in `:free`); Groq accepts **whatever free-text model string the Settings UI sends, with zero server-side validation**, forwarded verbatim to the upstream API. **There is no precedent forcing either choice for Mistral** — this audit recommends the server-side allowlist approach per mission §18 (frontend must never define trust/pricing/provider type), rather than following Groq's laissez-faire pattern.

### Settings UI — consistent inline pattern, no reusable component to import
No `<ProviderCard>`/`<CloudBadge>` component exists anywhere in `src/`. The pattern (masked-key input + show/hide toggle + Save/Remove + Test Connection button + status badge) is real and consistent but implemented inline, copy-pasted per provider inside one large `.map()` over the frontend's own `CLOUD_PROVIDERS` array in `SettingsModal.tsx`. `PROVIDER_STATE_LABELS`/`PROVIDER_STATE_COLORS` (a generic `ProviderHealthState`-keyed badge vocabulary: `ready/rate_limited/quota_exhausted/auth_required/offline/...`) is reusable as-is for a Mistral card without modification — everything else (Free/Paid badge, Active/Not-configured badge) would be new inline markup mirroring Groq's card exactly.

---

## 2. Existing Mistral references — exhaustive grep, classified

**Classification: NONE (no cloud API integration exists).**

Every "mistral" hit across the entire codebase (cortex-server/src, src/, scripts/, reports/) falls into one of these categories, confirmed exhaustively:
- **Local Ollama model names only**: `mistral:7b`, `mistral-nemo:12b-instruct-2407-q4_K_M` used as local fallback candidates in `router.js`'s `LEVEL_CANDIDATES`, as the default `chat_model` in `ROUTER_SETTINGS_DEFAULTS`/`chat.js`/`teacher.js`, and in the frontend's local-model picker (`ollamaModels.ts`, `SettingsModal.tsx`, `ConversationModal.tsx`).
- **`local-ai-catalog.js` entries** for Mistral-family local weights (`mistral/devstral-small-2`, `mistral/magistral`) — hardware-fit metadata for Ollama, not a cloud API client.
- **One hardcoded site-shortcut URL** to Mistral's own consumer web chat app (`https://chat.mistral.ai`) in a generic external-link seed list — unrelated to any API.
- **One unrelated false positive** ("la plateforme" as generic French, not Mistral's product name) and **one explicit negative-confirmation comment** in `maitre-executor.js` stating the file has no Mistral import, as part of that module's own isolation guarantee.
- **Report/markdown prose** discussing Mistral only in the context of local-model research or explicitly certifying zero Mistral reference in a security-sensitive codepath.

No hits at all for `mistralai` (as an SDK/package name), `codestral`, `la plateforme` (as the actual product name), or `ministral` outside of local-model research notes discussing it as a future local-model candidate. **Confirmed: this is a fully greenfield cloud-API integration** — Docteur currently only knows Mistral as a family of self-hosted, locally-run Ollama model weights, entirely separate from what a Mistral AI cloud provider (`api.mistral.ai`) integration would mean.

---

## 3. Official Mistral API (verified 2026-09-21, docs.mistral.ai)

- **Base URL**: `https://api.mistral.ai/`
- **Authentication**: Bearer token in `Authorization` header (`Authorization: Bearer $MISTRAL_API_KEY`)
- **Chat completions**: `POST /v1/chat/completions` — OpenAI-compatible-shaped request (`model`, `messages[]` with `system`/`user`/`assistant`/`tool` roles)
- **Streaming**: supported (standard SSE-style streaming, consistent with the rest of the documented API surface)
- **Tool/function calling**: supported, documented explicitly under "Tool Calling," available on Mistral Large 3, Mistral Medium 3.5, Mistral Small 3.2, Devstral 2.0, Magistral Medium/Small, Codestral, and all three Ministral 3 sizes
- **Structured outputs**: supported (JSON schema mode, separate documentation section confirmed to exist)
- **Embeddings**: `mistral-embed` (1024-dimension vectors) and `codestral-embed` (code-specific)
- **Vision**: supported on Mistral Large 3, Mistral Medium 3.5, and all Ministral 3 sizes (text+image+PDF input, text output)
- **Audio**: Voxtral family (transcription, realtime transcription, TTS with voice cloning) — separate product line, not chat completions
- **OCR**: separate dedicated OCR model line (OCR 4.1/4.0/3), priced per 1,000 pages, not per-token
- **Admin API (usage metrics)**: `GET https://api.mistral.ai/v1/admin/usage?month=&year=&workspace_id=` — **requires a separate Admin API key created in the Backoffice** (distinct credential type from a normal chat-completions API key), authenticated via `x-api-key` header. Returns daily series for tokens consumed (input/output/cached, per model), tool calls, session counts. This is the read-only, programmatic quota/usage-check mechanism mission §8 asks about — it exists, but needs its own separately-provisioned admin credential, not the same key used for inference.

**Relevance filter for Docteur (mission §5's "don't add functions just because the API has them")**: chat completions + tool calling + structured output + streaming are directly useful and map onto existing router.js task types. Embeddings could complement (not replace) the existing local Ollama embedding pipeline for cloud-scale semantic search if ever needed, but is not an immediate need. Vision could complement the existing local vision pipeline for higher-quality OCR-adjacent tasks. Audio/OCR/Moderation are separate product lines with no current Docteur use case identified — **not recommended for V1 scope**, consistent with the mission's own instruction not to add capability just because it exists.

---

## 4. Model catalog (verified 2026-09-21)

| Canonical model ID (illustrative, `-latest` suffix recommended over pinned dates) | Category | Context window | Modalities (in/out) | Tools | Structured output | Streaming | Notes |
|---|---|---|---|---|---|---|---|
| `mistral-large-latest` (Mistral Large 3, v25.12) | GENERAL / REASONING | 256K tokens | text+image+PDF / text | YES | YES | YES | 675B MoE (41B active), Apache 2.0 open-weight |
| `mistral-medium-latest` (Mistral Medium 3.5, v26.04) | GENERAL / REASONING | 256K tokens | text+image+PDF / text | YES | YES | YES | 128B dense, configurable reasoning effort per request |
| `mistral-small-latest` (Mistral Small 4, v26.03) | SMALL / LOW COST | Unverified exact figure | text+image / text | YES | YES | YES | Hybrid instruct/reasoning/coding |
| `ministral-3-14b` / `ministral-3-8b` / `ministral-3-3b` (v25.12) | SMALL / LOW COST | Unverified exact figure | text+vision / text | YES | Unverified | Likely | Lowest-cost tier |
| `codestral-latest` (v25.08) | CODING | Unverified exact figure | text / text | YES | Unverified | Likely | Code completion/generation |
| `mistral-embed` (v23.12) | EMBEDDING | N/A | text / vector (1024-dim) | N/A | N/A | N/A | Pricing has a source discrepancy — see below |
| `codestral-embed` (v25.05) | EMBEDDING | N/A | code / vector | N/A | N/A | N/A | Code-specific embeddings |

**Deprecation note**: per official docs, deprecation dates are listed per-model through mid-2026 — a hardcoded model ID list would go stale; any future integration should use `-latest` aliases where Mistral provides them, or fetch the live model list, rather than pinning dated model IDs (mission §6's own instruction).

---

## 5. Pricing (verified 2026-09-21, mistral.ai/pricing/api — flagged for re-verification before any future integration, since Mistral does not guarantee price stability)

| Model | Input ($/M tokens) | Output ($/M tokens) | Currency |
|---|---|---|---|
| Mistral Medium 3.5 | $1.50 | $7.50 | USD |
| Mistral Large 3 | $0.50 | $1.50 | USD |
| Mistral Small 4 | $0.15 | $0.60 | USD |
| Ministral 3 (14B) | $0.20 | $0.20 | USD |
| Ministral 3 (8B) | $0.15 | $0.15 | USD |
| Ministral 3 (3B) | $0.10 | $0.10 | USD |
| Codestral | $0.30 | $0.90 | USD |
| Mistral Embed | $0.10 (input only) | N/A | USD |
| Codestral Embed | $0.15 (input only) | N/A | USD |
| OCR 4.1 | $4.00 per 1,000 pages | — | USD |
| Voxtral TTS | $0.016 per 1,000 characters | — | USD |

**Discrepancy flagged, not silently resolved**: one third-party source (theneuralbase.com) cited Mistral Embed at $0.02/M input tokens, conflicting with the $0.10/M figure from the official `mistral.ai/pricing/api` page fetched directly for this audit. **The official-source figure ($0.10/M) is used above**, per mission §14's instruction to source from official pages — but this conflict itself is evidence that third-party pricing aggregators drift out of sync with official pricing, reinforcing why any future integration must re-verify pricing at the time of implementation, not reuse this table indefinitely.

**Pricing metadata for future integration**: `pricingLastVerifiedAt: 2026-09-21`, `source: mistral.ai/pricing/api`, `currency: USD`. EUR pricing is also offered by Mistral directly (not a Docteur-side conversion) — no currency conversion should ever be invented by Docteur; if EUR is needed, it should come from Mistral's own EUR price list, not a computed exchange rate.

---

## 6. Use cases for Docteur — REAL VALUE vs DUPLICATE vs NOT_NEEDED

| Use case | Classification | Reasoning |
|---|---|---|
| Generalist cloud completion (chat/synthesis) | DUPLICATE (partial) | Groq, OpenRouter, Gemini, FreeLLMAPI, Claude, Codex already cover this; Mistral would be one more option in an already-crowded lane — value is optionality/redundancy, not a new capability |
| Reasoning (Mistral Medium 3.5's configurable reasoning effort) | REAL VALUE (narrow) | No existing cloud provider offers a configurable-reasoning-effort dial; could complement Gemini's grounding-search use case in `research.js` for reasoning-heavy synthesis tasks |
| Coding assistance (Codestral) | DUPLICATE | Phase 4's Code Intelligence audit already concluded NO_INTEGRATION for coding-agent capability generally — MetaGPT (local) already covers plan/diff/apply; Codestral as a raw completion model would duplicate what local Ollama coding models already do for Docteur's coding-adjacent needs |
| Vision / OCR | NOT_NEEDED currently | No existing Docteur workflow was identified in any prior-phase audit that needs cloud-scale vision beyond what local vision models already handle |
| Embeddings (semantic search at cloud scale) | NOT_NEEDED currently | Docteur's embedding pipeline is local (Ollama `nomic-embed-text`, per `env.EMBEDDING_MODEL` seen in prior server.js review) — no demonstrated need for cloud embeddings |
| Explicit fallback provider (one more option in the existing cloud fallback chain) | REAL VALUE (narrow) | The existing chain (Groq → Gemini → OpenRouter → paid) already follows an explicit-only, no-silent-fallback design (confirmed in the .gitignore-audit-adjacent MAÎTRE/router work); adding Mistral as one more explicitly-configured link is architecturally trivial and doesn't duplicate anything since it's additive optionality, not a new fallback *mechanism* |

**Net finding**: Mistral's narrowest, most defensible value to Docteur is (a) reasoning-effort-configurable completions for `research.js`'s synthesis/deep-research modes, and (b) one more explicit, user-configured link in the existing cloud fallback chain — not a wholesale new capability class the way, say, Kiwix or a Code Intelligence gap-filler would be.

---

## 7. Account / API access (mission §8 — read-only, no assumptions)

API access : **UNKNOWN**
Account tier : **UNKNOWN**
Free credits : **UNKNOWN**
Paid credits : **UNKNOWN**
Current usage : **UNKNOWN**
Quota remaining : **UNKNOWN**
Monthly limit : **UNKNOWN**
Hard spending limit : **UNKNOWN**
Pay-As-You-Go : **UNKNOWN**

No Mistral account credential of any kind exists anywhere in Docteur's secret-store, environment, or configuration (confirmed by the exhaustive grep in §2 — there is no `MISTRAL_API_KEY` reference anywhere, meaning no key has ever been configured in this project). Checking live account/quota/billing state would require either (a) a normal Mistral API key plus the separate Admin-API key described in §3, or (b) the user manually checking the Mistral Admin Console (`admin.mistral.ai/organization/usage`) themselves. **Per mission §8's explicit instruction, this was not requested or assumed — every field above is reported as UNKNOWN rather than guessed.**

---

## 8. No billing changes (mission §9 — confirmed)

Automatic billing changes : **0**. No payment method was added or modified. No Pay-As-You-Go activation was attempted. No spending limit was raised, lowered, or removed. No credits were purchased. No plan upgrade was accepted.

---

## 9. Quota decision (mission §10)

Quota status : **QUOTA_UNKNOWN**

Per mission §10's explicit instruction, UNKNOWN is never treated as available. Since no account state is verifiable (§7), a reasonable, conservative reading is: **treat quota as effectively zero until the user explicitly confirms otherwise** — any future integration work must not assume free-tier capacity exists.

---

## 10. Budget guard design (mission §11–§17 — design only, not implemented)

A future Mistral budget guard should support, at minimum:

- `MONTHLY_HARD_LIMIT` (USD) — stored in `router_settings.mistral_budget_monthly_hard_limit_usd`
- `DAILY_SOFT_LIMIT` (USD) — `router_settings.mistral_budget_daily_soft_limit_usd`, warning-only, never blocks
- `PER_REQUEST_TOKEN_LIMIT` — `router_settings.mistral_max_tokens_per_request`, enforced before the call is made
- `MODEL_ALLOWLIST` — `router_settings.mistral_model_allowlist: string[]`, server-side, never trusting a frontend-supplied model ID (per mission §18 and the confirmed lack of any existing cloud-model allowlist precedent — this audit recommends Mistral be the first cloud provider to get one, rather than repeating Groq's free-text pattern)
- `REQUEST_COUNT_LIMIT` (optional) — a simple daily counter, following the exact pattern `teacher_model_usage` already uses (`date, model, calls`)

**Budget states** (mission §12): `OK` (call proceeds per policy) → `NEAR_LIMIT` (visible warning, call still proceeds) → `LIMIT_REACHED` (zero new Mistral calls) → `UNKNOWN` (fail conservative — treated identically to `LIMIT_REACHED` until the state is knowable again, never treated as unlimited).

**Hard limit enforcement** (mission §16): `current_spend + estimated_max_request_cost > hard_limit` must block *before* the call is dispatched, not after. If a reliable cost estimate isn't computable (e.g. unknown token count pre-call), the conservative policy is to block rather than proceed — matching mission §16's own instruction.

**Concurrency risk** (mission §17, design-only, not implemented now): multiple simultaneous requests could each pass a budget check before any of their actual costs are recorded, together exceeding the hard limit. A future implementation would need a reservation/pending-cost counter (increment an in-memory or SQLite "reserved" amount at request-start, decrement/reconcile with actual cost at response-time, and check `current_spend + all_pending_reservations + new_estimate > hard_limit`) — noted as a required design element for the eventual implementation, not built in this audit phase.

---

## 11. Usage/cost accounting design (mission §13–§15 — design only)

Mistral's API response (standard OpenAI-compatible `usage` object) provides `prompt_tokens`, `completion_tokens`, `total_tokens` — no confirmation found of a separate "cached tokens" or "reasoning tokens" field in the chat completions response specifically (Mistral Medium 3.5's configurable reasoning effort was not confirmed to expose a distinct reasoning-token count in the API response; would need direct verification against a real response before implementation, not assumed here).

**Proposed local usage record** (new SQLite table, since none exists to extend — confirmed absent for every provider in §1): `provider, model, timestamp, inputTokens, outputTokens, estimatedCostUsd, actualCostUsd (if computable), requestType`. Cost should be computed as `(inputTokens / 1_000_000) * inputPricePerM + (outputTokens / 1_000_000) * outputPricePerM` using the pricing table in §5, stored with sufficient decimal precision (e.g. as integer micro-cents, or a `DECIMAL`-equivalent string, rather than raw JS floating-point) to avoid floating-point drift accumulating over many small transactions — mission §15's explicit concern.

---

## 12. Rate limits, timeouts, streaming (mission §26–§29 — verified where possible)

- **429 response shape** (verified): `{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}`, with a `Retry-After` header (typically ~1s, longer under load) and `x-ratelimit-remaining`/`x-ratelimit-reset` headers for proactive avoidance.
- **Tiering**: rate limits are set at the **workspace level** (all API keys in a workspace share the same RPM/TPM budget), varying by account tier (free/"Experiment" vs. paid/"Scale") — exact current numeric limits are not publicly published on the docs pages fetched for this audit (Mistral directs users to the Admin Console's own Limits page for their specific current numbers) — reported as UNKNOWN rather than guessed, consistent with mission §8/§10's instruction.
- **Existing Docteur pattern to reuse**: `parseRetryAfterMs()` (provider-errors.js) already parses a `Retry-After` header generically — directly reusable for Mistral's 429 handling with no modification.
- **Backoff policy** (design, not implemented): bounded exponential backoff, small maximum retry count (matching mission §26's "pas de boucle infinie") — consistent with how the existing provider-errors.js classification is consumed by router.js's fallback/cooldown logic today.
- **Timeouts** (design): connect timeout, request timeout, and stream-inactivity timeout should all be set explicitly — no existing provider module was confirmed in this pass to have a stream-inactivity timeout specifically (worth verifying against groq.js/openrouter.js's actual fetch-timeout configuration before implementation, not assumed present).
- **Streaming**: Mistral's chat completions API supports SSE-style streaming (confirmed via docs structure, not independently tested against a real streamed response in this audit since no API key exists). Budget accounting must remain correct even if a stream is interrupted mid-response — meaning cost should be computed from whatever partial `usage` data is available at interruption, not assumed to be the full requested `max_tokens`.

---

## 13. Error normalization mapping (mission §28)

| Mission-requested category | Maps to existing `provider-errors.js` `ErrorCategory` |
|---|---|
| AUTH_ERROR | `AUTH_FAILED` |
| RATE_LIMIT | `RATE_LIMITED` |
| QUOTA_EXCEEDED | `QUOTA_EXCEEDED` |
| BUDGET_LIMIT | New — not a Mistral API error at all, but a Docteur-side budget-guard rejection (must be synthesized locally, before the API is ever called, distinct from any upstream classification) |
| MODEL_NOT_AVAILABLE | `MODEL_UNAVAILABLE` |
| TIMEOUT | `TIMEOUT` |
| NETWORK_ERROR | `NETWORK_ERROR` |
| INVALID_RESPONSE | Not currently a distinct category — would map to `UNKNOWN` or need a new category added to the shared enum |
| PROVIDER_ERROR | `PROVIDER_UNAVAILABLE` |

Nearly the entire requested taxonomy already exists in the shared `provider-errors.js` module — only `BUDGET_LIMIT` (inherently Docteur-side, not an upstream API error) is genuinely new. Per the existing pattern (confirmed via groq.js's test-connection route stripping the raw key from error text), any Mistral error message returned to the frontend must never include the raw upstream error body verbatim if it could contain the submitted key — same redaction discipline required.

---

## 14. Security review (mission §42–§44)

| Risk | Mitigation (existing pattern to reuse, or new design) |
|---|---|
| API key leakage | DPAPI secret-store (existing, directly reusable) + Pino log redaction for `Authorization`/`Bearer`/`api-key`/`MISTRAL_API_KEY` patterns (needs confirming the existing Pino redaction config already covers a generic `Authorization` header pattern — not independently verified in this pass, should be checked before implementation) |
| Budget race (concurrent requests) | Reservation/pending-cost counter — design only, see §10 |
| Model injection (frontend sending an untrusted model ID) | Server-side model allowlist (recommended new pattern for Mistral, since no cloud provider currently enforces one except OpenRouter's narrow single-model case) |
| Prompt injection | Mistral output must be treated as DATA at every sensitive boundary — same discipline already proven for MAÎTRE's Analyst output and Sherlock's `untrusted: true` tagging; text like "run powershell"/"approve action"/"send email"/"ignore policy" in a Mistral response constitutes zero authorization anywhere in Docteur |
| Cloud fallback (silent) | Already structurally prevented — `cloudCandidates()`'s fallback chain is explicit and user-configured, and Strict Local's "VERROU GLOBAL" blocks all cloud unconditionally with no bypass path; adding Mistral doesn't change this |
| Private-data leakage | **Must explicitly call `guardCloudCall()`** — confirmed NOT automatic (§1); this is the single highest-priority implementation detail for any future Mistral provider module |
| Unknown quota | Treated as `QUOTA_UNKNOWN`, never as unlimited (§9) |
| Stale pricing | `pricingLastVerifiedAt` metadata field + explicit re-verification requirement before any future cost calculation is trusted (§5) |
| Unbounded retries | Bounded exponential backoff, small max retry count (§12) |
| Oversized prompts | `PER_REQUEST_TOKEN_LIMIT` enforced pre-call (§10) |
| Malformed responses | Should map to `INVALID_RESPONSE`/`UNKNOWN`, never crash the caller — consistent with how `classifyHttpError`/`classifyNetworkError` already degrade gracefully rather than throwing raw |

---

## 15. MAÎTRE and Agency boundaries (mission §31–§32 — confirmed, not touched)

No MAÎTRE file was read, modified, or wired to Mistral in this audit. `maitre-executor.js` was confirmed (via the internal architecture audit) to contain an explicit comment stating it has no Mistral (or Codex/OpenAI) import — this isolation guarantee remains fully intact; nothing in this audit proposes changing it. Any future MAÎTRE use of Mistral as an analysis engine would require its own, separately-authorized scope — not implied or started here. Similarly, no Agency/Business-agent wiring was proposed or started — Phase 5's `BUILD_THIN_DOCTEUR_AGENT` recommendation remains a fully separate, unstarted chantier.

---

## 16. Settings UX (future architecture only, mission §33–§37 — not implemented)

Mistral would follow the exact existing card pattern (§1's Settings UI finding): masked-key input, Save/Remove, Test Connection (user-triggered only, never automatic on Settings-open), and a status badge drawn from the existing `PROVIDER_STATE_LABELS`/`PROVIDER_STATE_COLORS` vocabulary, extended with budget-specific states (`BUDGET_WARNING`, `BUDGET_REACHED`) that don't exist yet in that enum and would need to be added. Test Connection should use the smallest possible real call if Mistral has no free/zero-cost health-check endpoint (not independently verified whether one exists in this pass — worth checking before implementation), and any tokens consumed by a test call must be recorded in the same usage-accounting table as a real request, per mission §35. Opening Settings must trigger zero Mistral API calls, zero provider tests, zero model-list refreshes, and zero billing API calls — consistent with how the existing Settings modal already behaves for every other provider (masked-key display and cached `/api/router/providers` status data, not a live upstream call on every render).

---

## 17. Comparison with existing providers (mission §45 — factual, not marketing)

| Provider | Local/Cloud | Coding | Reasoning | Context (largest model) | Structured output | Tool calling | Pricing model |
|---|---|---|---|---|---|---|---|
| Ollama (local) | Local | Via local coding models | Via local reasoning models | Model-dependent | Model-dependent | Model-dependent | Free (compute cost only) |
| Groq | Cloud | Via `openai/gpt-oss-120b` default | Limited | Model-dependent | Unverified | Unverified | Free tier confirmed in UI (`free: true` in `CLOUD_PROVIDERS`) |
| OpenRouter | Cloud | Via routed model | Via routed model | Model-dependent | Model-dependent | Model-dependent | Free-tier-only enforced (`assertFreeModel`) |
| Gemini | Cloud | Limited | Grounding-search-assisted | Large (not independently re-verified here) | YES | YES | Paid, with grounding daily cap (20/day per `research.js`) |
| Claude (OAuth CLI) | Cloud | Strong (via external-agents.js) | Strong | Large | YES | YES | Subscription-based (OAuth, not per-token metered in Docteur) |
| Codex (CLI) | Cloud | Strong (via external-agents.js) | Moderate | Large | YES | YES | Subscription-based |
| FreeLLMAPI | Cloud (gateway) | Gateway-dependent | Gateway-dependent | Gateway-dependent | Gateway-dependent | Gateway-dependent | Free-only by design |
| **Mistral (candidate)** | Cloud | Codestral (dedicated model) | Medium 3.5 (configurable effort) | 256K (Large 3 / Medium 3.5) | YES | YES | **$0.15–$7.50/M tokens depending on model, no free tier for API confirmed in this pass** |

**Factual comparison conclusion**: Mistral's technical capability (256K context, configurable reasoning, tool calling, structured output) is genuinely competitive with Gemini and the Claude/Codex CLI providers, but Docteur already has strong coverage in every one of those lanes. Mistral's distinguishing value is narrow (configurable-reasoning-effort dial, open-weight licensing philosophy, potentially better per-token pricing than Gemini for some tasks) rather than a capability gap — this is architecturally similar to Phase 4's Code Intelligence conclusion (real technical merit, but duplicative of existing capability) rather than Phase 3's Kiwix conclusion (a genuine, currently-unfilled gap).

---

## 18. Recommendation (mission §46–§47)

**CONFIGURE_ONLY.**

Reasoning, applying mission §46's own decision criteria directly:

- **API access confirmed**: NO — account/quota/billing state is entirely UNKNOWN (§7), and per mission §47, a DEFER-or-CONFIGURE_ONLY outcome is mandatory when quota/billing is unclear and no user-authorized budget exists. This audit did not, and was instructed not to, assume PAYG activation or any budget authorization.
- **Budget/quota acceptable**: UNKNOWN, not verified — cannot be called "acceptable" without guessing.
- **Budget guard realizable**: YES — the design in §10–§11 is concrete and buildable using entirely existing Docteur patterns (`router_settings` JSON blob, a new SQLite usage table following the `router_logs`/`teacher_model_usage` shape, `provider-errors.js`'s existing categories).
- **Secret-store compatible**: YES — directly reusable with zero modification (§1).
- **Strict Local compatible**: YES — the existing "VERROU GLOBAL" gate requires no changes to remain fully effective against a new Mistral provider (§1).
- **Real value vs. existing providers**: NARROW, not absent — Mistral is technically competitive but duplicative of capability Docteur already has via Gemini/Claude/Codex/local Ollama (§6, §17), not a gap-filling addition the way Kiwix's offline-knowledge capability would be.

Given API/quota/billing access is entirely unverified, and the mission explicitly forbids treating that as "integrate anyway, PAYG can be sorted out later" — **CONFIGURE_ONLY is the correct verdict**: the architecture is sound and worth building (secret-store wiring, provider module skeleton, budget-guard scaffolding, Settings UI card) so that Mistral becomes available the moment the user confirms real account/budget details, without that scaffolding work depending on an unverified assumption about quota availability. This is distinct from DEFER (which would mean "not worth building yet at all") — the architecture work here has value independent of Mistral's own account status, since it also validates/exercises the "add a 6th cloud provider" pattern generally.

---

## 19. Proposed future integration scope (if/when the user confirms account details and authorizes proceeding)

1. `cortex-server/src/lib/providers/mistral.js` — `complete()`/`testKey()` following groq.js's exact shape, **with an explicit `guardCloudCall()` call as the first statement** (§1's critical finding).
2. Reuse `provider-errors.js` unmodified; add a new `BUDGET_LIMIT` category if the shared enum needs extending for the Docteur-side (non-upstream) budget-guard rejection case.
3. New SQLite table for usage/cost accounting (provider, model, timestamp, tokens, cost) — the first such table in Docteur, designed generically enough that Groq/Gemini/OpenRouter could adopt it later too, though this audit does not propose retrofitting them now.
4. `router_settings` additions: `mistral_model`, `mistral_budget_monthly_hard_limit_usd`, `mistral_budget_daily_soft_limit_usd`, `mistral_max_tokens_per_request`, `mistral_model_allowlist: []` — zero migration needed (§1).
5. Wire into `lib/router.js`'s four hardcoded spots + `routes/router.js`'s three maps, exactly mirroring Groq's registration.
6. Settings UI: new `CLOUD_PROVIDERS` entry + inline card JSX, extending `PROVIDER_STATE_LABELS`/`PROVIDER_STATE_COLORS` with `BUDGET_WARNING`/`BUDGET_REACHED` states.
7. Server-side model allowlist enforcement (recommended as the first cloud provider to get this, per §10/mission §18) rather than Groq's free-text pattern.
8. **No PAYG activation, no payment method changes, no spending-limit changes** — these remain entirely the user's own action via Mistral's own console, never something Docteur code touches.

---

## DOCTEUR MISTRAL AUDIT CHECKPOINT

Research date : 2026-09-21

Existing Mistral integration : **NONE** (only local Ollama Mistral-family model *weights* exist; zero cloud-API code, zero API key, zero references beyond local-model names and one unrelated web-chat shortcut URL)

Current provider architecture reviewed : PASS

Official Mistral API reviewed : PASS

Official models reviewed : PASS

Official pricing reviewed : PASS (one source discrepancy flagged for Mistral Embed — official page figure used, not silently resolved)

API access : UNKNOWN

Quota status : UNKNOWN (treated as unavailable per mission §10's own instruction, never as "available by default")

Billing status : UNKNOWN

Pay-As-You-Go : UNKNOWN

Automatic billing changes : 0

Free/paid credits verified : UNKNOWN — Mistral's own pricing page mentions a "$10/mo Free Plan API credits" figure, but this was not independently verified against this project's own (non-existent) account, so it is not asserted as fact for Docteur specifically

Current usage verified : UNKNOWN

Hard spending limit available : UNKNOWN (Mistral's own console supports Organization/Workspace spending limits per official docs — mechanism confirmed to exist, current value for any real account not checked)

Budget guard feasible : YES

Recommended monthly hard limit : Not set by this audit — must be a user-provided, explicitly authorized figure, never invented

Recommended daily soft limit : Not set by this audit — same reasoning

Per-request token limit : Design proposes this be configurable via `router_settings.mistral_max_tokens_per_request`, no default number asserted here

Model allowlist proposed : YES — server-side, via `router_settings.mistral_model_allowlist`, recommended to include only `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `codestral-latest`, `mistral-embed` (using `-latest` aliases, not dated pins, per §4)

Usage accounting feasible : YES (new table required — none exists to extend, confirmed for every provider)

Budget concurrency risk addressed in design : PASS (reservation/pending-cost counter proposed in §10, not implemented)

Secret-store compatible : PASS

Secrets exposed : 0

Strict Local compatible : PASS

Silent cloud fallback : 0

Settings-open cloud calls proposed : 0

Automatic model refresh proposed : 0

Automatic Pay-As-You-Go activation : 0

Payment modifications : 0

Real Mistral inference calls : 0

Useful Docteur use cases : reasoning-effort-configurable completions (Mistral Medium 3.5) for `research.js`'s synthesis/deep-research modes; one additional explicit, user-configured link in the existing cloud fallback chain

Duplicated use cases : generalist cloud completion (already covered by Groq/OpenRouter/Gemini/Claude/Codex), coding assistance (already covered by MetaGPT + local Ollama coding models, and Phase 4 already concluded no new coding-agent integration is needed), vision/OCR/embeddings (no demonstrated Docteur need beyond existing local pipelines)

Main security risks : privacy-guard is NOT automatic and must be explicitly wired into any new provider module (highest-priority finding); no existing usage/cost/budget infrastructure to extend (must build new); no existing cloud-model allowlist precedent (Mistral should be the first to get one, not repeat Groq's unvalidated free-text pattern); stale/conflicting third-party pricing sources exist and must not be trusted over official docs

Recommended integration architecture : `cortex-server/src/lib/providers/mistral.js` (groq.js-shaped, explicit `guardCloudCall()`), reuse `provider-errors.js` unmodified, new SQLite usage/cost table, `router_settings` additions (zero migration), standard 5-location wiring (router.js ×4 spots, routes/router.js ×3 maps, sqlite.js CLOUD_PROVIDERS, SettingsModal.tsx CLOUD_PROVIDERS + card JSX), server-side model allowlist as a new, stricter pattern for this provider specifically.

Files modified : 0 (1 new report file only)

Packages installed : 0

Verdict : **CONFIGURE_ONLY**

Puis STOP.

NE PAS COMMENCER L'INTÉGRATION MISTRAL AUTOMATIQUEMENT. ATTENDRE VALIDATION UTILISATEUR.
