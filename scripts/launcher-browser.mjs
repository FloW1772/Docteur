// [STARTUP-3] Relaunch without stacking browser windows: find an already open Docteur window and bring it back instead of
// opening another one. Privacy / safety:
//   - only top-level windows owned by chrome.exe are looked at, and only those whose title is EXACTLY the Docteur page
//     title (app window, or a tab window "… - Google Chrome") are reported — no other window or tab title leaves PowerShell;
//   - the only action is restore + bring to front (or flash the taskbar button when Windows refuses the foreground change),
//     after re-checking that the window still exists, belongs to the same chrome.exe and still carries the Docteur title.
//     Nothing is ever closed, no profile or setting is touched, no remote debugging is used.
import { execFile } from 'node:child_process';
import path from 'node:path';

export const DOCTEUR_TITLE = 'Docteur — Cortex Personnel';
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TIMEOUT_MS = 15_000;

// Title built from code points so the script text stays ASCII whatever the console code page.
const PRELUDE = `
$ErrorActionPreference = 'Stop'
$title = 'Docteur ' + [char]0x2014 + ' Cortex Personnel'
$titles = @($title, ($title + ' - Google Chrome'))
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class DocteurWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO f);
  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  public static List<string> List(uint[] pids, string[] titles) {
    var set = new HashSet<uint>(pids); var wanted = new HashSet<string>(titles); var r = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p) && IsWindowVisible(h)) { var t = Title(h); if (wanted.Contains(t)) r.Add(h.ToInt64() + "|" + p + "|" + (t == titles[0] ? "app" : "tab") + "|" + (IsIconic(h) ? 1 : 0)); }
      return true; }, IntPtr.Zero);
    return r;
  }
  public static string Activate(long hwnd, uint pid, uint[] pids, string[] titles) {
    var h = new IntPtr(hwnd); uint p;
    if (!IsWindow(h) || !IsWindowVisible(h)) return "gone";
    GetWindowThreadProcessId(h, out p);
    if (p != pid || Array.IndexOf(pids, p) < 0 || Array.IndexOf(titles, Title(h)) < 0) return "changed";
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    // Windows only lets the foreground owner (here the launcher console) hand over the foreground: share its input state
    // for the duration of the request, then detach. No synthetic input is sent.
    uint dummy; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy); uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); } finally { if (attached) AttachThreadInput(me, fgThread, false); }
    if (GetForegroundWindow() == h) return "activated";
    var f = new FLASHWINFO { hwnd = h, dwFlags = 3 | 12, uCount = 0, dwTimeout = 0 }; // FLASHW_ALL | FLASHW_TIMERNOFG
    f.cbSize = (uint)Marshal.SizeOf(f); FlashWindowEx(ref f);
    return "flashed";
  }
}
'@
$pids = [uint32[]]@(Get-Process -Name chrome -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
`;
const LIST_SCRIPT = `${PRELUDE}
@{ ok = $true; windows = @([DocteurWindows]::List($pids, $titles)) } | ConvertTo-Json -Compress`;
const ACTIVATE_SCRIPT = `${PRELUDE}
$h = [string]$env:DOCTEUR_BROWSER_HWND; $p = [string]$env:DOCTEUR_BROWSER_PID
if ($h -notmatch '^[0-9]{1,19}$' -or $p -notmatch '^[0-9]{1,10}$') { @{ result = 'bad-target' } | ConvertTo-Json -Compress; exit 0 }
@{ result = [DocteurWindows]::Activate([int64]$h, [uint32]$p, $pids, $titles) } | ConvertTo-Json -Compress`;

function runPowerShell(script, env = {}) {
  return new Promise(resolve => {
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, shell: false, encoding: 'utf8', env: { ...process.env, ...env } },
      (error, stdout) => resolve(error ? { ok: false } : { ok: true, stdout: String(stdout) }));
  });
}

/** Parses "hwnd|pid|app|tab|minimized" rows; anything malformed is dropped. */
export function parseWindowRows(rows) {
  const list = rows == null ? [] : Array.isArray(rows) ? rows : [rows];
  return list.map(String).map(r => r.split('|')).filter(c => c.length === 4 && /^\d+$/.test(c[0]) && /^\d+$/.test(c[1]) && (c[2] === 'app' || c[2] === 'tab'))
    .map(([hwnd, pid, kind, min]) => ({ hwnd, pid: Number(pid), kind, minimized: min === '1' }));
}

/** Best window to bring back: a visible app window first, then a minimized one, then a tab window. */
export function chooseDocteurWindow(windows) {
  const rank = w => (w.kind === 'app' ? 0 : 2) + (w.minimized ? 1 : 0);
  return [...windows].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** { ok: true, window | null } — any failure is { ok: false } and the caller simply opens a new window as before. */
export async function findDocteurWindow({ run = runPowerShell, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false };
  const r = await run(LIST_SCRIPT);
  if (!r.ok) return { ok: false };
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim()); } catch { return { ok: false }; }
  if (!parsed || parsed.ok !== true) return { ok: false };
  return { ok: true, window: chooseDocteurWindow(parseWindowRows(parsed.windows)) };
}

/** 'activated' | 'flashed' | 'gone' | 'changed' | 'failed' — never closes anything. */
export async function activateDocteurWindow(win, { run = runPowerShell, platform = process.platform } = {}) {
  if (platform !== 'win32' || !win || !/^\d{1,19}$/.test(String(win.hwnd)) || !Number.isInteger(win.pid)) return 'failed';
  const r = await run(ACTIVATE_SCRIPT, { DOCTEUR_BROWSER_HWND: String(win.hwnd), DOCTEUR_BROWSER_PID: String(win.pid) });
  if (!r.ok) return 'failed';
  try { return JSON.parse(r.stdout.trim()).result ?? 'failed'; } catch { return 'failed'; }
}
