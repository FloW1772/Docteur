# DOCTEUR OMEGA V2 OUTBOUND VIEW V1

Date: 2026-09-25  
Scope: Phase 3 final validation (Phase 3.1). No Phase 4, input injection, admin capability, cloud relay or Device Fabric routing.

## Final verdict

**PASS.** The VIEW path was exercised with a real Windows capture through the two-process TLS and signature transport, the browser pipeline passes 17/17, SAN and pin validation fail closed, and all 14/14 OMEGA V2 tests pass. The real second-device test remains `NOT_RUN`, which is allowed because the network/TLS harness and real Windows capture are complete.

## Final architecture

```text
local user -> loopback VIEW API -> signed OMEGA V2 session request
           -> strict TLS + SAN + exact pin -> in-memory Windows capture
           -> signed bounded PNG frame -> loopback read-only viewport
```

Only `VIEW_START`, `VIEW_FRAME`, `VIEW_STATUS` and `VIEW_STOP` exist. There is no generic RPC, input route, remote shell, file-transfer route, cloud relay or new production listener. Frames are pulled on demand; no capture loop or recording is started automatically.

Every request is signed over the exact controller id, host id, session id, request id, method, path, timestamp, nonce and body hash. Every frame is also bound to its stream id, frame id, monotonic sequence, timestamp, MIME type, dimensions, screen index and raw body hash.

## Limits and backpressure

- PNG only, structurally checked through `IHDR`, `IDAT` and final `IEND`.
- 8 MiB maximum frame size and 7680 px maximum dimension.
- 2 FPS maximum (`500 ms` minimum interval).
- One in-flight capture and one retained latest frame per stream; replacement drops the old reference.
- No client-side request queue and no automatic retry/reconnect.
- Maximum stream lifetime: 10 minutes and never beyond session expiry.
- Explicit screen selection; invalid screens fail closed.
- Frame memory is replaced in memory and cleared on every STOP path. No frame or screenshot is written by Phase 3.

The slow-client tests confirm bounded memory/queue behavior, rejection of concurrent pulls, rate limiting and old-frame replacement.

## Bugs found and corrected in Phase 3.1

Only defects in the existing Phase 3 path were changed:

1. The UI could fail to request its first frame while the host was still in `VIEW_STARTING`.
2. Polling could race ahead of the `VIEW_START` response on a slow host and incorrectly settle on `REMOTE_STOPPED`.
3. A late start/poll continuation could overwrite a STOP or network-error state.
4. A frame `GET` could be retried by a browser after an interrupted response; the loopback frame pull is now a semantic `POST` and remains explicitly initiated.
5. Frame validation did not fully bind and reject every wrong device/session/stream, duplicate frame id, sequence replay, MIME/body tamper and malformed PNG case.
6. The UI marked a received blob `VIEWING` before decoding it; it now validates MIME and completes browser PNG decoding first.
7. A capture already in flight when STOP arrived could still complete and return one stale frame; it is now rejected after capture and its buffer is zeroed.
8. An unreachable host-side stream depended on another request to observe expiry; an unreferenced expiry timer now clears its frame and indicator even after network loss.
9. A late controller-side frame response could race a local STOP; it is now bound to the original active view object and zeroed instead of being committed after STOP.

The delayed-start browser case proves that zero frame requests are made before `VIEW_START` completes.

## SAN, TLS and certificates

`test-omega-outbound-certificates.mjs` generated short-lived OpenSSL certificates in an OS temporary directory. The valid certificate contained `localhost`, `127.0.0.1` and the active RFC1918 address `192.168.1.14`.

| Case | Result |
|---|---|
| Valid localhost SAN | PASS |
| Valid 127.0.0.1 SAN | PASS |
| Valid RFC1918 IP SAN | PASS |
| Wrong SAN | REJECT |
| Wrong IP/address binding | REJECT |
| Wrong hostname | REJECT |
| Wrong pin | REJECT |
| Changed/untrusted certificate | REJECT |

TLS uses Node's native `tls.checkServerIdentity`, `rejectUnauthorized: true`, the exact certificate pin and the connected socket IP. There is no trust-all callback or identity bypass. Test keys/certificates were deleted in cleanup; no CA was installed and Windows global trust was not changed.

A deployed LAN host must still provision and pin a certificate whose SAN includes the exact address used by the controller. A generic certificate without that IP is correctly rejected; this is an operational prerequisite, not a bypass.

