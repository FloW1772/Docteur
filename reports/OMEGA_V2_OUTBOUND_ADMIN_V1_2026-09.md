# DOCTEUR OMEGA V2 OUTBOUND ADMIN V1

Date: 2026-09-28
Scope: Phase 5 — secure ADMIN semantic actions over the OMEGA V2 outbound transport. Additive only. No shell, terminal, generic executor, file transfer, clipboard, credential access, Device Fabric routing or Device Fabric V2 work.

## Final verdict

**PASS.** Every item of the Phase 5 PASS rule is met; see the checkpoint at the end.

| Suite | Result |
|---|---|
| OMEGA V2 tests | **77/77** (39 Phase 2–4 + 38 Phase 5) |
| Two-process TLS ADMIN harness | **10/10** subtests |
| ADMIN browser harness | **41/41** (3 consecutive runs) |
| Phase 4 browser harness | **58/58** (see flake note) |
| Phase 3 browser harness | **17/17** |
| OMEGA V1 | **224/227**, 0 fail, 3 historical skips |
| Device Fabric V1 | **84/84** |
| RASSILON V1 | **252/253**, 0 fail, 1 historical Ollama skip |
| Full backend | 2609 tests, 2600 pass, 4 fail, 1 cancelled, 4 skipped: **0 NEW** |
| Typecheck / build / isolated boot | PASS / PASS / PASS |

Real high-impact execution: **0**. Real second device: **NOT_RUN**.

## Baseline audit (before any change)

`git status` matched the Phase 4 state exactly: only `cortex-server/src/server.js` and `src/components/modals/SettingsModal.tsx` modified, every OMEGA V2 file untracked. The OMEGA V2 suite passed 39/39 before modification.

OMEGA V1 ADMIN was audited in code (`omega-admin.js`, `omega-admin.ps1`, `omega-admin-prompt.ps1`, `omega-admin-registry.js`, `omega-windows-exec.js`), not assumed from its report:

- **Permission model:** `omega_sessions.permission_level >= OMEGA_ADMIN`, bound to V1 sessions and the V1 nonce chain. It cannot be called by a V2 session, so V2 needs its own authorization layer.
- **Semantic enum:** nine V1 actions, a `ValidateSet` in the fixed `omega-admin.ps1`, arguments forced to `{}`.
- **Typed executors:** `getSystemInfo`, `getProcessList`, `getServiceStatus`, `getNetworkStatus`, `getDiskStatus`, `lockWorkstation`, `requestLogoff`, `requestRestart`, `requestShutdown`. Each is zero-argument and calls `runFixedPowerShellScript(ADMIN_SCRIPT_PATH, [action])`: absolute script, `-File`, `execFile`, `shell:false`, regex-checked arguments, 8 s timeout.
- **High-impact:** only `LockWorkStation` and `ExitWindowsEx` (no force flag).
- **Local approval:** a visible WinForms `OMEGA ADMIN REQUEST` prompt (`ALLOW ONCE` / `DENY`), a lease file heartbeat, a 30 s timeout and a SHA-256 binding. Any failure means DENY.
- **Result bounds:** 200 processes, 200 services, 64 interfaces, 32 disks, 512 KiB.
- **Tests:** high-impact tests use a fake executor. Real LOCK/LOGOFF/RESTART/SHUTDOWN were never run.

V1 exposes command-line-free process rows, but its network rows contain `macAddress` and its process rows contain a Windows `sessionId`. V2 drops both in its own projection.

**V1 files changed by Phase 5: 0.**

## Architecture

```text
local user click (loopback UI, typed confirmation for high impact)
  -> local API /api/omega/outbound/sessions/:id/admin/<semantic route>
  -> controller typed function (exact ADMIN permission, local quotas, UUID operationId)
  -> Ed25519-signed V2 envelope (device, session, requestId, method, path, timestamp, 192-bit nonce, body hash)
  -> strict TLS + SAN + exact certificate pin
  -> host adapter /api/omega-v2/sessions/:id/admin/{request|status|cancel}
  -> envelope verification + exact permission + closed enum + exact payload keys + quotas
  -> host ADMIN manager -> [high impact: host-local approval] -> typed V1 executor
  -> safe projection -> host-signed, operation-bound ADMIN_RESULT
  -> controller: signature + binding + strict schema re-validation -> UI (text only)
```

