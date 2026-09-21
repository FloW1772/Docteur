# MAÎTRE — Future Work Roadmap (V1.1 / V2 / Research)

**Date:** 2026-09-21
**Status:** Documentation only. MAÎTRE V1 remains CERTIFIED / AVAILABLE (see `reports/MAITRE_V1_2026-09.md`) — nothing below is implemented, and nothing below is a blocking bug against V1.
**Scope:** This document extends the existing project Roadmap (`README.md` § Roadmap) with the MAÎTRE-specific backlog identified during MA-12 final certification (§29, "Honest known limitations"). It does not replace the README roadmap; it is the detailed companion document the README links to, following the same pattern already established by `reports/MASTER_PHASE_8_TRAINING_FEASIBILITY.md` for the LoRA/QLoRA roadmap item.

---

## Current V1 certified state (for reference — not re-certified here)

MAÎTRE V1 final verdict: **PASS**. Baseline: MAÎTRE backend 547/547, MAÎTRE browser 27/27, Observateur backend 88/88, Observateur browser 25/25, Cyber Audit backend 272/272, Cyber Audit browser 25/25, typecheck PASS, build PASS. Full detail in `reports/MAITRE_V1_2026-09.md`.

Every item below originates from that report's §29 "Honest known limitations" — this document does not introduce any new limitation; it turns each already-documented limitation into a scoped, prioritized, actionable task.

---

## MAÎTRE V1.1

### 1. Wire MAÎTRE security-event retention scheduler

**Priority:** MEDIUM

**Rationale:** `purgeSecurityEventsOlderThan(days)` already exists in `cortex-server/src/lib/maitre-store.js` but is called by nothing outside its own test (`test-maitre-store.mjs`) — confirmed via repository-wide grep during MA-12. Data in `maitre_events`, and transitively anything referencing it, grows unbounded until this is wired up.

**Prerequisites:**
- Decide the scheduling mechanism consistent with the project's existing local-scheduler conventions (e.g. the pattern already used by `monitor-service.js`'s own interval-based lifecycle, not a new dependency).
- A configurable retention policy (default period, minimum/maximum bounds) — should live alongside other MAÎTRE settings, not invent a second settings surface.

**Safety constraints:**
- Must never block server startup (async/deferred initialization only).
- Cleanup itself must be bounded (batch-limited deletes, not a single unbounded `DELETE`) — mirrors the bounded-query discipline already certified everywhere else in MAÎTRE (MA-12 §22).
- Must be safely stoppable on shutdown (no orphaned timers), matching `monitor-service.js`'s existing `stopMonitorService()` precedent.
- Must never delete an event still referenced by an open (non-`RESOLVED`/`DISMISSED`) incident without an explicit, separate decision — retention of raw events vs. retention of incident-linked evidence should not be conflated by a naive "delete everything older than N days" pass.

**Definition of done:**
- A scheduler (or explicit manual-trigger endpoint, if a scheduler is judged premature) actually invokes `purgeSecurityEventsOlderThan()` on a real cadence.
- Isolated tests confirming: bounded batch size, no startup blocking, clean stop/restart, and that incident-linked evidence is not silently orphaned or corrupted by a purge.
- Documented retention period default and how to change it.

**Target version:** V1.1

---

### 2. Improve IPv6 host-isolation coverage

**Priority:** MEDIUM-HIGH

**Rationale:** V1's `HOST_ISOLATION` IPv6 rules are scoped to global-unicast-only (`2000::/3` and above), which trivially and safely excludes `::1` — but this is a conservative choice, not a precise "all IPv6 except loopback" policy. Link-local (`fe80::/10`) and unique-local (`fc00::/7`) IPv6 traffic is not blocked by the current isolation rules — documented as a known limitation in `reports/MAITRE_V1_2026-09.md` §29 and originally flagged in the MA-10 audit (`reports/MAITRE_MA10_AUDIT_2026-09.md`).

