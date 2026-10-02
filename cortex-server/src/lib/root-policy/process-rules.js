/**
 * ROOT POLICY V1 closure (RPC-2C) — per-module TYPED PROCESS rules: which executable a module may start, with which arguments, from which
 * working directory. Pure data checks: no I/O, no clock, no imports, no network, no LLM (the decision engine stays deterministic).
 *
 * Why: PROCESS_START used to say "a known executor id with typed arguments, no shell" and nothing more — a module that could be fed a
 * different executable path (a setting, a downloaded folder) still passed. The SIGNED policy can now declare, per module and per executor id,
 *
 *     capabilities["PROCESS.START_TYPED"].constraints.executors[<module>][<executorId>] = {
 *       executables:       ["kiwix-serve.exe"]        // exact basenames, case-insensitive          (allow-list mode)
 *       deniedExecutables: ["cmd.exe", …]             // + executableExtension: ".exe"               (deny-list mode, for user-chosen programs)
 *       parentDir:         "python_embeded"           // optional: the executable's parent directory name
 *       argsTemplates:     ["comfyui-main"]           // one of the code-defined argument shapes below
 *     }
 *
 * A module that has NO entry keeps exactly the V1 behaviour (known executor id + typed arguments). A module that HAS an entry is fail-closed:
 * unknown executor id, unparsable path, wrong basename, wrong location, wrong argument shape or wrong working directory ⇒ refused.
 *
 * The argument shapes are CODE (a signed file can only pick from them, never invent one): that is the ceiling.
 * Everything is checked on the ACTUAL arguments the caller is about to pass, not on a label the caller chose.
 */

const MAX_PATH = 520;
const MAX_ARG = 8192;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PATH_FORBIDDEN = /[<>"|?*]/;
const BASENAME_RE = /^[A-Za-z0-9._ -]{1,64}$/;

/**
 * Absolute Windows path with a DRIVE LETTER, strictly: no UNC, no `..` / `.` segment, no `:` after the drive (alternate data streams),
 * no wildcard / redirection characters, no control character, no segment ending in a dot or a space (Windows would drop it).
 * @returns {{ drive:string, segments:string[], lower:string, baseLower:string, dirLower:string, parentLower:string|null } | null}
 */
export function parseAbsoluteWindowsPath(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_PATH || CONTROL.test(value) || PATH_FORBIDDEN.test(value)) return null;
  const match = /^([A-Za-z]:)[\\/]+(.*)$/.exec(value);
  if (!match) return null;
  const segments = match[2].split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    const last = segment.at(-1);
    if (segment === '.' || segment === '..' || segment.includes(':') || last === '.' || last === ' ') return null;
  }
  const drive = match[1].toUpperCase();
  const lowerSegments = segments.map(s => s.toLowerCase());
  const dirSegments = lowerSegments.slice(0, -1);
  return {
    drive,
    segments,
    lower: `${drive.toLowerCase()}\\${lowerSegments.join('\\')}`,
    baseLower: lowerSegments.at(-1),
    dirLower: `${drive.toLowerCase()}\\${dirSegments.join('\\')}`,
    parentLower: dirSegments.length ? dirSegments.at(-1) : null,
  };
}

/** An http(s) URL in its normalised form (what `new URL(x).href` returns): the only form a caller may pass. */
export function isNormalisedHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ARG || CONTROL.test(value) || /\s/.test(value) || value.startsWith('-')) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '' && parsed.href === value;
}

