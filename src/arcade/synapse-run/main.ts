// [GAME-4] Synapse Run — game entry, bundled with three into public-path /arcade/synapse-run/game.js (classic
// script, see scripts/vite-arcade-game-bundle.mjs). Runs inside the Arcade sandbox before foundation.js, which owns
// the host protocol and forwards each validated host command here as a same-document "synapse-run:host" event.
// [GAME-5] Adds touch input (swipes + on-screen buttons, same commands as the keyboard), pause reasons (player /
// host / hidden page), local progression and missions. The profile is loaded and written ONLY through
// foundation.js ("synapse-run:save-result" / "synapse-run:save-write" events) → host → GAME-3 save store; this file
// never touches any storage or network API.
import { createSim, score, stepSim, type Command, type SimState } from './simulation.ts';
import { createFixedStepper } from './loop.ts';
import { actionForKey, commandForButton, createCommandQueue } from './input.ts';
import { createSwipeDetector } from './gestures.ts';
import { createPauseState } from './pause.ts';
import {
  MISSIONS, SYNAPSE_RUN_SAVE_VERSION, createSaveSession, missionProgress, type LoadResult, type MissionId, type Profile, type RunSummary,
} from './progression.ts';
import { createRunRenderer, type RunRenderer } from './renderer.ts';
import { createAutopilot } from './autopilot.ts';

/** Build-time flag: true only in test bundles (deterministic control hooks); false and stripped in production. */
declare const __SYNAPSE_TEST_HOOKS__: boolean;

type HostState = 'waiting' | 'active' | 'stopped';
interface HostCommandDetail { type: 'INIT' | 'PAUSE' | 'RESUME' | 'STOP'; reducedMotion?: boolean }
interface SaveResultDetail { op: 'LOAD' | 'WRITE'; status: string; code?: string; saveVersion?: unknown; data?: unknown }

const PERF_SAMPLES = 1200;
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

function newSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

function runSummary(sim: SimState): RunSummary {
  return { distanceM: Math.floor(sim.distance), shards: sim.shardsCollected, score: score(sim) };
}

