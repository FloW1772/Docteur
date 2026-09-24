# DOCTEUR RASSILON V1 — LOCAL WORKER ENRICHMENT + HARDENING (PHASE 3)

Date: 2026-09-23
Scope: Phase 3 — enrich and harden the Phase 2 local single-machine safe worker. Still LOCAL, SINGLE MACHINE, STRICT LOCAL — no multi-machine, no LAN, no Internet, no relay, no remote worker, no remote issuer, no shell, no arbitrary code, no terminal, no arbitrary filesystem, no model auto-download. OMEGA was not touched. MAÎTRE was not touched (no real bug was found in it, so mission §1's "sauf bug réel démontré" exception was not invoked).

---

## 1. Baseline audit

`git status --short` and `git diff --stat` before any change showed exactly the Phase 2 state (11 new lib files, 1 route, 11 test files, `sqlite.js`/`server.js` modified with pure additions — no drift, nothing left uncommitted from elsewhere). `reports/RASSILON_ARCHITECTURE_2026-09.md` and `reports/RASSILON_LOCAL_WORKER_V1_2026-09.md` were read in full before writing any code. The real Phase 2 implementation was audited directly (not assumed from the report): `rassilon-worker.js`, `rassilon-job-schema.js`, `rassilon-executors.js`, `rassilon-audit.js`, `rassilon-settings.js`, `rassilon-resource-guard.js`, `routes/rassilon.js` were all read end-to-end before any modification, confirming the documented state machine, acceptance pipeline, and closed registries matched what the code actually did.

---

## 2. EMBEDDING_BATCH executor

### Provider audit (mission §3)

Before writing any embedding code, the existing local embedding provider was audited: `cortex-server/src/lib/ollama.js`'s `embedText(client, modelName, text)` is the established adapter, already used by 9+ call sites across `server.js`/`routes/chat.js`/`routes/notebook.js`/`routes/pdf.js`/`routes/search.js`, backed by `env.EMBEDDING_MODEL` (default `'nomic-embed-text'`) and a module-level `ollamaClient` singleton. `verifyModelAvailability()` is the existing "is this model actually installed" check, already used the same way in `server.js`. **Decision: reuse this adapter directly, write no new embedding engine.**

### Implementation

`cortex-server/src/lib/rassilon-embedding.js` — a thin executor wrapping `ollama.js`'s `embedText`/`verifyModelAvailability`. `ollamaClient`/`embeddingModel` are always caller-injected (never a module-level import inside this file), wired from `server.js` using the **exact same** `ollamaClient`/`env.EMBEDDING_MODEL` objects every other embedding call site already uses — no new client, no new config surface.

### Local-only, no cloud fallback (mission §4)

The only network-capable object this module ever touches is the injected local Ollama client. No OpenAI/Gemini/Mistral/remote-endpoint code path exists anywhere in `rassilon-embedding.js`, confirmed by a dedicated static-audit test (`test-rassilon-static-audit.mjs`) that greps every RASSILON source file for `http://`/`https://` URL literals — zero matches. If the model is not installed, the job fails with `model_not_available` — never a fallback to any other provider.

### No model auto-download (mission §5)

`verifyModelAvailability()` is checked before every batch; on a miss, the executor throws `model_not_available` immediately. Nothing in this module or its call path calls Ollama's `/pull` endpoint or any install path — confirmed by the same static audit (no `ollama pull` pattern anywhere in RASSILON's own code).

### Input schema and limits (mission §6)

Real payload shape, added to `rassilon-job-schema.js`:

```
{ texts: string[], model: string }
```

