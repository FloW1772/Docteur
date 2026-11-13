// [STARTUP-2] Docteur-Launcher.bat option [1] (mode PC local), as one deterministic sequence:
//   PREFLIGHT → PORT_CHECK (3001 + 5173, before anything starts) → OLLAMA (never blocking) → BACKEND → FRONTEND → BROWSER_OPENING
// Exit 0 means "both services verified ready, open Chrome"; anything else leaves Chrome closed and prints a stable error code,
// a plain-French explanation and an action. Nothing is ever terminated except a CONFIRMED Docteur backend that stopped
// answering, after the user typed O, through launcher-identity's pinned re-verification.
//   node scripts/docteur-launch.mjs           daily use: backend `npm start` (no file watcher)            [STARTUP-3]
//   node scripts/docteur-launch.mjs --dev     development: backend `npm run dev` (node --watch, auto-restart)
// Exit codes: 0 ready → the .bat opens Chrome · 10 ready and a Docteur window was already open (brought back) · 1 failure.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  BACKEND_PORT, FRONTEND_PORT, OLLAMA_PORT, REPO_ROOT, STATES,
  takeSnapshot, classifyPort, findDocteurProcesses, backendTerminationTargets, terminatePinned,
} from './launcher-identity.mjs';
import { acquireLock, releaseLock, defaultLockDir } from './launcher-lock.mjs';
import { DEFAULT_URL as FRONTEND_URL, loopbackTarget, probeFrontend } from './wait-for-frontend.mjs';
import { findDocteurWindow, activateDocteurWindow } from './launcher-browser.mjs';

// Budgets. 120 s = the backend budget wait-for-cortex.mjs and the boot screen already use (one cold boot took 91 s before
// listening). 60 s = STARTUP-1 frontend budget (Vite listens < 1 s, first page ≈ 3 s). 45 s = how long an already
// listening backend may stay silent before it counts as hung (a synchronous Kiwix parse was seen blocking ≈ 22 s).
export const BACKEND_READY_TIMEOUT_MS = 120_000;
export const FRONTEND_READY_TIMEOUT_MS = 60_000;
export const BACKEND_BUSY_GRACE_MS = 45_000;
export const FRONTEND_BUSY_GRACE_MS = 15_000;
export const PROCESS_APPEAR_MS = 20_000;
export const PORT_RELEASE_TIMEOUT_MS = 20_000;
export const CONFIRM_TIMEOUT_MS = 60_000;
// Per-request timeouts. Measured 2026-10-22: the real Vite dev server answered its first pages in 3–4 s under load, so the
// 2 s STARTUP-1 probe timeout aborted every request and never saw "ready" in 60 s. The overall budgets above stay the bound.
export const FRONTEND_REQUEST_TIMEOUT_MS = 10_000;
export const BACKEND_REQUEST_TIMEOUT_MS = 5_000;
const SNAPSHOT_EVERY_MS = 4_000;
const PROGRESS_EVERY_MS = 10_000;
const POLL_MS = 1_000;

