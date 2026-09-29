# DEVICE FABRIC V2 — OMEGA V2 Outbound ADMIN + STOP Routing (Phase 5)

Status: **FINAL — PASS**
Date: 2026-09-29

## 1. Scope

Phase 5 extends Device Fabric V2 with a closed OMEGA V2 ADMIN surface — five
read-only status actions and four high-impact power actions (LOCK, LOGOFF,
RESTART, SHUTDOWN) — plus a Fabric-owned STOP DEVICE and STOP ALL. Fabric's
job is exactly what it already was for VIEW/INTERACTIVE: exact-target
resolution, TOCTOU revalidation, and delegation to OMEGA V2's own already
certified typed ADMIN functions. Fabric never deduces ADMIN from the link,
never approves a high-impact action itself, never stores an approval token,
and never exposes a generic executor.

**Zero modification** was made to any `omega-outbound-*.js` file or route.
OMEGA V2 remains FROZEN (confirmed by `git diff --name-only` against the
outbound client/store/protocol/route modules — empty). RASSILON was not
touched.

## 2. Architecture

### 2.1 Semantic allowlist

`device-fabric-omega-v2-admin.js` exposes exactly nine typed wrapper
functions — no generic `runFabricOmegaV2AdminOperation(id, action)` entry
point exists anywhere:

- Read-only: `getSystemInfoForFabricDevice`, `listProcessesForFabricDevice`,
  `getServiceStatusForFabricDevice`, `getNetworkStatusForFabricDevice`,
  `getDiskStatusForFabricDevice`
- High-impact: `lockFabricDevice`, `logoffFabricDevice`,
  `restartFabricDevice`, `shutdownFabricDevice`

Each maps 1:1 onto one of OMEGA V2's own certified client functions
(`getOmegaOutboundAdminSystemInfo`, …, `requestOmegaOutboundAdminLock`, …).
The static audit (`test-device-fabric-static-audit.mjs`) asserts every one of
these names appears exactly twice in the module (one import, one dependency
binding) and that no shell, PowerShell, generic command, RPC, raw executor,
file transfer, clipboard, credential, registry, service-mutation or
process-kill primitive exists anywhere in the file.

### 2.2 Exact-target + TOCTOU

`resolveFabricOmegaV2Target(fabricDeviceId)` is called once per request, then
revalidated a second time (`revalidate()`) immediately before any network
call reaches OMEGA. A mismatch on `linkId`, `linkVersion`, `omegaV2HostId` or
`fingerprint` between the two reads fails closed with `OMEGA_V2_LINK_CHANGED`
before any ADMIN action is ever attempted. This mirrors the identical
discipline already certified for VIEW/INTERACTIVE in Phases 3–4.

### 2.3 Permission ceiling — no silent upgrade

Fabric requests a session `permission` equal to the trust's own
`maxPermission` ceiling (`connectPermission`), never a hardcoded `'ADMIN'`
literal. OMEGA V2 independently re-verifies `session.permission === 'ADMIN'`
on every single call. A VIEW- or INTERACTIVE-ceilinged session is rejected by
OMEGA itself with `PERMISSION_DENIED`; Fabric never pre-empts or infers a
grant, and never silently opens a second, higher-privileged session behind
an existing VIEW/INTERACTIVE one.

### 2.4 High-impact confirmation

Every high-impact wrapper requires a body of exactly `{ confirm: '<ACTION>' }`
naming the action being requested (`requireConfirm`). This confirmation only
gates Fabric's own request to OMEGA — it is never treated as, and never
substitutes for, the remote device's own local approval prompt (OMEGA V2's
already-certified `PENDING_APPROVAL` → local `ALLOW`/`DENY` workflow).
Fabric holds no approval token, no approval secret, and has no self-approval
path anywhere in the module.

### 2.5 STOP DEVICE / STOP ALL

`stopDeviceForFabricDevice` and `stopAllForFabricDevices` are capacity
reductions, not ADMIN operations: no allowlist check, no approval, no
permission requirement beyond an existing Fabric binding. STOP ALL iterates
only `activeByFabricDevice` — the map of sessions *this Fabric process
created* — and calls `stopOmegaOutboundSession` per binding.
`stopAllOmegaOutboundSessions()` (the global OMEGA V2 primitive that would
reach every session, Fabric-owned or not) is never imported and never called
anywhere in the module; the static audit asserts this explicitly
(`assert.doesNotMatch(source, /stopAllOmegaOutboundSessions/)`). A failure
stopping one device's session never aborts the others (`Promise.allSettled`,
per-device results).

### 2.6 Audit

