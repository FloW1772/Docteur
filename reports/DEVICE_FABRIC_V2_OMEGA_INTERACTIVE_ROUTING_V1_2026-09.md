# DEVICE FABRIC V2 — OMEGA V2 Outbound INTERACTIVE Routing (Phase 4)

Status: **FINAL — PASS**
Date: 2026-09-28

## 1. Scope

Phase 4 extends Device Fabric V2 so that, for an already-active VIEW session on an
exact-target OMEGA V2 outbound host, the user can explicitly activate INTERACTIVE
(mouse/keyboard/wheel control) and explicitly stop it, without Fabric ever becoming
an input executor, a generic router, or an ADMIN surface.

Fabric's job is orchestration only:
- exact-target resolution (`resolveFabricOmegaV2Target`)
- TOCTOU double-read revalidation
- calling OMEGA V2's own certified `startOmegaOutboundInteractive` /
  `stopOmegaOutboundInteractive`

Pointer, mouse-button, wheel and keyboard events are never sent through a Fabric
route. The browser sends them directly to OMEGA V2's own certified
`/api/omega/outbound/sessions/:id/input/*` endpoints using the `sessionId`
Fabric's VIEW/INTERACTIVE state already exposes — exactly mirroring how VIEW
frames already bypass Fabric since Phase 3.

**Zero modification** was made to any `omega-outbound-*.js` file. OMEGA V2 remains
FROZEN. RASSILON was not touched. No ADMIN routing exists anywhere in this change
set.

## 2. Architecture

### 2.1 Exact-target routing

`resolveFabricOmegaV2Target(fabricDeviceId)` returns exactly
`{ fabricDeviceId, omegaV2HostId, linkId, linkVersion, fingerprint }` with zero
network side effect. `startInteractiveForFabricDevice` re-resolves this binding
and compares it against the binding the active VIEW session was created under
(`sameBinding`); any difference — unlink/relink, fingerprint change, link version
bump — fails closed with `OMEGA_V2_LINK_CHANGED` before any call to OMEGA.

### 2.2 VIEW dependency

INTERACTIVE is only ever an explicit elevation of an **already-active** VIEW
session on the same `sessionId`. There is no independent INTERACTIVE-only connect
path: `startInteractiveForFabricDevice` requires an existing binding
(`activeByFabricDevice.get(fabricDeviceId)`); with none, it fails
`OMEGA_V2_VIEW_NOT_ACTIVE` before any network call.

### 2.3 Permission model

Fabric requests a session `permission` equal to the trust's own `maxPermission`
ceiling at connect time (`connectPermission`), never higher. OMEGA V2 independently
re-verifies this on every subsequent call. If OMEGA denies INTERACTIVE elevation on
a session that only reached VIEW ceiling, that denial is reported verbatim through
the mission's closed safe-error vocabulary as `OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED`
— Fabric never infers or grants authorization itself.

A real bug was found and fixed during this phase: `connectView` originally
hardcoded the `'VIEW'` permission at connect time, which permanently prevented
INTERACTIVE from ever becoming reachable on a Fabric-initiated session (OMEGA's own
`requireInteractiveSession` checks the session's fixed `permission` field, which is
never renegotiated). Root-caused via the real two-process TLS harness failing with
`OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED`; fixed by adding the `connectPermission` dep
and threading `permission` through to `connectView(hostId, permission, options)`.

### 2.4 linkVersion / fingerprint revalidation and TOCTOU

Both VIEW start and INTERACTIVE start perform the same double-read discipline:
resolve once, resolve again immediately before the OMEGA call, and reject on any
difference between the two reads. INTERACTIVE additionally compares its
revalidated binding against the binding the VIEW session itself was created
under, so a link replacement that happens strictly between VIEW start and a later
INTERACTIVE click is rejected rather than silently used.

### 2.5 Input path

