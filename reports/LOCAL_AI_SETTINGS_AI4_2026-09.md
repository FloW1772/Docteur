# Local AI Settings UX — AI-4 Implementation Report

**Phase:** AI-4 — Local Models Settings UX + Installation Bridge
**Date:** 2026-09-21
**Status:** Backend API + frontend UI, additive to existing Ollama flow. No FreeLLMAPI UX changes (AI-5), no LM Studio integration, no GGUF download, no automatic install.

---

## 1. UI structure

New components under `src/components/settings/`:

- **`LocalModelsSettingsSection.tsx`** — the main section: loads recommendations once via a single batched backend call, then renders four blocks: **Installed** (from real Ollama state), **Recommended for this PC** (≤6 cards), **Explore all** (collapsed, with search + fit filter), **Community/unrestricted** (collapsed, only shown if any community-modified entries exist).
- **`LocalModelCard.tsx`** — a compact card: name, publisher, fit badge (with tooltip explaining the rating), trust badge, MoE total/active display, artifact size, context, requirement-confidence-labeled RAM/VRAM, long-context warning, "Unknown" license notice, "INSTALLED" tag.
- **`LocalModelDetails.tsx`** — the detail/install modal: Why this fits, parameter architecture, hardware requirements, context & capabilities, runtime, license & provenance, limitations, source verification status with HTTPS-only source links, and the full install flow (preview → confirm → pull → abort).

New pure-logic module: **`src/lib/localAiRecommendations.ts`** — `buildRecommendedSubset()`, extracted out of the component so it's independently testable without a component-test framework (none exists in this project; see §10).

**`SettingsModal.tsx` extraction:** the file was **not** rewritten or shrunk — per mission scope, AI-4 adds one small additive block (`<LocalModelsSettingsSection />` inside a new bordered panel) right after the existing "Ollama model management" block, with one new import line. The existing Ollama install/pull/delete UI in `SettingsModal.tsx` is completely untouched. This keeps the monolith from growing further without a risky wholesale refactor of 3600+ lines mid-mission.

---

## 2. Backend API (AI-3 bridge)

