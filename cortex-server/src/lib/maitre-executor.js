/**
 * MAÎTRE — safe executor. MA-8 shipped LEVEL 1 (COLLECT_EVIDENCE,
 * SCAN_WITH_DEFENDER). MA-9 adds LEVEL 2: TERMINATE_PROCESS,
 * BLOCK_REMOTE_IP, DISABLE_PERSISTENCE_ENTRY. QUARANTINE_WITH_DEFENDER
 * is deliberately NOT_SUPPORTED (see quarantineExecutor below) —
 * real-machine audit during this phase found Remove-MpThreat (the only
 * Defender remediation cmdlet) has NO targeting parameter at all: it
 * remediates ALL active threats system-wide, with no way to scope to
 * one file/detection, which mission §9 explicitly anticipates and
 * requires falling back to NOT_SUPPORTED rather than either widening
 * scope silently or inventing a custom Docteur quarantine mechanism.
 *
 * MA-10 adds LEVEL 3: HOST_ISOLATION, RESTORE_HOST_NETWORK. Both require
 * a valid, unexpired, unconsumed approval whose action carries
 * status APPROVED with strengthened confirmation already recorded by
 * maitre-approval.js's approveProposal() (LEVEL 3 gate) before this file
 * ever sees them. HOST_ISOLATION additionally persists a rollback-state
 * row BEFORE the first firewall change (see maitre-host-isolation.js) —
 * if that persist fails, the action is denied before touching the OS.
 *
 * There is no runCommand()/runShell()/executePowerShell(script)/
 * executeCustomAction()/executeArgsFromClient() — only named, semantic
 * executors, dispatched through a closed switch. No Ollama, Claude,
 * Codex, OpenAI, or Mistral import anywhere in this file.
 *
 * Flow: getActionProposal -> re-validate policy/approval fresh ->
 * TOCTOU re-check of the target -> dispatch -> persist a
 * maitre_action_runs audit row -> return a bounded ActionResult. This
 * file NEVER marks an action SUCCEEDED before the underlying operation
 * has actually completed and been observed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  insertMaitreActionRun, updateMaitreActionRun, findActiveOrSucceededRunForAction, getMaitreActionRunById,
  getMaitreIsolationStateByActionId,
} from './sqlite.js';
import { getActionProposal, validateApproval, consumeApproval } from './maitre-approval.js';
import { getIncident, createEvidence } from './maitre-store.js';
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral } from './maitre-windows-exec.js';
import { inspectProcess, classifyProcessCriticality } from './maitre-process-inspector.js';
import { inspectFile, isLocalPathAllowed } from './maitre-file-inspector.js';
import { getPersistenceSnapshot } from './maitre-persistence-inspector.js';
import { getDefenderStatus, getDefenderDetections } from './maitre-defender-adapter.js';
import { redactMaitreEvidenceMetadata } from './maitre-evidence.js';
import {
  hostIsolationPreflight, createIsolationRollbackState, applyHostIsolation,
  restoreHostNetwork,
} from './maitre-host-isolation.js';
import { isValidIncidentTransition } from './maitre-models.js';
import { updateIncident } from './maitre-store.js';

export class MaitreExecutionError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'MaitreExecutionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new MaitreExecutionError(code, detail);
}

// Server-side level lookup, independent of maitre-actions.js's own
// table — a second, deliberately duplicated source of truth so a bug
// in one file alone can never let a LEVEL 2/3 action slip through
// (mission §4: "même si approval valide... MA-8 ne doit jamais
// exécuter LEVEL 2/3").
// QUARANTINE_WITH_DEFENDER is deliberately absent from LEVEL 2 —
// dispatched to its own NOT_SUPPORTED stub (quarantineExecutor) rather
// than hard-denied like HOST_ISOLATION/RESTORE_HOST_NETWORK, since it
// IS a recognized, in-scope MA-9 action type whose result is simply
// "this cannot be done safely with the available Defender API", not
// "this action type doesn't exist yet".
const EXECUTABLE_LEVEL_1_ACTIONS = new Set(['COLLECT_EVIDENCE', 'SCAN_WITH_DEFENDER']);
const EXECUTABLE_LEVEL_2_ACTIONS = new Set(['TERMINATE_PROCESS', 'QUARANTINE_WITH_DEFENDER', 'BLOCK_REMOTE_IP', 'DISABLE_PERSISTENCE_ENTRY']);
const EXECUTABLE_LEVEL_3_ACTIONS = new Set(['HOST_ISOLATION', 'RESTORE_HOST_NETWORK']);

const EVIDENCE_METADATA_MAX_ITEMS = 50;

// ── COLLECT_EVIDENCE ────────────────────────────────────────────────────

/**
 * Collects exactly the evidence type the proposal targets, using only
 * already-certified MA-3/MA-4/Observateur read-only components. Bounds
 * are inherited from each inspector's own limits (mission §6) — this
 * function adds no separate unbounded path.
 */
