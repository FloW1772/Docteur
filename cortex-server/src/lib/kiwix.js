import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getKiwixSettings } from './sqlite.js';

export const KIWIX_TOOLS_URL = 'https://download.kiwix.org/release/kiwix-tools/';

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

// ── Démarrage / arrêt ──────────────────────────────────────────────────────────

export async function startKiwixServe({ logger } = {}) {
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

  const portFree = await isPortFree(port);
  if (!portFree) {
    _lastError = 'port_in_use';
    return { ok: false, error: 'port_in_use', message: `Le port ${port} est déjà utilisé par un autre processus.` };
  }

  const args = [`--port=${port}`, ...archives.map(a => a.path)];

  try {
    const child = spawn(binary, args, {
      cwd: path.dirname(binary),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      logger?.warn?.({ line: chunk.toString().trim() }, 'kiwix-serve stderr');
    });

    _child = child;
    _startedPort = port;
    _startedArchives = archives;
    _lastError = null;

    // Attendre que le serveur réponde (jusqu'à ~8s)
    let up = false;
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!_child) break; // crashed
      up = await healthCheck(port);
      if (up) break;
    }

    if (!up) {
      logger?.warn('kiwix-serve did not respond in time after spawn');
    }

    return { ok: true, port, archives, message: `kiwix-serve démarré avec ${archives.length} archive(s).` };
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
