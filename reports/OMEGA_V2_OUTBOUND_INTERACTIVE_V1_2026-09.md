# DOCTEUR OMEGA V2 OUTBOUND INTERACTIVE V1

Date: 2026-09-25  
Scope: Phase 4 (resume and finalization of secure INTERACTIVE control V1). This phase adds no ADMIN capability, starts no Phase 5 work and makes no Device Fabric change.

## Final verdict

**PASS.** Every item of the Phase 4 PASS rule is met.

| Suite | Result |
|---|---|
| OMEGA V2 tests | 39/39 |
| Two-process TLS harness | PASS, including INTERACTIVE |
| Phase 4 browser harness | 58/58 |
| Phase 3 browser harness | 17/17 |
| OMEGA V1, Device Fabric and RASSILON regressions | exactly at baseline |
| Full backend | 0 new failures |
| Typecheck, build and isolated boot | PASS |

The real Windows input smoke is **NOT_RUN (inconclusive)**. Its gates refused to act in 3 of 4 runs (see the Windows input smoke section). The real second-device test is **NOT_RUN**, because no second PC was supplied. Neither item is part of the PASS rule.

The resume audit found and fixed two real defects in pointer coalescing and several hardening gaps. All are listed under "Defects found and fixed during the resume".

## Final architecture

```text
controller UI (loopback, explicit START) -> local API /api/omega/outbound/sessions/:id/input/{pointer|button|wheel|key}
  -> controller client: operationId + streamId + screenIndex, Ed25519-signed envelope
  -> strict TLS + SAN + exact certificate pin -> host adapter /api/omega-v2/sessions/:id/input/{category}
  -> envelope verification (device, session, path, body hash, timestamp, nonce replay, trust, expiry)
  -> INTERACTIVE manager (permission, VIEW binding, stream/screen binding, operationId replay,
     per-category rate limit, lease, semantic validation, bounded ordered queue)
  -> V1 SendInput primitive (fixed script, numeric args)  |  V2 middle-button adapter (fixed script)
```

INTERACTIVE starts only after an explicit user START on an already VIEWING stream. It is bound to one session, one VIEW `streamId` and one `screenIndex`. It is never started by boot, voice, an agent, Device Fabric or automation. The only callers of INTERACTIVE start and input are the local route and the explicit button in `OmegaOutboundViewTab`.

Only four semantic categories exist:
- `pointer`: an absolute normalized move;
- `button`: LEFT, RIGHT or MIDDLE, with DOWN or UP;
- `wheel`: an integer delta from -3 to 3, never 0;
- `key`: an allowlisted `KeyboardEvent.code`, with DOWN or UP.

There is no text, command, RPC, clipboard, file or ADMIN route.

## SendInput V1 reuse

OMEGA V1 is unchanged. Pointer, left and right buttons, wheel and keys are converted to V1 tuples by the V1 `validateInputEvent`. They are executed by the V1 `sendInputBatch`, which calls `runFixedPowerShellScript` with:
- an absolute script path;
- `-File`;
- `execFile` without a shell;
- numeric arguments restricted to `/^[A-Za-z0-9_.:\\/-]{1,260}$/`.

V1 normalizes pixels to 0..65535 over the virtual desktop (`px·65536/width`). Each event is one `SendInput` call. V1's VK allowlist applies on top of the V2 key allowlist.

## V2 middle-button adapter

V1 has no middle button, so `omega-outbound-middle-input.ps1` is a fixed companion script:
- It accepts numeric arguments only: state 1 or 2, then x and y in 0..65535. Each is range-checked.
- It makes one `SendInput` call with `MOVE|ABSOLUTE|VIRTUALDESK` plus `MIDDLEDOWN` or `MIDDLEUP`, and prints JSON.
- It installs no hooks, reads no keyboard or clipboard, and starts no process.

Its path is now resolved with `fileURLToPath`, so a checkout path containing spaces works.