Enforced limits (documented, not the mission's placeholder numbers — chosen and justified in code comments):

| Limit | Value | Rationale |
|---|---|---|
| max text count | 64 | Small, predictable batch size for a soft-guarded local worker — large enough to be useful, small enough that one job stays fast |
| max chars per text | 8,000 | Generous for a paragraph/short document chunk, well under what would make a single text dominate the job |
| max total chars | 100,000 | Caps aggregate work even if every text is near its individual ceiling |
| max output vectors | = text count (1:1) | One vector per text, structurally — no batching amplification |
| max output size | 512 KB | `rassilon-embedding.js`'s own `MAX_RESULT_BYTES`, larger than SAFE_CPU_TASK's 64KB bound since embedding vectors are inherently bigger, still finite and enforced |

### Model allowlist (mission §7)

`EMBEDDING_MODEL_ALLOWLIST = ['nomic-embed-text']` in `rassilon-job-schema.js` — the **only** embedding model name referenced anywhere in this codebase today (confirmed by grep; no other embedding model appears in `local-ai-catalog.js` or elsewhere). The allowlist is a closed set, not a pattern match — a job's `model` field must exactly equal an allowlist entry, never a path, URL, UNC path, or external registry reference. Verified by a dedicated test that submits `C:\models\evil.gguf`, `../../etc/models/thing`, `http://attacker.example.com/model`, `\\attacker-host\share\model`, etc. — all rejected with `embedding_model_not_allowed`, none ever reach the executor.

### Output (mission §8)

Bounded result shape: `{ kind, model, vectorCount, dimensions, vectors, durationMs }` — vectors, dimensions, counts, model identifier, and a timing figure only. No system path, no provider internals, no environment data.

### Data privacy (mission §9)

`rassilon-embedding.js` makes **zero** calls to any logger — confirmed by static-audit test (no `log(` call anywhere in that file's code). The worker's own `log()` calls for job lifecycle events reference only `jobId`/`jobType`/error codes, never the payload/texts/vectors — confirmed by a static-audit test that scans every `log(` call site in `rassilon-worker.js` for suspicious identifiers. Audit events for embedding jobs carry only the closed-enum reason code (e.g. `model_not_available`), never input text or output vectors.

---

## 3. Resource budget honesty (mission §10/§11/§12)

EMBEDDING_BATCH respects the same `maxCpuPercent`/`maxRamMb`/`maxJobDurationSec`/`maxScratchMb`/`maxConcurrentJobs` admission checks as SAFE_CPU_TASK — no separate code path, same `checkAdmission()`/`checkRuntimeBudget()` from `rassilon-resource-guard.js`.

**Honest limitation, stated plainly**: RASSILON does **not** and **cannot** impose a hard CPU cap on the local Ollama server process — Ollama runs as its own separate OS process/service that RASSILON has no kernel-level control over. The worker's CPU quota enforcement was already documented as a **soft guard** in Phase 2 (admission-time policy check + cooperative scheduling + wall-clock timeout for RASSILON's own in-process work); for EMBEDDING_BATCH, RASSILON's control is even narrower — it can refuse to *submit* a job whose declared budget exceeds policy, and it can time out and discard the *result* of a request that runs too long, but it cannot throttle Ollama's own CPU usage while a request is in flight. This is documented directly in `rassilon-embedding.js`'s header comment and reflected honestly in the checkpoint below.

---

## 4. RAM guard for EMBEDDING_BATCH (mission §12)

Same admission-time check as any job type (`checkAdmission`'s `ram_budget_exceeds_policy`/`insufficient_free_ram`). During execution, the periodic safety-guard sweep's `checkRuntimeBudget()` observes this process's own RSS (the same whole-process limitation already documented in Phase 2 — RASSILON's own process, not Ollama's separate process) and cancels the active job if it's exceeded — never a voluntary OOM.

---

## 5. Telemetry / power / idle probe failure policies (mission §42/§43/§44)

- **RAM telemetry failure (mission §42)**: `rassilon-resource-guard.js`'s `getSystemRamStatus()` now returns `{ available: false, ... }` on any unexpected failure (defensive, since `os.totalmem()`/`os.freemem()` don't realistically throw) rather than fabricating a plausible reading. `checkAdmission()` treats `available: false` as an explicit `ram_telemetry_unavailable` rejection reason — a job is **never** admitted on the strength of missing data.
- **Power probe failure (mission §43)**: already correctly distinguished in Phase 2 — `NOT_PRESENT` (WMI succeeded, no battery found) is structurally different from `UNKNOWN` (probe failed/timed out/unsupported platform), confirmed by a dedicated regression test this phase (`power probe UNKNOWN is distinct from NOT_PRESENT`).
- **Idle probe failure (mission §44)**: **new conservative policy** — if `pauseWhenUserActive=true` and the idle reading is `UNKNOWN` (`idleMs: null`, the probe genuinely failed), the safety-guard sweep now treats this as **not healthy** and auto-pauses, rather than the Phase 2 behavior of silently skipping the check and letting a new job start with no confirmation the user is actually away. Verified by test.

---

## 6. AUTO_PAUSED vs. manual PAUSED (mission §13/§14/§46)

`AUTO_PAUSED` is now a distinct, real state in the state machine (`STATES` includes `DISABLED, IDLE, WORKING, PAUSED, AUTO_PAUSED, ERROR`), never conflated with manual `PAUSED`:

- The safety-guard sweep's auto-pause path (`evaluateAutoPauseReason` → `AUTO_PAUSED`) only ever transitions `IDLE`/`WORKING` → `AUTO_PAUSED`. It never touches a state that's already `PAUSED` (verified by test: an auto-pause-triggering condition observed while manually `PAUSED` leaves the state at `PAUSED`, not overwritten to `AUTO_PAUSED`).
- Manual `pauseRassilon()` always sets `PAUSED`, never `AUTO_PAUSED` — a human explicitly asked, so only a human resumes it.
- **Manual pause is never auto-resumed** — the sweep's auto-resume logic only fires from `AUTO_PAUSED`, never from `PAUSED`. Verified by a dedicated test that runs three consecutive healthy sweeps against a manually-`PAUSED` worker and confirms it stays `PAUSED`.

## 7. Auto-resume with hysteresis (mission §14/§15)

`AUTO_PAUSED → IDLE` requires `AUTO_RESUME_HEALTHY_SWEEPS_REQUIRED = 2` **consecutive** healthy sweeps (documented constant in `rassilon-worker.js`). At the existing 30-second sweep interval, this means a minimum of ~30-60 seconds of sustained healthy conditions before auto-resume fires — chosen and documented, not left as an unstated implicit value. A single healthy sweep does **not** resume; an unhealthy sweep at any point resets the counter to zero (verified by a dedicated test covering exactly this reset scenario). Auto-resume conditions checked: not `ERROR`/`DISABLED`/manually `PAUSED`, `RASSILON` still `enabled`, AC/battery condition back within policy, user idle again, and RAM pressure cleared.

---

## 8. ERROR state (mission §16/§17)

`ERROR` is now a real, reachable state with a defined trigger, not a defined-but-unused enum value:

- **Trigger**: `initRassilonWorker()` runs `checkExecutorRegistrySanity()` at every boot — confirms every job type in the schema layer's closed `JOB_TYPES` enum has a matching entry in the executor registry's `AVAILABLE_EXECUTORS`. A mismatch (a structural code defect, not a per-job problem) enters `ERROR` immediately, before accepting anything, with `errorDetail = { code: 'executor_registry_invalid', message }` exposed via `getRassilonStatus().error`.
- **Explicitly NOT triggered by**: a single job failing (`JOB_FAILED` status on that one job row — the worker itself stays healthy), a transient safety-guard sweep hiccup (caught and logged, worker stays exactly where it was), or an `EMBEDDING_BATCH` provider failure (`RassilonEmbeddingError` is caught per-job in `runJob`, never escalated to worker-level `ERROR`).
- **In ERROR**: `submitJob()` rejects every new job with `rassilon_error_state` (verified by test). `pauseRassilon()`/`resumeRassilon()` both refuse (`cannot_pause_in_error`/`cannot_resume_in_error`). `disableRassilon()` and `killAllRassilonWork()` **always** work, unconditionally, from `ERROR` exactly as from any other state — neither function has any state-based guard clause blocking it (verified by test).
- **Recovery**: the **only** path out of `ERROR` is calling `enableRassilon()` again, which **re-runs the exact same registry sanity check** `initRassilonWorker()` runs — `ERROR` only clears if that check now passes. This is deliberate deterministic recovery, not a silent auto-reset: a worker genuinely stuck with a broken registry stays in `ERROR` even after an enable attempt (verified by test with a synthetic forced-error state).

---

## 9. SETTINGS_CHANGED audit (mission §18)

`rassilon-worker.js`'s new `changeRassilonSettings()` function (which `PUT /rassilon/settings` now calls, replacing the route's prior direct call into `sqlite.js`) diffs the settings before/after a validated patch and, if anything actually changed, emits one `SETTINGS_CHANGED` audit event containing: the list of changed field names, an `{ old, new }` pair per changed field, whether the change happened `appliedDuringWorking` (a boolean, for observability), and whether any changed field is one of the `NEXT_JOB_ONLY_FIELDS`. A no-op patch (new value equals the old value) emits **no** audit event — verified by test. Settings contain no secrets, so nothing is redacted, but the function is written generically (diff-only, never dumping the whole object) rather than assuming that will always remain true.