All INTERACTIVE input (pointer move, button down/up, wheel, key down/up) is sent
by `FabricOmegaV2ViewPanel.tsx` directly to
`/api/omega/outbound/sessions/:id/input/{pointer,button,wheel,key}` via `fetch`,
reusing the exact letterbox coordinate-mapping, keyboard allowlist, focus-gated
capture, held-key/held-button release-on-blur, and Escape-to-stop-local logic
already certified in `OmegaOutboundViewTab.tsx`. Fabric's own routing module
(`device-fabric-omega-v2-routing.js`) contains **zero** references to
`sendOmegaOutboundInput`, no pointer/keyboard/mouse/wheel/clipboard identifiers,
and no raw input primitive — verified by the static audit's exact-match and
forbidden-pattern regressions (§5).

### 2.6 STOP semantics

- **STOP INTERACTIVE**: calls OMEGA's own `stopOmegaOutboundInteractive`; VIEW
  remains active (session stays `CONNECTED`).
- **STOP VIEW**: OMEGA's own certified `stopOmegaOutboundView` already stops
  INTERACTIVE internally whenever VIEW stops; Fabric mirrors this via
  `clearInteractive(binding)` on its own local state — it never issues a second
  explicit interactive-stop call.
- **STOP SESSION**: tears down the whole session; `clearInteractive` runs the
  same way.
- In all three cases, Fabric's `clearInteractive()` only ever mutates its own
  local `interactiveStatus` flag — it never touches held keys/buttons directly.
  That release is OMEGA's own certified responsibility
  (`stopOmegaOutboundInteractive` releases host-side held input internally).

### 2.7 Remote STOP / network drop / revocation / expiry

All four are learned passively from OMEGA's own session state
(`getOmegaOutboundSession`) on the next status read — Fabric performs zero
automatic reconnect and zero automatic INTERACTIVE re-activation in any of these
cases. `getViewStateForFabricDevice` explicitly clears the local
`interactiveStatus` whenever the underlying session is not `CONNECTED`.

## 3. Two-process real-TLS harnesses

### 3.1 VIEW harness (Phase 3, re-verified)
`test-device-fabric-omega-v2-view-harness.mjs` — real TLS cert
(`@vitejs/plugin-basic-ssl`), two forked host processes (A, B), real
`connectOmegaDevice`/session handshake. Fabric A connects only to host A; host B
receives zero session. Network-drop-on-A leaves host B untouched.
**Result: 1/1 PASS.**

### 3.2 INTERACTIVE harness (Phase 4, new)
`test-device-fabric-omega-v2-interactive-harness.mjs` — same two-host real-TLS
setup, both trusts registered at `maxPermission: 'INTERACTIVE'`. Flow: start VIEW
on A → fetch one real frame (the same step the browser's poll loop performs,
needed for OMEGA's own view state to reach `VIEWING` before INTERACTIVE is
reachable) → start INTERACTIVE on A → send one mocked pointer event and one mocked
key DOWN/UP directly to OMEGA's own certified input route (never through Fabric) →
verify host A's fixture recorder captured them, host B recorded **zero** → stop
INTERACTIVE (VIEW survives) → stop VIEW → stop session → fresh VIEW+INTERACTIVE →
remote STOP via the host process → verify Fabric's next status read reflects
`interactiveStatus: STOPPED` with zero reconnect → verify a subsequent input call
is rejected by OMEGA itself → final check that host B stayed at 0 events for the
entire run. **Result: 1/1 PASS.**

The host's mock `interactiveProvider` (`executeSemanticInput`/
`releaseSemanticInput`) is OMEGA V2's own existing certified test fixture, reused
as-is — no real Windows input API is ever exercised, and no new mock was built
for Fabric.

## 4. Browser test results

`scripts/test-device-fabric-browser.mjs` — extended in place, run against a real
React app served by Vite with a stateful mocked `/api/device-fabric` and
`/api/omega/outbound` surface.

