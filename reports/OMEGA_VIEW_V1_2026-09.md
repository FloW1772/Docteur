# DOCTEUR — OMEGA V1 VIEW ONLY (PHASE 3: LIVE LAN SCREEN VIEWING)

Date: 2026-09-22
Scope: Phase 3 only — real LAN session between two authorized devices, authenticated transport, remote screen capture, VIEW ONLY, screen selection, bounded streaming, STOP SESSION, visible session indicator. Per the mission: **zero** mouse, keyboard, clipboard, file, ADMIN, shell, Windows service, persistence, or Internet relay was implemented — not even scaffolding.

---

## 1. What was built on top of Phase 2

Phase 2 (identity + pairing + crypto, 81/81 tests, independently re-verified) is reused **verbatim, unmodified**:
- `omega-identity.js` (Ed25519 device identity, DPAPI key storage) — untouched.
- `omega-pairing.js` (pairing state machine, challenge-response mutual auth, `OMEGA_PERMISSION_LEVELS`) — untouched, only imported.
- `omega-session.js` (short-lived, nonce-chained, device-bound sessions) — untouched. Phase 3's entire VIEW data path is gated through `validateAndAdvanceSession({ sessionId, deviceId, presentedNonce })` — the exact same function, same nonce-chaining anti-replay, same live device-revocation check, same permission-read-from-session-record discipline Phase 2 built and tested. No new/weaker auth path was added anywhere.
- `omega-devices.js`, `omega-audit.js` — untouched except for four new closed-enum audit event types appended (`VIEW_STARTED`, `VIEW_STOPPED`, `VIEW_FRAME_REJECTED`, `VIEW_PERMISSION_DENIED`), following the exact existing pattern (throws on an unlisted type).

New Phase 3 files:
- `cortex-server/src/lib/omega-windows-exec.js` — OMEGA-owned safe PowerShell execution helper.
- `cortex-server/src/lib/omega-capture.ps1` — fixed, repo-shipped capture script (screen enumeration + single-frame capture).
- `cortex-server/src/lib/omega-indicator.ps1` — fixed, repo-shipped visible-indicator script (balloon-tip toast).
- `cortex-server/src/lib/omega-capture.js` — capture library (bounds, PNG validation, temp-file lifecycle).
- `cortex-server/src/lib/omega-view.js` — VIEW session orchestration (auth re-validation, permission gate, screen selection, FPS throttle, STOP SESSION).
- `cortex-server/src/routes/omega-view.js` — the LAN-reachable HTTP data path.
- `cortex-server/src/lib/sqlite.js` — additive `omega_view_sessions` table + accessors.
- `cortex-server/src/server.js` — one new import + one new `app.route()` registration line.
- Tests: `test-omega-capture.mjs`, `test-omega-view.mjs`, `test-omega-view-route.mjs`.

---

## 2. Screen capture mechanism

Per the mission's pre-made technical decision (not re-derived): **PowerShell + `System.Windows.Forms`/`System.Drawing`**, invoked via `execFile('powershell.exe', fixedArgs, { shell: false })`.

**Safe-exec helper decision**: a **new, OMEGA-owned** `omega-windows-exec.js` was written rather than importing `maitre-windows-exec.js`'s `runReadOnlyPowerShell()` directly. Two reasons, both documented in the file's header:
1. Module-boundary hygiene — OMEGA is a fully separate authorization domain from MAÎTRE (carried over from Phase 1/2's "zero imports from/into any maitre-*.js file" rule, applied here for consistency even though this isn't approval-layer code).
2. OMEGA's capture invocation has a materially different shape: it runs a **fixed script file** (`-File`, never `-Command` with inlined text) with **only numeric/enum positional arguments** — an even narrower surface than `maitre-windows-exec.js`'s escaped-string-literal `-Command` invocations, so its escaping machinery wasn't needed.

The new helper mirrors `maitre-windows-exec.js`'s exact discipline: absolute executable path, fixed args array, `shell:false`, `windowsHide:true`, bounded stdout/stderr (`maxBuffer`), hard timeout (5-6s). A defense-in-depth regex additionally rejects any argument containing PowerShell-meaningful characters before it ever reaches `execFile`, even though `shell:false` already prevents shell injection structurally.