New modules and changes:

| File | Role |
|---|---|
| `src/lib/omega-outbound-admin.js` (new) | closed enum, safe schemas and projection, typed executor binding, host ADMIN manager, V1-prompt approval channel |
| `src/lib/omega-outbound-client.js` | typed controller ADMIN functions, result binding, pending-operation monitor |
| `src/routes/omega-outbound.js` | host `ADMIN_*` routes, loopback semantic routes, STOP/revocation wiring |
| `src/lib/omega-outbound-store.js` | 8 closed audit events (additive) |
| `src/lib/omega-outbound-protocol.js` | `OMEGA_V2_ADMIN_MESSAGES` (additive) |
| `src/lib/omega-outbound-network.js` | optional `maxResponseBytes` for JSON responses (default unchanged: 64 KiB) |
| `src/components/settings/OmegaOutboundAdminPanel.tsx` (new) | ADMIN UI |
| `src/components/settings/OmegaOutboundViewTab.tsx` | renders the panel only for CONNECTED ADMIN sessions |

`server.js` is unchanged by Phase 5. The route was already mounted on the existing Cortex listener, so there is **no new listener or port**.

## ADMIN permission model

- The host decides the session permission at handshake time (Phase 2). It is never re-read from a payload.
- Every ADMIN message requires `session.permission === 'ADMIN'` exactly. The host checks it on every request, status and cancel. The controller checks it before any network call.
- VIEW and INTERACTIVE sessions get `403 PERMISSION_DENIED` from the host and `PERMISSION_DENIED` from the controller. Nothing is executed or approved, and the denial is audited.
- There is no upgrade path. A `permission` field in a payload is rejected as `ADMIN_PAYLOAD_INVALID`, and the tests confirm the stored permission is unchanged after an attempt.
- ADMIN keeps the V1 meaning: semantic allowlist only. It is never Windows Administrator, never elevation.

## Semantic allowlist

| V2 action | Class | V1 typed executor | V1 enum |
|---|---|---|---|
| `GET_SYSTEM_INFO` | read-only | `getSystemInfo()` | `GET_SYSTEM_INFO` |
| `PROCESS_LIST` | read-only | `getProcessList()` | `GET_PROCESS_LIST` |
| `SERVICE_STATUS` | read-only | `getServiceStatus()` | `GET_SERVICE_STATUS` |
| `NETWORK_STATUS` | read-only | `getNetworkStatus()` | `GET_NETWORK_STATUS` |
| `DISK_STATUS` | read-only | `getDiskStatus()` | `GET_DISK_STATUS` |
| `LOCK` | high impact | `lockWorkstation()` | `LOCK_WORKSTATION` |
| `LOGOFF` | high impact | `requestLogoff()` | `REQUEST_LOGOFF` |
| `RESTART` | high impact | `requestRestart()` | `REQUEST_RESTART` |
| `SHUTDOWN` | high impact | `requestShutdown()` | `REQUEST_SHUTDOWN` |

- The host maps the enum to a fixed method name on a typed executor object (`getSystemInfo`, `listProcesses`, … `requestShutdown`). Every method takes zero parameters.
- There is no `executeAdmin(action, payload)`.
- The request payload key set is exactly `{ operationId, actionType }`. Any other key is rejected, including `command`, `script`, `arguments`, `args`, `executable`, `shell`, `powershell`, `cmd`, `path`, `query`, `wmi`, `registryPath`, `approved`, `approval`, `permission` and `__proto__`.
- Unknown, lowercase, V1-named (`LOCK_WORKSTATION`), prototype-named and non-string actions are rejected with `ADMIN_ACTION_INVALID`.
- The executor also checks the V1 action echo: a result whose `action` differs from the expected V1 enum fails with `ADMIN_RESULT_INVALID`.
- Service start/stop/restart, process kill and registry access do not exist.

