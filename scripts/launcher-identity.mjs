// [STARTUP-2] Process & port identity for Docteur-Launcher.bat — DETECT (one read-only snapshot), CLASSIFY (pure JS),
// and the one guarded ACT the launcher may perform (terminate a confirmed, unresponsive Docteur backend).
//
// Identity is never a PID, a port, an image name, a window title or an HTTP answer alone. A listener is Docteur's only when
//   1. its owning process runs Docteur's own entry point (cortex-server src/server.js, or this repo's node_modules vite.js),
//   2. the process is anchored to THIS repository: the entry path is absolute inside the repo, or an ancestor is the
//      launcher console `cmd /k "cd /d <repo>[\cortex-server] && npm run dev"`, reached through a parent chain whose
//      creation times never go backwards (a recycled parent PID breaks the chain),
//   3. the listener address is the loopback one Docteur binds (backend 127.0.0.1 / ::1; Vite dual-stack ::).
// Anything else is FOREIGN_PROCESS, UNKNOWN_OWNER or INCONSISTENT_STATE, and those are never terminated.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKEND_PORT = 3001;
export const FRONTEND_PORT = 5173;
export const OLLAMA_PORT = 11434;
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const STATES = Object.freeze({
  FREE: 'FREE',
  BACKEND: 'DOCTEUR_BACKEND_CONFIRMED',
  FRONTEND: 'DOCTEUR_FRONTEND_CONFIRMED',
  FOREIGN: 'FOREIGN_PROCESS',
  UNKNOWN: 'UNKNOWN_OWNER',
  INCONSISTENT: 'INCONSISTENT_STATE',
});

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 15_000;
const TERMINATE_TIMEOUT_MS = 20_000;
const MAX_CHAIN_HOPS = 6;
const BACKEND_LOOPBACK = new Set(['127.0.0.1', '::1']);
const FRONTEND_LOOPBACK = new Set(['::', '::1', '127.0.0.1']);
const SYSTEM_PIDS = new Set([0, 4]);

// ── DETECT ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fixed script text, no caller data. Every listener of the given ports (default: the three Docteur ports), plus every process (pid, parent, name,
// creation time as a FILETIME string). Command lines are read for node.exe / cmd.exe only — other programs' arguments are
// never collected. Any read failure is reported as such, never as "port free".
const DEFAULT_PORTS = Object.freeze([BACKEND_PORT, FRONTEND_PORT, OLLAMA_PORT]);
const snapshotBody = ports => `
try { $all = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) } catch { $snap = @{ ok = $false; reason = 'LISTENERS_UNREADABLE' } }
if (-not $snap -and $all.Count -eq 0) { $snap = @{ ok = $false; reason = 'LISTENER_TABLE_EMPTY' } }
if (-not $snap) {
  try { $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { $snap = @{ ok = $false; reason = 'PROCESSES_UNREADABLE' } }
}
if (-not $snap) {
  $ports = @(${ports.map(Number).join(', ')})
  $listeners = @($all | Where-Object { $ports -contains [int]$_.LocalPort } | ForEach-Object { @{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })
  $rows = @($procs | ForEach-Object {
    $script = ($_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe')
    @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name
       created = $(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { $null })
       cmdLine = $(if ($script) { [string]$_.CommandLine } else { $null }) }
  })
  $snap = @{ ok = $true; listeners = $listeners; processes = $rows }
}
`;
const snapshotScript = ports => `$ErrorActionPreference = 'Stop'\n$snap = $null\n${snapshotBody(ports)}\n$snap | ConvertTo-Json -Compress -Depth 4`;
// ports are only ever integers written by this file (production constants, or test ports): no outside text reaches PowerShell
const validPorts = ports => Array.isArray(ports) && ports.length > 0 && ports.every(p => Number.isInteger(p) && p > 0 && p < 65536);

function runPowerShell(script, { timeoutMs, env } = {}) {
  return new Promise(resolve => {
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, shell: false, encoding: 'utf8', env: env ?? process.env },
      (error, stdout) => resolve(error ? { ok: false, reason: error.killed ? 'TIMEOUT' : 'EXEC_FAILED' } : { ok: true, stdout: String(stdout) }));
  });
}