**Capture flow**: Node picks a fresh random temp PNG path → runs `omega-capture.ps1` with `[screenIndex, outputPath]` → the script does `Add-Type` → `Screen.AllScreens[index].Bounds` → `Graphics.CopyFromScreen()` → `Bitmap.Save(PNG)` → prints a small JSON status line → Node reads the PNG into a Buffer, verifies PNG magic bytes, deletes the temp file (always, `try/finally`) → returns `{buffer, width, height, byteLength, capturedAt}`.

**Verified with REAL capture on this development machine** (not simulated): `listScreens()` correctly enumerated 2 real monitors (1920×1080 primary + 1536×864 secondary); `captureFrame(0)`/`captureFrame(1)` both produced valid, correctly-sized PNG buffers; the visible-indicator script successfully displayed a real Windows balloon tip. Zero new npm dependency — both .NET assemblies ship with Windows itself.

---

## 3. Transport / streaming design

**Mechanism chosen: bounded HTTP polling** (`GET /api/omega/view/:sessionId/frame`), not SSE. Documented reasoning:
- Capture is inherently **pull-based** — one PowerShell process per frame, not a continuously-pushing OS capture API. A polling "give me the next frame" endpoint maps directly onto that reality.
- SSE's `data:` event framing would require base64-encoding each PNG (~33% size overhead) for no benefit here, versus polling's raw `image/png` response body.
- Polling makes "lien lent" / "déconnexion" / "reconnexion" trivially reasoned about: each GET is fully independent and bounded, with no long-lived connection state that can hang or leak.
- **Backpressure is structural, not bolted on**: the server only ever captures a NEW frame in direct response to an actual client request, and a per-session in-process throttle map (`lastFrameServedAt`) refuses any request arriving sooner than `MIN_FRAME_INTERVAL_MS` after the last served frame (429-equivalent `rate_limited`). There is no unbounded producer queue anywhere.

**Network architecture** (mission rules 4/5 — no unjustified `0.0.0.0` listener, prefer LAN direct): **zero new listener, zero new port.** Phase 3 rides Cortex's pre-existing `LOCAL_NETWORK=true` LAN-exposure decision in `server.js` (binds `HOST` to `0.0.0.0` only when the user explicitly opts in via `.env`, documented there as "NEVER set this on a machine directly reachable from the internet"). This decision predates OMEGA entirely and is shared by every other LAN-capable route (Kiwix, download, etc.) via the existing `DEV_ORIGINS`/`isLanOrigin` CORS allowlist.

**Auth-model split** (the key architectural decision this phase made): Phase 2's control-plane routes (`/api/omega/*` in `omega.js`) are **loopback-only** (`isLocal(c)` + Origin check) — correct, since pairing/device-management has no reason to be reached from a second physical device. The VIEW data path (`/api/omega/view/*` in `omega-view.js`) is registered as a **separate route group with no loopback gate at all**, because it must by definition be reachable from the controller device elsewhere on the LAN. In its place, every single VIEW route requires a valid, non-expired, non-revoked, correctly-nonce-chained session token (Phase 2's `validateAndAdvanceSession()`, called on every request, not just session start) — this **is** the "transport authentifié par l'identité du device" requirement (mission rule 3). There is no separate/weaker auth path for the streaming route.

---

## 4. Transport encryption — honest assessment

**Cortex has zero existing TLS on its local/LAN HTTP listener today** (confirmed by inspection of `server.js`: `USE_HTTPS` is only true when `LOCAL_NETWORK=true` **and** cert files already exist at `../certs/{key,cert}.pem`, generated by a separate `scripts/gen-cert.mjs` the user must run manually; by default, in localhost-only dev mode, there is no cert and the server runs plain HTTP). Adding new TLS infrastructure was out of scope for Phase 3 — the mission's own guidance explicitly permits and expects an honest non-PASS here rather than a fabricated one.