## Read-only schemas

The host projects every V1 result onto an allowlist. The controller then re-validates the exact schema (exact keys, types, bounds, no control characters) and rejects the whole result on any mismatch.

| Action | Result |
|---|---|
| `GET_SYSTEM_INFO` | `{ system: { computerName≤64, osCaption≤128, osVersion≤64, architecture≤32, lastBootUpTime≤64 } }` |
| `PROCESS_LIST` | `{ processes: [{ pid, name≤128, memoryBytes\|null, cpuSeconds\|null }] ≤200, count, truncated }` |
| `SERVICE_STATUS` | `{ services: [{ name≤128, displayName≤256, state≤32, startMode≤32 }] ≤200, count, truncated }` |
| `NETWORK_STATUS` | `{ interfaces: [{ description≤128, dhcpEnabled, addresses≤16, gateways≤8, dnsServers≤8 }] ≤32, count, truncated }` |
| `DISK_STATUS` | `{ disks: [{ drive≤8, filesystem≤16, totalBytes, freeBytes }] ≤32, count, truncated }` |
| high impact | `{ accepted: boolean }` |

These are never returned: command line, environment, user, handles, Windows session id, MAC address, Wi-Fi/proxy secrets, service binary path or account, file lists or contents, product keys and serial numbers. The tests inject all of them into executor output and verify none survives projection.

**Response limits and DoS:**
- Rows are sorted deterministically: processes by pid, services by name, interfaces by description, disks by drive.
- Rows are then truncated by count, and then by serialized size (96 KiB maximum).
- `truncated` is true when a cap was reached or rows were dropped.
- A 5,000-process list returns exactly pids 1..200 with `truncated: true`, identically on repeat.
- The controller accepts at most 160 KiB per ADMIN JSON response, against the 64 KiB default kept for all other V2 routes. The harness confirms a bounded services result above 64 KiB is carried intact.

## High-impact approval model

1. The user clicks `Request <ACTION>` in the UI. This only opens a confirmation panel that names the action and the remote device. The first click sends nothing.
2. `Confirm <ACTION> request` posts `{ "confirm": "<ACTION>" }`. The local route rejects any other body with `400 CONFIRMATION_REQUIRED`.
3. The host creates the operation as `PENDING_APPROVAL` (TTL 30 s, capped by session expiry) with a one-time 192-bit approval nonce. It stores a SHA-256 binding over operation, session, controller, host, action, expiry and nonce.
4. The **host** shows its approval channel. In production this is the certified V1 prompt `omega-admin-prompt.ps1`, reused unchanged (fixed script, `ValidateSet` action, validated device id). It is launched through the V1 fixed runner (`runFixedPowerShellScript`, `execFile`, `shell:false`). Its arguments are only the V1 enum, the controller id, two `mkdtemp` file paths and two integers.
5. A decision is accepted only if its binding matches, compared timing-safe. After three mismatched approvals the operation is denied.
6. `ALLOW` then re-checks the host session and trust from SQLite: live, not ended, not expired, exact ADMIN, controller not revoked. It also checks the operation lease and expiry, then commits and runs the typed executor. `DENY`, prompt closed, timeout, spawn failure or `UNAVAILABLE` all result in no execution.

**No self-approval.** No network route can approve: `admin/approve`, `admin/approve-local`, `admin/allow`, `admin/decision` and `admin/confirm` all return 404. Approval fields in payloads are rejected, and the controller has no approval function. The decision entry point is reachable only from the host-local channel.

**Safe default.** A missing or throwing approval provider, a non-Windows host or a prompt that fails to launch all give `DENIED / APPROVAL_UNAVAILABLE`. Approval requirements are never downgraded.