## Permission model

| Permission | VIEW | INTERACTIVE | ADMIN actions |
|---|---|---|---|
| `VIEW` | yes | no | no |
| `INTERACTIVE` | yes | yes | no |
| `ADMIN` | yes | yes | no ADMIN routes exist in OMEGA V2 |

Permission is enforced in three places:
- the session ceiling granted at connect time;
- the host adapter, on every `interactive/start` and every `input/*` request (`403 PERMISSION_DENIED`);
- the manager `start()`.

A VIEW-only session gets `PERMISSION_DENIED` for all four input categories. Tests prove it, and 0 events reach SendInput. The browser keeps START INTERACTIVE disabled for VIEW sessions.

## Input protocol

Every input request is a signed session envelope. The signature covers:
- controller id, host id, session id and request id;
- method and exact path;
- timestamp, which must be within ±60 s;
- a 192-bit nonce, stored hashed for replay protection;
- a SHA-256 hash of the payload.

The payload key sets are exact:

- pointer: `operationId, streamId, screenIndex, x, y`
- button: `+ button, state`
- wheel: `+ delta`
- key: `operationId, streamId, screenIndex, key, state`

Any extra key is rejected with `INPUT_INVALID`. This covers `__proto__`, `constructor` and `text`.

`operationId` must be a UUID and is replay-checked in a bounded set of 1024 entries.

The host adapter now requires `Content-Type: application/json` (`415` otherwise) and a body of at most 16 KiB (`413`). A malformed, `null` or array body returns `400`; before this change it caused an unhandled exception.

Host responses are Ed25519-signed.

## Pointer mapping

Coordinates are normalized to `0 <= x,y < 1` against the displayed frame. The host maps them to pixels with `floor(x·width)`, capped at `width-1`, using the host's current screen bounds. A remote resolution change is therefore picked up on the next event.

The following are rejected with `POINTER_OUT_OF_BOUNDS`:
- negative values and values `>= 1`;
- `NaN` and `±Infinity`;
- `1e300`;
- strings, `null`, booleans, arrays and objects.

A wrong monitor gives `WRONG_SCREEN`, and a wrong stream gives `WRONG_STREAM`.

Tests cover:
- 0,0 maps to the origin;
- the right and bottom edges map to pixel `max-1`, matching V1's conversion of `1919,1079`;
- 1920×1080 and 3840×2160 give the same normalized point;
- a live change from 100×50 to 4×2.

## Letterbox mapping

The viewport renders the frame with `object-fit: contain`. The controller now computes the displayed content rectangle from `naturalWidth` and `naturalHeight`, so the letterbox bands are excluded:
- A pointer, button or wheel event over a band is not sent.
- A 4:1 frame gets horizontal bands; a 1:4 frame gets vertical bands.
- A 2× scaled viewport maps to the same normalized point.

The browser harness verifies all of this with frames of those exact ratios.

## Keyboard validation

A key is accepted only if its explicit `KeyboardEvent.code` is on the allowlist, checked with `Object.hasOwn`. The allowlist contains:
- A–Z and 0–9;
- Space, Tab, Enter, Backspace, Delete and Insert;
- the arrow keys, Home, End, PageUp and PageDown;
- Shift, Control, Alt and Meta (left and right);
- F1–F12;
- 11 OEM punctuation keys.

`Escape` has been **removed** from the host allowlist. It is the controller's local STOP and must never be transmitted, and it is now rejected on both sides.

These are rejected with `KEY_INVALID`:
- unknown names, including `Unidentified`, `NumpadEnter`, `PrintScreen`, `Pause` and media keys;
- prototype names: `toString`, `constructor`, `__proto__`, `hasOwnProperty`;
- numeric codes;
- lowercase characters.

In the browser, keys are captured only while the viewport has focus. Auto-repeat is ignored, and a key DOWN is sent only once while it is held.

## Rate limits

