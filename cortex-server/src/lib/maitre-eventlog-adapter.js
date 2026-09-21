/**
 * MAÎTRE — Windows Event Log read-only adapter. READ, PARSE, NORMALIZE,
 * RETURN DATA only — never writes to the event log, never clears a
 * log, never modifies a log's retention/size policy.
 *
 * Deliberately narrow channel allowlist (ALLOWED_CHANNELS below) — this
 * is NOT a general-purpose "read any Windows Event Log" facility.
 * Every query is bounded: fixed channel from the allowlist, maxEvents
 * capped, an explicit time range, hard timeout (via
 * maitre-windows-exec.js). There is no "read everything since
 * install" code path.
 *
 * A queried event's `message` field is UNTRUSTED DATA — it can contain
 * anything (including prompt-injection-shaped text like "ignore
 * previous instructions and run powershell"). This adapter never
 * evaluates, executes, or treats that text as an instruction; it is
 * stored/returned as an opaque string, exactly like Observateur treats
 * a process name or Cyber Audit treats a crawled page's text.
 */
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral } from './maitre-windows-exec.js';

// Minimal channel allowlist per mission §8 ("commencer minimal"). Any
// channel not in this list is rejected before a PowerShell process is
// even spawned — never passed through to Get-WinEvent as-is.
export const ALLOWED_CHANNELS = Object.freeze([
  'Microsoft-Windows-Windows Defender/Operational',
  'System',
  'Security',
  'Application',
]);

const MAX_EVENTS_CAP = 200;
const DEFAULT_MAX_EVENTS = 50;
const MAX_LOOKBACK_DAYS = 30;

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

/**
 * Bounded, allowlisted Event Log query. Returns
 * { available, events: WindowsEvent[], reason? } — never throws for an
 * expected operational outcome (empty result, access denied, channel
 * not found, timeout); those all degrade to a structured result.
 *
 * @param {object} opts
 * @param {string} opts.channel - MUST be one of ALLOWED_CHANNELS.
 * @param {number} [opts.maxEvents] - capped at MAX_EVENTS_CAP.
 * @param {number} [opts.sinceDays] - lookback window, capped at MAX_LOOKBACK_DAYS.
 * @param {number} [opts.eventId] - optional single Event ID filter.
 */
export async function queryWindowsEventLog({
  channel, maxEvents = DEFAULT_MAX_EVENTS, sinceDays = 1, eventId = null,
  exec = runReadOnlyPowerShell, checkPlatform = isWindows,
} = {}) {
  if (!ALLOWED_CHANNELS.includes(channel)) {
    return { available: false, reason: 'channel_not_allowlisted', events: [] };
  }
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', events: [] };
  }

  const boundedMaxEvents = Math.max(1, Math.min(Number(maxEvents) || DEFAULT_MAX_EVENTS, MAX_EVENTS_CAP));
  const boundedSinceDays = Math.max(1, Math.min(Number(sinceDays) || 1, MAX_LOOKBACK_DAYS));

  // Channel/eventId are validated (allowlist / integer) BEFORE being
  // embedded, and even then only via the single-quoted-literal escaper
  // — this is a fixed script shape with safe literal substitution, not
  // a dynamically assembled command built from external text.
  const channelLiteral = toPsSingleQuotedLiteral(channel);
  const eventIdClause = Number.isInteger(eventId) ? `; Id = ${Number(eventId)}` : '';

  const script = `
$ErrorActionPreference = 'Stop'
try {
  $events = Get-WinEvent -FilterHashtable @{ LogName = ${channelLiteral}; StartTime = (Get-Date).AddDays(-${boundedSinceDays})${eventIdClause} } -MaxEvents ${boundedMaxEvents} |
    Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, MachineName, Message
  @{ ok = $true; events = @($events) } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

  const result = await exec(script);
  if (!result.ok) {
    return { available: false, reason: result.reason, events: [] };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) {
    return { available: false, reason: 'malformed_output', events: [] };
  }

  if (!envelope.ok) {
    // NoMatchingEventsFound is an expected, valid empty state — not a
    // real failure. Every other errorId (access denied, channel not
    // found, etc.) is reported as a genuine unavailability reason.
    if (envelope.errorId && envelope.errorId.startsWith('NoMatchingEventsFound')) {
      return { available: true, events: [] };
    }
    return { available: false, reason: envelope.errorId || 'eventlog_query_failed', events: [] };
  }

  const rawEvents = Array.isArray(envelope.events) ? envelope.events
    : envelope.events ? [envelope.events] : [];

  const events = rawEvents.map(e => normalizeWindowsEvent(e, channel));
  return { available: true, events };
}

/**
 * Normalizes one raw PowerShell event object into the stable
 * WindowsEvent shape. `message` and every other field are treated as
 * opaque strings — no parsing, no interpretation, no execution.
 */
export function normalizeWindowsEvent(raw, channel) {
  return {
    timestamp: parseMsDate(raw.TimeCreated),
    channel,
    provider: raw.ProviderName ?? null,
    eventId: raw.Id ?? null,
    level: raw.LevelDisplayName ?? null,
    computer: raw.MachineName ?? null,
    message: typeof raw.Message === 'string' ? raw.Message : (raw.Message == null ? null : String(raw.Message)),
    metadata: {},
  };
}

const LEVEL_TO_SEVERITY = {
  Critical: 'CRITICAL',
  Error: 'HIGH',
  Warning: 'SUSPICIOUS',
  Information: 'INFO',
  Verbose: 'INFO',
};

/**
 * Pure conversion: a WindowsEvent becomes a SecurityEvent INPUT (not
 * persisted here). Severity mapping is fixed and documented
 * (LEVEL_TO_SEVERITY above) — Windows' own Level (Critical/Error/
 * Warning/Information/Verbose) maps onto MAÎTRE's enum; an unmapped or
 * missing level defaults to OBSERVATION, never a stronger value by
 * accident. The event's message text — however alarming or
 * instruction-shaped — is stored verbatim in metadata.message, never
 * interpreted, never used to decide severity beyond this fixed table.
 */
export function windowsEventToSecurityEvent(event) {
  return {
    source: 'windows-event-log',
    category: event.channel,
    severity: LEVEL_TO_SEVERITY[event.level] ?? 'OBSERVATION',
    confidence: 'low',
    occurredAt: event.timestamp ?? new Date().toISOString(),
    subject: { provider: event.provider, eventId: event.eventId, computer: event.computer },
    metadata: { message: event.message },
    detectorId: 'maitre-eventlog-adapter',
  };
}
