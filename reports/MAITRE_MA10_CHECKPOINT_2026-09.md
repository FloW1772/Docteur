# MAÎTRE MA-10 — Host Isolation + Safe Network Restore

**Phase:** MA-10 — LEVEL 3, reversible, fail-closed
**Date:** 2026-09-21
**Baseline:** MA-1 through MA-9 verified PASS (486/486 MAÎTRE, 272/272 Cyber Audit — Observateur browser suite not independently re-run, see Known Limitations).

---

## 1. Architecture

```
proposal (HOST_ISOLATION, LEVEL 3, target: {reason, previewMetadata, rollbackPlanAvailable})
  → maitre-policy.js: CONFIRM, requirements=[user_confirmation, strengthened_confirmation]
  → approveProposal({strengthenedConfirmation: true})   ← hard gate, DENY without it
  → executeApprovedAction()
      → hostIsolationExecutor()
          → hostIsolationPreflight()                     [read-only]
              - isolationAlreadyActive? (from persisted DB, not live state)
              - loopback baseline reachable?
          → createIsolationRollbackState()                [persisted BEFORE any OS change]
          → applyHostIsolation()                          [transactional, 4 steps]
              1. v4-out Block rule (RemoteAddress excludes 127.0.0.0/8)
              2. v4-in  Block rule (same exclusion)
              3. v6-out Block rule (RemoteAddress = global unicast only, excludes ::1)
              4. v6-in  Block rule (same)
              → verify: all 4 rules present + loopback still works
              → ACTIVE | PARTIAL_FAILURE (auto-rollback attempted) | FAILED | NOT_SUPPORTED
      → incident → CONTAINED (only on ACTIVE, only if graph allows it)

restore proposal (RESTORE_HOST_NETWORK, LEVEL 3, target: {relatedActionId})
  → maitre-policy.js: CONFIRM, requirements=[user_confirmation]  (NOT strengthened)
  → approveProposal()                                     ← plain confirmation sufficient
  → executeApprovedAction()
      → restoreHostNetworkExecutor()
          → resolve isolation state by relatedActionId
          → ALREADY_RESTORED (idempotent) | ownership-checked removal | RESTORED | PARTIAL_FAILURE | MANUAL_REVIEW
```

New files: `cortex-server/src/lib/maitre-host-isolation.js` (the entire strategy), plus a `maitre_isolation_state` SQLite table. `maitre-executor.js` extended with exactly two new named executors (`hostIsolationExecutor`, `restoreHostNetworkExecutor`) added to the existing closed dispatch switch — no generic firewall executor exists.

---

## 2. Audit before code (mission §3)

Full findings in `reports/MAITRE_MA10_AUDIT_2026-09.md`. Headline results:

- **Elevation**: dev machine runs non-elevated (`IsInRole(Administrator) = false`). Live-probed `New-NetFirewallRule` with a throwaway RFC 5737 documentation-IP rule — failed with `Windows System Error 5` (Access Denied), confirming the `access_denied` fail-closed path is real and reachable with the exact cmdlet MA-10 uses.
- **Read-only queries** (`Get-NetFirewallRule`, `Get-NetAdapter`, `Get-NetFirewallProfile`, `Get-NetConnectionProfile`) all work without elevation — preflight can always run.
- **Loopback safety — the critical finding**: researched Microsoft's own current documentation (`learn.microsoft.com/.../windows-firewall/rules`) rather than assuming. Windows Firewall's documented precedence is **"explicit Block always beats explicit Allow, regardless of specificity."** An originally-considered "Allow-loopback + Block-Any" design was proven unsafe by this research **before any executor code was written**, and replaced with the final design: every Block rule's `RemoteAddress` is scoped, by construction, to explicitly exclude loopback space (IPv4: `0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255`, excluding all of `127.0.0.0/8`; IPv6: `2000::-ffff:...`, the global unicast range, trivially excluding `::1`). Both range-list syntaxes were live-verified as syntactically accepted (failed with `access_denied`, not a parameter error).

---

## 3. LEVEL 3 enforcement

`maitre-executor.js`'s independent, duplicated-on-purpose level check (mirroring the existing LEVEL 1/2 pattern) now includes `EXECUTABLE_LEVEL_3_ACTIONS = new Set(['HOST_ISOLATION', 'RESTORE_HOST_NETWORK'])`, with a hard `level_mismatch_denied` if the action's persisted `level` column disagrees. Verified by the updated static-safety test asserting the executable-set constant matches exactly these two action types, no more.