const FAILURES = {
  NOT_WINDOWS: 'Le lanceur Docteur ne fonctionne que sous Windows.',
  LAUNCH_PATH_UNSUPPORTED: "Le dossier de Docteur contient des caractères que le lanceur ne sait pas transmettre sans risque (\" % & | < > ^ !).",
  PROCESS_PROBE_FAILED: "Docteur n'a pas pu lire la liste des programmes et des ports de ce PC ; sans elle, il ne peut pas savoir à qui appartiennent les ports 3001 et 5173.",
  LAUNCH_ALREADY_IN_PROGRESS: 'Un autre lancement de Docteur est déjà en cours.',
  LAUNCH_LOCK_ERROR: "Docteur n'a pas pu créer son verrou de lancement.",
  BACKEND_PORT_FOREIGN: 'Le port 3001 est utilisé par un autre programme.',
  BACKEND_PORT_UNKNOWN_OWNER: "Le port 3001 est occupé par un programme que Docteur ne peut pas identifier avec certitude.",
  BACKEND_PORT_INCONSISTENT: "L'occupation du port 3001 a changé pendant la vérification.",
  BACKEND_UNRESPONSIVE: 'Le moteur Docteur occupe le port 3001 mais ne répond plus.',
  BACKEND_REPLACE_REFUSED: "Le remplacement du moteur bloqué a été annulé : son identité n'a pas pu être revérifiée au moment de l'arrêt.",
  BACKEND_PORT_NOT_RELEASED: "Le port 3001 n'a pas été libéré après l'arrêt du moteur bloqué.",
  BACKEND_START_FAILED: "La fenêtre « Cortex Server » n'a pas pu être ouverte.",
  BACKEND_PROCESS_NOT_FOUND: "Le moteur Docteur n'a jamais démarré (aucun processus moteur trouvé).",
  BACKEND_CRASHED: "Le moteur Docteur s'est arrêté pendant son démarrage.",
  BACKEND_EXITED: "Le moteur Docteur s'est fermé pendant son démarrage.",
  BACKEND_PORT_TAKEN: 'Un autre programme a pris le port 3001 pendant le démarrage du moteur.',
  BACKEND_TIMEOUT: "Le moteur Docteur n'a pas répondu dans le délai prévu.",
  FRONTEND_PORT_FOREIGN: 'Le port 5173 est utilisé par un autre programme.',
  FRONTEND_PORT_UNKNOWN_OWNER: "Le port 5173 est occupé par un programme que Docteur ne peut pas identifier avec certitude.",
  FRONTEND_PORT_INCONSISTENT: "L'occupation du port 5173 a changé pendant la vérification.",
  FRONTEND_UNRESPONSIVE: "L'interface Docteur occupe le port 5173 mais ne répond plus.",
  FRONTEND_START_FAILED: "La fenêtre « Docteur Frontend » n'a pas pu être ouverte.",
  FRONTEND_PROCESS_NOT_FOUND: "L'interface Docteur n'a jamais démarré (aucun processus Vite trouvé).",
  FRONTEND_EXITED: "L'interface Docteur s'est fermée pendant son démarrage.",
  FRONTEND_PORT_TAKEN: 'Un autre programme a pris le port 5173 pendant le démarrage.',
  FRONTEND_NOT_READY: "L'interface Docteur n'a pas répondu dans le délai prévu.",
};

const ACTIONS = {
  LAUNCH_ALREADY_IN_PROGRESS: "Attendre la fin de l'autre fenêtre « DOCTEUR - LANCEUR » (elle ouvrira Docteur), ou la fermer puis relancer.",
  BACKEND_PORT_FOREIGN: 'Fermer ce programme (ou changer son port), puis relancer Docteur.',
  BACKEND_PORT_UNKNOWN_OWNER: "S'il s'agit d'un ancien moteur Docteur lancé à la main, fermer sa fenêtre ; sinon fermer le programme concerné, puis relancer.",
  BACKEND_UNRESPONSIVE: "Consulter la fenêtre « Cortex Server », la fermer, puis relancer Docteur.",
  BACKEND_CRASHED: "Lire l'erreur dans la fenêtre « Cortex Server » (elle reste ouverte), corriger, puis relancer.",
  BACKEND_EXITED: "Lire l'erreur dans la fenêtre « Cortex Server », puis relancer.",
  BACKEND_PROCESS_NOT_FOUND: "Lire la fenêtre « Cortex Server » (Node.js et npm doivent être installés), puis relancer.",
  BACKEND_TIMEOUT: "Lire la fenêtre « Cortex Server ». Le moteur peut encore finir de démarrer : relancer Docteur le réutilisera s'il répond.",
  FRONTEND_PORT_FOREIGN: 'Fermer ce programme (ou changer son port), puis relancer Docteur.',
  FRONTEND_PORT_UNKNOWN_OWNER: "S'il s'agit d'une ancienne interface Docteur lancée à la main, fermer sa fenêtre ; sinon fermer le programme concerné, puis relancer.",
  FRONTEND_UNRESPONSIVE: "Consulter la fenêtre « Docteur Frontend », la fermer, puis relancer Docteur.",
  FRONTEND_EXITED: "Lire l'erreur de Vite dans la fenêtre « Docteur Frontend », puis relancer.",
  FRONTEND_PROCESS_NOT_FOUND: "Lire la fenêtre « Docteur Frontend », puis relancer.",
  FRONTEND_NOT_READY: "Lire l'erreur de Vite dans la fenêtre « Docteur Frontend », puis relancer.",
};

class LaunchFailure extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

const describeOwner = c => (c.name ? `${c.name}${c.pid != null ? `, PID ${c.pid}` : ''}` : c.pid != null ? `PID ${c.pid}` : 'propriétaire inconnu');
const seconds = ms => Math.round(ms / 1000);

/**
 * deps: snapshot, pingBackend, probeFrontend, startService(kind), terminate(targets, expected), confirm(question),
 *       acquireLock(owner, isOwnerAlive), releaseLock(held), say(line), now, sleep, selfPid, platform, repoRoot
 * Returns { code: 0 } or { code: 1, error, detail } — never throws for an operational failure.
 */