**Limits:**
- one pending high-impact operation per session;
- a 30 s minimum interval between high-impact requests on the host;
- 4 high-impact requests per minute per session on the controller;
- 30 reads per minute;
- 120 status/cancel requests per minute;
- 20 invalid attempts per minute, after which the session is locked out of ADMIN for the rest of the window;
- 180 ADMIN envelopes per minute at the route.

## Protocol, exact target and replay

The closed message set is `ADMIN_REQUEST` (`admin/request`), `ADMIN_STATUS` (`admin/status`), `ADMIN_CANCEL` (`admin/cancel`), with `ADMIN_RESULT`/`ADMIN_STATUS` responses. Every request uses the unchanged Phase 2 envelope:
- controller id, host id, session id and request id;
- method and exact path;
- timestamp within ±60 s;
- a 192-bit nonce, stored hashed;
- the SHA-256 body hash, which covers `operationId` and `actionType`.

| Attack | Result |
|---|---|
| Exact replay / reused nonce | `409 REPLAY_REJECTED`, audited `OUTBOUND_ADMIN_REPLAY_REJECTED` |
| Duplicate `operationId` (fresh nonce, same or different action) | `409 OPERATION_DUPLICATE`, deterministic, audited as replay; never re-executed |
| Stale or future timestamp | `401 AUTH_FAILURE` |
| Wrong device id / wrong signing key | `401 AUTH_FAILURE` |
| Envelope for session A sent to session B | `401 AUTH_FAILURE` |
| Unknown session | `404` |
| Another controller querying/cancelling an operation | `OPERATION_NOT_FOUND` (operations are visible only to their own session and controller) |

**Result binding.** Every response payload names `sessionId`, `controllerDeviceId`, `hostDeviceId`, `operationId`, `actionType` and `status`, and is host-signed over the request id and body hash. The controller rejects:
- a wrong operation, action, session or device: `ADMIN_RESULT_MISMATCH`;
- a type/status inconsistency;
- an unknown outcome code;
- a schema violation: `ADMIN_RESULT_INVALID`.

A signature checked against a different device or a modified operation id fails (harness).

**Exact target.** Each session is pinned to one host identity, certificate and address (Phase 2). ADMIN adds no routing, fallback or target substitution. Device A's ADMIN can only be signed for and accepted by device A.

## Timeouts

| Stage | Bound |
|---|---|
| Approval wait | 30 s (and session expiry); prompt self-closes at 30 s |
| Approval lease | pending operation cancelled `NETWORK_TIMEOUT` if no controller status for 8 s (controller polls every 2 s) |
| Execution | 10 s host race (V1 script itself 8 s) → `FAILED / EXECUTION_TIMEOUT` |
| Network request | 15 s per ADMIN envelope |
| Controller tracking | local `EXPIRED` / `FAILED` after expiry + 15 s; UI stops polling after 40 × 1.5 s |

No ADMIN operation can stay pending indefinitely.

## STOP, expiry, revocation — atomicity rules

- **Commit point.** The final liveness check and the transition to `EXECUTING` run synchronously, with no `await` between them. STOP, revocation, expiry, lease loss or cancel that land before the commit cancel the action. After the commit, a high-impact action cannot be recalled. It completes or fails within the execution timeout. This is the only non-cancellable window.
- **Controller STOP SESSION.** Cancels pending operations on the host (`CONTROLLER_STOP`), closes the approval prompt and ends the session. Later ADMIN calls get `SESSION_EXPIRED` locally or `REMOTE_STOPPED` from the host.
- **Remote STOP on the host.** The host ADMIN indicator STOP ends the session, stops INTERACTIVE/VIEW and cancels pending ADMIN. If the session is ended directly in the host database, a later approval is refused at commit (`REMOTE_STOPPED`), and the next envelope cancels everything.
- **Session expiry.** A per-session timer cancels pending operations and expires the session, and new ADMIN is rejected (`410`). A session is never resurrected.
- **Revocation.** Pending operations are cancelled (`DEVICE_REVOKED`) and new ADMIN is rejected. Reconnect is refused while revoked, and there is no automatic reconnect.
- **In-flight reads** are dropped on STOP, since they have no side effect.

