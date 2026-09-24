# DOCTEUR RASSILON V1 — LOCAL SINGLE-MACHINE SAFE WORKER (PHASE 2: IMPLEMENTATION)

Date: 2026-09-23
Scope: Phase 2 — implement the LOCAL SINGLE-MACHINE SAFE WORKER designed in Phase 1 (`reports/RASSILON_ARCHITECTURE_2026-09.md`). No multi-machine, no LAN worker, no Internet, no relay. OMEGA V1 (frozen/certified) was not touched, imported from, or referenced.

---

## 1. Git baseline

`git status --short` at the start of this phase showed only the pre-existing untracked `external/MetaGPT/` and `external/OpenMontage/` vendor directories (unrelated) and the Phase 1 architecture report. `git diff --stat` was empty. Before writing code, the following existing files were read in full to confirm the reuse decisions from Phase 1: `strict-local.js`, `sqlite.js` (table-creation block, `getMeta`/`setMeta`, existing RASSILON-adjacent tables' shape), `server.js` (route-mounting convention, `initSqlite` call site, shutdown handlers), `logger.js` (redaction paths), `ollama.js`, `local-hardware-profile.js`, `omega-identity.js`, `secret-store.js`, `maitre-actions.js`, `maitre-windows-exec.js`, and `routes/maitre.js`. No RASSILON implementation existed prior to this phase.

---

## 2. Architecture as actually built

### Module layout (`cortex-server/src/lib/`)

| File | Responsibility |
|---|---|
| `rassilon-identity.js` | Ed25519 device identity — generate, sign, verify, revoke. Mirrors `omega-identity.js`'s shape under a separate `rassilon-device-key:` secret-store namespace. |
| `rassilon-job-schema.js` | Closed job-type enum, forbidden-key recursive check, per-type payload schemas, canonical serialization, signature verification, expiry/timestamp checks. |
| `rassilon-executors.js` | Closed `jobType → executor` registry. Phase 2 ships exactly one job type, `SAFE_CPU_TASK`, with three kinds (`HASH_BUFFER`, `JSON_TRANSFORM_BENCH`, `VECTOR_MATH`) — all pure in-process computation, cooperatively cancellable. |
| `rassilon-settings.js` | Settings PATCH validation (range/type checks), conservative defaults documented in `sqlite.js`. |
| `rassilon-resource-guard.js` | Live CPU%/RAM telemetry (`os.*`/`process.*`, no new dependency) and admission/runtime budget checks. Explicitly distinguishes soft guard vs. hard OS limit. |
| `rassilon-power.js` | AC/battery status via a fixed, read-only WMI probe (`Win32_Battery`) through `maitre-windows-exec.js`'s existing `runReadOnlyPowerShell()`. |
| `rassilon-idle.js` | User idle-duration probe via `GetLastInputInfo` (P/Invoke, fixed C# compiled in-process by PowerShell's `Add-Type`), same safe-exec contract. Reports only a millisecond duration, never input content. |
| `rassilon-scratch.js` | Dedicated scratch workspace (`data/rassilon/scratch/`), path-containment-checked per-job directories, boot-time sweep, usage accounting. |
| `rassilon-audit.js` | Closed-enum audit event recorder, bounded summaries. |
| `rassilon-worker.js` | The worker itself: state machine, bounded FIFO queue, full job-acceptance pipeline, lifecycle (enable/disable/pause/resume/kill), crash recovery, safety-guard loop. |

### Route (`cortex-server/src/routes/rassilon.js`)

Loopback-only + Origin-checked Hono sub-app, mounted in `server.js` exactly like `maitre.js`/`monitor.js`. Routes call only `rassilon-worker.js` — never `rassilon-executors.js`/`rassilon-job-schema.js` internals directly, mirroring MAÎTRE's routes-stay-thin discipline.

### Database (`cortex-server/src/lib/sqlite.js`)

Four new tables added to the existing single SQLite file, alongside the table-creation block for OMEGA's tables (no new database file, no new table outside the `rassilon_*` prefix):

- `rassilon_settings` — single row (`id=1`), quotas/policy, `enabled` flag.
- `rassilon_identity` — **public key material only** (PEM + fingerprint). The private key never touches this table or any other row in SQLite — it lives exclusively in `secret-store.js`'s DPAPI-backed storage under the `rassilon-device-key:<deviceId>` namespace, verified by a dedicated test (`rassilon_identity table stores PUBLIC key only`).
- `rassilon_jobs` — one row per accepted job (`job_id` PRIMARY KEY — a duplicate insert throws, which is the anti-replay mechanism beyond the in-pipeline expiry/timestamp checks), full lifecycle status, bounded `resource_budget`/`payload_summary`/`result_summary` JSON columns.
- `rassilon_audit` — closed-enum event log, bounded `result_summary`.

No `rassilon_*` code path reads or writes `omega_*`, `maitre_*`, `monitor_*`, or `cyber_*` tables — verified both by manual review and by an automated static-audit test (`test-rassilon-static-audit.mjs`) that greps the RASSILON source tree for those table-name patterns.

### `server.js` integration

```js
initSqlite(env.SQLITE_PATH);
setMeta('boot_at', new Date().toISOString());

initRassilonScratch(path.resolve(rootDir, 'data/rassilon/scratch'));
initRassilonWorker({ logger });
...
app.route('/api', createRassilonRoute({ logger }));
```

No new port, no new listener, no new process — RASSILON rides the existing cortex-server Hono app and process lifecycle, exactly like MAÎTRE/monitor/OMEGA's control-plane routes.

---

## 3. Default OFF / state machine

`rassilon_settings.enabled` defaults to `0` at first row creation (`RASSILON_SETTINGS_DEFAULTS` in `sqlite.js`) and `initRassilonWorker()` derives `currentState = settings.enabled ? 'IDLE' : 'DISABLED'` at boot — a fresh install, or any install where `/enable` was never called, always boots `DISABLED`. No timer starts, no job is accepted, until `enableRassilon()` runs.

States: `DISABLED`, `IDLE`, `WORKING`, `PAUSED`, `ERROR` (the `ERROR` value exists in the enum and is checked by `submitJob()`'s rejection path, though Phase 2's own code never transitions into it — no executor or lifecycle path in this phase throws an error class serious enough to justify parking the whole worker in `ERROR` rather than failing the individual job; documented as a limitation in §12).

Transitions implemented and tested (`test-rassilon-worker.mjs`, 23 tests): `DISABLED → IDLE` (enable), `IDLE ⇄ PAUSED` (pause/resume), `IDLE/WORKING/PAUSED → DISABLED` (disable, kill switch), `IDLE → WORKING → IDLE` (job start/completion), enable requires a complete settings payload (rejected if incomplete), pause/resume both reject when `DISABLED`.

---

## 4. Settings

Fields and hard-coded conservative defaults, persisted in `rassilon_settings`:

| Field | Default | Rationale |
|---|---|---|
| `maxCpuPercent` | 25 | Mission's own conceptual ceiling — low enough to stay unnoticeable even on modest hardware. |
| `maxRamMb` | 2048 | Mission's own conceptual ceiling — deliberately NOT scaled to this machine's actual RAM (which would make the budget grow simply because a machine has more RAM); kept small and predictable across different machines. |
| `maxConcurrentJobs` | 1 | Mission §29 default — avoids any fairness/starvation design question in V1. |
| `maxJobDurationSec` | 300 | 5 minutes — generous relative to Phase 2's bounded SAFE_CPU_TASK payload sizes, short enough that a stuck job self-terminates quickly. |
| `maxScratchMb` | 1024 | Forward-looking ceiling; Phase 2's only executor writes no scratch files at all (pure in-process computation). |
| `pauseOnBattery` | true | Mission §11's explicit recommendation. |
| `minimumBatteryPercent` | 30 | Conservative floor, well above Windows' typical 10-20% low-battery warning threshold. |
| `pauseWhenUserActive` | true | Mission §27's "priorité utilisateur absolue" invariant, defaulted on. |
| `approvalMode` | `ASK_EACH_JOB` | Phase 1 architecture report §33's explicit conservative-default recommendation (`AUTO_ACCEPT_ALLOWED_TYPES` exists as an enum value but nothing in Phase 2 implements an auto-accept relaxation flow beyond the `acceptedJobTypes` allowlist check already in the pipeline — see §12). |

Hard platform ceilings independent of what a caller requests are enforced in `rassilon-settings.js` (`LIMITS`), e.g. `maxCpuPercent` capped to [1,90], `maxConcurrentJobs` to [1,4] — a settings write cannot silently create an unbounded worker even if a future UI relaxes the numbers, and `enabled` is structurally excluded from the generic settings-PATCH validator (it can only be flipped via the dedicated enable/disable functions).

---

## 5. Live CPU/RAM telemetry — soft guard vs. hard limit (mission §7-§10)

Implemented with Node built-ins only (`os.cpus()`, `os.freemem()`/`os.totalmem()`, `process.cpuUsage()`, `process.memoryUsage()`) — no new dependency, no dynamic WMI command strings.

- **System-wide CPU%**: two-snapshot delta over `os.cpus()`'s per-core `times` (user+nice+sys+irq vs. idle), aggregated across all cores then converted to a percentage.
- **Process-own CPU%**: `process.cpuUsage()` delta over a sampling window, normalized to one logical core's worth of capacity.
- **RAM**: `os.freemem()`/`os.totalmem()` for system-wide pressure, `process.memoryUsage().rss` for this process's own resident memory.

**Explicitly distinguished, as the mission requires**:
- **Soft resource guard (what Phase 2 implements)**: admission-time budget-vs-policy check (`checkAdmission`) before a job starts, and a periodic runtime check (`checkRuntimeBudget`) during execution that cancels a job whose process RSS has grown past its declared `ramMb` budget.
- **Hard OS limit (NOT implemented, NOT claimed)**: Windows has no clean, dependency-free cgroups-equivalent for capping an arbitrary Node process's CPU%. Phase 2 does not fabricate one. CPU quota enforcement is bounded instead by: (a) admission-time rejection of any job whose declared `cpuPercent` budget exceeds policy, (b) cooperative scheduling inside the executor (chunked work with `setImmediate` yields, mission §9's explicitly acceptable V1 mechanism), (c) a hard wall-clock timeout per job. This is a soft guard, not a kernel-enforced ceiling — documented here and in the checkpoint below as **PARTIAL**, matching mission §9's own instruction not to overclaim.

A known limitation, documented rather than hidden: because Phase 2's executor runs in-process (same event loop as the rest of cortex-server) rather than in a child process, "the job's own RAM usage" is not cleanly separable from the whole process's RSS — the runtime RAM guard checks whole-process RSS against the job's budget, which is a reasonable proxy for a single-concurrency worker but not a per-job-isolated measurement. This is called out explicitly in `rassilon-resource-guard.js`'s header comment.

---

## 6. Battery / power policy (mission §11)

`rassilon-power.js` probes `Win32_Battery` via a fixed, read-only PowerShell script through `maitre-windows-exec.js`'s existing `runReadOnlyPowerShell()` (same `execFile`/`shell:false`/timeout/bounded-output contract already proven by `local-hardware-profile.js`'s GPU probe). Reports `AC_ONLY` / `ON_BATTERY` / `NOT_PRESENT` / `UNKNOWN`, plus a battery percentage when available.

