/**
 * Startup guard for a single canonical Cortex instance on env.PORT.
 *
 * Reuses MAITRE's existing runReadOnlyPowerShell() (fixed script text,
 * shell:false, hard timeout, bounded output) — no new PowerShell-invocation
 * pattern is introduced here, only a new fixed script through the same
 * already-audited execution path.
 *
 * Never kills anything. On an occupied port this only classifies the owner
 * (recognized Cortex vs. unknown process) and returns that classification;
 * the caller decides whether to refuse startup. There is no switch to a
 * different port — the frontend expects env.PORT specifically.
 *
 * Fail-closed: a probe that errors (Access Denied under a restricted/sandbox
 * account, PowerShell missing, timeout, unparseable output) is NEVER read as
 * "nobody is listening". When the primary Get-NetTCPConnection probe can't
 * give an answer, the OS listener table is read a second way (netstat.exe,
 * execFile with constant arguments). If neither gives an answer the result
 * is 'undetermined', never 'free'.
 */
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import path from 'node:path';
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral, MAX_OUTPUT_BYTES } from './maitre-windows-exec.js';

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const NETSTAT_EXE = path.join(SYSTEM_ROOT, 'System32', 'NETSTAT.EXE');
// Constant argument vector — nothing caller-supplied ever reaches netstat;
// the host/port filter is applied in JS on the parsed rows.
const NETSTAT_ARGS = Object.freeze(['-a', '-n', '-o']);
const PROBE_TIMEOUT_MS = 5_000;

// Kept intentionally small: only what's needed to tell a Docteur cortex-server
// process apart from an unrelated one also bound to the same port.
// Uses ConvertTo-Json rather than hand-built JSON strings — safe against
// backslashes (Windows paths) and quotes in CommandLine/ExecutablePath
// without needing multi-layer manual escaping across JS-template-literal →
// PowerShell-string → regex-replace boundaries.
//
// Listeners are enumerated WITHOUT a -LocalPort filter and filtered in
// PowerShell: Get-NetTCPConnection signals "no match" with an error, which
// is indistinguishable at this level from Access Denied. Enumerating every
// listener means any error at all is a probe failure, and an empty listener
// table (impossible on a live Windows host: RPC/SMB always listen) is also
// treated as a failed probe rather than as "port free".
const OWNER_SCRIPT = (host, port) => `
$ErrorActionPreference = 'Stop'
try {
  $all = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
} catch {
  Write-Output (@{probeFailed=$true; category=[string]$_.CategoryInfo.Category} | ConvertTo-Json -Compress); exit 0
}
if ($all.Count -eq 0) { Write-Output (@{probeFailed=$true; category='EmptyListenerTable'} | ConvertTo-Json -Compress); exit 0 }
$conn = $all | Where-Object { $_.LocalAddress -eq ${toPsSingleQuotedLiteral(host)} -and $_.LocalPort -eq ${Number(port)} } | Select-Object -First 1
if (-not $conn) { Write-Output (@{listening=$false} | ConvertTo-Json -Compress); exit 0 }
$proc = $null
try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$conn.OwningProcess)" -ErrorAction Stop } catch { $proc = $null }
if (-not $proc) { Write-Output (@{listening=$true; pid=[int]$conn.OwningProcess; unknown=$true} | ConvertTo-Json -Compress); exit 0 }
Write-Output (@{listening=$true; pid=$proc.ProcessId; name=$proc.Name; exe=$proc.ExecutablePath; cmdLine=$proc.CommandLine} | ConvertTo-Json -Compress)
`;

// Identity lookup for a PID found by the netstat probe. pid is validated as
// a positive integer before it is embedded.
const PROCESS_SCRIPT = (pid) => `
$ErrorActionPreference = 'Stop'
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction Stop
if (-not $proc) { Write-Output (@{found=$false} | ConvertTo-Json -Compress); exit 0 }
Write-Output (@{found=$true; pid=$proc.ProcessId; name=$proc.Name; exe=$proc.ExecutablePath; cmdLine=$proc.CommandLine} | ConvertTo-Json -Compress)
`;

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isPositivePid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Runs netstat.exe -a -n -o (constant argv, shell:false, hard timeout,
 * bounded output). Returns { ok: true, stdout } or { ok: false, reason }.
 */
