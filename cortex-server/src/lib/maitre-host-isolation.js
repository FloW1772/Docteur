/**
 * MAÎTRE — host network isolation (MA-10). LEVEL 3, reversible,
 * firewall-owned containment. Real-machine audit performed before any
 * code here was written (see reports/MAITRE_MA10_AUDIT_2026-09.md) found
 * that a naive "Allow-loopback + Block-Any" design is UNSAFE — Windows
 * Firewall's documented rule precedence is "explicit Block always beats
 * explicit Allow, regardless of specificity" (learn.microsoft.com,
 * "Rule precedence for inbound and outbound rules"). This module
 * therefore NEVER creates a RemoteAddress "Any" block rule. Every block
 * rule's RemoteAddress is scoped, by construction, to explicitly exclude
 * loopback space (127.0.0.0/8 for IPv4, the global-unicast range for
 * IPv6, which trivially excludes ::1) — the rule structurally cannot
 * match loopback traffic, independent of any Block/Allow ordering.
 *
 * No adapter disable, no DNS/route/proxy/DHCP change, no firewall
 * reset/disable, no global firewall policy change (mission §2/§12) —
 * containment is exclusively a small set of MAÎTRE-owned, uniquely
 * named New-NetFirewallRule rules, created and later removed one at a
 * time, each step individually verified.
 *
 * No runNetsh()/runFirewallCommand(command)/executePowerShell(script) —
 * every PowerShell script here is a FIXED, Docteur-authored template
 * with only data values (rule names, actionIds) interpolated via
 * toPsSingleQuotedLiteral, never a caller-supplied command string
 * (mission §21).
 */
import crypto from 'node:crypto';
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral } from './maitre-windows-exec.js';
import {
  insertMaitreIsolationState, getMaitreIsolationStateById, updateMaitreIsolationState,
  findActiveMaitreIsolationState,
} from './sqlite.js';

const STRATEGY_ID = 'firewall-scoped-block-v1';
const FIREWALL_TIMEOUT_MS = 8_000;
const LOOPBACK_CHECK_TIMEOUT_MS = 5_000;

// IPv4: every address EXCEPT the entire 127.0.0.0/8 loopback block.
// Live-verified during the MA-10 audit that New-NetFirewallRule accepts
// this exact multi-range syntax (probe failed with access_denied, not a
// parameter error, confirming the range list itself parses correctly).
const IPV4_NON_LOOPBACK_RANGE = '0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255';
// IPv6: scoped to the global unicast range (2000::/3 and above), which
// trivially and unambiguously excludes ::1 (in ::/128) without an
// error-prone subtraction expression.
const IPV6_GLOBAL_UNICAST_RANGE = '2000::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff';