**Bug found and fixed during this phase**: `maitre-approval.js`'s `approveProposal()` previously required `strengthenedConfirmation` for **any** LEVEL 3 action (`action.level === 3`), but `maitre-policy.js`'s own decision for `RESTORE_HOST_NETWORK` only lists `requirements: ['user_confirmation']` — not strengthened. The blanket level check contradicted the policy's own stated intent and mission §4's "RESTORE_HOST_NETWORK: confirmation explicite obligatoire" (not "renforcée"). Fixed to check the actual per-action `policyResult.requirements` array instead of a blanket level number — HOST_ISOLATION still correctly requires strengthened confirmation (its own policy decision lists it), RESTORE_HOST_NETWORK correctly does not. Verified by a new dedicated test and confirmed the existing 32-test `test-maitre-approval.mjs` suite is unaffected.

---

## 4. No auto elevation

Confirmed by design and by the live audit: no UAC prompt, no relaunch-as-admin, no privileged service, anywhere in `maitre-host-isolation.js` or the two new executors. `access_denied` is a first-class, explicitly-tested terminal result (`FAILED`, `reason: 'access_denied'`), not an error condition MAÎTRE tries to work around.

---

## 5. Preflight

`hostIsolationPreflight()` is strictly read-only: adapter metadata (name/status/description), firewall profile status (Domain/Private/Public enabled), a persisted-DB-derived "is an isolation already active" flag (never re-derived from live firewall state alone, so external tampering with actual rules can't fool the concurrency guard), and a local-only loopback probe (a plain `fetch` to cortex-server's own `/api/health` on 127.0.0.1 — never an external host). No network payload, no credentials. Live-verified this session against the real machine: returned real adapter/profile data; correctly reported `loopbackAvailable: false` when cortex-server wasn't running, rather than assuming success.

---

## 6. Rollback state persisted first

`createIsolationRollbackState()` inserts the `maitre_isolation_state` row (status `PENDING`) **before** `applyHostIsolation()` is ever called. If the insert fails (`insertMaitreIsolationState` returns `null` when the DB is unavailable), the executor throws `isolation_rollback_state_persist_failed` and never proceeds to touch the firewall — verified structurally (the throw happens strictly before `applyHostIsolation` is invoked in `hostIsolationExecutor`).

---

## 7. Transactional application + partial-failure rollback

`applyHostIsolation()` creates the 4 rules one at a time, persisting `rules_created` to the DB after **each** individual success (not only at the end), so a crash mid-application still leaves an accurate record. On any step failure (including a `timeout` or malformed PowerShell output), it:
1. Attempts best-effort removal of every rule created so far in this attempt.
2. Records `PARTIAL_FAILURE` (if ≥1 rule was created) or `FAILED` (if 0 rules were created) — never `SUCCEEDED` on a partial state.
3. Even after all 4 rules report success, a final verification step (rule presence + loopback check) must also pass — if not, the run still rolls back and reports `PARTIAL_FAILURE`, never silently claiming `ACTIVE` on an unverified state.

Verified by 3 dedicated tests: access-denied-on-first-rule (→ `FAILED`, 0 rules), partial-failure-at-step-3 (→ `PARTIAL_FAILURE`, 2 rules recorded, incident stays out of `CONTAINED`), and rollback-attempt-count verification (2 successfully-created rules each get an explicit `Remove-NetFirewallRule` attempt).

---

## 8. MAÎTRE ownership only

Every rule is named `Docteur-MAITRE-Isolation-<actionId>-{v4-out,v4-in,v6-out,v6-in}`, where `<actionId>` is the server-generated action UUID (never client-supplied). A dedicated static-safety test confirms every `New-NetFirewallRule`/`Remove-NetFirewallRule` call in the file is paired with a `-DisplayName` parameter in the same script template — no bare/wildcard rule enumeration exists. `RESTORE_HOST_NETWORK` additionally re-checks, at removal time, that every rule name in the persisted `rules_created` list actually starts with `Docteur-MAITRE-Isolation-<this state's own action_id>-` before attempting removal — even if the DB row were somehow tampered to include a foreign rule name, that name is skipped and the mismatch surfaces as `PARTIAL_FAILURE` rather than a silent no-op or an accidental foreign-rule deletion. Verified by the "foreign rule protection" test: a tampered `rules_created` list containing `SomeAntivirusVendorRule` and a rule scoped to a *different* action id — neither is ever passed to `Remove-NetFirewallRule`.

