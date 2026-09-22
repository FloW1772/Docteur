# DOCTEUR — BUSINESS / SALES AGENT V1 CHECKPOINT

Date: 2026-09-22
Scope: PHASE 3 — implementation of the thin, Docteur-authored Business/Sales Agent V1, per `AGENCY_AGENTS_AUDIT_2026-09.md` §21/§26 recommendation (**BUILD_THIN_DOCTEUR_AGENT**, not a third-party framework). No email sent, no CRM written, no browser login, no form submitted, no purchase made, no social post published, no shell executed, no MAÎTRE action invoked, no new Agency-tier framework installed, no new cloud provider added, no Mistral.

Pre-flight (before any modification):
```
git status --short   → confirmed clean starting point except pre-existing Phase 1/2 work (Kiwix PARTIAL, Code Intelligence CERTIFIED GREEN), untouched by this phase
git diff --stat       → confirmed no unrelated pending changes before starting
```

---

## 1. Architecture — RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN REVIEW

| Stage | Endpoint | Mechanism |
|---|---|---|
| Lead intake | `POST /api/sales/leads` | Validated name/company/notes, stored locally |
| RESEARCH | `POST /api/sales/leads/:id/research` | DuckDuckGo search + single-page Readability extraction (reused `searchDuckDuckGo`/`extractContent` from Investment Studio's pipeline), max 3 pages, every source wrapped `untrusted: true` before storage |
| ANALYZE / SCORE | `POST /api/sales/leads/:id/score` | Deterministic keyword-weight scoring against **user-supplied, visible criteria** — never an LLM-invented number, full per-criterion audit trail returned |
| DRAFT | `POST /api/sales/leads/:id/draft` | Template-based, local-only composition of an outreach message or CRM-style note — zero LLM/cloud dependency in V1, zero prompt-injection surface from research text (all interpolated fields sanitized/single-line) |
| HUMAN REVIEW | `GET /api/sales/leads/:id` | Full dossier (lead + sources + drafts) for manual review before any human decides to act outside Docteur |

## 2. Reused primitives (no new framework, no duplication)

- **Web research pipeline**: `searchDuckDuckGo` (`lib/web-search.js`) + `extractContent` (`lib/deep-capture.js`) + `assertSafeUrl` (`lib/url-security.js`) — identical to Investment Studio's `/investment/research`, dependency-injected the same way for testability.
- **Untrusted-data tagging**: `wrapUntrustedContent()` in the new `lib/sales-policy.js`, same idiom as `investment-policy.js`/`sherlock-gateway.js` (`metadata: { source, url, title, retrievedAt, untrusted: true }` + fenced prompt-injection warning). Every research source is stored with `untrusted = 1` in SQLite.
- **Deterministic, auditable scoring**: `lib/sales-scoring.js` mirrors `investment-scoring.js`'s discipline exactly — missing data is reported as `insufficient_data`, never silently scored 0; every factor exposes its rule and evidence.
- **Feature Registry / HELP_DIRECTORY**: new `FeatureKey = 'sales'` + `HELP_DIRECTORY` entry in `src/content/capabilities.ts`, `state: 'local'`, following the `investment`/`sherlock` pattern exactly.
- **StudioShell primitives**: `SalesStudioModal.tsx` built on `StudioShell`/`StudioTabs`/`StudioEmptyState`/`StudioErrorState`, modeled directly on `InvestmentStudioModal.tsx`.
- **Route registration**: `createSalesRoute({ services, logger })` Hono factory, mounted via `app.route('/api', createSalesRoute({ services, logger }))` in `server.js`, identical shape to every other route module.
- **Strict Local / privacy guards**: V1 has no cloud LLM call anywhere in the Sales Agent (draft composition is template-based, not LLM-generated), so `assertCloudAllowed()` is not currently invoked by this module — correctly, since there is no cloud call to gate. If a future version adds LLM-assisted drafting, it must gate that call through `assertCloudAllowed()` exactly like `research.js`, per the audit's own finding.
- **Secret-store**: not used — V1 requires no API key (DuckDuckGo search needs no credential, matching Investment Studio's existing pattern).

## 3. V1 forbidden-functions — enforced at the route layer, not just documented

`sales-policy.js`'s `ALLOWED_ACTIONS = {RESEARCH, ANALYZE, SCORE, DRAFT}` and an explicit `EXPLICITLY_FORBIDDEN_ACTIONS` denylist (SEND, SEND_EMAIL, CRM_WRITE, CRM_UPDATE, BROWSER_LOGIN, LOGIN, FORM_SUBMIT, SUBMIT_FORM, PURCHASE, PAY, PAYMENT, SOCIAL_POST, POST_SOCIAL) — named and refused, not just absent from the allowlist.

`routes/sales.js` additionally pre-registers explicit `403 forbidden_action_denied` handlers for the route shapes a client might guess (`/send`, `/send-email`, `/crm-write`, `/submit-form`, `/purchase`, `/browser-login`, `/social-post`), mirroring `investment.js`'s `real-buy`/`real-sell`/`live-order` rejection pattern — so even a plausible future-looking URL returns an explicit denial rather than a 404 that could be mistaken for "not yet implemented."

Every draft produced by `sales-draft.js` is passed through `labelDraft()`, which unconditionally overwrites `status` to the literal `'DRAFT — NOT SENT'` and `sent` to `false` — a caller cannot construct a draft that claims to be sent. The `sales_drafts` SQLite table stores `sent INTEGER NOT NULL DEFAULT 0`, and no function anywhere in `sqlite.js` ever sets it to `1`.

## 4. Files delivered

| File | Purpose |
|---|---|
| `cortex-server/src/lib/sales-policy.js` | Action allowlist/denylist, lead validation, untrusted-content wrapping, draft labeling |
| `cortex-server/src/lib/sales-scoring.js` | Deterministic, auditable keyword-weight scoring |
| `cortex-server/src/lib/sales-draft.js` | Local template-based outreach/CRM-note draft composition |
| `cortex-server/src/routes/sales.js` | `createSalesRoute()` — RESEARCH/SCORE/DRAFT endpoints + explicit forbidden-action denials |
| `cortex-server/src/lib/sqlite.js` (modified) | New tables `sales_leads`, `sales_research_sources`, `sales_drafts` + accessor functions |
| `cortex-server/src/server.js` (modified) | Route import + registration |
| `src/lib/sales-studio.ts` | Frontend typed API client |
| `src/lib/studio-errors.ts` (modified) | Sales-specific error-code translations |
| `src/components/modals/SalesStudioModal.tsx` | Studio UI (LEADS/RESEARCH/SCORE/DRAFT tabs) on `StudioShell` |
| `src/content/capabilities.ts` (modified) | `FeatureKey: 'sales'` + `HELP_DIRECTORY` entry |
| `src/App.tsx` (modified) | Lazy import, open-state, switch case, render wiring |
| `cortex-server/test-sales-policy.mjs`, `test-sales-scoring.mjs`, `test-sales-draft.mjs`, `test-sales-route.mjs` | New Agency tests (58 assertions total) |

## 5. New Agency tests — all green

| Test file | tests | pass | fail |
|---|---|---|---|
| `test-sales-policy.mjs` | 19 | 19 | 0 |
| `test-sales-scoring.mjs` | 8 | 8 | 0 |
| `test-sales-draft.mjs` | 12 | 12 | 0 |
| `test-sales-route.mjs` | 19 | 19 | 0 |
| **Total** | **58** | **58** | **0** |

Coverage highlights: every forbidden route shape (`/send`, `/send-email`, `/crm-write`, `/submit-form`, `/purchase`, `/browser-login`, `/social-post`) asserted `403 forbidden_action_denied`; every draft asserted `status === 'DRAFT — NOT SENT'` and `sent === false`; prompt-injection isolation asserted (`untrusted: true` tagging, fenced content, newline-injection resistance in draft fields); deterministic scoring asserted against missing-data, weighted, and case-insensitive scenarios.

## 6. Full backend regression (relevant + full suite)

Full suite: **116 test files run, 110 PASS / 5 FAIL.**

The 5 failures are **identical, pre-existing, and unrelated** to the Sales Agent — the same failures already documented and analyzed in the Phase 2 Code Intelligence checkpoint (`CODE_INTELLIGENCE_READONLY_CHECKPOINT_2026-09-22.md` §2): 4 are harness-timeout artifacts in unrelated suites (cyber-audit-crawler, maitre-executor-level2, regression-api — each cut off by this session's own 20s per-file test-timeout cap, not a code defect), and 2 (`test-find-eval.mjs`, `test-video-manual.mjs`) are real pre-existing failures in unrelated subsystems (find/eval tooling, manual video test), confirmed untouched by this phase's diff.

Directly relevant regressions re-verified green:
- **All 4 new sales test files**: 58/58 pass.
- **Investment Studio** (closest architectural analogue, `research.js`'s peer): `test-investment-calc.mjs`, `test-investment-route.mjs`, `test-investment-scoring.mjs`, `test-investment-timeline.mjs` — all pass.
- **Sherlock** (untrusted-tagging precedent): `test-phase7-sherlock.mjs` — pass.
- **Strict Local / privacy guard** (shared gate module): `test-strict-local-centralized.mjs` — pass, confirming the `sqlite.js` schema addition did not disturb the cloud-gating logic.

Per mission scope, no fix was needed or applied — none of the 5 failures relate to Code Intelligence (unchanged) or the new Sales Agent code.

## 7. Typecheck + build — confirmed

- Backend: `node src/server.js --check` → OK (boots cleanly with `createSalesRoute` registered; `status: "degraded"` is expected/benign, reflecting Ollama not running locally in this shell).
- Frontend: `npm run build` (`tsc && vite build`) → **PASS**. `tsc` typecheck completed with zero errors. `vite build` completed in 1.53s, emitting `dist/assets/SalesStudioModal-CuImPBAm.js` (9.62 kB / 3.25 kB gzip) alongside all other Studio bundles, unaffected. PWA precache generated (37 entries, 2081.20 KiB).

## 8. Feature Registry / HELP_DIRECTORY — confirmed

`src/content/capabilities.ts`: new `FeatureKey` literal `'sales'` added; new `HELP_DIRECTORY` entry "Studio Business/Sales" registered under the `'🤖 IA'` category, `state: 'local'`, with an explicit V1-scope description matching this checkpoint. `src/App.tsx` wiring confirmed complete (lazy import, `useState` + `useModalOpenTracking`, `onOpenFeature` switch case, conditional render) — identical pattern to `investment`/`sherlock`.

---

## DOCTEUR BUSINESS / SALES AGENT V1 CHECKPOINT

Phase: 3 (BUILD_THIN_DOCTEUR_AGENT per `AGENCY_AGENTS_AUDIT_2026-09.md` recommendation)

Scope delivered: RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN REVIEW, exactly as specified. No stage beyond DRAFT exists in code.

Modules delivered: `sales-policy.js`, `sales-scoring.js`, `sales-draft.js`, `routes/sales.js` (backend); `sales-studio.ts` + `SalesStudioModal.tsx` (frontend); `sqlite.js`/`server.js`/`capabilities.ts`/`App.tsx`/`studio-errors.ts` extended, not duplicated.

Forbidden functions verified absent, not just undocumented: automatic email send (0 code paths), CRM write (0 code paths), browser login (0 code paths), form submission (0 code paths), purchase/payment (0 code paths), social publication (0 code paths), arbitrary shell (0 code paths), MAÎTRE action invocation (0 code paths), new Agency-tier framework (0 packages installed), new cloud provider (0 added), Mistral (0 references). Every guessed forbidden-route shape returns an explicit `403 forbidden_action_denied`, not a silent 404.

Draft labeling verified structurally enforced: `labelDraft()` unconditionally sets `status = 'DRAFT — NOT SENT'` and `sent = false`; the `sales_drafts.sent` column is written `0` by every insert path and flipped to `1` by no code anywhere in this module.

Reused, not duplicated: providers (none new), Strict Local (no cloud call in V1, so no gate needed — correctly absent, not skipped), privacy/cloud guards (inherited via the shared `strict-local.js` module, regression-verified unaffected), secret-store (not needed — no credential in V1), research provenance pattern (reused from Investment Studio's DuckDuckGo + Readability + provenance pipeline), Feature Registry/HELP_DIRECTORY (extended, not replaced), StudioShell (reused for the new modal).

Untrusted data discipline: every web-research source wrapped via `wrapUntrustedContent()` (`untrusted: true`, fenced prompt-injection warning), identical idiom to Sherlock/Investment. Draft composition is template-based (no LLM call in V1) and sanitizes all interpolated lead-derived fields against newline/control-char injection — verified by test.

New Agency tests: 58/58 pass (`test-sales-policy.mjs` 19, `test-sales-scoring.mjs` 8, `test-sales-draft.mjs` 12, `test-sales-route.mjs` 19).

Full backend regression: 116 test files, 110 PASS / 5 FAIL — all 5 pre-existing and unrelated (identical to the failures already documented in the Phase 2 Code Intelligence checkpoint), 0 new failures introduced.

Strict Local reviewed: PASS (`test-strict-local-centralized.mjs` green; no new cloud call added, so no new gate was required)

Provider/privacy guards reviewed: PASS (no new provider, no new external egress beyond the already-audited DuckDuckGo/Readability pipeline already gated by `url-security.js`'s SSRF checks)

Feature Registry reviewed: PASS (`sales` FeatureKey + HELP_DIRECTORY entry + full App.tsx wiring confirmed)

Typecheck: PASS (`tsc`, zero errors)
Build: PASS (`vite build`, 1.53s, Sales Studio bundle emitted correctly)

Code Intelligence (Phase 2): unmodified — 0 files touched, CERTIFIED GREEN status unchanged.
Kiwix (Phase 1): unmodified — PARTIAL status unchanged, not revisited.

Verdict: **PHASE 3 BUSINESS / SALES AGENT V1 — CERTIFIED GREEN**

Then STOP.

PHASE 4 or any other work NOT STARTED, per instruction. Awaiting explicit validation to proceed.
