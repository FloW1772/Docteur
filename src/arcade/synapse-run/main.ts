// [GAME-4] Synapse Run — game entry, bundled with three into public-path /arcade/synapse-run/game.js (classic
// script, see scripts/vite-arcade-game-bundle.mjs). Runs inside the Arcade sandbox before foundation.js, which owns
// the host protocol and forwards each validated host command here as a same-document "synapse-run:host" event.
// Nothing here talks to the host, the network or any storage: the run lives in memory only (no progression yet).
import { createSim, score, stepSim, type Command, type SimState } from './simulation.ts';
import { createFixedStepper } from './loop.ts';
import { actionForKey, createCommandQueue } from './input.ts';
import { createRunRenderer, type RunRenderer } from './renderer.ts';
import { createAutopilot } from './autopilot.ts';

/** Build-time flag: true only in test bundles (deterministic control hooks); false and stripped in production. */
declare const __SYNAPSE_TEST_HOOKS__: boolean;

type HostState = 'waiting' | 'active' | 'paused' | 'stopped';
interface HostCommandDetail { type: 'INIT' | 'PAUSE' | 'RESUME' | 'STOP'; reducedMotion?: boolean }

const PERF_SAMPLES = 1200;

function newSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

function boot(): void {
  const root = document.documentElement;
  const viewport = document.getElementById('sr-viewport');
  const overlay = document.getElementById('sr-overlay');
  const overlayTitle = document.getElementById('sr-overlay-title');
  const overlayText = document.getElementById('sr-overlay-text');
  const action = document.getElementById('sr-action') as HTMLButtonElement | null;
  const hudDistance = document.getElementById('sr-distance');
  const hudShards = document.getElementById('sr-shards');
  const hudScore = document.getElementById('sr-score');
  if (!viewport || !overlay || !overlayTitle || !overlayText || !action || !hudDistance || !hudShards || !hudScore) return;

  let sim: SimState = createSim(newSeed());
  let host: HostState = 'waiting';
  let reducedMotion = false;
  let manual = false;
  let frameHandle = 0;
  let listeners = 0;
  let steps = 0;
  let frames = 0;
  const frameTimes = new Float64Array(PERF_SAMPLES);
  let lastFrameAt: number | null = null;
  const queue = createCommandQueue();
  // test builds only: an autopilot can feed the queue before each tick (frame-rate measurements over minutes)
  let autopilot: ((state: SimState) => Command[]) | null = null;
  const tick = () => {
    if (__SYNAPSE_TEST_HOOKS__ && autopilot) for (const command of autopilot(sim)) queue.push(command);
    stepSim(sim, queue.take());
    steps += 1;
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

  const hud = { distance: -1, shards: -1, score: -1, status: '', host: '' };
  const updateHud = () => {
    const d = Math.floor(sim.distance), s = score(sim);
    if (d !== hud.distance) { hud.distance = d; hudDistance.textContent = `${d} m`; }
    if (sim.shardsCollected !== hud.shards) { hud.shards = sim.shardsCollected; hudShards.textContent = `${sim.shardsCollected} éclat${sim.shardsCollected > 1 ? 's' : ''}`; }
    if (s !== hud.score) { hud.score = s; hudScore.textContent = `Score ${s}`; }
    if (sim.status === hud.status && host === hud.host) return;
    const wasGameOver = hud.status === 'GAME_OVER';
    hud.status = sim.status; hud.host = host;
    root.setAttribute('data-game-state', sim.status);
    let title = '', text = '', button = '';
    if (!view) { title = 'Affichage 3D indisponible'; text = 'WebGL n’est pas disponible dans ce navigateur : Synapse Run ne peut pas s’afficher. Le reste de Docteur n’est pas affecté.'; }
    else if (host === 'waiting') { title = 'Synapse Run'; text = 'En attente de Docteur…'; }
    else if (host === 'stopped') { title = 'Partie arrêtée'; text = 'Relancez Synapse Run depuis l’Arcade.'; }
    else if (host === 'paused') { title = 'En pause'; text = 'Reprenez depuis les commandes de Docteur.'; }
    else if (sim.status === 'READY') { title = 'Prêt'; text = 'Changez de couloir, sautez les blocs, glissez sous les portiques et ramassez les éclats.'; button = 'Démarrer'; }
    else if (sim.status === 'GAME_OVER') { title = 'Fin de course'; text = `Distance ${Math.floor(sim.distance)} m · ${sim.shardsCollected} éclat${sim.shardsCollected > 1 ? 's' : ''} · score ${score(sim)}`; button = 'Rejouer'; }
    overlay.hidden = title === '';
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    action.hidden = button === '';
    action.textContent = button;
    // keep keyboard users on the only control, but never pull focus into an unfocused frame
    if (button && document.hasFocus() && (sim.status === 'GAME_OVER' ? !wasGameOver : true)) action.focus();
  };

  const render = (time: number) => {
    if (view) view.render(sim, time);
    updateHud();
  };

  const onFrame = (time: number) => {
    frameHandle = 0;
    if (host !== 'active') return;
    if (lastFrameAt !== null) frameTimes[frames % PERF_SAMPLES] = time - lastFrameAt;
    lastFrameAt = time;
    frames += 1;
    if (!manual) stepper.frame(time);
    render(time);
    frameHandle = requestAnimationFrame(onFrame);
  };
  const startLoop = () => {
    if (frameHandle || host !== 'active' || !view) return;
    stepper.reset();
    lastFrameAt = null;
    frameHandle = requestAnimationFrame(onFrame);
  };
  const stopLoop = () => {
    if (frameHandle) cancelAnimationFrame(frameHandle);
    frameHandle = 0;
    stepper.reset();
  };

  const restart = (seed: number) => {
    queue.clear();
    sim = createSim(seed);
  };

  const confirm = () => {
    if (host !== 'active' || !view) return;
    if (sim.status === 'READY') queue.push('START');
    else if (sim.status === 'GAME_OVER') { restart(newSeed()); queue.push('START'); }
  };

  const onKey = (event: KeyboardEvent) => {
    const mapped = actionForKey(event);
    if (!mapped) return;
    event.preventDefault(); // game keys only: arrows / space must not scroll the frame or click the button
    if (host !== 'active' || !view) return;
    if (mapped === 'CONFIRM') { confirm(); return; }
    if (sim.status === 'READY') { if (mapped === 'JUMP') queue.push('START'); return; }
    if (sim.status === 'RUNNING') queue.push(mapped);
  };
  const onAction = () => confirm();

  const onHost = (event: Event) => {
    const detail = (event as CustomEvent<HostCommandDetail>).detail;
    if (!detail || host === 'stopped') return;
    if (detail.type === 'INIT' && host === 'waiting') {
      reducedMotion = detail.reducedMotion === true;
      root.setAttribute('data-reduced-motion', reducedMotion ? 'true' : 'false');
      view?.setReducedMotion(reducedMotion);
      host = 'active';
      startLoop();
    } else if (detail.type === 'PAUSE' && host === 'active') {
      host = 'paused';
      stopLoop();
      queue.clear();
    } else if (detail.type === 'RESUME' && host === 'paused') {
      host = 'active';
      startLoop();
    } else if (detail.type === 'STOP') {
      host = 'stopped';
      teardown();
    } else {
      return;
    }
    render(performance.now());
  };

  const teardown = () => {
    stopLoop();
    queue.clear();
    sim.status = 'STOPPED';
    window.removeEventListener('keydown', onKey);
    action.removeEventListener('click', onAction);
    listeners -= 2;
    view?.dispose();
    view = null;
    root.setAttribute('data-webgl', 'disposed');
  };

  window.addEventListener('keydown', onKey);
  action.addEventListener('click', onAction);
  listeners += 2;
  // the host bridge listener stays for the page's lifetime: after STOP it only ignores further commands
  document.addEventListener('synapse-run:host', onHost);
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
        host, manual, loopActive: frameHandle !== 0, renderer: view ? 'active' : 'none', listeners, frames, steps, dropped: stepper.dropped,
        canvas: document.querySelectorAll('canvas').length, overlay: overlay.hidden ? '' : overlayTitle.textContent, view: view?.info() ?? null,
      }),
      /** manual clock: the loop keeps rendering but only advance() moves the simulation */
      setManual: (value: boolean) => { manual = value === true; stepper.reset(); },
      advance: (ticks: number) => { for (let i = 0; i < Math.min(Math.max(0, Math.floor(ticks)), 60 * 60); i++) tick(); render(performance.now()); },
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