---

## 10. Settings mutability policy (mission §19/§20)

**Decision (confirmed with the user before implementation): next-job-only.** Changing `maxCpuPercent`/`maxRamMb`/`maxJobDurationSec`/`maxConcurrentJobs`/`maxScratchMb` while a job is `WORKING` never affects that already-running job — its `resourceBudget` was captured on the `rassilon_jobs` row at admission time and is never re-read from live settings mid-execution. A new/lower value only takes effect for jobs admitted **after** the change, since `checkAdmission()` always reads `getRassilonSettings()` fresh at admission time. This is enforced **structurally** (there is no code path that re-reads settings for an in-flight job's own limits), not by a special-cased runtime check that could drift out of sync. Verified by two dedicated tests: one confirms an active job's own `resourceBudget` row is unchanged after a mid-flight settings change; the other confirms a *subsequent* job submission is correctly rejected against the newly-lowered limit.

---

## 11. Executor registry stays closed (mission §21/§22)

`JOB_TYPES` (schema layer) and `AVAILABLE_EXECUTORS` (executor layer) are both exactly `['SAFE_CPU_TASK', 'EMBEDDING_BATCH']` — verified by test as the Phase 3 ceiling. No `runTool(name, args)`, `runCommand(...)`, `executeBinary(...)`, `executeScript(...)`, or `loadPlugin(path)` exists anywhere in RASSILON's code — confirmed by the static-audit test's forbidden-pattern grep (covers `exec(`, `eval(`, `new Function(`) plus manual review of every executor function's signature (each takes `(payload, options)`, never a caller-suppliable function name or path).

---

## 12. Schema strictness (mission §23/§38/§39)

Both job types' payload schemas reject unknown fields, validate every range/type/count, and cap array/string sizes. EMBEDDING_BATCH-specific security tests (mission §38) submit `command`, `shell`, `script`, `executablePath` (rejected as `forbidden_key`, recursive scan), `url`/`endpoint`/`providerUrl` (rejected as `payload_unknown_field` — the schema is closed to exactly `{texts, model}`), and confirm that path-traversal/drive-letter/UNC/`javascript:`/template-injection strings are **accepted as ordinary text content** when placed inside a `texts` array entry — since EMBEDDING_BATCH never interprets text as a path/command/URL anywhere in its pipeline, these strings carry no special authority; the test locks in that non-interpretation rather than assuming it. Oversized-payload tests (mission §39) cover too-many-texts, single-huge-text, total-chars-too-large, invalid model, empty list, wrong type, and a deeply-nested object as a text entry — all rejected before ever reaching the queue.

---

## 13. Signature coverage / replay (mission §24/§25)

No change needed to `canonicalJobBytes()` — it already covers `jobId, jobType, issuerId, createdAt, expiresAt, resourceBudget, payload, policyVersion` (everything except the signature itself), so `EMBEDDING_BATCH`'s `payload.texts`/`payload.model` are already inside the signed material; mutating either invalidates the signature, verified by test (a tampered `texts` array after signing is rejected as `signature_invalid`, never reaching the provider). Anti-replay was already comprehensive in Phase 2 (`job_id_already_processed` for any terminal or non-terminal status, since the `rassilon_jobs.job_id` PRIMARY KEY constraint fires regardless of what state the first submission reached) — extended with a dedicated EMBEDDING_BATCH-specific replay test this phase.

---

## 14. Queue determinism with a mixed job-type mix (mission §26)

A dedicated test submits `SAFE_CPU_TASK`, `EMBEDDING_BATCH`, `SAFE_CPU_TASK` in that order (single concurrency) and confirms all three complete with the correct `jobType` preserved per row — simple FIFO holds regardless of job-type mix, no special-casing needed since the queue only ever stores `jobId` strings.

---

## 15. Cancellation limitation, disclosed honestly (mission §27/§28)

**EMBEDDING_BATCH's cancellation is checked BETWEEN texts, not mid-request.** `ollama.js`'s `embedText()` call has no `AbortSignal` parameter in the version this codebase depends on — a cancellation request stops further texts in the batch from being submitted, but a single `embed()` call already in flight for the current text cannot be physically severed; the executor can only discard that one in-flight result once it settles. This is documented directly in `rassilon-embedding.js`'s header comment and verified by test: an abort signaled during the first text's request correctly prevents a second text's request from ever being made (`embedCalls === 1`), demonstrating the real, disclosed boundary of what "cancellation" means here — never claimed as hard mid-request cancellation. The job-level timeout (`min(job request, policy max)`, `runJobExecutor`'s existing `AbortController` + `setTimeout`) is unchanged and applies identically to both job types.

