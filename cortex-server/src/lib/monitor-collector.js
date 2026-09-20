/**
 * Observateur passive monitoring — OS-level collector. Shells out to
 * read-only, already-installed OS commands to see what the OS itself
 * reasonably exposes about active connections and processes. This file
 * NEVER: injects packets, performs MITM, decrypts TLS, captures
 * credentials, scans remote ports, or modifies traffic — it only parses
 * the text output of commands the OS ships (netstat/tasklist on
 * Windows; ss/ps on Linux/macOS).
 *
 * Uses execFile (never exec with a concatenated string) — every argv is
 * a fixed literal, never built from user/network input, so there is no
 * shell-injection surface. Every spawn has a hard timeout so a hung OS
 * command can never stall the collector loop indefinitely.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SPAWN_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 4 * 1024 * 1024;

async function run(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true });
    return stdout;
  } catch {
    return null; // command missing, timed out, or non-zero exit — collector degrades gracefully
  }
}

// `netstat -ano` columns (English Windows): Proto  Local Address  Foreign
// Address  State  PID. Parsed positionally (whitespace-split with a
// fixed expected column count), not by matching localized header text,
// so this survives non-English column headers; a line that doesn't
// match the expected shape is simply skipped rather than thrown on.
function parseNetstatWindows(output) {
  if (!output) return [];
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[0];
    if (proto !== 'TCP' && proto !== 'UDP') continue;
    const [, localAddr, foreignAddr, stateOrPid, maybePid] = parts;
    const isTcp = proto === 'TCP';
    const state = isTcp ? stateOrPid : null;
    const pidStr = isTcp ? maybePid : stateOrPid;
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isFinite(pid)) continue;
    const localPort = Number.parseInt(localAddr.split(':').pop(), 10);
    const foreignHost = foreignAddr.split(':').slice(0, -1).join(':') || foreignAddr;
    const foreignPort = Number.parseInt(foreignAddr.split(':').pop(), 10);
    rows.push({
      pid,
      protocol: proto,
      state: state || (foreignHost === '0.0.0.0' || foreignHost === '*' ? 'LISTENING' : 'ESTABLISHED'),
      localPort: Number.isFinite(localPort) ? localPort : null,
      remoteAddress: foreignHost,
      remotePort: Number.isFinite(foreignPort) ? foreignPort : null,
    });
  }
  return rows;
}

// `tasklist /fo csv /nh` — one CSV row per process, no header line
// ("/nh"): "name","pid","session","session#","memusage". Only name+pid
// are used; nothing here requires elevation on Windows.
function parseTasklistWindows(output) {
  const map = new Map();
  if (!output) return map;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const name = fields[0].replace(/"/g, '');
    const pid = Number.parseInt(fields[1].replace(/"/g, ''), 10);
    if (Number.isFinite(pid)) map.set(pid, name);
  }
  return map;
}

// `ss -tunp` (Linux) — best-effort parse, not the dev/tested path this
// session (dev box is win32) but implemented so Observateur degrades to
// "no connection data, no crash" rather than throwing on non-Windows.
function parseSsLinux(output) {
  if (!output) return [];
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(tcp|udp)\s+\S+\s+\S+\s+(\S+):(\d+)\s+(\S+):(\d+)/i);
    if (!m) continue;
    const [, proto, , localPort, remoteAddress, remotePort] = m;
    const pidMatch = line.match(/pid=(\d+)/);
    rows.push({
      pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
      protocol: proto.toUpperCase(),
      state: remoteAddress === '0.0.0.0' || remoteAddress === '*' ? 'LISTENING' : 'ESTABLISHED',
      localPort: Number.parseInt(localPort, 10),
      remoteAddress,
      remotePort: Number.parseInt(remotePort, 10),
    });
  }
  return rows;
}

function parsePsLinux(output) {
  const map = new Map();
  if (!output) return map;
  for (const line of output.split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    map.set(Number.parseInt(m[1], 10), m[2].trim());
  }
  return map;
}

async function collectWindows() {
  const [netstatOut, tasklistOut] = await Promise.all([
    run('netstat', ['-ano']),
    run('tasklist', ['/fo', 'csv', '/nh']),
  ]);
  const connections = parseNetstatWindows(netstatOut);
  const nameByPid = parseTasklistWindows(tasklistOut);
  return { connections, nameByPid };
}

async function collectPosix() {
  const [ssOut, psOut] = await Promise.all([
    run('ss', ['-tunp']),
    run('ps', ['-eo', 'pid,comm']),
  ]);
  const connections = parseSsLinux(ssOut);
  const nameByPid = parsePsLinux(psOut);
  return { connections, nameByPid };
}

// Returns { connections: [...], processes: [...] } — raw shape, not yet
// passed through monitor-privacy-guard.js (the caller, monitor-service.js,
// is responsible for that before anything reaches the aggregator).
export async function collectSnapshot() {
  const { connections, nameByPid } = process.platform === 'win32'
    ? await collectWindows()
    : await collectPosix();

  const timestamp = new Date().toISOString();
  const seenPids = new Set();
  const enrichedConnections = connections.map(conn => {
    const processName = (conn.pid != null && nameByPid.get(conn.pid)) || null;
    if (conn.pid != null) seenPids.add(conn.pid);
    return {
      processName: processName || 'processus inconnu',
      pid: conn.pid,
      remoteAddress: conn.remoteAddress,
      remotePort: conn.remotePort,
      localPort: conn.localPort,
      protocol: conn.protocol,
      state: conn.state,
      timestamp,
      approxBytes: 0, // not reliably available from netstat/ss without elevated counters — best-effort 0
    };
  });

  const processes = Array.from(nameByPid.entries())
    .filter(([pid]) => seenPids.has(pid))
    .map(([pid, processName]) => ({ processName, pid, timestamp }));

  return { connections: enrichedConnections, processes };
}