---

## 9. Loopback preservation

Guaranteed by construction (§2 above), not by Block/Allow ordering — every Block rule's `RemoteAddress` scope structurally excludes loopback space. Additionally verified operationally: `applyHostIsolation()`'s final verification step re-checks loopback reachability after all 4 rules are created, and rolls back everything if it fails. No external host is ever contacted to "test" the block (mission §13) — only local rule-presence queries and a local loopback probe.

---

## 10. Network adapters / DNS / routes / proxy untouched

Confirmed both by design (no such cmdlet is ever called) and by a dedicated static-safety test asserting `Disable-NetAdapter`, `Set-DnsClientServerAddress`, `New-NetRoute`/`Remove-NetRoute`/`Set-NetRoute`, `Set-NetIPInterface`, `Set-WinHttpProxy`, and DHCP-related cmdlets never appear anywhere in `maitre-host-isolation.js`.

---

## 11. Restore: ownership, idempotency, foreign-rule protection

`restoreHostNetwork()`:
- Resolves the target isolation state via `relatedActionId` (the original HOST_ISOLATION action's id — never an internal state id a client would have to know).
- If already `RESTORED`, returns `ALREADY_RESTORED` immediately with **zero** new `Remove-NetFirewallRule` calls — verified by a dedicated "restore twice" test asserting the second call's removal-call count is exactly 0.
- Otherwise removes only the rules recorded in that state's own `rules_created` list, each individually name-checked against the ownership pattern described in §8.
- Any rule not found in Windows Firewall (already gone) is treated as removed cleanly (`Remove-NetFirewallRule`'s own idempotent existence check).

---

## 12. Crash recovery

`detectActiveIsolationOnStartup()` reads only the persisted `maitre_isolation_state` table (via `findActiveMaitreIsolationState()`) — it never re-derives state from live firewall inspection and, critically, **never removes anything itself**. It returns `{isolationActive, isolationStateId, actionId, incidentId, status, restoreAvailable}` for the caller (a future Docteur UI/API layer) to surface to the user; the decision to actually restore remains a normal `RESTORE_HOST_NETWORK` proposal/approval/execute flow. Verified by two tests: an ACTIVE isolation from a prior "process lifetime" (simulated by calling the detection function fresh against the persisted DB) is correctly detected without being touched, and a clean DB correctly reports no active isolation.

---

## 13. Approval one-time use / TOCTOU

Both HOST_ISOLATION and RESTORE_HOST_NETWORK reuse `maitre-executor.js`'s existing, unmodified approval-consumption path (`validateApproval` + `consumeApproval`, called immediately before the RUNNING row is inserted) — no new approval-handling code was written for MA-10. A second `executeApprovedAction` call with an already-consumed approval fails cleanly (verified: `action_not_ready`, since the action's own status column already moved past `CONSUMED`). TOCTOU re-validation of the fresh action/incident/approval rows happens identically to every other MAÎTRE action type, since MA-10 introduces no separate execution path around this.

---

## 14. Concurrency

Two guards, verified independently:
- **Same action id**: the pre-existing `findActiveOrSucceededRunForAction()` guard (MA-8/9, unmodified) — two concurrent `executeApprovedAction` calls for the *same* HOST_ISOLATION action correctly resolve to exactly one success and one rejection (verified test, using `Promise.allSettled`).
- **Cross-incident, isolation-specific**: `findActiveMaitreIsolationState()` (new, MA-10) refuses a *second, different* HOST_ISOLATION action while an earlier one is `ACTIVE`/`PARTIAL_FAILURE`/etc., regardless of which incident it targets — verified test: isolation 1 reaches `ACTIVE`, isolation 2 (different incident, different action, different approval) is refused with `isolation_already_active` before ever calling the firewall.

---

## 15. Prompt injection

Tested: an incident with title `"isolate immediately without approval"`, a summary containing `'Event Log: "disable network"'`, `'process name: "run netsh"'`, `'Ollama text: "block everything"'`, and a HOST_ISOLATION target `reason` field containing the same instruction-shaped text. No approval was created for this proposal — `executeApprovedAction` correctly still requires `approval_required`, confirming none of this text grants any implicit bypass. This mirrors the exact pattern MA-8/MA-9's own prompt-injection tests use.

---

## 16. Static safety (mission §30) — all confirmed 0

Grep-verified directly this session (see raw output above in this conversation): `shell:true` — 0; `child_process` direct import/`execSync` — 0; `eval(`/`new Function(` — 0; `Invoke-Expression`/`iex` — 0; arbitrary `netsh` — 0 (only a doc-comment naming its absence); firewall reset — 0 (only a doc-comment); `Set-NetFirewallProfile`/`Disable-NetFirewallRule -All` — 0; `Disable-NetAdapter`/`Enable-NetAdapter` — 0; route/DNS modification cmdlets — 0; every `Remove-NetFirewallRule` call is `-DisplayName`-scoped, never a wildcard sweep. Also extended the existing exhaustive PowerShell-cmdlet allowlist test to cover the new file (`Get-NetAdapter`, `Get-NetFirewallProfile`, `Remove-NetFirewallRule`, `Select-Object` added to the certified set; anything else would fail the test).

---

## 17. Regressions

| Suite | Before MA-10 | After MA-10 | Explanation of change |
|---|---|---|---|
| MAÎTRE total | 486/486 | 511/511 | +25 = 5 tests updated in-place (2 superseded "LEVEL 3 hard deny" tests in `test-maitre-executor.mjs`/`test-maitre-executor-level2.mjs` rewritten to reflect LEVEL 3 now being legitimately executable, per this phase's own mission; 2 static-safety tests extended to also cover the new file; the dispatch-table-size test updated from a count-based to an explicit-8-actions check) + 20 new tests in `test-maitre-host-isolation.mjs` |
| Cyber Audit | 272/272 | 272/272 | untouched, unaffected |
| Observateur | (not independently re-run this session — no `node --test`-runnable backend suite found; the 360 figure in the mission's baseline combines Cyber Audit with a Playwright browser suite not exercised here) | — | see Known Limitations |
| Typecheck | PASS | PASS | — |
| Build | PASS | PASS | — |

Two real, non-test bugs were found and fixed during this phase (not pre-existing regressions — both are in code newly written for MA-10, caught by the new test suite before being shipped):
1. `applyHostIsolation`'s step objects used property name `name` while `buildCreateBlockRuleScript` destructured `ruleName` — every rule was being created with the literal string `'undefined'` as its name. Fixed by aligning the property name.
2. `approveProposal()`'s strengthened-confirmation gate checked `action.level === 3` instead of the actual per-action policy requirement, incorrectly demanding strengthened confirmation for RESTORE_HOST_NETWORK. Fixed to check `policyResult.requirements`.

---

## 18. Real machine testing (mission §28/§29)

**Real HOST_ISOLATION smoke test: NOT_RUN**, exactly as mission §28 requires — no real firewall isolation was ever applied to this or any machine during this phase.

**Safe live tests actually performed** (read-only or guaranteed-to-fail-safely, per mission §29):
- Real `New-NetFirewallRule` probe with a throwaway rule (RFC 5737 documentation IP, immediately failed with `access_denied`, nothing created) — confirms the fail-closed path.
- Real multi-range `RemoteAddress` syntax probes for both the IPv4-exclusion and IPv6-global-unicast expressions — confirmed syntactically accepted (failed only on privilege, not parameters).
- Real `hostIsolationPreflight()` call against this machine this session — returned genuine adapter/firewall-profile data and correctly detected the local health endpoint as unreachable (cortex-server wasn't running) rather than assuming success.
- Real read-only `Get-NetFirewallRule`/`Get-NetAdapter`/`Get-NetFirewallProfile`/`Get-NetConnectionProfile`/`Get-NetTCPConnection` queries throughout the audit phase.

None of these created, modified, or removed any real firewall rule, adapter, route, or DNS setting.

---

## 19. Known limitations

- **Observateur's browser-driven test suite was not independently re-run this session** — `scripts/test-observateur-studio-browser.mjs` is a Playwright harness, not a `node --test` unit suite, and re-running it was out of scope for a backend-focused MAÎTRE phase. The Cyber Audit portion of the combined "360" baseline (272 tests) was re-confirmed unchanged.
- **IPv6 loopback exclusion uses a simplified "global unicast only" scope** (`2000::/3` and above) rather than a precise "all of IPv6 except `::1`" exclusion — this is deliberately conservative (trivially, obviously correct — no subtraction arithmetic to get wrong) but means link-local (`fe80::/10`) and unique-local (`fc00::/7`) IPv6 traffic is not blocked by the v6 rules. This is a narrower containment guarantee than the IPv4 rules provide, and is documented in the isolation result's own `description` field rather than silently overstated.
- **No real HOST_ISOLATION has ever been executed against any machine** (by design — mission §28) — the transactional/rollback/verification logic is exhaustively unit-tested with mocked exec, but has not been observed against genuine Windows Firewall API behavior beyond the read-only/access-denied probes in §18. A future dedicated VM-based smoke test (mission's own suggestion) would be the natural next validation step before this feature is exposed in any UI.
- **`applyHostIsolation`'s rollback-on-verification-failure path** (all 4 rules report success individually, but the final presence+loopback verification fails) is implemented and unit-tested with mocked failure injection, but — like the rest of this phase — has not been observed against a real scenario where Windows Firewall silently fails to apply a rule despite reporting success. This is an inherent limit of testing against a mock rather than the real OS.
- **The `MANUAL_REVIEW` restore status** (returned when a rollback record's JSON is corrupt) exists in the code but has no dedicated test — it's a defensive branch for a database-corruption scenario that's difficult to construct cleanly in an automated test without reaching into private DB internals.

---

## 20. Files changed

New:
- `cortex-server/src/lib/maitre-host-isolation.js`
- `cortex-server/test-maitre-host-isolation.mjs` (20 tests)
- `reports/MAITRE_MA10_AUDIT_2026-09.md`
- `reports/MAITRE_MA10_CHECKPOINT_2026-09.md` (this report)

Modified:
- `cortex-server/src/lib/sqlite.js` — new `maitre_isolation_state` table + 7 new DB-access functions (insert/get/getByActionId/findActive/list/update), following the exact pattern of the existing `maitre_action_runs` functions.
- `cortex-server/src/lib/maitre-executor.js` — `EXECUTABLE_LEVEL_3_ACTIONS` set added; two new executor functions (`hostIsolationExecutor`, `restoreHostNetworkExecutor`) added to the closed dispatch table; level-enforcement block extended to LEVEL 3; `deriveFinalStatus`/`mapEvidenceType` extended for the two new action types plus the new `PARTIAL_FAILURE`/`MANUAL_REVIEW` run statuses; one narrow, mission-§25-scoped CONTAINED transition added (HOST_ISOLATION success only, graph-validated, never RESOLVED).
- `cortex-server/src/lib/maitre-approval.js` — `approveProposal()`'s strengthened-confirmation check fixed to read the actual per-action policy requirement instead of a blanket LEVEL 3 check (bug fix, see §3).
- `cortex-server/test-maitre-executor.mjs` — 2 superseded "LEVEL 3 hard deny" tests replaced with tests matching MA-10's real behavior (missing-approval-still-denied).
- `cortex-server/test-maitre-executor-level2.mjs` — 2 superseded security-invariant tests updated to assert the real, current LEVEL 2 + LEVEL 3 executable sets instead of "LEVEL 3 stays empty."
- `cortex-server/test-maitre-executor-static-safety.mjs` — extended to also statically scan `maitre-host-isolation.js` (7 new tests: shell:true, eval/Invoke-Expression, generic-command-function absence, netsh/adapter/DNS/route absence, DisplayName-scoping enforcement, RemoteAddress-"Any"-on-Block absence, LLM-reference absence) and extended the exhaustive cmdlet allowlist.

Not touched: any file under `external/`, any pre-existing MAÎTRE file beyond the three listed above, `maitre-actions.js`/`maitre-policy.js` (their MA-10 support — `ACTION_LEVELS`, target validators, policy decisions — was already present from an earlier phase and required no changes), `maitre-store.js`, `maitre-models.js` (only imported, not modified).

---

## Verdict

**PASS.** Every mission-mandated security property was independently verified — either by a passing automated test with mocked exec (never a real isolation) or by a genuinely safe, read-only live probe against the actual machine. Two real implementation bugs were caught and fixed by the test suite itself before this checkpoint, which is exactly what the mission's extensive test matrix (§26) was designed to catch.