---

## 16. Kill switch (mission §29)

Unchanged behavior, re-verified this phase: stop accepting, cancel queue, signal the active executor's `AbortController` (which EMBEDDING_BATCH's cooperative between-texts check honors the same way SAFE_CPU_TASK's chunk-boundary check does), cleanup, `enabled=false`, lands in `DISABLED`. No auto-resume afterward. Two new tests confirm the kill switch also works unconditionally from `ERROR`.

---

## 17. Battery / idle policy decisions (mission §30/§31)

**Decision (documented, mission §30's explicit open question)**: `minimumBatteryPercent` remains scoped **only** to when `pauseOnBattery=true` — the safety sweep only reads battery state at all when that setting is enabled, so there is no independent "pause below X% regardless of pauseOnBattery" path. This is a coherent, intentional choice (a user who disabled `pauseOnBattery` entirely has said they don't want battery state to affect RASSILON at all, including the percentage floor) rather than an oversight — restated explicitly here since the mission asked for an explicit decision, not silence.

`rassilon-idle.js`'s `GetLastInputInfo`-based probe is unchanged: duration only, no keystroke capture, no mouse-movement capture, no active-application capture — confirmed structurally (the probe's return shape is exactly `{ idleMs, source }`, nothing else) and by the existing regression test asserting that shape.