## Real Windows capture smoke

**PASS.** Two controlled checks were completed on the available Windows desktop:

- direct real capture: 2 screens enumerated; screen index 1 produced a validated `1920x1080` PNG of `1,791,780` bytes;
- real Phase 3 two-process path: the Windows provider captured `1536x864`, transported `1,451,616` bytes through real HTTPS, SAN/pin checks and signed frame verification, then validated the browser-compatible PNG result.

The buffers remained in memory and were zeroed/released after the smoke. No screenshot, video or frame artifact was persisted. The harness used its controlled test indicator while exercising the real capture provider; no input or admin capability was involved.

## Browser and viewport safety

Command: `node scripts/test-omega-outbound-view-browser.mjs`  
Result: **17/17 PASS**.

Covered cases include UI opening, `OMEGA VIEW ONLY`, connected session/device status, delayed start, decoded first frame, STOP VIEW, STOP SESSION, remote STOP, network failure, expired session, TLS identity failure, invalid PNG, inert XSS device/error strings and no browser errors.

With the viewport focused, click, keyboard, wheel and pointer-move events generated exactly **0** remote input requests. The image has `pointer-events: none`; no input-forwarding handler or route exists.

## Frame attack matrix

All negative cases are rejected:

- wrong session, device or stream;
- replayed/non-monotonic sequence;
- duplicate frame id;
- signature/body tamper;
- oversized body;
- invalid/truncated PNG;
- wrong MIME type;
- invalid dimensions or dimension mismatch.

Frame signatures, response signatures and error responses are validated against the expected host identity and active session. Replay state is bounded.

## STOP and failure behavior

`STOP VIEW`, `STOP SESSION`, host-side remote STOP, revocation, session expiry and network loss all invalidate the stream, clear the bounded frame reference, end polling/timers and stop further capture. A transport failure ends the session; a view-only error stops the view without silently reconnecting. Automatic restart/reconnect count: **0**.

The two-process harness covers controller STOP, active remote STOP, reconnect followed by STOP, and network loss while VIEW is active.

## Regression results

| Check | Result |
|---|---|
| OMEGA V2 outbound | **14/14 pass**, 0 fail/cancel/skip |
| Two-process TLS/VIEW harness | **PASS** |
| Browser VIEW | **17/17 pass** |
| OMEGA V1 | **224/227**, 0 fail, 3 historical skips |
| Device Fabric V1 | **84/84**, 0 fail/skip |
| RASSILON V1 | **252/253**, 0 fail, 1 historical Ollama skip |
| Typecheck `npx tsc --noEmit` | **PASS** |
| Build `npm run build` | **PASS**; historical chunk-size warning only |
| Isolated boot | **PASS** |
| Real second device | **NOT_RUN**; no second PC was supplied |

### Full backend

The certified command used all `test-*.mjs`, a 180-second timeout, concurrency 4 and Node's required experimental module-mock flag.

| Tests | Pass | Fail | Cancelled | Skipped |
|---:|---:|---:|---:|---:|
| 2546 | 2537 | 4 | 1 | 4 |

This is exactly `+4 tests / +4 pass` relative to the Phase 2 baseline of `2542 / 2533 / 4 / 1 / 4`. There are **0 new failures** and **0 OMEGA V2 failures**. The four historical failure counts remain associated with the pre-existing manual/environmental files `test-find-eval.mjs` (requires an external visible Vite app), `test-regression-api.mjs` (historical 180-second test-server timeout) and `test-video-manual.mjs` (historical cwd-dependent manual path). The cancelled/skipped counts are unchanged. OpenMontage passed in the final configured run.

## Boot, frozen scope and exposure

The isolated server booted on test port `127.0.0.1:3998` with temporary SQLite, LanceDB and log paths. `/api/omega/outbound/sessions` returned 200 with an empty session list: no auto-connect and no auto-view. The global health endpoint was degraded only because Ollama was absent. The exact smoke PID was stopped and its temporary directory removed.

OMEGA adds no production listening port: inbound semantic routes are mounted on the existing Cortex server. Device Fabric source files were not changed, its regression suite remains 84/84, and OMEGA routing through Fabric remains 0.

Static review confirms 0 mouse/keyboard injection, INTERACTIVE/ADMIN execution, remote shell/terminal, arbitrary code/executable path, file transfer, clipboard, credential, audio or camera capability.