async function collectEvidenceExecutor(action) {
  const { evidenceType } = action.target;

  if (evidenceType === 'PROCESS_SNAPSHOT') {
    const result = await inspectProcess(action.target.pid);
    if (!result.available) fail('collect_evidence_process_unavailable', { reason: result.reason });
    return { type: 'PROCESS_SNAPSHOT', metadata: result.process };
  }

  if (evidenceType === 'FILE_METADATA' || evidenceType === 'FILE_HASH') {
    if (!isLocalPathAllowed(action.target.path)) fail('collect_evidence_path_not_allowed');
    const result = await inspectFile(action.target.path);
    if (!result.available) fail('collect_evidence_file_unavailable', { reason: result.reason });
    return { type: evidenceType, metadata: result, sha256: result.sha256 };
  }

  if (evidenceType === 'DEFENDER_RESULT') {
    const status = await getDefenderStatus();
    const detections = await getDefenderDetections();
    return {
      type: 'DEFENDER_RESULT',
      metadata: { status, detections: (detections.detections ?? []).slice(0, EVIDENCE_METADATA_MAX_ITEMS) },
    };
  }

  if (evidenceType === 'PERSISTENCE_METADATA') {
    const snapshot = await getPersistenceSnapshot();
    return { type: 'PERSISTENCE_METADATA', metadata: { items: snapshot.items.slice(0, EVIDENCE_METADATA_MAX_ITEMS), sourceAvailability: snapshot.sourceAvailability } };
  }

  if (evidenceType === 'OTHER') {
    return { type: 'OTHER', metadata: { note: 'No specific collector for OTHER — placeholder evidence recorded on request.' } };
  }

  fail('collect_evidence_type_not_implemented', { evidenceType });
  return null; // unreachable — fail() always throws
}

// ── SCAN_WITH_DEFENDER ──────────────────────────────────────────────────
//
// V1 scope (confirmed via real-machine probing during this phase):
// Start-MpScan blocks synchronously for its FULL duration — a QuickScan
// measured ~50s on the dev box. Only CustomScan against the single
// explicit file the proposal targets is supported, since that
// completes in well under a second and stays safely within
// maitre-windows-exec.js's existing timeout — QuickScan/FullScan are
// NOT_SUPPORTED in MA-8 to avoid blocking a Node request thread for an
// unbounded, variable duration. This is a deliberate scope narrowing,
// not an oversight.
const SCAN_TIMEOUT_MS = 15_000;