---

## 18. Scratch (mission §32)

EMBEDDING_BATCH's executor writes **zero** scratch files — every operation is in-process (validated batch → provider call → structured JSON result), matching SAFE_CPU_TASK's existing pattern. The scratch infrastructure (`rassilon-scratch.js`) is unchanged and unexercised by either job type in this phase — kept, not removed, since a future executor may need it and the path-containment discipline is already proven correct.

---

## 19. Local API (mission §33/§34)

No new route, no LAN surface, no separate listener — `PUT /api/rassilon/settings` already existed from Phase 2 and now routes through the new `changeRassilonSettings()` (audit + mutability policy) instead of calling `sqlite.js` directly. Same loopback-only + Origin-check guard, same bounded body. Verified by 3 new route-level tests (valid PATCH round-trips through GET, invalid PATCH rejected 400, `enabled` field rejected via PATCH).

---

## 20. Issuer registration (mission §35) / multi-machine (mission §36)

**Not added, as instructed.** The only issuer-authentication path remains `getRassilonIdentity(job.issuerId)` against the local `rassilon_identity` table — no network-fetch, no pairing-code alternative, no LAN job-submission path, no device-discovery code, no cluster/mesh code anywhere in the codebase. Confirmed structurally: RASSILON's route (`routes/rassilon.js`) mounts no new listener and adds no port; `server.js`'s changes this phase are limited to moving `initRassilonWorker()` after `ollamaClient` exists and passing it as a provider — nothing related to networking beyond the loopback HTTP surface that already existed.

---

## 21. Strict Local (mission §37)

Tested explicitly this phase: `setRouterSettings({ strict_local_mode: true })`, then submit and complete a full EMBEDDING_BATCH job end-to-end — confirmed `COMPLETED`, zero interaction with `strict-local.js`'s `assertCloudAllowed()` gate at all, because EMBEDDING_BATCH's only network-capable dependency (the local Ollama client) was never a cloud call path to begin with. Cloud calls: **0**, confirmed structurally (no cloud provider import anywhere in `rassilon-embedding.js`) and behaviorally (the test).

---

## 22. Static / privacy audit (mission §51/§52)

Manual and automated grep across every RASSILON source file (12 files, including the new `rassilon-embedding.js`) for `shell:true`, `exec(`, `eval(`, `new Function`, direct `child_process` import, `cmd.exe`, `powershell -Command`, `Invoke-Expression`, `iex`, `bash`, `sh -c`, `download`, `ollama pull`, `npm install`, `pip install`, and (new this phase) any external `http://`/`https://` URL literal — **zero matches** in code, all confirmed by `test-rassilon-static-audit.mjs` (19 tests, up from 13 in Phase 2). Privacy audit (mission §52): input text logs **0** (no logger call exists in `rassilon-embedding.js` at all), vector logs **0** (same), credential access **0**, screen capture **0**, clipboard **0**, keylogging **0** (idle probe returns duration only), filesystem crawl **0** (EMBEDDING_BATCH touches no filesystem) — each confirmed by a dedicated static-audit test, not just asserted in prose.

---

## 23. Test suite

**RASSILON suite total: 213 tests across 12 files — 212 pass, 0 fail, 0 cancelled, 1 skipped (the real-provider smoke test, correctly `NOT_RUN` since no local Ollama instance was reachable in this environment).**

New/expanded files this phase:

| File | Tests | Covers |
|---|---|---|
| `test-rassilon-embedding.mjs` (new) | 15 | Valid batches, provider unavailable/timeout/malformed response, output validation (NaN/Infinity/empty/oversized-dimension rejection), honest cancellation-limitation behavior |
| `test-rassilon-embedding-smoke.mjs` (new) | 1 | Real local-provider smoke test — conditionally skipped (`NOT_RUN`) when no Ollama instance/model is available, never a FAIL |
| `test-rassilon-job-schema.mjs` (+16 tests) | 35 total | EMBEDDING_BATCH payload schema: allowlist, oversized/malformed inputs, security payloads (command/shell/url/path-in-text) |
| `test-rassilon-worker.mjs` (+19 tests) | 42 total | ERROR state (trigger, rejection, disable/kill-always-works, deterministic recovery), SETTINGS_CHANGED audit + no-op suppression, next-job-only mutability (2 tests), EMBEDDING_BATCH end-to-end (valid/failure/replay/signature/mixed-queue/Strict-Local) |
| `test-rassilon-battery-idle.mjs` (+14 tests) | 23 total | AUTO_PAUSED (not manual PAUSED) for every trigger, idle-probe-failure conservative policy, power-probe UNKNOWN-vs-NOT_PRESENT distinction, hysteresis (no-resume-on-1, resume-on-2, counter-reset), manual-pause-never-auto-resumed (2 tests) |
| `test-rassilon-route.mjs` (+3 tests) | 13 total | `PUT /rassilon/settings` valid/invalid/enabled-rejected via HTTP |
| `test-rassilon-static-audit.mjs` (+6 tests) | 19 total | New file coverage, external-URL grep, model-allowlist shape check, 3 privacy-specific tests |
| `test-rassilon-executors.mjs` (updated) | 11 total | Registry-closed assertion updated to the 2-executor Phase 3 ceiling |
| Other 4 files (settings/identity/resources/scratch) | unchanged | Re-run, all still pass — confirms Phase 3 changes didn't disturb Phase 2 behavior |

