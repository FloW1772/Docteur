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
//   - [SEC-REMED-1 / SEC-1] No command interpreter ever sees the URL. The
//     "system" dispatch was `cmd.exe /c start "" <url>`: cmd.exe re-parses its
//     command line, so `&`, `|`, `^`… in a URL ran commands.
//   - [SEC-REMED-2 / SEC-11] The URL is never handed to a launcher that has a
//     command grammar of its own. SEC-REMED-1 used `explorer.exe <url>`, but
//     explorer.exe splits its command line on commas and honours switches:
//     `https://h/?a,/root,C:\x.cmd` (a valid http URL) launched C:\x.cmd. The
//     "system" choice now resolves the default browser's OWN executable from
//     the registry and spawns `browser.exe [url]`; anything it cannot resolve
//     to a known browser fails closed with SAFE_BROWSER_OPEN_UNAVAILABLE.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getMeta, setMeta } from './sqlite.js';
import { buildDefaultPolicy } from './root-policy/default-policy.js';

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const PROGRAM_FILES = process.env['ProgramFiles'] || 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');

// Candidate install paths per browser — checked with fs.existsSync only,
// never executed to "probe". 'system' (the OS default handler) has no fixed
// path: the default browser's executable is resolved from the registry at
// open time (resolveDefaultBrowserExecutable).
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
  // [SEC-REMED-2] a shell / interpreter / launcher (explorer.exe, cmd.exe, rundll32.exe…) would read the URL as its own
  // syntax — same deny-list as the Root Policy rule for user-chosen browsers (browser-open-custom), read, not changed.
  if (SHELL_LIKE_EXECUTABLES.has(path.win32.basename(p).toLowerCase())) throw new Error('Ce programme n’est pas un navigateur (lanceur ou interpréteur refusé)');
  return p;
}

const SHELL_LIKE_EXECUTABLES = new Set(buildDefaultPolicy({ version: 2 })
  .capabilities['PROCESS.START_TYPED'].constraints.executors.browser['browser-open-custom'].deniedExecutables
  .map(name => name.toLowerCase()));

// ── [SEC-REMED-2 / SEC-11] default browser resolution ──────────────────────────────────────────────────────────────────
// Windows records the default http/https handler as a ProgId (HKCU …\UrlAssociations\<scheme>\UserChoiceLatest\ProgId on
// recent builds, …\UserChoice otherwise); the ProgId's shell\open\command holds e.g.
//   "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --single-argument %1
// Only the EXECUTABLE is taken from it, after strict checks; the registry string is never run. The URL is then the single
// argv element of that browser. Known browsers only (their argv semantics are known): anything else fails closed.
export const SAFE_BROWSER_OPEN_UNAVAILABLE = 'SAFE_BROWSER_OPEN_UNAVAILABLE';

function unavailable(why) {
  const error = new Error(`${SAFE_BROWSER_OPEN_UNAVAILABLE}: ${why}. Choisis un navigateur précis dans Paramètres.`);
  error.code = SAFE_BROWSER_OPEN_UNAVAILABLE;
  return error;
}

// executable basename → the folder it installs into (same pinning as the Root Policy V2 browser executors)
const KNOWN_DEFAULT_BROWSERS = new Map([
  ['msedge.exe', 'application'], ['chrome.exe', 'application'], ['brave.exe', 'application'], ['firefox.exe', 'mozilla firefox'],
]);
// static arguments the registered commands of those browsers carry before the %1 placeholder (all dropped at launch)
const KNOWN_STATIC_ARGS = new Set(['--single-argument', '-osint', '-url', '--']);
const PROG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REG_EXE = path.win32.join(SYSTEM_ROOT, 'System32', 'reg.exe');

