import { spawn } from 'node:child_process';
import path from 'node:path';

// Kills a process the caller spawned together with every descendant.
// yt-dlp.exe is a PyInstaller bootloader: on Windows `proc.kill()` only ends the
// bootloader and the worker keeps running (and keeps the stdout pipe open) until it finishes,
// so the whole tree must be taken down with taskkill /T /F. The PID always comes from the
// ChildProcess object Docteur spawned itself; argv is structured (no shell).
// Resolves once the kill attempt is over (never rejects).
export function killProcessTree(proc, { platform = process.platform, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    const fallback = () => { try { proc?.kill(); } catch { /* already gone */ } };
    if (!proc) return resolve(false);
    if (platform !== 'win32' || !Number.isInteger(proc.pid) || proc.pid <= 0) {
      fallback();
      return resolve(true);
    }
    let done = false;
    const finish = ok => { if (!done) { done = true; resolve(ok); } };
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
      const killer = spawnImpl(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      killer.on('error', () => { fallback(); finish(false); });
      // 128 = the process is already gone; any other failure → best-effort single kill.
      killer.on('close', code => { if (code !== 0) fallback(); finish(code === 0); });
    } catch {
      fallback();
      finish(false);
    }
  });
}
