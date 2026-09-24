# DOCTEUR RASSILON V1 — ARCHITECTURE (PHASE 1: AUDIT + ARCHITECTURE)

Date: 2026-09-23
Scope: Phase 1 only — repo audit + architecture design + threat model. **No RASSILON code, no routes, no tables, no dependencies were added. No daemon, no worker, no persistence, no job execution.** Per mission instructions, this phase stops at the checkpoint and awaits explicit user validation before Phase 2 (local single-machine safe worker) begins.

OMEGA V1 is frozen and certified (`reports/OMEGA_V1_FINAL_CERTIFICATION_2026-09.md`). This document does not modify OMEGA, does not import OMEGA code, and does not touch any `omega_*` table.

---

## 1. What RASSILON is and is not

RASSILON is a local, opt-in, resource-bounded compute-sharing agent: it lets the user offer a strictly limited slice of their own machine's CPU/GPU/RAM to Docteur for pre-defined, signed, semantic compute jobs (e.g. running a local LLM inference). It is not a generic remote-execution agent, not a botnet client, not a crypto miner, not a way to run arbitrary code or shell commands, and not a background service that starts itself or hides its activity.

Every constraint below exists to keep that distinction structural — enforced by code, not by policy prose alone. This mirrors the discipline already proven in this codebase by OMEGA (visible/consented/revocable admin) and MAÎTRE (closed action enum, no generic executor).

RASSILON V1 is single-machine, Strict-Local-compatible, and Windows-first. Multi-machine and any Internet-facing transport are explicitly out of scope for V1 (§30, §12).

---

## 2. Repo audit findings

Commands run: `git status --short`, `git diff --stat`, plus targeted `grep -ri rassilon` across the repo root, `cortex-server/`, and `src/`.

- `git status --short`: only `external/MetaGPT/` and `external/OpenMontage/` are untracked (unrelated vendor trees, pre-existing). No RASSILON-related working-tree changes.
- `git diff --stat`: empty — no staged or unstaged diff.
- `grep -ri rassilon` across `cortex-server/src`, `src/`, and the repo root: **zero matches**, in code, routes, database schema, reports, or tests.

**Existing RASSILON implementation: NONE.** Nothing to build on, nothing to avoid conflicting with, no partial state to reconcile.

### Relevant existing subsystems audited (read-only, for design reuse — see §9 for the full list)

- **OMEGA** (`cortex-server/src/lib/omega-*.js`, `cortex-server/src/routes/omega*.js`): frozen, certified visible/consented remote-admin module. Do not touch, do not import, do not reference `omega_*` tables. Its own certification report states OMEGA "accesses no `maitre_*`/`monitor_*`/`cyber_*` table and imports no MAÎTRE executor" — RASSILON must hold the same discipline relative to OMEGA and MAÎTRE both.
- **MAÎTRE** (`cortex-server/src/lib/maitre-*.js`, `cortex-server/src/routes/maitre.js`): local incident-response pipeline. Closest architectural sibling to RASSILON's job model — closed action-type enum, forbidden-generic-key validation, server-fixed permission level, single-dispatch executor table, hash-bound one-time approval, `execFile`+`shell:false`-only OS interaction. RASSILON mirrors this *shape*, without importing MAÎTRE code or touching `maitre_*` tables.
- **Local AI / Ollama** (`cortex-server/src/lib/ollama.js`): thin client wrapper, explicit user-triggered model pull only (`POST /api/ollama/pull`), no auto-pull anywhere. Directly reusable (read-only import) as the `LLM_INFERENCE` executor adapter.
- **Hardware/GPU detection** (`cortex-server/src/lib/local-hardware-profile.js`): already detects CPU cores, RAM, GPU/VRAM via a fixed read-only WMI PowerShell probe reusing MAÎTRE's `runReadOnlyPowerShell`. Explicitly documented as never sending data anywhere and never fingerprinting (no serial numbers, no MAC, no persistent machine ID). Directly reusable for RASSILON's capability advertisement and resource-budget enforcement.
- **Identity/signing** (`cortex-server/src/lib/omega-identity.js`, `cortex-server/src/lib/secret-store.js`): Ed25519 via Node's built-in `crypto`, SHA-256 fingerprint, private key stored via DPAPI-backed `secret-store.js` under a free-form namespace string. Structurally the correct template for RASSILON's own device identity — mirrored under a distinct `rassilon-device-key:` namespace, never sharing OMEGA's actual keys, tables, or session state machine.
- **Job/queue patterns**: no general-purpose job queue or worker-pool library in the codebase (no `bull`/`bullmq`/`p-queue`). Two ad hoc patterns exist: an in-memory ephemeral progress registry (`cortex-server/src/routes/jobs.js`, dies on restart) and persistent DB-backed pipeline tables (`video_jobs`/`video_job_segments`, `metagpt_missions`). RASSILON needs its own persistent `rassilon_jobs` table modeled on the `video_jobs` shape, since no shared scheduler exists to reuse.
- **Database**: single SQLite file (`cortex-server/src/lib/sqlite.js`), all tables in one file, isolation by table-name prefix only (`omega_*`, `maitre_*`, `monitor_*`, `cyber_audit_*`, etc.) — a convention OMEGA's own certification report treats as a hard isolation guarantee. RASSILON follows the same convention: `rassilon_*` tables added to the same file, no separate database.
- **Routes**: convention is `cortex-server/src/routes/<module>.js` exporting `create<Module>Route({ services, logger })` (Hono sub-app), mounted in `server.js` via `app.route('/api', create<Module>Route(...))`. Sensitive modules (MAÎTRE, monitor, cyber-audit, metagpt, sherlock) each inline the same loopback-only + Origin-check guard rather than relying on shared middleware.
- **Strict Local mode** (`cortex-server/src/lib/strict-local.js`): `isStrictLocalMode()` / `assertCloudAllowed(c, message)` is the one-line gate used by every route that could reach a cloud provider. A separate, independently-tested mechanism (`privacy-guard.js`, certified in `cortex-server/test-phase1-egress-certification.mjs`) blocks cloud egress for content marked private, regardless of the Strict Local toggle. RASSILON reuses `assertCloudAllowed()` at any point a job or result could leave the machine, and defaults any such surface to blocked.
- **Power/battery/live resource usage**: **not found anywhere in the codebase.** No battery API, no live CPU%/RAM% sampling. This must be designed and built from scratch for RASSILON's power-policy and safety-guard features (§6, §28) — flagged as a gap, not a reuse target.
- **Process spawning**: universal convention is `execFile`/`spawn` with `shell:false`; `shell:true` is treated as a named anti-pattern with explicit in-code comments warning against it. Two narrow, disclosed exceptions exist (`claude-oauth.js`, `codex.js`, lines probing local CLI `--version`/`login status` with fixed literal arguments only, needed because Windows `.cmd` shims require `cmd.exe`) — RASSILON must not adopt `shell:true` anywhere, including for any future local-CLI probes; the correct precedent is MAÎTRE's fixed-script-only, `shell:false`-always, `execFile`-only pattern.

---

## 3. Module separation

