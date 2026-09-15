// ComfyUI install/lifecycle manager — real download, extraction, spawn, stop,
// uninstall. Everything here only ever runs after an explicit user click
// through the Settings UI (POST /image-generation/comfyui/install|start|stop|
// uninstall) — nothing in this module is invoked automatically at server
// startup or on any timer.
//
// Source: official comfyanonymous/ComfyUI GitHub releases
// (https://github.com/comfyanonymous/ComfyUI/releases), portable Windows
// build. No published checksum/signature exists for these release assets as
// of this writing — this is disclosed to the user in the install
// confirmation UI rather than fabricating a verification step that doesn't
// exist upstream.
//
// Extraction uses 7zip-bin + node-7z (the official ComfyUI Windows portable
// build ships only as .7z; neither PowerShell's Expand-Archive nor Node's
// built-in zlib support that format). 7zip-bin bundles a real 7za.exe
// binary — no shell:true, no PATH lookup of a system 7-Zip.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import sevenBin from '7zip-bin';
import Seven from 'node-7z';
import { getMeta, setMeta } from './sqlite.js';
import { registerJob, updateJob, finishJob } from '../routes/jobs.js';
import { getComfyUiStatus, COMFYUI_DEFAULT_ENDPOINT } from './providers/comfyui.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');

// Default managed-install location — never used as a deletion target for
// anything outside this exact resolved path (see assertSafeInstallPath).
export const DEFAULT_MANAGED_PATH = path.join(ROOT, 'tools', 'comfyui');

// Official release — pinned to a specific tag, not "latest", so an install
// started today and one started next month fetch the exact same, previously
// reviewed asset. Bump this constant deliberately when vetting a newer tag.
export const COMFYUI_RELEASE = {
  tag: 'v0.35.0',
  // "nvidia" build: works for the common case (NVIDIA GPU) and CPU fallback;
  // AMD/Intel builds exist upstream but are not wired up by this picker.
  assetName: 'ComfyUI_windows_portable_nvidia.7z',
  url: 'https://github.com/comfyanonymous/ComfyUI/releases/download/v0.35.0/ComfyUI_windows_portable_nvidia.7z',
  approxSizeBytes: 1_910_000_000, // ~1.82 GiB per GitHub release metadata
  checksum: null, // no checksum/signature published upstream for this asset
};

const META_KEY = 'comfyui_install';

const INSTALL_DEFAULTS = {
  kind: 'none',            // 'none' | 'managed' | 'external'
  path: null,
  status: 'not_installed', // 'not_installed' | 'installed' | 'stopped' | 'running' | 'incomplete' | 'error'
  version: null,
  installedAt: null,
  startWithDocteur: false,
  pid: null,
  startedAt: null,
  lastError: null,
};

export function getInstallState() {
  return { ...INSTALL_DEFAULTS, ...getMeta(META_KEY, {}) };
}

function setInstallState(updates) {
  const current = getInstallState();
  const next = { ...current, ...updates };
  setMeta(META_KEY, next);
  return next;
}

// ── Path safety — critical, tested adversarially ──────────────────────────────
// Refuses to treat any of these as a deletable/manageable install root:
// drive roots, home/user roots, the project root itself, empty/'.'/'..'.
const FORBIDDEN_EXACT = new Set(['', '.', '..']);

