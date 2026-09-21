/**
 * MAÎTRE — Windows Defender read-only adapter. READ, PARSE, NORMALIZE,
 * RETURN DATA — nothing else. This file exposes NO scan/quarantine/
 * remediate/setPreference/disable function, even though the underlying
 * Defender PowerShell module offers them (Start-MpScan,
 * Remove-MpThreat, Set-MpPreference, etc.) — those belong to a later
 * MA phase's deterministic executor, gated by approval, never here.
 *
 * Uses Get-MpComputerStatus (status) and Get-MpThreatDetection
 * (detection history) via maitre-windows-exec.js's hardened,
 * fixed-script PowerShell runner. Both cmdlets ship with Windows
 * Defender's own PowerShell module — no extra install, matches
 * secret-store.js's existing "no native dependency" rationale.
 *
 * Windows-only: on any other platform, every exported function
 * resolves to an { available: false, reason: 'NOT_SUPPORTED' } shape
 * without ever touching child_process.
 */
import { isWindows, runReadOnlyPowerShell } from './maitre-windows-exec.js';

// Fixed, Docteur-authored scripts — no interpolation of any external
// value. Always wraps the cmdlet in try/catch and emits ONE JSON
// envelope on stdout so the Node side never has to parse PowerShell's
// own (locale-dependent) error text — only the stable
// $_.FullyQualifiedErrorId string.
const STATUS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $s = Get-MpComputerStatus | Select-Object AMEngineVersion, AMServiceEnabled, AntispywareEnabled, AntivirusEnabled, AntivirusSignatureVersion, AntivirusSignatureLastUpdated, RealTimeProtectionEnabled, NISEnabled, IsTamperProtected, QuickScanEndTime, FullScanEndTime, AMServiceVersion
  @{ ok = $true; status = $s } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

const DETECTIONS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $d = Get-MpThreatDetection | Select-Object -First 50 ThreatID, DetectionID, ThreatName, SeverityID, ActionSuccess, InitialDetectionTime, ProcessName, Resources
  @{ ok = $true; detections = @($d) } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

// PowerShell's ConvertTo-Json renders [DateTime] as the legacy
// "/Date(<ms-since-epoch>)/" ASP.NET JSON format, not ISO 8601. Parsed
// defensively — a null/absent Defender timestamp (e.g. signatures never
// updated) must degrade to null, never throw.
function parseMsDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\/Date\((\d+)\)\/$/);
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

const SEVERITY_ID_MAP = {
  1: 'INFO', 2: 'OBSERVATION', 3: 'SUSPICIOUS', 4: 'HIGH', 5: 'CRITICAL',
};

function mapDefenderSeverity(severityId) {
  return SEVERITY_ID_MAP[Number(severityId)] ?? 'OBSERVATION';
}

/**
 * Returns a normalized DefenderStatus:
 * { available, enabled, realtimeProtection, signatureVersion,
 *   signatureUpdatedAt, engineVersion, lastCheckedAt, warnings }
 * Never throws — degrades to { available: false, reason } on any
 * failure (not installed, access denied, timeout, non-Windows).
 */
export async function getDefenderStatus({ exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  const lastCheckedAt = new Date().toISOString();

  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', lastCheckedAt, warnings: ['platform_not_windows'] };
  }

  const result = await exec(STATUS_SCRIPT);
  if (!result.ok) {
    return { available: false, reason: result.reason, lastCheckedAt, warnings: [result.detail].filter(Boolean) };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) {
    return { available: false, reason: 'malformed_output', lastCheckedAt, warnings: ['could_not_parse_powershell_output'] };
  }

  if (!envelope.ok) {
    return { available: false, reason: envelope.errorId || 'defender_unavailable', lastCheckedAt, warnings: [envelope.message].filter(Boolean) };
  }

  const s = envelope.status ?? {};
  const warnings = [];
  if (s.AntivirusEnabled === false) warnings.push('antivirus_disabled');
  if (s.RealTimeProtectionEnabled === false) warnings.push('realtime_protection_disabled');
  if (s.IsTamperProtected === false) warnings.push('tamper_protection_disabled');

  return {
    available: true,
    enabled: Boolean(s.AntivirusEnabled),
    realtimeProtection: Boolean(s.RealTimeProtectionEnabled),
    signatureVersion: s.AntivirusSignatureVersion ?? null,
    signatureUpdatedAt: parseMsDate(s.AntivirusSignatureLastUpdated),
    engineVersion: s.AMEngineVersion ?? null,
    lastCheckedAt,
    warnings,
  };
}

/**
 * Returns normalized DefenderDetection[] (most recent 50 only — Get-
 * MpThreatDetection itself has no server-side pagination, so the
 * Select-Object -First 50 in the fixed script is the bound). Empty
 * array on "no detections" (a valid, common state), never an error.
 */
export async function getDefenderDetections({ exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', detections: [] };
  }

  const result = await exec(DETECTIONS_SCRIPT);
  if (!result.ok) {
    return { available: false, reason: result.reason, detections: [] };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) {
    return { available: false, reason: 'malformed_output', detections: [] };
  }
  if (!envelope.ok) {
    return { available: false, reason: envelope.errorId || 'defender_unavailable', detections: [] };
  }

  const rawDetections = Array.isArray(envelope.detections) ? envelope.detections
    : envelope.detections ? [envelope.detections] : []; // ConvertTo-Json collapses a 1-item array to a bare object

  const detections = rawDetections.map(d => ({
    id: String(d.DetectionID ?? d.ThreatID ?? ''),
    timestamp: parseMsDate(d.InitialDetectionTime),
    threatName: d.ThreatName ?? null,
    severity: mapDefenderSeverity(d.SeverityID),
    resource: Array.isArray(d.Resources) ? d.Resources[0] ?? null : d.Resources ?? null,
    actionStatus: d.ActionSuccess === true ? 'SUCCEEDED' : d.ActionSuccess === false ? 'FAILED' : 'UNKNOWN',
    source: 'windows-defender',
  }));

  return { available: true, detections };
}

/**
 * Pure conversion: a DefenderDetection becomes a SecurityEvent INPUT
 * (not yet persisted — the caller decides whether/when to call
 * createSecurityEvent from maitre-store.js). Severity mapping is fixed
 * and documented (SEVERITY_ID_MAP above): Defender's own SeverityID
 * (1-5) maps onto MAÎTRE's five-value enum — this NEVER produces
 * "MALWARE"/"ATTACK"/"COMPROMISED" as the severity value, even though
 * detection.threatName (a free-text field from Defender itself, e.g.
 * "Trojan:Win32/Wacatac.B!ml") legitimately contains such words — that
 * text is stored as DATA in metadata.threatName, never promoted to the
 * severity enum.
 */
export function defenderDetectionToSecurityEvent(detection) {
  return {
    source: 'windows-defender',
    category: 'detection',
    severity: detection.severity,
    confidence: 'medium',
    occurredAt: detection.timestamp ?? new Date().toISOString(),
    subject: { resource: detection.resource },
    metadata: { threatName: detection.threatName, actionStatus: detection.actionStatus, defenderDetectionId: detection.id },
    detectorId: 'maitre-defender-adapter',
  };
}