function boot(): void {
  const root = document.documentElement;
  const byId = (id: string) => document.getElementById(id);
  const viewport = byId('sr-viewport');
  const overlay = byId('sr-overlay');
  const overlayTitle = byId('sr-overlay-title');
  const overlayText = byId('sr-overlay-text');
  const overlayDetail = byId('sr-overlay-detail');
  const missionList = byId('sr-missions');
  const profileLine = byId('sr-profile');
  const progressSave = byId('sr-progress-save');
  const action = byId('sr-action') as HTMLButtonElement | null;
  const secondary = byId('sr-secondary') as HTMLButtonElement | null;
  const controls = byId('sr-controls');
  const pauseButton = byId('sr-pause') as HTMLButtonElement | null;
  const hudDistance = byId('sr-distance');
  const hudShards = byId('sr-shards');
  const hudScore = byId('sr-score');
  if (!viewport || !overlay || !overlayTitle || !overlayText || !overlayDetail || !missionList || !profileLine || !progressSave || !action || !secondary || !controls || !pauseButton || !hudDistance || !hudShards || !hudScore) return;
  const controlButtons = Array.from(controls.querySelectorAll<HTMLButtonElement>('button[data-control]'));

  let sim: SimState = createSim(newSeed());
  let runId = 0;
  let host: HostState = 'waiting';
  const pause = createPauseState();
  let reducedMotion = false;
  let manual = false;
  let frameHandle = 0;
  let listeners = 0;
  let steps = 0;
  let frames = 0;
  const frameTimes = new Float64Array(PERF_SAMPLES);
  let lastFrameAt: number | null = null;
  const queue = createCommandQueue();
  const swipes = createSwipeDetector();
  const session = createSaveSession();
  let lastRun: { summary: RunSummary; newRecords: { distance: boolean; score: boolean }; completedMissions: MissionId[] } | null = null;
  let writes = 0;

  const sendWrite = (payload: Profile | null) => {
    if (!payload) return;
    writes += 1;
    document.dispatchEvent(new CustomEvent('synapse-run:save-write', { detail: { saveVersion: SYNAPSE_RUN_SAVE_VERSION, data: payload } }));
  };

  // a run is settled exactly once, when the simulation itself reaches GAME_OVER (never on abandon / restart)
  const settleIfOver = () => {
    if (sim.status !== 'GAME_OVER') return;
    const summary = runSummary(sim);
    const result = session.settle(runId, summary);
    if (!result.settled) return;
    lastRun = { summary, newRecords: result.newRecords, completedMissions: result.completedMissions };
    sendWrite(result.write);
  };

  // test builds only: an autopilot can feed the queue before each tick (frame-rate measurements over minutes)
  let autopilot: ((state: SimState) => Command[]) | null = null;
  const tick = () => {
    if (__SYNAPSE_TEST_HOOKS__ && autopilot) for (const command of autopilot(sim)) queue.push(command);
    stepSim(sim, queue.take());
    steps += 1;
    settleIfOver();
  };
  const stepper = createFixedStepper(tick);

  let view: RunRenderer | null = null;
  try {
    view = createRunRenderer(viewport, { reducedMotion });
    root.setAttribute('data-webgl', 'ready');
  } catch {
    // no retry loop and no network fallback: a fixed message, the rest of the page (and Docteur) keeps working
    root.setAttribute('data-webgl', 'unavailable');
  }

  const running = () => host === 'active' && !!view && sim.status === 'RUNNING';
  const canPlay = () => running() && !pause.paused;

  const saveText = (): string => {
    switch (session.saveStatus) {
      case 'LOADING': return 'Progression locale : chargement…';
      case 'UNAVAILABLE': return 'Progression non sauvegardée : le stockage local de Docteur est indisponible.';
      case 'PROTECTED': return 'Progression locale illisible ou d’une version plus récente : elle est conservée telle quelle et rien n’est enregistré. Pour repartir de zéro, effacez-la depuis la liste de l’Arcade.';
      default:
        if (session.writeStatus === 'WRITING') return 'Progression locale : enregistrement…';
        if (session.writeStatus === 'FAILED') return 'Échec de l’enregistrement local : la dernière course n’est pas sauvegardée.';
        if (session.writeStatus === 'SAVED') return 'Progression enregistrée sur cet appareil.';
        return 'Progression locale active (sur cet appareil uniquement).';
    }
  };

  const renderMissions = (run: RunSummary | null) => {
    const rows = run ? missionProgress(session.profile, run) : MISSIONS.map(mission => ({ mission, ...session.profile.missions[mission.id], inRun: 0 }));
    missionList.replaceChildren(...rows.map(row => {
      const li = document.createElement('li');
      li.dataset.mission = row.mission.id;
      li.dataset.completed = String(row.completed);
      // completion is written out (and marked ✓), never shown by colour alone
      li.textContent = `${row.completed ? '✓ ' : ''}${row.mission.label} — ${row.progress} / ${row.mission.target} ${row.mission.unit}${row.completed ? ' · terminée' : ''}`;
      return li;
    }));
  };

  const profileText = (p: Profile) => `Record ${p.bestDistanceM} m · meilleur score ${p.bestScore} · ${plural(p.totalRuns, 'course')} · ${plural(p.totalShards, 'éclat')} au total`;

  const hud = { distance: -1, shards: -1, score: -1, overlayKey: '' };
  const updateHud = () => {
    const d = Math.floor(sim.distance), s = score(sim);
    if (d !== hud.distance) { hud.distance = d; hudDistance.textContent = `${d} m`; }
    if (sim.shardsCollected !== hud.shards) { hud.shards = sim.shardsCollected; hudShards.textContent = plural(sim.shardsCollected, 'éclat'); }
    if (s !== hud.score) { hud.score = s; hudScore.textContent = `Score ${s}`; }
    const p = session.profile;
    const key = [view ? 1 : 0, host, sim.status, pause.reasons().join('+'), session.saveStatus, session.writeStatus, runId, p.totalRuns, p.bestScore, p.bestDistanceM].join('|');
    if (key === hud.overlayKey) return;
    const previousKey = hud.overlayKey;
    hud.overlayKey = key;
    root.setAttribute('data-game-state', sim.status);
    root.setAttribute('data-pause', pause.reasons().join(' '));
    root.setAttribute('data-progress', session.saveStatus);
    controls.hidden = !running();
    pauseButton.setAttribute('aria-pressed', String(pause.has('PLAYER')));
    for (const button of controlButtons) button.disabled = !canPlay();

    let title = '', text = '', detail = '', primary = '', second = '', missions: 'none' | 'stored' | 'live' = 'none';
    if (!view) { title = 'Affichage 3D indisponible'; text = 'WebGL n’est pas disponible dans ce navigateur : Synapse Run ne peut pas s’afficher. Le reste de Docteur n’est pas affecté.'; }
    else if (host === 'waiting') { title = 'Synapse Run'; text = 'En attente de Docteur…'; }
    else if (host === 'stopped') { title = 'Partie arrêtée'; text = 'Relancez Synapse Run depuis l’Arcade.'; }
    else if (pause.has('PLAYER')) {
      title = 'Pause';
      text = pause.has('HOST') ? 'Docteur a aussi mis le jeu en pause : il reprendra quand les deux pauses seront levées.' : 'La course est figée.';
      detail = 'Couloir : ← → ou A D, glisser à gauche / droite · Saut : ↑ W Espace, glisser vers le haut · Glissade : ↓ S, glisser vers le bas · Pause : Échap ou P.';
      primary = 'Reprendre'; second = 'Recommencer la partie'; missions = 'live';
    } else if (pause.has('HOST')) { title = 'En pause'; text = 'Reprenez depuis les commandes de Docteur.'; }
    else if (sim.status === 'READY') {
      title = 'Prêt';
      text = 'Changez de couloir, sautez les blocs, glissez sous les portiques et ramassez les éclats.';
      primary = 'Démarrer'; missions = 'stored';
    } else if (sim.status === 'GAME_OVER') {
      title = 'Fin de course';
      const r = lastRun?.summary ?? runSummary(sim);
      text = `Distance ${r.distanceM} m · ${plural(r.shards, 'éclat')} · score ${r.score}`;
      const notes: string[] = [];
      if (lastRun?.newRecords.distance) notes.push('Nouveau record de distance !');
      if (lastRun?.newRecords.score) notes.push('Nouveau meilleur score !');
      for (const id of lastRun?.completedMissions ?? []) notes.push(`Mission accomplie : ${MISSIONS.find(m => m.id === id)?.label ?? id}.`);
      detail = notes.join(' ');
      primary = 'Rejouer'; missions = 'stored';
    }
    overlay.hidden = title === '';
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    overlayDetail.textContent = detail;
    overlayDetail.hidden = detail === '';
    missionList.hidden = missions === 'none';
    profileLine.hidden = missions === 'none';
    progressSave.hidden = missions === 'none';
    if (missions !== 'none') {
      renderMissions(missions === 'live' ? runSummary(sim) : null);
      profileLine.textContent = profileText(session.profile);
      progressSave.textContent = saveText();
    }
    action.hidden = primary === '';
    action.textContent = primary;
    secondary.hidden = second === '';
    secondary.textContent = second;
    // keep keyboard users on the main control when a menu opens, but never pull focus into an unfocused frame
    const opened = previousKey.split('|').slice(0, 4).join('|') !== key.split('|').slice(0, 4).join('|');
    if (primary && opened && document.hasFocus()) action.focus();
  };

  const render = (time: number) => {
    if (view) view.render(sim, time);
    updateHud();
  };

  const onFrame = (time: number) => {
    frameHandle = 0;
    if (host !== 'active' || pause.paused) return;
    if (lastFrameAt !== null) frameTimes[frames % PERF_SAMPLES] = time - lastFrameAt;
    lastFrameAt = time;
    frames += 1;
    if (!manual) stepper.frame(time);
    render(time);
    frameHandle = requestAnimationFrame(onFrame);
  };
  const startLoop = () => {
    if (frameHandle || host !== 'active' || pause.paused || !view) return;
    stepper.reset();
    lastFrameAt = null;
    frameHandle = requestAnimationFrame(onFrame);
  };
  const stopLoop = () => {
    if (frameHandle) cancelAnimationFrame(frameHandle);
    frameHandle = 0;
    stepper.reset();
  };
  /** after any pause-reason change: the loop runs only when no reason is left (no dt is carried over) */
  const syncPause = () => {
    if (pause.paused) { stopLoop(); queue.clear(); } else startLoop();
    render(performance.now());
  };

  const restart = (seed: number) => {
    queue.clear();
    runId += 1;
    lastRun = null;
    sim = createSim(seed);
  };

  const confirm = () => {
    if (host !== 'active' || !view) return;
    if (pause.has('PLAYER')) { pause.remove('PLAYER'); syncPause(); return; }
    if (pause.paused) return;
    if (sim.status === 'READY') queue.push('START');
    else if (sim.status === 'GAME_OVER') { restart(newSeed()); queue.push('START'); }
  };
  const abandon = () => {
    // "Recommencer la partie" from the pause menu: the unfinished run is NOT settled
    if (host !== 'active' || !view || !pause.has('PLAYER')) return;
    restart(newSeed());
    queue.push('START');
    pause.remove('PLAYER');
    syncPause();
  };
  const togglePlayerPause = () => {
    if (host !== 'active' || !view) return;
    if (pause.has('PLAYER')) pause.remove('PLAYER');
    else if (sim.status === 'RUNNING') pause.add('PLAYER');
    else return;
    syncPause();
  };
  const issue = (command: Command) => { if (canPlay()) queue.push(command); };

  const onKey = (event: KeyboardEvent) => {
    const mapped = actionForKey(event);
    if (!mapped) return;
    // Enter / Space on a focused button are that button's own activation (keyboard-operable controls)
    const onButton = event.target instanceof HTMLButtonElement && (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space');
    if (onButton) return;
    event.preventDefault(); // game keys only: arrows / space must not scroll the frame
    if (host !== 'active' || !view) return;
    if (mapped === 'PAUSE') { togglePlayerPause(); return; }
    if (mapped === 'CONFIRM') { confirm(); return; }
    if (pause.paused) return;
    if (sim.status === 'READY') { if (mapped === 'JUMP') queue.push('START'); return; }
    issue(mapped);
  };
  const onAction = () => confirm();
  const onSecondary = () => abandon();

  // on-screen buttons: pointer → command at once without moving focus; keyboard activation → click with detail 0
  const onControlPointer = (event: PointerEvent) => {
    const button = (event.target as Element | null)?.closest?.('button');
    if (!button || !controls.contains(button)) return;
    event.preventDefault();
    if (!event.isPrimary) return;
    if (button === pauseButton) { togglePlayerPause(); return; }
    const command = commandForButton(button.getAttribute('data-control'));
    if (command) issue(command);
  };
  const onControlClick = (event: MouseEvent) => {
    if (event.detail !== 0) return; // pointer clicks were handled on pointerdown
    const button = (event.target as Element | null)?.closest?.('button');
    if (!button || !controls.contains(button)) return;
    if (button === pauseButton) { togglePlayerPause(); return; }
    const command = commandForButton(button.getAttribute('data-control'));
    if (command) issue(command);
  };

  // swipes on the play area (buttons live outside it, so a tap on a button is never a swipe)
  const sample = (event: PointerEvent) => ({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp });
  const onPointerDown = (event: PointerEvent) => { if (event.isPrimary && canPlay()) swipes.down(sample(event)); };
  const onPointerMove = (event: PointerEvent) => { const command = swipes.move(sample(event)); if (command) issue(command); };
  const onPointerUp = (event: PointerEvent) => { const command = swipes.up(sample(event)); if (command) issue(command); };
  const onPointerCancel = (event: PointerEvent) => swipes.cancel(event.pointerId);

  // a hidden page pauses the run and leaves the pause menu open: coming back never resumes by itself
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (!running()) return;
      pause.add('HIDDEN');
      pause.add('PLAYER');
    } else if (!pause.remove('HIDDEN')) {
      return;
    }
    syncPause();
  };

  const onSaveResult = (event: Event) => {
    const detail = (event as CustomEvent<SaveResultDetail>).detail;
    if (!detail || typeof detail !== 'object') return;
    if (detail.op === 'LOAD') {
      let result: LoadResult = { status: 'ERROR', code: typeof detail.code === 'string' ? detail.code : 'STORAGE_FAILED' };
      if (detail.status === 'EMPTY') result = { status: 'EMPTY' };
      else if (detail.status === 'FOUND') result = { status: 'FOUND', saveVersion: detail.saveVersion, data: detail.data };
      sendWrite(session.onLoad(result));
    } else if (detail.op === 'WRITE') {
      sendWrite(session.onWriteResult(detail.status === 'SAVED'));
    }
    render(performance.now());
  };

  const onHost = (event: Event) => {
    const detail = (event as CustomEvent<HostCommandDetail>).detail;
    if (!detail || host === 'stopped') return;
    if (detail.type === 'INIT' && host === 'waiting') {
      reducedMotion = detail.reducedMotion === true;
      root.setAttribute('data-reduced-motion', reducedMotion ? 'true' : 'false');
      view?.setReducedMotion(reducedMotion);
      host = 'active';
    } else if (detail.type === 'PAUSE' && host === 'active') {
      if (!pause.add('HOST')) return;
    } else if (detail.type === 'RESUME' && host === 'active') {
      if (!pause.remove('HOST')) return;
    } else if (detail.type === 'STOP') {
      host = 'stopped';
      teardown();
      render(performance.now());
      return;
    } else {
      return;
    }
    syncPause();
  };

  const bindings: [EventTarget, string, EventListener][] = [
    [window, 'keydown', onKey as EventListener],
    [action, 'click', onAction],
    [secondary, 'click', onSecondary],
    [controls, 'pointerdown', onControlPointer as EventListener],
    [controls, 'click', onControlClick as EventListener],
    [viewport, 'pointerdown', onPointerDown as EventListener],
    [viewport, 'pointermove', onPointerMove as EventListener],
    [viewport, 'pointerup', onPointerUp as EventListener],
    [viewport, 'pointercancel', onPointerCancel as EventListener],
    [document, 'visibilitychange', onVisibility],
  ];
  const teardown = () => {
    stopLoop();
    queue.clear();
    pause.clear();
    sim.status = 'STOPPED';
    for (const [target, type, listener] of bindings) target.removeEventListener(type, listener);
    listeners = 0;
    view?.dispose();
    view = null;
    root.setAttribute('data-webgl', 'disposed');
  };

  for (const [target, type, listener] of bindings) target.addEventListener(type, listener);
  listeners = bindings.length;
  // the host bridge and save-result listeners stay for the page's lifetime: after STOP they change nothing visible
  document.addEventListener('synapse-run:host', onHost);
  document.addEventListener('synapse-run:save-result', onSaveResult);
  render(performance.now());

  if (__SYNAPSE_TEST_HOOKS__) {
    const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
    (window as unknown as Record<string, unknown>).__synapseRunTest = Object.freeze({
      /** sanitized game-only state; never anything from Docteur */
      snapshot: () => ({
        seed: sim.seed, tick: sim.tick, status: sim.status, lane: sim.lane, laneTo: sim.laneTo, laneProgress: sim.laneProgress,
        y: sim.y, mode: sim.mode, distance: sim.distance, shardsCollected: sim.shardsCollected, score: score(sim), crash: sim.crash,
        obstacles: sim.obstacles.map(o => ({ id: o.id, type: o.type, lane: o.lane, z: o.z })),
        shards: sim.shards.map(s => ({ id: s.id, lane: s.lane, z: s.z, collected: s.collected })),
        host, pause: pause.reasons(), manual, loopActive: frameHandle !== 0, renderer: view ? 'active' : 'none', listeners, frames, steps, dropped: stepper.dropped,
        canvas: document.querySelectorAll('canvas').length, overlay: overlay.hidden ? '' : overlayTitle.textContent, view: view?.info() ?? null,
        runId, profile: JSON.parse(JSON.stringify(session.profile)), saveStatus: session.saveStatus, writeStatus: session.writeStatus, writes,
        controlsVisible: !controls.hidden,
      }),
      /** manual clock: the loop keeps rendering but only advance() moves the simulation */
      setManual: (value: boolean) => { manual = value === true; stepper.reset(); },
      advance: (ticks: number) => {
        if (pause.paused) return; // a paused game never advances, not even through the test clock
        const count = Math.min(Math.max(0, Math.floor(ticks)), 60 * 60);
        for (let i = 0; i < count; i++) tick();
        render(performance.now());
      },
      setAutopilot: (seed: number | null) => { autopilot = typeof seed === 'number' ? createAutopilot(seed) : null; },
      restart: (seed: number) => { restart(seed); render(performance.now()); },
      perf: () => {
        const n = Math.min(frames - 1, PERF_SAMPLES);
        const sorted = Array.from(frameTimes.subarray(0, Math.max(0, n))).sort((a, b) => a - b);
        const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return { frames, steps, dropped: stepper.dropped, samples: sorted.length, meanMs: mean, fps: mean ? 1000 / mean : 0, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), maxMs: sorted[sorted.length - 1] ?? 0, heapBytes: memory?.usedJSHeapSize ?? null, view: view?.info() ?? null, entities: { obstacles: sim.obstacles.length, shards: sim.shards.length } };
      },
    });
  }
}

boot();