// cmd.exe re-parses its command line: these characters would end the `start` command and begin another one …
const CMD_METACHARACTERS = /[&|<>^"]/;
// … and `%NAME%` is expanded from the environment. A percent-ENCODED URL (`%C3%A9`) only ever produces two-hex-digit "names" between percents, so it is not
// confused with a variable; anything else between two percents is treated as a possible variable reference (refused for cmd.exe, fine for explorer.exe).
const hasCmdVariableReference = (text) => [...text.matchAll(/%([^%]*)%/g)].some(m => !/^[0-9A-Fa-f]{2}$/.test(m[1]));

/** Argument shapes. Each receives the ACTUAL argv, the parsed executable and the parsed working directory (or null when inherited). */
export const ARG_TEMPLATES = Object.freeze({
  // <browser.exe> <url>                                  — a real browser started directly: the URL is one argv entry, never re-parsed by a shell
  url: ({ args, cwd }) => cwd === null && args.length === 1 && isNormalisedHttpUrl(args[0]),
  // explorer.exe <url>                                   — the system default handler without any command interpreter
  'shell-open-url': ({ args, cwd }) => cwd === null && args.length === 1 && isNormalisedHttpUrl(args[0]),
  // cmd.exe /c start "" <url>                            — legacy default-browser dispatch; refused for a URL cmd.exe would reinterpret
  'cmd-start-url': ({ args, cwd }) => cwd === null && args.length === 4 && args[0] === '/c' && args[1] === 'start' && args[2] === ''
    && isNormalisedHttpUrl(args[3]) && !CMD_METACHARACTERS.test(args[3]) && !hasCmdVariableReference(args[3]),
  // kiwix-serve --port=N --address=127.0.0.1 --blockexternal <archive.zim>…   cwd = the executable's own directory
  'kiwix-serve-loopback': ({ args, executable, cwd }) => {
    if (!cwd || cwd.lower !== executable.dirLower) return false;
    if (args.length < 4 || !/^--port=\d{1,5}$/.test(args[0]) || Number(args[0].slice(7)) < 1 || Number(args[0].slice(7)) > 65535) return false;
    if (args[1] !== '--address=127.0.0.1' || args[2] !== '--blockexternal') return false;
    return args.slice(3).every(a => { const p = parseAbsoluteWindowsPath(a); return p !== null && p.baseLower.endsWith('.zim'); });
  },
  // <root>\python_embeded\python.exe -s <root>\ComfyUI\main.py --windows-standalone-build      cwd = <root>
  'comfyui-main': ({ args, executable, cwd }) => {
    if (!cwd || args.length !== 3 || args[0] !== '-s' || args[2] !== '--windows-standalone-build') return false;
    const main = parseAbsoluteWindowsPath(args[1]);
    if (!main || main.baseLower !== 'main.py' || main.parentLower !== 'comfyui') return false;
    const root = cwd.lower;
    return executable.lower === `${root}\\python_embeded\\python.exe` && main.lower === `${root}\\comfyui\\main.py`;
  },
  // 7za x <archive.7z[.tmp]> <destination-dir>   |   7za l <archive.7z[.tmp]>        (the descriptor of what node-7z is asked to do)
  'sevenzip-archive': ({ args, cwd }) => {
    if (cwd !== null || args.length < 2 || args.length > 3) return false;
    const archive = parseAbsoluteWindowsPath(args[1]);
    if (!archive || !/\.7z(\.tmp)?$/.test(archive.baseLower)) return false;
    if (args[0] === 'l') return args.length === 2;
    return args[0] === 'x' && args.length === 3 && parseAbsoluteWindowsPath(args[2]) !== null;
  },
});
export const ARG_TEMPLATE_IDS = Object.freeze(Object.keys(ARG_TEMPLATES));

const ENTRY_KEYS = ['executables', 'deniedExecutables', 'executableExtension', 'parentDir', 'argsTemplates'];
const isStrArray = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');

/** Structural validation of the `executors` constraint (used by schema.js, so a malformed signed policy is refused at load). */
export function validateExecutorsConstraint(executors, path, errors, { isModuleWithProcessCapability }) {
  if (executors === null || typeof executors !== 'object' || Array.isArray(executors)) { errors.push(`${path}: object required`); return; }
  for (const [moduleName, byExecutor] of Object.entries(executors)) {
    const here = `${path}.${moduleName}`;
    if (!isModuleWithProcessCapability(moduleName)) errors.push(`${here}: module unknown or without PROCESS.START_TYPED`);
    if (byExecutor === null || typeof byExecutor !== 'object' || Array.isArray(byExecutor) || Object.keys(byExecutor).length === 0) { errors.push(`${here}: executors required`); continue; }
    for (const [executorId, entry] of Object.entries(byExecutor)) {
      const where = `${here}.${executorId}`;
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(executorId)) errors.push(`${where}: invalid executor id`);
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${where}: object required`); continue; }
      for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) errors.push(`${where}.${key}: unknown key`);
      const hasAllow = entry.executables !== undefined;
      const hasDeny = entry.deniedExecutables !== undefined;
      if (hasAllow === hasDeny) errors.push(`${where}: exactly one of executables / deniedExecutables`);
      for (const key of ['executables', 'deniedExecutables']) {
        if (entry[key] === undefined) continue;
        if (!isStrArray(entry[key]) || entry[key].length === 0 || entry[key].some(n => !BASENAME_RE.test(n) || !n.toLowerCase().endsWith('.exe'))) errors.push(`${where}.${key}: non-empty list of .exe base names`);
      }
      if (hasDeny && entry.executableExtension !== '.exe') errors.push(`${where}.executableExtension: ".exe" required with deniedExecutables`);
      if (!hasDeny && entry.executableExtension !== undefined) errors.push(`${where}.executableExtension: only with deniedExecutables`);
      if (entry.parentDir !== undefined && (typeof entry.parentDir !== 'string' || !BASENAME_RE.test(entry.parentDir))) errors.push(`${where}.parentDir: base name required`);
      if (!isStrArray(entry.argsTemplates) || entry.argsTemplates.length === 0 || entry.argsTemplates.some(t => !ARG_TEMPLATE_IDS.includes(t))) errors.push(`${where}.argsTemplates: known templates required`);
    }
  }
}

/**
 * @param {Record<string, object>} rules  constraints.executors[<module>]
 * @param {{ executorId?:string, executable?:string, args?:string[], cwd?:string }} context
 * @returns {{ ok:true, executorId:string, template:string } | { ok:false, reason:string }}
 */
export function evaluateProcessRules(rules, context) {
  try {
    return evaluate(rules, context);
  } catch {
    return { ok: false, reason: 'RULE_OR_REQUEST_MALFORMED' }; // fail closed: a malformed rule (schema validation normally prevents it) or request never allows
  }
}

function evaluate(rules, context) {
  const entry = typeof context?.executorId === 'string' && Object.hasOwn(rules, context.executorId) ? rules[context.executorId] : undefined;
  if (!entry) return { ok: false, reason: 'EXECUTOR_NOT_DECLARED' };

  const executable = parseAbsoluteWindowsPath(context.executable);
  if (!executable) return { ok: false, reason: 'EXECUTABLE_PATH_INVALID' };
  if (Array.isArray(entry.executables)) {
    if (!entry.executables.some(name => name.toLowerCase() === executable.baseLower)) return { ok: false, reason: 'EXECUTABLE_NOT_PERMITTED' };
  } else {
    if (!executable.baseLower.endsWith(entry.executableExtension)) return { ok: false, reason: 'EXECUTABLE_NOT_PERMITTED' };
    if (entry.deniedExecutables.some(name => name.toLowerCase() === executable.baseLower)) return { ok: false, reason: 'EXECUTABLE_DENIED' };
  }
  if (entry.parentDir !== undefined && executable.parentLower !== entry.parentDir.toLowerCase()) return { ok: false, reason: 'EXECUTABLE_LOCATION' };

  if (!Array.isArray(context.args) || context.args.some(a => typeof a !== 'string' || a.length > MAX_ARG || a.includes('\u0000'))) return { ok: false, reason: 'ARGUMENTS_NOT_TYPED' };
  let cwd = null;
  if (context.cwd !== undefined && context.cwd !== null) {
    cwd = parseAbsoluteWindowsPath(context.cwd);
    if (!cwd) return { ok: false, reason: 'CWD_INVALID' };
  }
  const input = { args: context.args, executable, cwd };
  const template = entry.argsTemplates.find(id => Object.hasOwn(ARG_TEMPLATES, id) && ARG_TEMPLATES[id](input));
  return template ? { ok: true, executorId: context.executorId, template } : { ok: false, reason: 'ARGUMENTS_NOT_PERMITTED' };
}