## Audit and privacy

The closed enum is added to `omega_v2_audit`:
- `OUTBOUND_ADMIN_REQUESTED`
- `OUTBOUND_ADMIN_APPROVAL_REQUIRED`
- `OUTBOUND_ADMIN_APPROVED`
- `OUTBOUND_ADMIN_DENIED`
- `OUTBOUND_ADMIN_EXECUTED`
- `OUTBOUND_ADMIN_FAILED`
- `OUTBOUND_ADMIN_CANCELLED`
- `OUTBOUND_ADMIN_REPLAY_REJECTED`

Audit detail keys are limited to `operationId`, `actionType`, `status`, `expiresAt`, `attempt`, `permission` and `message`, plus a closed result code. The tests confirm the audit never contains:
- results (process names, service names, IPs, computer name);
- the approval nonce;
- payload echoes (`calc`, `cmd.exe`, `Get-Process`);
- secrets, command lines or paths.

Raw executor error text is never propagated. Both sides audit: the host records host-side events, the controller records request and terminal outcome.

## UI

`OmegaOutboundAdminPanel` is rendered only for a `CONNECTED` session whose permission is exactly `ADMIN`. It does not exist for VIEW or INTERACTIVE sessions.

- **READ-ONLY STATUS** (cyan): five read buttons. Results are rendered as plain React text in tables, which makes them XSS-inert, with a truncation notice.
- **HIGH-IMPACT ACTIONS** (red border, warning icon, explanatory text): `Request LOCK`, `Request LOGOFF`, `Request RESTART` and `Request SHUTDOWN`.
  - A request needs the confirmation panel first.
  - Only one request can be pending, and the UI shows its live status.
  - `Cancel ADMIN request` is available while approval is pending.
- **Session end:** `SESSION_EXPIRED`, `DEVICE_REVOKED`, `REMOTE_STOPPED` or `NETWORK_UNAVAILABLE` disables every control and stops polling. A client-side expiry clock also disables the panel. STOP SESSION removes the panel.
- No request is sent on mount. Every ADMIN request follows an explicit click.

## Two-process TLS harness

`test-omega-outbound-admin-harness.mjs`: process A is the real controller and process B is the host fixture. They use separate SQLite databases, identities and `mkdtemp` directories, over real HTTPS with SAN and an exact pin. The fixture **always** injects a recorder executor and an IPC-driven approval channel, so the harness cannot reach a real Windows probe or action.

| Subtest | Result |
|---|---|
| ADMIN auth (mutual TLS, pinned host, exact permission) | PASS |
| VIEW / INTERACTIVE refused by controller and by host (direct signed envelope → 403) | PASS |
| 5 read-only actions, exact schemas, 5,000 processes → 200, >64 KiB bounded response | PASS |
| LOCK/LOGOFF/RESTART/SHUTDOWN: pending → wrong-device approval rejected → approval → EXECUTED, exactly one mock call each | PASS |
| deny, cancel, approval timeout, approval unavailable → no execution | PASS |
| replay, duplicate operation, stale timestamp, wrong device/session, result binding and signature binding | PASS |
| STOP SESSION with pending action | PASS |
| remote STOP with pending action | PASS |
| revocation with pending action, reconnect refused | PASS |
| network drop: `NETWORK_UNAVAILABLE`, `network_drop`, no reconnect, controller audit privacy | PASS |

Across the run, exactly the four approved high-impact mocks executed.

## High-impact mock tests

- `test-omega-outbound-admin.mjs` (15 tests) replaces the V1 module `omega-admin.js` with recorders **before** loading V2. Every test is skipped unless the replacement is verifiably in place (function identity check), so the real V1 functions cannot be reached.
- It proves the default V2 executor calls exactly the nine V1 typed functions with zero arguments.
- It proves the real approval channel passes only the fixed argument set to the V1 prompt and fails closed on cancel, on a runner error and on a non-Windows host.
- It also covers request, approve, execute, deny, cancel, timeout, lease loss, STOP, remote STOP, revocation, expiry, execution failures and timeouts, rate limits, and the mandatory indicator with its STOP.
- `test-omega-outbound-admin-route.mjs` (12 tests) covers the full host adapter and local API matrix.