function isolationRuleNames(actionId) {
  const base = `Docteur-MAITRE-Isolation-${actionId}`;
  return {
    v4Out: `${base}-v4-out`,
    v4In: `${base}-v4-in`,
    v6Out: `${base}-v6-out`,
    v6In: `${base}-v6-in`,
  };
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ── Preflight (mission §6) — entirely read-only, no payload, no creds ─────

const PREFLIGHT_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $adapters = Get-NetAdapter | Select-Object Name, Status, InterfaceDescription
  $profiles = Get-NetFirewallProfile | Select-Object Name, Enabled
  @{
    ok = $true
    adapters = $adapters
    firewallProfiles = $profiles
  } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

function buildCheckRulesScript(ruleNames) {
  const namesLiteral = toPsSingleQuotedLiteral(ruleNames.join(','));
  return `
$ErrorActionPreference = 'Stop'
try {
  $names = (${namesLiteral}).Split(',')
  $found = @()
  foreach ($n in $names) {
    $r = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
    if ($r) { $found += $n }
  }
  @{ ok = $true; found = $found } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

/**
 * Bounded, read-only preflight snapshot. Never a network payload, never
 * credentials — adapter metadata and firewall profile status only
 * (mission §6). "Isolation already active?" is answered from the
 * PERSISTED rollback-state table (the source of truth for what MAÎTRE
 * believes it has done), not solely from live firewall inspection —
 * live inspection is a secondary consistency check only.
 */
export async function hostIsolationPreflight({ exec = runReadOnlyPowerShell, checkPlatform = isWindows, loopbackCheck = defaultLoopbackCheck } = {}) {
  const activeState = findActiveMaitreIsolationState();

  if (!checkPlatform()) {
    return {
      platformSupported: false,
      isolationAlreadyActive: !!activeState,
      activeIsolationStateId: activeState?.id ?? null,
      adapters: [],
      firewallProfiles: [],
      loopbackAvailable: null,
    };
  }

  const result = await exec(PREFLIGHT_SCRIPT, { timeoutMs: FIREWALL_TIMEOUT_MS });
  const envelope = result.ok ? parseJsonEnvelope(result.stdout) : null;
  const loopbackAvailable = await loopbackCheck();

  return {
    platformSupported: true,
    isolationAlreadyActive: !!activeState,
    activeIsolationStateId: activeState?.id ?? null,
    adapters: envelope?.ok ? (Array.isArray(envelope.adapters) ? envelope.adapters : [envelope.adapters].filter(Boolean)) : [],
    firewallProfiles: envelope?.ok ? (Array.isArray(envelope.firewallProfiles) ? envelope.firewallProfiles : [envelope.firewallProfiles].filter(Boolean)) : [],
    loopbackAvailable,
  };
}

// Default loopback check: a local HTTP probe against cortex-server's own
// health endpoint on 127.0.0.1 — never an external host (mission §13).
async function defaultLoopbackCheck() {
  try {
    const port = process.env.PORT || 3001;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOPBACK_CHECK_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal }).finally(() => clearTimeout(timeout));
    return res.ok;
  } catch {
    return false;
  }
}

// ── HOST_ISOLATION — transactional, step-by-step application ──────────────

function buildCreateBlockRuleScript({ ruleName, direction, remoteAddress }) {
  const ruleNameLiteral = toPsSingleQuotedLiteral(ruleName);
  const remoteAddressLiteral = toPsSingleQuotedLiteral(remoteAddress);
  return `
$ErrorActionPreference = 'Stop'
try {
  $addrs = (${remoteAddressLiteral}).Split(',')
  New-NetFirewallRule -DisplayName ${ruleNameLiteral} -Direction ${direction} -RemoteAddress $addrs -Action Block -ErrorAction Stop | Out-Null
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function buildRemoveRuleScript(ruleName) {
  const ruleNameLiteral = toPsSingleQuotedLiteral(ruleName);
  return `
$ErrorActionPreference = 'Stop'
try {
  $existing = Get-NetFirewallRule -DisplayName ${ruleNameLiteral} -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-NetFirewallRule -DisplayName ${ruleNameLiteral} -ErrorAction Stop | Out-Null
  }
  @{ ok = $true; existed = ($null -ne $existing) } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function isAccessDenied(envelope) {
  const detail = envelope?.message ?? '';
  return /access.*denied|accès.*refusé/i.test(detail) || envelope?.errorId?.includes('Windows System Error 5');
}

/**
 * Rolls back (removes) any rules already created in THIS attempt, best
 * effort, after a step N failure (mission §8). Never throws — a rollback
 * failure is recorded but does not mask the original PARTIAL_FAILURE.
 */
async function rollbackCreatedRules(createdRuleNames, { exec }) {
  const stillPresent = [];
  for (const ruleName of createdRuleNames) {
    try {
      const result = await exec(buildRemoveRuleScript(ruleName), { timeoutMs: FIREWALL_TIMEOUT_MS });
      const envelope = result.ok ? parseJsonEnvelope(result.stdout) : null;
      if (!envelope?.ok) stillPresent.push(ruleName);
    } catch {
      stillPresent.push(ruleName);
    }
  }
  return stillPresent;
}

/**
 * Applies host isolation transactionally, one rule at a time. The
 * rollback-state row MUST already exist (inserted by the caller BEFORE
 * this function is invoked — mission §7) so a crash mid-application can
 * always be recovered from at next startup (mission §17).
 */
export async function applyHostIsolation({
  actionId, isolationStateId, exec = runReadOnlyPowerShell, checkPlatform = isWindows, loopbackCheck = defaultLoopbackCheck,
} = {}) {
  if (!checkPlatform()) {
    updateMaitreIsolationState(isolationStateId, { status: 'FAILED', updated_at: nowIso() });
    return { isolationStatus: 'NOT_SUPPORTED', reason: 'platform_not_windows' };
  }

  const ruleNames = isolationRuleNames(actionId);
  const steps = [
    { ruleName: ruleNames.v4Out, direction: 'Outbound', remoteAddress: IPV4_NON_LOOPBACK_RANGE },
    { ruleName: ruleNames.v4In, direction: 'Inbound', remoteAddress: IPV4_NON_LOOPBACK_RANGE },
    { ruleName: ruleNames.v6Out, direction: 'Outbound', remoteAddress: IPV6_GLOBAL_UNICAST_RANGE },
    { ruleName: ruleNames.v6In, direction: 'Inbound', remoteAddress: IPV6_GLOBAL_UNICAST_RANGE },
  ];

  updateMaitreIsolationState(isolationStateId, { status: 'APPLYING', updated_at: nowIso() });

  const created = [];
  for (const step of steps) {
    let result;
    try {
      result = await exec(buildCreateBlockRuleScript(step), { timeoutMs: FIREWALL_TIMEOUT_MS });
    } catch (err) {
      result = { ok: false, reason: 'exec_error', detail: err?.message };
    }

    if (!result.ok) {
      const rollbackRemaining = await rollbackCreatedRules(created, { exec });
      const status = created.length > 0 ? 'PARTIAL_FAILURE' : 'FAILED';
      updateMaitreIsolationState(isolationStateId, {
        status, rules_created: JSON.stringify(created), updated_at: nowIso(),
        verification_metadata: JSON.stringify({ failedStep: step.ruleName, reason: result.reason === 'timeout' ? 'timeout' : 'exec_failed', rollbackRemaining }),
      });
      return { isolationStatus: status === 'PARTIAL_FAILURE' ? 'PARTIAL_FAILURE' : 'FAILED', reason: result.reason === 'timeout' ? 'timeout' : 'firewall_rule_failed', rulesCreated: created, rollbackRemaining };
    }

    const envelope = parseJsonEnvelope(result.stdout);
    if (!envelope) {
      const rollbackRemaining = await rollbackCreatedRules(created, { exec });
      const status = created.length > 0 ? 'PARTIAL_FAILURE' : 'FAILED';
      updateMaitreIsolationState(isolationStateId, {
        status, rules_created: JSON.stringify(created), updated_at: nowIso(),
        verification_metadata: JSON.stringify({ failedStep: step.ruleName, reason: 'malformed_output', rollbackRemaining }),
      });
      return { isolationStatus: status === 'PARTIAL_FAILURE' ? 'PARTIAL_FAILURE' : 'FAILED', reason: 'malformed_output', rulesCreated: created, rollbackRemaining };
    }

    if (!envelope.ok) {
      const reason = isAccessDenied(envelope) ? 'access_denied' : (envelope.errorId || 'firewall_rule_failed');
      const rollbackRemaining = await rollbackCreatedRules(created, { exec });
      const status = created.length > 0 ? 'PARTIAL_FAILURE' : 'FAILED';
      updateMaitreIsolationState(isolationStateId, {
        status, rules_created: JSON.stringify(created), updated_at: nowIso(),
        verification_metadata: JSON.stringify({ failedStep: step.ruleName, reason, rollbackRemaining }),
      });
      return { isolationStatus: status === 'PARTIAL_FAILURE' ? 'PARTIAL_FAILURE' : 'FAILED', reason, rulesCreated: created, rollbackRemaining };
    }

    created.push(step.ruleName);
    // Persist progress after EACH successful step, not only at the end —
    // so a crash between steps still leaves an accurate rules_created
    // record for crash-recovery / manual restoration (mission §7/§17).
    updateMaitreIsolationState(isolationStateId, { rules_created: JSON.stringify(created), updated_at: nowIso() });
  }

  // Verification (mission §13): confirm all four rules exist AND loopback
  // is still reachable. Never contact an external host to "test" the
  // block — only local rule presence + local loopback probe.
  const verifyRules = await exec(buildCheckRulesScript(Object.values(ruleNames)), { timeoutMs: FIREWALL_TIMEOUT_MS });
  const verifyEnvelope = verifyRules.ok ? parseJsonEnvelope(verifyRules.stdout) : null;
  const allRulesPresent = verifyEnvelope?.ok && Object.values(ruleNames).every(n => (verifyEnvelope.found ?? []).includes(n));
  const loopbackStillWorks = await loopbackCheck();

  const verificationMetadata = { allRulesPresent: !!allRulesPresent, loopbackStillWorks };

  if (!allRulesPresent || !loopbackStillWorks) {
    // Verification failed even though every individual step reported
    // success — never claim ACTIVE on an unverified state (mission §8:
    // "never announce SUCCEEDED on partial state"). Roll back everything
    // created rather than leave a half-verified isolation in place.
    const rollbackRemaining = await rollbackCreatedRules(created, { exec });
    updateMaitreIsolationState(isolationStateId, {
      status: 'PARTIAL_FAILURE', rules_created: JSON.stringify(created), updated_at: nowIso(),
      verification_metadata: JSON.stringify({ ...verificationMetadata, rollbackRemaining }),
    });
    return { isolationStatus: 'PARTIAL_FAILURE', reason: 'verification_failed', rulesCreated: created, verificationMetadata, rollbackRemaining };
  }

  updateMaitreIsolationState(isolationStateId, {
    status: 'ACTIVE', rules_created: JSON.stringify(created), updated_at: nowIso(),
    verification_metadata: JSON.stringify(verificationMetadata),
  });

  return {
    isolationStatus: 'ACTIVE', rulesCreated: created, strategy: STRATEGY_ID, verificationMetadata,
    description: 'Outbound and inbound traffic to all non-loopback IPv4/IPv6 addresses is blocked by 4 MAÎTRE-owned firewall rules. Loopback (127.0.0.1/::1) and Docteur\'s own local server remain reachable. This is firewall-scoped containment, not an air-gap: it does not disable network adapters, and any traffic path outside Windows Firewall\'s enforcement (if any) is not covered.',
  };
}

/**
 * Creates the rollback-state row FIRST, before any firewall modification
 * (mission §7). Returns the new state id, or throws if persistence
 * itself failed — the caller (maitre-executor.js) treats that as a hard
 * DENY, never proceeding to applyHostIsolation without it.
 */
export function createIsolationRollbackState({ actionId, incidentId }) {
  const id = crypto.randomUUID();
  const now = nowIso();
  const insertedId = insertMaitreIsolationState({
    id, action_id: actionId, incident_id: incidentId, created_at: now, updated_at: now,
    strategy: STRATEGY_ID, status: 'PENDING', rules_created: '[]', verification_metadata: '{}',
    restored_at: null, restore_action_id: null,
  });
  if (!insertedId) {
    throw new Error('isolation_rollback_state_persist_failed');
  }
  return id;
}

export function getIsolationState(id) {
  return getMaitreIsolationStateById(id);
}

// ── RESTORE_HOST_NETWORK ───────────────────────────────────────────────────

/**
 * Removes ONLY the rules recorded in the target isolation state's own
 * rules_created list — never a wildcard `Docteur-MAITRE-*` sweep, never
 * a rule this specific state didn't itself create (mission §14/§15).
 * Idempotent (mission §16): a state already RESTORED returns
 * ALREADY_RESTORED rather than re-attempting removal or erroring.
 */
export async function restoreHostNetwork({
  isolationStateId, restoreActionId, exec = runReadOnlyPowerShell, checkPlatform = isWindows,
} = {}) {
  const state = getMaitreIsolationStateById(isolationStateId);
  if (!state) return { restoreStatus: 'DENY', reason: 'isolation_state_not_found' };

  if (state.status === 'RESTORED') {
    return { restoreStatus: 'ALREADY_RESTORED', restoredAt: state.restored_at };
  }

  // Ownership/identity re-check (mission §15): only a state whose status
  // reflects an attempted-or-active isolation may be restored. A state
  // still PENDING (rollback row created, but no rule was ever actually
  // applied — e.g. denied before applyHostIsolation ran) has nothing to
  // remove and is not a valid restore target in the ordinary sense, but
  // is still handled cleanly rather than erroring, since rules_created
  // is correctly empty for it.
  let rulesCreated;
  try {
    rulesCreated = JSON.parse(state.rules_created || '[]');
  } catch {
    return { restoreStatus: 'MANUAL_REVIEW', reason: 'rollback_record_corrupt' };
  }
  if (!Array.isArray(rulesCreated)) {
    return { restoreStatus: 'MANUAL_REVIEW', reason: 'rollback_record_corrupt' };
  }

  if (!checkPlatform()) {
    return { restoreStatus: 'FAILED', reason: 'platform_not_windows' };
  }

  updateMaitreIsolationState(isolationStateId, { status: 'RESTORING', updated_at: nowIso() });

  const stillPresent = [];
  for (const ruleName of rulesCreated) {
    // Defense in depth: only ever remove a rule whose name matches
    // MAÎTRE's own isolation naming convention for THIS state's action —
    // even though rules_created is server-persisted (never client-
    // supplied), this guard means a corrupted/tampered DB row still
    // cannot cause removal of an unrelated rule.
    if (!ruleName.startsWith(`Docteur-MAITRE-Isolation-${state.action_id}-`)) {
      stillPresent.push(ruleName);
      continue;
    }
    try {
      const result = await exec(buildRemoveRuleScript(ruleName), { timeoutMs: FIREWALL_TIMEOUT_MS });
      const envelope = result.ok ? parseJsonEnvelope(result.stdout) : null;
      if (!envelope?.ok) stillPresent.push(ruleName);
    } catch {
      stillPresent.push(ruleName);
    }
  }

  if (stillPresent.length > 0) {
    updateMaitreIsolationState(isolationStateId, {
      status: 'PARTIAL_FAILURE', updated_at: nowIso(),
      verification_metadata: JSON.stringify({ ...safeParseVerification(state), restoreRemaining: stillPresent }),
    });
    return { restoreStatus: 'PARTIAL_FAILURE', remaining: stillPresent };
  }

  const restoredAt = nowIso();
  updateMaitreIsolationState(isolationStateId, {
    status: 'RESTORED', restored_at: restoredAt, restore_action_id: restoreActionId ?? null, updated_at: restoredAt,
  });

  return { restoreStatus: 'RESTORED', restoredAt, rulesRemoved: rulesCreated };
}

function safeParseVerification(state) {
  try {
    return JSON.parse(state.verification_metadata || '{}');
  } catch {
    return {};
  }
}

/**
 * Crash recovery (mission §17): called at server startup. If a MAÎTRE
 * isolation state is still ACTIVE/PARTIAL_FAILURE/APPLYING/RESTORING
 * from a previous process lifetime, report it — NEVER auto-restore.
 * The decision to restore remains the user's, via the ordinary
 * RESTORE_HOST_NETWORK proposal/approval flow.
 */
export function detectActiveIsolationOnStartup() {
  const active = findActiveMaitreIsolationState();
  if (!active) return { isolationActive: false };
  return {
    isolationActive: true,
    isolationStateId: active.id,
    actionId: active.action_id,
    incidentId: active.incident_id,
    status: active.status,
    restoreAvailable: active.status !== 'RESTORING',
  };
}