The limits are per stream and per category:

| Category | Limit |
|---|---|
| pointer | 30/s |
| button | 10/s |
| wheel | 8/s |
| key | 20/s |

The local API applies the same limits per session and category.

The rate check runs before semantic validation, so a flood of invalid payloads is also capped.

The flood test sends 2,000 events per category. It confirms:
- at most the per-category limit is accepted;
- every other event gets `RATE_LIMITED`;
- a flood in one category does not starve another;
- the queue stays at 32 or fewer and the operationId set at 1024 or fewer;
- execution time and RSS growth stay bounded.

## Coalescing

Only moves are coalesced. While a primitive is executing, a new move replaces the single pending move, so the latest position wins. Before any button, wheel or key event is queued, the pending move is now flushed into the queue ahead of it. This keeps DOWN/UP order and drag paths intact.

The tests confirm:
- A burst of 28 moves collapses to `queueDepth 1`.
- Exactly two moves execute, and the final position is the last move.
- `move -> DOWN -> move -> UP -> key DOWN/UP -> move` executes in that order.
- Rapid DOWN/UP pairs stay strictly ordered.

## Bounded queue

- The queue holds at most 32 items, the pending move included; beyond that the request gets `QUEUE_FULL`.
- The operationId replay set is bounded to 1024 entries.
- There is one drain per stream.
- On STOP, queued items are rejected with `INTERACTIVE_STOPPED`, and the in-flight primitive is awaited before release.

An input that races a STOP (the stream stops while `listScreens` is pending) now fails with `INTERACTIVE_STOPPED`. Before, its promise never settled.

## Network lease

The host lease lasts 6 s and is refreshed by the signed `interactive/status` keepalive, which the controller sends every 2 s, and by each input. When the lease expires, the host stops INTERACTIVE, releases held input, stops VIEW and terminates the session with reason `network_timeout`. The controller treats a network error as `network_drop` and does not reconnect.

Tested cases:
- A valid keepalive keeps the lease alive for more than 8 s.
- Silence stops everything.
- A network interruption stops everything.
- A stopped session rejects input.
- Nothing restarts automatically.

The browser harness confirms there is no automatic view or interactive restart after a drop.

## Held-key and held-button cleanup

The host tracks held keys and buttons per session. A duplicate DOWN is rejected with `DUPLICATE_DOWN`. An UP with no matching held input is an idempotent no-op and is never re-sent.

Every stop path releases the held keys, left and right buttons, and the middle button:
- STOP INTERACTIVE;
- STOP VIEW;
- STOP SESSION;
- remote/local host STOP (indicator);
- network drop (lease);
- revocation;
- a terminal envelope error;
- **session expiry**.

Only the owning session's input is released. For each path, the test holds input on a second session and verifies it is untouched.

New in this resume:
- **Session-expiry timer.** INTERACTIVE now stops at `expires_at` even when no traffic arrives. Before, expiry was only noticed through the 6 s lease.
- **Immediate release on revoked, expired or ended sessions.** When a signed `input/*`, `interactive/status` or `interactive/stop` request finds the session `DEVICE_REVOKED`, `SESSION_EXPIRED` or `REMOTE_STOPPED`, the host stops INTERACTIVE and VIEW at once and releases held input.
- **Controller-side guards.** Losing viewport focus sends UP for locally held keys and buttons. A button released outside the frame is still sent as an UP, clamped to the frame edge. Pointer capture is requested on DOWN.

## STOP semantics

| Action | Effect |
|---|---|
| STOP INTERACTIVE | Returns to VIEW; the VIEW stream keeps running. |
| STOP VIEW | Kills INTERACTIVE (`onViewStopped`). |
| STOP SESSION | Kills INTERACTIVE, then VIEW, then the session. |
| Remote STOP (host indicator) | Kills INTERACTIVE, VIEW and the session. |
| Network drop | Kills everything. |
| Expiry or revocation | Kills everything. |