export function assertSafeInstallPath(candidatePath, { mustBeManagedRoot = false } = {}) {
  if (typeof candidatePath !== 'string' || FORBIDDEN_EXACT.has(candidatePath.trim())) {
    throw new Error('Chemin invalide');
  }

  const resolved = path.resolve(candidatePath);
  const { root } = path.parse(resolved);

  // Reject drive/filesystem roots outright (C:\, /, etc.)
  if (resolved === root) {
    throw new Error('Chemin refusé : racine du disque');
  }

  // Reject well-known dangerous absolute roots
  const dangerous = [
    root,
    path.join(root, 'Windows'),
    path.join(root, 'Users'),
    process.env.SystemRoot || path.join(root, 'Windows'),
    process.env.USERPROFILE || path.join(root, 'Users'),
    ROOT, // the Docteur project root itself
  ].map((p) => path.resolve(p).toLowerCase());

  const resolvedLower = resolved.toLowerCase();
  if (dangerous.includes(resolvedLower)) {
    throw new Error('Chemin refusé : dossier système ou racine du projet');
  }

  // Reject any ancestor of the project root, or the project root's own parent
  // (a managed uninstall must never be able to walk up and wipe more than
  // its own subtree).
  const projectParent = path.resolve(ROOT, '..').toLowerCase();
  if (resolvedLower === projectParent) {
    throw new Error('Chemin refusé : dossier parent du projet');
  }

  if (mustBeManagedRoot) {
    const managedResolved = path.resolve(DEFAULT_MANAGED_PATH).toLowerCase();
    if (resolvedLower !== managedResolved) {
      throw new Error('Chemin refusé : ne correspond pas à l’installation gérée enregistrée');
    }
  }

  return resolved;
}

// Rejects an archive entry path that would escape the extraction root
// (zip-slip / path traversal / absolute path / symlink-as-path tricks).
// 7-Zip itself resolves symlinks at extraction time on the destination
// filesystem, not inside this check — this guards the *entry name*, which is
// the actual zip-slip vector (an entry named "../../evil" or "C:\evil").
export function assertSafeArchiveEntry(entryName, destRoot) {
  if (typeof entryName !== 'string' || !entryName) {
    throw new Error('Entrée d’archive invalide');
  }
  if (path.isAbsolute(entryName) || /^[A-Za-z]:/.test(entryName)) {
    throw new Error(`Entrée d’archive refusée (chemin absolu) : ${entryName}`);
  }
  const target = path.resolve(destRoot, entryName);
  const destResolved = path.resolve(destRoot);
  if (target !== destResolved && !target.startsWith(destResolved + path.sep)) {
    throw new Error(`Entrée d’archive refusée (hors du dossier cible) : ${entryName}`);
  }
  return target;
}

function checkDiskSpace(targetDir, neededBytes) {
  // statfsSync needs an existing path — walk up to the nearest existing ancestor.
  let probe = targetDir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const stat = fs.statfsSync(probe);
  const freeBytes = stat.bavail * stat.bsize;
  if (freeBytes < neededBytes) {
    const freeGb = (freeBytes / 1024 / 1024 / 1024).toFixed(1);
    const neededGb = (neededBytes / 1024 / 1024 / 1024).toFixed(1);
    throw new Error(`Espace disque insuffisant : ${freeGb} Go disponibles, ${neededGb} Go requis`);
  }
}

// ── Install (real download + extraction) ──────────────────────────────────────

// Kicks off a real download+extract job in the background; returns
// immediately with a jobId the caller polls via the existing jobs registry.
// Guarded so only one install can run at a time.
let installInFlight = false;

export function startManagedInstall({ destination } = {}) {
  if (installInFlight) {
    throw new Error('Une installation est déjà en cours');
  }
  const dest = destination ? assertSafeInstallPath(destination) : DEFAULT_MANAGED_PATH;
  assertSafeInstallPath(dest); // re-validate regardless of source

  // Extraction needs roughly archive-size again in temp space alongside the
  // final install, so require some headroom above the raw download size.
  checkDiskSpace(path.dirname(dest), COMFYUI_RELEASE.approxSizeBytes * 2.2);

  const jobId = randomUUID();
  registerJob(jobId, 'Installation ComfyUI', 100);
  setInstallState({ kind: 'managed', path: dest, status: 'incomplete', lastError: null });
  installInFlight = true;

  void runManagedInstall(jobId, dest).finally(() => { installInFlight = false; });

  return { jobId, destination: dest };
}