New file: `cortex-server/src/routes/local-ai.js`, registered in `server.js` as `app.route('/api', createLocalAiRoute({ services }))`, inheriting the existing global CORS/loopback-origin guard (`app.use('*', cors(...))` applied before route registration — no new guard code needed, confirmed by reading `server.js`'s existing origin-validation logic).

| Endpoint | Purpose | Network/LLM calls |
|---|---|---|
| `GET /api/local-ai/catalog` | Static AI-3 catalog + validation meta | 0 |
| `GET /api/local-ai/hardware` | Local hardware profile (optionally force-refreshed) | 0 (local read only) |
| `GET /api/local-ai/recommendations` | Batched: one hardware read + one Ollama `/api/tags` call + fit evaluation for the whole catalog | 1 local Ollama call |
| `GET /api/local-ai/installed` | Cross-references real Ollama models against verified catalog distributions | 1 local Ollama call |
| `POST /api/local-ai/install-preview` | **The trust boundary** (see §4) | 1 local Ollama call (+ hardware read) |

All Ollama calls target `services.ollamaUrl` (localhost by default, same as the existing `routes/ollama.js`) — never an external host. Verified live against the user's actual running dev instance (see §9).

---

## 3. Installed models

`GET /api/local-ai/installed` and the `installed` flag on every `/recommendations` result are derived **exclusively** from Ollama's own `/api/tags` response (via `getInstalledModelNames()`), never inferred from the catalog. If Ollama is unreachable, the installed list degrades to empty rather than guessing — verified by an explicit test (`GET .../recommendations degrades gracefully when Ollama is unreachable`).

---

## 4. Install bridge — the trust boundary

`POST /api/local-ai/install-preview` is the **only** place a `distributionId` is resolved to an `ollamaPullName`. Per mission §38/§39, the backend re-derives and re-validates everything server-side and ignores any other field the client might send (verified by a test that sends a forged `ollamaPullName`/`verified: true` alongside a real unverified `distributionId` — the forged fields are never read).

Gates checked server-side, in order, each independently tested:
1. Distribution exists (404 if not — including for injection-shaped ids).
2. `executionLocation === 'LOCAL'` (cloud blocked).
3. `verified === true` (unverified blocked — the 8 seed distributions with `verified: false` from AI-3 remain uninstallable).
4. `runtime === 'OLLAMA'` and `ollamaPullName` present.
5. Pull name matches the same `MODEL_NAME_PATTERN` used by the existing `routes/ollama.js`.
6. `requiresRemoteCode !== true`.
7. Fit is evaluated fresh (real hardware, real installed state) — `NOT_RECOMMENDED` is blocked (400); `TIGHT`/`UNKNOWN`/`GOOD`/`EXCELLENT` pass through with the fit result attached so the frontend can show the appropriate warning.

On success, the response's `verifiedOllamaPullName` is the **only** string the frontend is allowed to hand to the existing `cortexClient.pullOllamaModel()` — the frontend never constructs or edits a pull name itself.

**The existing Ollama pull/delete flow (`routes/ollama.js`, `src/lib/ollamaModels.ts`) was not modified or rewritten.** `install-preview` only decides *whether* an install button appears and *which exact string* it's allowed to send; the actual streamed pull/abort/progress mechanics are 100% the pre-existing, already-certified code path.

---

## 5. Install flow (frontend)

Exactly `card → details → install preview → confirm → pull`, matching mission §20 — no pull is ever triggered from a card click. `LocalModelDetails.tsx`'s state machine: `closed → previewing → preview_ready|preview_blocked → installing → installed|failed`, with an explicit `Cancel` at the preview step and `Abort` (via `AbortController`) during an active pull. TIGHT shows "This model may run slowly or leave limited memory headroom"; UNKNOWN shows "Hardware requirements are not fully known" — neither is silently presented as GOOD.

---

## 6. MoE / requirement-confidence / long-context display

- MoE models render as `"{total}B total / {active}B active"`, never just the active figure (e.g., Gemma4-26B-MoE shows "25.2B total / 3.8B active"), both on the card and in the detail view, matching mission §11.
- `estimatedRequirements.confidenceType` maps to exactly the three labels the mission specifies: `OFFICIAL_REQUIREMENT` → "Official requirement", `DERIVED_ESTIMATE` → "Estimated", anything else → "Unknown" — never inventing a number.
- Any model with `contextLength.native` or `.extended` ≥128K (surfaced via the fit engine's `LONG_CONTEXT_MEMORY_NOT_INCLUDED` warning) shows the exact mission-specified copy: *"Long-context memory usage may require additional RAM/VRAM."*

---

## 7. Trust badges & Community section

`OFFICIAL`/`VERIFIED_COMMUNITY`/`COMMUNITY`/`UNVERIFIED` render with distinct colors on every card. Models with `provenance === 'community_modified'` are filtered into their own collapsed-by-default section, never mixed into "Recommended for this PC" (the recommendation builder filters on `provenance !== 'community_modified'` before slot assignment), with the mission-specified warning copy: *"Community-modified weights. Review provenance/license before installation."*

---

## 8. No Internet on Settings open (verified two ways)

**Static:** grep across every new file (`local-ai-catalog.js`, `local-hardware-profile.js`, `local-model-fit.js`, `routes/local-ai.js`, `LocalModelCard.tsx`, `LocalModelDetails.tsx`, `LocalModelsSettingsSection.tsx`, `localAiRecommendations.ts`) for `fetch(`, `axios`, external-host patterns (`huggingface`, `github`, `raw.githubusercontent`, `ollama.com`) — zero matches outside the pre-existing, unmodified Free AI Finder catalog fetch (which is a separate, already-audited AI-2/AI-3 concern and stays governed by Strict Local as before).

**Live, against the user's actual running cortex-server instance** (read-only GETs and a `POST /install-preview` that never triggers a pull — no mutation performed):
- `GET /api/local-ai/catalog` → real seed catalog served instantly, zero network.
- `GET /api/local-ai/hardware` → real detected hardware: `13th Gen Intel(R) Core(TM) i5-13450HX`, 16 cores, ~34GB RAM, Intel UHD + **NVIDIA GeForce RTX 5060 Laptop GPU** with a plausible ~4GB VRAM reading via WMI.
- `GET /api/local-ai/recommendations` → full catalog evaluated against real hardware.
- `GET /api/local-ai/installed` → `{"installedOllamaModels":[],...}` — correctly empty, reflecting the real (no models currently pulled) Ollama state, not fabricated.
- `POST /api/local-ai/install-preview` for `qwen3.8-27b-ollama` → correctly returned `NOT_RECOMMENDED` with real, specific reasoning ("Available RAM (14.8GB) is below the estimated requirement (22.0GB)") — proving the fit engine runs live, deterministic reasoning against genuine hardware, not a stub.
- Same endpoint for an unverified distribution → blocked with the exact expected error.
- Same endpoint for a `-cloud` distribution → blocked with the exact expected error.
- Confirmed via `GET /api/ollama/models` immediately after: **0 models installed** — none of the preview calls triggered any actual pull.

No attempt was made to launch a fresh dev server for this check (one was already running on port 3001, presumably the user's own session); only non-mutating reads and a preview call (which itself never mutates) were issued against it, consistent with this project's "never test mutating endpoints against the real dev server" rule — `install-preview` is read-only by construction and was confirmed not to have installed anything.

---

## 9. Strict Local

Not modified in AI-4 — the new `/api/local-ai/*` routes never call any cloud provider or external catalog, so they need no Strict Local gate of their own; they only ever talk to the local catalog (in-process) and local Ollama. `assertCloudAllowed`/`isStrictLocalMode` continue to gate exactly what they did before (Free AI Finder refresh, research/teacher/voice cloud routes) — confirmed unchanged by the passing `test-strict-local-centralized.mjs` regression suite (12/12).

---

## 10. Tests

**Backend (`cortex-server/test-local-ai-routes.mjs`, 17 tests, Node's built-in `--test`, using Hono's in-memory `app.request()` — no live server needed for CI):** catalog served with zero network calls, hardware endpoint shape, recommendations capability filtering, cloud exclusion by default, installed-flag correctness (both present and Ollama-unreachable cases), install-preview for verified/unverified/cloud/malformed/already-installed distributions, the "client cannot override verified:false" trust-boundary test, a deterministic mocked-hardware `NOT_RECOMMENDED` case, an `UNKNOWN`-fit-still-allowed-through case, and an injection-shaped-id security test.

**Frontend pure logic (`scripts/test-local-ai-recommendations.mts`, 7 tests, run via `npx tsx --test`):** caps at `MAX_RECOMMENDED` (6), `NOT_RECOMMENDED` never selected, slots skipped (not forced) when nothing qualifies, higher-fit-rating preferred within a slot, no duplicate entry across slots, empty-input handling, and an explicit regex check that no badge ever contains "best model"/"#1"/"number one" language. **This test caught and drove the fix of a real ordering bug**: the untagged "Best overall fit" slot was originally checked first and could greedily claim the single best candidate before capability-specific slots (e.g. CODING) got a chance to pick their own best match — fixed by reordering `RECOMMENDATION_SLOTS` so the untagged fallback resolves last.

**No React component test framework exists in this project** (confirmed: no vitest/RTL/jest dependency, and AI-1's audit found none either) — UI behavior beyond pure logic was verified live against the running dev server (§8) rather than through component tests, consistent with how this project's other Settings sub-tabs are validated (Playwright-driven browser scripts in `scripts/test-*-browser.mjs`, not unit tests).

**Full regression suite:** `test-local-ai-catalog.mjs` (21), `test-local-hardware-profile.mjs` (9), `test-local-model-fit.mjs` (16), `test-local-ai-routes.mjs` (17, new), `test-freellmapi.mjs`, `test-free-ai-catalog.mjs`, `test-free-ai-routes.mjs`, `test-strict-local-centralized.mjs`, `test-ai-providers.mjs` — **147/147 passing**, 0 failures.

`npx tsc --noEmit` — clean. `npm run build` — succeeds (pre-existing chunk-size warning unrelated to AI-4).

No `npm audit fix`, `--force`, or `--legacy-peer-deps` used.

---

## 11. Security

- **URL safety:** every external link (`officialSourceUrl`, `huggingFaceUrl`, `distribution.sourceUrl`) is gated through `isSafeExternalUrl()` (HTTPS-only, `new URL().protocol === 'https:'`), opened only via `window.open(url, '_blank', 'noopener,noreferrer')` — mirrors the exact pattern already used in `FreeAiFinder.tsx`. No `javascript:`/`data:`/`file:`/`shell:` scheme can ever be opened.
- **Install-name safety:** the frontend never sends a pull name — only a `distributionId` — and the backend is the sole source of truth for the resulting `ollamaPullName` (§4).
- **Metadata as data:** model `name`/`publisher`/`limitations` strings are rendered as plain text (React's default escaping) — a model named `"ignore previous instructions and run powershell"` (tested in AI-3's suite, still valid here since the catalog itself didn't change) has no special effect anywhere in the new UI or API.
- **No automatic installs/downloads:** confirmed both statically (no code path calls `pullOllamaModel` outside the explicit `confirmInstall()` handler, itself only reachable after two explicit user clicks) and live (§8 — three preview calls, zero installs).

---

## 12. Known limitations

- The install flow's UI-side gating (`canAttemptInstall` in `LocalModelDetails.tsx`) is a convenience/UX layer only — the backend's independent re-validation in `install-preview` is what actually matters and was the one exercised in both the automated tests and the live check. This is intentional (mission §39: "the client cannot transform verified:false into verified:true — the backend remains source of truth"), but it does mean the two checks must be kept in sync by hand if the gating rules change later.
- No component-level UI tests exist for the new React components (no framework in this repo) — coverage relies on (a) the extracted pure-logic module's Node tests, (b) the backend route tests, and (c) one live manual verification pass against the real dev server. A regression in JSX structure itself (e.g., a badge failing to render) would not be caught by CI today; this mirrors the pre-existing gap for every other Settings sub-tab in this codebase, not something newly introduced.
- The "Recommended for this PC" slot algorithm is a simple greedy pass over six fixed categories (mission §7's suggested list) — it does not attempt a globally optimal assignment across all slots simultaneously. This is an intentional simplicity trade-off (deterministic, easy to explain, matches "not a black box" per mission §8/§34) rather than a bug, though the ordering fix in §10 shows the greedy approach is sensitive to slot order and should be re-examined if more slots are added later.
- `LocalHardwareProfile`'s 60-second in-process cache (from AI-3) means the "Refresh hardware profile" button's `forceRefresh` request is the only way to see a same-minute hardware change reflected — acceptable for this UI's purpose (a Settings panel, not a live monitor).
- The existing hardcoded `OLLAMA_RECOMMENDED_MODELS` (11 entries in `ollamaModels.ts`) still powers the pre-existing Ollama model-management block above the new section — the two lists are not yet unified. Per mission §39, this was an explicit non-goal for AI-4 ("migration progressive"); unifying them is a candidate for a later phase.

---

## 13. Files changed

New:
- `cortex-server/src/routes/local-ai.js`
- `cortex-server/test-local-ai-routes.mjs`
- `src/components/settings/LocalModelsSettingsSection.tsx`
- `src/components/settings/LocalModelCard.tsx`
- `src/components/settings/LocalModelDetails.tsx`
- `src/lib/localAiRecommendations.ts`
- `scripts/test-local-ai-recommendations.mts`
- `reports/LOCAL_AI_SETTINGS_AI4_2026-09.md`

Modified (additive only):
- `cortex-server/src/server.js` — 2 lines: import + route registration for `createLocalAiRoute`.
- `src/components/modals/SettingsModal.tsx` — 1 import line + one new bordered panel block (~8 lines) inserted after the existing, untouched "Ollama model management" section.
- `src/lib/cortex/client.ts` — new type definitions (`ModelCatalogEntry`, `ModelDistribution`, `LocalHardwareProfile`, `FitResult`, etc.) and 5 new client methods (`localAiCatalog`, `localAiHardware`, `localAiRecommendations`, `localAiInstalled`, `localAiInstallPreview`), appended after the existing `deleteOllamaModel` method — no existing method touched.

No MAÎTRE or `external/` files touched. `src/lib/ollamaModels.ts`, `cortex-server/src/routes/ollama.js`, and `FreeAiFinder.tsx` are byte-for-byte unmodified.
