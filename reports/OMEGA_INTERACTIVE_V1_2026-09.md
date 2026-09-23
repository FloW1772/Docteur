# DOCTEUR OMEGA INTERACTIVE V1

Date: 2026-09-22  
Scope: Phase 4 only. Phase 5 was not started.

## Architecture réelle

OMEGA INTERACTIVE reuses the existing Cortex HTTP listener and the Phase 2 device identity/pairing/session layers. It adds a separate Hono route group at `/api/omega/interactive/*`, registered alongside the existing OMEGA control and VIEW route groups; it does not create a listener, port, shell, relay, or cloud path.

The data path is:

1. Ed25519 device pairing, approval and challenge-response mutual authentication.
2. A server-minted `omega_sessions` record with device binding, permission level, expiry and nonce chain.
3. An explicit screen selection for an INTERACTIVE session.
4. Server-side validation of every input batch, followed by the injected/real SendInput provider.

Permission is read from the server-side session/device record. Client fields such as `permissionLevel` are ignored. A VIEW session cannot reach the input provider.

## SendInput mechanism

The real Windows mechanism is `user32.dll!SendInput`, invoked by the fixed repository script `src/lib/omega-input.ps1` through `execFile` with `shell: false`, `-File`, fixed positional arguments and no user text interpolated into PowerShell.

The script uses `MOUSEINPUT` and `KEYBDINPUT`. Keyboard `wScan` is always `0`; `KEYEVENTF_UNICODE` is not used. There is no free-text, `SendKeys`, `mouse_event`, or `keybd_event` path.

UIPI is preserved: a normal non-elevated process cannot inject into elevated/admin windows. The API reports the actual `sent` count and can honestly return `sent < requested` or zero. OMEGA does not bypass UIPI, UIAccess, UAC, secure desktop, Ctrl+Alt+Del, elevation, services, drivers or DLL injection. UAC secure desktop and Secure Attention Sequence are unsupported by design.

## Exact input allowlists and bounds

Mouse event types:

- `MOVE`
- `LEFT_DOWN`, `LEFT_UP`
- `RIGHT_DOWN`, `RIGHT_UP`
- `WHEEL`

Keyboard event types are `KEY_DOWN` and `KEY_UP` only. The exact virtual-key allowlist is:

- `A-Z`: `0x41-0x5A`
- top-row digits: `0x30-0x39`
- OEM punctuation: `0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0, 0xDB, 0xDC, 0xDD, 0xDE`
- Space, Tab, Enter, Escape, Backspace, Delete, Insert: `0x20, 0x09, 0x0D, 0x1B, 0x08, 0x2E, 0x2D`
- navigation: `0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22`
- modifiers: `0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0-0xA5`
- function keys: `0x70-0x7B` (`F1-F12`)

The bounds are:

- maximum 20 events per batch;
- minimum 50 ms between requests for one session, equivalent to 20 requests/s;
- HTTP body limit 8 KiB;
- integer coordinates only, with `0 <= x < screen.width` and `0 <= y < screen.height` on the explicitly selected monitor;
- virtual-desktop normalization is bounded to `0..65535`;
- wheel delta is a non-zero integer in `-3..3`;
- screen index must select an enumerated screen;
- SendInput PowerShell timeout is 4 s per event;
- fixed PowerShell helper timeout is 6 s by default, with 12 MiB stdout and 4 KiB stderr bounds.

Invalid data fails the whole batch before any provider event is sent. No client value becomes a PowerShell script argument without numeric/enum validation.

## Session, nonce, replay and revocation

Start and every input request revalidate the existing session through the Phase 2 nonce-chain validator. This enforces session existence, device identity binding, expiry, live device revocation, ended-session state and nonce freshness. A nonce replay, wrong device, expired session or revoked device is rejected.

STOP marks the interactive row stopped and ends the underlying OMEGA session. Later input and silent restart fail closed. STOP is idempotent at the library layer and emits an audit record. Input and lifecycle events are recorded in the OMEGA audit trail.

## Visible indicator

The controlled Windows machine receives the fixed notification title:

`OMEGA — INTERACTIVE CONTROL ACTIVE`

The indicator is a real `NotifyIcon`/balloon-tip notification at start and a distinct session-ended notification at STOP. It is point-in-time/transient, not a persistent tray icon for the entire session. The report does not claim persistence.

## Safety strategy

The real SendInput tests remain deliberately limited to:

- safe mouse MOVE;
- VK_SHIFT down/up alone.

No real click, right click, Enter, Delete, Win combination, Ctrl/Alt combination, text or character injection was enabled. The additional real-injection scenarios remain explicit opt-in only and were not activated. HTTP and orchestration tests use an injected fake provider and therefore perform no real click or keystroke.

Static inspection found no arbitrary shell, elevation, persistence, cloud relay, clipboard, file transfer or ADMIN action path. The only `-Command` occurrence in the OMEGA execution helper is a fixed, repo-authored, argument-free inline command path used for screen enumeration/indicator support; input uses fixed `-File` invocation and `shell: false`.