/** Normalizes a parsed snapshot (PowerShell may collapse arrays); null when the shape is not a usable snapshot. */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || raw.ok !== true) return null;
  const list = value => (value == null ? [] : Array.isArray(value) ? value : [value]);
  const listeners = list(raw.listeners).filter(l => l && Number.isInteger(l.port) && Number.isInteger(l.pid))
    .map(l => ({ address: String(l.address ?? '').toLowerCase(), port: l.port, pid: l.pid }));
  const processes = list(raw.processes).filter(p => p && Number.isInteger(p.pid))
    .map(p => ({ pid: p.pid, ppid: Number.isInteger(p.ppid) ? p.ppid : null, name: p.name ? String(p.name) : null,
      created: /^\d+$/.test(String(p.created ?? '')) ? String(p.created) : null, cmdLine: p.cmdLine ? String(p.cmdLine) : null }));
  if (processes.length === 0) return null; // a live Windows host always has processes: an empty list is a failed read
  return { ok: true, listeners, processes };
}

/** One read-only observation. { ok: true, listeners, processes } or { ok: false, reason } — never "free" on failure. */
export async function takeSnapshot({ run = runPowerShell, platform = process.platform, ports = DEFAULT_PORTS } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'NOT_WINDOWS' };
  if (!validPorts(ports)) return { ok: false, reason: 'BAD_PORTS' };
  const result = await run(snapshotScript(ports), { timeoutMs: SNAPSHOT_TIMEOUT_MS });
  if (!result.ok) return { ok: false, reason: `SNAPSHOT_${result.reason}` };
  let raw;
  try { raw = JSON.parse(result.stdout.trim()); } catch { return { ok: false, reason: 'SNAPSHOT_UNPARSEABLE' }; }
  if (raw && raw.ok === false) return { ok: false, reason: String(raw.reason ?? 'SNAPSHOT_FAILED') };
  return normalizeSnapshot(raw) ?? { ok: false, reason: 'SNAPSHOT_UNPARSEABLE' };
}

// ── CLASSIFY (pure) ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Splits a Windows command line into arguments (quotes group, quotes removed). */
export function splitCommandLine(cmdLine) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmdLine ?? '')))) tokens.push(m[1] ?? m[2]);
  return tokens;
}

