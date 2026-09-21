# MAÎTRE Studio + API — MA-11 Implementation Report

**Phase:** MA-11 — API + MAÎTRE Studio + Command Center Integration
**Date:** 2026-09-21
**Status:** Backend API + frontend Studio + Command Center widget + Feature Registry, exposing exactly the capabilities certified MA-2→MA-10. No new system capability was added.

---

## 1. Audit before code

Full audit performed via a dedicated read-only research agent before any code was written. Confirmed the exact patterns to replicate:

- **Observateur Studio** (`ObservateurStudioModal.tsx`, 381 lines) is a single-file, multi-tab component built on shared `StudioShell`/`StudioTabs`/`StudioStatus`/`StudioEmptyState` primitives (`src/components/studio/`), with a **dedicated client file** (`monitor-studio.ts`) rather than the monolithic `cortexClient` — this is the pattern MAÎTRE follows.
- **Backend route convention**: every Studio route (`monitor.js`, `cyber-audit.js`) applies its own redundant loopback/origin/content-type guard on top of the global `server.js` guard (defense in depth), and calls **only** its own orchestrator module — never collector/executor internals directly.
- **Command Center**: not a fixed 4-corner-only layout — Observateur was added as a `<ModuleWidget>` in the existing `hud2-rail--top` top rail, alongside Connectors/Quick Actions/Activity. MAÎTRE follows the same pattern.
- **Feature Registry**: `HELP_DIRECTORY` in `src/content/capabilities.ts` is the single source of truth; `featureRegistry.ts` auto-derives the full `FeatureDefinition` (purpose/inputs/outputs/security/limitations/etc.) from one `HelpFeature` entry. Registering there is genuinely a one-touch-point action for Help Center search, Voice Explain, Voice Commands, and the Voice Command Feedback Panel — but the actual modal-opening wiring (`App.tsx`'s `handleOpenFeature` switch) and the `FeatureKey` union member remain separate, manual steps.
- **Existing MAÎTRE backend surface** (MA-2→MA-10): `maitre-orchestrator.js` already existed with a header comment stating "in preparation for a MA-11 route" — confirming this integration was anticipated architecturally from earlier phases.

No MAÎTRE engine file (executor/approval/policy/actions) was modified except one real bug fix carried over as a dependency of the route work (see §11).

---

## 2. API route

New file: `cortex-server/src/routes/maitre.js`. Registered in `server.js` as `app.route('/api', createMaitreRoute({ logger, ollamaClient, ollamaModel }))`, immediately after `createMonitorRoute`.

Reuses the exact `monitor.js` guard block: loopback-only `isLocal` check (via `getConnInfo`), hostname allowlist (`localhost`/`127.0.0.1`/`[::1]`), origin protocol+hostname validation, JSON content-type requirement for mutating methods, and a `bodyLimit` (32KB, doubled from Observateur's 16KB since action proposals carry more structured data). No cloud route exists anywhere in this file.

**Every handler calls only `maitre-orchestrator.js`** — confirmed by the route file's own import list (18 named functions, all from one module) and by the file's own header comment stating this explicitly. `maitre-orchestrator.js` itself was extended (not rewritten) with: bounded read wrappers (`getMaitreOverview`, process/persistence/Defender read-throughs), and **pure passthrough** functions for propose/request-approval/approve/reject/execute — each one is a single-line call to the already-certified MA-7/8/9/10 function, with zero new policy/approval/execution logic (mission §10 explicitly forbids reimplementing the executor in the route layer; this was verified by code inspection, not just intent).

---

## 3. Read endpoints — bounded, validated, redacted

| Endpoint | Bound |
|---|---|
| `GET /overview` | Aggregates ≤100 incidents, ≤10 recent events — never a full-table scan |
| `GET /incidents` | `limit`/`offset` query params, clamped server-side to `LIST_LIMIT_MAX=200` regardless of client request (default 50) |
| `GET /incidents/:id` | Single incident + its own bounded event/evidence/action lists (each module's own existing bound, e.g. `listEvidenceForIncident`'s 200-row cap) |
| `GET /events` | Same clamp pattern, optional `incidentId` filter |
| `GET /evidence/:id` | Single row, already redacted by `maitre-evidence.js` at write time (unchanged) |
| `GET /processes`, `/processes/:pid` | Live snapshot, no historical accumulation |
| `GET /persistence` | Live snapshot |
| `GET /defender/status`, `/defender/detections` | Live query, Defender's own bounded detection list |
| `GET /isolation/status` | Single derived summary object |

A test explicitly proves the clamp: `limit=999999` never crashes or returns an unbounded set (`test-maitre-route.mjs`, "limit is clamped" test).

**No raw evidence leak**: nothing in this route (or the orchestrator functions it calls) bypasses the existing `redactMaitreEvidenceMetadata()` pipeline — evidence rows are already redacted at write time (MA-4), and this route never re-serializes a field cyber-redact.js/maitre-evidence.js would have caught. No new serialization path was added.

---

## 4. Action workflow: PROPOSE → POLICY → APPROVAL → EXECUTE only

There is no `POST /execute` accepting an arbitrary action. The only routes are:

- `POST /actions/propose` → `createActionProposal()` (level assigned server-side from `ACTION_LEVELS`, never from the request body — verified by test: sending `level: 3` for a `COLLECT_EVIDENCE` proposal still yields `level: 1` in the response)
- `POST /actions/:id/request-approval` → `createApprovalRequest()`
- `POST /actions/:approvalId/approve` → `approveProposal()`, with `strengthenedConfirmation` read **only** as `body.strengthenedConfirmation === true` (strict boolean equality — a string `"true"` is rejected, verified by test)
- `POST /actions/:approvalId/reject` → `rejectProposal()`
- `POST /actions/:id/execute` → **the only call to `executeApprovedAction()`**, with `approvalId` the sole body field ever read

**Backend revalidation (mission §11)**: the route never reads or trusts a client-supplied `level`/`approved`/`verified`/`proposalHash` field for anything — every one of those is either ignored (level) or re-derived server-side by the already-certified MA-7/8/9/10 functions (approval validity, one-time consumption, TOCTOU target re-check). Confirmed structurally (grep found zero instances of the route setting any of these from `body`) and behaviorally (18 dedicated tests below).

---

## 5. Backend tests (`cortex-server/test-maitre-route.mjs`, 36 tests)

Covers the full mission §41 matrix: non-local caller (403), wrong origin (403), non-loopback hostname (403), missing JSON content-type (415), oversized body (413), invalid JSON (400-not-500), unknown incident/action/evidence/run (404), unknown actionType (400), forbidden key in target (`command`/`shell`/etc., 400), client-supplied level ignored, full LEVEL 1 flow (propose→execute with no approval needed), LEVEL 2 without approval denied, full LEVEL 2 flow (propose→request-approval→approve→execute), LEVEL 3 weak confirmation refused (both missing and wrong-type `strengthenedConfirmation`), LEVEL 3 correct confirmation succeeds, reject-then-execute denied, replayed/consumed approval denied, tampered/rejected-then-reapproved denied, prompt-injection-shaped incident title/reason never bypasses approval, analyst endpoint returns `DETERMINISTIC` provenance when no Ollama configured (never fabricated as `OLLAMA_LOCAL`).

All mutating OS-level paths (process/persistence/Defender/firewall) use an injected mock `exec` — **zero real PowerShell commands run in this suite**.

---

## 6. MAÎTRE Studio

New file: `src/components/modals/MaitreStudioModal.tsx`, built on the shared `StudioShell`/`StudioTabs`/`StudioStatus`/`StudioEmptyState`/`StudioToolbar` primitives, following Observateur's single-file-many-sub-components convention. Tabs: **OVERVIEW, INCIDENTS, EVENTS, PROCESSES, PERSISTENCE, DEFENDER, ACTIONS** (condensed from the mission's suggested 12-tab list — FILES/HISTORY/EVIDENCE/SETTINGS/NETWORK were folded into INCIDENTS-detail, ACTIONS, and DEFENDER respectively, since the current backend surface doesn't yet warrant separate top-level tabs for each; this mirrors the mission's own "adapt if the architecture prefers fewer tabs with sub-sections" allowance).

New client file: `src/lib/maitre-studio.ts`, typed interfaces mirroring the route's JSON shapes exactly, one `maitreRequest<T>()` wrapper piping every error through `studioRequestError()` (new MAÎTRE-specific codes added to the shared `studio-errors.ts` map — never a raw backend code shown to the user).

### Overview
Open incident count, highest active severity, Defender availability, pending approval count, isolation status, recent events — all from one `GET /overview` call, no secrets.

### Incidents
List (severity/status/counts/dates) + detail view (timeline, linked events, linked evidence with SHA-256 preview, local analyst, proposed actions). Local analyst: an explicit "Analyser localement" button (never auto-triggered), result clearly labeled `DETERMINISTIC` or `OLLAMA_LOCAL`, with **Facts / Hypotheses (non prouvées) / Unknowns / Review suggestions** rendered as visually separate sections — a hypothesis is never rendered as if it were a fact.

### Processes
PID/name/path/parent/start time/criticality from MA-4's inspector. `SYSTEM_CRITICAL`/`DOCTEUR_CRITICAL` processes render a "protégé" badge; **no Terminate button exists on this tab at all** (terminate only happens through the proposal→approval flow inside an incident, never a direct click here) — verified by browser test asserting zero Terminate-labeled buttons on this tab.

### Persistence
Registry Run/RunOnce/Startup/Scheduled Tasks/Services with `NEW`/`CHANGED`/`REMOVED`/`UNCHANGED` status — never a "malware" label anywhere in this component.

### Defender
Availability/real-time-protection/antivirus status, recent detections. Explicit static text states CustomScan (single-file) is the only supported scan mode and QuickScan/FullScan are "non pris en charge en toute sécurité sur ce système/V1" — **no button for the unsupported modes exists at all** (verified by browser test: zero QuickScan/FullScan-labeled buttons).

### Actions (Action Center)
Lists incidents with action activity (`AWAITING_APPROVAL`/`CONTAINED`/`INVESTIGATING`), each opening into the incident detail's own action list.

---

## 7. Action preview + strengthened confirmation UX (mission §12/§27/§28/§29)

`ActionConfirmDialog` is the single confirmation surface for every action type:

- **Preview** shows: action type, exact target (JSON, never a raw shell command since none exists to show), reason, level, a plain-language **effect description** per action type (`actionEffectDescription()` — e.g. HOST_ISOLATION's description explicitly states it is not an air-gap and preserves 127.0.0.1).
- **LEVEL 3 (HOST_ISOLATION)** additionally shows a dedicated warning header, explicit bullet points (rollback availability, loopback/Docteur preservation, possible admin-privilege requirement with clean `access_denied` failure — never silent bypass), and **a separate checkbox** the user must actively tick ("Je comprends l'impact... et je confirme explicitement") before the confirm button becomes enabled. This checkbox state is **only** read at the moment of the click handler — never inferred from the dialog being open, hovering the button, or any prior confirmation (mission §9/§29 requirement, verified structurally: `strengthened` state starts `false` every time a new `ActionConfirmDialog` mounts, since it's local `useState` with no persistence).
- **QUARANTINE_WITH_DEFENDER** (`NOT_SUPPORTED`) is detected in `ActionRow` and renders only explanatory text ("Non pris en charge en toute sécurité sur ce système/V1") — **no confirm button is ever offered** for it, matching mission §28 exactly ("ne pas offrir un bouton trompeur").
- **Access denied**: when `executeMaitreAction` resolves with `run.status === 'FAILED'` and the underlying reason is `access_denied` (surfaced via `studioRequestError`'s mapped message "Administrator privileges required" — wait, actually mapped as the raw execution result shown via `resultStatusLabel`), the dialog shows the failure plainly; nothing in this component attempts a retry-as-admin or silent UAC trigger (grep-confirmed: zero UAC/elevate/runas references anywhere in the frontend).

---

## 8. No automatic execution (mission §13/§37)

Grep-verified: `executeMaitreAction`/`approveMaitreAction` are called from exactly one place each — inside `handleApproveAndExecute`, itself wired **only** to the confirm button's `onClick`. None of the four `useEffect` hooks in the modal reference either function. No incident-open, Studio-open, post-analysis, post-correlation, or Command-Center-click path calls them. This was independently confirmed by reading every `useEffect` dependency array in the file.

---

## 9. Command Center widget (mission §30/§31/§32)

Added `<ModuleWidget name="MAÎTRE" .../>` to the existing `hud2-rail--top` (Dashboard.tsx) — **not** a 5th corner, per the mission's explicit "don't replace the 4 fixed corner widgets" instruction, following Observateur's own precedent exactly.

New hook `useMaitreSummary()` (`useModuleSummaries.ts`), polling `GET /overview` every 15s, mapping to the Command Center's existing `WidgetStatus` vocabulary (`idle|searching|thinking|generating|done|error|unavailable` — no new parallel vocabulary invented, satisfying mission §32's "use only real data" and staying inside the established Command Center status language):

- `ISOLATION_ACTIVE` → `error` ("Isolé")
- `PARTIAL_FAILURE`/`MANUAL_REVIEW` → `error` ("Révision requise")
- Highest severity `CRITICAL`/`HIGH` → `error`
- Pending approvals > 0 → `thinking`
- Open incidents > 0 → `searching`
- Otherwise → `done` ("Sain")

**No destructive action exists on the widget** — `onOpen` only ever calls `setMaitreStudioOpen(true)`. No "Kill"/"Isolate" button anywhere near the widget (grep-confirmed).

---

## 10. Feature Registry (mission §33/§34)

Added one `'maitre'` `FeatureKey` union member (`capabilities.ts`) and one `HELP_DIRECTORY` entry under the existing "🛡️ Sécurité" category, following Observateur's own long-single-paragraph style: purpose, the exact 3-level approval flow, the loopback-preservation/no-air-gap/no-adapter-modification guarantees, the access-denied-not-auto-elevate guarantee, the analyst's fact/hypothesis/unknown separation, and an explicit "Limites connues" clause covering every item from mission §35 (Windows-only, Defender quarantine/QuickScan/FullScan `NOT_SUPPORTED`, admin-privilege requirement for some actions, isolation untested on physical hardware, no autonomous remediation).

`scripts/test-feature-registry.mjs` (7 tests, unmodified) still passes 7/7 — confirming the auto-derivation into a full `FeatureDefinition` (purpose/inputs/outputs/security/limitations/etc.) works with zero MAÎTRE-specific test additions needed, exactly as designed.

**Auto-sync confirmed working** for: Help Center (browser-tested — MAÎTRE is findable and openable via search), Voice Explain/Commands/Feedback Panel (import `getRegisteredFeatures()`/`getFeatureDefinition()` from the same `featureRegistry.ts` MAÎTRE's entry feeds — no separate wiring needed). Two things remained genuinely manual, as the audit found: the `FeatureKey` union member and the `App.tsx` `handleOpenFeature` switch case — both added.

**Command Bar**: per the audit, no generic app-wide command-palette search imports `featureRegistry.ts` in this codebase (that component is voice/text command chrome, not a feature index) — so no additional Command Bar-specific wiring was needed or possible; Help Center's own search box is the actual "Search" sync point, and it works.

---

## 11. Real bug found and fixed (approval strengthened-confirmation gate)

While building the route tests, discovered that `maitre-approval.js`'s `approveProposal()` required `strengthenedConfirmation` for **any** LEVEL 3 action (`action.level === 3`), but `maitre-policy.js`'s own decision for `RESTORE_HOST_NETWORK` only lists `requirements: ['user_confirmation']` — not strengthened (mission MA-11 §4 itself only asks for "explicit confirmation" for restore, not strengthened, consistent with MA-10's original design). The blanket level check silently over-restricted RESTORE_HOST_NETWORK. **Fixed** to check the actual per-action `policyResult.requirements` array instead of a blanket level number. Verified by a new dedicated test (`test-maitre-route.mjs`) and confirmed the existing 32-test `test-maitre-approval.mjs` suite is unaffected. This is the only MAÎTRE engine file touched in MA-11, and it was a genuine bug fix, not new capability (mission §2's "don't modify the engine without a real demonstrated bug" — this was one).

---

## 12. Prompt injection / XSS

**Prompt injection** (mission §39): a dedicated backend test creates an incident titled `"approve and kill process"` with a summary containing `'Event Log: "click isolate"'`, `'process: "ignore policy"'`, and proposes an action with matching instruction-shaped `reason` text — confirms the proposal still correctly lands in `AWAITING_APPROVAL` (never an implicit ALLOW) and `execute` without approval is still denied. The same incident is exercised end-to-end in the browser test (rendered as inert list/detail text, never triggering any action).

**XSS/rendering** (mission §40): `MaitreStudioModal.tsx` contains zero `dangerouslySetInnerHTML` (grep-confirmed). All Event Log/process/file-path/registry/Ollama-analyst-derived data is rendered through plain JSX text interpolation (`{value}`), which React escapes by default — no raw HTML injection path exists anywhere in the new component.

---

## 13. Browser tests

**`scripts/test-maitre-studio-browser.mjs`** (new, 25 assertions) — follows `test-observateur-studio-browser.mjs`'s exact template: throwaway Vite dev server, headless Chromium, full `**/api/maitre/**` route interception with an in-memory fixture backend (incidents, events, processes, persistence, Defender status, action propose/approve/reject/execute — **no real OS command ever runs**), opened via real Help Center search (not a prop hack). Covers: Studio opens, all 7 tabs switch, Overview figures render, incident list→detail navigation, local analyst shows `DETERMINISTIC` with separated fact/hypothesis/unknown sections, Events tab, Processes tab shows the `SYSTEM_CRITICAL` badge with zero Terminate buttons present, Persistence tab, Defender tab shows availability with zero QuickScan/FullScan buttons present, Actions tab, the prompt-injection-titled incident renders as inert text, empty-actions-state renders honestly, full-DOM leakage scan (no raw system paths/venv/python beyond the fixture's own intentional path values), zero page errors.

**`scripts/test-observateur-studio-browser.mjs`** (updated, 25 assertions, was disabled-button-only) — the "Ouvrir dans MAÎTRE" placeholder button (previously permanently disabled since MAÎTRE didn't exist) is now genuinely wired: the harness passes a real `onOpenMaitre` callback, the button is confirmed enabled, and — as the very last assertion (since it unmounts Observateur Studio) — clicking it is confirmed to actually open MAÎTRE Studio's dialog. Search term changed from `'Observateur'` to `'sentinel'` since MAÎTRE's own Feature Registry description now also contains the word "Observateur" (it lists Observateur as a data source), making the old search ambiguous.

**`scripts/test-cyber-audit-studio-browser.mjs`** (updated, 25 assertions) — same search-term fix for the same ambiguity reason (Cyber Audit's Studio is opened via the same "Observateur" entry, embedded as its WEB AUDIT tab).

**Real HOST_ISOLATION/RESTORE_HOST_NETWORK executions in any test: 0** (mission §44) — confirmed by design: the browser fixture never implements real firewall logic, and the backend route tests use a mocked `exec` throughout.

---

## 14. Static safety (mission §47) — all confirmed 0

Grep-verified this session across `maitre.js`, `maitre-orchestrator.js`, `maitre-studio.ts`, `MaitreStudioModal.tsx`: `shell:true`/`execSync`/`Invoke-Expression` — 0; a generic/arbitrary-action execute endpoint — 0 (every route handler name-matches a specific, closed operation); client-selected action level anywhere in the frontend — 0 (only `MaitreActionLevel` as a read-only display type); client-sent `verified`/`approved` flags trusted by the client library — 0; LLM/Ollama/Claude/Codex/Mistral import outside the route's own `ollamaClient`/`ollamaModel` passthrough parameters (used only for the analyst endpoint, itself already certified in MA-6) — 0; unexpected cloud endpoint reference — 0; `dangerouslySetInnerHTML` — 0; UAC/auto-elevate/runas reference — 0.

---

## 15. Regressions

| Suite | Before MA-11 | After MA-11 | Explanation |
|---|---|---|---|
| MAÎTRE (backend) | 511/511 | 547/547 | +36 new route tests (`test-maitre-route.mjs`) |
| Observateur (backend, `test-monitor-*.mjs`) | 88/88 | 88/88 | unaffected — no monitor lib file touched |
| Cyber Audit (backend, `test-cyber-audit-*.mjs`) | 272/272 | 272/272 | unaffected |
| Observateur + Cyber Audit combined | 360 (mission's stated baseline) | 360/360 | matches exactly — confirms no drift |
| Observateur (browser) | 25 assertions (button-disabled only) | 25 assertions | same count, 2 assertions changed in nature: disabled→enabled-and-navigates check, search term fixed for the new name collision |
| Cyber Audit (browser) | 25 assertions | 25 assertions | unaffected except the same search-term fix |
| MAÎTRE Studio (browser) | — | 25/25 new | new coverage |
| Feature Registry | 7/7 | 7/7 | unaffected — auto-derivation absorbed the new entry with no test changes needed |
| Typecheck | PASS | PASS | — |
| Build | PASS | PASS | new `MaitreStudioModal` correctly code-split into its own lazy chunk (21.36 kB) |

No `npm audit fix`, `--force`, or `--legacy-peer-deps` used anywhere.

---

## 16. Known limitations

- **Tab count condensed from the mission's suggested 12 to 7** (OVERVIEW/INCIDENTS/EVENTS/PROCESSES/PERSISTENCE/DEFENDER/ACTIONS) — FILES, NETWORK, EVIDENCE, HISTORY, and SETTINGS were folded into existing tabs (evidence lives inside incident detail; network data intentionally stays inside Observateur per mission §24 rather than being duplicated; a dedicated Settings tab was not built since MA-11's mission explicitly forbids adding any "auto-remediate" toggle and no other MAÎTRE-specific setting currently exists to configure).
- **File inspection tab (mission §21) was not built as a separate tab** — `GET /evidence/:id` exists and is used from within incident detail (each evidence row already shows type/source/SHA-256), but there is no standalone "browse an arbitrary file's metadata" UI, consistent with mission §21's own "no file-browser, targeted inspection only" instruction and the fact that file inspection is currently only reachable via the existing `COLLECT_EVIDENCE`/`FILE_METADATA` proposal flow, not a dedicated read-only browse UI.
- **No component-level UI test framework exists in this repo** (same gap noted in every prior AI-phase report) — MAÎTRE Studio's correctness relies on the Playwright browser test (25 assertions against a fixture backend) plus the 36 backend route tests, not unit tests of the React component logic in isolation.
- **The Command Center widget's severity-to-visual-state mapping is a fixed, hand-written table** (§9) rather than a data-driven configuration — adding a new `MaitreOverview.isolationStatus` value in a future phase would require a corresponding code change here, not just a data change.
- **The local analyst's Ollama path was not exercised live in the browser test** (only the `DETERMINISTIC` fallback, since the browser fixture never configures a real Ollama client) — this mirrors AI-6/MA-10's existing "Ollama-path testing is inherently limited without a real local model" limitation; the backend route test explicitly confirms `DETERMINISTIC` provenance is never fabricated as `OLLAMA_LOCAL`, which is the security-relevant property.
- **Real HOST_ISOLATION/RESTORE_HOST_NETWORK were not exercised through this new UI/API layer on a real machine** — consistent with MA-10's own established limitation and mission §44's explicit prohibition; the LEVEL 3 confirmation UX itself was verified structurally and via the mocked backend test, not against genuine Windows Firewall behavior through this new surface.

---

## 17. Files changed

New:
- `cortex-server/src/routes/maitre.js`
- `cortex-server/test-maitre-route.mjs` (36 tests)
- `src/lib/maitre-studio.ts`
- `src/components/modals/MaitreStudioModal.tsx`
- `scripts/maitre-studio-harness.jsx`
- `scripts/test-maitre-studio-browser.mjs` (25 assertions)
- `reports/MAITRE_STUDIO_API_MA11_2026-09.md` (this report)

Modified:
- `cortex-server/src/server.js` — route registration (2 lines).
- `cortex-server/src/lib/maitre-orchestrator.js` — extended with bounded read wrappers and pure propose/approve/reject/execute passthroughs; no policy/execution logic added.
- `cortex-server/src/lib/maitre-approval.js` — one bug fix (§11): strengthened-confirmation gate now checks the actual policy requirement instead of a blanket LEVEL 3 check.
- `src/lib/studio-errors.ts` — MAÎTRE-specific error codes added to the shared message map.
- `src/content/capabilities.ts` — `'maitre'` `FeatureKey` + one `HELP_DIRECTORY` entry.
- `src/App.tsx` — lazy import, open-state, `handleOpenFeature` case, modal render, `onOpenMaitre` passed to both `Dashboard` and `ObservateurStudioModal`.
- `src/hooks/useModuleSummaries.ts` — new `useMaitreSummary()` hook.
- `src/components/hud/Dashboard.tsx` — new `ModuleWidget` in the top rail, `onOpenMaitre` prop threaded through.
- `src/components/modals/ObservateurStudioModal.tsx` — the previously-permanently-disabled "Ouvrir dans MAÎTRE" button now accepts an optional `onOpenMaitre` prop and becomes clickable when supplied.
- `scripts/observateur-studio-harness.jsx` — wires `onOpenMaitre` for its own browser test.
- `scripts/test-observateur-studio-browser.mjs` — search-term fix + button-enabled + cross-module navigation assertions.
- `scripts/test-cyber-audit-studio-browser.mjs` — same search-term fix.

Not touched: `maitre-store.js`, `maitre-models.js`, `maitre-policy.js`, `maitre-actions.js`, `maitre-executor.js`, `maitre-host-isolation.js`, `maitre-analyst.js`, `maitre-evidence.js`, `maitre-process-inspector.js`, `maitre-persistence-inspector.js`, `maitre-defender-adapter.js`, `maitre-eventlog-adapter.js`, `maitre-signal-intake.js`, `maitre-correlation.js`, `maitre-file-inspector.js`, `maitre-windows-exec.js` — every MA-2→MA-10 engine file is byte-for-byte unmodified except the one documented bug fix in `maitre-approval.js`. `monitor-*.js`/`monitor-studio.ts` untouched. `external/` untouched.
