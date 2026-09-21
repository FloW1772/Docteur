/**
 * MAÎTRE — process inspector. READ-ONLY metadata only: no termination,
 * no suspension, no injection, no arbitrary memory reads, no debugger
 * attach. On-demand inspection only — no watcher, no polling loop, no
 * autostart (mirrors monitor-collector.js's own "no packet capture"
 * discipline, scoped instead to "no process control").
 *
 * Uses Get-CimInstance Win32_Process (structured fields — ProcessId,
 * ParentProcessId, Name, ExecutablePath, CreationDate — never a
 * localized label) via maitre-windows-exec.js's hardened, fixed-script
 * PowerShell runner. Executable path/command line values coming back
 * from Windows are treated as untrusted DATA end to end — never
 * concatenated into a shell command; when a path needs to be reused
 * (e.g. hashFile in maitre-file-inspector.js) it is passed as a
 * separate, escaped literal, never string-glued into a script.
 */
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral } from './maitre-windows-exec.js';
import { getLiveMonitorConnections } from './sqlite.js';
import { redactMaitreEvidenceMetadata } from './maitre-evidence.js';

const LIST_MAX = 500; // hard bound — Win32_Process on a busy machine can return 300+
const CORRELATION_WINDOW_MINUTES = 30;

function parseMsDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\/Date\((\d+)\)\/$/);
  if (!match) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// ── Critical-process classification ───────────────────────────────────────
//
// Purely informational in MA-4 — prepares the ground for a future
// TERMINATE_PROCESS approval gate (a later MA phase) to refuse/require
// stronger confirmation for these. Nothing here can kill anything.
const SYSTEM_CRITICAL_NAMES = new Set([
  'system', 'system idle process', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'lsass.exe', 'services.exe', 'smss.exe', 'registry',
]);
const SYSTEM_CRITICAL_PIDS = new Set([0, 4]);

// Docteur's own known process names — matches the allowlist already
// used by monitor-anomaly.js's DOCTEUR_PROCESS_NAMES for consistency.
const DOCTEUR_PROCESS_NAMES = new Set(['node.exe', 'node']);

export function classifyProcessCriticality({ pid, name }) {
  const lowerName = String(name ?? '').toLowerCase();
  if (SYSTEM_CRITICAL_PIDS.has(Number(pid)) || SYSTEM_CRITICAL_NAMES.has(lowerName)) {
    return 'SYSTEM_CRITICAL';
  }
  if (DOCTEUR_PROCESS_NAMES.has(lowerName)) {
    // Name-only match is necessarily broad (any node.exe looks like
    // Docteur) — that ambiguity is intentional caution: a later phase's
    // approval gate should treat DOCTEUR_CRITICAL as "verify further
    // before touching", not a precise identity proof.
    return 'DOCTEUR_CRITICAL';
  }
  if (name === undefined || name === null || name === '') {
    return 'UNKNOWN';
  }
  return 'NORMAL';
}

// Fixed, Docteur-authored scripts — no interpolation except a validated
// PID (integer, coerced with Number() + Number.isInteger() before ever
// reaching toPsSingleQuotedLiteral/embedding).
const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $procs = Get-CimInstance Win32_Process | Select-Object -First ${LIST_MAX} ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate
  @{ ok = $true; processes = @($procs) } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