Covers: INTERACTIVE initially OFF while VIEW is live; VIEW continues to work
unmodified; explicit-click-only activation; live `INTERACTIVE` label; zero input
before activation; pointer move; left click; right click; wheel; keyboard reaches
OMEGA only with viewport focus (an unfocused key press generates zero remote
event); a held button released outside the viewport still sends UP; Escape stops
INTERACTIVE locally and is never itself forwarded as a remote key; a blur/focus
loss releases locally-held keys; STOP INTERACTIVE leaves VIEW active; STOP VIEW
also stops INTERACTIVE; STOP SESSION also stops INTERACTIVE; OMEGA's own
`OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED` denial is surfaced without a fake ACTIVE
state; remote STOP clears local INTERACTIVE; network drop leaves INTERACTIVE
unreachable without auto-retry; revoked / fingerprint-mismatched trust blocks both
VIEW and INTERACTIVE buttons entirely; a raw wrong-Fabric-device INTERACTIVE start
is rejected (404); the INTERACTIVE start request schema is closed (any body field
→ 400); no ADMIN button anywhere in the panel; clipboard paste/copy and
drag/drop generate zero file transfer while INTERACTIVE is live; and an explicit
two-device exact-target proof — Fabric A → OMEGA host A, Fabric B → OMEGA host
B, INTERACTIVE input on A recorded only on A's own session, host B recorded
**zero** events throughout, and a stale/failed attempt against A is rejected
(`OMEGA_V2_LINK_CHANGED`) with host B still at zero events and no fallback
attempt.