---

## 24. Regressions

- **Strict Local, Local AI (catalog + routes), MAÎTRE (db + route), OMEGA (identity + route + security)**: 127/127 pass — zero cross-module contamination. Specifically confirms RASSILON's own `strict_local_mode` interaction, the shared `ollamaClient`/`env.EMBEDDING_MODEL` reuse, and the `rassilon-device-key:` secret-store namespace all coexist cleanly with existing code.
- **Full backend suite** (`node --test --test-concurrency=4 test-*.mjs`, 144 files, 2407 individual tests): **2397 pass / 6 fail / 4 skipped / 0 cancelled**. All 6 failures are the **exact same pre-existing, environment-level failures identified and confirmed unrelated to RASSILON at the end of Phase 2** (`test-find-eval.mjs` — Playwright needing the frontend dev server; `test-video-pipeline.mjs` — a `mock.module` Node API/flag mismatch; `test-video-manual.mjs` — a malformed doubled path in that test's own working-directory assumption; `test-regression-api.mjs` — a port-3002 conflict; `checkPortOwnership` ×2 — a pre-existing network-probe timing flake). **Zero RASSILON test appears among the 6 failures**, and the failure count/identity is unchanged from Phase 2's own controlled-concurrency baseline — no new failure was introduced anywhere in the codebase by this phase's changes.

---

## 25. Typecheck / build / server boot

- `npx tsc --noEmit` (repo root, frontend): **PASS**, no output.
- `npm run build`: **PASS**, built in 1.68s, 37 precache entries, same pre-existing chunk-size advisory (unrelated).
- Server smoke boot on a scratch port/SQLite path: **PASS** — `GET /api/rassilon/status` returned `200 {"state":"DISABLED","enabled":false,...,"error":null}` (the new `error` field present and `null` as expected outside `ERROR`), `GET /api/rassilon/settings` returned the full settings object correctly. Zero errors in the boot log. No new listener, no new port, no `EADDRINUSE`. Cleaned up afterward.

---

## 26. Gitignore

Verified, not modified: `cortex-server/data/` (covers the RASSILON scratch workspace) and `data-test-*/`/`cortex-server/data-test-*/` (cover every RASSILON test's temp SQLite DB and scratch directory, including the new `data-test-rassilon-embedding-smoke/`-shaped names should that ever be created) were already wholesale-ignored by the existing rules from Phase 1/2 — no new rule was needed or added. All new `.js`/`.mjs`/`.md` source, test, and report files are trackable and were confirmed present in `git status --short`.

---

## 27. Files changed

**Created**:
```
cortex-server/src/lib/rassilon-embedding.js
cortex-server/test-rassilon-embedding.mjs
cortex-server/test-rassilon-embedding-smoke.mjs
reports/RASSILON_LOCAL_ENRICHMENT_V1_2026-09.md   (this document)
```

**Modified** (all other RASSILON lib files were edited in place; no file was rewritten from scratch):
```
cortex-server/src/lib/rassilon-job-schema.js   — JOB_TYPES now includes EMBEDDING_BATCH;
                                                  added EMBEDDING_MODEL_ALLOWLIST + validateEmbeddingBatchPayload;
                                                  removed a stale unused `crypto` import from Phase 2
cortex-server/src/lib/rassilon-executors.js    — EMBEDDING_BATCH added to the closed EXECUTORS registry;
                                                  runJobExecutor now threads a `providers` object through
cortex-server/src/lib/rassilon-resource-guard.js — getSystemRamStatus/checkAdmission now fail closed on
                                                  telemetry-unavailable (mission §42) rather than assuming "all clear"
cortex-server/src/lib/rassilon-audit.js        — AUDIT_EVENT_TYPES gained AUTO_PAUSED/AUTO_RESUMED/
                                                  WORKER_ERROR/WORKER_RECOVERED; SETTINGS_CHANGED now actually emitted
cortex-server/src/lib/rassilon-worker.js       — largest change: AUTO_PAUSED/ERROR states, hysteresis-gated
                                                  auto-resume, changeRassilonSettings() with audit + next-job-only
                                                  mutability, boot-time registry sanity check, providers threading,
                                                  __forceErrorStateForTests test hook
cortex-server/src/routes/rassilon.js           — PUT /rassilon/settings now calls changeRassilonSettings()
                                                  instead of sqlite.js directly
cortex-server/src/server.js                    — initRassilonWorker() moved after ollamaClient's creation and
                                                  now passes { ollamaClient, embeddingModel: env.EMBEDDING_MODEL }
cortex-server/test-rassilon-job-schema.mjs     — +16 EMBEDDING_BATCH schema/security tests; JOB_TYPES assertion
                                                  updated to the 2-type Phase 3 ceiling
cortex-server/test-rassilon-executors.mjs      — AVAILABLE_EXECUTORS assertion updated to the 2-executor ceiling
cortex-server/test-rassilon-worker.mjs         — +19 tests: ERROR behavior, SETTINGS_CHANGED audit, mutability
                                                  policy, EMBEDDING_BATCH end-to-end (valid/failure/replay/
                                                  signature/mixed-queue/Strict-Local)
cortex-server/test-rassilon-battery-idle.mjs   — rewritten: PAUSED assertions corrected to AUTO_PAUSED;
                                                  +14 tests for hysteresis, idle/power-probe-failure policy,
                                                  manual-pause-never-auto-resumed
cortex-server/test-rassilon-route.mjs          — +3 PUT /rassilon/settings tests
cortex-server/test-rassilon-static-audit.mjs   — +6 tests: new file coverage, external-URL check, privacy audit
```

**Not modified**: `cortex-server/src/lib/sqlite.js` (Phase 3 reused Phase 2's existing `updateRassilonSettings`/ `getRassilonSettings`, no new table/column needed), any OMEGA file, any MAÎTRE file (no real bug was found — mission §1's exception was not invoked), any `omega_*`/`maitre_*`/`monitor_*`/`cyber_*` table, `.gitignore` (already sufficient), `package.json` (zero new dependencies).

---

## 28. Known limitations (Phase 3, honestly scoped)

- **CPU quota for EMBEDDING_BATCH cannot be hard-capped on the Ollama process** — RASSILON has no kernel-level control over a separate local server process; its control is limited to admission-time budget checks and result-discard-on-timeout, never live throttling of Ollama's own CPU usage. Documented directly in code, reflected as PARTIAL below (same posture as Phase 2's own SAFE_CPU_TASK soft guard, now explicitly extended to cover the multi-process reality of EMBEDDING_BATCH).
- **EMBEDDING_BATCH cancellation is between-texts, not mid-request** — `ollama.js`'s `embedText()` has no AbortSignal parameter in this codebase's dependency version; an in-flight single-text request cannot be physically severed, only its eventual result discarded. Disclosed, not claimed as hard cancellation.
- **RAM guard remains whole-process, not per-job-isolated** — unchanged limitation from Phase 2, still true for EMBEDDING_BATCH's own process footprint (Ollama's own memory usage is entirely outside RASSILON's visibility or control, a separate process with its own resource profile).
- **`minimumBatteryPercent` remains scoped to `pauseOnBattery=true` only** — an explicit, documented decision (mission §30), not an oversight; restated in the checkpoint.
- **No real local embedding smoke test ran in this environment** — no Ollama instance was reachable on `localhost:11434` during this phase's test run; the smoke test correctly self-reports `NOT_RUN` rather than a fabricated pass or a false failure, per mission §50's explicit instruction.
- **Issuer registration remains a direct function call, not an HTTP endpoint** — unchanged limitation from Phase 2, explicitly not addressed since mission §35 instructed against adding remote issuer registration in this phase.
- **Auto-resume hysteresis window (2 sweeps ≈ 30-60s) is a chosen default, not empirically tuned** — reasonable and documented, but Phase 3 had no real-world usage data to calibrate against; a future phase could adjust this constant if real usage shows it's too eager or too slow.

None of these limitations weaken any of the mission's zero-tolerance invariants — they are precision/scope limitations of an honestly-described soft-guard, multi-process-aware worker, not security gaps.

---

## DOCTEUR RASSILON PHASE 3 CHECKPOINT

SAFE_CPU_TASK preserved :
PASS

EMBEDDING_BATCH :
PASS

Local embedding only :
PASS

Cloud fallback :
0 attendu — confirmé (aucun chemin cloud dans rassilon-embedding.js, testé sous Strict Local)

Automatic model download :
0 attendu — confirmé (NOT_AVAILABLE sur modèle absent, aucun appel /pull)

Model allowlist :
PASS

Input bounds :
PASS

Output validation :
PASS

Signed jobs :
PASS

Replay protection :
PASS

Executor allowlist :
PASS

Arbitrary shell :
0 attendu — confirmé (grep manuel + test automatisé étendu, aucune occurrence)

Arbitrary executable :
0 attendu — confirmé

Arbitrary code :
0 attendu — confirmé

Crypto mining :
0 attendu — confirmé (enum fermé inchangé, MINING/STRATUM/etc. toujours NOT_SUPPORTED)

Credential access :
0 attendu — confirmé

Screen capture :
0 attendu — confirmé

Keylogging :
0 attendu — confirmé (idle probe : durée uniquement)

Clipboard :
0 attendu — confirmé

Cloud relay :
0 attendu — confirmé

CPU resource guard :
PARTIAL — soft guard inchangé ; limitation honnêtement documentée pour EMBEDDING_BATCH : aucun hard cap possible sur le processus Ollama séparé (contrôle limité à l'admission-time + discard-on-timeout)

RAM resource guard :
PASS — soft guard fonctionnel ; limitation whole-process inchangée, désormais documentée comme s'appliquant uniquement au processus RASSILON lui-même, jamais au processus Ollama séparé

Automatic pause :
PASS

Automatic resume :
PASS — avec hystérésis (2 sweeps sains consécutifs, ~30-60s)

Manual pause never auto-resumes :
PASS

Battery policy :
PASS — décision explicite documentée : minimumBatteryPercent scopé à pauseOnBattery=true uniquement

User idle guard :
PASS — policy conservatrice ajoutée : idle inconnu + pauseWhenUserActive=true → AUTO_PAUSED

ERROR state :
PASS — trigger réel (registry sanity check), comportement complet (no new job, disable/kill toujours actifs, recovery déterministe re-validée)

SETTINGS_CHANGED audit :
PASS — champs modifiés, anciennes/nouvelles valeurs, jamais de secret, jamais d'événement sur no-op

Kill switch :
PASS

Crash recovery :
PASS (inchangé, re-vérifié)

Strict Local :
PASS — testé explicitement avec un job EMBEDDING_BATCH complet sous strict_local_mode=true

Real embedding smoke :
NOT_RUN — aucune instance Ollama locale accessible dans cet environnement ; ce n'est pas un FAIL

RASSILON tests :
212/213

Skipped :
1 (smoke test réel, NOT_RUN attendu et documenté — pas un échec)

Failed :
0

Cancelled :
0

Relevant regressions :
PASS (Strict Local + Local AI + MAÎTRE + OMEGA : 127/127)

Full backend regression :
2397/2407 PASS (144 fichiers, concurrence contrôlée) — 6 échecs, identiques et confirmés pré-existants/environnementaux (Playwright dev server, incompatibilité API mock.module, chemin de test malformé, conflit de port, flake réseau préexistant) ; 0 échec RASSILON parmi ces 6 ; aucune nouvelle régression introduite par cette phase

Typecheck :
PASS

Build :
PASS

Server boot :
PASS

Files changed :
1 nouveau fichier lib (rassilon-embedding.js) + 2 nouveaux fichiers de test + 1 rapport créé ; 9 fichiers RASSILON existants modifiés (job-schema, executors, resource-guard, audit, worker, route, server.js + 5 fichiers de test étendus) ; sqlite.js/.gitignore non touchés (suffisants tels quels) ; 0 fichier OMEGA/MAÎTRE touché ; 0 nouvelle dépendance

Known limitations :
- CPU quota EMBEDDING_BATCH : pas de hard cap possible sur le processus Ollama séparé (documenté honnêtement)
- Cancellation EMBEDDING_BATCH : entre les textes, pas mid-request (limitation du client Ollama existant, documentée)
- RAM guard toujours whole-process, jamais isolé par job, et jamais visible sur le processus Ollama séparé
- minimumBatteryPercent scopé à pauseOnBattery=true uniquement (décision explicite, pas un oversight)
- Smoke test embedding réel non exécuté (aucun Ollama local disponible dans cet environnement) — NOT_RUN documenté, pas un échec
- Issuer registration reste un appel de fonction direct, pas un endpoint HTTP (hors scope Phase 3 par instruction explicite)
- Fenêtre d'hystérésis auto-resume (2 sweeps, ~30-60s) est un défaut raisonnable mais non calibré empiriquement

Verdict :
PASS

Puis STOP.

NE PAS commencer Phase 4.
NE PAS ajouter multi-machine.
NE PAS ajouter LAN.
NE PAS ajouter Internet.
NE PAS ajouter relay.