**Real LOCK/LOGOFF/RESTART/SHUTDOWN executed: 0.** Real Windows read probes are also not exercised by Phase 5 tests; they are V1-certified.

## Static security audit

Phase 5 files were scanned for `shell:true`, `exec(`, `execFile(`, `spawn(`, `eval(`, `new Function`, `cmd.exe`, `powershell`, `Invoke-Expression`, `Start-Process`, `rundll32`, `reg.exe`, `sc.exe`, `wmic`, `-Command`, clipboard, credential, password, upload, download, RunAs, UAC, `schtasks` and Run keys:

- `omega-outbound-admin.js`: `mkdtempSync`, `writeFileSync`, `readFileSync` and `rmSync` on the fixed `approval.txt` / `lease.txt` in a fresh OS temp directory. This is the V1 prompt protocol, and no path is user-controlled. The only process launch is the fixed V1 prompt through `runFixedPowerShellScript` (V1 helper: absolute `powershell.exe`, `-File`, `execFile`, `shell:false`, argument regex). It uses a constant script, enum-derived arguments and no user string.
- `omega-outbound-network.js:25-29`: `powershell.exe -Command` is **pre-existing Phase 2** code (private-network profile probe). Its only interpolation is an IPv4 re-built from numbers. Phase 5 changed only the response-size parameter of `tlsJsonRequest`.
- `omega-outbound-store.js`: `database.exec` is SQLite DDL, not a process.
- The fixture reads its harness certificate and key from paths given by the test.

The static audit found no `executeAdmin`, raw payload, generic RPC, `/execute`, `/shell`, `/command`, `/script`, `/raw` or `/rpc` route. The route test asserts 404 for 30 forbidden ADMIN/generic paths on both the host adapter and the local API.

**Autonomous ADMIN.** The only importers of the ADMIN functions are the loopback route, the Settings UI panel (explicit clicks) and tests. Voice, agent, LLM, scheduler and Device Fabric paths: 0.

## Regressions

| Check | Result |
|---|---|
| OMEGA V2 | **77/77** (baseline 39/39 re-verified before changes; +15 manager/schema, +12 route matrix, +11 harness incl. 10 subtests) |
| Phase 4 browser | **58/58** (limitation 10: 2 intermittent harness crashes in 10 runs, last 8 consecutive passes) |
| Phase 3 browser | **17/17** |
| ADMIN browser | **41/41**, three consecutive runs |
| OMEGA V1 (14 files, file by file) | **224/227**, 0 fail, 0 cancelled, 3 historical skips |
| Device Fabric V1 | **84/84**; no Fabric file changed; OMEGA routing through Fabric 0 |
| RASSILON V1 | **252/253**, 0 fail, 1 historical Ollama skip |
| `npx tsc --noEmit` | **PASS** |
| `npm run build` | **PASS** (historical chunk-size warning only) |

### Full backend

Command: `node --test --test-timeout=180000 --test-concurrency=4 --experimental-test-module-mocks test-*.mjs`.

| Run | Tests | Pass | Fail | Cancelled | Skipped |
|---|---:|---:|---:|---:|---:|
| Phase 4 baseline | 2571 | 2564 | 2 | 1 | 4 |
| **Phase 5** | **2609** | **2600** | **4** | **1** | **4** |

The +38 tests are exactly the new Phase 5 tests, and all pass. Non-passing:

| File | Classification |
|---|---|
| `test-find-eval.mjs` | HISTORICAL: needs a visible Vite app on `:5173` |
| `test-video-manual.mjs` | HISTORICAL: working-directory dependent |
| `test-regression-api.mjs` (cancelled) | HISTORICAL: 180 s test-server timeout / open handle |
| `test-port-preflight.mjs`: 2 `checkPortOwnership` subtests | ENVIRONMENTAL: contention under concurrency 4 (already listed as such in the Phase 2 report); the file is unchanged since `f0388f2`, has no OMEGA dependency, and passes **8/8 in isolation twice** |