**Result: 156/156 assertions PASS**, verified stable across 5 consecutive runs
(0 flakes) after two real fixes: a coordinate-mapping issue (the 1×1 test PNG
scales to a near-zero on-screen target under `object-fit: contain`, so tests now
click the viewport's default visual center rather than a fixed offset) and an
inter-click timing race (two `.click()` calls on the same element back-to-back
raced their async `sendInput` fetches; a short wait between them removed the
flake).

## 5. Static audit

`test-device-fabric-static-audit.mjs` — **22/22 PASS.**

Re-verifies (Phase 3 checks unchanged, Phase 4 additions in bold):
- generic router / generic RPC / shell / raw input primitive: **0**
- **ADMIN**: the string `ADMIN` appears exactly once in the routing module, as a
  read-only accept-list entry (`['VIEW','INTERACTIVE','ADMIN'].includes(session.permission)`)
  acknowledging that a session locked at the ADMIN ceiling still satisfies a
  VIEW/INTERACTIVE request — never a route, a call, or a routing decision. A
  dedicated assertion confirms no `requestAdmin|startAdmin|enterAdmin|admin-mode`
  pattern exists anywhere in the module.
- clipboard / file transfer / credential access: **0**
- voice / agent / MetaGPT / CommandBar routing reaching Device Fabric: **0**
- **`connectOmegaDevice(hostId, permission, options)`** call pattern (not a
  hardcoded `'VIEW'` literal) plus the `connectPermission` dependency source
  verified present by regex
- **`sendOmegaOutboundInput`, `requestOmegaOutboundAdmin*`,
  `getOmegaOutboundAdmin*`, `cancelOmegaOutboundAdmin*`**: 0 matches in the
  routing module
- **`pointerEvent|keyboardEvent|mouseEvent|wheelDelta|keyCode|virtualKey|clipboard`**:
  0 matches (narrowed from an earlier over-broad `\bkey\b` ban that falsely
  matched legitimate local variables like the rate-limiter's `key` parameter)
- **`heldKeys|heldButtons|releaseSemanticInput|releaseHeldInput`**: 0 matches,
  proving Fabric never performs local held-input release itself
- **Frontend**: exact one call site each for
  `deviceFabricOmegaV2InteractiveStart`/`Stop`, both only from
  `onClick={() => void startInteractive()}` /
  `onClick={() => void stopInteractive()}`; no INTERACTIVE/VIEW start or stop call
  inside any `setInterval`; raw input goes to
  `` `/api/omega/outbound/sessions/${sessionId}/input/${category}` `` via `fetch`
  and never to any `/api/device-fabric/...input` path; no `ADMIN`, `FULL CONTROL`,
  `SUPER ADMIN`, or `TOTAL CONTROL` label anywhere.

## 6. Regression results

| Suite | Result | Baseline | Delta |
|---|---|---|---|
| Device Fabric backend (all `test-device-fabric-*.mjs`) | **171/171 PASS** | 146 (Phase 3) | +25 new (Phase 4 unit + route + static-audit additions) |
| Device Fabric browser | **156/156 PASS** | 117 (Phase 3) | +39 new (Phase 4 INTERACTIVE coverage) |
| Two-process VIEW TLS harness | **1/1 PASS** | 1/1 | unchanged |
| Two-process INTERACTIVE TLS harness | **1/1 PASS** | new | new |
| OMEGA V2 outbound (`test-omega-outbound-*.mjs`) | **77/77 PASS** | 77/77 | unchanged, 0 modification |
| OMEGA V1 (`test-omega-*.mjs`, excl. outbound) | **224/227 PASS, 3 skip** | 224/227, 3 skip | unchanged |
| RASSILON (`test-rassilon-*.mjs`) | **252/253 PASS, 1 skip** | 252/253, 1 skip (Ollama) | unchanged |
| Full backend (`test-*.mjs`, 170 files) | **2683/2696 PASS, 9 fail (0 NEW), 4 skip** | — | 0 NEW Device Fabric V2 failures |

### 6.1 The 9 pre-existing (non-Device-Fabric) failures, classified

All nine are unrelated to this mission's file set (confirmed via `git status`/
`git diff` against every touched subsystem) and were already failing before this
phase began:

- `searchText: finds a known symbol by exact string` — HISTORICAL (code-intel
  search index)
- `test-find-eval.mjs` — HISTORICAL
- `idle overhead: a real collectSnapshot() cycle completes well under the
  default 10s interval` — ENVIRONMENTAL (timing-sensitive on this machine)
- `OpenMontage adapter — Remotion cwd/root isolation` — ENVIRONMENTAL (needs a
  real Remotion/Node environment)
- `real Sherlock receives HTTP fixture through gateway` — ENVIRONMENTAL (needs a
  real Sherlock process)
- `checkPortOwnership: free port reports state "free"` — ENVIRONMENTAL (depends
  on real OS port/process state at run time)
- `checkPortOwnership: port held by an unrelated process...` — ENVIRONMENTAL
  (same)
- `test-regression-api.mjs` — ENVIRONMENTAL: not a real `node:test` file; it is a
  standalone dev fixture script that boots an HTTP server on port 3002 and never
  exits, which hangs a broad `node --test test-*.mjs` glob run until killed. Not
  a code defect.
- `test-video-manual.mjs` — ENVIRONMENTAL: a manual repro script, not a
  `node:test` file; fails on `mkdtemp` because the fixture assumes the working
  directory is `cortex-server/` but the batch run's CWD differs, producing a
  doubled path.

**0 NEW failures introduced by Device Fabric V2 Phase 4.**

Separately, running `test-omega-outbound-admin.mjs` (and a small number of other
files, e.g. `test:video`) requires Node's `--experimental-test-module-mocks` flag
for `mock.module()` — a pre-existing environmental requirement of this Node
version, already documented in `cortex-server/package.json`'s own `test:video`
script. All regression runs above were executed with this flag.

## 7. Typecheck / build / server boot

- `npx tsc --noEmit`: **PASS**
- `npm run build`: **PASS** (PWA precache regenerated, 37 entries)
- Isolated server boot smoke (`scripts/test-device-fabric-server-boot.mjs`,
  extended for Phase 4): **5/5 PASS** — no auto-connect, no auto-VIEW, no
  auto-INTERACTIVE, no ADMIN activity, no outbound/cloud URL logged, no
  unexpected second listener port opened, clean SIGINT shutdown.

## 8. Privacy / secret scan

- Typed text persisted in Fabric: **0**
- Keylogging: **0**
- Mouse-position history persisted: **0**
- Clipboard access: **0**
- Remote screen frame bytes persisted in Fabric: **0** (only an opaque
  `streamId` string is retained; frame PNG bytes never pass through Fabric,
  confirmed by the static audit's `frame(s|Bytes|Buffer)?|image/png` ban)
- Fabric OMEGA private keys / tokens / session secrets in the `fabric_audit` /
  `fabric_agent_links` schema: **0** (schema columns checked directly; audit
  events carry only ids/reasons)
- `.gitignore`: no change needed; `git status` shows only the expected Phase 4
  file set, nothing sensitive

## 9. Files changed

**Modified:**
- `cortex-server/src/lib/sqlite.js` — `fabric_audit`/`fabric_agent_links`
  migrations extended for INTERACTIVE audit event types (Phase 4 additions on
  top of the existing Phase 2/3 schema)
- `cortex-server/src/routes/device-fabric.js` — three new closed routes:
  `POST .../omega-v2/interactive/start`, `GET .../interactive/status`,
  `POST .../interactive/stop`
- `cortex-server/test-device-fabric-static-audit.mjs` — Phase 4 import/pattern
  assertions, narrowed ADMIN check, new frontend INTERACTIVE test
- `cortex-server/test-device-fabric-migration.mjs` — Phase 4 schema coverage
- `scripts/test-device-fabric-browser.mjs` — full Phase 4 INTERACTIVE browser
  coverage (see §4)
- `src/lib/cortex/client.ts` — `deviceFabricOmegaV2InteractiveStart/Status/Stop`
  methods, `interactiveStatus` field on `FabricOmegaV2ViewState`
- `src/components/settings/FabricOmegaV2ViewPanel.tsx` — INTERACTIVE UI (see §2.5)
- `scripts/test-device-fabric-server-boot.mjs` — extended for Phase 4 (§7)

**New:**
- `cortex-server/src/lib/device-fabric-omega-v2-routing.js` — the closed
  VIEW+INTERACTIVE orchestration module (Phase 3 base + Phase 4 INTERACTIVE
  functions)
- `cortex-server/test-device-fabric-omega-v2-interactive.mjs` — 22 unit tests
  (mocked deps, no DB/network)
- `cortex-server/test-device-fabric-omega-v2-interactive-harness.mjs` — real
  two-process TLS harness (§3.2)

**Untouched (frozen, verified via `git status`/`git diff`):**
- Every `cortex-server/src/lib/omega-outbound-*.js` file
- Every RASSILON source file
- `external/MetaGPT/`, `external/OpenMontage/`

## 10. Known limitations

- The real two-process harnesses exercise the certified mock `interactiveProvider`
  fixture already used by OMEGA V2's own test suite; no real Windows
  mouse/keyboard API is exercised by any automated test in this repository
  (mission-mandated: `Real Windows input smoke: NOT_RUN`).
- The browser test's exact-target proof drives the mock API directly via
  `fetch` for the two-device scenario rather than through two independent UI
  panels, because the mock server's `omegaViewState` is a single global variable
  (adequate for the existing single-device VIEW/INTERACTIVE UI flow); the
  per-session input-event isolation it proves (`omegaSessions` keyed by
  `sessionId`) is the same mechanism the real two-process harness verifies at
  the protocol level.
- Cancellation of an in-flight INTERACTIVE activation request is not a distinct
  primitive (same limitation already documented for RASSILON V1); STOP
  INTERACTIVE remains the only control.

## 11. Verdict

**PASS.** Device Fabric V2 Phase 4 (OMEGA V2 outbound INTERACTIVE routing) is
complete: exact-target, VIEW-dependent, TOCTOU-revalidated, permission-ceiling
respecting, zero-fallback, zero-ADMIN, zero-input-executor orchestration, with
input forwarding fully delegated to OMEGA V2's own certified routes. All unit,
static-audit, two-process real-TLS, and browser suites pass; the full backend
regression shows 0 new failures; typecheck and build both pass; OMEGA V2,
RASSILON, and OMEGA V1 are all preserved unmodified.