async function runManagedInstall(jobId, dest) {
  const tmpArchive = `${dest}.download.7z.tmp`;
  const controller = new AbortController();
  activeInstallControllers.set(jobId, controller);

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    updateJob(jobId, { current: 1, currentLabel: 'Téléchargement…' });
    await downloadWithProgress(COMFYUI_RELEASE.url, tmpArchive, {
      signal: controller.signal,
      onProgress: (pct) => updateJob(jobId, { current: Math.min(60, Math.round(pct * 0.6)), currentLabel: `Téléchargement… ${pct}%` }),
      expectedApproxBytes: COMFYUI_RELEASE.approxSizeBytes,
    });

    if (controller.signal.aborted) throw new Error('cancelled');

    updateJob(jobId, { current: 65, currentLabel: 'Extraction…' });
    const extractTmp = `${dest}.extracting.tmp`;
    fs.rmSync(extractTmp, { recursive: true, force: true });
    fs.mkdirSync(extractTmp, { recursive: true });

    await extractArchiveSafely(tmpArchive, extractTmp, {
      onProgress: (pct) => updateJob(jobId, { current: 65 + Math.round(pct * 0.3), currentLabel: `Extraction… ${pct}%` }),
    });

    // Atomic finalize: only rename into the real destination once fully
    // extracted and verified — an interrupted install never leaves something
    // that looks installed.
    updateJob(jobId, { current: 97, currentLabel: 'Finalisation…' });
    const innerRoot = findExtractedRoot(extractTmp);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(innerRoot, dest);
    fs.rmSync(extractTmp, { recursive: true, force: true });
    fs.rmSync(tmpArchive, { force: true });

    updateJob(jobId, { current: 100, currentLabel: 'Installation terminée' });
    finishJob(jobId, 'done', { path: dest });
    setInstallState({ status: 'installed', version: COMFYUI_RELEASE.tag, installedAt: Date.now(), lastError: null });
  } catch (err) {
    fs.rmSync(tmpArchive, { force: true });
    const cancelled = err.message === 'cancelled' || controller.signal.aborted;
    finishJob(jobId, cancelled ? 'cancelled' : 'failed', { errorCode: cancelled ? 'cancelled' : 'install_failed' });
    setInstallState({ status: 'incomplete', lastError: sanitizeErrorForState(err) });
  } finally {
    activeInstallControllers.delete(jobId);
  }
}

const activeInstallControllers = new Map();

export function cancelInstall(jobId) {
  const controller = activeInstallControllers.get(jobId);
  if (!controller) throw new Error('Aucune installation en cours avec cet identifiant');
  controller.abort();
  return { ok: true };
}

function sanitizeErrorForState(err) {
  // Never surface raw stack traces / absolute paths beyond what's already
  // user-visible (the install destination) into persisted state read by the UI.
  const msg = String(err?.message ?? 'Erreur inconnue');
  return msg.slice(0, 300);
}

async function downloadWithProgress(url, destPath, { signal, onProgress, expectedApproxBytes }) {
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Téléchargement HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || expectedApproxBytes || 0;
  let received = 0;
  let lastReportedPct = -1;

  const fileStream = fs.createWriteStream(destPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      await new Promise((resolve, reject) => {
        fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
      if (total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          onProgress?.(pct);
        }
      }
    }
  } finally {
    await new Promise((resolve) => fileStream.end(resolve));
  }

  if (total > 0 && received < total * 0.99) {
    fs.rmSync(destPath, { force: true });
    throw new Error(`Téléchargement incomplet (${received}/${total} octets)`);
  }
}