export async function runLaunch(deps) {
  const d = { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)), repoRoot: REPO_ROOT, platform: process.platform, mode: 'daily', ...deps };
  const trace = [];
  const enter = state => { trace.push(state); d.onState?.(state); };
  let held = null;
  try {
    enter('PREFLIGHT');
    if (d.platform !== 'win32') throw new LaunchFailure('NOT_WINDOWS');
    if (!isCmdSafePath(d.repoRoot)) throw new LaunchFailure('LAUNCH_PATH_UNSUPPORTED');
    d.say('[1/4] Vérification de l\'environnement : Docteur contrôle les ports 3001 et 5173 et les programmes qui les utilisent.');
    const first = await snapshotOrFail(d);
    const me = first.processes.find(p => p.pid === d.selfPid);
    const isOwnerAlive = owner => first.processes.some(p => p.pid === owner.pid && p.created === owner.created);
    held = d.acquireLock(me ? { pid: me.pid, created: me.created } : null, isOwnerAlive);
    if (!held.acquired) throw new LaunchFailure(held.reason === 'ACTIVE' ? 'LAUNCH_ALREADY_IN_PROGRESS' : 'LAUNCH_LOCK_ERROR', held.owner?.pid ? `lancement en cours : PID ${held.owner.pid}` : held.detail ?? null);

    enter('PORT_CHECK');
    let snap = await snapshotOrFail(d);
    // 5173 first (never destructive): a foreign 5173 must stop the launch before the backend is started or replaced
    await planFrontend(d, snap);
    const backendPlan = await planBackend(d, snap, enter);
    if (backendPlan.replaced) snap = await snapshotOrFail(d);
    const leftovers = findDocteurProcesses(snap, d.repoRoot).idleConsoles;
    for (const c of leftovers) d.say(`   Info : ancienne fenêtre « ${c.kind === 'backend' ? 'Cortex Server' : 'Docteur Frontend'} » sans service actif (PID ${c.pid}). Elle n'est pas fermée automatiquement : la lire puis la fermer si elle n'est plus utile.`);

    enter('OLLAMA');
    await ensureOllama(d, snap);

    enter('BACKEND_STARTING');
    if (backendPlan.action === 'reuse') {
      d.say(`[3/4] Moteur Docteur déjà actif et vérifié (PID ${backendPlan.pid}, ${MODE_LABEL[backendPlan.runMode]}) : réutilisé, aucun nouveau moteur lancé.`);
      if (backendPlan.runMode !== d.mode) d.say(`   Info : vous avez demandé le ${MODE_LABEL[d.mode]}. Pour changer de mode, fermer la fenêtre « Cortex Server » puis relancer (rien n'est arrêté automatiquement).`);
    }
    else if (backendPlan.action === 'await-existing') d.say('[3/4] Un moteur Docteur est déjà en train de démarrer (lancement précédent) : Docteur l\'attend au lieu d\'en lancer un second.');
    else {
      d.say(`[3/4] Démarrage du moteur Docteur (fenêtre « Cortex Server », ${MODE_LABEL[d.mode]})…`);
      const started = await d.startService('backend');
      if (!started.ok) throw new LaunchFailure('BACKEND_START_FAILED', started.reason ?? null);
    }
    if (backendPlan.action !== 'reuse') await waitBackendReady(d, { started: backendPlan.action === 'start', ignoreWatchers: backendPlan.staleWatchers ?? [] });
    enter('BACKEND_READY');

    enter('FRONTEND_STARTING');
    const frontendPlan = await planFrontend(d, await snapshotOrFail(d)); // re-checked: 5173 may have changed during the backend wait
    if (frontendPlan.action === 'reuse') d.say(`[4/4] Interface Docteur déjà active et vérifiée (PID ${frontendPlan.pid}) : réutilisée.`);
    else if (frontendPlan.action === 'await-existing') d.say('[4/4] Une interface Docteur est déjà en train de démarrer : Docteur l\'attend.');
    else {
      d.say('[4/4] Préparation de l\'interface (fenêtre « Docteur Frontend »)…');
      const started = await d.startService('frontend');
      if (!started.ok) throw new LaunchFailure('FRONTEND_START_FAILED', started.reason ?? null);
    }
    if (frontendPlan.action !== 'reuse') await waitFrontendReady(d, { started: frontendPlan.action === 'start' });
    enter('FRONTEND_READY');

    enter('BROWSER_OPENING');
    // [STARTUP-3] an already open Docteur window is brought back instead of stacking a new one (never closes anything)
    const existing = d.findDocteurWindow ? await d.findDocteurWindow() : { ok: false };
    if (existing.ok && existing.window) {
      const shown = await d.activateWindow(existing.window);
      if (shown === 'activated' || shown === 'flashed') {
        d.say(shown === 'activated'
          ? 'Docteur est prêt. Une fenêtre Docteur était déjà ouverte : elle a été remise au premier plan (aucune nouvelle fenêtre).'
          : "Docteur est prêt. Une fenêtre Docteur est déjà ouverte : elle clignote dans la barre des tâches (Windows n'a pas autorisé sa mise au premier plan).");
        d.say('   Pour ouvrir une fenêtre supplémentaire malgré tout : http://localhost:5173');
        return { code: 0, browser: 'existing', trace };
      }
    }
    d.say('Docteur est prêt. Ouverture du navigateur…');
    return { code: 0, browser: 'open', trace };
  } catch (error) {
    if (!(error instanceof LaunchFailure)) throw error;
    enter('FAILED');
    return { code: 1, error: error.code, detail: error.detail, trace };
  } finally {
    if (held?.acquired) d.releaseLock(held);
  }
}

