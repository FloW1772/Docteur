# MAÎTRE MA-10 — Pre-Implementation Audit: Host Isolation Firewall Strategy

**Date:** 2026-09-21
**Scope:** mission §3 — audit Windows firewall interfaces before writing any HOST_ISOLATION/RESTORE_HOST_NETWORK code.

---

## 1. Elevation status on this dev machine

```
whoami: flow1
IsInRole(Administrator): False
```

**Finding:** the dev machine is running non-elevated. `New-NetFirewallRule` (the same cmdlet MA-9's `BLOCK_REMOTE_IP` already uses) was probed live with a throwaway rule targeting an RFC 5737 TEST-NET-3 documentation-only address (`203.0.113.1`, never a real host) and failed:

```json
{"ok":false,"message":"Accès refusé. ","errorId":"Windows System Error 5,New-NetFirewallRule"}
```

Since the call failed before creating anything, there was nothing to clean up. This confirms the `access_denied` path (mission §5/§6: "insufficient privileges → FAILED, reason = access_denied, this is a valid result") is real and reachable on this exact machine, using the exact cmdlet MA-10 will call. **MA-10's executors will correctly fail closed with `access_denied` when run non-elevated, matching MA-9's existing `BLOCK_REMOTE_IP` behavior** — no new elevation logic was needed or added, and no UAC prompt, relaunch, or privilege-bypass exists anywhere in this phase (mission §5).

## 2. Read-only firewall/network queries work without elevation

Confirmed live, all succeeded non-elevated:
- `Get-NetFirewallProfile` → returns Domain/Private/Public profile enabled status.
- `Get-NetFirewallRule -DisplayName 'Docteur-MAITRE-*'` → returns matching rules (0 found, as expected pre-MA-10).
- `Get-NetAdapter` → returns adapter name/status/description.
- `Get-NetConnectionProfile` → returns active connection's `NetworkCategory`/`IPv4Connectivity`.
- `Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen` → returns current loopback listeners (Docteur's own cortex-server and Vite dev server ports were visible).

**Conclusion:** preflight (mission §6) can always run, even without admin rights, since it is entirely read-only. Only the mutating isolation step itself requires elevation and can fail closed.

## 3. Loopback safety — this is the critical finding of this audit

**Initial assumption to be tested:** could an outbound Block rule scoped to `RemoteAddress Any`, paired with a higher-priority Allow rule scoped to `RemoteAddress 127.0.0.1,::1`, reliably keep loopback alive?

**Researched against Microsoft's own current documentation** (`learn.microsoft.com/.../windows-firewall/rules`, "Rule precedence for inbound and outbound rules") rather than assumed:

> 1. Explicitly defined allow rules take precedence over the default block setting.
> 2. Explicit block rules take precedence over any conflicting allow rules.
> 3. More specific rules take precedence over less specific rules, **except if there are explicit block rules as mentioned in 2**.

**This is unconditional: an explicit Block rule always beats an explicit Allow rule, regardless of how specific the Allow rule is.** A narrow "Allow loopback" rule would NOT protect loopback against a broad "Block Any" rule. This directly contradicts the initially-considered Allow+Block design — which was never implemented, caught during audit before any code was written.

**Also researched:** whether loopback traffic is architecturally exempt from WFP's ALE outbound/inbound filtering layers regardless of rule content. It is not — Microsoft's own WFP API documentation defines `FWP_CONDITION_FLAG_IS_LOOPBACK`, usable specifically at the `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6` layer (the layer outbound block rules are enforced at), whose entire purpose is to let a filter distinguish loopback traffic during normal classification — which is only meaningful if loopback traffic passes through the same generic classification pipeline as any other connection. Independent technical analysis (Gary Nebbett's WFP/Windows Service Hardening research) documents a concrete case of a generic block filter actually dropping loopback-destined traffic. **There is no general, reliable, undocumented loopback exemption to rely on.**

### Safe strategy adopted

**Never author a "Block Any" rule.** Every MAÎTRE isolation Block rule's `RemoteAddress` is scoped, by construction, to explicitly exclude loopback space — so the rule structurally cannot match loopback traffic in the first place, regardless of Block/Allow precedence semantics:

- **IPv4:** `RemoteAddress = '0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255'` — every IPv4 address except the entire `127.0.0.0/8` loopback block. Live-verified this session: the cmdlet accepted this exact multi-range syntax (probe failed with `access_denied`, not a parameter/syntax error, confirming the range list itself parsed correctly).
- **IPv6:** `RemoteAddress = '2000::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'` — scoped to the IPv6 global unicast range (`2000::/3` and above), which trivially and unambiguously excludes `::1` (in `::/128`) without needing an error-prone subtraction expression. Live-verified: same syntax-accepted, access-denied-on-privilege result.

This design needs no reliance on Allow-over-Block ordering, no reliance on an unverified WFP loopback exemption, and is simple enough to hand-verify for gaps (the excluded range is exactly and only `127.0.0.0/8` for v4, and loopback `::1` is trivially outside the v4-style-simplified v6 global-unicast scope chosen for v6).

**Post-application verification (mission §13):** after creating the rules, MA-10 explicitly re-tests that a local loopback HTTP call to Docteur's own cortex-server (already running, already listening on 127.0.0.1) still succeeds, and that the expected MAÎTRE rules are present via `Get-NetFirewallRule`. It never contacts an external Internet host to "test" the block (mission §13 explicit prohibition) — the block's existence is verified by rule presence, not by attempting and observing an external connection.

## 4. MAÎTRE rule ownership / identification

Following `BLOCK_REMOTE_IP`'s existing precedent exactly: every rule created by `HOST_ISOLATION` is named `Docteur-MAITRE-Isolation-<actionId>-<suffix>` (e.g. `-v4-out`, `-v4-in`, `-v6-out`, `-v6-in`), where `<actionId>` is the server-generated action UUID — never client-supplied, never guessable, never colliding with a pre-existing rule. `RESTORE_HOST_NETWORK` only ever queries/removes rules matching this exact, actionId-scoped name pattern for the specific isolation it is restoring (see §15 in the mission — ownership re-verified against the persisted rollback state before any deletion, never a wildcard `Docteur-MAITRE-*` sweep).

## 5. No DNS/route/adapter/proxy modification capability needed or used

Confirmed by design, not just by omission: nothing in the chosen strategy touches `Set-DnsClientServerAddress`, `New-NetRoute`, `Set-NetIPInterface`, `Disable-NetAdapter`, or any proxy configuration. Containment is firewall-rule-only, exactly as mission §12 mandates.

## 6. Preflight data shape (mission §6)

Confirmed available and bounded, all read-only, no network payload, no credentials:
- `Get-NetAdapter` (name, status, description) — small, fixed-size list (2 adapters on this machine).
- `Get-NetFirewallProfile` (Domain/Private/Public enabled status) — fixed 3 rows.
- `Get-NetFirewallRule -DisplayName 'Docteur-MAITRE-Isolation-*'` — MAÎTRE-owned rules only, bounded by MAÎTRE's own naming convention.
- Loopback availability — a local HTTP probe to cortex-server's own health endpoint, never external.
- Docteur local server status — process/port already known to cortex-server itself.
- "Isolation already active?" — derived from the persisted rollback-state table (§7 below), not from re-deriving it from live firewall state (which could be manipulated externally) — the database is the source of truth for "does MAÎTRE believe isolation is active," while the live `Get-NetFirewallRule` check is used only for verification/consistency, never as the sole authority.

## 7. Verdict

**HOST_ISOLATION and RESTORE_HOST_NETWORK are implementable safely** using an explicit-exclusion Block-rule strategy (never "Block Any", never relying on Allow-over-Block ordering, never touching adapters/DNS/routes). This audit's loopback-safety research changed the original design (Allow+Block) to the final, safer design (exclusion-scoped Block only) **before any executor code was written** — exactly the audit-before-code discipline mission §3 requires.