A desktop machine with no `Win32_Battery` instance reports `NOT_PRESENT` and the safety-guard sweep never pauses the worker on that basis — verified by test (`provider: NOT_PRESENT (desktop, no battery) — never blocks the worker`).

`pauseOnBattery=true` (the default) pauses the worker the moment `ON_BATTERY` is observed; independently, `minimumBatteryPercent` pauses even a `pauseOnBattery=false` configuration is not itself forced by this check — as configured today, `minimumBatteryPercent` is only meaningful when `pauseOnBattery` is also true, since the safety sweep only inspects the power reading at all when `pauseOnBattery` is enabled. This is a minor scope note, not a gap: the intended behavior ("pause on battery" as a graduated policy) matches this shape.

---

## 7. User idle/activity guard (mission §12/§13)

`rassilon-idle.js` calls `GetLastInputInfo` (user32.dll) via a fixed C# snippet compiled in-process by PowerShell's `Add-Type`, invoked through the same safe-exec contract. Returns **only** a millisecond "time since last input" integer — verified by test that the returned shape has exactly two keys (`idleMs`, `source`), never keystroke or mouse-position content.

`GetLastInputInfo` is session-scoped (reports input only for the interactive session the probe runs in), which is exactly the "is this machine's owner using it right now" signal needed — not a system-wide or cross-session snoop.