## Tests

Phase 4 additions:

| File | Tests | Pass | Fail | Cancelled | Skipped |
|---|---:|---:|---:|---:|---:|
| `test-omega-input.mjs` | 20 | 18 | 0 | 0 | 2 |
| `test-omega-interactive.mjs` | 28 | 28 | 0 | 0 | 0 |
| `test-omega-interactive-route.mjs` | 11 | 11 | 0 | 0 | 0 |
| **Phase 4 additions** | **59** | **57** | **0** | **0** | **2** |

The two `test-omega-input.mjs` skips are the expected opt-in-only real scenarios. The default real tests proved mouse MOVE and SHIFT down/up on this Windows machine.

All OMEGA files (`test-omega-*.mjs`): **200 tests, 197 pass, 0 fail, 0 cancelled, 3 skipped**. The three skips are expected non-default/opt-in cases. The new HTTP route tests use real Hono requests, real pairing/session tokens and a safe injected input provider.

Strict Local checks:

- `test-strict-local-centralized.mjs`: 6/6 pass;
- `test-phase1-egress-certification.mjs`: 7/7 pass;
- `test-omega-security.mjs`: 6/6 pass;
- the per-session throttle map removes stale entries after 60 seconds and deletes the entry on STOP;
- Phase 4 cloud calls: 0;
- relay: 0;
- external provider calls: 0.

Full backend regression, run file by file with `node --test --test-timeout=20000`:

- 130 files;
- 2147 tests;
- 2138 pass;
- 3 fail;
- 3 cancelled;
- 3 skipped.

The six non-passing files are exactly the known baseline files and were not changed:

- `test-cyber-audit-crawler.mjs`: 1 cancelled;
- `test-find-eval.mjs`: 1 fail;
- `test-maitre-executor-level2.mjs`: 1 cancelled;
- `test-regression-api.mjs`: 1 cancelled;
- `test-video-manual.mjs`: 1 fail;
- `test-video-pipeline.mjs`: 1 fail.

Typecheck: `npx tsc --noEmit` PASS.  
Build: `npm run build` PASS, with the existing large-chunk warning only.  
Server boot: PASS. The live server used the existing `127.0.0.1:3001` listener; an HTTP request reached the interactive route and returned the expected 400 for an invalid session path. The smoke process was stopped afterward. `node src/server.js --check` remains `degraded` when Ollama is not running, which is an environment/provider status and not an OMEGA route failure.

## Transport and known limitations

Transport encryption remains **PARTIAL**, unchanged from Phase 3. Session authentication and replay protection are present, but TLS confidentiality depends on the pre-existing user-controlled Cortex HTTPS/certificate configuration. Phase 4 did not add encryption infrastructure.

The indicator is transient rather than persistent. The request throttle and challenge/session auxiliary state are in-process and reset on Cortex restart. UIPI/elevated windows and secure desktop are explicitly unsupported. No automated second-physical-machine test was added; the route tests simulate the second authorized device with real HTTP and cryptographic session flow.

## DOCTEUR OMEGA INTERACTIVE CHECKPOINT

Mouse control : PASS  
Keyboard control : PASS  
VIEW cannot inject : PASS  
INTERACTIVE permission enforcement : PASS  
Device identity binding : PASS  
Replay protection : PASS  
Revocation : PASS  
Rate limits : PASS  
Bounds : PASS  
Visible indicator : PASS (point-in-time notification)  
STOP SESSION : PASS  
UIPI boundary preserved : PASS  
Secure desktop bypass : 0 attendu  
KEYEVENTF_UNICODE : 0 attendu  
Free-text keyboard injection : 0 attendu  
Admin actions : 0 attendu  
Arbitrary shell : 0 attendu  
Elevation : 0 attendu  
Hidden persistence : 0 attendu  
Cloud relay : 0 attendu  
Clipboard access : 0 attendu  
File transfer : 0 attendu  
Strict Local : PASS  
OMEGA tests : 197/200  
skipped : 3  
failed : 0  
cancelled : 0  
Relevant regressions : PASS (no new failure; known baseline non-passers unchanged)  
Full backend regression : PARTIAL — 2147 tests, 2138 pass, 3 fail, 3 cancelled, 3 skipped; six known baseline files only  
Typecheck : PASS  
Build : PASS  
Server boot : PASS  
Files changed : `cortex-server/src/lib/omega-interactive.js` (real error-contract fix), `cortex-server/test-omega-interactive-route.mjs` (new HTTP/Hono coverage), `reports/OMEGA_INTERACTIVE_V1_2026-09.md` (this report), plus the pre-existing Phase 4 files listed by Git status  
Known limitations : transport encryption PARTIAL; transient indicator; UIPI/elevated/secure-desktop unsupported; in-process throttle/session auxiliary state; no second physical machine in automated tests  
Verdict : PARTIAL

Phase 5 was not started.