**NEW failures: 0. OMEGA V2 failures: 0.**

### Isolated boot

Booted on `127.0.0.1:3994` with a temporary SQLite, LanceDB and log directory:
- `/api/omega/outbound/sessions`: 200 with `[]` (no auto-connect, auto-view, auto-interactive or auto-admin);
- local ADMIN read with no session: `409 SESSION_EXPIRED`; `lock/request` without confirmation: `400 CONFIRMATION_REQUIRED`;
- host `admin/request` over cleartext: `426 TLS_REQUIRED`; foreign Origin: `403`;
- `/execute`, `/shell`, `/command`, `/script`, `/raw` and `/rpc` under the local API: `404`;
- database after boot: 0 V2 sessions, identities or trust rows, and 0 ADMIN audit events;
- the process listened on `127.0.0.1:3994` only; there was no new listener and no cloud call;
- the exact PID was stopped and the port was released. The temporary directory was removed.

## Secrets and gitignore

- Tracked `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.sqlite`, `*.db`: **0**.
- Private key, token or credential patterns in Phase 5 files: **0**. The only key-shaped text is the pre-existing harness regex that extracts its ephemeral test key. Test "secrets" are sentinel strings used to prove non-projection.
- Command lines logged: **0**. ADMIN results are never audited. `request_logs` records only the route path.
- Ignored: `.tmp/` (Vite caches, including `.tmp/vite-omega-admin`), `cortex-server/data/`, `certs/`, `*.pem`, `*.sqlite-wal`, `logs/`.
- Trackable: the new source, tests, browser script and this report.
- Harness certificates, databases and approval files live in OS `mkdtemp` directories and are deleted after each run. No Phase 5 leftover was found.
- Nine `docteur-omega-v2-*` directories and one `docteur-omega-san-audit` directory from 2026-09-24/25 (earlier phases) remain in `%TEMP%`, outside the repository. They were not deleted without the user's approval.

## Limitations

1. **Real second device: NOT_RUN.** No second PC was supplied.
2. **Real high-impact execution: NOT_RUN by design.** Only recorders were used.
3. **Real Windows input smoke (Phase 4): still NOT_RUN / inconclusive.** It was not required for ADMIN validation and was not attempted.
4. **The real V1 approval prompt was not displayed during automated tests.** Its argument set and fail-closed behavior are tested with an injected runner. A supervised manual check on a real host is recommended before production use.
5. **Committed high-impact actions cannot be recalled.** STOP after approval does not undo an `ExitWindowsEx` already issued. This is the documented atomicity boundary.
6. **Execution timeout does not prove the action did not run.** A high-impact timeout reports `FAILED / EXECUTION_TIMEOUT`, but the OS call may still have been issued.
7. **Some V1 cap truncations are indistinguishable from a full list.** V1 truncates at its source (200 processes/services, 64 interfaces) before V2 sorts. The V2 `truncated` flag is therefore conservative (true whenever the cap is reached), and the "first 200 by pid" order applies within V1's returned set.
8. **The approval timeout counts from the request.** The V1 prompt names the controller device, action and a local timestamp, but not the exact expiry; this is a V1 script limitation, left frozen.
9. **ADMIN state is process-local.** Rate limits, pending approvals and duplicate-operation memory are in memory and reset on restart. Pending approvals do not survive a restart, which fails closed.
10. **Phase 4 browser flake.** The Phase 4 browser harness crashed twice in ten runs at its 3 s pointer-move wait (`inputs.at(-1)` undefined). Both crashes happened when it ran right after another Chromium harness. The last 8 consecutive runs passed 58/58. The ADMIN panel is never rendered in that harness (VIEW/INTERACTIVE sessions only; 0 ADMIN requests), so this is classified as a pre-existing timing flake, the one noted in the Phase 4 report under load.
11. **One Phase 4 test was narrowed.** `test-omega-outbound-interactive.mjs` asserted that the shared client exported no `admin|lock|…` names. It now enforces that the INTERACTIVE and input modules export none, that the client exports **exactly** the 13 closed Phase 5 ADMIN names, and that `text|command|execute|rpc|raw|clipboard|file|shell` remain forbidden everywhere.