// Reads one registry string with reg.exe: fixed argv, no shell, never any part of the URL. null when absent.
function readRegistryString(key, valueName) {
  let out;
  try {
    out = execFileSync(REG_EXE, ['query', key, ...(valueName ? ['/v', valueName] : ['/ve'])], {
      shell: false, windowsHide: true, timeout: 5000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return null; }
  // reg.exe columns are separated by 4 spaces: "    <name>    REG_SZ    <data>"
  for (const raw of out.split(/\r?\n/)) {
    const cols = raw.trim().split('    ');
    if (cols.length >= 3 && (cols[1] === 'REG_SZ' || cols[1] === 'REG_EXPAND_SZ')) return cols.slice(2).join('    ').trim();
  }
  return null;
}

/** Validated absolute path of a known browser executable taken from a registered open command, or throws unavailable. */
export function parseBrowserOpenCommand(commandLine) {
  const s = String(commandLine ?? '').trim();
  // "<exe>" rest   or   <exe> rest
  const exeEnd = s.startsWith('"') ? s.indexOf('"', 1) : s.search(/\s|$/);
  const exe = s.startsWith('"') ? s.slice(1, exeEnd) : s.slice(0, exeEnd);
  const rest = s.slice(s.startsWith('"') ? exeEnd + 1 : exeEnd);
  if (exeEnd <= 0 || !exe || (rest && !/^\s/.test(rest))) throw unavailable('commande du navigateur par défaut illisible');
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (!['%1', '"%1"'].includes(tokens.at(-1)) || tokens.slice(0, -1).some(t => !KNOWN_STATIC_ARGS.has(t))) {
    throw unavailable('commande du navigateur par défaut non reconnue');
  }
  if (/[%"]/.test(exe) || !/^[A-Za-z]:\\/.test(exe) || exe.split('\\').some(part => part === '..' || part === '.')) {
    throw unavailable('chemin du navigateur par défaut non local ou non absolu');
  }
  const name = path.win32.basename(exe).toLowerCase();
  const folder = path.win32.basename(path.win32.dirname(exe)).toLowerCase();
  if (KNOWN_DEFAULT_BROWSERS.get(name) !== folder) throw unavailable(`navigateur par défaut non pris en charge (${name})`);
  let stat;
  try { stat = fs.statSync(exe); } catch { stat = null; }
  if (!stat?.isFile()) throw unavailable('exécutable du navigateur par défaut introuvable');
  return exe;
}

/** The default browser's own executable for this http/https scheme (registry, local, no network). */
export function resolveDefaultBrowserExecutable(scheme, { readRegistry = readRegistryString, platform = process.platform } = {}) {
  if (platform !== 'win32') throw unavailable('résolution du navigateur par défaut disponible sous Windows uniquement');
  if (scheme !== 'http' && scheme !== 'https') throw unavailable('schéma non pris en charge');
  const assoc = `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}`;
  const progId = readRegistry(`${assoc}\\UserChoiceLatest\\ProgId`, 'ProgId') ?? readRegistry(`${assoc}\\UserChoice`, 'ProgId');
  if (progId !== null && !PROG_ID.test(progId)) throw unavailable('association du navigateur par défaut invalide');
  const command = readRegistry(progId ? `HKCR\\${progId}\\shell\\open\\command` : `HKCR\\${scheme}\\shell\\open\\command`, null);
  if (!command) throw unavailable('navigateur par défaut introuvable');
  return parseBrowserOpenCommand(command);
}

const BLOCKED_SCHEMES = new Set(['file:', 'javascript:', 'data:', 'powershell:', 'cmd:', 'vbscript:', 'about:', 'shell:', 'ftp:', 'ms-settings:']);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_URL_LENGTH = 8192;

// Only http:/https: may ever be opened — everything else (including
// javascript:, file:, data:, powershell:, cmd:) is rejected before spawn.
// [SEC-REMED-1] Fail closed on control characters (the URL parser would
// silently drop CR / LF / TAB) and re-check the normalised form: it is passed
// as ONE argv element, so it must hold no quote, whitespace or control char.
export function assertOpenableUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('URL invalide');
  if (rawUrl.length > MAX_URL_LENGTH || CONTROL_CHARS.test(rawUrl)) throw new Error('URL invalide');
  let parsed;
  try { parsed = new URL(rawUrl.trim()); }
  catch { throw new Error('URL invalide'); }
  if (BLOCKED_SCHEMES.has(parsed.protocol) || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Protocole non autorisé : ${parsed.protocol} (http/https uniquement)`);
  }
  if (!parsed.hostname || /["\s]/.test(parsed.href) || CONTROL_CHARS.test(parsed.href)) throw new Error('URL invalide');
  return parsed.href;
}

// Resolves the executable + args to spawn for the currently selected
// browser. Never returns a shell string — always {command, args} for
// spawn(command, args, { shell: false }).
export function resolveOpenCommand(url, { readRegistry, platform } = {}) {
  const settings = getBrowserSettings();
  const installed = detectInstalledBrowsers();

  if (settings.selected === 'custom' && settings.customPath) {
    const verifiedPath = validateCustomBrowserPath(settings.customPath);
    return { command: verifiedPath, args: [url] };
  }

  if (settings.selected === 'system') {
    // [SEC-REMED-2] the default browser's own .exe, never a dispatcher (cmd.exe, explorer.exe, rundll32…)
    const scheme = new URL(url).protocol.slice(0, -1);
    return { command: resolveDefaultBrowserExecutable(scheme, { readRegistry, platform }), args: [url] };
  }

  const browser = installed.find(b => b.id === settings.selected);
  if (!browser || !browser.path) {
    throw new Error(`Navigateur '${settings.selected}' non détecté sur cette machine — vérifie qu'il est installé ou choisis-en un autre dans Paramètres.`);
  }
  return { command: browser.path, args: [url] };
}

// `spawnImpl`, `readRegistry` and `platform` are test seams only (the route never passes them).
export function openUrlInSelectedBrowser(url, { spawnImpl = spawn, readRegistry, platform } = {}) {
  const safeUrl = assertOpenableUrl(url);
  const { command, args } = resolveOpenCommand(safeUrl, { readRegistry, platform });
  // [SEC-REMED-2] last check before any process exists: an absolute local .exe that is not a launcher/interpreter, and
  // the URL as the ONE argument (it can never pick the executable, a switch, a file or an extra argv element).
  const exeName = path.win32.basename(command).toLowerCase();
  if (!/^[A-Za-z]:\\/.test(command) || !exeName.endsWith('.exe') || SHELL_LIKE_EXECUTABLES.has(exeName)
    || args.length !== 1 || args[0] !== safeUrl || !/^https?:\/\//.test(safeUrl)) {
    throw unavailable('lancement refusé');
  }
  const child = spawnImpl(command, [safeUrl], { shell: false, windowsVerbatimArguments: false, detached: true, stdio: 'ignore' });
  child.unref();
  return { opened: true, url: safeUrl };
}