const MODE_LABEL = { daily: 'mode quotidien stable', dev: 'mode développement : rechargement automatique' };

/** 'dev' when the confirmed server runs under its verified `node --watch` parent, else 'daily'. */
function runningMode(snap, c, repoRoot) {
  return (backendTerminationTargets(snap, c, repoRoot) ?? []).some(t => t.role === 'watcher') ? 'dev' : 'daily';
}

async function snapshotOrFail(d) {
  const snap = await d.snapshot();
  if (!snap.ok) throw new LaunchFailure(snap.reason === 'NOT_WINDOWS' ? 'NOT_WINDOWS' : 'PROCESS_PROBE_FAILED', snap.reason);
  return snap;
}

/** Decides what to do with 3001. Returns { action: 'start' | 'reuse' | 'await-existing', pid?, replaced? } or throws. */
async function planBackend(d, snap, enter, retried = false) {
  const c = classifyPort(snap, BACKEND_PORT, 'backend', d.repoRoot);
  if (c.state === STATES.FREE) {
    const procs = findDocteurProcesses(snap, d.repoRoot);
    if (procs.backendServers.length > 0) return { action: 'await-existing' };
    for (const w of procs.idleWatchers) d.say(`   Info : un ancien moteur Docteur arrêté reste en attente dans sa fenêtre (PID ${w.pid}) ; il n'est pas fermé automatiquement.`);
    return { action: 'start', staleWatchers: procs.idleWatchers.map(w => w.pid) };
  }
  if (c.state === STATES.INCONSISTENT && !retried) { await d.sleep(POLL_MS); return planBackend(d, await snapshotOrFail(d), enter, true); }
  if (c.state === STATES.INCONSISTENT) throw new LaunchFailure('BACKEND_PORT_INCONSISTENT', `${c.reason} — Docteur n'a fermé aucun processus`);
  if (c.state === STATES.FOREIGN) throw new LaunchFailure('BACKEND_PORT_FOREIGN', `${describeOwner(c)} — Docteur n'a fermé aucun processus`);
  if (c.state !== STATES.BACKEND) throw new LaunchFailure('BACKEND_PORT_UNKNOWN_OWNER', `${describeOwner(c)}, ${c.reason} — Docteur n'a fermé aucun processus`);

  // confirmed Docteur backend: reuse it if it answers, possibly after a busy period
  const started = d.now();
  let lastCheck = started, announced = false;
  for (;;) {
    if ((await d.pingBackend()).state === 'ready') return { action: 'reuse', pid: c.pid, runMode: runningMode(snap, c, d.repoRoot) };
    if (d.now() - started >= BACKEND_BUSY_GRACE_MS) break;
    if (!announced) { announced = true; d.say(`   Le moteur Docteur (PID ${c.pid}) occupe déjà le port 3001 mais ne répond pas encore : attente jusqu'à ${seconds(BACKEND_BUSY_GRACE_MS)} s.`); }
    await d.sleep(POLL_MS * 1.5);
    if (d.now() - lastCheck >= SNAPSHOT_EVERY_MS) {
      lastCheck = d.now();
      const again = await snapshotOrFail(d);
      const now = classifyPort(again, BACKEND_PORT, 'backend', d.repoRoot);
      if (now.state !== STATES.BACKEND || now.pid !== c.pid || now.created !== c.created) {
        if (retried) throw new LaunchFailure('BACKEND_PORT_INCONSISTENT', "LISTENER_CHANGED — Docteur n'a fermé aucun processus");
        return planBackend(d, again, enter, true);
      }
    }
  }

  // hung: replacement only with the user's explicit agreement, and only through the pinned re-verification
  const targets = backendTerminationTargets(snap, c, d.repoRoot);
  if (!targets) throw new LaunchFailure('BACKEND_UNRESPONSIVE', `PID ${c.pid}`);
  const list = targets.map(t => `PID ${t.pid} (${t.role === 'watcher' ? 'surveillance node --watch' : 'moteur'})`).join(', ');
  const yes = await d.confirm(`Le moteur Docteur (PID ${c.pid}) ne répond plus depuis ${seconds(BACKEND_BUSY_GRACE_MS)} s. L'arrêter et en démarrer un nouveau ?\n   Seuls ses processus Docteur vérifiés seront arrêtés : ${list}. Aucun autre programme. [O/N] `);
  if (!yes) throw new LaunchFailure('BACKEND_UNRESPONSIVE', `PID ${c.pid} — rien n'a été arrêté`);
  enter('STOPPING');
  const result = await d.terminate(targets, { port: BACKEND_PORT, pid: c.pid, created: c.created });
  if (!result.ok) throw new LaunchFailure('BACKEND_REPLACE_REFUSED', `${result.reason} — rien n'a été arrêté`);
  d.say(`   Moteur bloqué arrêté (${result.killed.map(p => `PID ${p}`).join(', ')}). Vérification de la libération du port 3001…`);
  const releaseStart = d.now();
  for (;;) {
    const after = await snapshotOrFail(d);
    if (classifyPort(after, BACKEND_PORT, 'backend', d.repoRoot).state === STATES.FREE) return { action: 'start', replaced: true };
    if (d.now() - releaseStart >= PORT_RELEASE_TIMEOUT_MS) throw new LaunchFailure('BACKEND_PORT_NOT_RELEASED', `après ${seconds(PORT_RELEASE_TIMEOUT_MS)} s`);
    await d.sleep(POLL_MS);
  }
}