After any STOP, the controller sends 0 input. The UI now uses a live ref, so pending pointer timers and stale render closures cannot send after a stop. A terminal host error (for example `SESSION_EXPIRED`, `DEVICE_REVOKED`, `WRONG_STREAM` or `INTERACTIVE_NOT_STARTED`) puts the UI back to `STOPPED`.

## Local Escape

Escape is handled in the viewport's own `keydown` listener. It releases locally held input, calls STOP INTERACTIVE and is never forwarded. The browser test confirms 0 Escape events were sent, and the host rejects `Escape` in any case.

No global Windows keyboard or mouse hook exists. A static search found no `SetWindowsHookEx`, `WH_KEYBOARD`, `WH_MOUSE`, `GetAsyncKeyState` or `RegisterRawInputDevices`.

## Audit and privacy

The INTERACTIVE audit is aggregated only. It records:
- requested, started, denied, stopped and remote-stop events;
- the category and code of rate-limited or invalid input;
- event **counts** per category at stop.

The route test inserts key names and coordinates and verifies that none of them appears in `omega_v2_audit`. No input, key, frame or clipboard table exists.

The global request logger used to persist one `request_logs` row per request, which for OMEGA would have left one row per keystroke with a timestamp: a typing-rhythm trail. `server.js` now skips per-event logging for `/api/omega-v2/sessions/:id/input/*` and `/api/omega/outbound/sessions/:id/input/*`, and for no other route. The isolated boot confirms it: 0 input rows and 7 other OMEGA rows logged.

| Data | Logged or persisted |
|---|---|
| Typed text | 0 |
| Full key sequences | 0 |
| Keystroke audit content | 0 |
| Clipboard | 0 |
| Screens | 0 |
| Credentials | 0 |

## TLS two-process harness

`test-omega-outbound-harness.mjs` runs a real controller and a real host child process over HTTPS with SAN and an exact pin. The run passes with 62 internal assertions. They cover:
- connect and signed status;
- wrong pin and wrong target;
- replay;
- VIEW frames;
- INTERACTIVE start, pointer, middle DOWN and key DOWN;
- signed status and stop;
- host-side release of held MIDDLE and KeyA;
- remote STOP and network loss.

Certificates and the database live in a `mkdtemp` directory that is removed after the run.

## Browser harness

`scripts/test-omega-outbound-interactive-browser.mjs` passes **58/58** in real Chromium against a fully mocked local API (no host, no SendInput). It covers:
- INTERACTIVE off at start and during VIEW-only;
- explicit START and the visible `INTERACTIVE` label;
- VIEW-only permission (button disabled, direct call answered 403, 0 input sent);
- horizontal and vertical letterbox bands, edges at 0 and at max-1, and a scaled viewport;
- LEFT, RIGHT and MIDDLE DOWN/UP in order;
- wheel ±1 inside the frame and 0 over a band;
- keyboard only while the viewport has focus, and non-allowlisted keys ignored;
- blur release and an UP clamped outside the frame;
- Escape local and never transmitted;
- STOP INTERACTIVE returning to VIEW;
- STOP VIEW, `SESSION_EXPIRED`, `DEVICE_REVOKED`, `WRONG_STREAM`, remote STOP, network drop (no reconnect) and STOP SESSION, each followed by 0 input;
- XSS-inert device name and remote error;
- file drop giving 0 transfer, paste giving 0 clipboard sync, the clipboard API unused and no file input;
- all traffic staying on loopback.

The positive checks wait for the expected requests rather than a fixed delay. The harness passed 58/58 in 3 consecutive runs while the full backend suite ran in parallel. An earlier fixed-delay version was flaky under that load.

## Windows input smoke