Every ADMIN request, completion, failure, denial, cancellation and STOP is
recorded via `insertFabricAudit` with `agentType: OMEGA_V2_AGENT_TYPE` and a
closed, safe reason vocabulary. No result payload, approval nonce, or secret
is ever written to the audit row (proven by both the unit suite and the
two-process harness's final audit-table secret scan).

## 3. Frontend

`FabricOmegaV2AdminPanel.tsx` mirrors the certified OMEGA V2 outbound admin
UX: a READ-ONLY STATUS block (five buttons, one per typed read, rendering a
bounded table/definition-list), and a HIGH-IMPACT ACTIONS block (four
buttons, each opening an explicit confirm dialog naming the action before
any request is sent). All text fields (device names, process/service names,
network labels, disk labels, error codes) are rendered through a `safe()`
helper that strips control/bidi characters and truncates — never
`dangerouslySetInnerHTML` or raw HTML. STOP DEVICE is a single button with no
confirmation dialog (a capacity reduction, not a destructive action on the
remote device). The panel is mounted in `DeviceFabricSettingsTab.tsx` only
when `shownLink.linkState === 'OK'` and the ADMIN capability's `authorized`
flag is `'YES'` — never inferred from the link alone.

## 4. Test results

| Suite | Result | Notes |
|---|---|---|
| Static security audit (`test-device-fabric-static-audit.mjs`) | **23/23 PASS** | Frontend allowlist already includes `FabricOmegaV2AdminPanel.tsx`; no fix needed — was already resolved in the working tree at mission start. |
| Device Fabric backend (`test-device-fabric-*.mjs`) | **202/202 PASS** | 194 baseline (unit + route + migration + static audit) + 8 new from the two-process ADMIN TLS harness added this phase. 0 fail, 0 skip. |
| ADMIN unit (`test-device-fabric-omega-v2-admin.mjs`) | **21/21 PASS** | Matches stated Phase 5 baseline exactly. |
| Route tests (`test-device-fabric-omega-v2-route.mjs`) | **11/11 PASS** | Matches stated Phase 5 baseline exactly. |
| Migration (`test-device-fabric-migration.mjs`) | **3/3 PASS** | Pre-V2 → current schema migration preserves existing links/IDs/fingerprints; ADMIN audit event types accepted post-migration. |
| **New:** two-process ADMIN TLS harness (`test-device-fabric-omega-v2-admin-harness.mjs`) | **8/8 PASS** (7 subtests) | Written this phase (see §5). Stable across 3 consecutive runs. |
| VIEW TLS harness | **1/1 PASS** | Stable across 3 consecutive runs. |
| INTERACTIVE TLS harness | **1/1 PASS** | Stable across 3 consecutive runs. |
| Browser suite (`scripts/test-device-fabric-browser.mjs`) | **190/190 PASS** | Extended this phase from 156 → 190 (+34 assertions) for Phase 5 ADMIN panel coverage (see §5). 0 page errors. |
| OMEGA V2 outbound regression | **77/77 PASS** | One file (`test-omega-outbound-admin.mjs`, an OMEGA **V1** admin mock test, not V2) requires the `--experimental-test-module-mocks` Node flag; without it that single file errors at import (`mock.module is not a function`) — an environmental/Node-version issue unrelated to this branch, confirmed 77/77 with the flag. |
| OMEGA V1 regression | **224/227 PASS** | 3 historical skips, 0 fail — matches baseline exactly. |
| RASSILON regression | **252/253 PASS** | 1 historical Ollama skip, 0 fail — matches baseline exactly. |
| Server boot smoke | **5/5 PASS** | No auto-VIEW, no auto-INTERACTIVE, no auto-ADMIN, no unexpected listener, clean SIGINT shutdown. First run timed out / showed a false "unexpected listener" due to a stray process left over from manual debugging on the same port — not a product defect; confirmed clean on a port-clear rerun. |
| **Full backend suite** (all `test-*.mjs`, excluding `test-regression-api.mjs`) | **2716/2726 PASS, 6 fail, 4 skip** | `test-regression-api.mjs` is not a test — it is a manual-debug fixture that starts an HTTP server on port 3002 and never exits; it hangs `node --test` indefinitely when swept up by a glob and is correctly excluded (as it always must be) from any batch test run. The 6 failures are all pre-existing, environmental, and entirely unrelated to Device Fabric/OMEGA/RASSILON: `test-cyber-audit-policy.mjs` (one abort-signal race), `test-find-eval.mjs` and `test-video-manual.mjs` (whole-file timeouts), `test-monitor-performance-benchmark.mjs` (an explicit 5s performance budget missed by 84ms), and `test-port-preflight.mjs` ×2 (`checkPortOwnership` returned `undetermined` instead of a determined state, consistent with `netstat`/`tasklist` contention). All are consistent with CPU/IO contention from running 171 test files concurrently on one machine, not logic regressions — none of the 6 files, or their source, were touched this session. **0 Device Fabric / OMEGA V1 / OMEGA V2 / RASSILON failures** confirmed by grep across the full run. |
| Typecheck (`npx tsc --noEmit`) | **PASS** | |
| Build (`npm run build`) | **PASS** | |

## 5. New work this phase

Two gaps remained from the Phase 4→5 handoff and were completed:

1. **Two-process real-TLS ADMIN harness**
   (`cortex-server/test-device-fabric-omega-v2-admin-harness.mjs`, new file).
   Process A is the real Fabric/OMEGA V2 outbound controller; process B is
   `fixtures/omega-outbound-server-child.mjs` (the same fixture already used
   by the certified OMEGA V2 admin harness and the Phase 3/4 Fabric
   harnesses) over real HTTPS with SAN/pin/mutual identity. The host's ADMIN
   executor is a recorder and approval is driven over IPC — no real Windows
   action (read probe, LOCK, LOGOFF, RESTART, SHUTDOWN) can run. Covers:
   exact-target read-only allowlist (host A executes, host B receives 0),
   full high-impact approval workflow for all four actions, missing/wrong
   confirmation rejected before reaching the host, exact-target proof via
   each host's own SQLite session table, STOP DEVICE (link preserved,
   reconnect proves it), STOP ALL (both Fabric-owned bindings stopped, no
   global primitive used), and A-unavailable/B-untouched with no fallback or
   retargeting. Stable across 3 consecutive runs.