/** Decides what to do with 5173 — never terminates anything. */
async function planFrontend(d, snap, retried = false) {
  const c = classifyPort(snap, FRONTEND_PORT, 'frontend', d.repoRoot);
  if (c.state === STATES.FREE) return { action: findDocteurProcesses(snap, d.repoRoot).frontends.length > 0 ? 'await-existing' : 'start' };
  if (c.state === STATES.INCONSISTENT && !retried) { await d.sleep(POLL_MS); return planFrontend(d, await snapshotOrFail(d), true); }
  if (c.state === STATES.INCONSISTENT) throw new LaunchFailure('FRONTEND_PORT_INCONSISTENT', `${c.reason} — Docteur n'a fermé aucun processus`);
  if (c.state === STATES.FOREIGN) throw new LaunchFailure('FRONTEND_PORT_FOREIGN', `${describeOwner(c)} — Docteur n'a fermé aucun processus`);
  if (c.state !== STATES.FRONTEND) throw new LaunchFailure('FRONTEND_PORT_UNKNOWN_OWNER', `${describeOwner(c)}, ${c.reason} — Docteur n'a fermé aucun processus`);
  const started = d.now();
  for (;;) {
    if ((await d.probeFrontend()).state === 'ready') return { action: 'reuse', pid: c.pid };
    if (d.now() - started >= FRONTEND_BUSY_GRACE_MS) throw new LaunchFailure('FRONTEND_UNRESPONSIVE', `PID ${c.pid} — rien n'a été arrêté`);
    await d.sleep(POLL_MS);
  }
}

function ensureOllamaMessage(kind) {
  return {
    listening: '[2/4] Ollama répond déjà sur ce PC : utilisé tel quel (Docteur ne le gère pas et ne le ferme pas).',
    starting: '[2/4] Ollama est déjà en cours de démarrage (lancé hors de Docteur) : utilisé tel quel.',
    started: '[2/4] Ollama démarré en mode local (fenêtre « Ollama », écoute 127.0.0.1 uniquement, modèles cloud Ollama désactivés pour cette instance).',
    missing: "[2/4] Ollama introuvable sur ce PC : Docteur démarre quand même ; les fonctions d'IA locale resteront indisponibles.",
    failed: "[2/4] Ollama n'a pas pu être lancé : Docteur démarre quand même ; les fonctions d'IA locale resteront indisponibles.",
  }[kind];
}