RASSILON is architecturally isolated from every other Docteur module: OMEGA, MAÎTRE, OBSERVATEUR, Voice, Local AI, Code Intelligence, MetaGPT, Sherlock, Investment, Business Agent.

- **Identity**: RASSILON has its own Ed25519 device keypair, stored via `secret-store.js` under a `rassilon-device-key:<deviceId>` namespace — distinct from OMEGA's `omega-device-key:<deviceId>` namespace, never shared, never derived from it.
- **Permissions**: RASSILON defines its own permission/consent state (§3 below is about module separation; consent model is §4). No implicit inheritance of OMEGA's `OMEGA_VIEW`/`INTERACTIVE`/`ADMIN` levels or MAÎTRE's `ACTION_LEVELS`. A user enabling OMEGA or MAÎTRE grants nothing to RASSILON, and vice versa.
- **Tables**: `rassilon_*` prefix only (§39). Zero reads or writes to `omega_*`, `maitre_*`, `monitor_*`, `cyber_audit_*`, or any other module's tables.
- **Routes**: `cortex-server/src/routes/rassilon.js` (control plane) is new and self-contained. It does not import `maitre-executor.js`, `maitre-approval.js`, `omega-identity.js`'s session state, or any other module's route logic. Where RASSILON's design *mirrors* another module's pattern (MAÎTRE's action-schema discipline, OMEGA's identity-key shape), it reimplements the pattern under its own name — it does not call into the other module's code.
- **Audit**: `rassilon_audit` is a separate closed-enum event log (§36), never comingled with `maitre_action_runs` or `omega_audit`.

---

## 4. Consent model

RASSILON is **OFF by default**. There is no implicit opt-in path — not on install, not on first Docteur launch, not as a side effect of enabling any other module (Local AI, OMEGA, MAÎTRE, etc.).

Activation requires an explicit user action in a dedicated RASSILON settings surface, during which the user must configure, before RASSILON can transition out of `OFF`:

| Setting | Purpose |
|---|---|
| CPU quota (%) | hard ceiling on RASSILON's CPU share |
| GPU allowed (bool) | whether any job may use the GPU at all |
| RAM quota (MB or %) | hard ceiling on RASSILON's memory footprint |
| Scratch disk quota (MB) | hard ceiling on RASSILON's temp storage |
| Allowed hours (optional) | time-of-day/day-of-week window, or "always" |
| Battery policy | run on battery: never / only above X% / only while charging (§28) |
| Auto-pause on machine use | pause when the user is actively using the machine (policy choice, §33) |
| Accepted job types | subset of the closed job-type enum (§7) the user allows |