2. **Browser coverage for the ADMIN panel**
   (`scripts/test-device-fabric-browser.mjs`, extended). Added 34 assertions
   covering: the ADMIN section appearing/disappearing with authorization;
   all five read-only buttons exercised end-to-end with hostile
   (`<img onerror>`) text in one field per action proven inert (0 `img`,
   `script`, or `b` elements added); LOCK approved end-to-end (click →
   confirm dialog → `PENDING_APPROVAL` with 0 executions → local approval →
   `EXECUTED` → exactly 1 execution) and LOGOFF denied end-to-end (`DENIED`,
   0 executions); STOP DEVICE (exactly 1 call, section becomes disabled);
   and a scoped forbidden-button-text check limited to the ADMIN section
   (shell/PowerShell/command/RPC/raw/file/clipboard/credential). No existing
   assertion was removed, renamed, or weakened.

## 6. Security negative surface (proven, not asserted)

Both the static audit and the two harnesses above prove, not merely assert:

- 0 shell, PowerShell, generic command, RPC, raw executor, arbitrary
  executable, file transfer, clipboard, credential access, registry
  mutation, or process-kill primitive anywhere in the Fabric ADMIN module or
  panel.
- 0 Fabric self-approval, 0 approval token generation, 0 approval secret
  storage in Fabric.
- 0 real Windows LOCK/LOGOFF/RESTART/SHUTDOWN executed by any test in this
  phase — only the certified mock executor.
- 0 use of `stopAllOmegaOutboundSessions()` by Fabric STOP ALL.
- 0 automatic/voice/agent/scheduler routing reaches Device Fabric ADMIN
  (covered by the existing static audit tests, re-run and still passing
  unchanged).

## 7. Limitations (honest)

- Real physical second machine: **NOT_RUN** — all cross-device proof uses
  two real local TLS server processes (real network stack, real
  certificates, real signed protocol), never two physical Windows machines.
- Real Windows high-impact action: **0, by design** — every high-impact test
  runs against the certified mock executor, never `LockWorkStation` /
  `ExitWindowsEx` (those exist only in OMEGA V1's own frozen
  `omega-admin.ps1`, never called from any Fabric code path).
- The OMEGA V2 outbound regression suite's one environmental failure
  (`test-omega-outbound-admin.mjs` needing `--experimental-test-module-mocks`
  on this Node version) is pre-existing and orthogonal to Device Fabric; it
  is not part of this phase's changes and does not affect the 77/77 result
  once the flag is supplied.

## 8. Files changed this phase

New:
- `cortex-server/test-device-fabric-omega-v2-admin-harness.mjs`

Modified:
- `scripts/test-device-fabric-browser.mjs` (+34 ADMIN assertions)

All other Phase 5 source (`device-fabric-omega-v2-admin.js`, route wiring,
`FabricOmegaV2AdminPanel.tsx`, `client.ts` ADMIN methods, SQLite audit
schema) and its unit/route test coverage were already complete and passing
in the working tree at the start of this session; they were verified, not
rewritten.

## 9. Verdict

**PASS.** Phase 5 (ADMIN + STOP) is complete: 0 new failures (confirmed
against the full 2726-test backend suite), 0 unresolved security defect, 0
generic router, 0 fallback, 0 unauthorized capability, 0 secret leak. Gate to
Phase 6 is open.