/** Optional dependency: reported, never waited for, never stopped. */
async function ensureOllama(d, snap) {
  if (snap.listeners.some(l => l.port === OLLAMA_PORT)) return d.say(ensureOllamaMessage('listening'));
  if (snap.processes.some(p => p.name && /^ollama( app)?\.exe$/i.test(p.name))) return d.say(ensureOllamaMessage('starting'));
  const result = await d.startService('ollama');
  d.say(ensureOllamaMessage(result.ok ? 'started' : result.reason === 'OLLAMA_NOT_FOUND' ? 'missing' : 'failed'));
}

/** Tracks the service's own processes while polling, so a crash is reported at once instead of after the whole budget. */
function processWatch(kind, { seenAtStart = false, ignoreWatchers = [] } = {}) {
  let seen = seenAtStart, crashedRuns = 0, goneRuns = 0;
  return procs => {
    const live = kind === 'backend' ? procs.backendServers.length : procs.frontends.length;
    // a watcher already idle before this launch (old crashed console) says nothing about the backend being started now
    const idleWatcher = kind === 'backend' && procs.backendWatchers.some(w => !ignoreWatchers.includes(w.pid));
    if (live > 0) { seen = true; crashedRuns = 0; goneRuns = 0; return null; }
    if (idleWatcher) { seen = true; return ++crashedRuns >= 2 ? 'CRASHED' : null; } // node --watch keeps waiting after its server died
    if (seen) return ++goneRuns >= 2 ? 'EXITED' : null;
    return 'NOT_SEEN';
  };
}

async function waitBackendReady(d, { started, ignoreWatchers = [] }) {
  const t0 = d.now();
  const watch = processWatch('backend', { seenAtStart: !started, ignoreWatchers }); // awaiting an existing boot: its process was already seen
  let lastSnap = -Infinity, lastProgress = t0;
  for (;;) {
    const elapsed = d.now() - t0;
    if ((await d.pingBackend()).state === 'ready') {
      const c = classifyPort(await snapshotOrFail(d), BACKEND_PORT, 'backend', d.repoRoot);
      if (c.state === STATES.BACKEND) { d.say(`   Moteur Docteur prêt et vérifié (PID ${c.pid}) après ${seconds(d.now() - t0)} s.`); return; }
      if (c.state !== STATES.FREE) throw new LaunchFailure('BACKEND_PORT_TAKEN', `${describeOwner(c)}, ${c.reason}`);
    }
    if (d.now() - lastSnap >= SNAPSHOT_EVERY_MS) {
      lastSnap = d.now();
      const snap = await snapshotOrFail(d);
      const c = classifyPort(snap, BACKEND_PORT, 'backend', d.repoRoot);
      if (c.state === STATES.FOREIGN || c.state === STATES.UNKNOWN) throw new LaunchFailure('BACKEND_PORT_TAKEN', `${describeOwner(c)}, ${c.reason}`);
      const verdict = watch(findDocteurProcesses(snap, d.repoRoot));
      if (verdict === 'CRASHED') throw new LaunchFailure('BACKEND_CRASHED', `après ${seconds(elapsed)} s`);
      if (verdict === 'EXITED') throw new LaunchFailure('BACKEND_EXITED', `après ${seconds(elapsed)} s`);
      if (verdict === 'NOT_SEEN' && elapsed >= PROCESS_APPEAR_MS) throw new LaunchFailure('BACKEND_PROCESS_NOT_FOUND', `après ${seconds(elapsed)} s`);
    }
    if (elapsed >= BACKEND_READY_TIMEOUT_MS) throw new LaunchFailure('BACKEND_TIMEOUT', `${seconds(BACKEND_READY_TIMEOUT_MS)} s — Chrome n'a pas été ouvert`);
    if (d.now() - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = d.now();
      d.say(`   Le moteur s'initialise… ${seconds(elapsed)} s écoulées (maximum ${seconds(BACKEND_READY_TIMEOUT_MS)} s). Le premier lancement peut prendre plus d'une minute.`);
    }
    await d.sleep(POLL_MS);
  }
}