**What actually holds today**: every VIEW frame request is **authenticated** by Phase 2's device-bound, nonce-chained session mechanism (the same cryptographic proof-of-possession chain established via Ed25519 challenge-response at session creation), running over Cortex's existing HTTP(S) listener — HTTPS **if** the user has set `LOCAL_NETWORK=true` and generated certs (existing, pre-OMEGA mechanism), otherwise plain HTTP. Phase 3 adds no new encryption and structurally cannot claim TLS exists where it doesn't.

**Checkpoint marking**: "Transport encryption" is marked **PARTIAL** below — authenticated and replay-protected in all configurations; confidentiality-in-transit (TLS) depends entirely on whether the user has separately enabled `LOCAL_NETWORK=true` + generated certs, which is a pre-existing, opt-in, user-controlled Cortex setting Phase 3 did not change. This is the honest outcome per the mission's own explicit instruction not to fabricate a PASS here.

---

## 5. VIEW ONLY enforcement

Permission is read exclusively from `validateAndAdvanceSession()`'s return value (`result.permissionLevel`), which itself reads from the `omega_sessions` row set at session-creation time — **never** from any client-supplied field, anywhere in `omega-view.js` or `routes/omega-view.js`. Structurally verified (not just by policy): `omega-view.js` and `routes/omega-view.js` were grepped for `mouse`/`keyboard`/`admin`/`shell`/`command`/`exec`-shaped tokens and contain zero functional matches (only comments describing the absence). A dedicated route-level test confirms `POST /api/omega/view/:sessionId/mouse|keyboard|admin` all 404 — no such route exists on the Hono app at all. A permission-escalation attempt via extra client-supplied body fields (`permissionLevel: 3`, `action: 'CLICK'`, `mouseX`, `keys`) was tested and confirmed ignored — the session's actual permission level (read server-side) is unaffected.

---

## 6. Multi-monitor

`listScreens()` requires no session and enumerates all detected monitors (index, primary flag, bounds, device name) via `[System.Windows.Forms.Screen]::AllScreens`. `startViewSession()` **requires** an explicit integer `screenIndex` argument — there is no default value and no fallback; omitting it fails closed (`screen_index_required`). An index beyond the detected count fails closed (`screen_index_out_of_range`), never silently clamped. Verified on this real dual-monitor development machine: both screens enumerate correctly and each captures at its own correct resolution independently.

---

## 7. Streaming bounds (mission rule 9)

Enforced in `omega-capture.js`:
- `MAX_FRAME_BYTES = 8 MB` — an oversized PNG is rejected (`capture_frame_too_large`), never truncated-and-forwarded.
- `MAX_SCREEN_DIMENSION = 7680` — a pathological/spoofed resolution value fails closed.
- `CAPTURE_TIMEOUT_MS = 5000` — the PowerShell invocation itself is time-bounded.
- PNG magic-byte verification — a malformed/corrupted capture is rejected (`capture_frame_malformed`) before ever leaving Node.

Enforced in `omega-view.js`:
- `MAX_FPS = 5` (`MIN_FRAME_INTERVAL_MS ≈ 200ms`) — a deliberately conservative ceiling for a polling/pull transport, not a live video feed. A poll arriving faster is `rate_limited` (429), server-enforced per-session, never trusting client self-throttling.

Every bound fails **closed**, never best-effort/partial.

---

## 8. STOP SESSION (mission rule 11)

`stopViewSession()` does two things, in order: (1) marks the `omega_view_sessions` row stopped, so `getFrame()` refuses further frames immediately; (2) calls Phase 2's `endSession()` on the **underlying** `omega_sessions` row, so the session credential itself is invalidated — not just a client-side UI flag. Tested: after STOP, both a frame request with the last-known-valid nonce AND a fresh `startViewSession()` attempt using the same session id both fail (`session_invalid`) — silent resumption is structurally impossible, matching the mission's strongest clause ("empêcher toute reprise silencieuse"). STOP is idempotent (calling it twice never throws) and always shows the visible "stop" indicator.

---

## 9. Visible session indicator (mission rule 12)