const winNorm = p => path.win32.normalize(String(p).replace(/\//g, '\\')).toLowerCase();
const isNodeExe = token => /^node(\.exe)?$/i.test(path.win32.basename(String(token ?? '')));
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function nodeScript(cmdLine) {
  const tokens = splitCommandLine(cmdLine);
  if (tokens.length < 2 || !isNodeExe(tokens[0])) return null;
  let i = 1;
  const options = [];
  while (i < tokens.length && tokens[i].startsWith('-')) options.push(tokens[i++]);
  if (i >= tokens.length) return null;
  return { options, script: tokens[i], rest: tokens.slice(i + 1) };
}

/** Docteur backend entry: node [--options] src/server.js (relative, npm cwd) or <repo>\cortex-server\src\server.js. */
export function recognizeBackend(cmdLine, repoRoot = REPO_ROOT) {
  const parsed = nodeScript(cmdLine);
  if (!parsed || parsed.rest.length > 0) return null;
  const script = winNorm(parsed.script);
  const absolute = path.win32.isAbsolute(parsed.script) && script === winNorm(path.win32.join(repoRoot, 'cortex-server', 'src', 'server.js'));
  if (!absolute && script !== 'src\\server.js') return null;
  const watcher = parsed.options.some(o => o === '--watch' || o.startsWith('--watch-path'));
  return { role: watcher ? 'watcher' : 'server', absolute };
}

/** Docteur frontend entry: node <repo>\node_modules\vite\bin\vite.js with no sub-command (the `npm run dev` server). */
export function recognizeFrontend(cmdLine, repoRoot = REPO_ROOT) {
  const parsed = nodeScript(cmdLine);
  if (!parsed) return null;
  const script = winNorm(parsed.script);
  const absolute = path.win32.isAbsolute(parsed.script) && script === winNorm(path.win32.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'));
  if (!absolute && script !== 'node_modules\\vite\\bin\\vite.js') return null;
  return { role: parsed.rest.length === 0 ? 'dev' : 'other', absolute };
}

/** 'backend' | 'frontend' | null — is this cmd.exe the console the launcher opens for that service in this repo? */
export function consoleAnchor(cmdLine, repoRoot = REPO_ROOT) {
  const text = String(cmdLine ?? '').replace(/\//g, '\\');
  if (!/^\s*"?[^"]*cmd(\.exe)?"?\s/i.test(text)) return null;
  const repo = escapeRe(path.win32.normalize(repoRoot).replace(/\\$/, ''));
  // backend: daily mode `npm start` (no watcher) or development mode `npm run dev`; frontend: `npm run dev` only
  const tail = script => `"?\\s*&&\\s*npm\\s+${script}\\s*"?\\s*$`;
  if (new RegExp(`cd\\s+\\\\d\\s+"?${repo}\\\\cortex-server${tail('(?:run\\s+dev|start)')}`, 'i').test(text)) return 'backend';
  if (new RegExp(`cd\\s+\\\\d\\s+"?${repo}${tail('run\\s+dev')}`, 'i').test(text)) return 'frontend';
  return null;
}

export function indexSnapshot(snapshot) {
  const byPid = new Map();
  for (const p of snapshot.processes) byPid.set(p.pid, p);
  return byPid;
}

const notBefore = (parent, child) => parent.created != null && child.created != null && BigInt(parent.created) <= BigInt(child.created);

/** Parent of a process, only if the parent PID still names the process that created it (creation-time order). */
export function verifiedParent(byPid, proc) {
  const parent = proc.ppid != null ? byPid.get(proc.ppid) : null;
  return parent && parent.pid !== proc.pid && notBefore(parent, proc) ? parent : null;
}

/** Walks the verified parent chain looking for the launcher console of `kind`. */
export function anchoredConsole(byPid, proc, kind, repoRoot = REPO_ROOT) {
  let current = proc;
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    const parent = verifiedParent(byPid, current);
    if (!parent) return null;
    if (parent.name && /^cmd\.exe$/i.test(parent.name) && consoleAnchor(parent.cmdLine, repoRoot) === kind) return parent;
    current = parent;
  }
  return null;
}

/** Identity of one process as a Docteur service, or null. */
export function docteurIdentity(byPid, proc, repoRoot = REPO_ROOT) {
  if (!proc || !proc.cmdLine || !proc.name || !/^node\.exe$/i.test(proc.name) || proc.created == null) return null;
  const backend = recognizeBackend(proc.cmdLine, repoRoot);
  if (backend) {
    const anchor = backend.absolute ? 'absolute-path' : anchoredConsole(byPid, proc, 'backend', repoRoot) ? 'launcher-console' : null;
    return { kind: 'backend', role: backend.role, anchored: Boolean(anchor), anchor };
  }
  const frontend = recognizeFrontend(proc.cmdLine, repoRoot);
  if (frontend) {
    const anchor = frontend.absolute ? 'absolute-path' : anchoredConsole(byPid, proc, 'frontend', repoRoot) ? 'launcher-console' : null;
    return { kind: 'frontend', role: frontend.role, anchored: Boolean(anchor), anchor };
  }
  return null;
}

/**
 * Classifies who holds `port`. kind = 'backend' (3001) or 'frontend' (5173). Returns
 * { state, port, reason, pid?, created?, name? } — state is one of STATES. Deterministic, no I/O.
 */
export function classifyPort(snapshot, port, kind, repoRoot = REPO_ROOT) {
  const rows = snapshot.listeners.filter(l => l.port === port);
  if (rows.length === 0) return { state: STATES.FREE, port, reason: 'NO_LISTENER' };
  const pids = [...new Set(rows.map(r => r.pid))];
  if (pids.length > 1) return { state: STATES.INCONSISTENT, port, reason: 'MULTIPLE_OWNERS', pids };
  const pid = pids[0];
  if (SYSTEM_PIDS.has(pid)) return { state: STATES.FOREIGN, port, reason: 'SYSTEM_OWNER', pid, name: 'System' };
  const byPid = indexSnapshot(snapshot);
  const proc = byPid.get(pid);
  if (!proc) return { state: STATES.INCONSISTENT, port, reason: 'OWNER_NOT_IN_PROCESS_LIST', pid };
  const base = { port, pid, created: proc.created, name: proc.name };
  if (!proc.name || !/^node\.exe$/i.test(proc.name)) return { ...base, state: STATES.FOREIGN, reason: 'NOT_A_NODE_PROCESS' };
  if (!proc.cmdLine) return { ...base, state: STATES.UNKNOWN, reason: 'COMMAND_LINE_UNREADABLE' };
  const id = docteurIdentity(byPid, proc, repoRoot);
  if (!id) return { ...base, state: STATES.FOREIGN, reason: 'OTHER_NODE_PROGRAM' };
  if (id.kind !== kind) return { ...base, state: STATES.UNKNOWN, reason: `DOCTEUR_${id.kind.toUpperCase()}_ON_WRONG_PORT` };
  if (!id.anchored) return { ...base, state: STATES.UNKNOWN, reason: 'NOT_ANCHORED_TO_THIS_REPOSITORY' };
  const allowed = kind === 'backend' ? BACKEND_LOOPBACK : FRONTEND_LOOPBACK;
  if (!rows.every(r => allowed.has(r.address))) return { ...base, state: STATES.UNKNOWN, reason: 'NON_LOOPBACK_LISTENER' };
  if (kind === 'backend' && id.role !== 'server') return { ...base, state: STATES.UNKNOWN, reason: 'UNEXPECTED_BACKEND_ROLE' };
  if (kind === 'frontend' && id.role !== 'dev') return { ...base, state: STATES.UNKNOWN, reason: 'NOT_THE_DEV_SERVER' };
  return { ...base, state: kind === 'backend' ? STATES.BACKEND : STATES.FRONTEND, reason: id.anchor };
}

/** Anchored Docteur processes (listening or not) and launcher consoles left without a live service. */
export function findDocteurProcesses(snapshot, repoRoot = REPO_ROOT) {
  const byPid = indexSnapshot(snapshot);
  const out = { backendServers: [], backendWatchers: [], frontends: [], idleConsoles: [] };
  const serviceAncestors = new Set();
  for (const proc of snapshot.processes) {
    const id = docteurIdentity(byPid, proc, repoRoot);
    if (!id || !id.anchored) continue;
    if (id.kind === 'backend') (id.role === 'watcher' ? out.backendWatchers : out.backendServers).push(proc);
    else if (id.role === 'dev') out.frontends.push(proc);
    else continue;
    if (id.kind === 'backend' && id.role === 'watcher') continue; // a watcher alone (its server crashed) keeps nothing alive
    for (let cur = proc, hop = 0; hop < MAX_CHAIN_HOPS && cur; hop++) { serviceAncestors.add(cur.pid); cur = verifiedParent(byPid, cur); }
  }
  for (const proc of snapshot.processes) {
    if (!proc.name || !/^cmd\.exe$/i.test(proc.name)) continue;
    const kind = consoleAnchor(proc.cmdLine, repoRoot);
    if (kind && !serviceAncestors.has(proc.pid)) out.idleConsoles.push({ pid: proc.pid, kind });
  }
  // a watcher whose server child is gone ("waiting for file changes") — useful to explain a crashed backend
  out.idleWatchers = out.backendWatchers.filter(w => !out.backendServers.some(s => { const p = verifiedParent(byPid, s); return p && p.pid === w.pid; }));
  return out;
}

/**
 * Processes to stop to replace a confirmed backend: the listening server and, when it is its verified parent, the
 * `node --watch` supervisor (otherwise it would restart the server on the next file change). Never descendants: the
 * backend spawns third-party programs (the user's browser via lib/browser.js, kiwix-serve, ffmpeg…) that are not Docteur's.
 */
export function backendTerminationTargets(snapshot, classification, repoRoot = REPO_ROOT) {
  if (classification?.state !== STATES.BACKEND) return null;
  const byPid = indexSnapshot(snapshot);
  const server = byPid.get(classification.pid);
  if (!server || server.created !== classification.created) return null;
  const targets = [];
  const parent = verifiedParent(byPid, server);
  const parentId = parent ? docteurIdentity(byPid, parent, repoRoot) : null;
  if (parentId && parentId.kind === 'backend' && parentId.role === 'watcher' && parentId.anchored) targets.push({ pid: parent.pid, created: parent.created, role: 'watcher' });
  targets.push({ pid: server.pid, created: server.created, role: 'server' });
  return targets;
}

/** Is a re-observation still describing exactly the same targets and the same confirmed listener? */
export function sameTargetsStillConfirmed(snapshot, targets, expected, repoRoot = REPO_ROOT) {
  const now = classifyPort(snapshot, expected.port, 'backend', repoRoot);
  if (now.state !== STATES.BACKEND) return { ok: false, reason: `LISTENER_${now.state}` };
  if (now.pid !== expected.pid || now.created !== expected.created) return { ok: false, reason: 'LISTENER_NOT_THE_SAME_PROCESS' };
  const again = backendTerminationTargets(snapshot, now, repoRoot) ?? [];
  const key = list => list.map(t => `${t.pid}:${t.created}:${t.role}`).join(',');
  return key(again) === key(targets) ? { ok: true } : { ok: false, reason: 'TARGETS_CHANGED' };
}

// ── ACT (guarded) ────────────────────────────────────────────────────────────────────────────────────────────────────
// Pins every target with an open process handle (Windows never recycles a PID while a handle is open), re-observes the
// system while pinned, lets the caller re-classify that observation, and only on "GO" kills through the pinned handles.
const terminateScript = ports => `
$ErrorActionPreference = 'Stop'
$spec = [string]$env:DOCTEUR_LAUNCH_TARGETS
if ($spec -notmatch '^[0-9]+(,[0-9]+)*$') { @{ phase = 'pin'; ok = $false; reason = 'BAD_TARGETS' } | ConvertTo-Json -Compress; exit 0 }
$pinned = New-Object System.Collections.ArrayList
foreach ($t in $spec.Split(',')) {
  try { $p = [System.Diagnostics.Process]::GetProcessById([int]$t); $null = $p.Handle; [void]$pinned.Add($p) }
  catch { @{ phase = 'pin'; ok = $false; reason = 'TARGET_NOT_PINNABLE' } | ConvertTo-Json -Compress; exit 0 }
}
$snap = $null
${snapshotBody(ports)}
$snap.phase = 'pinned'
[Console]::Out.WriteLine(($snap | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
$answer = [Console]::In.ReadLine()
if ($answer -ne 'GO') { @{ phase = 'done'; killed = @(); reason = 'ABORTED' } | ConvertTo-Json -Compress; exit 0 }
$killed = @(); $failed = @()
foreach ($p in $pinned) { try { if (-not $p.HasExited) { $p.Kill() }; $killed += $p.Id } catch { $failed += $p.Id } }
foreach ($p in $pinned) { try { [void]$p.WaitForExit(5000) } catch {} }
$exited = @($pinned | Where-Object { $_.HasExited } | ForEach-Object { $_.Id })
@{ phase = 'done'; killed = $killed; failed = $failed; exited = $exited } | ConvertTo-Json -Compress
`;

function defaultPinnedSession({ pids, ports }) {
  const child = spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${terminateScript(ports)}`],
    { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, DOCTEUR_LAUNCH_TARGETS: pids.join(',') } });
  const lines = [];
  const waiters = [];
  let buffer = '';
  let closed = false;
  const flush = () => { while (waiters.length && (lines.length || closed)) waiters.shift()(lines.shift() ?? null); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (line) lines.push(line); }
    flush();
  });
  child.on('close', () => { if (buffer.trim()) lines.push(buffer.trim()); closed = true; flush(); });
  child.on('error', () => { closed = true; flush(); });
  const timer = setTimeout(() => child.kill(), TERMINATE_TIMEOUT_MS);
  return {
    next: () => new Promise(resolve => { waiters.push(resolve); flush(); }),
    send: text => { try { child.stdin.end(`${text}\n`); } catch { /* closed */ } },
    close: () => { clearTimeout(timer); try { child.stdin.end(); } catch { /* closed */ } },
  };
}

/**
 * Terminates exactly `targets` (from backendTerminationTargets) after re-verifying them while pinned.
 * Returns { ok: true, killed } or { ok: false, reason } — on any doubt nothing is killed.
 */
export async function terminatePinned(targets, expected, { openSession = defaultPinnedSession, platform = process.platform, repoRoot = REPO_ROOT, ports = DEFAULT_PORTS } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'NOT_WINDOWS' };
  if (!validPorts(ports) || !ports.includes(expected?.port)) return { ok: false, reason: 'BAD_PORTS' };
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 2 || !targets.every(t => Number.isInteger(t.pid) && t.pid > 4 && /^\d+$/.test(String(t.created)))) {
    return { ok: false, reason: 'BAD_TARGETS' };
  }
  const session = openSession({ pids: targets.map(t => t.pid), ports });
  try {
    const parse = line => { try { return JSON.parse(line); } catch { return null; } };
    const pinned = parse(await session.next());
    if (!pinned || pinned.phase !== 'pinned') { session.send('ABORT'); return { ok: false, reason: pinned?.reason ?? 'PIN_FAILED' }; }
    const snapshot = normalizeSnapshot(pinned);
    const check = snapshot ? sameTargetsStillConfirmed(snapshot, targets, expected, repoRoot) : { ok: false, reason: 'PINNED_SNAPSHOT_UNUSABLE' };
    if (!check.ok) { session.send('ABORT'); await session.next(); return { ok: false, reason: `IDENTITY_CHANGED_${check.reason}` }; }
    session.send('GO');
    const done = parse(await session.next());
    if (!done || done.phase !== 'done') return { ok: false, reason: 'TERMINATION_RESULT_UNKNOWN' };
    const asList = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
    const failed = asList(done.failed);
    return failed.length ? { ok: false, reason: 'TERMINATION_FAILED', killed: asList(done.killed), failed } : { ok: true, killed: asList(done.killed), exited: asList(done.exited) };
  } finally { session.close(); }
}
