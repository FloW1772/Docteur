# FreeLLMAPI UX — AI-5 Implementation Report

**Phase:** AI-5 — Free AI Finder Progressive Disclosure + UX
**Date:** 2026-09-21
**Status:** Frontend UX change to `FreeAiFinder.tsx` + one new persisted setting. Model Catalog (AI-3), fit engine (AI-3), Ollama integration, and LM Studio scope were not touched.

---

## 1. Default subset logic

New pure module: **`src/lib/freeAiRecommendations.ts`**, extracted so the selection logic is independently testable without mounting the component (mission §3/§26).

- **`deriveProviderStatus(provider)`** — computes `AVAILABLE | UNKNOWN | STALE | DEPRECATED | UNAVAILABLE` **entirely from existing catalog fields** (`category`, `verified`, `verificationFreshness`, which the backend already derives — see `free-ai.js`'s `verificationFreshness()`). No new field was invented in the dataset or the backend; this is a pure re-interpretation of data Docteur already has. A provider that is both unverified and long-overdue for recheck (`verificationFreshness === 'recheck' && !verified`) is treated as `DEPRECATED`; verified-but-overdue is `STALE`; anything with insufficient category/freshness data is `UNKNOWN`.
- **`selectRecommendedFreeProviders(providers)`** — deterministic, no LLM (mission §5). Ranks by an explicit, inspectable rule list (never an opaque single score): configured-in-Docteur first, then native-Docteur-provider, then `AVAILABLE` status, then `verified`, then a real non-trial free tier (`perpetual`/`renewing-quota`), then documented (`docsUrl` present), then has listed free models, then no-card-required — with `DEPRECATED`/`UNAVAILABLE` providers assigned `+Infinity` so they can never be selected regardless of any other factor. Caps at `MAX_RECOMMENDED_FREE_APIS = 6`.
- **`sortFreeProviders(providers)`** — the same ranking used for the "View all" list, with an alphabetical fallback for ties, so ordering is stable across renders (mission §17) rather than re-shuffling.
- **`filterFreeProviders(providers, filters)`** — local-only filtering (search, configured, native-only, modality, card-free); never touches the network.

This module deliberately does **not** hardcode "OpenRouter/Groq/Gemini/Cloudflare are always the best" (mission §6) — it scores whatever the current catalog snapshot contains, so a provider that was solid in AI-2's research but goes stale or unverified in a later catalog refresh naturally falls out of the ranking without any code change.

---

## 2. FreeAiFinder changes

Modified **`src/components/settings/FreeAiFinder.tsx`** additively — not rewritten. The existing search/filter/sort/card rendering logic, the `configuredProviders`/`discoverableProviders` split, the Strict Local banner, and the manual refresh button are all **unchanged** in behavior; they now activate only once the user expands to "View all" instead of always rendering.

New behavior:
- **Two view states**, exactly as the mission specifies: `showAll = alwaysShowAll === true || expandedThisSession`.
  - `expandedThisSession` (component-local `useState`, default `false`) — the **temporary** expansion from clicking "View all"; resets every time the component remounts (e.g. Settings reopened).
  - `alwaysShowAll` (prop, backed by `router_settings.always_show_all_free_apis`) — the **persistent** preference. Clicking "View all" never touches this; only the explicit checkbox does (mission §10).
- **Default view**: a "RECOMMENDED (N)" section showing `selectRecommendedFreeProviders(providers)` (≤6), computed from the **full, unfiltered** provider list — search/filters only apply once expanded.
- **"View all free APIs (N)"** button appears only when `providers.length > recommended.length` (mission §22: no button needed when the catalog already has ≤6 entries — verified by a test).
- **"Show recommended only"** button collapses back, shown only when not permanently pinned open by the persistent preference.
- Expanded view shows a `Recommended` badge on cards that are also in the recommended subset, so the two views stay visually connected.
- **`Always show all free APIs` checkbox** — unchecked by default, wired to `onAlwaysShowAllChange`.
- New status badge (`AVAILABLE`/`UNKNOWN`/`STALE`/`DEPRECATED`/`UNAVAILABLE`) rendered on every card via `deriveProviderStatus()` — `AVAILABLE` shows no badge (the common case, keeps cards clean); the others get a colored label so a stale/deprecated provider is never silently indistinguishable from a healthy one.

---

## 3. Persistent preference

Added `always_show_all_free_apis: false` to `ROUTER_SETTINGS_DEFAULTS` in `cortex-server/src/lib/sqlite.js` — the exact same merge-onto-defaults mechanism already used for every other router setting (`getRouterSettings()` spreads `ROUTER_SETTINGS_DEFAULTS` first, then the stored blob). This means:
- **No migration needed** (mission §9/§27): an existing installation's stored `router_settings` blob simply doesn't have the key yet, and the merge supplies `false` automatically — verified by the same mechanism that already handles every prior settings addition (`claude_mode`, `openai_mode`, etc., per the existing code comment).
- Persisted via the pre-existing `POST /api/router/settings` route and `cortexClient.updateRouterSettings()` — no new storage mechanism, no localStorage, matching mission §9's explicit instruction to reuse SQLite/`router_settings`/meta.
- `SettingsModal.tsx` wires `alwaysShowAll={settings.always_show_all_free_apis === true}` and an `onAlwaysShowAllChange` handler that optimistically updates local state then persists — identical pattern to the adjacent `handleToggleStrictLocal`/`freellmapi` handlers already in that file.

---

## 4. Network behavior on Settings open

**Unchanged from before AI-5** — this was already correct pre-existing behavior (confirmed by AI-1's audit and AI-3's regression suite), not something AI-5 needed to fix at the network layer: `FreeAiFinder`'s `load()` calls `cortexClient.getFreeAiProviders(false)`, which hits `GET /api/free-ai/providers` **without** `?refresh=1`. The backend route (`routes/free-ai.js`, untouched by AI-5) already serves from the 24h in-memory cache when fresh, and under Strict Local calls `getCachedCatalogOnly()` which **never** calls `fetch()` regardless of TTL (confirmed unchanged by the still-passing `test-strict-local-centralized.mjs` and `test-free-ai-routes.mjs`).

**What AI-5 actually changed for network behavior**: nothing at the request level — the same one `GET /api/free-ai/providers` call still fires once per mount. What changed is **client-side rendering volume**: previously the mount rendered every returned provider immediately (confirmed live: 69 real cards); now it renders ≤6 by default (mission §23's real target).

**Live verification** against the user's already-running cortex-server instance (read-only GET only, no mutation):
- `GET /api/free-ai/providers` → 69 real providers returned.
- `GET /api/free-ai/cache-info` → `{"cached":true,"ageMs":5921,"stale":false}` — confirming the request I just made was served entirely from the existing 24h cache, not a fresh network fetch.

---

## 5. Strict Local

Not modified — `strictLocalActive` prop, the Strict-Local banner, and the refresh button's `disabled={refreshing || strictLocalActive}` guard are all pre-existing and untouched. `deriveProviderStatus()` and `selectRecommendedFreeProviders()` operate purely on whatever provider list is already in state (which, under Strict Local, is already correctly limited to cache-only data by the unmodified backend) — there is no path by which AI-5's new logic could bypass Strict Local, since it never itself calls `fetch()` or any network API.

---

## 6. Search, filters, and rendering bounds

- Search input and the free-type/no-card/no-phone/OpenAI-compatible/modality filter buttons are unchanged in logic, now gated to render only when `showAll` is true — so they don't clutter the default recommended view, and (mission §23) the DOM for the full filter UI + full card list is not created at all until the user expands.
- Search matches locally against already-fetched data (`name`/`id`) — no per-keystroke network call, verified by the pure-function tests (`filterFreeProviders` takes only in-memory data, no `fetch` reference anywhere in `freeAiRecommendations.ts`, confirmed by grep).

---

## 7. Tests

**`scripts/test-free-ai-recommendations.mts`** (15 tests, run via `npx tsx --test`, no live server or component framework needed):
- `deriveProviderStatus`: `AVAILABLE`, `DEPRECATED` (recheck + unverified), `STALE` (recheck + verified, and separately `aging`), `UNKNOWN` (unknown freshness or null category).
- `selectRecommendedFreeProviders`: caps at 6, `DEPRECATED` never selected, deterministic across repeated calls, favors configured/native/verified/non-trial providers correctly.
- `sortFreeProviders`: alphabetical tie-break, no randomness across repeated calls.
- `filterFreeProviders`: search across name/id/bestFor/models/modalities with empty-search no-op, configured/native/modality/card-free filters.
- Empty-list edge case across all three functions.
- Security: provider metadata shaped like a prompt injection or shell command is treated as ordinary text data by both ranking and filtering, with no special handling triggered.

**Full regression** (backend, `cortex-server/`): `test-local-ai-catalog.mjs` (21), `test-local-hardware-profile.mjs` (9), `test-local-model-fit.mjs` (16), `test-local-ai-routes.mjs` (17), `test-freellmapi.mjs`, `test-free-ai-catalog.mjs`, `test-free-ai-routes.mjs`, `test-strict-local-centralized.mjs`, `test-ai-providers.mjs` — **147/147 passing**, 0 failures.

**Full regression** (frontend pure logic, `npx tsx --test`): `scripts/test-local-ai-recommendations.mts` (7, AI-4) + `scripts/test-free-ai-recommendations.mts` (15, AI-5) — **22/22 passing**.

`npx tsc --noEmit` — clean. `npm run build` — succeeds.

No `npm audit fix`, `--force`, or `--legacy-peer-deps` used.

**Not independently tested via a component framework** (none exists in this repo, same gap noted in AI-4's report): the JSX wiring of `showAll`/`expandedThisSession`/the checkbox was verified by careful code reading plus the live read-only check in §4, not by a mounted-component test. This mirrors AI-4's precedent for the same structural reason.

---

## 8. Security

- **No secret leak**: `FreeAiProvider.configuredInDocteur` remains the only Docteur-state field ever sent to the frontend for a provider (unchanged — `attachDocteurState()` in `routes/free-ai.js` was not touched); no API key, secret, or token is newly exposed by AI-5's additions. The new status/recommendation logic reads only fields already present in the existing `FreeAiProvider` type.
- **Metadata as data**: provider `name`/`bestFor`/`notes` strings flow through React's default escaping in `ProviderCard`, same as before AI-5; the new recommendation ranking treats them as opaque strings for search-matching only (verified by the injection-shaped-text test in §7).
- **No provider auto-testing**: `selectRecommendedFreeProviders`/`deriveProviderStatus`/`filterFreeProviders` never call `fetch`, never hit a provider's own API, never validate credentials — confirmed by grep (zero `fetch(` in `freeAiRecommendations.ts`).

---

## 9. Performance

- **Initial provider cards rendered**: reduced from "all returned providers" (69, live-verified) to **≤6** by default — the mission's core target (mission §4/§23).
- The full filter UI (search input + 4+ filter buttons + modality buttons) is also not mounted until expansion, reducing initial DOM size further.
- No new network round-trip was introduced; the same single `GET /api/free-ai/providers` call still powers both the recommended and full views from one in-memory response — expansion is a pure client-side render change, not a second fetch.

---

## 10. Known limitations

- `deriveProviderStatus`'s `DEPRECATED`/`UNAVAILABLE`/`STALE` distinction is a **derived heuristic**, not a field the upstream `free-llm-api-hub` dataset actually provides (confirmed in AI-2's research: the dataset has no explicit lifecycle-status field). It is the most honest signal obtainable from existing data (`category`/`verified`/`verificationFreshness`) without inventing new catalog metadata, per the mission's explicit instruction not to guess — but it means a provider that quietly went from "documented and free" to "actually retired" without its `last_verified` date changing would not be caught until the upstream dataset itself reflects that.
- `UNAVAILABLE` status is defined in the type but currently unreachable from the real dataset's fields (no field maps to it today) — it exists so the enum is forward-compatible if the upstream schema or Docteur's own catalog ever gains an explicit availability flag, without requiring another type change later.
- The recommendation ranking's weights (the `rank()` function in `freeAiRecommendations.ts`) are a simple additive rule list, not a formally validated model — this matches the mission's explicit preference for an inspectable, non-opaque scoring approach over a black-box one, but means the exact ordering among near-tied providers is a design choice, not a provably optimal one.
- No component-level UI test exists for the `showAll`/checkbox interaction itself (same gap as AI-4, no framework in this repo) — validated via code review and one live read-only check against the real running server, not an automated click-through test.
- The persisted preference is a boolean only; there's no per-provider "always show even if usually hidden" override — matches the mission's exact spec (one global "Always show all" toggle), not an omission.

---

## 11. Files changed

Modified (additive):
- `src/components/settings/FreeAiFinder.tsx` — new imports, two new optional props (`alwaysShowAll`, `onAlwaysShowAllChange`), one new local state (`expandedThisSession`), recommended-subset computation, progressive-disclosure gating of the existing search/filter/full-list rendering, status badge on cards, persistent-preference checkbox. All pre-existing logic (search, filters, sort, configured/discoverable split, Strict Local banner, manual refresh) left intact.
- `src/components/modals/SettingsModal.tsx` — `<FreeAiFinder>` usage extended with the two new props, following the existing `updateRouterSettings` optimistic-update pattern used elsewhere in the same file.
- `cortex-server/src/lib/sqlite.js` — one new key (`always_show_all_free_apis: false`) added to `ROUTER_SETTINGS_DEFAULTS`.
- `src/lib/cortex/client.ts` — `RouterSettings` interface extended with the optional `always_show_all_free_apis` field.

New:
- `src/lib/freeAiRecommendations.ts` — pure selection/sort/filter/status logic.
- `scripts/test-free-ai-recommendations.mts` — 15 tests for the above.
- `reports/FREELLMAPI_UX_AI5_2026-09.md`

Not touched: Model Catalog (AI-3: `local-ai-catalog.js`, `local-hardware-profile.js`, `local-model-fit.js`), `routes/local-ai.js`, `LocalModelsSettingsSection.tsx`/`LocalModelCard.tsx`/`LocalModelDetails.tsx` (AI-4), `routes/ollama.js`, `src/lib/ollamaModels.ts`, `free-ai-catalog.js`, `routes/free-ai.js`, `strict-local.js`, any MAÎTRE file, `external/`.