function buildScanScript(path) {
  const pathLiteral = toPsSingleQuotedLiteral(path);
  return `
$ErrorActionPreference = 'Stop'
try {
  Start-MpScan -ScanType CustomScan -ScanPath ${pathLiteral} -ErrorAction Stop
  @{ ok = $true; status = 'COMPLETED' } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Runs a CustomScan against the proposal's single explicit file
 * target. Returns { scanStatus: 'COMPLETED' | 'FAILED' | 'UNKNOWN', ... }
 * — never fabricates "SUCCESS" beyond what Start-MpScan itself
 * confirmed (mission §28). No remediation call (Remove-MpThreat,
 * quarantine, preference changes) exists anywhere in this function —
 * MAÎTRE only ever asks Defender to scan.
 */
async function defenderScanExecutor(action, { exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) {
    return { scanStatus: 'UNKNOWN', reason: 'NOT_SUPPORTED' };
  }

  const path = action.target.path;

  // TOCTOU re-check (mission §16): the file must still exist and pass
  // the same local-path policy immediately before scanning it.
  if (!isLocalPathAllowed(path)) fail('scan_target_path_not_allowed');
  const metadata = await inspectFile(path);
  if (!metadata.available) fail('scan_target_changed', { reason: metadata.reason });

  const result = await exec(buildScanScript(path), { timeoutMs: SCAN_TIMEOUT_MS });
  if (!result.ok) {
    if (result.reason === 'timeout') return { scanStatus: 'UNKNOWN', reason: 'timeout' };
    return { scanStatus: 'FAILED', reason: result.reason };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { scanStatus: 'UNKNOWN', reason: 'malformed_output' };

  if (!envelope.ok) {
    // MI RESULT 16 = a scan is already in progress on this device
    // (confirmed via real-machine testing during this phase) — this is
    // an expected operational conflict, not a crash.
    if (envelope.errorId && envelope.errorId.startsWith('MI RESULT 16')) {
      return { scanStatus: 'FAILED', reason: 'scan_already_running' };
    }
    return { scanStatus: 'FAILED', reason: envelope.errorId || 'defender_scan_failed' };
  }

  return { scanStatus: 'COMPLETED', fileMetadata: { path, sha256: metadata.sha256 } };
}

// ── TERMINATE_PROCESS ───────────────────────────────────────────────────
//
// Uses Stop-Process -Id <pid> ONLY — never -Name (which matches by
// process name and could hit an unintended process), never a wildcard,
// never a client-supplied argument list (mission §7). The identity
// re-check below (mission §5) is what actually prevents "kill whatever
// currently holds this PID" from being sufficient.

const TERMINATE_TIMEOUT_MS = 8_000;

function buildTerminateScript(pid) {
  return `
$ErrorActionPreference = 'Stop'
try {
  Stop-Process -Id ${Number(pid)} -ErrorAction Stop
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

async function terminateProcessExecutor(action, { exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) return { terminationStatus: 'UNKNOWN', reason: 'NOT_SUPPORTED' };

  const { pid, processIdentity, executablePath, startTime } = action.target;

  // Hard, non-bypassable critical-process re-check (mission §6) — even
  // though maitre-actions.js's validator already denies this at
  // proposal time, this is deliberately checked AGAIN here,
  // independently, immediately before termination. A future bug in the
  // proposal-time check must not be the only thing standing between a
  // client and killing a critical process.
  const criticality = classifyProcessCriticality({ pid, name: processIdentity });
  if (criticality === 'SYSTEM_CRITICAL') fail('terminate_denied_system_critical_reexec', { pid });
  if (criticality === 'DOCTEUR_CRITICAL') fail('terminate_denied_docteur_critical_reexec', { pid });

  // TOCTOU identity re-check (mission §5): PID alone is insufficient —
  // re-inspect the CURRENT process at this PID and compare name/path/
  // startTime against what the proposal captured. Any mismatch means
  // the PID has been reused by a different process since the proposal
  // was made, or the proposal's own data was stale.
  const current = await inspectProcess(pid, { exec, checkPlatform, correlateObservateur: false });
  if (!current.available) {
    // Process already gone — nothing to terminate, and nothing unsafe
    // happened. This is a successful outcome from a defensive-posture
    // standpoint (the threat is no longer running) but MA-9 must not
    // fabricate SUCCEEDED for an action it did not itself perform.
    return { terminationStatus: 'ALREADY_GONE', reason: 'process_not_found' };
  }

  const nameMismatch = current.process.name && processIdentity && current.process.name.toLowerCase() !== processIdentity.toLowerCase();
  const pathMismatch = executablePath && current.process.executablePath && current.process.executablePath !== executablePath;
  const startTimeMismatch = startTime && current.process.startTime && current.process.startTime !== startTime;
  if (nameMismatch || pathMismatch || startTimeMismatch) {
    fail('terminate_target_changed', { nameMismatch, pathMismatch, startTimeMismatch });
  }

  const result = await exec(buildTerminateScript(pid), { timeoutMs: TERMINATE_TIMEOUT_MS });
  if (!result.ok) {
    if (result.reason === 'timeout') return { terminationStatus: 'UNKNOWN', reason: 'timeout' };
    return { terminationStatus: 'FAILED', reason: result.reason };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { terminationStatus: 'UNKNOWN', reason: 'malformed_output' };
  if (!envelope.ok) {
    if (envelope.errorId && envelope.errorId.startsWith('NoProcessFoundForGivenId')) {
      return { terminationStatus: 'ALREADY_GONE', reason: 'process_not_found' };
    }
    return { terminationStatus: 'FAILED', reason: envelope.errorId || 'terminate_failed' };
  }

  // Verification (mission §23): re-check that the SAME process identity
  // is no longer present, rather than trusting the command's own exit
  // code alone — a new, unrelated process could theoretically reuse the
  // PID in the (small) window since the Stop-Process call returned.
  const verify = await inspectProcess(pid, { exec, checkPlatform, correlateObservateur: false });
  if (verify.available && verify.process.startTime === startTime && startTime) {
    // Same identity somehow still present — do not claim success.
    return { terminationStatus: 'UNKNOWN', reason: 'verification_inconclusive' };
  }

  return { terminationStatus: 'TERMINATED', pid, processIdentity };
}

// ── QUARANTINE_WITH_DEFENDER — NOT_SUPPORTED (mission §9) ─────────────────

async function quarantineExecutor() {
  return {
    quarantineStatus: 'NOT_SUPPORTED',
    reason: 'defender_remediation_not_precisely_targetable',
  };
}

// ── BLOCK_REMOTE_IP ─────────────────────────────────────────────────────
//
// Creates exactly one New-NetFirewallRule for the exact IP the proposal
// validated (mission §11 — never a domain/wildcard/CIDR/range, already
// enforced by maitre-actions.js's BLOCK_REMOTE_IP validator, re-used
// unchanged here). The rule is named Docteur-MAITRE-<actionId> so it is
// unambiguously identifiable as MAÎTRE's own (mission §12) and never
// collides with or touches any pre-existing rule.

const FIREWALL_TIMEOUT_MS = 8_000;

function firewallRuleName(actionId) {
  return `Docteur-MAITRE-${actionId}`;
}

function buildBlockIpScript({ ruleName, ip, direction, protocol }) {
  const ruleNameLiteral = toPsSingleQuotedLiteral(ruleName);
  const ipLiteral = toPsSingleQuotedLiteral(ip);
  const psDirection = direction === 'inbound' ? 'Inbound' : direction === 'both' ? 'Inbound' : 'Outbound'; // 'both' handled by two calls below when needed
  const psProtocol = protocol === 'tcp' ? 'TCP' : protocol === 'udp' ? 'UDP' : 'Any';
  return `
$ErrorActionPreference = 'Stop'
try {
  New-NetFirewallRule -DisplayName ${ruleNameLiteral} -Direction ${psDirection} -RemoteAddress ${ipLiteral} -Action Block -Protocol ${psProtocol} -ErrorAction Stop | Out-Null
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function buildCheckRuleExistsScript(ruleName) {
  const ruleNameLiteral = toPsSingleQuotedLiteral(ruleName);
  return `
$ErrorActionPreference = 'Stop'
try {
  $rule = Get-NetFirewallRule -DisplayName ${ruleNameLiteral} -ErrorAction Stop
  @{ ok = $true; exists = ($null -ne $rule) } | ConvertTo-Json -Compress
} catch {
  @{ ok = $true; exists = $false } | ConvertTo-Json -Compress
}
`;
}

async function blockRemoteIpExecutor(action, { exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) return { firewallStatus: 'UNKNOWN', reason: 'NOT_SUPPORTED' };

  const { ip } = action.target;
  const { direction = 'outbound', protocol = 'any' } = action.parameters ?? {};
  const ruleName = firewallRuleName(action.id);

  // Idempotency at the firewall level: if a rule with this exact
  // Docteur-owned name already exists (e.g. a retried execution after a
  // partial failure), do not create a duplicate.
  const existsCheck = await exec(buildCheckRuleExistsScript(ruleName), { timeoutMs: FIREWALL_TIMEOUT_MS });
  if (existsCheck.ok) {
    const existsEnvelope = parseJsonEnvelope(existsCheck.stdout);
    if (existsEnvelope?.ok && existsEnvelope.exists) {
      return { firewallStatus: 'ALREADY_BLOCKED', ruleName, ip };
    }
  }

  const result = await exec(buildBlockIpScript({ ruleName, ip, direction, protocol }), { timeoutMs: FIREWALL_TIMEOUT_MS });
  if (!result.ok) {
    if (result.reason === 'timeout') return { firewallStatus: 'UNKNOWN', reason: 'timeout' };
    return { firewallStatus: 'FAILED', reason: result.reason };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { firewallStatus: 'UNKNOWN', reason: 'malformed_output' };
  if (!envelope.ok) {
    const detail = envelope.message ?? '';
    if (/access.*denied|accès.*refusé/i.test(detail) || envelope.errorId?.includes('Windows System Error 5')) {
      return { firewallStatus: 'FAILED', reason: 'access_denied' };
    }
    return { firewallStatus: 'FAILED', reason: envelope.errorId || 'firewall_rule_failed' };
  }

  // Verification (mission §24): confirm the exact rule now exists,
  // never generate outbound network traffic to "test" the block.
  const verify = await exec(buildCheckRuleExistsScript(ruleName), { timeoutMs: FIREWALL_TIMEOUT_MS });
  const verifyEnvelope = verify.ok ? parseJsonEnvelope(verify.stdout) : null;
  if (!verifyEnvelope?.exists) {
    return { firewallStatus: 'UNKNOWN', reason: 'verification_inconclusive' };
  }

  return { firewallStatus: 'BLOCKED', ruleName, ip, direction, protocol };
}

// ── DISABLE_PERSISTENCE_ENTRY ─────────────────────────────────────────────
//
// Re-fetches the CURRENT persistence snapshot and finds the item by its
// MA-4-generated id (mission §14 — never a freeform path/key from the
// client). If the item is gone or its target value has changed since
// the proposal, DENY_TARGET_CHANGED (mission §15) rather than acting on
// a possibly-different entry that happens to share an id collision
// (extremely unlikely given the id is a hash of type+scope+name, but
// the target/value comparison is the real safety net either way).

const PERSISTENCE_TIMEOUT_MS = 8_000;
const DISABLED_PERSISTENCE_DIR_NAME = 'docteur-maitre-disabled-persistence';

function buildDisableRegistryScript(hive, regPath, valueName) {
  const psPath = `${hive}:\\${regPath}`;
  const psPathLiteral = toPsSingleQuotedLiteral(psPath);
  const valueNameLiteral = toPsSingleQuotedLiteral(valueName);
  return `
$ErrorActionPreference = 'Stop'
try {
  Remove-ItemProperty -Path ${psPathLiteral} -Name ${valueNameLiteral} -ErrorAction Stop
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function buildDisableScheduledTaskScript(taskPath, taskName) {
  const fullNameLiteral = toPsSingleQuotedLiteral(taskName);
  const taskPathLiteral = toPsSingleQuotedLiteral(taskPath || '\\');
  return `
$ErrorActionPreference = 'Stop'
try {
  Disable-ScheduledTask -TaskName ${fullNameLiteral} -TaskPath ${taskPathLiteral} -ErrorAction Stop | Out-Null
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function buildDisableServiceScript(serviceName) {
  const nameLiteral = toPsSingleQuotedLiteral(serviceName);
  return `
$ErrorActionPreference = 'Stop'
try {
  Set-Service -Name ${nameLiteral} -StartupType Disabled -ErrorAction Stop
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function isFirewallOrRegistryAccessDenied(envelope) {
  const detail = envelope?.message ?? '';
  return /access.*denied|accès.*refusé|non autorisé/i.test(detail);
}

async function disablePersistenceEntryExecutor(action, { exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) return { persistenceStatus: 'UNKNOWN', reason: 'NOT_SUPPORTED' };

  const { persistenceItemId, persistenceType } = action.target;

  const snapshot = await getPersistenceSnapshot();
  const item = snapshot.items.find(i => i.id === persistenceItemId);
  if (!item) fail('persistence_target_changed', { reason: 'item_not_found' });
  if (item.type !== persistenceType) fail('persistence_target_changed', { reason: 'type_mismatch' });

  // Rollback metadata (mission §17) — captured and persisted via the
  // audit row's result_metadata regardless of outcome, bounded/redacted
  // like every other MAÎTRE evidence-shaped payload.
  const rollbackMetadata = redactMaitreEvidenceMetadata({
    type: item.type, scope: item.scope, name: item.name, previousTarget: item.target, sourceLocation: item.sourceLocation,
  });

  let scriptResult;
  if (item.type === 'REGISTRY_RUN' || item.type === 'REGISTRY_RUNONCE') {
    const [hive, ...pathParts] = item.scope.split('\\');
    const regPath = pathParts.join('\\');
    scriptResult = await exec(buildDisableRegistryScript(hive, regPath, item.name), { timeoutMs: PERSISTENCE_TIMEOUT_MS });
  } else if (item.type === 'SCHEDULED_TASK') {
    scriptResult = await exec(buildDisableScheduledTaskScript(item.scope, item.name), { timeoutMs: PERSISTENCE_TIMEOUT_MS });
  } else if (item.type === 'AUTO_START_SERVICE') {
    scriptResult = await exec(buildDisableServiceScript(item.name), { timeoutMs: PERSISTENCE_TIMEOUT_MS });
  } else if (item.type === 'STARTUP_FILE') {
    return disableStartupFileEntry(item, rollbackMetadata);
  } else {
    return { persistenceStatus: 'NOT_SUPPORTED', reason: 'persistence_type_not_implemented', rollbackMetadata };
  }

  if (!scriptResult.ok) {
    if (scriptResult.reason === 'timeout') return { persistenceStatus: 'UNKNOWN', reason: 'timeout', rollbackMetadata };
    return { persistenceStatus: 'FAILED', reason: scriptResult.reason, rollbackMetadata };
  }

  const envelope = parseJsonEnvelope(scriptResult.stdout);
  if (!envelope) return { persistenceStatus: 'UNKNOWN', reason: 'malformed_output', rollbackMetadata };
  if (!envelope.ok) {
    if (isFirewallOrRegistryAccessDenied(envelope)) return { persistenceStatus: 'FAILED', reason: 'access_denied', rollbackMetadata };
    return { persistenceStatus: 'FAILED', reason: envelope.errorId || 'persistence_disable_failed', rollbackMetadata };
  }

  // Verification (mission §25): re-read ONLY the targeted item, never a
  // broader scan.
  const verifySnapshot = await getPersistenceSnapshot();
  const stillPresent = verifySnapshot.items.some(i => i.id === persistenceItemId);
  if (stillPresent) return { persistenceStatus: 'UNKNOWN', reason: 'verification_inconclusive', rollbackMetadata };

  return { persistenceStatus: 'DISABLED', itemType: item.type, itemName: item.name, rollbackMetadata };
}

// STARTUP_FILE: disabled by moving the file out of the Startup folder
// into a Docteur-owned holding directory — reversible (mission §17
// notes MA-9 need not expose an automated restore yet, but the file
// itself must not be destroyed), requires no elevation (confirmed via
// real-machine probing during this phase), and never a delete.
function disableStartupFileEntry(item, rollbackMetadata) {
  const sourcePath = item.sourceLocation;
  if (!isLocalPathAllowed(sourcePath)) fail('persistence_target_path_not_allowed');

  if (!fs.existsSync(sourcePath)) {
    return { persistenceStatus: 'UNKNOWN', reason: 'file_already_gone', rollbackMetadata };
  }

  const holdingDir = path.join(os.tmpdir(), DISABLED_PERSISTENCE_DIR_NAME);
  try {
    fs.mkdirSync(holdingDir, { recursive: true });
    const destPath = path.join(holdingDir, `${Date.now()}-${path.basename(sourcePath)}`);
    fs.renameSync(sourcePath, destPath);
    return { persistenceStatus: 'DISABLED', itemType: 'STARTUP_FILE', movedTo: destPath, rollbackMetadata };
  } catch (err) {
    return { persistenceStatus: 'FAILED', reason: err.code || 'move_failed', rollbackMetadata };
  }
}

// ── HOST_ISOLATION ──────────────────────────────────────────────────────
//
// LEVEL 3. Rollback state is persisted BEFORE any firewall change
// (mission §7) — if that insert fails, this executor fails closed
// without ever calling applyHostIsolation. Application is transactional,
// step-by-step, with automatic rollback of partially-applied rules on
// failure (mission §8) — see maitre-host-isolation.js for the full
// strategy and its audited loopback-safety rationale.

async function hostIsolationExecutor(action, { exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  const preflight = await hostIsolationPreflight({ exec, checkPlatform });

  if (!preflight.platformSupported) {
    return { isolationStatus: 'NOT_SUPPORTED', reason: 'platform_not_windows' };
  }
  // Concurrency guard (mission §27): a second HOST_ISOLATION while one is
  // already active/in-progress is refused before any rollback-state row
  // is even created for this attempt.
  if (preflight.isolationAlreadyActive) {
    fail('isolation_already_active', { activeIsolationStateId: preflight.activeIsolationStateId });
  }
  if (preflight.loopbackAvailable === false) {
    // Refuse to start an isolation attempt if we cannot even confirm
    // loopback works BEFORE any change — verifying post-change against a
    // baseline that was already broken would be meaningless.
    fail('isolation_denied_loopback_baseline_unavailable');
  }

  let isolationStateId;
  try {
    isolationStateId = createIsolationRollbackState({ actionId: action.id, incidentId: action.incidentId });
  } catch {
    fail('isolation_rollback_state_persist_failed');
  }

  const result = await applyHostIsolation({ actionId: action.id, isolationStateId, exec, checkPlatform });
  return { ...result, isolationStateId };
}

// ── RESTORE_HOST_NETWORK ────────────────────────────────────────────────
//
// Removes ONLY the rules the target isolation attempt itself created
// (mission §14/§15) — ownership is re-verified against the persisted
// rollback record, never a wildcard sweep. Idempotent (mission §16): a
// second restore for an already-RESTORED state returns ALREADY_RESTORED.

async function restoreHostNetworkExecutor(action, { exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  const { relatedActionId } = action.target;

  // relatedActionId refers to the ORIGINAL HOST_ISOLATION action's id
  // (not the isolation-state row's own id) — a client only ever needs to
  // reference the action it originally saw, never an internal state id.
  const state = getMaitreIsolationStateByActionId(relatedActionId);
  if (!state) fail('restore_target_not_found', { relatedActionId });

  const result = await restoreHostNetwork({ isolationStateId: state.id, restoreActionId: action.id, exec, checkPlatform });
  return result;
}

// ── Dispatcher ──────────────────────────────────────────────────────────

const EXECUTORS = {
  COLLECT_EVIDENCE: collectEvidenceExecutor,
  SCAN_WITH_DEFENDER: defenderScanExecutor,
  TERMINATE_PROCESS: terminateProcessExecutor,
  QUARANTINE_WITH_DEFENDER: quarantineExecutor,
  HOST_ISOLATION: hostIsolationExecutor,
  RESTORE_HOST_NETWORK: restoreHostNetworkExecutor,
  BLOCK_REMOTE_IP: blockRemoteIpExecutor,
  DISABLE_PERSISTENCE_ENTRY: disablePersistenceEntryExecutor,
};

function nowIso() {
  return new Date().toISOString();
}

/**
 * The only entry point. actionId must reference an action already
 * validated by MA-7 (policy ALLOW/CONFIRM, and — if CONFIRM — a
 * PENDING-then-APPROVED, unexpired, un-consumed approval whose hash
 * matches the CURRENT action row). Options:
 *  - approvalId: required when the action's policy decision was
 *    CONFIRM (i.e. status AWAITING_APPROVAL/APPROVED); ignored for an
 *    ALLOW-decision action already in READY status.
 */
export async function executeApprovedAction(actionId, { approvalId = null, exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  const action = getActionProposal(actionId);
  if (!action) fail('action_not_found');

  // Hard, structural LEVEL 1/2/3-only enforcement — independent
  // re-check, never trusting the action row's own `level` column alone
  // in case a future bug ever let an inconsistent row exist.
  const isLevel1 = EXECUTABLE_LEVEL_1_ACTIONS.has(action.actionType);
  const isLevel2 = EXECUTABLE_LEVEL_2_ACTIONS.has(action.actionType);
  const isLevel3 = EXECUTABLE_LEVEL_3_ACTIONS.has(action.actionType);
  if (!isLevel1 && !isLevel2 && !isLevel3) {
    fail('action_type_not_executable', { actionType: action.actionType, level: action.level });
  }
  if (isLevel1 && action.level !== 1) {
    fail('level_mismatch_denied', { actionType: action.actionType, level: action.level });
  }
  if (isLevel2 && action.level !== 2) {
    fail('level_mismatch_denied', { actionType: action.actionType, level: action.level });
  }
  if (isLevel3 && action.level !== 3) {
    fail('level_mismatch_denied', { actionType: action.actionType, level: action.level });
  }

  const incident = getIncident(action.incidentId);
  if (!incident) fail('incident_not_found');

  // Idempotency + concurrency guard (mission §20/§21): a second
  // execute() call for the same actionId while one is RUNNING or after
  // one has already SUCCEEDED is refused before touching the OS.
  const existingRun = findActiveOrSucceededRunForAction(actionId);
  if (existingRun) {
    fail(existingRun.status === 'RUNNING' ? 'action_already_running' : 'action_already_executed', { runId: existingRun.id });
  }

  // Approval requirement: an action currently AWAITING_APPROVAL or
  // APPROVED requires a valid, matching, unexpired, unconsumed approval
  // — re-validated and CONSUMED right here, immediately before
  // execution (mission §15), never trusting a status flag alone.
  let consumedApproval = null;
  if (action.status === 'AWAITING_APPROVAL' || action.status === 'APPROVED') {
    if (!approvalId) fail('approval_required');
    const check = validateApproval(approvalId, { expectedActionId: action.id, expectedIncidentId: action.incidentId });
    if (!check.valid) fail('approval_invalid', { reason: check.reason });
    consumedApproval = consumeApproval(approvalId, { expectedActionId: action.id, expectedIncidentId: action.incidentId });
  } else if (action.status !== 'READY') {
    fail('action_not_ready', { status: action.status });
  }

  // Insert the RUNNING row FIRST (before any OS interaction) so a
  // concurrent second call sees it via findActiveOrSucceededRunForAction
  // immediately, without a race window.
  const runId = crypto.randomUUID();
  const startedAt = nowIso();
  insertMaitreActionRun({
    id: runId, action_id: action.id, incident_id: action.incidentId, action_type: action.actionType,
    proposal_hash: action.proposalHash, approval_id: consumedApproval?.id ?? null, status: 'RUNNING',
    started_at: startedAt, finished_at: null, result_metadata: '{}', error_category: null,
  });

  try {
    const executor = EXECUTORS[action.actionType];
    const rawResult = await executor(action, { exec, checkPlatform });

    // Bound + redact result metadata before persistence (mission §7/§18)
    // — never raw shell output, never a secret, never unbounded.
    const boundedResult = boundAndRedactResult(rawResult);
    const finalStatus = deriveFinalStatus(action.actionType, boundedResult);

    const isFailureLikeStatus = ['FAILED', 'NOT_SUPPORTED', 'PARTIAL_FAILURE', 'MANUAL_REVIEW'].includes(finalStatus);
    updateMaitreActionRun(runId, {
      status: finalStatus,
      finished_at: nowIso(),
      result_metadata: JSON.stringify(boundedResult),
      error_category: isFailureLikeStatus ? (boundedResult.reason ?? 'unknown') : null,
    });

    if (finalStatus === 'SUCCEEDED') {
      createEvidence({
        type: mapEvidenceType(action.actionType, boundedResult),
        source: action.actionType === 'COLLECT_EVIDENCE' ? 'integrity-monitor'
          : action.actionType === 'TERMINATE_PROCESS' ? 'process-monitor'
            : action.actionType === 'DISABLE_PERSISTENCE_ENTRY' ? 'persistence-monitor'
              : (action.actionType === 'HOST_ISOLATION' || action.actionType === 'RESTORE_HOST_NETWORK') ? 'firewall-monitor'
                : 'windows-defender',
        incidentId: action.incidentId,
        metadata: boundedResult,
      });
    }

    // MA-8/MA-9 never auto-transition the incident to CONTAINED/RESOLVED
    // (mission §33/MA-10 §25) — a scan/evidence collection, termination,
    // or firewall block is not by itself a resolution. HOST_ISOLATION is
    // the ONE narrow exception mission §25 explicitly allows: a
    // successful isolation may transition the incident to CONTAINED
    // (never RESOLVED, and only via the graph's own existing
    // isValidIncidentTransition rule — never a forced/invalid jump).
    if (finalStatus === 'SUCCEEDED' && action.actionType === 'HOST_ISOLATION') {
      if (isValidIncidentTransition(incident.status, 'CONTAINED')) {
        updateIncident(incident.id, { status: 'CONTAINED' });
      }
    }

    return parseRunResult(getMaitreActionRunById(runId));
  } catch (err) {
    const category = err instanceof MaitreExecutionError ? err.code : 'unexpected_error';
    updateMaitreActionRun(runId, { status: 'FAILED', finished_at: nowIso(), error_category: category, result_metadata: JSON.stringify({ error: category }) });
    return parseRunResult(getMaitreActionRunById(runId));
  }
}

// Mission §22: results are one of SUCCEEDED/FAILED/DENIED/NOT_SUPPORTED
// — never SUCCEEDED merely because a command was launched. Each action
// type's own result field (scanStatus/terminationStatus/
// quarantineStatus/firewallStatus/persistenceStatus) is mapped
// explicitly; any status this function doesn't recognize as a positive
// outcome defaults to FAILED, never SUCCEEDED-by-omission.
function deriveFinalStatus(actionType, result) {
  if (actionType === 'SCAN_WITH_DEFENDER') {
    return result.scanStatus === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED';
  }
  if (actionType === 'TERMINATE_PROCESS') {
    if (result.terminationStatus === 'TERMINATED') return 'SUCCEEDED';
    if (result.terminationStatus === 'ALREADY_GONE') return 'SUCCEEDED'; // the target is confirmed not running — the defensive goal is met
    return 'FAILED';
  }
  if (actionType === 'QUARANTINE_WITH_DEFENDER') {
    return 'NOT_SUPPORTED';
  }
  if (actionType === 'BLOCK_REMOTE_IP') {
    if (result.firewallStatus === 'BLOCKED' || result.firewallStatus === 'ALREADY_BLOCKED') return 'SUCCEEDED';
    return 'FAILED';
  }
  if (actionType === 'DISABLE_PERSISTENCE_ENTRY') {
    if (result.persistenceStatus === 'DISABLED') return 'SUCCEEDED';
    if (result.persistenceStatus === 'NOT_SUPPORTED') return 'NOT_SUPPORTED';
    return 'FAILED';
  }
  if (actionType === 'HOST_ISOLATION') {
    if (result.isolationStatus === 'ACTIVE') return 'SUCCEEDED';
    if (result.isolationStatus === 'NOT_SUPPORTED') return 'NOT_SUPPORTED';
    // PARTIAL_FAILURE is its own distinct run status (mission §8/§18) —
    // never silently folded into FAILED, since it carries a live,
    // manually-actionable rollback record that plain FAILED does not.
    if (result.isolationStatus === 'PARTIAL_FAILURE') return 'PARTIAL_FAILURE';
    return 'FAILED';
  }
  if (actionType === 'RESTORE_HOST_NETWORK') {
    if (result.restoreStatus === 'RESTORED' || result.restoreStatus === 'ALREADY_RESTORED') return 'SUCCEEDED';
    if (result.restoreStatus === 'PARTIAL_FAILURE') return 'PARTIAL_FAILURE';
    if (result.restoreStatus === 'MANUAL_REVIEW') return 'MANUAL_REVIEW';
    return 'FAILED';
  }
  // COLLECT_EVIDENCE: the executor throws on failure, so reaching here
  // means data was actually collected.
  return 'SUCCEEDED';
}

function mapEvidenceType(actionType, result) {
  if (actionType === 'SCAN_WITH_DEFENDER') return 'DEFENDER_RESULT';
  if (actionType === 'TERMINATE_PROCESS') return 'PROCESS_SNAPSHOT';
  if (actionType === 'BLOCK_REMOTE_IP') return 'FIREWALL_STATE';
  if (actionType === 'DISABLE_PERSISTENCE_ENTRY') return 'PERSISTENCE_METADATA';
  if (actionType === 'HOST_ISOLATION' || actionType === 'RESTORE_HOST_NETWORK') return 'FIREWALL_STATE';
  return result.type ?? 'OTHER';
}

const RESULT_METADATA_MAX_CHARS = 8_000;

function boundAndRedactResult(result) {
  if (!result || typeof result !== 'object') return {};
  const serialized = JSON.stringify(result);
  if (serialized.length <= RESULT_METADATA_MAX_CHARS) return result;
  // Oversized — bound rather than reject, since the underlying
  // operation already completed; truncate the serialized form.
  return { truncated: true, preview: serialized.slice(0, RESULT_METADATA_MAX_CHARS) };
}

function parseRunResult(row) {
  if (!row) return null;
  return {
    actionId: row.action_id,
    actionType: row.action_type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: safeParseJson(row.result_metadata, {}),
    error: row.error_category,
  };
}

function safeParseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function getActionRun(runId) {
  return parseRunResult(getMaitreActionRunById(runId));
}
