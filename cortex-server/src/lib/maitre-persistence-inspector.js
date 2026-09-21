/**
 * MAÎTRE — persistence inspector. READ-ONLY metadata only: no registry
 * write/delete/create, no scheduled-task modification, no service
 * modification. Targeted, explainable scope (mission §14/§16) — this
 * is NOT an exhaustive persistence-hunting framework, only the small
 * set of locations listed in REGISTRY_RUN_KEYS below plus Startup
 * folders / scheduled tasks / auto-start services.
 *
 * A new/changed persistence entry is an OBSERVATION, never a verdict —
 * comparePersistenceSnapshots() reports NEW/CHANGED/REMOVED/UNCHANGED
 * only; correlation/anomaly judgment belongs to a later MA phase.
 */
import crypto from 'node:crypto';
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral } from './maitre-windows-exec.js';
import { redactMaitreEvidenceMetadata } from './maitre-evidence.js';

// Closed, explicit registry scope (mission §16) — read-only, no
// WOW6432Node support yet (not "explicitly tested" per the mission's
// own gate on adding it).
export const REGISTRY_RUN_KEYS = Object.freeze([
  { hive: 'HKCU', path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', type: 'REGISTRY_RUN' },
  { hive: 'HKCU', path: 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', type: 'REGISTRY_RUNONCE' },
  { hive: 'HKLM', path: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', type: 'REGISTRY_RUN' },
  { hive: 'HKLM', path: 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', type: 'REGISTRY_RUNONCE' },
]);

const SCHEDULED_TASKS_LIMIT = 200;
const SERVICES_LIMIT = 500;

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

function makeId(type, scope, name) {
  return crypto.createHash('sha256').update(`${type}:${scope}:${name}`).digest('hex').slice(0, 32);
}

// ── Registry Run / RunOnce ─────────────────────────────────────────────────

function buildRegistryScript(hive, regPath) {
  // PS registry-drive path uses ':' after the hive name (HKCU:, HKLM:)
  // — hive is always one of the two fixed literals above, never
  // interpolated from external input.
  const psPath = `${hive}:\\${regPath}`;
  const psPathLiteral = toPsSingleQuotedLiteral(psPath);
  return `
$ErrorActionPreference = 'Stop'
try {
  $item = Get-ItemProperty -Path ${psPathLiteral} -ErrorAction Stop
  $names = $item.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS(Path|ParentPath|ChildName|Provider)$' } | ForEach-Object { @{ name = $_.Name; value = "$($_.Value)" } }
  @{ ok = $true; entries = @($names) } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

/**
 * Reads all four fixed Run/RunOnce locations. A missing key (common —
 * RunOnce is often empty) is a valid empty result, not an error.
 */
export async function getRegistryRunEntries({ exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', items: [] };
  }

  const items = [];
  const warnings = [];

  for (const key of REGISTRY_RUN_KEYS) {
    const result = await exec(buildRegistryScript(key.hive, key.path));
    if (!result.ok) {
      warnings.push({ key: `${key.hive}\\${key.path}`, reason: result.reason });
      continue;
    }
    const envelope = parseJsonEnvelope(result.stdout);
    if (!envelope) {
      warnings.push({ key: `${key.hive}\\${key.path}`, reason: 'malformed_output' });
      continue;
    }
    if (!envelope.ok) {
      // PathNotFound (key doesn't exist) is a valid empty state, not a warning.
      if (!envelope.errorId || !envelope.errorId.startsWith('PathNotFound')) {
        warnings.push({ key: `${key.hive}\\${key.path}`, reason: envelope.errorId || 'read_failed' });
      }
      continue;
    }

    const entries = Array.isArray(envelope.entries) ? envelope.entries : envelope.entries ? [envelope.entries] : [];
    for (const entry of entries) {
      const scope = `${key.hive}\\${key.path}`;
      items.push({
        id: makeId(key.type, scope, entry.name),
        type: key.type,
        scope,
        name: entry.name,
        target: entry.value,
        sourceLocation: scope,
        metadata: redactMaitreEvidenceMetadata({ hive: key.hive, path: key.path }),
      });
    }
  }

  return { available: true, items, warnings };
}

// ── Startup folders ─────────────────────────────────────────────────────

const STARTUP_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $paths = @(
    @{ scope = 'current-user'; path = [Environment]::GetFolderPath('Startup') },
    @{ scope = 'all-users'; path = [Environment]::GetFolderPath('CommonStartup') }
  )
  $results = foreach ($p in $paths) {
    if (Test-Path -LiteralPath $p.path) {
      Get-ChildItem -LiteralPath $p.path -File -ErrorAction SilentlyContinue | ForEach-Object {
        @{ scope = $p.scope; name = $_.Name; fullName = $_.FullName; createdAt = $_.CreationTime; modifiedAt = $_.LastWriteTime; length = $_.Length }
      }
    }
  }
  @{ ok = $true; items = @($results) } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

export async function getStartupFolderItems({ exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', items: [] };
  }

  const result = await exec(STARTUP_SCRIPT);
  if (!result.ok) return { available: false, reason: result.reason, items: [] };

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { available: false, reason: 'malformed_output', items: [] };
  if (!envelope.ok) return { available: false, reason: envelope.errorId || 'startup_read_failed', items: [] };

  const raw = Array.isArray(envelope.items) ? envelope.items : envelope.items ? [envelope.items] : [];
  const items = raw.map(r => ({
    id: makeId('STARTUP_FILE', r.scope, r.name),
    type: 'STARTUP_FILE',
    scope: r.scope,
    name: r.name,
    target: r.fullName,
    sourceLocation: r.fullName,
    metadata: { createdAt: parseMsDate(r.createdAt), modifiedAt: parseMsDate(r.modifiedAt), sizeBytes: r.length ?? null },
  }));

  return { available: true, items };
}

// ── Scheduled tasks ─────────────────────────────────────────────────────

const SCHEDULED_TASKS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $tasks = Get-ScheduledTask | Select-Object -First ${SCHEDULED_TASKS_LIMIT}
  $results = foreach ($t in $tasks) {
    $actionExe = ($t.Actions | Select-Object -First 1).Execute
    @{ taskName = $t.TaskName; taskPath = $t.TaskPath; state = [int]$t.State; author = $t.Author; actionExecutable = $actionExe }
  }
  @{ ok = $true; items = @($results) } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

const TASK_STATE_MAP = { 0: 'Unknown', 1: 'Disabled', 2: 'Queued', 3: 'Ready', 4: 'Running' };

export async function getScheduledTasks({ exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', items: [] };
  }

  const result = await exec(SCHEDULED_TASKS_SCRIPT);
  if (!result.ok) return { available: false, reason: result.reason, items: [] };

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { available: false, reason: 'malformed_output', items: [] };
  if (!envelope.ok) return { available: false, reason: envelope.errorId || 'scheduled_tasks_read_failed', items: [] };

  const raw = Array.isArray(envelope.items) ? envelope.items : envelope.items ? [envelope.items] : [];
  const items = raw.slice(0, SCHEDULED_TASKS_LIMIT).map(r => ({
    id: makeId('SCHEDULED_TASK', r.taskPath, r.taskName),
    type: 'SCHEDULED_TASK',
    scope: r.taskPath ?? '\\',
    name: r.taskName,
    target: r.actionExecutable ?? null,
    sourceLocation: `${r.taskPath ?? ''}${r.taskName ?? ''}`,
    metadata: redactMaitreEvidenceMetadata({ state: TASK_STATE_MAP[r.state] ?? 'Unknown', author: r.author ?? null }),
  }));

  return { available: true, items };
}

// ── Auto-start services ─────────────────────────────────────────────────

const SERVICES_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $svcs = Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' } | Select-Object -First ${SERVICES_LIMIT} Name, DisplayName, State, StartMode, PathName, StartName
  @{ ok = $true; items = @($svcs) } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

export async function getAutoStartServices({ exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED', items: [] };
  }

  const result = await exec(SERVICES_SCRIPT);
  if (!result.ok) return { available: false, reason: result.reason, items: [] };

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { available: false, reason: 'malformed_output', items: [] };
  if (!envelope.ok) return { available: false, reason: envelope.errorId || 'services_read_failed', items: [] };

  const raw = Array.isArray(envelope.items) ? envelope.items : envelope.items ? [envelope.items] : [];
  const items = raw.slice(0, SERVICES_LIMIT).map(r => ({
    id: makeId('AUTO_START_SERVICE', r.Name, r.Name),
    type: 'AUTO_START_SERVICE',
    scope: 'local-machine',
    name: r.Name,
    target: r.PathName ?? null,
    sourceLocation: r.Name,
    metadata: redactMaitreEvidenceMetadata({ displayName: r.DisplayName ?? null, state: r.State ?? null, startMode: r.StartMode ?? null, account: r.StartName ?? null }),
  }));

  return { available: true, items };
}

/**
 * Convenience aggregate — calls all four inspectors and flattens into
 * one PersistenceItem[] list, suitable as a "snapshot" for
 * comparePersistenceSnapshots(). Each sub-call already degrades
 * gracefully; a failure in one source does not block the others.
 */
export async function getPersistenceSnapshot(opts = {}) {
  const [registry, startup, tasks, services] = await Promise.all([
    getRegistryRunEntries(opts),
    getStartupFolderItems(opts),
    getScheduledTasks(opts),
    getAutoStartServices(opts),
  ]);

  return {
    takenAt: new Date().toISOString(),
    items: [
      ...(registry.items ?? []),
      ...(startup.items ?? []),
      ...(tasks.items ?? []),
      ...(services.items ?? []),
    ],
    sourceAvailability: {
      registry: registry.available, startup: startup.available, scheduledTasks: tasks.available, services: services.available,
    },
  };
}

/**
 * Pure function: compares two PersistenceItem[] snapshots by id, never
 * touches the filesystem/registry/OS. Returns
 * { new: [], changed: [], removed: [], unchanged: [] } — a changed
 * item is one whose `target` differs between snapshots (the same id,
 * i.e. same type+scope+name, but a different value). A NEW/CHANGED
 * entry is reported as an observation only — no verdict, no incident.
 */
export function comparePersistenceSnapshots(previousItems, currentItems) {
  const previous = new Map((previousItems ?? []).map(i => [i.id, i]));
  const current = new Map((currentItems ?? []).map(i => [i.id, i]));

  const result = { new: [], changed: [], removed: [], unchanged: [] };

  for (const [id, item] of current) {
    const prior = previous.get(id);
    if (!prior) {
      result.new.push(item);
    } else if (prior.target !== item.target) {
      result.changed.push({ id, previous: prior, current: item });
    } else {
      result.unchanged.push(item);
    }
  }

  for (const [id, item] of previous) {
    if (!current.has(id)) result.removed.push(item);
  }

  return result;
}

/**
 * Pure conversion: a persistence CHANGE (from comparePersistenceSnapshots)
 * becomes a SecurityEvent INPUT — never persisted/incident-created here.
 * Severity is fixed and conservative: NEW/CHANGED registry+service+task
 * entries are OBSERVATION by default (a new persistence entry is
 * common and legitimate — software installers add Run keys constantly)
 * — never a stronger value without further correlation (MA-5).
 */
export function persistenceChangeToSecurityEvent(changeType, item) {
  return {
    source: 'persistence-monitor',
    category: item.type,
    severity: 'OBSERVATION',
    confidence: 'low',
    occurredAt: new Date().toISOString(),
    subject: { name: item.name, scope: item.scope, changeType },
    metadata: redactMaitreEvidenceMetadata({ target: item.target, sourceLocation: item.sourceLocation, ...item.metadata }),
    detectorId: 'maitre-persistence-inspector',
  };
}