async function waitFrontendReady(d, { started }) {
  const t0 = d.now();
  const watch = processWatch('frontend', { seenAtStart: !started });
  let lastSnap = -Infinity, lastProgress = t0, foreignSince = null;
  for (;;) {
    const elapsed = d.now() - t0;
    const probe = await d.probeFrontend();
    if (probe.state === 'ready') {
      const c = classifyPort(await snapshotOrFail(d), FRONTEND_PORT, 'frontend', d.repoRoot);
      if (c.state === STATES.FRONTEND) { d.say(`   Interface prête et vérifiée (PID ${c.pid}) après ${seconds(d.now() - t0)} s.`); return; }
      if (c.state !== STATES.FREE) throw new LaunchFailure('FRONTEND_PORT_TAKEN', `${describeOwner(c)}, ${c.reason}`);
    }
    foreignSince = probe.state === 'foreign' ? (foreignSince ?? elapsed) : null;
    if (d.now() - lastSnap >= SNAPSHOT_EVERY_MS || (foreignSince !== null && elapsed - foreignSince >= 3_000)) {
      lastSnap = d.now();
      const snap = await snapshotOrFail(d);
      const c = classifyPort(snap, FRONTEND_PORT, 'frontend', d.repoRoot);
      if (c.state === STATES.FOREIGN || c.state === STATES.UNKNOWN) throw new LaunchFailure('FRONTEND_PORT_TAKEN', `${describeOwner(c)}, ${c.reason}`);
      const verdict = watch(findDocteurProcesses(snap, d.repoRoot));
      if (verdict === 'EXITED') throw new LaunchFailure('FRONTEND_EXITED', `après ${seconds(elapsed)} s`);
      if (verdict === 'NOT_SEEN' && elapsed >= PROCESS_APPEAR_MS) throw new LaunchFailure('FRONTEND_PROCESS_NOT_FOUND', `après ${seconds(elapsed)} s`);
    }
    if (elapsed >= FRONTEND_READY_TIMEOUT_MS) throw new LaunchFailure('FRONTEND_NOT_READY', `${seconds(FRONTEND_READY_TIMEOUT_MS)} s — Chrome n'a pas été ouvert`);
    if (d.now() - lastProgress >= PROGRESS_EVERY_MS) { lastProgress = d.now(); d.say(`   Préparation de l'interface… ${seconds(elapsed)} s écoulées (maximum ${seconds(FRONTEND_READY_TIMEOUT_MS)} s).`); }
    await d.sleep(POLL_MS);
  }
}

/** Plain-French failure block (the launcher pauses on it; it is never cleared). */
export function describeFailure(result, logFile = null) {
  const lines = ['', '  ============================================', `  ERREUR ${result.error}`, `  ${FAILURES[result.error] ?? 'Échec du démarrage.'}`];
  if (result.detail) lines.push(`  Détail : ${result.detail}`);
  if (ACTIONS[result.error]) lines.push(`  Que faire : ${ACTIONS[result.error]}`);
  lines.push("  Chrome n'a pas été ouvert. Aucun programme étranger n'a été fermé.");
  if (logFile) lines.push(`  Journal : ${logFile}`);
  lines.push('  ============================================', '');
  return lines.join('\n');
}

// ── real dependencies (Windows) ─────────────────────────────────────────────────────────────────────────────────────
export function pingBackend({ port = BACKEND_PORT, timeoutMs = BACKEND_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', family: 4, port, path: '/api/ping', timeout: timeoutMs, headers: { accept: 'application/json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        let ok = false;
        try { ok = JSON.parse(body)?.ok === true; } catch { /* not the Docteur ping */ }
        resolve(res.statusCode === 200 && ok ? { state: 'ready' } : { state: 'down', detail: `HTTP ${res.statusCode}` });
      });
      res.on('error', () => resolve({ state: 'down', detail: 'RESPONSE_ERROR' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ state: 'down', detail: 'TIMEOUT' }); });
    req.on('error', error => resolve({ state: 'down', detail: error.code ?? 'ERROR' }));
  });
}

