// [STARTUP-2] Synthetic Windows world for the launcher tests: processes (pid / parent / creation time / command line),
// listeners and HTTP behaviour, on a virtual clock. Command lines reproduce the real shapes observed on this machine for
// `cmd /k "cd /d <repo>\cortex-server && npm run dev"` → npm → cmd /d /s /c → node --watch → node src/server.js.
export const REPO = 'C:\\dev\\Docteur';
const NODE = '"C:\\Program Files\\nodejs\\node.exe"';
const NPM = '"C:\\Program Files\\nodejs\\\\node.exe"  "C:\\Program Files\\nodejs\\\\node_modules\\npm\\bin\\npm-cli.js" run dev';

export function createWorld({ repo = REPO } = {}) {
  const w = {
    t: 0, nextPid: 5000, clock: 134371000000000000n, repo,
    procs: new Map(), listeners: [], said: [], starts: [], terminations: [], confirms: [], snapshotFails: 0,
    backendHealthy: true, frontendHealthy: true, frontendForeignAnswer: false, scheduled: [],
    lockHeld: false, lockReleases: 0,
  };
  w.tick = () => { for (const job of w.scheduled.filter(j => j.at <= w.t)) { w.scheduled.splice(w.scheduled.indexOf(job), 1); job.run(); } };
  w.at = (delayMs, run) => w.scheduled.push({ at: w.t + delayMs, run });
  w.add = ({ name, cmdLine = null, ppid = 4, created = null }) => {
    const pid = w.nextPid++;
    w.clock += 10_000n;
    w.procs.set(pid, { pid, ppid, name, created: created ?? String(w.clock), cmdLine });
    return pid;
  };
  w.remove = pid => { w.procs.delete(pid); w.listeners = w.listeners.filter(l => l.pid !== pid); };
  w.listen = (port, pid, address = port === 5173 ? '::' : '127.0.0.1') => w.listeners.push({ port, pid, address });
  // mode 'dev' = `npm run dev` (node --watch parent); mode 'daily' = `npm start` (node src/server.js, no watcher)
  w.backendChain = ({ listen = true, mode = 'dev', watcher = mode === 'dev' } = {}) => {
    const script = mode === 'dev' ? 'run dev' : 'start';
    const launcher = w.add({ name: 'cmd.exe', cmdLine: `C:\\WINDOWS\\system32\\cmd.exe /c ""${repo}\\Docteur-Launcher.bat" "` });
    const consolePid = w.add({ name: 'cmd.exe', ppid: launcher, cmdLine: `"C:\\WINDOWS\\System32\\cmd.exe" /s /k "cd /d "${repo}\\cortex-server" && npm ${script}"` });
    const npm = w.add({ name: 'node.exe', ppid: consolePid, cmdLine: NPM.replace('run dev', script) });
    const shell = w.add({ name: 'cmd.exe', ppid: npm, cmdLine: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c node ${watcher ? '--watch-path=src --watch-preserve-output ' : ''}src/server.js` });
    const watcherPid = watcher ? w.add({ name: 'node.exe', ppid: shell, cmdLine: 'node  --watch-path=src --watch-preserve-output src/server.js' }) : null;
    const server = w.add({ name: 'node.exe', ppid: watcherPid ?? shell, cmdLine: watcher ? `${NODE} --watch-preserve-output src/server.js` : 'node  src/server.js' });
    if (listen) w.listen(3001, server);
    return { console: consolePid, npm, shell, watcher: watcherPid, server };
  };
  w.frontendChain = ({ listen = true } = {}) => {
    const consolePid = w.add({ name: 'cmd.exe', cmdLine: `"C:\\WINDOWS\\System32\\cmd.exe" /s /k "cd /d "${repo}" && npm run dev"` });
    const npm = w.add({ name: 'node.exe', ppid: consolePid, cmdLine: NPM });
    const shell = w.add({ name: 'cmd.exe', ppid: npm, cmdLine: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite' });
    const vite = w.add({ name: 'node.exe', ppid: shell, cmdLine: `"node"  "${repo}\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" ` });
    if (listen) w.listen(5173, vite);
    return { console: consolePid, vite };
  };
  w.snapshot = () => ({ ok: true, listeners: w.listeners.map(l => ({ ...l })), processes: [...w.procs.values()].map(p => ({ ...p })) });
  return w;
}

/** Orchestrator dependencies bound to a world. Behaviour hooks: onStart[kind](w), confirmAnswer, terminateResult(targets). */
export function worldDeps(w, { onStart = {}, confirmAnswer = false, terminateResult = null, lockActive = false, platform = 'win32', selfPid, mode, browserWindow = null, activation = 'activated' } = {}) {
  const me = selfPid ?? w.add({ name: 'node.exe', cmdLine: `${NODE} scripts/docteur-launch.mjs` });
  w.windowLookups = 0; w.activations = [];
  return {
    platform, repoRoot: w.repo, selfPid: me, ...(mode ? { mode } : {}),
    // browser: browserWindow null = no Docteur window open, 'fail' = detection failed; activation result returned as given
    findDocteurWindow: async () => { w.windowLookups++; return browserWindow === 'fail' ? { ok: false } : { ok: true, window: browserWindow }; },
    activateWindow: async win => { w.activations.push(win); return activation; },
    now: () => w.t,
    sleep: async ms => { w.t += ms; w.tick(); },
    snapshot: async () => {
      w.tick();
      if (w.snapshotFails > 0) { w.snapshotFails--; return { ok: false, reason: 'SNAPSHOT_TIMEOUT' }; }
      return w.snapshot();
    },
    pingBackend: async () => {
      w.tick();
      const l = w.listeners.find(x => x.port === 3001);
      if (!l) return { state: 'down', detail: 'ECONNREFUSED' };
      return w.backendHealthy || w.foreignBackendAnswers ? { state: 'ready' } : { state: 'down', detail: 'TIMEOUT' };
    },
    probeFrontend: async () => {
      w.tick();
      const l = w.listeners.find(x => x.port === 5173);
      if (!l) return { state: 'down', detail: 'ECONNREFUSED' };
      if (w.frontendForeignAnswer) return { state: 'foreign', detail: 'HTTP 200' };
      return w.frontendHealthy ? { state: 'ready' } : { state: 'down', detail: 'TIMEOUT' };
    },
    startService: async kind => {
      w.starts.push(kind);
      const hook = onStart[kind];
      if (hook) return hook(w) ?? { ok: true };
      return { ok: true };
    },
    terminate: async (targets, expected) => {
      w.terminations.push({ targets, expected });
      const result = terminateResult ? terminateResult(w, targets, expected) : { ok: true, killed: targets.map(t => t.pid) };
      if (result.ok) for (const t of targets) w.remove(t.pid);
      return result;
    },
    confirm: async question => { w.confirms.push(question); return typeof confirmAnswer === 'function' ? confirmAnswer(w) : confirmAnswer; },
    acquireLock: owner => {
      if (lockActive || w.lockHeld) return { acquired: false, reason: 'ACTIVE', owner: { pid: 4242 } };
      if (!owner) return { acquired: false, reason: 'LOCK_ERROR', detail: 'OWNER_UNKNOWN' };
      w.lockHeld = true;
      return { acquired: true, lock: { owner } };
    },
    releaseLock: held => { if (held.acquired) { w.lockHeld = false; w.lockReleases++; } },
    say: line => w.said.push(line),
  };
}

/** Typical start hooks: the backend chain appears at once and listens after bootMs; same for the frontend. */
export const startBackend = (bootMs = 5_000, opts = {}, appearMs = 0) => w => {
  const create = () => {
    const chain = w.backendChain({ listen: false, ...opts });
    w.lastBackend = chain;
    w.at(Math.max(0, bootMs - appearMs), () => { if (w.procs.has(chain.server)) w.listen(3001, chain.server); });
  };
  if (appearMs > 0) w.at(appearMs, create); else create(); // appearMs: npm slow to spawn the node processes
};
export const startFrontend = (bootMs = 3_000) => w => {
  const chain = w.frontendChain({ listen: false });
  w.lastFrontend = chain;
  w.at(bootMs, () => { if (w.procs.has(chain.vite)) w.listen(5173, chain.vite); });
};
export const startOllama = w => { const pid = w.add({ name: 'ollama.exe' }); w.listen(11434, pid); };
