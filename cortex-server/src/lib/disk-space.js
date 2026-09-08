import { execFile } from 'node:child_process';
import path from 'node:path';

// Espace disque libre sur Windows via PowerShell Get-PSDrive — choisi plutôt que
// fs.statfs (indisponible/instable sur Windows selon la version de Node) ou un
// package tiers (check-disk-space) pour éviter une dépendance supplémentaire :
// Get-PSDrive est disponible nativement sur toute installation Windows.
export function freeDiskSpaceBytes(targetPath) {
  return new Promise((resolve) => {
    const driveLetter = path.parse(path.resolve(targetPath)).root.replace(/[\\/]/g, '').replace(':', '');
    if (!driveLetter) { resolve(null); return; }

    const cmd = `(Get-PSDrive -Name '${driveLetter}').Free`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 8_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const value = Number(String(stdout).trim());
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}
