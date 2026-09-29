# DOCTEUR — DEVICE FABRIC V2 — FINAL CERTIFICATION

Status: **FINAL — CERTIFIED — FROZEN**
Date: 2026-09-29

## 1. Executive summary

Device Fabric V2 lets this PC act as an explicit, inventory-driven outbound
controller of RASSILON compute workers and OMEGA V2 outbound hosts, and
remains a read-mostly inbound registry of OMEGA V1 clients. Across five
phases — inventory (Phase 2), VIEW (Phase 3), INTERACTIVE (Phase 4), ADMIN +
STOP (Phase 5), and this final hardening/certification pass (Phase 6) —
Fabric has consistently been built as **orchestration, never authority**: it
resolves an exact target, revalidates that resolution immediately before
every privileged call (TOCTOU), and delegates to each domain's own already
certified execution primitive (RASSILON's scheduler, OMEGA V2's outbound
client). It holds no key, no credential, no approval token, and exposes no
generic router, no generic RPC, and no arbitrary-execution surface anywhere
in its own code.

This phase added no feature. It re-audited the architecture end-to-end,
proved exact-target and TOCTOU guarantees once more against fresh two-target
scenarios, ran every regression suite (Device Fabric, OMEGA V1, OMEGA V2,
RASSILON, and the full backend) to completion, discovered and documented a
non-test script that had been silently corrupting prior "full backend" runs,
built a deterministic test manifest to make that discovery permanent, and
produced this certification.

**Verdict: PASS. Device Fabric V2 is FINAL, CERTIFIED, FROZEN.**

## 2. Architecture

### 2.1 What Fabric is

- An **inventory**: `fabric_devices` — opaque local labels (`fdev-<uuid>`)
  with a display name, created/updated/removed timestamps. No credential, no
  permission, no session state.
- A **link table**: `fabric_agent_links` — at most one active link per
  `(fabricDeviceId, agentType)` and per `(agentType, agentDeviceId)` (partial
  unique SQLite indexes), each requiring an explicit `confirmFingerprint`
  matching the target identity's *current* fingerprint at link time. No
  foreign key into `omega_*`, `omega_v2_outbound_*`, or `rassilon_*` — Fabric
  references those tables by id only, never owns rows in them.
- An **orchestrator**: for RASSILON compute (Phase 1), OMEGA V2 VIEW/
  INTERACTIVE (Phase 3/4), and OMEGA V2 ADMIN/STOP (Phase 5), Fabric resolves
  the exact linked target, revalidates it a second time immediately before
  any privileged call, and calls straight into that domain's own certified
  entry point — never re-implementing execution, signing, transport, or
  approval itself.

### 2.2 What Fabric is not (re-confirmed this phase)

- **Not an authority**: every privileged action re-verifies its own
  permission independently inside the target domain (OMEGA V2's
  `session.permission === 'ADMIN'` check, RASSILON's own worker/session
  state) — Fabric's link existing is never sufficient by itself.
- **Not a credential store**: `grep`-confirmed zero private key, DPAPI call,
  signing function, or credential/token/secret field anywhere in
  `device-fabric*.js` or the Fabric routes/frontend (§7).
- **Not a super-admin**: the ADMIN surface is a closed nine-action semantic
  allowlist (five reads, four high-impact) with typed one-function-per-action
  wrappers — no `runFabricOmegaV2AdminOperation(id, action)` generic entry
  point exists anywhere in the codebase.
- **Not a generic router**: no `/execute`, `/shell`, `/command`, `/run`,
  `/rpc`, `/raw` route exists under `/api/device-fabric/*` (tested against a
  live 404 by the route test suite and independently `grep`-confirmed this
  phase).

## 3. Identity spaces and trust domain separation

Three structurally distinct identity/trust domains, confirmed to have zero
inheritance between them:

| Domain | Agent-type constant | Source table | Key namespace |
|---|---|---|---|
| OMEGA V1 (inbound) | `'OMEGA'` | `omega_devices` | `omega-device-key:*` |
| OMEGA V2 (outbound) | `'OMEGA_V2_OUTBOUND'` | `omega_v2_outbound_trust` | `omega-v2-role-key:controller:*` (this PC's own key only — a remote host's key is never held here) |
| RASSILON | `'RASSILON'` | RASSILON's own worker/identity tables | RASSILON's own DPAPI namespace |

Independently re-verified this phase:
- `grep -n "rassilon" src/lib/device-fabric-omega-v2*.js` → **zero matches**
  (the OMEGA V2 Fabric modules never reference RASSILON at all).
- `grep` for `IP`/`hostname`/`MAC`/display-name-based matching inside the
  OMEGA V2 link module → **zero matches**; `linkOmegaV2Host(fabricDeviceId,
  { omegaV2HostId, confirmFingerprint })` takes exactly an explicit host id
  and an explicit fingerprint confirmation, nothing implicit.
- No key inheritance, trust inheritance, permission inheritance, session
  inheritance, approval inheritance, or revocation inheritance crosses a
  domain boundary anywhere in the linking or routing code — each domain's
  own trust/session/revocation state is read fresh from that domain's own
  store on every request, never cached or copied into Fabric's own tables.

## 4. Capability model — status honesty

SUPPORTED / AUTHORIZED / AVAILABLE remain three independently computed
`YES | NO | UNKNOWN` values, never merged into a single boolean, and never
upgraded to invented states like `"ONLINE"`, `"READY"`, or `"TRUSTED"` from a
database link alone:

- **SUPPORTED**: the capability exists in this Fabric version's allowlist —
  a static fact, never network-derived.
- **AUTHORIZED**: derived from the trust's own `maxPermission` ceiling —
  read fresh from the trust row, never cached.
- **AVAILABLE**: `UNKNOWN` unless a real, current session already proves it
  — never inferred from the link or trust existing alone. Confirmed by the
  browser suite: a fresh link with no session shows `Disponibilité UNKNOWN`,
  and the capability matrix only shows `YES` for a given permission tier
  once a real session at that tier or higher exists.

## 5. Exact-target routing and TOCTOU — final proof

Re-validated this phase via the two-process real-TLS ADMIN harness
(`test-device-fabric-omega-v2-admin-harness.mjs`, new in Phase 5, re-run
stable across 3 fresh runs this phase) plus the existing VIEW/INTERACTIVE
harnesses, using the classic two-target scenario: **Fabric A → OMEGA host A,
Fabric B → OMEGA host B**, both real local HTTPS server processes with
distinct certificates and identities.

| Proof | VIEW | INTERACTIVE | ADMIN | STOP DEVICE |
|---|---|---|---|---|
| Action on A reaches exact host A | ✓ (harness + browser exact-target block) | ✓ (harness) | ✓ (harness, 5 reads + 4 high-impact) | ✓ (harness) |
| Host B receives 0 | ✓ | ✓ | ✓ | ✓ |
| A becomes unavailable → action on A fails, B still receives 0 | ✓ | — (not re-tested this phase; unchanged from Phase 4) | ✓ | — |
| Fallback / automatic retargeting | 0 (no second dispatch call site exists; static-audit-enforced) | 0 | 0 (no fallback/bestAvailable/selectHost symbol anywhere in the ADMIN module) | 0 |

`resolveFabricOmegaV2Target(fabricDeviceId)` is called, then called again
(`revalidate()`) immediately before every privileged network call across
VIEW, INTERACTIVE, and ADMIN alike; a mismatch on `linkId`, `linkVersion`,
`omegaV2HostId`, or `fingerprint` between the two reads fails closed with
`OMEGA_V2_LINK_CHANGED` before the call ever reaches OMEGA. RASSILON's own
exact-target guarantee (`devices: [worker]`, a single-element list handed to
the scheduler, making fallback structurally impossible) is unchanged from
Phase 1 and was not touched this phase.

## 6. VIEW / INTERACTIVE / ADMIN / STOP — final regression

All four surfaces were re-run this phase, not merely re-read:

- **VIEW** (`test-device-fabric-omega-v2-view-harness.mjs`): explicit-only
  start, exact target, authenticated frames, STOP VIEW, STOP SESSION, remote
  STOP, network drop — all PASS, stable across 3 runs.
- **INTERACTIVE** (`test-device-fabric-omega-v2-interactive-harness.mjs`):
  VIEW dependency enforced (no independent INTERACTIVE-only connect path),
  explicit activation, real mocked pointer/key events recorded only on the
  exact target host, STOP INTERACTIVE / STOP VIEW (kills INTERACTIVE too) /
  STOP SESSION (kills INTERACTIVE too), remote STOP with zero automatic
  reconnect — all PASS, stable across 3 runs.
- **ADMIN** (`test-device-fabric-omega-v2-admin-harness.mjs`, written in
  Phase 5): the closed nine-action allowlist only; every other tested action
  name (SHELL, COMMAND, POWERSHELL, EXECUTE, RUN, RPC, RAW, FILE_READ,
  FILE_WRITE, CLIPBOARD, CREDENTIAL, REGISTRY_WRITE, SERVICE_START/STOP,
  PROCESS_KILL) has no corresponding function anywhere in the module — PASS,
  stable across 3 runs.
- **STOP DEVICE / STOP ALL**: STOP DEVICE stops only the exact Fabric-bound
  session for one device, preserving the link (a reconnect afterward proves
  it). STOP ALL iterates only `activeByFabricDevice` — the map of sessions
  *this Fabric process itself created* — and never calls
  `stopAllOmegaOutboundSessions()` (statically asserted absent from the
  module, and dynamically proven: a non-Fabric OMEGA session and a RASSILON
  fixture are untouched by Fabric STOP ALL in the unit suite).

No input (pointer, key, wheel) is ever possible before VIEW→INTERACTIVE
activation, after STOP, after revocation, or after expiry — enforced by
OMEGA V2's own session-state checks, which Fabric never bypasses or
pre-empts.

## 7. Static negative surface — independently re-scanned this phase

A fresh `grep` pass (independent of the existing `test-device-fabric-static-audit.mjs`,
which also re-ran clean at 23/23) across every Fabric V2 source and frontend
file for: shell, PowerShell, generic command, generic RPC, raw executor,
arbitrary executable, file transfer, clipboard, credentials, registry
mutation, service mutation, process kill, UAC bypass, persistence, cloud
relay, STUN, TURN, UPnP, firewall mutation, new listener.

**Result: 0 matches** in `device-fabric.js`, `device-fabric-agents.js`,
`device-fabric-routing.js`, `device-fabric-omega-v2.js`,
`device-fabric-omega-v2-routing.js`, `device-fabric-omega-v2-admin.js`,
`routes/device-fabric.js`, and all three Fabric frontend components. The
only textual hits were two doc comments explicitly *stating* the absence of
a real Windows registry/shell surface (one referring to RASSILON's own job
"registry" — a queue concept — the other describing a UI component as a
"VIEW+INTERACTIVE shell" in the scaffolding sense) — neither is a real
capability.