## Secrets and gitignore

- tracked private key/session secret/test private key: **0**;
- tracked certificate/database/frame artifact: **0**;
- real token pattern match in Phase 3 sources/tests: **0**;
- persisted real screen frame: **0**.

Existing ignore rules cover `certs/`, private-key extensions, SQLite databases and journals, `cortex-server/data/`, `.tmp/`, logs, Playwright reports and browser evidence. Explicit checks confirmed representative test certificates, DBs, captures, logs and temp artifacts are ignored, while the source, test and report files are trackable. No `.gitignore` change was necessary.

## Files in the OMEGA V2 outbound change set

- `cortex-server/src/server.js`
- `cortex-server/src/lib/omega-outbound-client.js`
- `cortex-server/src/lib/omega-outbound-identity.js`
- `cortex-server/src/lib/omega-outbound-network.js`
- `cortex-server/src/lib/omega-outbound-protocol.js`
- `cortex-server/src/lib/omega-outbound-store.js`
- `cortex-server/src/lib/omega-outbound-view.js`
- `cortex-server/src/routes/omega-outbound.js`
- `cortex-server/fixtures/omega-outbound-server-child.mjs`
- `cortex-server/test-omega-outbound-certificates.mjs`
- `cortex-server/test-omega-outbound-harness.mjs`
- `cortex-server/test-omega-outbound-protocol.mjs`
- `cortex-server/test-omega-outbound-route.mjs`
- `cortex-server/test-omega-outbound-view.mjs`
- `src/components/settings/OmegaOutboundViewTab.tsx`
- `src/components/modals/SettingsModal.tsx`
- `scripts/omega-outbound-view-harness.jsx`
- `scripts/test-omega-outbound-view-browser.mjs`
- `reports/OMEGA_V2_OUTBOUND_ARCHITECTURE_2026-09.md`
- `reports/OMEGA_V2_OUTBOUND_TRANSPORT_V1_2026-09.md`
- `reports/OMEGA_V2_OUTBOUND_VIEW_V1_2026-09.md`

## Remaining limitations

1. A real second physical PC was not supplied, so that test is `NOT_RUN`.
2. LAN deployment must provision a certificate with the exact controller-used IP/DNS SAN and pin it; incompatible certificates fail closed.
3. The repository-wide run still contains its unchanged historical/manual non-pass baseline described above; none is in OMEGA V1/V2, Device Fabric or RASSILON.

No Phase 4 work was started.

## Final checkpoint

```text
DOCTEUR OMEGA V2 OUTBOUND PHASE 3 FINAL CHECKPOINT

OMEGA V1 preserved :
PASS

Device Fabric preserved :
PASS

RASSILON preserved :
PASS

VIEW implemented :
PASS

VIEW ONLY enforced :
PASS

TLS mandatory :
PASS

SAN validation :
PASS

TLS bypass :
0

Certificate pinning :
PASS

Authenticated frames :
PASS

Frame replay protection :
PASS

Frame tamper rejection :
PASS

Frame limits :
PASS

Backpressure :
PASS

Real Windows capture smoke :
PASS

Browser tests :
17/17

STOP VIEW :
PASS

STOP SESSION :
PASS

Remote STOP :
PASS

Network drop :
PASS

Mouse injection :
0

Keyboard injection :
0

INTERACTIVE execution :
0

ADMIN execution :
0

File transfer :
0

Clipboard :
0

Credential access :
0

Screen persistence :
0

Device Fabric OMEGA routing :
0

Real second-device test :
NOT_RUN

OMEGA V2 tests :
14/14

OMEGA V1 regressions :
PASS

Device Fabric regressions :
PASS

RASSILON regressions :
PASS

Full backend regression :
2546 total; 2537 pass; 4 historical fail; 1 cancelled; 4 skipped; 0 new OMEGA V2 failure

Typecheck :
PASS

Build :
PASS

Server boot :
PASS

Secret scan :
PASS

Gitignore :
PASS

Files changed :
21 files in the OMEGA V2 outbound change set, listed above

Known limitations :
Second physical PC NOT_RUN; deployment certificate must contain the exact LAN SAN; historical/manual full-backend non-pass baseline unchanged

Report :
reports/OMEGA_V2_OUTBOUND_VIEW_V1_2026-09.md

Final verdict :
PASS
```
