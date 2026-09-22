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
 * the caller decides whether to refuse startup. There is no fallback to a
 * different port — the frontend expects env.PORT specifically.
 */
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral } from './maitre-windows-exec.js';

// Kept intentionally small: only what's needed to tell a Docteur cortex-server
// process apart from an unrelated one also bound to the same port.
// Uses ConvertTo-Json rather than hand-built JSON strings — safe against
// backslashes (Windows paths) and quotes in CommandLine/ExecutablePath
// without needing multi-layer manual escaping across JS-template-literal →
// PowerShell-string → regex-replace boundaries.
const OWNER_SCRIPT = (host, port) => `
$ErrorActionPreference = 'SilentlyContinue'
$conn = Get-NetTCPConnection -LocalAddress ${toPsSingleQuotedLiteral(host)} -LocalPort ${Number(port)} -State Listen | Select-Object -First 1
if (-not $conn) { Write-Output (@{listening=$false} | ConvertTo-Json -Compress); exit 0 }
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
if (-not $proc) { Write-Output (@{listening=$true; pid=$conn.OwningProcess; unknown=$true} | ConvertTo-Json -Compress); exit 0 }
Write-Output (@{listening=$true; pid=$proc.ProcessId; name=$proc.Name; exe=$proc.ExecutablePath; cmdLine=$proc.CommandLine} | ConvertTo-Json -Compress)
`;

/**
 * Returns one of:
 *  - { state: 'free' }
 *  - { state: 'owned_by_cortex', pid, cmdLine }         — a recognized cortex-server process
 *  - { state: 'owned_by_unknown', pid, name, cmdLine }  — occupied by something else (or undetermined)
 *  - { state: 'undetermined' }                          — could not check (non-Windows, or PowerShell failed)
 *
 * "Recognized" means: the owning process's command line invokes Node on a
 * path ending in cortex-server's own src/server.js — the same entry point
 * every start/dev npm script in this package resolves to. This intentionally
 * does not trust process name alone ("node.exe" is not sufficient, per the
 * mission's own instruction — many unrelated Node processes can be running).
 */
export async function checkPortOwnership(host, port) {
  if (!isWindows()) return { state: 'undetermined' };

  const result = await runReadOnlyPowerShell(OWNER_SCRIPT(host, port), { timeoutMs: 5_000 });
  if (!result.ok) return { state: 'undetermined' };

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return { state: 'undetermined' };
  }

  if (!parsed.listening) return { state: 'free' };
  if (parsed.unknown || !parsed.cmdLine) {
    return { state: 'owned_by_unknown', pid: parsed.pid, name: parsed.name ?? null, cmdLine: parsed.cmdLine ?? null };
  }

  const cmdLine = String(parsed.cmdLine);
  // npm's "start"/"dev" scripts invoke Node with a path RELATIVE to
  // cortex-server/ (e.g. "node  src/server.js", "node ... nodemon ...
  // src/server.js") since npm already cd's into that package directory —
  // the command line never contains the literal "cortex-server" segment.
  // Both the relative in-package form and a fully-qualified absolute path
  // are accepted; either way the entry point must be src/server.js itself,
  // never a bare "node.exe" match (many unrelated Node processes exist).
  const mentionsServerEntry = /[\\/]?src[\\/]server\.js/i.test(cmdLine);
  const mentionsNode = /node(\.exe)?["'\s]/i.test(cmdLine);
  const mentionsNodemon = /nodemon/i.test(cmdLine);
  const isCortexEntry = mentionsServerEntry && (mentionsNode || mentionsNodemon);

  if (isCortexEntry) {
    return { state: 'owned_by_cortex', pid: parsed.pid, cmdLine };
  }
  return { state: 'owned_by_unknown', pid: parsed.pid, name: parsed.name ?? null, cmdLine };
}