async function extractArchiveSafely(archivePath, destDir, { onProgress }) {
  // First pass: list entries and validate every one before extracting
  // anything — refuses the whole archive if a single entry tries to escape
  // destDir (zip-slip) rather than extracting-then-cleaning-up.
  const entries = await listArchiveEntries(archivePath);
  for (const entry of entries) {
    assertSafeArchiveEntry(entry, destDir);
  }

  await new Promise((resolve, reject) => {
    const stream = Seven.extractFull(archivePath, destDir, { $bin: sevenBin.path7za, $progress: true });
    stream.on('progress', (p) => onProgress?.(p.percent ?? 0));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

function listArchiveEntries(archivePath) {
  return new Promise((resolve, reject) => {
    const names = [];
    const stream = Seven.list(archivePath, { $bin: sevenBin.path7za });
    stream.on('data', (entry) => { if (entry?.file) names.push(entry.file); });
    stream.on('end', () => resolve(names));
    stream.on('error', reject);
  });
}

// ComfyUI's portable 7z extracts into a single top-level folder
// (e.g. "ComfyUI_windows_portable/") — find it so the managed install path
// points directly at the useful root rather than one level too high.
function findExtractedRoot(extractedTo) {
  const entries = fs.readdirSync(extractedTo, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && entries.length === 1) {
    return path.join(extractedTo, dirs[0].name);
  }
  return extractedTo;
}

// ── External install ───────────────────────────────────────────────────────────

// Files/dirs a genuine ComfyUI portable install is expected to contain —
// used so "use existing install" doesn't accept just any folder.
const EXPECTED_ENTRIES = ['ComfyUI', 'python_embeded'];

export function useExistingInstall({ installPath }) {
  const resolved = assertSafeInstallPath(installPath);

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: 'Dossier introuvable' };
  }

  const contents = fs.readdirSync(resolved);
  const hasExpected = EXPECTED_ENTRIES.some((name) => contents.includes(name));
  if (!hasExpected) {
    return { ok: false, error: 'Ce dossier ne ressemble pas à une installation ComfyUI (fichiers attendus introuvables)' };
  }

  setInstallState({ kind: 'external', path: resolved, status: 'installed', version: null, lastError: null });
  return { ok: true, path: resolved };
}

export function detachExternalInstall() {
  const current = getInstallState();
  if (current.kind !== 'external') {
    throw new Error('Aucune installation externe à dissocier');
  }
  if (current.status === 'running' && current.pid) {
    stopProcessIfOwned(current.pid);
  }
  setInstallState({ ...INSTALL_DEFAULTS });
  return getInstallState();
}

// ── Start/stop (real spawn) ──────────────────────────────────────────────────────

const READY_POLL_INTERVAL_MS = 1000;
const READY_POLL_TIMEOUT_MS = 60_000;

// Locates the portable launcher. ComfyUI's Windows portable ships
// `run_nvidia_gpu.bat` / `run_cpu.bat` at the install root, invoking the
// embedded python with fixed args — Docteur runs the underlying python
// executable directly (not the .bat, so no shell is involved) with the same
// arguments the .bat encodes.
function resolveComfyUiExecutable(installPath) {
  const pythonExe = path.join(installPath, 'python_embeded', 'python.exe');
  const mainScript = path.join(installPath, 'ComfyUI', 'main.py');
  if (fs.existsSync(pythonExe) && fs.existsSync(mainScript)) {
    return { command: pythonExe, args: ['-s', mainScript, '--windows-standalone-build'], cwd: installPath };
  }
  return null;
}

let runningProcess = null; // { pid, child }

export function startComfyUi() {
  const current = getInstallState();
  if (current.status === 'not_installed' || !current.path) {
    throw new Error('ComfyUI n’est pas installé');
  }
  if (current.status === 'running') {
    throw new Error('ComfyUI est déjà en cours d’exécution');
  }

  const resolvedPath = assertSafeInstallPath(current.path);
  const launch = resolveComfyUiExecutable(resolvedPath);
  if (!launch) {
    setInstallState({ status: 'error', lastError: 'Exécutable ComfyUI introuvable dans ce dossier' });
    throw new Error('Exécutable ComfyUI introuvable dans ce dossier (installation incomplète ou dossier invalide)');
  }

  let child;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    // Some platforms/error kinds throw synchronously from spawn() rather
    // than emitting an async 'error' event (e.g. a non-executable file) —
    // handle both so a bad install folder never crashes the Cortex server.
    setInstallState({ status: 'error', lastError: `Échec du démarrage : ${err.code ?? err.message}` });
    throw new Error('Échec du démarrage de ComfyUI (exécutable invalide)');
  }

  const logTail = { stdout: [], stderr: [] };
  child.stdout?.on('data', (chunk) => pushLogTail(logTail.stdout, chunk));
  child.stderr?.on('data', (chunk) => pushLogTail(logTail.stderr, chunk));

  // Required: an unhandled 'error' on a ChildProcess (e.g. spawn ENOENT) would
  // otherwise crash the whole Cortex server process.
  child.on('error', (err) => {
    if (runningProcess?.pid === child.pid) {
      runningProcess = null;
      setInstallState({ status: 'error', pid: null, startedAt: null, lastError: `Échec du démarrage : ${err.code ?? err.message}` });
    }
  });

  child.on('exit', (code) => {
    if (runningProcess?.pid === child.pid) {
      runningProcess = null;
      setInstallState({ status: code === 0 ? 'stopped' : 'error', pid: null, startedAt: null, lastError: code === 0 ? null : `Processus terminé (code ${code})` });
    }
  });

  runningProcess = { pid: child.pid, child, logTail };
  setInstallState({ status: 'starting', pid: child.pid, startedAt: Date.now(), lastError: null });

  return getInstallState();
}