/** Absolute ollama.exe from PATH or the per-user installer location, or null. */
export function findOllamaExe(env = process.env, exists = fs.existsSync) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Programs', 'Ollama'));
  for (const dir of dirs) {
    const candidate = path.join(dir.replace(/"/g, ''), 'ollama.exe');
    if (path.isAbsolute(candidate) && exists(candidate)) return candidate;
  }
  return null;
}

// A path is substituted into a cmd.exe command line only when it cannot change how cmd parses it.
export const isCmdSafePath = p => /^[A-Za-z]:\\[^"%&|<>^!]*$/.test(String(p ?? ''));

/** Console definitions — constant commands; only a validated repository / ollama.exe path is substituted. Null = refused. */
export function serviceConsole(kind, { repoRoot = REPO_ROOT, env = process.env, ollamaExe = null, mode = 'daily' } = {}) {
  if (!isCmdSafePath(repoRoot) || (ollamaExe !== null && !isCmdSafePath(ollamaExe))) return null;
  const quiet = { npm_config_update_notifier: 'false' }; // npm's daily registry update check is not needed to start Docteur
  // [STARTUP-3] daily use runs `npm start` (node src/server.js): with NTFS last-access updates on, `node --watch` also
  // restarts on mere READS of src/ files (measured 2026-10-22). Development keeps `npm run dev` explicitly.
  if (kind === 'backend') return { title: 'Cortex Server', command: `cd /d "${path.join(repoRoot, 'cortex-server')}" && npm ${mode === 'dev' ? 'run dev' : 'start'}`, env: { ...env, ...quiet } };
  if (kind === 'frontend') return { title: 'Docteur Frontend', command: `cd /d "${repoRoot}" && npm run dev`, env: { ...env, ...quiet } };
  if (kind === 'ollama' && ollamaExe) {
    // Instance started BY Docteur only: loopback listener and no ollama.com cloud-model lookups (OLLAMA_NO_CLOUD, official
    // Ollama setting). An Ollama the user already runs is used as-is and never reconfigured.
    return { title: 'Ollama', command: `"${ollamaExe}" serve`, env: { ...env, OLLAMA_NO_CLOUD: '1', OLLAMA_HOST: '127.0.0.1:11434' } };
  }
  return null;
}

export function startConsole(spec) {
  return new Promise(resolve => {
    if (!spec || !/^[A-Za-z ]+$/.test(spec.title)) { resolve({ ok: false, reason: 'UNSAFE_COMMAND' }); return; }
    const comspec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    // cmd /s /c strips only the outer quotes; the console then runs `cmd.exe /s /k "<command>"` in its own window
    const child = spawn(comspec, ['/d', '/s', '/c', `"start "${spec.title}" "${comspec}" /s /k "${spec.command}""`],
      { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore', env: spec.env });
    child.on('error', () => resolve({ ok: false, reason: 'SPAWN_FAILED' }));
    child.on('exit', code => resolve(code === 0 ? { ok: true } : { ok: false, reason: `START_EXIT_${code}` }));
  });
}

function askYesNo(question, { input = process.stdin, output = process.stdout, timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
  if (!input.isTTY) return Promise.resolve(false); // no human to ask: never terminate
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output });
    const timer = setTimeout(() => { output.write('\n   Pas de réponse : rien n\'est arrêté.\n'); rl.close(); resolve(false); }, timeoutMs);
    rl.question(question, answer => { clearTimeout(timer); rl.close(); resolve(/^\s*o(ui)?\s*$/i.test(answer)); });
  });
}

function makeLog(dir) {
  const file = path.join(dir, 'launcher.log');
  return {
    file,
    write(line) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* first write */ }
        fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
      } catch { /* the log is a convenience; the console message is the diagnostic */ }
    },
  };
}

async function main(args) {
  const mode = args.includes('--dev') ? 'dev' : 'daily';
  const lockDir = defaultLockDir();
  const log = makeLog(lockDir);
  const frontendTarget = loopbackTarget(FRONTEND_URL);
  const result = await runLaunch({
    mode,
    selfPid: process.pid,
    snapshot: () => takeSnapshot(),
    pingBackend: () => pingBackend(),
    probeFrontend: () => probeFrontend(frontendTarget, { requestTimeoutMs: FRONTEND_REQUEST_TIMEOUT_MS }),
    startService: async kind => {
      if (kind === 'ollama') {
        const exe = findOllamaExe();
        if (!exe) return { ok: false, reason: 'OLLAMA_NOT_FOUND' };
        return startConsole(serviceConsole('ollama', { ollamaExe: exe }));
      }
      return startConsole(serviceConsole(kind, { mode }));
    },
    terminate: (targets, expected) => terminatePinned(targets, expected),
    findDocteurWindow: () => findDocteurWindow(),
    activateWindow: win => activateDocteurWindow(win),
    confirm: question => askYesNo(question),
    acquireLock: (owner, isOwnerAlive) => acquireLock({ owner, isOwnerAlive, dir: lockDir }),
    releaseLock: held => releaseLock(held),
    say: line => console.log(line),
    onState: state => log.write(`state ${state}`),
  });
  if (result.code === 0) { log.write(`result READY mode=${mode} browser=${result.browser}`); return result.browser === 'existing' ? 10 : 0; }
  log.write(`result ${result.error}${result.detail ? ` ${result.detail}` : ''}`);
  console.error(describeFailure(result, log.file));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