export function runNetstatListing({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      NETSTAT_EXE,
      NETSTAT_ARGS,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, shell: false, encoding: 'latin1' },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, reason: err.killed ? 'timeout' : 'exec_failed', detail: String(err.message || '').slice(0, 500) });
          return;
        }
        resolve({ ok: true, stdout: String(stdout) });
      },
    );
  });
}

function splitEndpoint(endpoint) {
  const idx = endpoint.lastIndexOf(':');
  if (idx <= 0) return null;
  let address = endpoint.slice(0, idx);
  const portText = endpoint.slice(idx + 1);
  if (!/^\d+$/.test(portText)) return null;
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  return { address: address.toLowerCase(), port: Number(portText) };
}

/**
 * Parses `netstat -ano` output into TCP listener rows. Header lines are
 * localized (e.g. "Adresse locale") and ignored; only the ASCII data columns
 * are read. A row counts as a listener when its state column says LISTENING
 * or its remote endpoint is the wildcard ":0" (locale-independent: only
 * listening TCP sockets have no remote port).
 * Returns { tcpRows, listeners: [{ address, port, pid }] }.
 */
export function parseNetstatListeners(text) {
  const listeners = [];
  let tcpRows = 0;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const cols = rawLine.trim().split(/\s+/);
    if (cols.length < 4 || cols[0].toUpperCase() !== 'TCP') continue;
    const local = splitEndpoint(cols[1]);
    const remote = splitEndpoint(cols[2]);
    if (!local || !remote) continue;
    tcpRows++;
    const pidText = cols[cols.length - 1];
    const state = cols.length >= 5 ? cols[3].toUpperCase() : '';
    const isListen = state.startsWith('LISTEN') || remote.port === 0;
    if (!isListen) continue;
    const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
    listeners.push({ address: local.address, port: local.port, pid });
  }
  return { tcpRows, listeners };
}