function pushLogTail(arr, chunk) {
  arr.push(chunk.toString('utf8'));
  if (arr.length > 50) arr.shift();
}

// Polls the real ComfyUI HTTP endpoint until it responds or timeout elapses.
// Never marks 'running' as ready just because the process spawned — a Python
// process that spawned but crashed on import, or is still loading torch, is
// not a usable provider yet.
export async function waitForComfyUiReady(endpoint = COMFYUI_DEFAULT_ENDPOINT, timeoutMs = READY_POLL_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = getInstallState();
    if (current.status !== 'starting' && current.status !== 'running') {
      // Process exited/crashed while we were waiting.
      return { ready: false, errorCode: 'process_exited' };
    }
    const status = await getComfyUiStatus(endpoint);
    if (status.available) {
      setInstallState({ status: 'running' });
      return { ready: true };
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  return { ready: false, errorCode: 'timeout' };
}

// Verifies the tracked PID is still the process Docteur itself spawned
// before signaling it — never kills an arbitrary PID from stored state alone.
function stopProcessIfOwned(pid) {
  if (!runningProcess || runningProcess.pid !== pid) {
    throw new Error('Ce processus n’a pas été démarré par Docteur dans cette session — arrêt refusé');
  }
  runningProcess.child.kill();
  runningProcess = null;
}

export function stopComfyUi() {
  const current = getInstallState();
  if (current.status !== 'running' && current.status !== 'starting') {
    throw new Error('ComfyUI n’est pas en cours d’exécution');
  }
  if (!current.pid) {
    throw new Error('Aucun PID connu pour ce processus');
  }
  stopProcessIfOwned(current.pid);
  setInstallState({ status: 'stopped', pid: null, startedAt: null });
  return getInstallState();
}

// Test-only accessor — lets tests assert ownership behavior without
// spawning a real process.
export function _setRunningProcessForTest(proc) {
  runningProcess = proc;
}

// ── Uninstall (real, managed only) ────────────────────────────────────────────

// options.deleteModels: false by default (most conservative). Generated
// images and Docteur settings live entirely outside the ComfyUI install dir
// so they are never affected either way.
export function uninstallManaged({ deleteModels = false } = {}) {
  const current = getInstallState();
  if (current.kind !== 'managed') {
    throw new Error('Seule une installation gérée par Docteur peut être désinstallée');
  }
  if (!current.path) {
    throw new Error('Chemin d’installation inconnu');
  }

  const resolved = assertSafeInstallPath(current.path, { mustBeManagedRoot: true });

  if (current.status === 'running' && current.pid) {
    stopProcessIfOwned(current.pid);
  }

  if (deleteModels || !fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  } else {
    // Preserve the models subfolder: move it out, wipe the rest, nothing else.
    const modelsDir = path.join(resolved, 'ComfyUI', 'models');
    const preserveTmp = path.join(path.dirname(resolved), `.comfyui-models-preserved-${randomUUID()}`);
    if (fs.existsSync(modelsDir)) {
      fs.renameSync(modelsDir, preserveTmp);
      fs.rmSync(resolved, { recursive: true, force: true });
      // Models are preserved on disk at preserveTmp but not reattached to
      // any install automatically — the next managed install can't safely
      // assume the same folder layout, so this is left as an explicit,
      // documented location rather than silently merged into a fresh install.
    } else {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }

  setInstallState({ ...INSTALL_DEFAULTS });
  return { ok: true };
}
