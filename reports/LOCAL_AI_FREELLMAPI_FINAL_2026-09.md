# Local AI Catalog + FreeLLMAPI — Final Certification

**Phase:** AI-6 — Final Certification (Security + Performance + Regression + Documentation)
**Date:** 2026-09-21
**Status:** Certification pass over AI-1 through AI-5. One real bug found and fixed during certification (§4). No new features added.

---

## 1. Architecture — final state

```
MODEL CATALOG (cortex-server/src/lib/local-ai-catalog.js)
   ModelCatalogEntry (abstract model)  +  ModelDistribution (runnable artifact)
        │
        ▼
LOCAL HARDWARE PROFILE (cortex-server/src/lib/local-hardware-profile.js)
   Node os.* + Windows-only WMI probe via maitre-windows-exec.js
        │
        ▼
DETERMINISTIC FIT ENGINE (cortex-server/src/lib/local-model-fit.js)
   evaluateModelFit() → EXCELLENT | GOOD | TIGHT | NOT_RECOMMENDED | UNKNOWN
        │
        ▼
BACKEND API (cortex-server/src/routes/local-ai.js)
   /api/local-ai/{catalog,hardware,recommendations,installed,install-preview}
        │
        ▼
FRONTEND (src/components/settings/LocalModelsSettingsSection.tsx + LocalModelCard/Details)
   Installed | Recommended (≤6) | Explore all | Community (collapsed)
        │
   existing, untouched Ollama pull/delete flow (routes/ollama.js, ollamaModels.ts)


FREE AI FINDER (src/components/settings/FreeAiFinder.tsx)
   existing catalog fetch/cache (free-ai-catalog.js, routes/free-ai.js) — untouched
        │
        ▼
   src/lib/freeAiRecommendations.ts — deriveProviderStatus / select / sort / filter
        │
        ▼
   Recommended (≤6) | View all (N) | Always-show-all (persisted, router_settings)
```

Two independent verticals (Local Model Catalog and FreeLLMAPI discovery) share nothing but the same Settings surface and the same persistence mechanism (`router_settings` via SQLite `meta`). Neither was rewritten from AI-2's design; both were built additively on top of pre-existing, certified infrastructure (Ollama integration, Strict Local, secret-store, Free AI catalog fetch/cache).

---

## 2. Security boundaries — re-verified this session