function buildInspectScript(pid) {
  return `
$ErrorActionPreference = 'Stop'
try {
  $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate
  if ($null -eq $p) {
    @{ ok = $false; errorId = 'ProcessNotFound' } | ConvertTo-Json -Compress
  } else {
    @{ ok = $true; process = $p } | ConvertTo-Json -Compress -Depth 4
  }
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

/**
 * Normalizes one raw Win32_Process record into the stable shape other
 * MAÎTRE modules consume. executablePath/name are untrusted DATA —
 * returned verbatim as strings, never parsed as instructions.
 */
export function normalizeProcess(raw) {
  return {
    pid: raw.ProcessId ?? null,
    name: raw.Name ?? null,
    executablePath: raw.ExecutablePath ?? null,
    parentPid: raw.ParentProcessId ?? null,
    startTime: parseMsDate(raw.CreationDate),
    criticality: classifyProcessCriticality({ pid: raw.ProcessId, name: raw.Name }),
  };
}

/**
 * Bounded process listing (at most LIST_MAX entries — Win32_Process has
 * no native pagination, so the cap is enforced inside the fixed
 * script's own Select-Object -First). On-demand only, never a
 * background poll.
 */
export async function listProcesses({ exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', processes: [] };
  }

  const result = await exec(LIST_SCRIPT);
  if (!result.ok) {
    return { available: false, reason: result.reason, processes: [] };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { available: false, reason: 'malformed_output', processes: [] };
  if (!envelope.ok) return { available: false, reason: envelope.errorId || 'process_list_failed', processes: [] };

  const rawProcesses = Array.isArray(envelope.processes) ? envelope.processes
    : envelope.processes ? [envelope.processes] : [];

  return { available: true, processes: rawProcesses.slice(0, LIST_MAX).map(normalizeProcess) };
}

/**
 * Inspects a single PID. Returns { available: false, reason:
 * 'process_not_found' } (not a throw) if the PID no longer exists —
 * processes routinely exit between listing and inspection, that is an
 * expected outcome, not an error.
 */
export async function inspectProcess(pid, { exec = runReadOnlyPowerShell, checkPlatform = isWindows, correlateObservateur = true } = {}) {
  const pidNumber = Number(pid);
  if (!Number.isInteger(pidNumber) || pidNumber < 0) {
    return { available: false, reason: 'invalid_pid' };
  }
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED' };
  }

  const result = await exec(buildInspectScript(pidNumber));
  if (!result.ok) {
    return { available: false, reason: result.reason };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { available: false, reason: 'malformed_output' };
  if (!envelope.ok) {
    return { available: false, reason: envelope.errorId === 'ProcessNotFound' ? 'process_not_found' : (envelope.errorId || 'inspect_failed') };
  }

  const process = normalizeProcess(envelope.process);
  const observateurConnections = correlateObservateur ? getObservateurConnectionsForProcess(process) : [];

  return { available: true, process: { ...process, observateurConnections } };
}

/**
 * Reuses Observateur's ALREADY-PERSISTED monitor_connections (via
 * sqlite.js's existing getLiveMonitorConnections) — never re-collects
 * network data, never writes to monitor_*. Correlates by PID first
 * (more precise), falling back to process name (PID reuse across
 * process lifetimes means a name match is weaker evidence, surfaced
 * as-is, not silently upgraded).
 */
export function getObservateurConnectionsForProcess(process) {
  const since = new Date(Date.now() - CORRELATION_WINDOW_MINUTES * 60_000).toISOString();
  const rows = getLiveMonitorConnections(since, 500);
  const byPid = process.pid != null ? rows.filter(r => r.pid === process.pid) : [];
  const matched = byPid.length > 0 ? byPid : rows.filter(r => r.process_name === process.name);
  return matched.map(r => ({
    remoteAddress: r.remote_address,
    remotePort: r.remote_port,
    protocol: r.protocol,
    state: r.state,
    lastSeen: r.last_seen,
  }));
}

/**
 * Pure conversion: a normalized, inspected process becomes a
 * SecurityEvent "subject"-shaped SUBJECT object for correlation input
 * (MA-5) — NOT a full SecurityEvent by itself (a process being
 * inspected is not inherently an event; MA-5's correlation engine
 * decides when/whether to raise one). Command-line-shaped fields, if
 * ever added by a future phase, MUST be redacted before reaching here
 * — this function assumes its input is already inspector-normalized,
 * never raw OS output.
 */
export function processToSecuritySubject(process) {
  return redactMaitreEvidenceMetadata({
    pid: process.pid,
    name: process.name,
    executablePath: process.executablePath,
    parentPid: process.parentPid,
    startTime: process.startTime,
    criticality: process.criticality,
  });
}

/**
 * Pure conversion: an inspected process becomes a SecurityEvent INPUT
 * (not persisted/incident-created here — the caller decides). Severity
 * is always OBSERVATION — merely inspecting a process, however
 * unusual its name/path looks, is never itself evidence of anything;
 * only MA-5's correlation engine may eventually raise a stronger
 * severity from actual corroborating signals (e.g. an Observateur
 * anomaly + an unexpected new process together).
 */
export function processObservationToSecurityEvent(process) {
  return {
    source: 'process-monitor',
    category: 'process-inspection',
    severity: 'OBSERVATION',
    confidence: 'low',
    occurredAt: new Date().toISOString(),
    subject: processToSecuritySubject(process),
    metadata: { observateurConnectionCount: process.observateurConnections?.length ?? 0 },
    detectorId: 'maitre-process-inspector',
  };
}