**NOT_RUN (inconclusive).** The smoke ran through the real V1 and V2 primitives against a dedicated, blank, maximized Chromium test window. Each step was gated:
1. **Move gate.** A real move had to be observed by the test window near its centre before anything else.
2. **Click.** Only then was one left click sent, on the blank page.
3. **Focus gate.** The key was sent only if the test window had focus.
4. **Key and cleanup.** One `ShiftLeft` DOWN/UP was sent, then everything was released.

No PowerShell window was opened and nothing was typed. No system button, UAC, login screen or other application was touched.

| Run | Outcome |
|---|---|
| 1 | Move gate refused; only 2 moves were sent. |
| 2 | Move and click reached the test window. Focus gate passed. `ShiftLeft` was not observed by Chromium. |
| 3 | Move gate refused (the cursor was already on the target pixel). |
| 4 | Move gate refused. |

The anomaly in run 2: the page saw 3 click sequences while exactly 2 button primitives (1 DOWN, 1 UP) were sent. Extra physical input on this active desktop is the likely cause.

No run left any key or button held. Because the desktop is in active use, the smoke was stopped rather than retried repeatedly.

**Recommendation:** run a supervised manual smoke with the user present, to confirm keyboard delivery through the V1 VK-only primitive (`wScan = 0`) on Chromium.

## Regressions

| Check | Result |
|---|---|
| OMEGA V2 tests | **39/39**. At resume there were 21 tests; this resume added 10 manager tests and a new 8-test route matrix. |
| Two-process harness | **PASS**, 62 internal assertions |
| Phase 4 browser | **58/58** |
| Phase 3 VIEW browser | **17/17** |
| OMEGA V1 | **224/227**, 0 fail, 3 historical skips |
| Device Fabric V1 | **84/84**. No Fabric file changed; `OMEGA_VIEW/INTERACTIVE/ADMIN` stay `FABRIC_NOT_ROUTABLE`; OMEGA routing through Fabric = 0. |
| RASSILON V1 | **252/253**, 0 fail, 1 historical Ollama skip |
| `npx tsc --noEmit` | **PASS** |
| `npm run build` | **PASS** |
| Isolated boot (`127.0.0.1:3995`, temporary DB) | **PASS**. 0 sessions and no auto-connect, auto-view or auto-interactive. Input without a session returns 409. Text, ADMIN and execute routes return 404. The host adapter over cleartext gives `TLS_REQUIRED`, and a foreign Origin gets 403. The only listener is the configured port, released on shutdown. Health is `degraded` only because Ollama is absent. |
| Secret scan | **PASS**. The only hit is the harness regex that extracts its ephemeral test key. |
| Gitignore | **PASS**. `.tmp/` (Vite caches) and `dist/` are ignored; harness certificates and databases are in OS temp and deleted. Source, tests and reports are trackable. |

### Full backend

The command was `node --test --test-timeout=180000 --test-concurrency=4 --experimental-test-module-mocks test-*.mjs`.

| Run | Tests | Pass | Fail | Cancelled | Skipped |
|---|---:|---:|---:|---:|---:|
| Phase 3 baseline | 2546 | 2537 | 4 | 1 | 4 |
| **Phase 4 final** | **2571** | **2564** | **2** | **1** | **4** |

The +25 tests are exactly the new OMEGA V2 tests (39 − 14 in the Phase 3 suite).

The failures and the cancellation are all historical or environmental:
- `test-find-eval.mjs` needs a visible Vite app on `:5173`.
- `test-video-manual.mjs` depends on the working directory.
- `test-regression-api.mjs` is cancelled on its historical 180 s timeout and open handle.

**0 new failures and 0 OMEGA failures.** Two intermediate runs each exposed an OMEGA test flaking under load, and both were fixed before this run:
- The flood test depended on wall-clock time. It now freezes `Date` only.
- The harness TTL assertion failed because of Phase 2 timestamp skew (defect 10).

## Defects found and fixed during the resume