No setting has a pre-filled "on" default that grants meaningful resource access — every quota field must be explicitly set by the user before RASSILON can leave `OFF`. Disabling RASSILON at any time reverts to `OFF` and clears any in-progress consent state; re-enabling requires walking through configuration again (no silently-remembered prior grant beyond what's persisted in `rassilon_settings`, which itself is visible and editable by the user at any time).

---

## 5. Visible indicator & user control

Whenever RASSILON is anything other than `OFF`, a visible indicator is mandatory — a system tray icon state and an in-app status widget, both reflecting the same underlying state machine:

```
OFF → IDLE → WORKING → PAUSED
        ↑________________|
              (also: any state → ERROR → OFF or IDLE after user ack)
```

- **OFF**: RASSILON disabled. No listener, no queue, no resource reservation.
- **IDLE**: enabled, no active job, awaiting/eligible to accept work within configured policy.
- **WORKING**: actively executing a job. Tray/indicator shows job type and elapsed time (never job input/output content).
- **PAUSED**: enabled but not accepting/executing work (user-initiated pause, or automatic pause per §6 safety guards).
- **ERROR**: a fault occurred (executor crash, resource-budget violation, integrity failure). Requires visible surfacing; does not silently retry into WORKING.

The user must be able to, at any time, from the local machine only:

- **PAUSE** — stop accepting new jobs, let any active job either finish or be cancelled (policy choice, default: cancel), resume later.
- **STOP** — immediately halt the active job (bounded-time forced termination, §21) and clear the queue.
- **DISABLE** — return to `OFF`, equivalent to STOP plus revoking the enabled state.

None of these controls may be remote-only. A remote controller (a paired Docteur instance, once multi-device exists in a future phase) may be allowed to *request* pause/stop of its own submitted jobs, but the local owner's PAUSE/STOP/DISABLE always wins and can never be hidden, delayed, or overridden remotely. No remote-hide of the indicator is permitted under any configuration.

---

## 6. Resource bounds & safety guards

### Resource bounds (hard ceilings, enforced by the executor, not advisory)

| Resource | Enforcement point | Notes |
|---|---|---|
| CPU % | OS-level where available (process priority / affinity), plus wall-clock job timeout as a backstop | Windows lacks a clean cgroups-equivalent; process priority + measured sampling + timeout is the realistic V1 mechanism |
| GPU % / VRAM | executor-level (bounded model size / batch size against `local-hardware-profile.js`'s VRAM reading), refuse job if it would exceed budget | No fine-grained GPU quota API exists on Windows for arbitrary processes; V1 enforces via admission control (reject oversized jobs) rather than live throttling |
| RAM | executor-level pre-check against configured quota; job aborted if it exceeds budget during execution (sampled) | |
| Disk scratch | fixed-size scoped scratch directory (§17) with quota enforcement and mandatory cleanup after each job | |
| Job duration | hard timeout per job type (mirrors MAÎTRE's `DEFAULT_TIMEOUT_MS` pattern), forced termination on expiry | |
| Concurrency | 1 active job by default, configurable ceiling, never unbounded | |
| Network bandwidth | not applicable in V1 — jobs execute against local-only executors (Ollama, etc.); no job-driven outbound network traffic exists to bound (§12) |

Exact numeric defaults (e.g. "CPU ≤ 25%") are deliberately not fixed in this document — the mission explicitly warns against fixing final values without dedicated audit of what's measurable and enforceable on Windows per resource type. Phase 2 must validate each bound against what the platform can actually report/enforce before defaults ship.

### Safety guards (automatic pause/stop triggers)

| Condition | Action | Feasibility note |
|---|---|---|
| RAM pressure high | pause, do not accept new jobs | measurable via `os.freemem()`-class APIs, feasible |
| Disk pressure high | pause | measurable via existing `Get-PSDrive`-style probe already used in `local-hardware-profile.js` |
| Battery low / not charging (per policy) | pause | requires new battery-state probe (§10, gap) |
| User actively using machine (if policy enabled) | pause or reduce priority | requires new idle/active detection (gap — see §33) |
| Docteur shutting down | graceful stop, no orphaned worker (§43) | process-lifecycle hook, feasible |
| CPU temperature critical | **not implemented in V1** | no reliable, universally-available thermal sensor API on consumer Windows without vendor-specific drivers; promising this would misrepresent what's actually measurable — documented as an explicit non-goal, not silently dropped |

---

## 7. Job model — Signed Semantic Job

RASSILON never accepts arbitrary commands, shell, PowerShell, cmd, bash, user-supplied code, downloaded scripts, or arbitrary executables. The only unit of work is a **Signed Semantic Job**: a closed-enum job *type*, with a type-specific validated parameter schema, executed by exactly one fixed, pre-installed, pre-authorized executor per type.

### V1 candidate job types (closed enum — subject to narrowing, not widening, during Phase 2 review)

| Job type | Executor | Precondition |
|---|---|---|
| `LLM_INFERENCE` | Ollama adapter (`ollama.js`, reused) | requested model already installed locally; no auto-pull (§26) |
| `EMBEDDING_BATCH` | Ollama embedding adapter (`embedText`, reused) | same |
| `IMAGE_GENERATION` | local ComfyUI adapter, only if already installed via the existing explicit user-triggered install flow | ComfyUI installed; no auto-install triggered by a job |
| `TRANSCRIPTION` | local transcription adapter, if/when one exists as a standing Docteur capability | executor must already exist and be locally authorized — RASSILON does not introduce a new transcription engine to satisfy this job type |
| `SAFE_CPU_TASK` | a narrowly-scoped, Docteur-authored, fixed-logic CPU task (e.g. a specific deterministic computation Docteur ships code for) | never a generic "run this code" — the task logic ships with Docteur, the job only supplies bounded parameters |

Every job type maps to exactly one fixed executor function, mirroring MAÎTRE's `EXECUTORS` dispatch table (§9). There is no generic `run(job.command)` or `spawn(job.executable)` path, and never will be in V1 — this is a structural guarantee, not a runtime check.

If a job requests a job type whose executor or required model/asset is not present locally, the job is rejected as `NOT_AVAILABLE` (§26) — never auto-installed, never auto-downloaded to satisfy the request.

---

## 8. Job schema

Conceptual schema (no implementation in this phase):

```
{
  jobId:          string (UUID, issuer-assigned, unique)
  jobType:        enum (§7 closed list)
  issuer:         { deviceId, publicKeyFingerprint }
  createdAt:      timestamp
  expiresAt:      timestamp (short-lived; anti-replay, §15)
  resourceBudget: { cpuPct, ramMb, gpuAllowed, maxDurationMs }
  input:          { refs: [inputReferenceId, ...] }   // never inline arbitrary filesystem paths
  outputConstraints: { maxSizeBytes, format }
  policyVersion:  string
  signature:      Ed25519 signature over the canonical serialization of the above
}
```

Explicitly forbidden fields, checked generically (mirroring MAÎTRE's `FORBIDDEN_KEY_PATTERN`) across the whole job object regardless of `jobType`:

```
command, cmd, shell, powershell, script, args, exec, execute,
executablePath, toolCall, tool_call
```

A job containing any of these keys — anywhere in its structure, not just top-level — is rejected before any type-specific validation runs, exactly as MAÎTRE rejects a forbidden key before dispatching to a type-specific handler.

---

## 9. Executor registry

Fixed `jobType → executor` mapping, no generic dispatch:

```
LLM_INFERENCE    → ollamaExecutor      (reuses cortex-server/src/lib/ollama.js)
EMBEDDING_BATCH  → ollamaEmbedExecutor (reuses cortex-server/src/lib/ollama.js's embedText)
IMAGE_GENERATION → comfyuiExecutor     (reuses existing ComfyUI install/spawn lifecycle, never auto-installs)
TRANSCRIPTION    → transcriptionExecutor (only if a standing local transcription capability already exists)
SAFE_CPU_TASK    → fixed, Docteur-authored function per allowed task id — not a generic function
```

Each executor is a named function with its own fixed parameter schema. There is no `run(job.command)`, no `spawn(job.executable)`, and no mechanism by which a job's fields select an arbitrary code path — the `jobType` string selects one of a fixed, small number of hardcoded functions, the same discipline as MAÎTRE's `EXECUTORS` table (§2).

---

## 10. Code execution — hard zero

RASSILON V1 guarantees, structurally:

- Arbitrary shell execution: **0**
- Arbitrary executable execution: **0**
- Arbitrary/dynamic code execution (`eval`, `new Function`, dynamically-loaded scripts): **0**
- Arbitrary container/payload execution: **0**

Even a validly signed job cannot escape this — the signature proves issuer authenticity and integrity, it does not grant a job the ability to specify code. The executor registry (§9) is the sole gate on what runs, and it is fixed at Docteur build time, not at job-submission time.

---

## 11. Crypto mining — explicitly not supported

```
crypto mining jobs: NOT_SUPPORTED
```

No job type in §7's closed enum is or ever becomes a hashing/mining primitive. Explicitly excluded, permanently, from the job-type enum: hashing-for-profit workloads, mining-pool client behavior, wallet-related jobs, Stratum protocol support, GPU workloads whose purpose is proof-of-work computation. Adding such a job type would require a new mission and explicit user authorization outside RASSILON's charter — it is not a matter of configuration.

---

## 12. Network model

V1 network surface is deliberately minimal:

- **Local Docteur** (same machine, loopback) — the primary V1 case: Docteur's own cortex-server submits jobs to RASSILON as a logically separate component within the same trusted process boundary (or a loopback-only child process/service in a later phase).
- **LAN, explicitly authorized** — a second Docteur-controlled device on the same local network, only after an explicit pairing-equivalent trust step (§13). Not automatic, not zero-configuration.

Explicitly **not built** in V1, and requiring a separate future phase with its own justification and threat model if ever pursued:

- Internet relay
- Public P2P
- UPnP / automatic port-forwarding
- NAT traversal, STUN, TURN
- Reverse tunneling

This mirrors OMEGA's own V1 transport decision (LAN-direct only, Internet relay explicitly deferred) — consistent posture across Docteur's local-agent modules.

---

## 13. Trust model

Who may issue a job to RASSILON in V1:

1. **The local Docteur instance itself** (same-machine cortex-server process) — trusted by construction, since it's the same install the user already granted permission to when they enabled RASSILON.
2. **An explicitly paired/authorized device**, if and only if a pairing-equivalent trust establishment (structurally similar to — but not reusing — OMEGA's pairing flow) has been completed by the user.

No anonymous job acceptance. No job is accepted from an unrecognized `issuer.deviceId`/public key. This is enforced the same way OMEGA enforces device trust: by checking the job's signature against a *registered* public key already on file, never a key supplied at job-submission time.

---

## 14. Job signatures

RASSILON jobs are cryptographically signed for integrity, issuer authentication, anti-tamper, expiry, and anti-replay.

**Algorithm**: Ed25519, via Node's built-in `crypto` module — the same choice OMEGA already made and validated for this codebase (no new dependency, no third-party crypto library, consistent with the "no new dependencies in Phase 1" constraint and this codebase's existing preference for built-ins over added packages).

**Identity separation from OMEGA**: RASSILON generates and stores its own device keypair, under its own `secret-store.js` namespace (`rassilon-device-key:<deviceId>`, distinct from OMEGA's `omega-device-key:<deviceId>`). RASSILON does not read, import, or depend on OMEGA's identity records, keys, or pairing state. A future multi-device RASSILON pairing flow would be RASSILON's own state machine (its own `rassilon_devices` table, §39), structurally similar to OMEGA's pairing model but not sharing code or data with it — matching this codebase's established per-module isolation discipline (§3).

**Verification**: `crypto.verify(null, jobBytes, registeredPublicKey, signature)` against a public key already on file for that `issuer.deviceId` — never a key supplied inline with the job itself.

---

## 15. Anti-replay

- `jobId`: issuer-assigned UUID, unique.
- `expiresAt`: short-lived (minutes, not hours) — a job presented after expiry is rejected outright, never queued.
- Processed-job cache: RASSILON maintains a bounded, time-windowed record of recently-processed `jobId`s (persisted in `rassilon_jobs`, §39) and rejects a duplicate `jobId` within that window.
- No job is treated as idempotent-safe-to-repeat by default; a job type would need to explicitly declare idempotency (not part of the V1 closed enum) before repeated execution of the same `jobId` could ever be permitted.

---

## 16. Job results

Results returned to the issuer are strictly bounded:

- `status` (closed enum: completed / failed / cancelled / timed_out)
- `metrics` (duration, resource usage summary — coarse, not a full process dump)
- small structured output (e.g. inference text, embedding vector) up to `outputConstraints.maxSizeBytes`
- artifact references (an id pointing into RASSILON's own scratch/artifact store, §17) rather than raw file content for large outputs

Never returned: machine secrets, environment variables, credentials, arbitrary filesystem contents, process listings, or any data outside what the specific job type's output schema defines.

---

## 17. Filesystem model

RASSILON operates against a single, dedicated, scoped scratch workspace (e.g. `<Docteur data dir>/rassilon/scratch/`) — never arbitrary filesystem access.

Explicitly **out of bounds**, unconditionally:

```
C:\ (root)
Documents, Desktop, Downloads
browser profiles / browser data directories
SSH keys / .ssh
Windows credential store / secret-store's OTHER namespaces
any path outside the RASSILON scratch workspace
```

The scratch workspace is quota-bounded (§6), cleanable (explicit cleanup after each job, plus a periodic sweep), and the only place executors may write.

---

## 18. Input data

Jobs reference inputs by an explicit, authorized identifier (`input.refs`, §8) — resolved by RASSILON against its own scratch/artifact store or an explicitly-provided payload, never by an arbitrary filesystem path supplied in the job. No job triggers a filesystem crawl, home-directory scan, or browser-data scan. If a job references an input id RASSILON cannot resolve within its own authorized store, the job fails validation — it never falls back to searching the filesystem.

---

## 19. Output data

Job output is written only into the RASSILON scratch workspace or a designated artifact store — never to an arbitrary path on the system, never overwriting existing user files, never outside the scoped workspace defined in §17.

---

## 20. Privacy policy

RASSILON does not collect, and no job type in the V1 closed enum can cause it to collect:

```
keystrokes
screen content
clipboard
credentials
browser history
personal documents (unless a specific file is explicitly supplied by the user as a job input, per §18 — never scanned or inferred)
```

This mirrors `local-hardware-profile.js`'s own explicitly documented stance (never sends data anywhere, no fingerprinting) — RASSILON extends the same posture to job execution, not just hardware probing.

---

## 21. Process security

For any future executor that spawns a subprocess (e.g. invoking a local model runner):

- fixed executable path (never derived from job input)
- fixed, schema-validated argument list (never a raw string, never shell-interpolated)
- `shell: false`, always — no exception carved out for RASSILON (§2 notes the codebase's two existing `shell:true` exceptions are narrow, disclosed, and specifically NOT a pattern RASSILON should extend)
- hard timeout per job type (§6)
- bounded stdout/stderr capture (mirroring MAÎTRE's `MAX_OUTPUT_BYTES`)
- kill targets the exact tracked process/process-tree for that job only — never a global "kill all node processes" or similarly broad operation

---

## 22. Persistence

V1: **no hidden persistence of any kind.** RASSILON does not install a Windows service, does not add a Registry Run key, does not schedule a task, and does not survive as an orphaned process independent of the Docteur/cortex-server process lifecycle (§43).

If a future phase proposes a tray application that starts with Windows, that must be:

- a separate, explicit user-facing toggle (default off)
- visible in Settings, not buried
- trivially disable-able from the same UI that enabled it
- never installed as a side effect of enabling RASSILON's compute-sharing feature itself

Phase 1 output is design only — no autostart mechanism is proposed for implementation here.

---

## 23. Windows-first

RASSILON V1 targets Windows only, consistent with this codebase's existing platform posture (`local-hardware-profile.js` explicitly short-circuits to `unsupported_platform` on non-Windows rather than guessing).

Available building blocks confirmed present in this environment:
- **Node.js** runtime (already the whole cortex-server stack).
- **Ollama**, via the existing `ollama.js` adapter, for `LLM_INFERENCE`/`EMBEDDING_BATCH`.
- **GPU/VRAM detection**: `local-hardware-profile.js`, already Windows-specific (WMI via PowerShell), directly reusable.
- **Process control**: `execFile`/`spawn` with `shell:false`, the established codebase-wide convention.
- **Power/battery APIs**: **not currently used anywhere in Docteur.** Would need a new, narrowly-scoped, read-only WMI probe (e.g. `Get-CimInstance -ClassName Win32_Battery`), built the same way `local-hardware-profile.js` built its GPU probe — fixed script, `execFile`, bounded timeout. This is new work, not reuse, and is called out as a gap (§10 of the mission checklist maps to this).

No WSL, no Docker dependency proposed — none is justified by anything in §7's job types, all of which run as native Windows processes via already-present adapters (Ollama) or Docteur-authored fixed logic.

---

## 24. GPU detection

Audited: `cortex-server/src/lib/local-hardware-profile.js` already detects GPU name/vendor/VRAM via a fixed, read-only WMI PowerShell script (`Win32_VideoController`), with a specific safeguard against WMI's known 32-bit `AdapterRAM` overflow bug on GPUs >4GB (treats implausible values as unknown rather than reporting a wrong number — directly relevant to RASSILON not trusting a bogus VRAM cap).

**Decision: RASSILON reuses `local-hardware-profile.js` as a read-only import.** No second hardware detector is written. RASSILON's GPU-budget enforcement (§6) consumes this module's output (`getTotalVramBytes()`, already exported) rather than re-probing WMI itself.

---

## 25. Ollama reuse

Audited: `cortex-server/src/lib/ollama.js` — `createOllamaClient`, `getInstalledModels`, `verifyModelAvailability`, `chatCompletion` (`stream:false`, bounded `keep_alive`), `embedText`, `unloadModel`. No auto-pull anywhere in this module or its route (`cortex-server/src/routes/ollama.js`'s `/pull` endpoint fires only on an explicit client-initiated call).

**Decision: RASSILON's `LLM_INFERENCE`/`EMBEDDING_BATCH` executors call into this module directly (read-only reuse).** RASSILON does not implement a second Ollama client, and does not add any auto-pull behavior — a `LLM_INFERENCE` job requesting a model not returned by `verifyModelAvailability()` is rejected `NOT_AVAILABLE` (§26), full stop.

---

## 26. Model downloads

V1 policy, no exceptions:

```
job requires a model/asset not already installed locally
→ NOT_AVAILABLE
```

No auto-download, no auto-pull, triggered by a job, ever. Installing a model remains a separate, explicit user action through Docteur's existing Local AI settings UI — RASSILON never initiates it on a job's behalf.

---

## 27. User priority

The machine owner is always prioritized over any RASSILON workload:

- **Pause when machine busy** — if the active-use safety guard (§6, §33) is enabled, RASSILON pauses or de-prioritizes rather than competing for resources.
- **Resource reduction** — RASSILON's process priority should be set low (e.g. below-normal / idle priority class) by default so it yields to foreground work automatically, independent of the explicit pause logic.
- **Manual pause / immediate stop** — always available locally (§5), always honored immediately, never queued behind an in-progress job beyond the bounded forced-termination timeout (§21).

RASSILON must never make the machine unusable — this is a design invariant that the resource-bound and safety-guard sections above (§6) exist specifically to enforce, and Phase 2's concrete numeric defaults must be validated against this invariant before shipping (e.g. a CPU quota that's technically "bounded" but still causes visible lag defeats the purpose).

---

## 28. Power policy

Configurable options (part of the consent model, §4):

- **Pause on battery** — RASSILON pauses entirely when the machine switches to battery power, if this policy is enabled (recommended default: enabled).
- **Minimum battery %** — a floor below which RASSILON pauses even if "run on battery" is otherwise allowed.
- **Only when charging** — the strictest option: RASSILON only ever runs while the machine is plugged in.

Default posture recommendation: conservative — no intensive work on battery unless the user explicitly opts into it, consistent with §27's "never make the machine unusable/inconvenient" invariant (a drained battery counts as harm to the user's ownership of their own machine).

This entire feature is a **gap** per §2 and §23 — no existing battery-state code exists in Docteur today. Phase 2 must build a minimal, read-only battery probe before this policy can be enforced; until then, "pause on battery" cannot be implemented and must not be advertised as active.

---

## 29. Scheduling

V1 scheduling is intentionally simple, matching the mission's explicit instruction against over-engineering:

- A bounded local queue (persisted in `rassilon_jobs`, §39).
- Simple priority (e.g. FIFO, or a single priority field with no complex weighting).
- One active worker by default, a small configurable concurrency ceiling above that (§6).

No cluster scheduler, no Kubernetes, no distributed orchestration framework — nothing in RASSILON V1's single-machine, 1-to-few-concurrent-job scope justifies one. This mirrors the audit finding (§2) that no such primitive exists elsewhere in Docteur either — RASSILON does not need to introduce the codebase's first one.

---

## 30. Multi-machine (future-proofing only, not implemented)

V1 is single-machine. The architecture below anticipates a future multi-machine phase without building it:

Each machine that could eventually run RASSILON would have:
- its own **identity** (Ed25519 keypair, §14, never shared across machines)
- its own **capabilities** advertisement (§31)
- its own **resource policy** (§4's settings, independently configured per machine)
- its own **status** (§5's state machine, independently visible per machine)

No public mesh, no machine-discovery-by-default, no assumption that a second machine is automatically trusted — a future multi-machine phase would need its own pairing-equivalent trust step (§13) per machine pair, the same posture OMEGA already takes for its own multi-device model.

---

## 31. Capabilities advertisement

A machine running RASSILON may advertise, to an already-trusted issuer only:

```
CPU logical core count
RAM budget (configured quota, not raw total)
GPU presence (bool) + VRAM budget (configured quota, not raw total)
installed safe executors (which of §7's job types this machine can actually run)
available local models (which Ollama models are installed, for LLM_INFERENCE fit-checking)
```

Explicitly **not** advertised:

```
full hardware fingerprint
serial numbers
MAC addresses / persistent machine identifiers
any identifier beyond what's needed for coarse capacity/fit decisions
```

This mirrors `local-hardware-profile.js`'s own documented non-goal (§2, §24) — RASSILON's capability advertisement is a filtered, coarse view of that module's output, not a new fingerprinting surface.

---

## 32. Job acceptance pipeline

```
receive job metadata
→ authenticate issuer (registered public key on file, §13)
→ verify signature (§14)
→ verify expiry / replay (§15)
→ validate job schema (§8) + forbidden-key check (generic, before type-specific validation)
→ check executor allowlist (jobType is in §7's closed enum, and its executor is actually installed/available, §26)
→ check local policy (§4's consent settings: is this jobType accepted? are we within allowed hours? battery policy satisfied?)
→ check resource budget (does the job's declared resourceBudget fit within remaining quota + configured ceilings, §6)
→ accept or reject (closed outcome — every rejection reason is one of a fixed set, never a leaking stack trace)
→ execute bounded (§6, §21)
→ produce result (§16)
→ cleanup (§17 scratch workspace)
→ audit (§36, every step above emits an audit event)
```

---

## 33. User approval mode

Two possible modes, per job type:

- **AUTO-ACCEPT for explicitly-allowed safe job types** — only for job types the user has explicitly checked in the consent settings (§4's "accepted job types" field), and only from an already-authenticated, already-trusted issuer.
- **ASK EACH JOB** — every job requires an explicit local approval before execution, regardless of job type.

**Recommended V1 default: ASK EACH JOB**, conservative, matching the mission's explicit instruction to default conservative. AUTO-ACCEPT is an opt-in relaxation the user can enable per job type after understanding what that job type does — it should never be the out-of-the-box behavior. This decision should be revisited in Phase 2 once real usage friction is measurable, but V1's design defaults to the safer, more conservative posture.

---

## 34. Kill switch

A single, always-available local action: **STOP ALL RASSILON WORK.**

Effects, in order:
1. Immediately stop accepting new jobs (transition out of `IDLE`/`WORKING` acceptance).
2. Cancel all queued jobs (never silently executed later).
3. Safely stop the active worker — bounded forced-termination if it doesn't exit within the job's timeout window (§21).
4. Clean up the scratch workspace for any in-flight job.
5. Prevent silent auto-restart — the kill switch leaves RASSILON in `PAUSED` or `OFF` (user's choice of which), never auto-resuming without a fresh explicit user action.

---

## 35. Revocation

Three revocation targets:

- **Issuer revoke** — a specific `issuer.deviceId` is no longer trusted; its future jobs are denied at the authentication step (§32), its currently-queued jobs (if any) are removed.
- **Device revoke** — the paired relationship with a remote device (future multi-machine phase, §30) is torn down entirely; same effect as issuer revoke plus removal of the device record.
- **Key revoke** — RASSILON's own device key is rotated/invalidated; any issuer trusting the old public key must re-establish trust against the new one.

An active job at the moment of revocation follows an explicit policy (not left ambiguous): the safest default is **immediate cancellation** of any active job tied to the revoked issuer/device, consistent with the kill-switch philosophy (§34) that revocation is a security action, not a graceful-wind-down request.

---

## 36. Audit log

Closed enum of event types (extendable only by future mission, not by runtime data):

```
RASSILON_ENABLED
RASSILON_DISABLED
RASSILON_PAUSED
RASSILON_RESUMED
SETTINGS_CHANGED
JOB_RECEIVED
JOB_ACCEPTED
JOB_REJECTED        (with a closed rejection-reason sub-enum, not free text)
JOB_STARTED
JOB_COMPLETED
JOB_FAILED
JOB_CANCELLED
JOB_TIMED_OUT
ISSUER_REVOKED
DEVICE_REVOKED
KEY_ROTATED
KILL_SWITCH_TRIGGERED
```

Each entry stores: `timestamp`, `jobId` (where applicable), `issuer.deviceId` (where applicable), `eventType`, `resultSummary` (coarse, closed-enum-shaped, never raw job input/output). Never stores: job input content, job output content, credentials, environment variables, or any secret material — mirroring OMEGA's audit redaction discipline (shared Pino redaction config, extended with RASSILON-specific field names rather than a bespoke scheme).

---

## 37. Telemetry

Local-only in V1:

```
CPU usage (of RASSILON's own job, not system-wide profiling)
RAM usage (same scope)
GPU usage, if reliably available (advisory only — §6 notes Windows lacks fine-grained per-process GPU quota APIs)
job duration
resource budget vs. actual consumption
```

No cloud telemetry, no analytics endpoint, no external transmission of any of the above in V1 — this data stays in `rassilon_jobs`/local memory and is surfaced only to the local UI/tray (§41).

---

## 38. Strict Local compatibility

RASSILON V1 is Strict-Local compatible by construction:

- Cloud calls: **0 by default.** Every job type in §7's closed enum executes against a local executor (Ollama, local ComfyUI, Docteur-authored fixed logic) — none of them call out to a cloud provider.
- Internet relay: **0** (§12).
- External marketplace / external job source: **0** — the only trusted issuers are the local Docteur instance and explicitly-paired devices (§13), never an open marketplace of external job requesters.

Any future RASSILON surface that could reach outside the machine (e.g. a future multi-machine relay) must call the existing `assertCloudAllowed()` gate (`cortex-server/src/lib/strict-local.js`) before proceeding, the same idiom every other cloud-capable route in this codebase already follows.

---

## 39. Database design

New tables, added to the existing single-file convention (`cortex-server/src/lib/sqlite.js`, alongside `omega_*`/`maitre_*`/etc. — no separate database file):

```
rassilon_settings   -- one row (or keyed by profile): enabled, cpu_quota, gpu_allowed,
                     -- ram_quota_mb, disk_quota_mb, allowed_hours, battery_policy,
                     -- auto_pause_on_use, accepted_job_types (JSON), approval_mode,
                     -- updated_at

rassilon_devices    -- future multi-machine: device_id, public_key, label,
                     -- capabilities (JSON, §31), paired_at, revoked_at, last_seen

rassilon_jobs       -- job_id (PK), job_type, issuer_device_id, status, resource_budget (JSON),
                     -- created_at, expires_at, started_at, completed_at, error_message,
                     -- result_summary (JSON, bounded per §16), cancelled (bool)

rassilon_audit      -- id (PK), timestamp, event_type (closed enum, §36), job_id (nullable),
                     -- issuer_device_id (nullable), result_summary (bounded)
```

No writes to `omega_*`, `maitre_*`, `monitor_*`, or `cyber_*` tables — confirmed as a hard constraint from the OMEGA precedent (§2, §3).

---

## 40. API (conceptual — not implemented)

```
GET  /api/rassilon/status              -- current state machine value + active job summary
GET  /api/rassilon/settings            -- current consent/quota configuration
POST /api/rassilon/enable              -- requires full settings payload (§4), cannot enable with defaults only
POST /api/rassilon/disable
POST /api/rassilon/pause
POST /api/rassilon/resume
GET  /api/rassilon/jobs                -- job history/queue (bounded, paginated)
POST /api/rassilon/jobs/:id/cancel     -- local cancel of a specific job
POST /api/rassilon/kill                -- kill switch (§34)

-- job submission, on an authenticated channel only (not a bare POST):
POST /api/rassilon/jobs/submit         -- body: signed job object (§8); loopback or
                                        -- paired-device-authenticated only, never anonymous
```

Structurally absent, permanently, from this API surface:

```
/shell
/exec
/run
/script
```

No field named `command`, `cmd`, `shell`, or `script` exists anywhere in this API, at any phase — the same guarantee OMEGA's API surface already holds.

Route module: `cortex-server/src/routes/rassilon.js`, following the `create<Module>Route({ services, logger })` factory convention, mounted via `app.route('/api', createRassilonRoute({ services, logger }))` in `server.js`. Control-plane endpoints (`status`/`settings`/`enable`/`disable`/`pause`/`resume`/`jobs`/`kill`) reuse the loopback-only + Origin-check guard pattern already inlined in `maitre.js`/`monitor.js`/`cyber-audit.js`. The job-submission endpoint, if ever reachable from a paired LAN device rather than loopback-only, needs the fuller device-identity+signature check (§13/§14) layered on top — a different, stronger trust boundary than the local control-plane guard, and this distinction must be made explicit in Phase 2's implementation, not conflated.

---

## 41. UI / Tray design (conceptual)

A simple, always-visible surface when RASSILON is not `OFF`:

```
┌─────────────────────────────┐
│ RASSILON            [●IDLE] │
│                              │
│ CPU budget:   ▓▓▓░░░  30%    │
│ RAM budget:   ▓▓░░░░  2.1GB  │
│ GPU:          allowed        │
│                              │
│ Current job:  —               │
│ Elapsed:      —               │
│                              │
│         [ PAUSE ]  [ STOP ]  │
└─────────────────────────────┘
```

While `WORKING`:

```
┌─────────────────────────────┐
│ RASSILON          [●WORKING]│
│                              │
│ CPU budget:   ▓▓▓▓▓░  85%    │
│ RAM budget:   ▓▓▓▓░░  3.4GB  │
│ GPU:          in use         │
│                              │
│ Current job:  LLM_INFERENCE  │
│ Elapsed:      00:00:42       │
│                              │
│         [ PAUSE ]  [ STOP ]  │
└─────────────────────────────┘
```

Tray icon reflects the same four visible states (`OFF` = icon absent or explicitly greyed, `IDLE`/`WORKING`/`PAUSED`/`ERROR` = distinct icon badges) — no state is invisible, no state requires opening a window to discover. This mirrors OMEGA's own "visible session indicator mandatory whenever active" invariant.

---

## 42. Threat model

For each threat: **Mitigation** / **Limitation** (residual risk) / **Test** (how a later phase proves it).

### T1 — Malicious issuer (a compromised or rogue trusted device submits harmful jobs)
- **Mitigation**: closed job-type enum (§7) bounds what *any* issuer, malicious or not, can ask for — there is no job shape that grants code execution regardless of issuer intent. Resource budgets (§6) bound blast radius even for a "successful" malicious-intent job (e.g. repeatedly submitting `LLM_INFERENCE` to waste resources is still capped by concurrency + quota).
- **Limitation**: a compromised trusted issuer can still spam legitimate-shaped jobs up to the resource ceiling, degrading the machine's availability for its owner within that ceiling.
- **Test**: Phase 2 — revoke a misbehaving issuer and confirm subsequent jobs are denied; confirm resource ceilings hold under a submission flood.

### T2 — Stolen/forged job (signature bypass attempt)
- **Mitigation**: Ed25519 signature verification against a registered public key (§14) — a job without a valid signature from a known issuer is rejected before any other processing.
- **Limitation**: if the issuer's private key itself is stolen, RASSILON cannot distinguish a legitimate job from an attacker holding that key until the key is revoked (§35).
- **Test**: Phase 2 — tampered job body (any single field changed) fails signature verification; job signed by an unregistered key is rejected.

### T3 — Replay attack
- **Mitigation**: `expiresAt` + `jobId` uniqueness + processed-job cache (§15).
- **Limitation**: the processed-job cache is bounded by the expiry window — a job replayed after the cache's retention window but before some other constraint would need `expiresAt` alone to have already caught it; V1 design keeps `expiresAt` short enough that this isn't a meaningful gap, but exact windows are a Phase 2 tuning decision.
- **Test**: Phase 2 — identical `jobId` submitted twice within the expiry window is rejected on the second attempt.

### T4 — Oversized job (resource exhaustion via declared or actual usage)
- **Mitigation**: `resourceBudget` is validated against remaining quota at admission time (§32); actual usage is sampled during execution and the job is aborted if it exceeds its declared budget.
- **Limitation**: sampling has some latency — a very short-lived spike could theoretically exceed budget between samples. Mitigated by hard OS-level ceilings (process priority, timeout) as a backstop rather than relying on sampling alone.
- **Test**: Phase 2 — job declaring a budget above the user's configured quota is rejected at admission; job that exceeds its declared budget mid-execution is terminated.

### T5 — Resource exhaustion via queue flooding
- **Mitigation**: bounded queue size (§29), concurrency ceiling (§6), rate consideration folded into job acceptance policy (§32/§33 — ASK EACH JOB by default further bounds this since each job needs local approval).
- **Limitation**: even a bounded queue can be kept full by a persistent malicious issuer, denying queue slots to legitimate jobs — mitigated by per-issuer fairness/limits, a Phase 2 tuning detail.
- **Test**: Phase 2 — queue-flood simulation confirms bounded memory/disk growth and confirms legitimate jobs aren't permanently starved.

### T6 — Malicious input data (input reference points to something harmful)
- **Mitigation**: inputs are resolved only against RASSILON's own authorized scratch/artifact store or explicit approved references (§18) — never an arbitrary filesystem path, never a URL fetched on the job's behalf in V1.
- **Limitation**: if the authorized input store itself is compromised (e.g. another Docteur component writes something malicious into it), RASSILON would process it as legitimate — this is a boundary-of-trust question for whatever writes to that store, not something RASSILON itself can fully control.
- **Test**: Phase 2 — job referencing an input id outside the authorized store is rejected; a path-traversal-shaped input reference (`../../etc`) is rejected by construction (references are opaque ids, not paths).

### T7 — Executor abuse (a job type's parameters are crafted to make its fixed executor do something unintended)
- **Mitigation**: each executor has its own strict, type-specific parameter schema (§7/§9), validated before the executor function is ever called — mirrors MAÎTRE's per-action-type schema discipline.
- **Limitation**: a schema bug in one executor's validation is a real residual risk class — this is why the executor list stays small and fixed (§9) rather than growing arbitrarily, keeping the audit surface small.
- **Test**: Phase 2 — each executor gets its own fuzz/boundary test suite for its parameter schema (oversized strings, wrong types, injection-shaped strings even though there's no shell to inject into).

### T8 — Path traversal (scratch workspace or output write escapes its bound)
- **Mitigation**: scratch workspace paths are always constructed from a fixed base directory plus a generated (never user/job-supplied) filename/id — never string-concatenated from job input (§17/§19).
- **Test**: Phase 2 — job input/output reference containing `../` or absolute-path-shaped strings is rejected or has no effect on the actual filesystem path used (since paths are never built from job strings in the first place).

### T9 — Command/shell injection
- **Mitigation**: structural — no job field is ever passed to a shell (§10, §21). `shell:false` always, fixed executable paths, fixed argument schemas.
- **Test**: Phase 2 — shell-metacharacter-laden strings (`; rm -rf`, `$(...)`, backticks, `&&`) submitted as job parameters have zero effect beyond being rejected/treated as inert data by whatever schema validation applies to that field.

### T10 — Job spoofing (attacker claims to be a different, more-trusted issuer)
- **Mitigation**: issuer identity is proven by signature against a registered public key (§13/§14), never by a self-declared `issuer` field alone — a spoofed `issuer.deviceId` with a signature that doesn't verify against that device's registered key is rejected.
- **Test**: Phase 2 — job claiming `issuer: trustedDeviceX` but signed with an unregistered/different key is rejected.

### T11 — DoS via the control-plane API itself (not job-related — e.g. flooding `/api/rassilon/status`)
- **Mitigation**: loopback-only + Origin-check guard (§40) bounds the control plane to local callers by default, the same posture as `maitre.js`/`monitor.js`. Rate limiting on sensitive endpoints (enable/disable/settings changes) is a Phase 2 implementation detail, following the same discipline OMEGA applies to its own pairing/session endpoints.
- **Test**: Phase 2 — repeated rapid calls to state-changing endpoints are rate-limited/cooled down.

### T12 — Secret/credential leakage via logs or audit
- **Mitigation**: audit log (§36) stores only closed-enum event data and bounded summaries, never job input/output content or credentials; reuses the existing shared Pino redaction discipline (§2, mirroring OMEGA's own approach) extended with RASSILON-specific field names.
- **Test**: Phase 2 — audit log entries for a job containing plausible-looking secret-shaped input never contain that raw input.

### T13 — Crash recovery / unexpected termination mid-job
- **Mitigation**: see §43 — no silent resume, job marked interrupted, no hidden worker survives a Docteur restart.
- **Test**: Phase 2 — forced server restart during an active job results in that job's status becoming `interrupted`/`failed`, never silently re-executed without a fresh signed job submission.

### T14 — Unknown/future job type submitted
- **Mitigation**: job schema validation rejects any `jobType` not in the closed enum (§7) — there is no default/fallback executor for an unrecognized type.
- **Test**: Phase 2 — job with a `jobType` string not in the enum is rejected with a closed-enum rejection reason, never silently ignored or executed by a best-guess handler.

---

## 43. Crash recovery

- **Server restart**: any job that was `WORKING` at the moment of restart transitions to `interrupted` (or `failed`) in `rassilon_jobs` — it is never silently resumed as if nothing happened. The scratch workspace for that job is cleaned up on next startup.
- **Queued jobs**: policy is explicit, not implicit — on restart, queued-but-not-started jobs are either re-validated (signature/expiry re-checked, since time has passed) before being reconsidered, or simply dropped and left for the issuer to resubmit, depending on Phase 2's chosen default; either way, they are never assumed-still-valid without re-validation.
- **No hidden worker survives Docteur shutdown.** RASSILON's job execution is bound to the same process lifecycle as the rest of cortex-server (or a supervised child process that is explicitly terminated on shutdown, never orphaned) — consistent with §22's no-hidden-persistence guarantee.

---

## 44. Test strategy (future plan, not executed in this phase)

Phase 2+ test plan should cover:

- Opt-in default is `OFF` — verified at fresh install and after any settings reset.
- Resource limits are enforced (CPU/RAM/GPU/disk/duration/concurrency), including the boundary case (budget requested = exactly the quota).
- Invalid signatures are rejected (tampered body, wrong key, malformed signature).
- Expired jobs are rejected.
- Replay attempts (same `jobId` twice) are rejected.
- Unknown job types are rejected.
- Oversized input/output is rejected.
- Path traversal in any reference field has no filesystem effect.
- Shell-injection-shaped strings in any job field have no shell effect (because there is no shell in the execution path).
- Executor allowlist holds — a `jobType` cannot select any function outside the fixed registry (§9).
- Kill switch stops queued and active work and prevents silent restart.
- Pause/resume behave correctly, including automatic pause triggers (RAM/disk pressure, battery, active-use policy).
- Revocation (issuer/device/key) denies future jobs and removes queued ones.
- Crash recovery — restart mid-job never silently resumes execution.
- Strict Local — no RASSILON code path reaches a cloud provider; verified the same way `test-phase1-egress-certification.mjs` verifies it for the rest of the router (mocked `fetch` that throws on any real network call).
- No XSS in any RASSILON UI surface rendering job metadata/status (job type strings, error messages) — since job metadata originates from a network-adjacent issuer, it must be treated as untrusted display data, not trusted HTML.
- Database isolation — a RASSILON test run never reads or writes `omega_*`/`maitre_*`/`monitor_*`/`cyber_*` tables; confirmed by asserting on the full set of tables touched during a test pass.

---

## 45. Security invariants (target state for Phase 2+)

```
arbitrary shell:          0
arbitrary executable:     0
arbitrary code:           0
hidden persistence:       0
crypto mining:            0
credential access:        0
screen capture:           0
keylogging:                0
clipboard access:          0
cloud relay (default):    0
silent auto-enable:       0
```

Every one of these is a structural property of the design above (closed job-type enum, fixed executor registry, no shell anywhere, `OFF`-by-default consent model, Strict-Local-compatible network model) — not a runtime check that could be individually disabled by a bug in one place.

---

## 46. Dependencies

**Zero new dependencies added or proposed for installation in this phase**, per the mission constraint.

If Phase 2 implementation needs a package (e.g. for a battery-state probe, though the WMI-via-PowerShell pattern already used by `local-hardware-profile.js` likely avoids needing one), it must be identified, license-checked, and justified against Node built-ins first — following the same discipline OMEGA's own architecture doc applied to its (still-undecided) transport library choice. Ed25519 signing needs no new dependency: Node's built-in `crypto` module already supports it and is already proven in this codebase via `omega-identity.js`.

---

## 47. Report

This document: `reports/RASSILON_ARCHITECTURE_2026-09.md`. No other source file has been created or modified in this phase.

---

## 48. Verdict

**READY_FOR_PHASE_2**, scoped strictly to what the mission defines as Phase 2's ceiling: a **local single-machine safe worker** — no multi-machine, no Internet transport.

Justification:
- No existing RASSILON code conflicts with or must be reconciled against this design (§2 — confirmed NONE).
- Every mission-mandated structural guarantee (§10, §11, §45) is satisfiable by the design above without requiring any pattern this codebase hasn't already proven safe elsewhere (MAÎTRE's closed-executor discipline, OMEGA's Ed25519 identity, `strict-local.js`'s cloud gate).
- The two genuine gaps identified (§2, §23, §28 — no existing battery/power API, no existing live CPU%/RAM% sampling, no existing active-use/idle detection) are real but narrow: they block full realization of the battery-policy and active-use safety guards, not the core job-acceptance/signature/executor-allowlist/resource-bound architecture. Phase 2 should build these probes early, following the exact pattern `local-hardware-profile.js` already established (fixed read-only WMI script, `execFile`, bounded timeout), before relying on them in shipped default policy.
- Phase 2 must still make and document several concrete decisions this Phase-1 design deliberately left open: exact numeric resource-quota defaults (§6), exact `expiresAt`/replay-window durations (§15), queued-job-on-restart policy (§43), and whether the control-plane's job-submission endpoint is loopback-only-for-V1 or also needs the fuller device-pairing trust layer from day one (§40) — recommendation: loopback-only for the true V1 slice (Docteur submitting jobs to itself), with LAN-paired-device submission deferred to the moment multi-machine is actually being built (§30), keeping Phase 2's surface area minimal.

---

## DOCTEUR RASSILON PHASE 1 CHECKPOINT

Existing RASSILON implementation :
NONE

Opt-in architecture :
PASS

Visible operation :
PASS

Resource limits design :
PASS

Safe semantic job model :
PASS

Signed job design :
PASS

Replay protection design :
PASS

Separate RASSILON identity :
PASS

Executor allowlist design :
PASS

Arbitrary shell :
0 attendu

Arbitrary executable :
0 attendu

Arbitrary code :
0 attendu

Hidden persistence :
0 attendu

Crypto mining :
0 attendu

Credential access :
0 attendu

Screen capture :
0 attendu

Keylogging :
0 attendu

Clipboard :
0 attendu

Cloud relay :
0 attendu

Strict Local compatibility :
PASS

Kill switch design :
PASS

Crash recovery design :
PASS

Database isolation :
PASS

Threat model :
PASS

Test plan :
PASS

Files changed :
reports/RASSILON_ARCHITECTURE_2026-09.md (created — this document, the only file added or modified in this phase)

Report :
reports/RASSILON_ARCHITECTURE_2026-09.md

Known limitations :
- No battery/power-state API exists anywhere in Docteur today (confirmed absent by repo-wide grep) — the "pause on battery" / "minimum battery %" power policy (§28) cannot be enforced until Phase 2 builds a new, narrowly-scoped, read-only WMI battery probe following the same pattern as `local-hardware-profile.js`'s GPU probe.
- No live CPU%/RAM% sampling exists anywhere in Docteur today — resource-bound enforcement during job execution (§6) will need this built in Phase 2; static CPU-core-count/total-RAM figures from `local-hardware-profile.js` are available now but are not the same as live utilization sampling.
- No active-use/idle detection exists anywhere in Docteur today — the "auto-pause when machine used" policy (§6, §33) cannot be enforced until Phase 2 builds this.
- CPU temperature monitoring is explicitly out of scope permanently (§6) — no reliable, universally-available thermal sensor API exists on consumer Windows without vendor-specific drivers; this is a documented non-goal, not a deferred gap.
- Exact numeric resource-quota defaults, exact anti-replay window durations, and the queued-job-on-restart policy are deliberately left as Phase 2 decisions (§48) rather than fixed arbitrarily in this architecture-only phase, per mission instruction.
- No dependency has been evaluated in depth for Phase 2's needs (e.g. confirming Node's built-in WMI-via-PowerShell approach fully covers battery-state reading) — Phase 2 must do this evaluation before any new package is proposed.

Verdict :
READY_FOR_PHASE_2

Then STOP.