**Prerequisites:**
- A fresh, dedicated audit of Windows Firewall's IPv6 `RemoteAddress` range semantics (the same class of research MA-10 already performed for the current IPv4/v6-global-unicast design — do not assume, verify against current Microsoft documentation as MA-10 did, since this space can change).
- Explicit confirmation of the exact address-set expression needed to cover link-local + unique-local + global-unicast while excluding `::1`, without relying on Allow-over-Block ordering (MA-10's audit already established that ordering is unsafe for this purpose — any new design must respect that finding, not rediscover it the hard way).

**Safety constraints:**
- Must never widen the rule based on assumption alone — MA-10's own governing principle ("if a safe, reversible strategy cannot be proven, mark NOT_SUPPORTED rather than widen scope silently") applies here too.
- `::1` and Docteur's own local access must remain provably preserved by construction, exactly as the IPv4 rules already are — not merely "expected to work."
- Any new rule set must still be MAÎTRE-owned, uniquely named, and fully removable by `RESTORE_HOST_NETWORK` with the same ownership-scoping discipline already certified.

**Definition of done:**
- Updated IPv6 rule construction with a documented, sourced rationale (mirroring `reports/MAITRE_MA10_AUDIT_2026-09.md`'s existing format).
- Mocked-exec test coverage for the new rule shape, matching the rigor of the existing 20 host-isolation tests.
- VM-based validation (see item 5 below) before any claim that the improved IPv6 coverage works on a real machine.

**Target version:** V1.1

---

### 3. Design bounded asynchronous Defender QuickScan

**Priority:** MEDIUM

**Rationale:** V1's `SCAN_WITH_DEFENDER` only supports `CustomScan` against a single explicit file, because `Start-MpScan -ScanType QuickScan` was observed blocking synchronously for its full duration (~50s+ measured during MA-8) — incompatible with a bounded HTTP request/response model. `QuickScan`/`FullScan` are `NOT_SUPPORTED` in V1 for this reason, not because they're unsafe in principle.

**Prerequisites:**
- Audit of Windows Defender's status-polling APIs (`Get-MpComputerStatus`, `Get-MpThreatDetection`, or any documented scan-progress surface) to determine whether a launched scan's state can be observed asynchronously without blocking the launching call.
- A clear background-job identity model: how MAÎTRE identifies and correlates "the scan I started" versus "a scan the user or another tool started," given only one scan can run system-wide at a time (MA-8 already found evidence of this constraint: `MI RESULT 16` = "a scan is already in progress").

**Safety constraints:**
- The launch call itself must still return promptly (never block a Node request thread for 50+ seconds) — this was the entire reason V1 excluded QuickScan/FullScan; any redesign must actually solve that, not just document around it.
- Bounded polling with a hard timeout and a maximum poll count — no unbounded wait loop.
- Explicit cancellation semantics: if a user wants to abandon a QuickScan proposal before it completes, what happens to the already-launched scan (it may not be cancellable via the available API — this must be researched and honestly documented, not assumed).
- One-scan-at-a-time conflict handling must degrade cleanly (the existing `scan_already_running` handling in `defenderScanExecutor` is the precedent to extend, not replace).
- Still goes through the existing PROPOSE→POLICY→APPROVAL→EXECUTE flow — no new bypass.

**Definition of done:**
- A working asynchronous QuickScan path with bounded polling, a defined timeout, and clean status reporting (`RUNNING`/`COMPLETED`/`TIMED_OUT`/`FAILED`), tested with mocked exec.
- FullScan remains explicitly out of scope for this specific item (its duration is even less bounded) — a separate future item if ever pursued.

**Target version:** V1.1

---

### 4. Expand live validation of MAÎTRE local Ollama analyst

**Priority:** MEDIUM / OPTIONAL

**Rationale:** The local analyst's deterministic fallback is exhaustively tested and certified; the structural safety of the Ollama-backed path (schema validation, executable-shape filtering, timeout handling) is also certified. What has **not** been exhaustively tested is output *quality* against a real local model — MA-12 explicitly flagged this as untested rather than claiming false confidence.

**Prerequisites:**
- A small corpus of synthetic incidents spanning MAÎTRE's real event sources (Defender detection, Event Log entry, process observation, file observation, persistence change) with known-reasonable expected analyst output shapes.
- Access to at least one, ideally several, locally-installed Ollama models to validate behavior isn't tied to a single model's quirks.

**Safety constraints:**
- **This is a quality/validation task only — no security-relevant code path changes.** The existing structural guarantees (severity/status immutability, facts-vs-hypotheses separation, executable-suggestion filtering, deterministic fallback on any failure) are not being questioned or reopened here.
- Must not become a pretext to loosen `EXECUTABLE_SHAPE_PATTERN` or any other existing safety filter to "improve" output — if a real model's legitimate output gets over-filtered, that's a tuning question for the filter's precision, handled with the same rigor as the original filter design, not a reason to weaken it.

**Definition of done:**
- Documented test corpus with expected-shape assertions (not exact-text assertions, since LLM output is non-deterministic) covering: hallucination resistance (the model inventing facts not in the provided context), timeout behavior under real model latency, malformed-output resilience, and context-size behavior as incident data grows toward the existing MA-6 bounds (20 events / 10 evidence / 30 timeline entries / 12,000-char prompt cap).
- A short written assessment of observed quality across the models tested — this is inherently qualitative, and should be reported honestly as such, not as a pass/fail gate.

**Target version:** V1.1

---

## Validation environment (prerequisite for any real-world isolation claim)

### 5. Validate HOST_ISOLATION/RESTORE in a disposable Windows VM

**Priority:** HIGH — required before MAÎTRE can honestly claim host isolation has been validated against real Windows Firewall behavior, rather than only against mocked exec + live read-only capability probes.

**Rationale:** MA-10/MA-11/MA-12 all explicitly and correctly never applied a real `HOST_ISOLATION` on any machine, per mission mandate across all three phases. This is the right call for a development machine, but it means the transactional/rollback/loopback-preservation logic has only been validated against mocks. A disposable, snapshotted VM is the appropriate — and only appropriate — environment to close this gap.

**Prerequisites:**
- A disposable Windows VM with a snapshot/restore capability and out-of-band recovery access (i.e., recovery that does not depend on the VM's own network being reachable, since that's exactly what's being tested).
- **Never** the development machine or any machine relied upon for other work, as the first (or any) real-world test environment — this is a hard constraint carried forward from every prior phase's own explicit instruction, not new to this document.

**Safety constraints:**
- Snapshot before every real isolation test run, so a stuck/failed isolation can always be discarded rather than requiring in-VM recovery.
- Confirm out-of-band recovery access actually works *before* the first real isolation test, not after.

**Definition of done — test matrix:**
- Real isolation correctly blocks non-loopback traffic.
- `127.0.0.1`/`::1` and Docteur's own local server access remain reachable throughout.
- A simulated crash mid-isolation (kill the Node process during `applyHostIsolation`) — confirm crash-recovery detection (`detectActiveIsolationOnStartup()`) correctly reports the state on next start, without auto-restoring.
- A simulated partial-apply failure on real hardware (not just mocked) — confirm rollback behavior matches the certified mocked behavior.
- Full restore removes exactly the MAÎTRE-owned rules, verified via `Get-NetFirewallRule` inside the VM.
- Restore called twice — confirm idempotent `ALREADY_RESTORED`.
- Reboot while isolated — confirm the isolation state (and, separately, whether the actual firewall rules) survive a reboot, and that `detectActiveIsolationOnStartup()` still correctly reports it afterward without auto-restoring.

**Target version:** Validation milestone, not tied to a specific MAÎTRE version — this closes an existing V1 limitation rather than adding new scope, but is listed separately since it's an environment/process undertaking, not a code change.

---

## Research only (no committed timeline)

### 6. Re-evaluate safe Defender quarantine targeting

**Priority:** RESEARCH ONLY

**Rationale:** `QUARANTINE_WITH_DEFENDER` is `NOT_SUPPORTED` in V1 because `Remove-MpThreat` — the only Defender remediation cmdlet found during MA-9's real-machine audit — has no per-detection targeting parameter: it remediates ALL active threats system-wide, with no way to scope to the one detection a user approved. Widening MAÎTRE's action surface to a "remediate everything" operation disguised as a targeted action would be a genuine security regression, not a feature.

**Future activation condition (all of the following, not any one):**
- exact detection identity (a stable identifier for the specific detection being acted on, not just a file path);
- exact resource binding (proof the remediation call will only affect the identified detection);
- deterministic scope (no ambiguity about what else might be affected);
- TOCTOU revalidation (the detection must still be present and unchanged at execution time, matching every other MAÎTRE executor's existing discipline);
- an auditable result (confirmation of exactly what was remediated, not just "it succeeded").

**If no such API/interface exists:** `QUARANTINE_WITH_DEFENDER` remains `NOT_SUPPORTED` indefinitely. This is an acceptable, permanent V1 state, not a gap requiring a workaround.

**Definition of done (research phase only):** A documented, sourced finding on whether a sufficiently precise Windows Defender API exists today (Microsoft's own documentation, WMI/CIM classes, or a newer PowerShell module surface not available during MA-9's original audit). If found, a follow-up implementation item would be scoped separately — this item itself produces a research report, not code.

**Target version:** Research only — no version commitment.

---

## MAÎTRE V2

### 7. macOS/Linux defensive incident-response adapters

**Priority:** V2

**Rationale:** MAÎTRE is Windows-first by design — every inspector/executor in V1 (process, persistence, Defender, firewall, event log) uses Windows-specific APIs (WMI, PowerShell, Windows Event Log, Windows Firewall, Windows Defender). This is an intentional, correctly-scoped V1 boundary, not an oversight — the mission explicitly warns against prematurely abstracting V1 for a cross-platform future that doesn't yet exist.

**Future architecture direction:** common MAÎTRE models (`maitre-models.js`'s `SecurityEvent`/`Incident`/`Evidence` shapes, the policy/approval/execution state machine) are already platform-agnostic by construction — they contain no OS-specific assumption. The adapter/executor layer (`maitre-process-inspector.js`, `maitre-persistence-inspector.js`, `maitre-defender-adapter.js`, `maitre-eventlog-adapter.js`, and the OS-touching parts of `maitre-executor.js`) is where platform-specific implementations would need to be added, following a common interface each platform adapter implements.

**Explicitly not in scope even for V2:** inventing a single "universal" security API that doesn't reflect real OS differences (e.g., macOS has no direct Windows Defender equivalent — a macOS adapter would need to target Gatekeeper/XProtect/EndpointSecurity honestly, not pretend feature parity that doesn't exist).

**Target version:** V2.

---

### 8. Advanced kernel/driver security visibility

**Priority:** V2 / RESEARCH

**Rationale:** V1 operates entirely at the user-mode Windows API level. This is an explicit, permanent scope boundary for a custom-built security surface, not a temporary gap to be closed by building a kernel component.

**Research areas (documented Windows APIs only):**
- signed driver inventory (enumerable via existing, documented Windows mechanisms);
- driver reputation metadata (where a documented, official source exists);
- kernel event visibility via ETW (Event Tracing for Windows) or other fully-documented, officially-supported Windows telemetry surfaces — never an undocumented hook;
- vulnerable-driver awareness (e.g., cross-referencing against Microsoft's own published vulnerable-driver blocklist, if a usable local/offline form exists);
- deeper Windows Defender / ETW integration possibilities beyond what V1 already uses.

**Explicitly and permanently out of scope:**
- a custom rootkit scanner;
- a Docteur-authored kernel driver;
- kernel injection of any kind;
- undocumented Windows hooks or APIs.

MAÎTRE must never claim kernel-level antivirus/EDR capability it does not have — this constraint is permanent, not just a V1-era caveat, and any V2 work here must preserve the same "document real user-mode API capability honestly, never oversell" discipline that governed V1.

**Target version:** V2 / Research.

---

### 9. Advanced forensic evidence workflow

**Priority:** V2 / OPTIONAL

**Rationale:** V1's evidence integrity mechanism (SHA-256 hashing via `computeEvidenceIntegrityHash()`) exists for tamper-evidence and deduplication purposes only, and is explicitly documented as such — it is not, and must never be marketed as, a legally certified forensic chain-of-custody mechanism, which requires a fundamentally different architecture (signed, timestamped, access-logged, legally-admissible evidence handling that V1 makes no attempt at).

**Future possibilities (all optional, none committed):**
- stronger evidence manifests (structured metadata beyond the current bounded/redacted JSON blob);
- immutable export bundles (a way to export an incident's full evidence set as a self-contained, tamper-evident package);
- timestamp provenance (stronger guarantees about when evidence was actually collected, versus when it was recorded);
- evidence export functionality (currently, evidence is viewable in Studio but has no dedicated export path);
- hash manifests covering an entire incident package, not just individual evidence rows;
- incident packages (a bundled export of incident + events + evidence + timeline + analyst output, for handoff to a human investigator or another tool).

**Non-negotiable framing constraint for any future work here:** every artifact this produces must be labeled, in its own UI and documentation, as **forensic-assistance**, explicitly distinct from **legally certified chain-of-custody** — the two are not the same thing, and conflating them would be a materially misleading claim about what Docteur/MAÎTRE provides.

**Target version:** V2 / Optional.

---

## Explicitly excluded from this roadmap (permanent exclusions, not deferred items)

The following are **not** future MAÎTRE work at any version — they are excluded on security-design grounds, not scheduling grounds, and re-raising them should be treated as a proposal to weaken MAÎTRE's core security model, not a normal backlog item:

- automatic remediation of "everything suspicious" without human approval;
- automatic host isolation without human approval;
- a custom kernel rootkit scanner or kernel driver;
- a stealth/hidden agent of any kind;
- antivirus bypass functionality;
- hidden or automatic privilege escalation;
- an arbitrary/generic shell command executor;
- offensive exploitation capability;
- autonomous cloud-based remediation (MAÎTRE's entire value proposition includes working fully offline/Strict-Local — a cloud remediation dependency would contradict that).

---

## Priority summary

| # | Task | Priority | Version |
|---|---|---|---|
| 1 | Retention scheduler | MEDIUM | V1.1 |
| 2 | IPv6 isolation refinement | MEDIUM-HIGH | V1.1 |
| 3 | Async Defender QuickScan | MEDIUM | V1.1 |
| 4 | Ollama analyst live validation | MEDIUM / OPTIONAL | V1.1 |
| 5 | Host-isolation VM certification | HIGH (blocks any real-world isolation claim) | Validation milestone |
| 6 | Defender quarantine targeting re-evaluation | RESEARCH ONLY | Research |
| 7 | Cross-platform adapters | — | V2 |
| 8 | Kernel/driver visibility research | — | V2 / Research |
| 9 | Advanced forensic workflow | — | V2 / Optional |

This ordering matches the mission's own recommended priority. It can be adjusted if a future audit surfaces a dependency between items not visible today (e.g., item 2's IPv6 refinement logically depends on item 5's VM environment existing before it can be honestly claimed "validated," even though it's drafted/designed at V1.1 — the VM environment is the gating validation step for both item 2 and the original V1 IPv6 scope, not just new V2 claims).

---

## Feature Registry note

MAÎTRE's `HELP_DIRECTORY` entry (`src/content/capabilities.ts`) was checked during this audit: `FeatureState` is a closed union (`'disponible' | 'local' | 'a_configurer' | 'partiel'`) with no `'PLANNED'` or equivalent future-work status, and `featureRegistry.ts`'s derived `status` field has no such value either. Per this mission's own instruction, **the Feature Registry was not modified** — none of the items in this document are described as available, planned, or otherwise present in Help Center, Search, Command Bar Explain, or Voice Explain. MAÎTRE continues to be described there exactly as it exists in V1, nothing more.