1. **Coalesced moves never executed.** `item.resolve?.(await runPrepared(...))`: optional chaining skips evaluating the argument when `resolve` is null. A coalesced move has no resolver, so its `await runPrepared` never ran. It is now evaluated before the optional call. The previous test only checked `calls <= 2`, which is why it did not catch this.
2. **A stale pending move could overtake later DOWN/UP or key events.** The pending move is now flushed into the queue before any non-move event.
3. **Hanging promise on an input/STOP race.** An input arriving on a stopped stream is now rejected with `INTERACTIVE_STOPPED`.
4. **Unknown category crashed the manager.** `input()` with an unknown category or a non-object payload reached `stream.rate[category]`. It is now rejected with `INPUT_CATEGORY_INVALID` or `INPUT_INVALID`.
5. **Host adapter accepted any Content-Type and crashed on a malformed body.** It now returns 415 or 400.
6. **Revoked, expired or ended sessions held input until the lease ran out.** Held input is now released immediately. A session-expiry timer was also added.
7. **Escape was accepted by the host.** It has been removed from the allowlist.
8. **Controller UI.** The following were fixed:
   - stale closures could send after STOP;
   - the letterbox was not accounted for;
   - an UP outside the frame was dropped;
   - held keys were not released on blur;
   - a terminal host error left the UI in INTERACTIVE;
   - the wheel listener was passive, so `preventDefault` was ignored;
   - `Â·` was shown instead of `·`.
9. **Privacy.** The per-keystroke request-log trail was removed.
10. **Session TTL off by up to 1 ms.** This is pre-existing Phase 2 code, found through an intermittent harness failure under load. `POST /omega-v2/sessions` computed `createdAt` and `expiresAt` from two separate `Date.now()` calls, so the TTL could come out 1 ms longer than 15 min. Both now come from a single timestamp. The harness then passed 3/3.

## Files changed in Phase 4

- `cortex-server/src/lib/omega-outbound-interactive.js`
- `cortex-server/src/lib/omega-outbound-input.js`
- `cortex-server/src/lib/omega-outbound-middle-input.ps1`
- `cortex-server/src/lib/omega-outbound-client.js` (INTERACTIVE functions)
- `cortex-server/src/routes/omega-outbound.js` (INTERACTIVE and input routes, host adapter hardening)
- `cortex-server/src/server.js` (route mount from Phase 2; skip per-event input request logging)
- `src/components/settings/OmegaOutboundViewTab.tsx`
- `cortex-server/test-omega-outbound-interactive.mjs`
- `cortex-server/test-omega-outbound-interactive-route.mjs` (new)
- `cortex-server/test-omega-outbound-harness.mjs`
- `cortex-server/fixtures/omega-outbound-server-child.mjs`
- `scripts/test-omega-outbound-interactive-browser.mjs`
- `reports/OMEGA_V2_OUTBOUND_INTERACTIVE_V1_2026-09.md`

Unchanged: OMEGA V1 files, Device Fabric files and RASSILON files.

## Limitations

- The real Windows input smoke is **NOT_RUN (inconclusive)**: keyboard delivery through the V1 VK-only primitive is unconfirmed on Chromium. It needs a supervised manual smoke.
- The real second-device test is **NOT_RUN**.
- Auto-repeat is not forwarded: a held key sends one DOWN only.
- There is no text entry, IME or composition. Only allowlisted physical keys are sent, and non-US layouts send positions, not characters.
- Key combinations built from allowed keys are possible, as on a physical keyboard (for example Win+L). Ctrl+Alt+Del and the secure desktop cannot be synthesized by `SendInput`.
- Each primitive spawns one fixed PowerShell process (V1 design), which limits real throughput to a few events per second. Coalescing and the per-category limits keep this bounded.
- The UI component and harness keep the Phase 3 names `OMEGA VIEW ONLY` and `Read-only remote viewport` so the Phase 3 selectors stay stable. The `INTERACTIVE:` state label and the pink viewport border mark active control.