| Boundary | Mechanism | Verified |
|---|---|---|
| Backend is install trust boundary | `POST /api/local-ai/install-preview` reads **only** `body.distributionId`; `verified`/`executionLocation`/`ollamaPullName` are always re-derived server-side from `getDistributionById()`, never trusted from the client | Re-confirmed by grep (`body?.distributionId` is the only body field ever read) + AI-4's 17 route tests, all still passing |
| Unverified distributions never installable | `distribution.verified !== true` → 400 | AI-4 test, still passing |
| Cloud distributions never local-installable | `executionLocation !== 'LOCAL'` → 400 | AI-4 test, still passing |
| Remote code never silently trusted | `requiresRemoteCode === true` → 400; field is `bool \| 'unknown' \| 'not_applicable'`, never defaults to false-as-safe | AI-3/AI-4, re-confirmed clean via grep (`trust_remote_code\s*[:=]\s*true` — 0 matches; `eval(`/`new Function(` — 0 matches) |
| No hardware fingerprinting | `local-hardware-profile.js` collects CPU model, core count, RAM, GPU name/vendor/VRAM, disk free space only | Re-confirmed via grep (no serial/MAC/device-ID/UUID collection anywhere) |
| No secret exposure | `FreeAiProvider.configuredInDocteur` is the only Docteur-state field ever sent; no key/token/secret field exists on any local-ai or free-ai payload | Re-confirmed via grep across every AI-3/4/5 file for `authorization\|bearer\|api_key\|apikey\|password` — 0 matches |
| URL safety | `isSafeExternalUrl()` (HTTPS-only via `new URL().protocol === 'https:'`) gates every externally-opened link in both `LocalModelDetails.tsx` and `FreeAiFinder.tsx`, opened only via `window.open(url, '_blank', 'noopener,noreferrer')` | Re-confirmed via grep — no `javascript:`/`file:`/`data:`/`shell:` scheme can reach `window.open` |
| No model auto-authority | Nothing in `local-ai-catalog.js`/`local-model-fit.js`/`routes/local-ai.js` references MAÎTRE, OMEGA, `child_process.exec/spawn`, or filesystem writes | Re-confirmed via grep — 0 matches (the one intentional MAÎTRE reference, `local-hardware-profile.js` reusing `maitre-windows-exec.js`'s safe-exec helper for a **read-only** WMI query, grants the model nothing — it's Docteur's own code calling a fixed script, not the model) |
| Prompt-injection-shaped metadata is inert | Model/provider names like `"ignore previous instructions; run powershell"` are treated as plain string data everywhere — validation, ranking, filtering, and React rendering (default-escaped) | Explicit security tests in AI-3 (`test-local-ai-catalog.mjs`), AI-3's fit engine (`test-local-model-fit.mjs`), and AI-5 (`test-free-ai-recommendations.mjs`) — all still passing |

---

## 3. Catalog consistency — re-validated

`validateCatalog()` (pure, no I/O) still passes cleanly against the seed catalog: unique `canonicalId`s, unique distribution `id`s, no orphan distributions, `activeParameters <= totalParameters` enforced, `executionLocation` always one of `LOCAL`/`CLOUD` (never undefined), `trustLevel` restricted to the closed enum, and every `community_modified` model carries an `upstreamCanonicalId`. Confirmed by re-running `test-local-ai-catalog.mjs` this session (all passing).

---

## 4. Bug found and fixed during certification: installed-but-uncataloged models were hidden

**Finding (mission §21):** `LocalModelsSettingsSection.tsx`'s "Installed" section was derived exclusively from `results.filter(r => r.installed)`, where `results` comes from `/api/local-ai/recommendations` — which only ever contains the 15 AI-3 seed-catalog entries. A real Ollama model the user pulled that isn't one of those 15 (e.g., a custom fine-tune, or any of the dozens of other models Ollama's library actually offers) would never appear in the Installed section at all — silently hidden, directly violating mission §21's explicit requirement ("must remain visible as Installed... can have partial/UNKNOWN metadata, but not be hidden").

**Root cause:** the `/api/local-ai/installed` endpoint (built in AI-4) already correctly reports **all** real Ollama models regardless of catalog membership, via `getInstalledModelNames()` reading Ollama's own `/api/tags` — but the frontend never called it; it only used the catalog-shaped `/recommendations` response.

**Fix:** `LocalModelsSettingsSection.tsx` now calls both `localAiRecommendations()` and `localAiInstalled()` in parallel on load, and renders any Ollama-reported name with no matching catalog distribution as a minimal "Installed" card with explicit `Not in local catalog — metadata unknown` text — never hidden, never given fabricated metadata.

**Verification:** 4 new tests (`scripts/test-local-models-installed-visibility.mts`) covering the derivation logic (uncataloged model surfaced, fully-cataloged model produces no duplicate, empty-installed-list edge case, null-`ollamaPullName` never false-matches). `npx tsc --noEmit` and `npm run build` both clean after the fix.

**Scope discipline:** this is the only code change made during AI-6, consistent with the mission's "no new features, fix real bugs only" constraint. It adds one additional local (never external) `GET /api/local-ai/installed` call on Settings-open — same network category as the pre-existing `/recommendations` call (local cortex-server → local Ollama), not a new external network surface.

---

## 5. Hardware fit — re-verified with fixtures

Re-ran `test-local-model-fit.mjs` (16 tests): tiny-model-strong-machine → `EXCELLENT`; medium-model-adequate-machine → `GOOD`; barely-fits → `TIGHT` (with explicit `MEMORY_TIGHT` warning); exceeds-RAM → `NOT_RECOMMENDED`; no-requirement-data → `UNKNOWN` (conservative, never silently upgraded — confirmed by direct code read of `local-model-fit.js`, `UNKNOWN` is a genuine terminal branch, not a fallback masking a bug); cloud distribution → excluded regardless of hardware; disk-insufficient → hard `NOT_RECOMMENDED` regardless of RAM; deterministic (same input, same output, byte-for-byte `deepEqual`); every result carries plain-string `reasons`/`warnings`.

**MoE ≠ memory footprint**, explicitly tested: a 25.2B-total/3.8B-active model on a small mock machine (8GB RAM) rates `NOT_RECOMMENDED`, with the reason text explicitly stating active parameters affect compute speed only, not memory requirement.

**Long context** (`contextLength.native/extended >= 128K`) always carries the `LONG_CONTEXT_MEMORY_NOT_INCLUDED` warning — confirmed by test and, live, by the earlier AI-4 verification against the real dev server (`qwen3.8-27b`'s install-preview response included this exact warning).

**Estimation labeling**: every `estimatedRequirements` carries an explicit `confidenceType` (`OFFICIAL_REQUIREMENT`/`COMMUNITY_ESTIMATE`/`DERIVED_ESTIMATE`/`UNKNOWN`), surfaced in the UI as "Official requirement"/"Estimated"/"Unknown" — never presented as unqualified fact.

---

## 6. Strict Local — re-verified

`isStrictLocalMode()`/`assertCloudAllowed()` (`strict-local.js`) were **not modified** by any AI-3/4/5/6 work. Local-AI-catalog code (`local-ai-catalog.js`, `local-hardware-profile.js`, `local-model-fit.js`, `routes/local-ai.js`) never calls any cloud provider or external URL — confirmed by grep (0 `fetch(` outside the pre-existing, unmodified Free AI catalog fetcher) — so it structurally cannot bypass Strict Local; it simply has no cloud path to gate. Re-ran `test-strict-local-centralized.mjs` (still passing): research/teacher/voice routes remain correctly blocked/redirected. Re-ran `test-free-ai-routes.mjs` (still passing): the 4 explicit "zero network calls under Strict Local" tests for the Free AI Finder catalog remain green — AI-5's changes only affected client-side rendering of an already-fetched/cached response, never the fetch path itself.

Behavior under Strict Local, confirmed by code path (not re-toggled live this session, since the dev server is the user's real instance and I limited myself to read-only checks — this matches the "never test mutating/state-changing config against the real dev server" rule; the underlying logic was exhaustively unit-tested in AI-3/AI-4/AI-5 and is unchanged):
- Local catalog: works (pure in-process data, no gate needed).
- Hardware profile: works (pure local read, no gate needed).
- Installed Ollama models: works (local Ollama call, not gated by Strict Local — Ollama is always-local by design).
- Recommendations: works (batches the above two, no cloud call).
- Free AI cached catalog: works if cached (`getCachedCatalogOnly()`, unchanged).
- Free AI external refresh: blocked (`assertCloudAllowed()` on `POST /free-ai/refresh`, unchanged).
- Cloud distributions: unavailable for local install (`executionLocation !== 'LOCAL'` → 400, independent of Strict Local since cloud installs are never allowed at all in this UI, per AI-4 §17).

---

## 7. FreeLLMAPI UX — re-verified

Re-ran the 15 `freeAiRecommendations` tests + live check: default view shows ≤6 recommended providers (from a real, live 69-provider catalog, confirmed again this session via `GET /api/free-ai/providers`); "View all free APIs (69)" reveals the full list; "Show recommended only" collapses back; search/filters operate locally on already-fetched data (0 `fetch` references in `freeAiRecommendations.ts`); the `Always show all free APIs` checkbox persists via `router_settings.always_show_all_free_apis` (added to `ROUTER_SETTINGS_DEFAULTS`, merge-onto-defaults, no migration needed); temporary expansion (`expandedThisSession`, component-local `useState`) is structurally incapable of writing to the persisted setting — the only write path is the checkbox's `onAlwaysShowAllChange`.

**Performance, before/after, confirmed live this session:**
- **Before AI-5:** all 69 real providers rendered on every Settings open.
- **After AI-5 (still true this session):** ≤6 rendered by default; the other 63 provider cards, plus the entire search/filter UI, are not mounted until the user explicitly clicks "View all."

---

## 8. Network certification — traced this session

| Action | External network calls | Verified |
|---|---|---|
| Settings open (Local Models tab) | 0 | Grep: 0 `fetch(` to huggingface/github/ollama.com in any local-ai file; live: `/api/local-ai/*` calls only ever target `services.ollamaUrl` (localhost) |
| Settings open (Free AI Finder) | 0 (cache hit) | Live-verified this session: `GET /api/free-ai/providers` served from cache (`cache-info` showed `ageMs: 5921`, well under the 24h TTL) — no outbound fetch occurred |
| Explore All (local models) | 0 | Client-side filter over already-fetched `results` state, no new request |
| Free AI View All | 0 | Client-side filter/expand over already-fetched `providers` state |
| Search (either) | 0 | Local `.filter()` over in-memory arrays, confirmed by code read — no debounced/per-keystroke fetch exists |
| Filter (either) | 0 | Same |
| Manual "Actualiser les offres" (Free AI refresh) | 1 explicit fetch, if Strict Local is OFF | Unchanged pre-existing route (`POST /api/free-ai/refresh`), gated by `assertCloudAllowed()` |
| "Refresh hardware profile" button | 0 external (local hardware re-read only) | `cortexClient.localAiHardware(true)` → local `GET /api/local-ai/hardware?refresh=1`, no cloud call |

---

## 9. Performance — no regression

- Hardware detection is not re-run per card: `/api/local-ai/recommendations` calls `detectHardware({})` **once**, then evaluates every catalog entry against that single profile in-process (`filterCatalogForHardware`) — confirmed by code read of `routes/local-ai.js`, unchanged since AI-4.
- Fit engine runs in a single batch per request, not N separate calls — same evidence.
- No N-subprocess pattern: the only subprocess-shaped calls are the two fixed, Windows-only WMI/PowerShell probes in `local-hardware-profile.js` (GPU, disk), each gated behind a 60-second in-process cache (`CACHE_TTL_MS`), so repeated fit evaluations within that window don't re-invoke PowerShell at all.
- No N-network pattern: `/api/local-ai/recommendations` and `/api/local-ai/installed` each make exactly one call to local Ollama (`/api/tags`), regardless of catalog size.
- AI-6's one fix adds exactly one additional local (never external) `GET /api/local-ai/installed` call per Settings-open — a fixed cost, not a per-card or per-model cost.

---

## 10. Tests — final tally

| Suite | Count | Status |
|---|---|---|
| `test-local-ai-catalog.mjs` (AI-3) | 21 | PASS |
| `test-local-hardware-profile.mjs` (AI-3) | 9 | PASS |
| `test-local-model-fit.mjs` (AI-3) | 16 | PASS |
| `test-local-ai-routes.mjs` (AI-4) | 17 | PASS |
| `test-freellmapi.mjs` | — | PASS |
| `test-free-ai-catalog.mjs` | — | PASS |
| `test-free-ai-routes.mjs` | — | PASS |
| `test-strict-local-centralized.mjs` | — | PASS |
| `test-ai-providers.mjs` | — | PASS |
| **Backend total** | **147** | **147/147 PASS** |
| `scripts/test-local-ai-recommendations.mts` (AI-4) | 7 | PASS |
| `scripts/test-free-ai-recommendations.mts` (AI-5) | 15 | PASS |
| `scripts/test-local-models-installed-visibility.mts` (AI-6, new) | 4 | PASS |
| **Frontend pure-logic total** | **26** | **26/26 PASS** |
| **Grand total** | **173** | **173/173 PASS** |

`npx tsc --noEmit` — clean. `npm run build` — succeeds (pre-existing >500kB chunk warning, unrelated to this work, present since before AI-1).

No `npm audit fix`, `--force`, or `--legacy-peer-deps` used at any point across AI-1 through AI-6.

---

## 11. Known limitations (carried forward + new)

- **No component-level UI test framework** exists in this repo (confirmed in AI-1's audit and unchanged through AI-6) — all React component behavior was validated via code review, extracted pure-logic tests, backend route tests against an in-memory Hono app, and periodic live read-only checks against the user's actual running dev server. A regression purely in JSX structure (e.g., a badge failing to render) would not be caught by CI today.
- **Memory/VRAM estimates are mostly `DERIVED_ESTIMATE`**, not vendor-stated — only `gpt-oss-20b`/`120b` and `muse-glimmer-30b` carry `OFFICIAL_REQUIREMENT` figures in the 15-model seed catalog (unchanged since AI-3).
- **KV-cache cost for long-context models is not computed**, only flagged via warning — no reliable formula was found in AI-2's research.
- **GPU/VRAM/disk detection is Windows-only**, best-effort via WMI; non-Windows platforms and detection failures degrade to `UNKNOWN` by design, not a crash.
- **8 of 16 seed distributions remain `verified: false`** (their base name was confirmed in Ollama's library listing during AI-2, but the individual tag page wasn't fetched) — intentionally non-installable until someone re-verifies them individually.
- **The new local-model catalog and the pre-existing hardcoded `OLLAMA_RECOMMENDED_MODELS` (11 entries) remain unmerged** — both still exist side by side in Settings, per AI-4's explicit "migration progressive" scope decision, not revisited in AI-6 since unifying them was never flagged as a bug, only a future simplification.
- **`DEPRECATED`/`STALE`/`UNAVAILABLE` free-API provider status is a derived heuristic** from existing fields (`category`/`verified`/`verificationFreshness`), not an explicit upstream dataset field — the most honest signal obtainable without inventing catalog metadata (AI-5, unchanged).
- **The AI-6 bug fix (§4) adds one more Settings-open network call** (local `GET /api/local-ai/installed`) — still zero external calls, but a small addition to the local call count, documented here for transparency rather than silently absorbed.

---

## 12. Future optional work (not implemented, per mission §27)

- LM Studio as an optional secondary runtime (enum placeholders exist in the schema; no detection, no localhost:1234 probe, no UI).
- GGUF/Hugging Face advanced import mode (explicitly out of scope through all six phases).
- An explicit, user-visible "refresh model catalog" workflow for the AI-3 static seed catalog itself (today only the Free AI Finder's provider catalog has a refresh action; the model catalog is a versioned static file with `isCatalogStale()` as a signal only, no fetch path).
- Better VRAM detection (WMI's 32-bit `AdapterRAM` overflow on some high-VRAM cards is worked around by treating suspiciously small values as unknown, not by reading the true value — a more robust source, e.g. DXGI or nvidia-smi, would be a future improvement).
- A KV-cache-aware memory estimator for long-context models, replacing today's blanket warning with an actual number.
- A component-level UI test framework (Vitest + React Testing Library, or similar) — flagged as a recurring gap across AI-4, AI-5, and AI-6's certification pass.

---

## 13. Files changed across the full AI-3 → AI-6 arc

**New (AI-3):** `cortex-server/src/lib/local-ai-catalog.js`, `local-hardware-profile.js`, `local-model-fit.js`, plus 3 test files.
**New (AI-4):** `cortex-server/src/routes/local-ai.js` + its test file, `src/components/settings/LocalModelsSettingsSection.tsx`, `LocalModelCard.tsx`, `LocalModelDetails.tsx`, `src/lib/localAiRecommendations.ts` + test.
**New (AI-5):** `src/lib/freeAiRecommendations.ts` + test.
**New (AI-6):** `scripts/test-local-models-installed-visibility.mts`, this report.
**Modified, additive-only, across AI-4/5/6:** `cortex-server/src/server.js` (route registration), `cortex-server/src/lib/sqlite.js` (+1 default settings key), `src/components/modals/SettingsModal.tsx` (+~25 net lines across the whole arc, from a 3596-line baseline to 3619), `src/components/settings/FreeAiFinder.tsx` (progressive disclosure added, all pre-existing logic intact), `src/lib/cortex/client.ts` (new types + client methods, nothing existing removed), `src/components/settings/LocalModelsSettingsSection.tsx` (AI-6 bug fix).

**Never touched, across all six phases:** `src/lib/ollamaModels.ts`, `cortex-server/src/routes/ollama.js`, `cortex-server/src/lib/free-ai-catalog.js`, `cortex-server/src/routes/free-ai.js`, `cortex-server/src/lib/strict-local.js`, `cortex-server/src/lib/secret-store.js`, any MAÎTRE file, `external/MetaGPT/`, `external/OpenMontage/`.