## Files changed in Phase 5

- `cortex-server/src/lib/omega-outbound-admin.js` (new)
- `cortex-server/src/lib/omega-outbound-client.js`
- `cortex-server/src/routes/omega-outbound.js`
- `cortex-server/src/lib/omega-outbound-store.js`
- `cortex-server/src/lib/omega-outbound-protocol.js`
- `cortex-server/src/lib/omega-outbound-network.js`
- `cortex-server/fixtures/omega-outbound-server-child.mjs`
- `cortex-server/test-omega-outbound-admin.mjs` (new)
- `cortex-server/test-omega-outbound-admin-route.mjs` (new)
- `cortex-server/test-omega-outbound-admin-harness.mjs` (new)
- `cortex-server/test-omega-outbound-interactive.mjs` (static test narrowed, see limitation 11)
- `src/components/settings/OmegaOutboundAdminPanel.tsx` (new)
- `src/components/settings/OmegaOutboundViewTab.tsx`
- `scripts/test-omega-outbound-admin-browser.mjs` (new)
- `reports/OMEGA_V2_OUTBOUND_ADMIN_V1_2026-09.md` (new)

Unchanged: all OMEGA V1 files, all Device Fabric files, all RASSILON files and `server.js`.

## Final checkpoint

```text
DOCTEUR OMEGA V2 OUTBOUND PHASE 5 FINAL CHECKPOINT

OMEGA V1 preserved : PASS
Device Fabric preserved : PASS
RASSILON preserved : PASS
Phase 2 transport preserved : PASS
Phase 3 VIEW preserved : PASS
Phase 4 INTERACTIVE preserved : PASS
ADMIN implemented : PASS
ADMIN permission enforced : PASS
VIEW -> ADMIN rejection : PASS
INTERACTIVE -> ADMIN rejection : PASS
Semantic allowlist : PASS
GET_SYSTEM_INFO : PASS
PROCESS_LIST : PASS
SERVICE_STATUS : PASS
NETWORK_STATUS : PASS
DISK_STATUS : PASS
LOCK workflow : PASS
LOGOFF workflow : PASS
RESTART workflow : PASS
SHUTDOWN workflow : PASS
High-impact local approval : PASS
Remote self-approval : 0
Exact device binding : PASS
Exact operation binding : PASS
Replay protection : PASS
Session expiry : PASS
Revocation : PASS
Remote STOP : PASS
STOP SESSION : PASS
Rate limits : PASS
Response limits : PASS
Remote shell / terminal / arbitrary command / executable / code / PowerShell : 0
Generic RPC / file transfer / clipboard / credential access : 0
Registry or service arbitrary mutation / UAC bypass / persistence : 0
Autonomous / voice / agent ADMIN, Device Fabric ADMIN routing : 0
Cloud relay / Internet exposure : 0
Two-process ADMIN harness : 10/10
High-impact real execution : 0
Real second-device test : NOT_RUN
OMEGA V2 tests : 77/77
OMEGA V2 browser tests : 41/41 ADMIN; 58/58 Phase 4; 17/17 Phase 3
Full backend regression : 2609 total; 2600 pass; 4 fail (2 historical + 2 environmental port-preflight subtests); 1 historical cancelled; 4 skipped; 0 NEW
Typecheck / Build / Server boot : PASS / PASS / PASS
Secret/privacy scan : PASS
Gitignore : PASS
Final verdict : PASS
```

Phase 5 stops here. Device Fabric V2 was not started. No shell or terminal was added. No real LOGOFF, RESTART or SHUTDOWN was executed.