function classifyOwner({ pid, name, cmdLine }) {
  if (!cmdLine) {
    return { state: 'owned_by_unknown', pid: pid ?? null, name: name ?? null, cmdLine: null };
  }
  const text = String(cmdLine);
  // npm's "start"/"dev" scripts invoke Node with a path RELATIVE to
  // cortex-server/ (e.g. "node  src/server.js", "node ... nodemon ...
  // src/server.js") since npm already cd's into that package directory —
  // the command line never contains the literal "cortex-server" segment.
  // Both the relative in-package form and a fully-qualified absolute path
  // are accepted; either way the entry point must be src/server.js itself,
  // never a bare "node.exe" match (many unrelated Node processes exist).
  const mentionsServerEntry = /[\\/]?src[\\/]server\.js/i.test(text);
  const mentionsNode = /node(\.exe)?["'\s]/i.test(text);
  const mentionsNodemon = /nodemon/i.test(text);
  const isCortexEntry = mentionsServerEntry && (mentionsNode || mentionsNodemon);

  if (isCortexEntry) {
    return { state: 'owned_by_cortex', pid, cmdLine: text };
  }
  return { state: 'owned_by_unknown', pid, name: name ?? null, cmdLine: text };
}

function parseJsonLine(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? '').trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function probeWithPowerShell(host, port, runPowerShell) {
  let result;
  try {
    result = await runPowerShell(OWNER_SCRIPT(host, port), { timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return { conclusive: false, reason: 'powershell_unavailable' };
  }
  if (!result?.ok) return { conclusive: false, reason: `powershell_${result?.reason ?? 'failed'}` };
  const parsed = parseJsonLine(result.stdout);
  if (!parsed) return { conclusive: false, reason: 'powershell_unparseable' };
  if (parsed.probeFailed) return { conclusive: false, reason: 'powershell_probe_failed', category: parsed.category ?? null };
  if (parsed.listening === false) return { conclusive: true, owner: { state: 'free' } };
  if (parsed.listening !== true) return { conclusive: false, reason: 'powershell_unparseable' };
  const pid = Number(parsed.pid);
  if (parsed.unknown || !parsed.cmdLine) {
    return { conclusive: true, owner: { state: 'owned_by_unknown', pid: isPositivePid(pid) ? pid : null, name: parsed.name ?? null, cmdLine: parsed.cmdLine ?? null } };
  }
  return { conclusive: true, owner: classifyOwner({ pid, name: parsed.name, cmdLine: parsed.cmdLine }) };
}

async function identifyPid(pid, runPowerShell) {
  if (!isPositivePid(pid)) return null;
  try {
    const result = await runPowerShell(PROCESS_SCRIPT(pid), { timeoutMs: PROBE_TIMEOUT_MS });
    if (!result?.ok) return null;
    const parsed = parseJsonLine(result.stdout);
    if (!parsed?.found) return null;
    return { name: parsed.name ?? null, cmdLine: parsed.cmdLine ?? null };
  } catch {
    return null;
  }
}

async function probeWithNetstat(host, port, runNetstat, runPowerShell) {
  // netstat rows can only be matched against an IP literal; a hostname can't
  // be compared, so no conclusion is possible from this probe.
  if (!isIP(String(host))) return { conclusive: false, reason: 'netstat_host_not_ip' };
  let result;
  try {
    result = await runNetstat({ timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return { conclusive: false, reason: 'netstat_unavailable' };
  }
  if (!result?.ok) return { conclusive: false, reason: `netstat_${result?.reason ?? 'failed'}` };
  const { tcpRows, listeners } = parseNetstatListeners(result.stdout);
  // An empty/garbled table is not evidence of a free port.
  if (tcpRows === 0 || listeners.length === 0) return { conclusive: false, reason: 'netstat_unparseable' };

  const wanted = String(host).toLowerCase();
  const match = listeners.find((row) => row.address === wanted && row.port === port);
  if (!match) return { conclusive: true, owner: { state: 'free' } };

  const identity = await identifyPid(match.pid, runPowerShell);
  const pid = isPositivePid(match.pid) ? match.pid : null;
  if (!identity) return { conclusive: true, owner: { state: 'owned_by_unknown', pid, name: null, cmdLine: null } };
  return { conclusive: true, owner: classifyOwner({ pid, name: identity.name, cmdLine: identity.cmdLine }) };
}

/**
 * Returns one of:
 *  - { state: 'free' }                                  — a probe positively saw no listener
 *  - { state: 'owned_by_cortex', pid, cmdLine }         — a recognized cortex-server process
 *  - { state: 'owned_by_unknown', pid, name, cmdLine }  — occupied by something else (or owner unidentifiable)
 *  - { state: 'undetermined', reason, probes }          — no probe could answer; NOT a free port
 *
 * "Recognized" means: the owning process's command line invokes Node on a
 * path ending in cortex-server's own src/server.js — the same entry point
 * every start/dev npm script in this package resolves to. This intentionally
 * does not trust process name alone ("node.exe" is not sufficient, per the
 * mission's own instruction — many unrelated Node processes can be running).
 *
 * The third argument is for tests only (probe injection); production callers
 * pass (host, port).
 */
export async function checkPortOwnership(host, port, {
  windows = isWindows(),
  runPowerShell = runReadOnlyPowerShell,
  runNetstat = runNetstatListing,
} = {}) {
  if (!windows) return { state: 'undetermined', reason: 'not_windows', probes: [] };
  const portNumber = Number(port);
  if (!isValidPort(portNumber)) return { state: 'undetermined', reason: 'invalid_port', probes: [] };

  const probes = [];
  const primary = await probeWithPowerShell(host, portNumber, runPowerShell);
  if (primary.conclusive) return primary.owner;
  probes.push(primary.reason);

  const secondary = await probeWithNetstat(host, portNumber, runNetstat, runPowerShell);
  if (secondary.conclusive) return secondary.owner;
  probes.push(secondary.reason);

  return { state: 'undetermined', reason: 'all_probes_failed', probes };
}
