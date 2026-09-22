import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getKiwixSettings } from './sqlite.js';
import { checkPortOwnership } from './port-preflight.js';

export const KIWIX_TOOLS_URL = 'https://download.kiwix.org/release/kiwix-tools/';

// kiwix-serve's own --help (v3.7.0, empirically confirmed 2026-09-22 via
// `kiwix-serve.exe --help`): "-i, --address  Listen only on this ip
// address, all available ones otherwise" — i.e. WITHOUT this flag,
// kiwix-serve binds to all interfaces (confirmed empirically with
// netstat/Get-NetTCPConnection: 0.0.0.0:<port> LISTENING). This constant is
// the loopback-only enforcement the mission requires; it is never
// user-configurable — Docteur always spawns kiwix-serve loopback-only.
const LOOPBACK_ADDRESS = '127.0.0.1';

// ── État du process (un seul kiwix-serve géré à la fois) ──────────────────────

let _child       = null;
let _startedPort = null;
let _startedArchives = [];
let _lastError   = null;

export function defaultArchivesFolder() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'kiwix-desktop');
}

// ── Détection du binaire ──────────────────────────────────────────────────────

export function resolveKiwixServeBinary() {
  const settings = getKiwixSettings();
  const configuredPath = settings.kiwixServePath;
  if (configuredPath) {
    const direct = configuredPath.toLowerCase().endsWith('.exe')
      ? configuredPath
      : path.join(configuredPath, 'kiwix-serve.exe');
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

// ── Scan des archives .zim ────────────────────────────────────────────────────

export function scanArchives(folder) {
  const target = folder || getKiwixSettings().archivesFolder || defaultArchivesFolder();
  if (!fs.existsSync(target)) return { folder: target, archives: [] };

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { folder: target, archives: [] };
  }

  const archives = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.zim'))
    .map(e => {
      const fullPath = path.join(target, e.name);
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch { /* ignore */ }
      return {
        name: path.basename(e.name, path.extname(e.name)),
        fileName: e.name,
        path: fullPath,
        sizeBytes: size,
      };
    });

  return { folder: target, archives };
}

// ── Vérification port libre ────────────────────────────────────────────────────

export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

// ── Health check (port déjà occupé par un kiwix-serve tournant ou non) ───────

export async function healthCheck(port) {
  const target = port || getKiwixSettings().port || 8090;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    const res = await fetch(`http://127.0.0.1:${target}/`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok || res.status === 404; // kiwix-serve répond même sans lib configurée
  } catch {
    return false;
  }
}

export function getStatus() {
  return {
    running: _child !== null,
    port: _startedPort,
    archives: _startedArchives,
    lastError: _lastError,
    pid: _child?.pid ?? null,
  };
}

// ── Vérification empirique du binding (post-spawn) ────────────────────────────
// kiwix-serve's own process exiting cleanly on a bad bind (see corrupted-ZIM /
// port-in-use tests) is not itself proof the socket is loopback-only — a
// future kiwix-tools release could change --address's default or behavior.
// This checks the OS's own view of the listening socket after spawn and
// refuses/stops if it is ever anything other than 127.0.0.1, using the same
// read-only PowerShell Get-NetTCPConnection path port-preflight.js already
// uses for the cortex-server port (checkPortOwnership), so this doesn't
// introduce a second PowerShell-invocation pattern.
export async function verifyLoopbackBinding(port, { checkOwnership = checkPortOwnership } = {}) {
  const loopback = await checkOwnership(LOOPBACK_ADDRESS, port);
  // A listener on 127.0.0.1 for this port is expected (that's kiwix-serve
  // itself, just spawned). What matters is that it is NOT *also* bound wide:
  // probe 0.0.0.0 directly — if kiwix-serve ever bound wide despite
  // --address=127.0.0.1, Get-NetTCPConnection with LocalAddress=0.0.0.0
  // would show a listener on this port too.
  const wide = await checkOwnership('0.0.0.0', port);
  const boundWide = wide.state === 'owned_by_unknown' || wide.state === 'owned_by_cortex';
  return { loopbackOnly: !boundWide, loopback, wide };
}

// ── Démarrage / arrêt ──────────────────────────────────────────────────────────

export async function startKiwixServe({
  logger, spawnFn = spawn,
  // Injectable for tests only — production always uses the real ~8s budget
  // (16 attempts × 500ms) to give a real kiwix-serve process time to open
  // its large ZIM archive(s) and start listening.
  healthCheckAttempts = 16, healthCheckIntervalMs = 500,
} = {}) {
  if (_child) {
    return { ok: true, alreadyRunning: true, ...getStatus() };
  }

  const binary = resolveKiwixServeBinary();
  if (!binary) {
    _lastError = 'binary_not_found';
    return {
      ok: false,
      error: 'binary_not_found',
      message: `kiwix-serve.exe introuvable. Télécharge kiwix-tools_win-i686.zip depuis ${KIWIX_TOOLS_URL}, extrais-le, puis renseigne le dossier dans Réglages.`,
    };
  }

  const settings = getKiwixSettings();
  const port = Number(settings.port) || 8090;
  const { folder, archives } = scanArchives(settings.archivesFolder);

  if (archives.length === 0) {
    _lastError = 'no_archives';
    return {
      ok: false,
      error: 'no_archives',
      message: `Aucune archive .zim trouvée dans ${folder}.`,
    };
  }

  const alreadyUp = await healthCheck(port);
  if (alreadyUp) {
    _lastError = null;
    return { ok: true, externallyManaged: true, port, archives, message: 'Un kiwix-serve répond déjà sur ce port.' };
  }

  // Port ownership: never kill an unknown process on a busy port. isPortFree()
  // (bind-attempt classification) is sufficient here — unlike the single
  // canonical cortex-server port that port-preflight.js's checkPortOwnership()
  // was built to identify (a fixed, known process signature: node src/server.js),
  // the kiwix port is user-configurable and the "expected" owner is an
  // arbitrary user-supplied kiwix-serve.exe with no fixed command-line
  // signature to match against — so process-identity classification doesn't
  // generalize the way it does for cortex-server's own port. Both paths share
  // the same non-negotiable behavior: on any occupied port, refuse to start
  // and never attempt to kill whatever is listening there.
  const portFree = await isPortFree(port);
  if (!portFree) {
    _lastError = 'port_in_use';
    return { ok: false, error: 'port_in_use', message: `Le port ${port} est déjà utilisé par un autre processus.` };
  }

  // Loopback-only + block external links: --address is mandatory (kiwix-serve
  // binds to ALL interfaces without it, confirmed empirically 2026-09-22 via
  // netstat showing 0.0.0.0:<port> LISTENING with no --address passed).
  // --blockexternal is kiwix-serve's own built-in flag (confirmed present in
  // v3.7.0 --help output) to prevent users from directly following external
  // links out of a served article.
  const args = [
    `--port=${port}`,
    `--address=${LOOPBACK_ADDRESS}`,
    '--blockexternal',
    ...archives.map(a => a.path),
  ];

  try {
    const child = spawnFn(binary, args, {
      cwd: path.dirname(binary),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    child.on('error', (err) => {
      _lastError = err.message;
      logger?.error?.({ error: err.message }, 'kiwix-serve process error');
      _child = null;
    });
    child.on('exit', (code) => {
      logger?.info?.({ code }, 'kiwix-serve exited');
      _child = null;
      _startedPort = null;
      _startedArchives = [];
    });
    child.stderr?.on('data', (chunk) => {
      logger?.warn?.('kiwix-serve stderr (line suppressed from logs — may contain request paths)');
    });

    _child = child;
    _startedPort = port;
    _startedArchives = archives;
    _lastError = null;

    // Attendre que le serveur réponde (jusqu'à ~8s en production)
    let up = false;
    for (let i = 0; i < healthCheckAttempts; i++) {
      await new Promise(r => setTimeout(r, healthCheckIntervalMs));
      if (!_child) break; // crashed
      up = await healthCheck(port);
      if (up) break;
    }

    if (!up) {
      logger?.warn('kiwix-serve did not respond in time after spawn');
      return { ok: true, port, archives, bindingVerified: false, message: `kiwix-serve démarré avec ${archives.length} archive(s) mais ne répond pas encore.` };
    }

    // Empirical post-spawn binding verification — refuse/stop if ever found
    // bound wide despite --address=127.0.0.1 (defense in depth against a
    // future kiwix-tools behavior change).
    let bindingVerified = true;
    try {
      const binding = await verifyLoopbackBinding(port);
      if (!binding.loopbackOnly) {
        logger?.error?.('kiwix-serve bound to a non-loopback address despite --address=127.0.0.1 — stopping');
        stopKiwixServe();
        _lastError = 'binding_not_loopback';
        return { ok: false, error: 'binding_not_loopback', message: 'kiwix-serve ne s\'est pas lié en local uniquement — arrêté par sécurité.' };
      }
    } catch {
      // undetermined (non-Windows, or PowerShell check failed) — do not
      // block startup on an inconclusive check; --address=127.0.0.1 was
      // still passed to the process itself.
      bindingVerified = false;
    }

    return { ok: true, port, archives, bindingVerified, message: `kiwix-serve démarré avec ${archives.length} archive(s).` };
  } catch (err) {
    _lastError = err.message;
    _child = null;
    return { ok: false, error: 'spawn_failed', message: err.message };
  }
}

export function stopKiwixServe() {
  if (!_child) return { ok: true, wasRunning: false };
  try {
    _child.kill();
  } catch { /* ignore */ }
  _child = null;
  _startedPort = null;
  _startedArchives = [];
  return { ok: true, wasRunning: true };
}

export function registerShutdownHook(logger) {
  const shutdown = () => {
    if (_child) {
      logger?.info?.('stopping kiwix-serve on shutdown');
      stopKiwixServe();
    }
  };
  process.on('exit', shutdown);
}
