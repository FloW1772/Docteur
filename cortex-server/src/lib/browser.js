// Configurable browser selection (Phase 6, MASTER mission) — lets the user
// pick which installed browser Docteur spawns to open an external link,
// independent of whichever browser is currently displaying the Docteur web
// app itself (window.open() always opens in that browser; this module is
// for backend-initiated opens, e.g. "Voir la documentation" links).
//
// SECURITY:
//   - spawn(executable, [url], { shell: false }) always — never shell:true,
//     never string concatenation into a command line.
//   - Only http:/https: URLs may be opened. file:, javascript:, data:,
//     powershell:, cmd: and everything else are rejected outright.
//   - Only browsers this module itself detected as installed (or an
//     explicit, validated custom .exe path) may be spawned — never an
//     arbitrary caller-supplied executable name.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getMeta, setMeta } from './sqlite.js';

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const PROGRAM_FILES = process.env['ProgramFiles'] || 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');

// Candidate install paths per browser — checked with fs.existsSync only,
// never executed to "probe". 'system' (the OS default handler) has no path:
// it uses `cmd /c start` (Windows-native URL dispatch), not a specific .exe.
const KNOWN_BROWSERS = [
  { id: 'system', label: 'Navigateur par défaut du système' },
  { id: 'edge', label: 'Microsoft Edge', paths: [
    path.join(PROGRAM_FILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PROGRAM_FILES_X86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] },
  { id: 'chrome', label: 'Google Chrome', paths: [
    path.join(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PROGRAM_FILES_X86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCAL_APPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] },
  { id: 'firefox', label: 'Mozilla Firefox', paths: [
    path.join(PROGRAM_FILES, 'Mozilla Firefox', 'firefox.exe'),
    path.join(PROGRAM_FILES_X86, 'Mozilla Firefox', 'firefox.exe'),
  ] },
  { id: 'brave', label: 'Brave', paths: [
    path.join(PROGRAM_FILES, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(PROGRAM_FILES_X86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(LOCAL_APPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ] },
];

// Detects which known browsers are actually installed on THIS machine —
// never assumed, always fs.existsSync()-verified. 'system' is always
// reported present (it's the OS's own URL dispatch, not a specific binary).
export function detectInstalledBrowsers() {
  return KNOWN_BROWSERS
    .filter(b => b.id === 'system' || (b.paths ?? []).some(p => fs.existsSync(p)))
    .map(b => ({
      id: b.id,
      label: b.label,
      path: b.id === 'system' ? null : b.paths.find(p => fs.existsSync(p)),
    }));
}

export function getBrowserSettings() {
  return getMeta('browser_settings', { selected: 'system', customPath: null });
}

export function setBrowserSettings(updates) {
  const current = getBrowserSettings();
  const next = { ...current, ...updates };
  setMeta('browser_settings', next);
  return next;
}

// Validates a caller-supplied custom browser executable path: must exist,
// must be a real .exe file, must not include any arguments (a path with
// arguments baked in could be used to smuggle extra flags at spawn time).
export function validateCustomBrowserPath(candidatePath) {
  const p = String(candidatePath ?? '').trim();
  if (!p) throw new Error('Chemin vide');
  if (!/\.exe$/i.test(p)) throw new Error('Le chemin doit pointer vers un exécutable .exe');
  if (!path.isAbsolute(p)) throw new Error('Le chemin doit être absolu');
  if (!fs.existsSync(p)) throw new Error('Fichier introuvable à ce chemin');
  const stat = fs.statSync(p);
  if (!stat.isFile()) throw new Error('Le chemin ne pointe pas vers un fichier');
  return p;
}

const BLOCKED_SCHEMES = new Set(['file:', 'javascript:', 'data:', 'powershell:', 'cmd:', 'vbscript:', 'about:']);

// Only http:/https: may ever be opened — everything else (including
// javascript:, file:, data:, powershell:, cmd:) is rejected before spawn.
export function assertOpenableUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl)); }
  catch { throw new Error('URL invalide'); }
  if (BLOCKED_SCHEMES.has(parsed.protocol) || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Protocole non autorisé : ${parsed.protocol} (http/https uniquement)`);
  }
  return parsed.href;
}

// Resolves the executable + args to spawn for the currently selected
// browser. Never returns a shell string — always {command, args} for
// spawn(command, args, { shell: false }).
export function resolveOpenCommand(url) {
  const settings = getBrowserSettings();
  const installed = detectInstalledBrowsers();

  if (settings.selected === 'custom' && settings.customPath) {
    const verifiedPath = validateCustomBrowserPath(settings.customPath);
    return { command: verifiedPath, args: [url] };
  }

  if (settings.selected === 'system') {
    // Windows-native URL dispatch — `cmd /c start "" <url>` is the standard,
    // documented way to hand a URL to the OS default handler without a
    // shell string (args are still passed as a real array, shell:false).
    const cmdExe = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe');
    return { command: cmdExe, args: ['/c', 'start', '', url] };
  }

  const browser = installed.find(b => b.id === settings.selected);
  if (!browser || !browser.path) {
    throw new Error(`Navigateur '${settings.selected}' non détecté sur cette machine — vérifie qu'il est installé ou choisis-en un autre dans Paramètres.`);
  }
  return { command: browser.path, args: [url] };
}

export function openUrlInSelectedBrowser(url) {
  const safeUrl = assertOpenableUrl(url);
  const { command, args } = resolveOpenCommand(safeUrl);
  const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore' });
  child.unref();
  return { opened: true, url: safeUrl };
}