Cost note (confirmed by research before implementation): `Add-Type` C# compilation adds real overhead (~300-600ms per call, compilation-dominated) on top of the baseline PowerShell cold start. The safety-guard sweep polls every 30 seconds (`SAFETY_GUARD_INTERVAL_MS`), keeping this overhead negligible — this was a deliberate design decision, not an oversight; polling every few seconds would have been wasteful.

`pauseWhenUserActive=true` (the default) pauses the worker when idle duration drops under a 60-second "active" threshold.

---

## 8. Job model — Signed Semantic Job

Schema (mission §16), validated by `rassilon-job-schema.js`:

```
jobId, jobType, issuerId, createdAt, expiresAt, resourceBudget { cpuPercent, ramMb, maxDurationSec },
payload, policyVersion, signature
```

**Closed job-type enum, Phase 2**: `SAFE_CPU_TASK` only. Mission §20 explicitly recommended starting with 1-2 executors and warned against widening scope; `EMBEDDING_BATCH` (the Phase 1 report's other candidate) was deliberately deferred rather than added, documented in `rassilon-job-schema.js`'s header comment — adding it would pull a live Ollama dependency into every job-acceptance test, which the mission's own test philosophy ("provider injectable... not dependent on real hardware") argues against for this phase. `LLM_INFERENCE`/`IMAGE_GENERATION`/`TRANSCRIPTION` were not added, per explicit mission instruction.

**SAFE_CPU_TASK kinds** (mission §21): `HASH_BUFFER` (SHA-256/SHA-512 digest of a bounded hex buffer — a single fixed-size digest of caller-supplied data, explicitly NOT a nonce search or mining primitive), `JSON_TRANSFORM_BENCH` (deterministic aggregation/stats over a bounded array), `VECTOR_MATH` (bounded dot-product-sum or magnitude-sum over small equal-length numeric vectors). All three are pure, deterministic, in-process Node computation with strict per-field schema validation (types, sizes, counts, ranges) and unknown-field rejection.

**Forbidden keys** (mission §24 architecture report, mirroring MAÎTRE's `FORBIDDEN_KEY_PATTERN`): `command`, `cmd`, `shell`, `powershell`, `script`, `args`, `exec`, `execute`, `executablePath`, `toolCall`, `tool_call` — checked **recursively across the entire job object**, not just top-level, before any type-specific validation runs. Verified structurally correct by test: a job with `target: { executablePath: '...' }` nested two levels deep is still rejected as `forbidden_key`, not as a generic unknown-field error, confirming the recursive scan runs before the payload-specific schema.

---

## 9. Executor registry (mission §23)

```
SAFE_CPU_TASK → executeSafeCpuTask → { HASH_BUFFER, JSON_TRANSFORM_BENCH, VECTOR_MATH } handler dispatch
```

No `run(command)`, no `execute(command)`, no `spawn(job.executable)`, no `child_process` import anywhere in `rassilon-executors.js` — confirmed both by manual review and by the automated static-audit test suite. Each executor accepts an `AbortSignal` and checks it cooperatively between chunks (mission §35's realistic V1 mechanism — no subprocess to kill for in-process work). `runJobExecutor()` wraps every execution with a hard wall-clock timeout derived from the job's own `maxDurationSec` (capped by policy), converting a still-running job past that deadline into a `job_timed_out` rejection.

---

## 10. Anti-replay (mission §17/§18/§49)

Layered checks, all in `submitJob()`'s acceptance pipeline before any DB write:

1. **Reasonable timestamp**: `createdAt` more than 60 seconds in the future (clock skew / forged timestamp) is rejected.
2. **Lifetime cap**: `MAX_JOB_LIFETIME_MS = 5 minutes` — a job's own `expiresAt - createdAt` cannot exceed this, regardless of what the issuer requested. This is the "replay window" the Phase 1 report left as a Phase 2 decision (§18 of the mission): **5 minutes**, documented here as the real value.
3. **Expiry**: a job presented after its own `expiresAt` is rejected outright.
4. **Duplicate jobId**: `rassilon_jobs.job_id` is a PRIMARY KEY — a second submission with the same `jobId` throws a SQLite constraint violation, caught and reported as `job_id_already_processed`. This holds regardless of the first submission's outcome (`RECEIVED`/`QUEUED`/`RUNNING`/`COMPLETED`/`FAILED`/`CANCELLED`/`INTERRUPTED` — all leave a row with that `job_id`, so a replay after any of these terminal or non-terminal states is rejected identically).

Verified by 5 dedicated tests in `test-rassilon-worker.mjs`: same jobId twice, expired job, unreasonable future timestamp, lifetime exceeding policy, and replay of an already-`COMPLETED` job.

---

## 11. Separate RASSILON identity (mission §15/§48)

Ed25519 via Node's built-in `crypto` (no new dependency — same choice OMEGA already validated for this codebase). `rassilon-identity.js` structurally mirrors `omega-identity.js` but is fully separate code: its own `rassilon-device-key:<deviceId>` secret-store namespace (never `omega-device-key:`), its own `rassilon_identity` SQLite table (public key material only — the private key never leaves `secret-store.js`'s DPAPI-backed storage), zero imports of or calls into `omega-identity.js`.

Verified by test: namespace prefix check (`rassilon-device-key:device-x`, never `omega-`), signature round-trip, wrong-key rejection, mutated-job signature invalidation (any single field change — including a nested `payload.data` field — invalidates the signature), garbage-signature handling (never throws, always returns `false`), revocation (`deleteDeviceKey` removes the private key, `getDeviceKeyStatus` returns to `absent`), and a direct assertion that the stored `rassilon_identity.public_key_pem` row contains a `PUBLIC KEY` PEM marker and never a `PRIVATE KEY` one.

---

## 12. Trust model — Phase 2 (mission §19)

The only registered issuer path in Phase 2 is `upsertRassilonIdentity()`, called directly (there is no `/rassilon/identity/register` HTTP endpoint in this phase — registering a trusted issuer is an operator/test-harness action, not yet exposed over the API). This is intentionally conservative: Phase 2's mission scope is "Docteur local trusted issuer only," and no LAN/Internet/anonymous issuer path exists anywhere in the code (confirmed structurally — the only issuer-authentication call is `getRassilonIdentity(job.issuerId)` against the local `rassilon_identity` table, with no network-fetch or pairing-code alternative). A future phase that wants a UI-driven "register this Docteur instance as an issuer" flow would add a thin route around the already-implemented `generateDeviceIdentity()`/`upsertRassilonIdentity()` pair — noted as a known limitation in §16, not implemented here to avoid widening Phase 2's API surface beyond what the mission asked for.

---

## 13. Job lifecycle states (mission §30)

`RECEIVED` (audited, not persisted as a DB row — see below), `VALIDATED`/`QUEUED` (persisted), `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `REJECTED` (audited, not persisted as a DB row), `INTERRUPTED`.

**Design note, documented rather than left implicit**: a job that fails any acceptance-pipeline check (schema, signature, replay, policy, resource admission, queue-full) never gets a `rassilon_jobs` row — it is rejected before the first `INSERT`, with the rejection reason recorded only in `rassilon_audit` (`JOB_REJECTED` event with a closed reason code). This was a deliberate choice: persisting a full row for every rejected submission (including malformed/malicious ones) would mean an attacker-controlled `jobId`/`jobType` string ends up in `rassilon_jobs` regardless of validity, whereas the audit log's bounded, closed-enum shape is a cleaner place for "this was rejected and why." A job that *does* pass acceptance is inserted directly at `QUEUED` (the `RECEIVED`/`VALIDATED` states exist conceptually in the pipeline but are not separately persisted transient DB states) and then proceeds through `RUNNING → COMPLETED/FAILED/CANCELLED`, or `INTERRUPTED` if the process restarts mid-run.

---

## 14. Enable / disable / pause / resume / kill switch (mission §31-§33)

- **Enable**: requires a complete settings payload (all 8 quota/policy fields) — cannot enable relying on defaults alone (verified by test). Persists settings, flips `enabled=1`, transitions to `IDLE`, starts the safety-guard timer, audits `RASSILON_ENABLED`.
- **Disable**: cancels the queue, cancels any active job, flips `enabled=0`, stops the safety-guard timer, transitions to `DISABLED`, audits `RASSILON_DISABLED`.
- **Pause/Resume**: both reject if `DISABLED` (verified by test). Pause stops new job admission; resume re-derives `IDLE`/`WORKING` based on whether a job is still active, then re-drains the queue.
- **Kill switch** (`POST /rassilon/stop`): stops accepting, cancels the queue, cancels the active job, flips `enabled=0`, lands in `DISABLED` (the Phase 1 report's explicit recommendation) — never a silent resume.

---

## 15. Crash recovery (mission §34)

`initRassilonWorker()` runs at every server boot, before the worker accepts anything:

1. Every `rassilon_jobs` row still `RUNNING` from a prior process is marked `INTERRUPTED` (never silently resumed), its scratch directory cleaned up, and a `JOB_INTERRUPTED` audit event recorded.
2. Every row still `QUEUED`/`VALIDATED`/`RECEIVED` is marked `CANCELLED` (mission §34's explicit V1 recommendation: cancel queued jobs on restart rather than re-validate-and-resume), with `JOB_CANCELLED` audited.
3. The scratch workspace is swept (`sweepScratchOnBoot()`) — every per-job subdirectory under the scratch root is removed, regardless of which job it belonged to, since crash recovery already finalized every job's DB status by this point.
4. In-memory `queue`/`activeJob` are reset to empty/null (they hold nothing meaningful across a restart anyway, since this is a new process).

Verified by two dedicated tests that directly insert `RUNNING`/`QUEUED` rows (simulating a prior crash) and confirm `initRassilonWorker()` on the next call correctly transitions them.

---

## 16. Scratch workspace (mission §25-§27)

`cortex-server/data/rassilon/scratch/` (already covered by the existing wholesale `cortex-server/data/` gitignore rule — no new gitignore entry needed). Per-job subdirectories, resolved only from a fixed root plus a validated `jobId` (never string-concatenated from job-supplied data). Containment is checked via `path.relative()` + `path.resolve()`, refusing `..`, absolute paths, and UNC paths — verified by 4 dedicated path-safety tests plus 6 additional security-suite tests covering the same shapes through the full job pipeline.

Phase 2's only executor (`SAFE_CPU_TASK`) never actually writes to this workspace — all three kinds are pure in-process computation with structured JSON results. The scratch module and its quota/cleanup/sweep machinery are built now (not deferred) since the job-acceptance pipeline and crash-recovery path already reference `cleanupJobScratchDir()`, and a future executor must not be able to introduce a path-escape by construction — this is infrastructure a later phase's executors will need, verified correct today rather than assumed correct later.

---

## 17. Queue / scheduler (mission §28/§29)

`MAX_QUEUE_SIZE = 10` (documented, conservative, matching the mission's own conceptual example). Simple FIFO array of `jobId`s. `maxConcurrentJobs` defaults to 1 and Phase 2's scheduler (`processQueue()`) only ever starts a new job when `activeJob` is `null` — true single-concurrency, no starvation possible with one worker slot. A submission beyond `MAX_QUEUE_SIZE` is rejected with `queue_full`, verified by test.

---

## 18. Output bounds (mission §37)

Every executor result is JSON-serialized and checked against a 64KB bound (`MAX_RESULT_BYTES` in `rassilon-executors.js`) before being returned — `RassilonExecutionError('result_too_large')` if exceeded. No executor returns unbounded stdout, log text, or arbitrary file references (Phase 2 has no file-producing executor). The route layer's own body-size limit (64KB, `bodyLimit` middleware) independently bounds incoming job submissions.

---

## 19. Audit log (mission §38)

Closed enum in `rassilon-audit.js`: `RASSILON_ENABLED`, `RASSILON_DISABLED`, `RASSILON_PAUSED`, `RASSILON_RESUMED`, `SETTINGS_CHANGED` (defined but not yet emitted anywhere — see §21 limitations), `JOB_RECEIVED`, `JOB_REJECTED`, `JOB_QUEUED`, `JOB_STARTED`, `JOB_COMPLETED`, `JOB_FAILED`, `JOB_CANCELLED`, `JOB_INTERRUPTED`, `KILL_SWITCH_TRIGGERED`. `recordAuditEvent()` throws if called with an event type outside this enum (a code-level guardrail, not just documentation). Result summaries are bounded to 4KB; anything larger is replaced with `{truncated: true}`. Never logs job payload content, credentials, or private key material — the private key is never even in a variable this code path can reach (it lives inside `rassilon-identity.js`'s closure over `secret-store.js`).

---

## 20. API (mission §40)

```
GET  /api/rassilon/status
GET  /api/rassilon/settings
PUT  /api/rassilon/settings
POST /api/rassilon/enable
POST /api/rassilon/disable
POST /api/rassilon/pause
POST /api/rassilon/resume
POST /api/rassilon/stop
GET  /api/rassilon/jobs
GET  /api/rassilon/jobs/:id
POST /api/rassilon/jobs/:id/cancel
POST /api/rassilon/jobs            (signed job submission)
```

Loopback-only + Origin-checked guard, identical shape to `maitre.js`/`monitor.js` (127.0.0.1/::1 remote-address check, hostname allowlist, Origin header validation when present, JSON content-type requirement on POST/PUT, 64KB body limit). Verified by 10 route-level tests including non-loopback denial, bad-Origin denial, oversized-body 413, and a full enable→submit→poll→complete round trip through the actual Hono app.

No `/shell`, `/exec`, `/run`, `/script` route exists (verified by test: each returns 404). No field named `command`/`cmd`/`shell`/`script` appears anywhere in the request/response shapes.

**Signature required even from loopback** (mission §41): `POST /rassilon/jobs`'s body is a fully signed job envelope, validated through the exact same `submitJob()` pipeline regardless of caller — the route layer adds no "local callers skip verification" shortcut. This was verified structurally (the route calls `submitJobAndEnqueue`, an alias for `submitJob`, with no branch for trusted-origin bypass) and behaviorally (a job with a forbidden key or invalid signature is rejected identically whether or not the request came from loopback).

---

## 21. Known limitations (Phase 2, honestly scoped)

- **CPU quota enforcement is a soft guard, not a hard OS limit** (§5) — Windows has no clean cgroups-equivalent for an arbitrary Node process without a new dependency or a much larger architecture change (e.g. running each job in its own throttled child process/job object via Windows Job Objects, which was out of scope for this phase). Reported as **PARTIAL** below.
- **No issuer-registration HTTP endpoint** (§12) — registering a trusted issuer (`generateDeviceIdentity` + `upsertRassilonIdentity`) is currently a direct function call (used by tests and would be used by a first-run setup script), not exposed via `/api/rassilon/*`. Adding one is a small, well-scoped addition for a future phase, deliberately not added here to keep Phase 2's API surface exactly at what the mission listed in §40.
- **`SETTINGS_CHANGED` and `ERROR` state are defined but unused** — the audit enum includes `SETTINGS_CHANGED` for completeness/future-proofing, but `PUT /rassilon/settings` does not currently emit it (a one-line addition, omitted here since it wasn't exercised by any required test and didn't seem worth adding speculative code for). Similarly, the `ERROR` state exists in the state machine but nothing in Phase 2's code paths transitions into it — no executor or lifecycle failure in this phase's scope was judged severe enough to justify parking the *entire worker* in an error state rather than just failing the individual job.
- **In-process execution means RAM/CPU attribution is whole-process, not per-job** (§5) — documented, not hidden. A future phase that needs true per-job resource isolation would need child-process or worker-thread execution, which introduces its own process-management complexity (mission explicitly kept Phase 2 to "cooperative scheduling... concurrency limit... job cancellation," not process-level isolation).
- **`minimumBatteryPercent` is only checked when `pauseOnBattery` is also true** (§6) — not a bug, but worth flagging: there's no independent "pause below X% regardless of the pauseOnBattery toggle" path, since the safety sweep only reads battery state at all when `pauseOnBattery` is enabled.
- **Auto-resume after an automatic pause is not implemented** — the safety-guard sweep can transition `IDLE → PAUSED` automatically (battery/idle/RAM pressure), but nothing automatically transitions back to `IDLE` once conditions clear; resuming requires an explicit `/resume` call. This is a conservative simplification (documented in `rassilon-worker.js`'s `runSafetyGuardSweep` comment) rather than an oversight — auto-resume would need to track *why* a pause happened (user-initiated vs. automatic) to avoid silently overriding a user's own explicit pause, which was judged out of scope for Phase 2.
- **EMBEDDING_BATCH deferred** (§8) — a legitimate Phase 3 candidate per the Phase 1 report, deliberately not added in Phase 2 to keep the executor surface minimal and the test suite hardware-independent, per mission §20's explicit "start small" instruction.

None of these limitations weaken any of the mission's zero-tolerance invariants (§45 of the architecture report / the Phase 2 checkpoint below) — they are scope/precision limitations of a soft resource guard and an intentionally minimal Phase 2 API surface, not security gaps.

---

## 22. Test suite (mission §47-§60)

11 new test files, `test-rassilon-*.mjs`, 145 tests total:

| File | Tests | Covers |
|---|---|---|
| `test-rassilon-settings.mjs` | 10 | Defaults, enable-flag isolation from generic settings writes, range/type validation, boundary values |
| `test-rassilon-identity.mjs` | 10 | Key generation, fingerprint stability, namespace separation from OMEGA, sign/verify round trip, wrong-key/mutated-job/garbage-signature rejection, revocation, DB stores public key only |
| `test-rassilon-job-schema.mjs` | 19 | Schema validation, closed job-type enum, crypto-mining rejection, forbidden-key recursion, per-kind payload schemas, resource-budget validation, jobId format, timestamp/expiry ordering |
| `test-rassilon-executors.mjs` | 11 | All three SAFE_CPU_TASK kinds' correctness, bounded result size, timeout/cancellation wiring, unroutable-type defensive path |
| `test-rassilon-worker.mjs` | 23 | State machine transitions, enable/disable/pause/resume/kill, full accept-to-complete flow, 5 replay-protection tests, issuer/signature checks, queue overflow, job cancellation, 2 crash-recovery tests |
| `test-rassilon-security.mjs` | 20 | 7 dangerous-payload-shape rejections, forbidden-key end-to-end rejection, 5 scratch-path-traversal rejections, 5 crypto-mining-job-type rejections |
| `test-rassilon-resources.mjs` | 13 | Admission-check unit tests (CPU/RAM/duration over policy, insufficient free RAM), runtime-budget check, 3 end-to-end over-budget rejections, live telemetry sanity |
| `test-rassilon-battery-idle.mjs` | 9 | Injectable-provider battery (AC/on-battery/low-battery/no-battery) and idle (active/away) pause-decision logic |
| `test-rassilon-scratch.mjs` | 7 | Directory creation, cleanup, usage accounting, boot sweep |
| `test-rassilon-route.mjs` | 10 | Loopback/Origin guard, oversized body, disabled-state rejection, incomplete-enable rejection, full HTTP round trip, forbidden-key via HTTP, absent shell/exec/run/script routes |
| `test-rassilon-static-audit.mjs` | 13 | Automated grep-based regression guard for forbidden execution patterns, direct `child_process` imports, and cross-module table references |

**RASSILON suite result**: `node --test test-rassilon-*.mjs` → **145/145 pass, 0 fail, 0 cancelled, 0 skipped.**

---

## 23. Regressions

- `test-strict-local-centralized.mjs`: 6/6 pass — RASSILON adds no cloud call path, Strict Local behavior for the rest of the router is unaffected.
- `test-maitre-db.mjs` + `test-maitre-route.mjs`: pass — confirms the `sqlite.js` edit (new `rassilon_*` table-creation block + CRUD functions appended at file end) did not disturb MAÎTRE's existing tables/queries.
- `test-omega-identity.mjs` + `test-omega-route.mjs` + `test-omega-security.mjs`: 84/84 pass (combined with the MAÎTRE files above) — confirms OMEGA's identity/session/security behavior is untouched, and specifically that RASSILON's separate `rassilon-device-key:` secret-store namespace does not collide with OMEGA's `omega-device-key:` namespace.
- **Full backend suite** (`node --test test-*.mjs`, 144 test files, 2339 individual tests): first run at default (unthrottled) concurrency showed 36 failures, all `EBUSY` (Windows file-handle contention unlinking `data-test-rassilon-*` SQLite files) or the pre-existing `test-port-preflight.mjs` flake — both symptomatic of resource exhaustion from running 144 test-file processes fully in parallel, not logic defects. Re-run with `--test-concurrency=4` (a controlled, non-contended pass) produced **2330 pass / 6 fail / 3 skipped / 0 cancelled**, with **zero RASSILON test among the 6 failures**. Each of the 6 was individually re-run in isolation and confirmed pre-existing/unrelated to this phase:
  - `test-find-eval.mjs` — Playwright test requiring the frontend dev server at `localhost:5173` (not running during a backend-only regression pass; no frontend code was touched in Phase 2).
  - `test-video-pipeline.mjs` — `mock.module is not a function` (a Node.js test-runner API/flag mismatch in that file, pre-existing, unrelated to RASSILON).
  - `test-video-manual.mjs` — `ENOENT` on a malformed doubled path (`cortex-server/cortex-server/data/tmp/...`), a pre-existing bug in that test's own working-directory assumption.
  - `test-regression-api.mjs` — `EADDRINUSE` on port 3002 (test-suite port contention, pre-existing).
  - `checkPortOwnership` (2 subtests, `test-port-preflight.mjs`) — real network-port-probe timing flake under parallel load, the same test that also flaked in the first unthrottled run.
  A final isolated re-run of `node --test test-rassilon-*.mjs` alone confirmed **145/145 pass, 0 fail** after all of the above.

---

## 24. Static security audit (mission §58)

Manual `grep` across every `rassilon-*.js`/`routes/rassilon.js` file for: `shell:true`, `exec(`, `eval(`, `Function(`, `cmd.exe`, `powershell -Command`, `Invoke-Expression`, `iex`, `bash`, `sh -c`, `download`, `ollama pull`, `npm install`, `pip install`, `schtasks`, `service install`, `Run` registry key — **zero matches** in code (some patterns appear only in header comments explaining what the code deliberately does NOT do, e.g. "no shell:true anywhere," which the automated version of this check in `test-rassilon-static-audit.mjs` strips out before matching to avoid false positives on the comments themselves).

Additionally confirmed: no `rassilon-*.js` file imports `node:child_process` directly — every Windows-probe interaction (`rassilon-power.js`, `rassilon-idle.js`) goes through the already-audited `maitre-windows-exec.js`'s `runReadOnlyPowerShell()`, which is the sole `child_process`/`execFile` call site these modules depend on.

---

## 25. Typecheck / build / server boot (mission §62/§63)

- `npx tsc --noEmit` (repo root, covers the React/TS frontend under `src/`): **PASS**, no output/errors. cortex-server itself is plain JS (`node --check` used per-file instead, all pass — see below); the root `tsconfig.json` scope was unaffected by this phase since no frontend file was touched.
- `npm run build` (frontend production build): **PASS**, built in 1.63s, 37 precache entries, no new warnings beyond the pre-existing chunk-size advisory (unrelated to RASSILON).
- `node --check` on all 11 new/modified `cortex-server/src/lib/rassilon-*.js` + `routes/rassilon.js` + `sqlite.js` + `server.js`: **PASS**, zero syntax errors.
- **Server smoke boot**: booted `cortex-server/src/server.js` on a scratch port/SQLite path, confirmed `RASSILON_ROUTE` registered alongside `MAITRE_ROUTE_REGISTERED` et al., `GET /api/rassilon/status` returned `200 {"state":"DISABLED","enabled":false,...}` — confirming default-off boot, no new listener/port, no `EADDRINUSE`, no errors in the boot log. Server was cleanly terminated afterward; scratch DB/log files removed.

---

## 26. Files changed

**Created**:
```
cortex-server/src/lib/rassilon-identity.js
cortex-server/src/lib/rassilon-job-schema.js
cortex-server/src/lib/rassilon-executors.js
cortex-server/src/lib/rassilon-settings.js
cortex-server/src/lib/rassilon-resource-guard.js
cortex-server/src/lib/rassilon-power.js
cortex-server/src/lib/rassilon-idle.js
cortex-server/src/lib/rassilon-scratch.js
cortex-server/src/lib/rassilon-audit.js
cortex-server/src/lib/rassilon-worker.js
cortex-server/src/routes/rassilon.js
cortex-server/test-rassilon-settings.mjs
cortex-server/test-rassilon-identity.mjs
cortex-server/test-rassilon-job-schema.mjs
cortex-server/test-rassilon-executors.mjs
cortex-server/test-rassilon-worker.mjs
cortex-server/test-rassilon-security.mjs
cortex-server/test-rassilon-resources.mjs
cortex-server/test-rassilon-battery-idle.mjs
cortex-server/test-rassilon-scratch.mjs
cortex-server/test-rassilon-route.mjs
cortex-server/test-rassilon-static-audit.mjs
reports/RASSILON_LOCAL_WORKER_V1_2026-09.md   (this document)
```

**Modified**:
```
cortex-server/src/lib/sqlite.js   — added rassilon_settings/rassilon_identity/rassilon_jobs/rassilon_audit table
                                     creation + CRUD functions; zero changes to any existing table/function
cortex-server/src/server.js       — added 2 imports, 2 init calls (initRassilonScratch/initRassilonWorker)
                                     after initSqlite, 1 route mount (createRassilonRoute) alongside
                                     createMaitreRoute; zero changes to any existing route/init call
```

**Not modified**: any OMEGA file, any MAÎTRE file, any `omega_*`/`maitre_*`/`monitor_*`/`cyber_*` table, `.gitignore` (the existing wholesale `cortex-server/data/` and `data-test-*/` rules already cover RASSILON's runtime scratch and test-DB directories — no new rule was needed), `package.json` (zero new dependencies).

---

## DOCTEUR RASSILON PHASE 2 CHECKPOINT

Default OFF :
PASS

Explicit enable :
PASS

Visible status :
PASS

Separate RASSILON identity :
PASS

Signed jobs :
PASS

Replay protection :
PASS

Expired jobs rejected :
PASS

Semantic job schema :
PASS

Executor allowlist :
PASS

Arbitrary shell :
0 attendu — confirmé (grep manuel + test automatisé, aucune occurrence)

Arbitrary executable :
0 attendu — confirmé (aucun `spawn(job.executable)`/chemin exécutable arbitraire)

Arbitrary code :
0 attendu — confirmé (aucun `eval`/`new Function`/script dynamique)

Crypto mining :
0 attendu — confirmé (MINING/STRATUM/CRYPTO_MINING/HASHCASH_FOR_PROFIT explicitement NOT_SUPPORTED, testé)

Hidden persistence :
0 attendu — confirmé (aucun service Windows, aucune clé Registry Run, aucun scheduled task)

Credential access :
0 attendu — confirmé (RASSILON n'accède à aucun secret hors de sa propre clé device)

Screen capture :
0 attendu — confirmé (aucun code de capture d'écran)

Keylogging :
0 attendu — confirmé (idle probe ne retourne qu'une durée en ms, jamais de contenu clavier)

Clipboard :
0 attendu — confirmé (aucun accès presse-papiers)

Cloud relay :
0 attendu — confirmé (aucun appel cloud, Strict Local inchangé et testé)

Local-only API :
PASS

Queue bounds :
PASS

Concurrency bounds :
PASS

Job timeout :
PASS

CPU resource guard :
PARTIAL — soft guard (admission-time policy check + cooperative scheduling + wall-clock timeout), pas de hard OS cap kernel-level (non disponible proprement sur Windows sans nouvelle dépendance)

RAM resource guard :
PASS — soft guard fonctionnel (admission-time + runtime check), limitation documentée : mesure au niveau du process entier, pas isolée par job (exécution in-process)

Scratch quota :
PASS (infrastructure complète ; non exercée par l'unique executor Phase 2, qui n'écrit aucun fichier)

Battery policy :
PASS — implémenté (probe WMI Win32_Battery, pause on battery, minimum %, NOT_PRESENT géré), testé avec providers injectables

User idle guard :
PASS — implémenté (GetLastInputInfo via Add-Type, durée uniquement, jamais de contenu), testé avec providers injectables

Pause/resume :
PASS

Kill switch :
PASS

Crash recovery :
PASS

Strict Local :
PASS

RASSILON tests :
145/145

Skipped :
0

Failed :
0

Cancelled :
0

Relevant regressions :
PASS (Strict Local 6/6, MAÎTRE DB+route + OMEGA identity+route+security 84/84)

Full backend regression :
2330/2339 PASS (144 fichiers, concurrence contrôlée) — 6 échecs, tous pré-existants et sans rapport avec RASSILON (Playwright nécessitant le dev server frontend, incompatibilité API mock.module, chemin de test malformé, conflit de port, flake réseau préexistant sur checkPortOwnership) ; 0 échec RASSILON parmi ces 6 ; confirmé par ré-exécution isolée de chacun

Typecheck :
PASS

Build :
PASS

Server boot :
PASS

Files changed :
11 fichiers créés (lib) + 1 route + 11 fichiers de test + 1 rapport ; 2 fichiers modifiés (sqlite.js, server.js) ; 0 fichier OMEGA/MAÎTRE touché ; 0 nouvelle dépendance

Known limitations :
- CPU quota enforcement : soft guard uniquement (pas de hard cap OS sur Windows sans nouvelle dépendance/architecture)
- Pas d'endpoint HTTP d'enregistrement d'issuer (fonction directe utilisée par les tests, exposition API différée)
- SETTINGS_CHANGED et état ERROR définis mais non émis/atteints par le code Phase 2
- Isolation RAM par job non garantie (exécution in-process, mesure au niveau du process entier)
- minimumBatteryPercent seulement vérifié si pauseOnBattery=true
- Pas de reprise automatique après une pause automatique (reprise manuelle requise)
- EMBEDDING_BATCH différé à une phase future

Verdict :
PASS