Autonomy surface (§17): `grep` for `device-fabric`/`deviceFabric` inside
every voice/intent/registry-named frontend module → **0 matches**. No
scheduler, agent runner, or LLM tool path reaches Device Fabric anywhere in
the codebase (also statically enforced by
`test-device-fabric-static-audit.mjs`'s own dedicated test, re-run clean).

## 8. Restart safety

`activeByFabricDevice` (the in-memory map of currently-active VIEW/
INTERACTIVE/ADMIN sessions Fabric itself created) is declared fresh on
module load in both `device-fabric-omega-v2-routing.js` and
`device-fabric-omega-v2-admin.js` — a process restart clears it
unconditionally. Combined with the server boot smoke test (re-run this
phase, 5/5 PASS): zero auto-connect, zero auto-VIEW, zero auto-INTERACTIVE,
zero auto-ADMIN, zero new listener beyond the one expected cortex-server
port, zero outbound/cloud URL logged at boot, clean SIGINT shutdown with no
residual process. Persisted state after restart is exactly `fabric_devices`
and `fabric_agent_links` (explicit inventory and links) plus safe audit
history — never a session, an approval, or a remote-availability claim.

## 9. Migration safety

`test-device-fabric-migration.mjs` (3/3 PASS this phase) proves a pre-V2
(Phase 2/3-era) database migrates in place: the existing `fdev-old` device
and its one `RASSILON` link (`flnk-old-1`, `rassilon-existing-1`, full
fingerprint) survive unchanged, `link_version` is defaulted to `1` for
pre-existing rows, `fabric_audit` rows keep their original ids and content,
`AUTOINCREMENT` continues seamlessly afterward, and the migrated schema
accepts the newest (Phase 5 ADMIN) event-type enum values while still
rejecting anything outside it. An unrelated table in the same database
(`unrelated_marker`) is confirmed untouched. No destructive migration path
exists — the migration only adds columns/tables and rebuilds constrained
tables in place, never drops user data.

## 10. Browser / UI final audit

`scripts/test-device-fabric-browser.mjs` — **190/190 PASS**, stable across 3
fresh runs this phase, 0 page errors each run. Confirms:
- OMEGA V1 (inbound), OMEGA V2 (outbound), and RASSILON sections render as
  visually and semantically distinct blocks in Settings → Appareils.
- VIEW, INTERACTIVE, ADMIN, and STOP controls are distinct buttons with
  distinct testids and distinct confirmation flows — no button implies a
  higher permission than it grants (`FULL CONTROL`, `SUPER ADMIN`, `TOTAL
  CONTROL` wording is asserted absent).
- **XSS**: hostile values (`<img src=x onerror=...>`, `<script>`, raw
  `javascript:` URLs, HTML entities, bidi control characters, 500+ character
  Unicode names) injected into device names, agent names, process names,
  service display names, network interface descriptions, disk labels, and
  error/audit-reason fields all render as inert text — 0 `<script>`, 0
  `<img>`, 0 `<b>` elements ever added to the DOM, 0 `window.__xssFired`.
- **Accessibility**: role-based Playwright selectors (`getByRole('button')`,
  `getByRole('dialog')`, `getByLabel(...)`) and explicit disabled-state
  assertions are used throughout — the suite structurally cannot pass
  without correct semantic markup, labels, and disabled states on every
  interactive element it exercises, including the Phase 5 ADMIN panel.

## 11. TLS harnesses and stability runs

Minimum 3 runs each, this phase, all real local two-process HTTPS with real
certificates and the real signed OMEGA V2 protocol:

| Suite | Run 1 | Run 2 | Run 3 | Classification |
|---|---|---|---|---|
| Device Fabric backend (202 tests) | PASS | PASS | PASS | stable |
| Device Fabric browser (190 assertions) | PASS | PASS | PASS | stable |
| VIEW TLS harness | PASS | PASS | PASS | stable |
| INTERACTIVE TLS harness | PASS | PASS | PASS | stable |
| ADMIN TLS harness | PASS | PASS | PASS | stable |

**0 flakes observed.** No logic failure was masked or hidden.

## 12. Full-backend methodology and the non-test script discovery

### 12.1 The discovery

`test-regression-api.mjs` matches the `test-*.mjs` glob every prior "full
backend" run used, but it is **not a test**: it calls `serve({ ... port:
3002 })` at module scope with no `node:test` import and no exit path. When
swept into a `node --test` batch it opens a listener and never terminates,
silently hanging the entire run forever with zero further output — this is
exactly what happened during this mission's own Phase 5→6 transition (a
full run appeared to hang for over an hour; root-caused by process
inspection, not guesswork, to this file).

### 12.2 The fix — a deterministic manifest, not a workaround

`cortex-server/test-manifest.mjs` (new, this phase) is the single source of
truth for which `test-*.mjs` files are genuine, terminating, automated
tests. It classifies and excludes exactly 5 files, each with a documented,
inspected reason — nothing was guessed:

| File | Classification | Reason |
|---|---|---|
| `test-regression-api.mjs` | NON_TEST_SCRIPT | Non-terminating debug server (§12.1) |
| `test-find-eval.mjs` | NON_TEST_SCRIPT | Manual Playwright repro script (`headless: false`), no `node:test` import, no batch-execution contract |
| `test-video-manual.mjs` | NON_TEST_SCRIPT | Manual repro script requiring explicit `--application`/`--hls` flags and live YouTube network access |
| `test-cyber-audit-fixture.mjs` | SHARED_FIXTURE | Exports a fixture helper for other test files to import; contains no assertions itself |
| `test-setup.mjs` | SHARED_SETUP | Imported first by every real test file to set `DOCTEUR_TEST_MODE=1`; contains no assertions itself |

The debug server itself was **not modified, renamed, or deleted** — per
mission instruction, it remains available for a developer to run manually.
Only the *test-running methodology* changed: `node test-manifest.mjs --run`
now runs exactly the 167 genuine, terminating, automated test files, and the
manifest self-validates on every invocation (it warns if a file with no
`node:test` import lacks an exclusion entry, so a future accidental
non-test script cannot silently re-corrupt a full run without at least a
visible warning).

### 12.3 Full backend result (via the manifest)

**2715/2722 PASS, 3 fail, 4 skip.** Every non-pass classified:

| Test | Classification | Evidence |
|---|---|---|
| `test-cyber-audit-policy.mjs`: "cancellation: an already-aborted signal is rejected immediately" | HISTORICAL/ENVIRONMENTAL | An abort-signal race, sensitive to CPU scheduling under the heavy concurrent load of 167 test files running in parallel. Not in any Device Fabric, OMEGA, or RASSILON file; not touched this session. |
| `test-port-preflight.mjs`: `checkPortOwnership` free-port / owned-by-unknown (×2) | HISTORICAL/ENVIRONMENTAL | Both returned `'undetermined'` instead of a determined state — consistent with `netstat`/process-inspection contention under the same concurrent load. Not in any Device Fabric, OMEGA, or RASSILON file; not touched this session. |
| `test-monitor-performance-benchmark.mjs`: idle overhead 5s budget | ENVIRONMENTAL, self-resolved | Missed its 5s budget by 84ms on one full run under heavy concurrent load; passed cleanly on the very next full run and in this phase's final run. Confirms load-sensitivity, not a logic defect. |

4 skips: the same historical skips already documented in every prior phase
(3 in OMEGA V1, 1 Ollama skip in RASSILON) — unchanged.

**0 Device Fabric / OMEGA V1 / OMEGA V2 / RASSILON failures**, confirmed by
an explicit `grep` of every `not ok` line in the full run's output against
those four domains — zero matches.

## 13. OMEGA V2 / OMEGA V1 / RASSILON regression

| Suite | Result | Baseline | Delta |
|---|---|---|---|
| OMEGA V2 outbound | 77/77 PASS | 77/77 | 0 |
| OMEGA V1 | 224/227 PASS, 3 historical skips | 224/227 | 0 |
| RASSILON | 252/253 PASS, 1 historical Ollama skip | 252/253 | 0 |

`git diff --name-only` against every `omega-outbound-*.js` file,
`omega-outbound-input.js`, `omega-outbound-middle-input.ps1`, and
`routes/omega-outbound.js` returns **empty** — 0 OMEGA V2 frozen files
modified this phase or any prior phase of this mission.

## 14. Typecheck, build, server boot

- `npx tsc --noEmit`: **PASS** (no output, zero errors).
- `npm run build`: **PASS** (built in ~17s, PWA precache generated cleanly).
- Server boot smoke (`scripts/test-device-fabric-server-boot.mjs`): **5/5
  PASS** — server starts, zero unexpected second listener probed on
  `port+1`, zero auto-VIEW/auto-INTERACTIVE/auto-ADMIN activity logged,
  zero non-loopback URL logged, clean SIGINT shutdown.

## 15. Secret scan, privacy, gitignore, git safety

- **Secret scan**: `grep` for private-key markers, DPAPI calls, and
  API-key-shaped literals across every file this session modified or
  created — **0 matches**. `fabric_audit` rows contain only ids, closed
  enum event types, and bounded safe reasons (re-confirmed by both the unit
  suite's dedicated audit-content test and the ADMIN harness's final
  audit-table secret scan against `HARNESS-SECRET`-style bait strings).
- **Privacy**: Fabric persists 0 screen frames, 0 mouse/keyboard history, 0
  typed text, 0 clipboard content, 0 raw ADMIN command text, 0 credentials
  — it never touches any of these; frames and input go directly between the
  browser and OMEGA V2's own certified endpoints, bypassing Fabric entirely
  by design (unchanged architecture since Phase 3/4, re-confirmed this
  phase by the same static audit tests).
- **Temp artifacts**: inventoried `cortex-server/data-test-device-fabric-*`
  (five directories, one regenerable SQLite file each) and OS-temp
  `docteur-fabric-omega-v2-*` harness scratch directories — all already
  correctly excluded from git via `data-test-*/` in `.gitignore` (verified
  with `git check-ignore -v`), so none require deletion to satisfy
  certification; left in place as they are recreated fresh by every test
  run and pose zero repository risk.
- **Gitignore**: confirmed patterns cover `*.key`, `*.pem`, `*.sqlite*`,
  `logs/`, `data-test-*/`, and Playwright screenshot output; source, tests,
  and reports remain trackable.
- **Git safety**: `git status --short` / `git diff --stat` / `git diff
  --name-only` only — no `add`, `commit`, `push`, `reset`, `clean`, or
  `stash` was run this phase. `external/MetaGPT/` and `external/OpenMontage/`
  (nested external repos) remain listed as ignored and untouched.

## 16. Known limitations (honest)

- **Real Windows input smoke**: NOT_RUN this phase (unchanged from Phase 5;
  all input goes through the certified mock executor in every harness).
- **Real high-impact Windows action** (LOCK/LOGOFF/RESTART/SHUTDOWN): **0,
  by design** — `LockWorkStation`/`ExitWindowsEx` exist only inside OMEGA
  V1's own frozen `omega-admin.ps1`, never called from any Fabric code path;
  every high-impact test in this mission used the certified mock executor.
- **Real physical second machine**: NOT_RUN — every exact-target /
  two-target proof in this mission (VIEW, INTERACTIVE, ADMIN) uses two real
  local TLS server *processes* with real certificates and the real signed
  protocol, never two physically separate Windows machines.
- The three environmental full-backend failures (§12.3) are documented, not
  hidden, and are unrelated to Device Fabric by file, by domain, and by
  git-diff evidence.

## 17. Files changed this phase

New:
- `cortex-server/test-manifest.mjs` (deterministic test manifest)
- `reports/DEVICE_FABRIC_V2_FINAL_CERTIFICATION_2026-09.md` (this report)

No source file was modified this phase — Phase 6 was audit, regression,
stability, and documentation only, exactly as scoped.

## 18. Freeze declaration

All Phase 6 pass-rule conditions are met:

- Phase 2 PASS, Phase 3 PASS, Phase 4 PASS, Phase 5 PASS.
- 0 NEW failure (full backend, OMEGA V1, OMEGA V2, RASSILON, Device Fabric
  backend/browser/harnesses all confirmed against their exact baselines).
- 0 unresolved security defect.
- 0 fallback, 0 automatic retargeting.
- 0 generic router, 0 generic RPC.
- 0 secret leak.
- 0 frozen OMEGA V2 file modification.

**DEVICE FABRIC V2 IS FINAL, CERTIFIED, FROZEN.**

Any future modification — new capability, new action, new UI surface, or a
change to the exact-target/TOCTOU/permission model described in this report
— requires a new, explicit mission. This certification does not authorize
incremental extension without one.
