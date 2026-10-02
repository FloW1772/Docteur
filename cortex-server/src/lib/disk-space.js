import { execFile } from 'node:child_process';
import path from 'node:path';

// Espace disque libre sur Windows via PowerShell Get-PSDrive — choisi plutôt que
// fs.statfs (indisponible/instable sur Windows selon la version de Node) ou un
// package tiers (check-disk-space) pour éviter une dépendance supplémentaire :
// Get-PSDrive est disponible nativement sur toute installation Windows.
//
// SECURITY (Root Policy V1 closure, RPC-2A): the drive name is derived from a folder that a local
// client can set (PUT /kiwix/settings → archivesFolder). It used to be spliced into the PowerShell
// command text, so a crafted UNC path (`\\h\sh'; <code>; '\z`) became PowerShell source. The command
// text is now a CONSTANT; the drive name travels in an environment variable, i.e. as pure data that
// PowerShell reads with `$env:` and can never reinterpret as code. Every local drive gives the same
// number as before. A name that is not a drive at all (a UNC share root such as `srvshare`) now reports
// "unknown" (null) instead of the accidental 0 the old script printed for it — callers already treat
// null as "do not block" (kiwix download: `freeBytes !== null && freeBytes < size`), so no legitimate
// path is refused any more than before.
export const DRIVE_ENV_VAR = 'DOCTEUR_DRIVE_NAME';
export const FREE_SPACE_SCRIPT = `$d = Get-PSDrive -Name $env:${DRIVE_ENV_VAR} -ErrorAction SilentlyContinue; if ($d) { $d.Free } else { exit 3 }`;

/** Same derivation as before: `C:\x` → `C`; a UNC root `\\srv\share\` → `srvshare` (looked up as a drive name, never executed). */
export function driveNameFor(targetPath) {
  return path.parse(path.resolve(targetPath)).root.replace(/[\\/]/g, '').replace(':', '');
}

/** Pure: what would be launched. Constant file + constant args; the only variable part is the environment value. */
export function buildFreeSpaceInvocation(driveName) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', FREE_SPACE_SCRIPT],
    env: { ...process.env, [DRIVE_ENV_VAR]: driveName },
  };
}

export function freeDiskSpaceBytes(targetPath, { execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    let driveName;
    try { driveName = driveNameFor(targetPath); } catch { resolve(null); return; }
    if (!driveName) { resolve(null); return; }

    const { file, args, env } = buildFreeSpaceInvocation(driveName);
    try {
      execFileImpl(file, args, { timeout: 8_000, env }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const value = Number(String(stdout).trim());
        resolve(Number.isFinite(value) ? value : null);
      });
    } catch {
      resolve(null); // e.g. an environment value Windows cannot carry (NUL, too long): unknown free space, never a thrown error
    }
  });
}