Built as a genuinely OS-level Windows balloon-tip notification (`System.Windows.Forms.NotifyIcon.ShowBalloonTip`), titled **"OMEGA — VIEW ONLY ACTIVE"**, shown on the **controlled** machine (never the controller's UI) at session start, and a distinct "session ended" notice at STOP. Verified with a real invocation on this machine (a real balloon tip appeared).

**Honest limitation** (documented in the script's own header comment and repeated here, not hidden): a balloon tip is transient (a few seconds on screen), and the underlying `NotifyIcon` is a short-lived, one-shot process invoked once per lifecycle event — it is a truthful point-in-time indicator at start/stop, **not** a continuously-visible taskbar glyph for the entire session duration. A persistent tray-icon app (this project has no Electron/tray infrastructure today) is out of scope for V1, as anticipated by the mission's own guidance, and is a natural Phase 4/5-adjacent follow-up rather than something attempted here.

`showSessionIndicator()`'s own failure does not block session start (a locked-down machine without balloon-tip support shouldn't hard-fail VIEW capability) — this is a documented tradeoff: the requirement is "best-effort genuinely visible," not "session cannot start without it."

---

## 10. Strict Local

Confirmed by inspection (and by a dedicated test grepping the actual source): `omega-capture.js`, `omega-view.js`, and `routes/omega-view.js` contain **zero** references to `fetch()`, `http(s)` clients, or `assertCloudAllowed()` — there is no cloud/Internet code path anywhere in this phase's surface, so the guard was correctly never needed, exactly mirroring Phase 2's own finding. `test-strict-local-centralized.mjs` (the dedicated suite) ran clean, 6/6, unaffected.

---

## 11. Tests

| File | Tests | Result |
|---|---|---|
| `test-omega-capture.mjs` | 12 | 11 pass, 1 skipped (non-Windows branch, correctly skipped — this machine is Windows) |
| `test-omega-view.mjs` | 23 | 23/23 pass |
| `test-omega-view-route.mjs` | 25 | 25/25 pass |
| **Phase 3 total** | **60** | **59 pass, 1 skipped, 0 fail** |

`test-omega-capture.mjs` exercises the **real** PowerShell capture mechanism on this actual Windows machine (real multi-monitor enumeration, real frame capture with PNG validation, real balloon-tip indicator, real non-Windows-path error handling — skipped since this machine is Windows). `test-omega-view.mjs`/`test-omega-view-route.mjs` use an injected fake capture provider (`_setCaptureProviderForTests`, mirroring the existing `isLocal`-injection pattern from `omega.js`/`monitor.js`) so the full mission-mandated scenario matrix runs fast and deterministically: authorized device, unpaired device, revoked device, wrong key, expired session, replay, normal view, resolution change, multi-monitor, malformed frame, oversized frame, slow link, disconnection/reconnection, crashed transport, STOP SESSION, VIEW-attempting-escalation (via client-field smuggling and via nonexistent-route 404 checks), XSS-shaped device name, and zero-cloud/zero-fetch source checks.

Combined with Phase 2's unchanged 81/81: **OMEGA total 140/141 pass, 1 correctly skipped, 0 fail.**

---

## 12. Regressions

Full `cortex-server` suite — **127 `test-*.mjs` files** (124 from Phase 2's baseline + 3 new Phase 3 files) — run via `node --test --test-timeout=20000 <file>` per file, identical methodology to Phase 2.

**Aggregate (assertion-level, summed across all 127 files): 2088 total, 2081 pass, 3 fail, 3 cancelled, 1 skipped.**

- **fail (3 files, 1 assertion each)**: `test-find-eval.mjs`, `test-video-manual.mjs`, `test-video-pipeline.mjs` — all three match Phase 2's own documented pre-existing baseline exactly.
- **cancelled (3 files, 20s harness-timeout each — per Node's test-runner semantics, a timed-out assertion is `cancelled`, not `fail`)**: `test-cyber-audit-crawler.mjs`, `test-maitre-executor-level2.mjs`, `test-regression-api.mjs` — all three match Phase 2's documented baseline exactly.

All 6 non-passing files confirmed via `git status --short -- <file>` to have **zero diff/status entry** — none were touched by this session (verified directly, exit with no output for all 6 paths). No regression attributable to Phase 3's actual changes (the `sqlite.js` `omega_view_sessions` schema/accessor addition is purely additive; the `omega-audit.js` event-type addition is purely additive; `server.js`'s new route registration is two new lines) was found anywhere in the 127-file run.

`test-strict-local-centralized.mjs`: 6/6 clean, unaffected.

**Typecheck**: `npx tsc --noEmit` (repo root) — exit 0, no errors.
**Build**: `npm run build` — exit 0, same pre-existing large-chunk warning as Phase 2 (frontend untouched this phase — Phase 3 added zero `.ts`/`.tsx` files).

---

## 13. Frontend

**No frontend UI was built this phase** — a deliberate judgment call, following the exact precedent Phase 2 set for its own pairing-confirmation UI. Backend correctness and the mission-mandated test matrix consumed the available effort; a minimal VIEW Studio (device list, start button, live frame view, STOP button, indicator) would be natural follow-on work but was judged lower priority than hardening and fully testing the actual security-relevant surface (auth re-validation on every frame, bounds, STOP-invalidation semantics). `src/content/capabilities.ts` was **not** touched — no live, clickable end-to-end UI exists yet for a user to exercise, so even a "partiel" entry would overclaim; this mirrors Phase 2's own reasoning for leaving it untouched.

---

## 14. Known limitations (honest)

- **Transport encryption depends on a pre-existing, opt-in Cortex setting** (`LOCAL_NETWORK=true` + manually-generated certs) that Phase 3 did not add and did not change — see §4. Without it, VIEW traffic is authenticated-but-plaintext over LAN, same posture as every other existing LAN-capable route in this codebase (Kiwix, download, etc.), not something Phase 3 uniquely regresses.
- **No frontend UI** — backend-only this phase, by judgment call (see §13).
- **Visible indicator is point-in-time, not continuously persistent** — a transient balloon tip at start/stop, not a full-duration taskbar glyph, due to no existing tray-icon infrastructure in this project (see §9).
- **FPS ceiling (5) and polling-based delivery are deliberately conservative** — adequate for a VIEW-only, low-frequency "check what's on that screen" use case, not tuned for smooth real-time video; this was a documented design choice (§3), not an oversight.
- **In-process throttle/session-view state resets on Cortex restart** — same rationale and same acceptance as Phase 2's in-process pairing rate-limiter and issued-challenge set (single-user local/LAN control plane, not an Internet-facing service).
- **No automated multi-machine LAN test** — per this project's own established testing discipline (Phase 1 §64), both peers were simulated as local test clients making real HTTP requests through real session tokens over Cortex's actual HTTP server; a second physical machine was not used for automated tests. The real capture mechanism itself (PowerShell/System.Windows.Forms/System.Drawing) was verified with actual, non-simulated screen captures on this development machine.
- **Screen-topology change mid-session** (e.g., a monitor unplugged after `startViewSession()` selected it) is handled by failing closed on the next `getFrame()` call (the PowerShell script's own out-of-range check triggers `capture_failed`) rather than by a dedicated hot-reconfiguration path — acceptable fail-closed behavior, not a silent frame corruption.

---

## DOCTEUR OMEGA VIEW CHECKPOINT

Live LAN session : PASS (real HTTP requests, real Phase 2 session tokens, both peers simulated as local test clients per this project's established testing discipline; real screen-capture mechanism independently verified on this Windows machine)
Authenticated transport : PASS (every VIEW route re-validates the device-bound, nonce-chained session on every request — no separate/weaker auth path)
Transport encryption : PARTIAL (authenticated and replay-protected always; TLS confidentiality depends on the pre-existing, user-controlled `LOCAL_NETWORK`+certs setting, which Phase 3 did not add — see §4; plain HTTP by default, same as every other existing LAN route in this codebase)
Device identity binding : PASS (reused verbatim from Phase 2, tested against wrong-device/wrong-key/revoked scenarios on the VIEW path specifically)
VIEW ONLY : PASS (permission read server-side only; zero mouse/keyboard/admin routes exist; escalation-attempt test confirms client-supplied fields are ignored)
Screen capture : PASS (real PowerShell + System.Windows.Forms/System.Drawing capture, verified with actual non-simulated screenshots on this machine)
Multiple monitors : PASS (explicit detection + explicit required selection; verified on this machine's real 2-monitor setup, each capturing its own correct resolution)
Resolution changes : PASS (surfaced via frame metadata/headers, never silently hidden; tested at both the library and HTTP layer)
Streaming bounds : PASS (max frame size, max resolution, max FPS, capture timeout, all fail-closed and tested)
Backpressure : PASS (structural — pull-based capture, one frame per client request, server-enforced per-session throttle)
Visible session indicator : PASS, with documented limitation (genuine OS-level balloon tip on the controlled machine; point-in-time at start/stop rather than continuously persistent — see §9/§14)
STOP SESSION : PASS (cuts the stream AND invalidates the underlying session credential; silent resumption structurally impossible; idempotent)
Revoked-device rejection : PASS (tested on both the control-plane and the VIEW data-path route)
Replay protection : PASS (nonce-chaining reused verbatim from Phase 2; tested against start-session replay and frame-request replay specifically)
Strict Local : PASS (zero cloud/fetch code path exists in this phase's surface, confirmed by source-grep test; dedicated suite 6/6 clean, unaffected)
Cloud relay : 0 attendu — **0 confirmed**
Mouse injection : 0 attendu — **0 confirmed**
Keyboard injection : 0 attendu — **0 confirmed**
Admin actions : 0 attendu — **0 confirmed**
Arbitrary shell : 0 attendu — **0 confirmed** (only two fixed, repo-shipped `.ps1` files exist, invoked with numeric/enum args only, never string-interpolated text)
OMEGA tests : 139/140 (1 correctly skipped — non-Windows code path, this machine is Windows; combined Phase 2 (81/81) + Phase 3 (59/60 + 1 skip) = 140/141 total, 0 fail)
Relevant regressions : PASS (full 127-file suite: 2088 assertions, 2081 pass, 3 fail, 3 cancelled, 1 skipped — all 6 non-passing files confirmed pre-existing, untouched by this session via `git status`, and matching Phase 2's own documented baseline exactly; Strict Local suite 6/6 clean)
Typecheck : PASS
Build : PASS
Files changed : `cortex-server/src/lib/omega-windows-exec.js` (new), `cortex-server/src/lib/omega-capture.ps1` (new), `cortex-server/src/lib/omega-indicator.ps1` (new), `cortex-server/src/lib/omega-capture.js` (new), `cortex-server/src/lib/omega-view.js` (new), `cortex-server/src/routes/omega-view.js` (new), `cortex-server/test-omega-capture.mjs` (new), `cortex-server/test-omega-view.mjs` (new), `cortex-server/test-omega-view-route.mjs` (new), `cortex-server/src/lib/sqlite.js` (modified — additive `omega_view_sessions` table + accessors), `cortex-server/src/lib/omega-audit.js` (modified — 4 new closed-enum event types, additive), `cortex-server/src/server.js` (modified — one new import + one new route-registration block). `capabilities.ts` NOT touched (see §13).
Known limitations : Transport encryption depends on a pre-existing opt-in Cortex setting, not added this phase (§4/§14); no frontend UI this phase (§13); visible indicator is point-in-time not continuously persistent (§9); conservative 5-FPS polling ceiling by design (§3); in-process throttle state resets on Cortex restart (§14); no automated multi-physical-machine test, real capture mechanism itself independently verified on this machine instead (§14).
Verdict : PARTIAL (every mission checkpoint is PASS except "Transport encryption," which is honestly PARTIAL per the mission's own explicit instruction not to fabricate a PASS where no TLS was added this phase — all functional/security requirements — VIEW ONLY enforcement, authentication, replay protection, bounds, STOP SESSION, revocation, visible indicator, zero input injection — are fully implemented and tested PASS)

Then STOP. NE PAS COMMENCER PHASE 4 — INTERACTIVE CONTROL.
