// [FILAMENT-1] Filament — game entry, bundled into the classic script /arcade/filament/game.js
// (scripts/vite-arcade-filament-bundle.mjs). It runs inside the Docteur Arcade sandbox (iframe allow-scripts, page
// CSP connect-src 'none'); public/arcade/filament/host.js speaks the host protocol and forwards each validated host
// command here as a same-document "filament:host" event. This file never sees raw host messages.
//
// Load order: game.js only registers that listener; everything else (DOM, canvas, input) is built on INIT, when
// host.js is loaded and listening for errors, so any failure reaches the host as ARCADE_ERROR.
//
// Pause has three independent reasons (same rules as Synapse Run): PLAYER (P / Échap / Pause button), HOST
// (Docteur's ARCADE_PAUSE, removed only by ARCADE_RESUME), HIDDEN (page hidden; also sets PLAYER so coming back never
// resumes by itself). The simulation advances only with no reason active, and only through loop.ts (bounded steps
// per frame) and session.ts (bounded attempt). requestAnimationFrame stops whenever nothing moves.
// [FILAMENT-4] Chapters: the level grid has one tab per chapter. Chapter 2 « Courants d’Altitude » is shown as six
// « en préparation » tiles (not playable, not counted, not saved) with a scenery preview of its first level behind the
// title (threads, walls, rifts, winds; no goal, no stars, never simulated). Fans: tap / click the fan device, F, or
// the « Ventilateur » button; each switch is a validated TOGGLE request (session.ts), applied on the next tick.
// [FILAMENT-4 CH2-A] Level 9 « Premier souffle » is playable: counters, dawn, star totals and the end-of-chapter screen
// are per chapter (chapter 1 shows exactly what it showed before); chapter 2 lists its open level, then the pending
// tiles; the scenery preview is used only for a chapter with no playable level.
// [FILAMENT-5] Chapter 3 « Vergers Stellaires »: a third tab with five « en préparation » tiles and its scenery preview
// (wells drawn, never simulated); the end of chapter 2 announces it with an « Aperçu du chapitre 3 » button only.
// [FILAMENT-5 CH3-E] Chapter 3 is complete (levels 15 to 19): its end screen « Fin du chapitre 3 — Le cœur du verger »
// announces chapter 4 « Lisière du Crépuscule » (levels 20 to 24, 24 planned in all) as text only, nothing playable.
// [FILAMENT-6] Chapter 4 now exists as a fourth tab with five « en préparation » tiles and its scenery preview (theme
// 'crepuscule'); the end of chapter 3 keeps its kicker and offers « Aperçu du chapitre 4 » only (getLevel(19) stays
// null: N and the end screen never open level 20). The final screen « Filament — Les 24 fils du voyage » is prepared but
// can only show once the 24 levels are integrated (none pending) and the last one is won.
// [FILAMENT-6 CH4] Levels 20–24 validated one at a time and integrated: the end of chapter 3 now offers « Chapitre 4 · Le
// dernier rayon » (kicker kept: « Fin du chapitre 3 — Le cœur du verger »), and winning level 24 shows the final screen.
// [FILAMENT-6 polish] Keyboard: F drives the level's first fan (as before, same as the « Ventilateur » button), G the
// second one (only level 23 has two); the intro names each key's device by its side. Mouse and touch unchanged.
import { CHAPTER_TITLE, FILAMENT_CHAPTERS, FILAMENT_LEVELS, PENDING_LEVELS, PLANNED_LEVELS, chapterLevelIndices, chapterPending, getChapter, getLevel, previewLevel, type ChapterId, type FilamentLevel } from './levels.ts';
import { createAttempt, type Attempt, type AttemptLoss } from './session.ts';
import { createFixedStepper } from './loop.ts';
import { FAN_RADIUS_MOUSE, FAN_RADIUS_TOUCH, keyCommand, pickFan, pickThread, threadsCrossed, PICK_RADIUS_MOUSE, PICK_RADIUS_TOUCH, type FanDevice, type ThreadLine } from './input.ts';
import { createFilamentRenderer, type CutEffect, type FilamentRenderer } from './renderer.ts';
import { createProgressSession, FILAMENT_SAVE_VERSION, type LoadResult, type ProgressPayload } from './progress.ts';
import type { Vec } from './physics.ts';

type Screen = 'waiting' | 'title' | 'intro' | 'playing' | 'won' | 'lost' | 'stopped';
interface HostDetail { type: 'INIT' | 'PAUSE' | 'RESUME' | 'STOP'; reducedMotion: boolean }
/** [FILAMENT-3] forwarded by host.js from a validated ARCADE_SAVE_RESULT (or its own SAVE_BUSY refusal) */
interface SaveResultDetail { op: 'LOAD' | 'WRITE'; status: string; code?: string; saveVersion?: unknown; data?: unknown }
interface OverlayButton { label: string; run: () => void }
/** levels: show the level grid (title screen) */
interface Overlay { kicker?: string; title: string; text: string; detail?: string; buttons: OverlayButton[]; levels?: boolean }

const LOSS_TEXT: Record<AttemptLoss, string> = {
  OUT_OF_BOUNDS: 'Elle a quitté le ciel.',
  RIFT: 'Elle a touché une faille.',
  STUCK: 'Elle s’est immobilisée loin du halo.',
  FREE_FLIGHT_TIMEOUT: 'Elle a dérivé trop longtemps sans atteindre le halo.',
  INVALID: 'La simulation s’est arrêtée par sécurité.',
  TIME_UP: 'Le temps de cette tentative (60 secondes) est écoulé.',
};

const CONTROLS_TEXT = 'Souris : cliquez sur le fil ou tracez un trait à travers. Tactile : touchez ou glissez. Clavier : Espace pour couper, P pour la pause, R pour recommencer.';

/** [FILAMENT-6] fan sentence of the level intro: one fan → as before; two fans (level 23) → which key drives which device */
function fanControlsText(slots: readonly FanDevice[]): string {
  if (slots.length === 0) return '';
  if (slots.length === 1) return ' Ventilateur : touchez-le, cliquez dessus ou appuyez sur F.';
  const side = (own: FanDevice, other: FanDevice) => (own.x < other.x ? 'de gauche' : 'de droite');
  const [first, second] = slots;
  return ` Ventilateurs : touchez ou cliquez sur leur boîtier ; au clavier, F pour le boîtier ${side(first, second)} (comme le bouton Ventilateur), G pour le boîtier ${side(second, first)}.`;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`FILAMENT_PAGE_INCOMPLETE:${id}`);
  return element as T;
}

function starsText(count: number, total: number): string {
  return `${'★'.repeat(count)}${'☆'.repeat(Math.max(0, total - count))}`;
}

/** [FILAMENT-4 CH2-A] number of a chapter's last level, playable or pending (chapter 1: 8) */
function chapterLastNumber(id: ChapterId): number {
  return Math.max(0, ...chapterLevelIndices(id).map(i => FILAMENT_LEVELS[i].number), ...chapterPending(id).map(p => p.number));
}

/** « Niveau 3/8 » in chapter 1 (as before), « Niveau 9/14 » in chapter 2 */
function levelLabel(level: FilamentLevel): string {
  return `Niveau ${level.number}/${chapterLastNumber(level.chapter)}`;
}

/** « les niveaux 10 à 14 sont en préparation : ils s’ouvriront… » / « le niveau 14 est en préparation : il… » / '' */
function pendingText(id: ChapterId): string {
  const pending = chapterPending(id);
  if (pending.length === 0) return '';
  if (pending.length === 1) return `le niveau ${pending[0].number} est en préparation : il s’ouvrira après sa validation`;
  const span = pending.length === 2 ? `${pending[0].number} et ${pending[1].number}` : `${pending[0].number} à ${pending[pending.length - 1].number}`;
  return `les niveaux ${span} sont en préparation : ils s’ouvriront après leur validation`;
}

function startGame(initialReducedMotion: boolean) {
  const canvas = byId<HTMLCanvasElement>('fl-canvas');
  const stage = byId<HTMLDivElement>('fl-stage');
  const ui = {
    level: byId('fl-level'), stars: byId('fl-stars'), announce: byId('fl-announce'),
    pause: byId<HTMLButtonElement>('fl-pause'), restart: byId<HTMLButtonElement>('fl-restart'), exit: byId<HTMLButtonElement>('fl-exit'),
    cut: byId<HTMLButtonElement>('fl-cut'),
    fan: byId<HTMLButtonElement>('fl-fan'),
    overlay: byId('fl-overlay'), kicker: byId('fl-overlay-kicker'), title: byId('fl-overlay-title'), text: byId('fl-overlay-text'), detail: byId('fl-overlay-detail'),
    buttons: [byId<HTMLButtonElement>('fl-primary'), byId<HTMLButtonElement>('fl-secondary'), byId<HTMLButtonElement>('fl-tertiary')],
    levels: byId('fl-levels'),
    save: byId('fl-save'),
  };
  const renderer: FilamentRenderer = createFilamentRenderer(canvas);
  const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const hostReducedMotion = initialReducedMotion;
  let reducedMotion = false;

  let screen: Screen = 'waiting';
  let levelIndex = 0;
  let attempt: Attempt | null = null;
  const pause = { player: false, host: false, hidden: false };
  const cuts: CutEffect[] = [];
  const lines: ThreadLine[] = [];
  let lineSlots: ThreadLine[] = [];
  const crossed: number[] = [];
  let highlightThread = -1;
  let rafId = 0;
  let endPending = false;
  let overlayActions: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  /** [FILAMENT-3] best stars per level, loaded from and saved to the Arcade host save (progress.ts) */
  const progress = createProgressSession(FILAMENT_LEVELS.map(level => ({ id: level.id, stars: level.physics.stars.length })));
  let saveWarned = false;
  let wonAtMs: number | null = null;
  const levelButtons: { button: HTMLButtonElement; stars: HTMLSpanElement }[] = [];
  /** [FILAMENT-4] chapter tab shown in the level grid, chapter grids and tabs (built once), fan devices of the level */
  let selectedChapter: ChapterId = 'ch1';
  const chapterTabs = new Map<ChapterId, HTMLButtonElement>();
  const chapterGrids = new Map<ChapterId, HTMLDivElement>();
  let fanSlots: FanDevice[] = [];
  let highlightFan = -1;

  /** every listener goes through here so teardown() removes exactly what was added */
  const listen = (target: EventTarget, type: string, handler: (event: never) => void, options?: AddEventListenerOptions) => {
    target.addEventListener(type, handler as EventListener, options);
    cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
  };

  const paused = () => pause.player || pause.host || pause.hidden;
  const canPlay = () => screen === 'playing' && !paused() && attempt !== null && attempt.phase === 'playing';

  // ── simulation clock ──────────────────────────────────────────────────────────────────────────────────────────
  const stepper = createFixedStepper(() => {
    if (!attempt) return false;
    const report = attempt.step();
    if (!report) return false;
    if (report.cutThreads > 0) say(report.cutThreads > 1 ? 'Fils coupés' : 'Fil coupé');
    if (report.toggledFans > 0) { updateHud(); say(fanIsOn() ? 'Ventilateur allumé' : 'Ventilateur éteint'); }
    if (report.starsTaken > 0) { updateHud(); say(`Étoile cueillie : ${attempt.starCount} sur ${attempt.level.physics.stars.length}`); }
    if (report.ended) { endPending = true; return false; }
    return true;
  });

  // ── rendering ────────────────────────────────────────────────────────────────────────────────────────────────
  const animating = () => !paused() && (screen === 'playing' || (!reducedMotion && (screen === 'title' || screen === 'intro' || screen === 'won' || screen === 'lost')));

  function draw(now: number) {
    if (!attempt) return;
    renderer.render({
      physics: attempt.level.physics, state: attempt.state, alpha: canPlay() ? stepper.alpha : 1,
      nowMs: now, cuts, highlightThread, running: screen === 'playing', wonAtMs, highlightFan,
    });
  }

  function frame(now: number) {
    rafId = 0;
    if (screen === 'stopped') return;
    if (canPlay()) stepper.frame(now);
    draw(now);
    if (endPending) { endPending = false; finishAttempt(); }
    // finishAttempt() may already have scheduled the next frame through wake(): never run two loops
    if (animating() && !rafId) rafId = window.requestAnimationFrame(frame);
  }

  function wake() {
    if (screen === 'stopped') return;
    if (animating()) { if (!rafId) rafId = window.requestAnimationFrame(frame); }
    else draw(performance.now());
  }

  // ── text and overlay ─────────────────────────────────────────────────────────────────────────────────────────
  function say(text: string) { ui.announce.textContent = text; }

  /** [FILAMENT-4] state of the level's first fan (false when there is none) */
  function fanIsOn(): boolean {
    if (!attempt) return false;
    const index = attempt.firstFan();
    return index >= 0 && attempt.state.fanOn[index] === true;
  }

  /** [FILAMENT-4] the scene currently shown is a pending level's scenery preview (title screen only) */
  const isPreview = (level: FilamentLevel | undefined) => !!level && PENDING_LEVELS.some(p => p.id === level.id);

  function updateHud() {
    const level = attempt?.level;
    const chapterTitle = level ? getChapter(level.chapter).title : CHAPTER_TITLE;
    if (!level) ui.level.textContent = CHAPTER_TITLE;
    else if (isPreview(level)) ui.level.textContent = `${chapterTitle} · aperçu du niveau ${level.number}`;
    else ui.level.textContent = `${chapterTitle} · ${levelLabel(level)} · ${level.title}`;
    const hasFan = (attempt?.firstFan() ?? -1) >= 0;
    ui.fan.hidden = screen !== 'playing' || !hasFan;
    ui.fan.disabled = !canPlay();
    ui.fan.setAttribute('aria-pressed', fanIsOn() ? 'true' : 'false');
    ui.fan.textContent = fanIsOn() ? 'Ventilateur : allumé' : 'Ventilateur : éteint';
    const total = level?.physics.stars.length ?? 3;
    const count = attempt?.starCount ?? 0;
    ui.stars.textContent = `${starsText(count, total)} ${count}/${total}`;
    ui.stars.setAttribute('aria-label', `Étoiles cueillies : ${count} sur ${total}`);
    const inLevel = screen === 'playing' || screen === 'won' || screen === 'lost';
    ui.pause.hidden = screen !== 'playing';
    ui.pause.setAttribute('aria-pressed', pause.player ? 'true' : 'false');
    ui.pause.textContent = pause.player ? 'Reprendre' : 'Pause';
    ui.restart.hidden = !inLevel;
    ui.cut.hidden = screen !== 'playing';
    ui.cut.disabled = !canPlay() || (attempt?.nextCuttableThread() ?? -1) < 0;
    const previewNote = isPreview(level) ? ' Aperçu du décor : niveau en préparation, pas encore jouable.' : '';
    canvas.setAttribute('aria-label', level ? `Niveau ${level.number}, ${level.title}. ${level.scene}${previewNote}` : 'Filament : ciel nocturne des Jardins de l’Aube.');
  }

  function showOverlay(o: Overlay, moveFocus = true) {
    ui.kicker.textContent = o.kicker ?? '';
    ui.kicker.hidden = !o.kicker;
    ui.title.textContent = o.title;
    ui.text.textContent = o.text;
    ui.detail.textContent = o.detail ?? '';
    ui.detail.hidden = !o.detail;
    overlayActions = o.buttons.map(b => b.run);
    ui.buttons.forEach((button, i) => {
      const spec = o.buttons[i];
      button.hidden = !spec;
      button.textContent = spec ? spec.label : '';
    });
    ui.levels.hidden = !o.levels;
    if (o.levels) updateLevelGrid();
    ui.overlay.hidden = false;
    // like Synapse Run: move focus only when the frame already has it, never steal it from Docteur's host page
    const first = ui.buttons.find(b => !b.hidden);
    if (moveFocus && first && document.hasFocus()) first.focus({ preventScroll: true });
  }

  function hideOverlay() {
    ui.overlay.hidden = true;
    overlayActions = [];
    if (document.hasFocus()) canvas.focus({ preventScroll: true });
  }

  // ── level grid (built once from the fixed level list; text only, no markup injection) ────────────────────────
  function buildLevelGrid() {
    // [FILAMENT-4] one tab and one grid per chapter
    const tabs = document.createElement('div');
    tabs.className = 'fl-chapters';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Chapitres');
    ui.levels.append(tabs);
    for (const chapter of FILAMENT_CHAPTERS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'fl-chapter-tab';
      tab.id = `fl-tab-${chapter.id}`;
      tab.setAttribute('role', 'tab');
      tab.textContent = `Chapitre ${chapter.number} · ${chapter.title}`;
      const grid = document.createElement('div');
      grid.className = 'fl-grid';
      grid.id = `fl-grid-${chapter.id}`;
      grid.setAttribute('role', 'tabpanel');
      grid.setAttribute('aria-labelledby', tab.id);
      tab.setAttribute('aria-controls', grid.id);
      tabs.append(tab);
      ui.levels.append(grid);
      chapterTabs.set(chapter.id, tab);
      chapterGrids.set(chapter.id, grid);
      listen(tab, 'click', () => selectChapter(chapter.id));
    }
    // [FILAMENT-4 CH2-A] playable levels first, then the pending tiles (chapter 2: 9, then 10 … 14)
    FILAMENT_LEVELS.forEach((level, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fl-level-btn';
      const num = document.createElement('span');
      num.className = 'fl-level-num';
      num.textContent = String(level.number);
      const name = document.createElement('span');
      name.className = 'fl-level-name';
      name.textContent = level.title;
      const stars = document.createElement('span');
      stars.className = 'fl-level-stars';
      button.append(num, name, stars);
      chapterGrids.get(level.chapter)?.append(button);
      levelButtons.push({ button, stars });
      listen(button, 'click', () => goIntro(index));
    });
    // pending tiles: visible, announced as not playable, never start anything
    for (const pending of PENDING_LEVELS) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'fl-level-btn';
      tile.dataset.pending = 'true';
      tile.setAttribute('aria-disabled', 'true');
      tile.setAttribute('aria-label', `Niveau ${pending.number}, ${pending.title} : en préparation, pas encore jouable`);
      const num = document.createElement('span');
      num.className = 'fl-level-num';
      num.textContent = String(pending.number);
      const name = document.createElement('span');
      name.className = 'fl-level-name';
      name.textContent = pending.title;
      const status = document.createElement('span');
      status.className = 'fl-level-stars';
      status.textContent = 'En préparation';
      tile.append(num, name, status);
      chapterGrids.get(pending.chapter)?.append(tile);
      listen(tile, 'click', () => say(`${pending.title} est en préparation : ce niveau s’ouvrira après sa validation.`));
    }
  }

  /** [FILAMENT-4] shows one chapter's grid; on the title screen also its scenery (chapter 2: preview, no goal/stars) */
  function selectChapter(id: ChapterId) {
    selectedChapter = id;
    for (const [chapterId, tab] of chapterTabs) tab.setAttribute('aria-selected', chapterId === id ? 'true' : 'false');
    for (const [chapterId, grid] of chapterGrids) grid.hidden = chapterId !== id;
    if (screen !== 'title') return;
    // [FILAMENT-4 CH2-A] a chapter with a playable level shows its first open one (chapter 1: same level as before)
    const open = firstOpenIn(id);
    if (open < 0) showPreview(id);
    else loadLevel(open);
    ui.detail.textContent = titleDetail();
    ui.detail.hidden = false;
    updateHud();
    wake();
  }

  /** Scenery preview of a chapter's first pending level: never stepped (the title screen never runs the simulation). */
  function showPreview(id: ChapterId) {
    const pending = chapterPending(id)[0] ?? PENDING_LEVELS[0];
    if (!pending) { loadLevel(firstOpenLevel()); return; }
    attempt = createAttempt(previewLevel(pending));
    lineSlots = [];
    fanSlots = [];
    cuts.length = 0;
    highlightThread = -1;
    highlightFan = -1;
    wonAtMs = null;
    renderer.resetTrail();
    renderer.setTheme(getChapter(pending.chapter).theme);
    renderer.setDawn(0);
    stepper.reset();
  }

  function titleDetail(): string {
    // [FILAMENT-5] any chapter after the first: open levels, pending ones, or a scenery preview when none is open yet
    if (selectedChapter !== 'ch1') {
      const id = selectedChapter;
      const chapter = getChapter(id);
      const open = chapterLevelIndices(id).map(i => FILAMENT_LEVELS[i]);
      const pending = chapterPending(id);
      if (open.length === 0) {
        const first = pending[0]?.number ?? 0, last = pending[pending.length - 1]?.number ?? 0;
        return `Chapitre ${chapter.number} · ${chapter.title} · ${pending.length} niveaux (${first} à ${last}) en préparation : le décor et les obstacles sont visibles ici en aperçu ; les niveaux s’ouvriront après leur validation.`;
      }
      const openText = open.length === 1 ? `niveau ${open[0].number} ouvert` : `${open.length} niveaux ouverts`;
      const later = pendingText(id);
      return `Chapitre ${chapter.number} · ${chapter.title} · ${openText}${later ? ` ; ${later}` : ''}. Étoiles : ${chapterStars(id)} sur ${chapterStarTotal(id)}.`;
    }
    return `Chapitre 1 · ${CHAPTER_TITLE} · ${chapterLevelIndices('ch1').length} niveaux, du plus simple au plus délicat. Étoiles : ${chapterStars('ch1')} sur ${chapterStarTotal('ch1')}.`;
  }

  /** [FILAMENT-4 CH2-A] stars won / available in one chapter's playable levels */
  function chapterStars(id: ChapterId): number {
    return chapterLevelIndices(id).reduce((n, i) => n + Math.max(0, progress.best(FILAMENT_LEVELS[i].id)), 0);
  }
  function chapterStarTotal(id: ChapterId): number {
    return chapterLevelIndices(id).reduce((n, i) => n + FILAMENT_LEVELS[i].physics.stars.length, 0);
  }

  function updateLevelGrid() {
    const next = progress.firstOpen();
    const allDone = FILAMENT_LEVELS.every(level => progress.best(level.id) >= 0);
    levelButtons.forEach(({ button, stars }, index) => {
      const level = FILAMENT_LEVELS[index];
      const got = progress.best(level.id);
      const total = level.physics.stars.length;
      const plural = got > 1 ? 's' : '';
      const done = got >= 0 ? `, réussi avec ${got} étoile${plural} sur ${total}` : '';
      const advised = !allDone && index === next ? ', niveau conseillé' : '';
      stars.textContent = got >= 0 ? starsText(got, total) : '';
      button.setAttribute('aria-label', `Niveau ${level.number}, ${level.title}${done}${advised}`);
      button.dataset.done = got >= 0 ? 'true' : 'false';
      button.dataset.next = advised ? 'true' : 'false';
    });
  }

  /** first level not won yet, from the saved progression (or the last one) */
  const firstOpenLevel = () => progress.firstOpen();

  /** [FILAMENT-4 CH2-A] first level of a chapter not won yet, else its last level; −1 if it has no playable level */
  function firstOpenIn(id: ChapterId): number {
    const indices = chapterLevelIndices(id);
    return indices.find(i => progress.best(FILAMENT_LEVELS[i].id) < 0) ?? indices[indices.length - 1] ?? -1;
  }

  // ── [FILAMENT-3] saved progression ──────────────────────────────────────────────────────────────────────────
  function saveLine(): string {
    switch (progress.saveStatus) {
      case 'LOADING': return 'Progression : vérification…';
      case 'UNAVAILABLE': return 'Progression non conservée : stockage local indisponible (elle reste valable pendant cette partie).';
      case 'PROTECTED': return 'Progression locale illisible ou plus récente : conservée telle quelle, rien n’est enregistré. Effacez-la depuis la liste de l’Arcade pour repartir de zéro.';
      case 'READY':
        switch (progress.writeStatus) {
          case 'WRITING': return 'Progression : enregistrement…';
          case 'SAVED': return 'Progression enregistrée sur cet appareil.';
          case 'FAILED': return 'Progression : l’enregistrement a échoué ; il sera retenté à la prochaine victoire.';
          case 'IDLE': return FILAMENT_LEVELS.some(l => progress.best(l.id) >= 0) ? 'Progression retrouvée sur cet appareil.' : 'Progression : aucune pour l’instant.';
        }
    }
    return '';
  }

  function updateSaveLine() {
    ui.save.textContent = saveLine();
    document.documentElement.setAttribute('data-progress', progress.saveStatus);
  }

  /** hands one write request to host.js (which alone builds the protocol message); null = nothing to write */
  function writeProgress(payload: ProgressPayload | null) {
    if (payload) document.dispatchEvent(new CustomEvent('filament:save-write', { detail: { saveVersion: FILAMENT_SAVE_VERSION, data: payload } }));
    updateSaveLine();
  }

  function onSaveResult(detail: SaveResultDetail) {
    if (detail.op === 'LOAD') {
      let result: LoadResult;
      if (detail.status === 'EMPTY') result = { status: 'EMPTY' };
      else if (detail.status === 'FOUND') result = { status: 'FOUND', saveVersion: detail.saveVersion, data: detail.data };
      else result = { status: 'ERROR', code: typeof detail.code === 'string' ? detail.code : 'STORAGE_FAILED' };
      writeProgress(progress.onLoad(result));
      if ((progress.saveStatus === 'UNAVAILABLE' || progress.saveStatus === 'PROTECTED') && !saveWarned) {
        saveWarned = true;
        say('La progression ne sera pas enregistrée pendant cette partie.');
      }
      // the title screen was shown before the load answer: refresh it in place (no focus move)
      if (screen === 'title') goTitle(false);
      else updateLevelGrid();
      return;
    }
    writeProgress(progress.onWriteResult(detail.status === 'SAVED'));
  }

  // ── flow ──────────────────────────────────────────────────────────────────────────────────────────────────────
  function loadLevel(index: number) {
    const level: FilamentLevel | null = getLevel(index);
    if (!level) throw new Error('FILAMENT_UNKNOWN_LEVEL');
    levelIndex = index;
    const next = createAttempt(level);
    attempt = next;
    // the orb end of every line is the live engine position (read-only here)
    lineSlots = level.physics.threads.map((thread, index) => ({ index, a: thread.anchor, b: next.state.p }));
    cuts.length = 0;
    highlightThread = -1;
    endPending = false;
    wonAtMs = null;
    // [FILAMENT-4] fan devices of this level (none in chapter 1) and the chapter's scenery
    fanSlots = (level.physics.currents ?? []).flatMap((c, i) => (c.fan ? [{ index: i, x: c.fan.device.x, y: c.fan.device.y }] : []));
    highlightFan = -1;
    renderer.setTheme(getChapter(level.chapter).theme);
    renderer.resetTrail();
    // [FILAMENT-2] the sky moves from deep night (level 1) towards dawn (last level)
    // [FILAMENT-4 CH2-A] within the level's chapter, pending levels included (chapter 1: index / 7, as before)
    const position = chapterLevelIndices(level.chapter).indexOf(index);
    const size = chapterLevelIndices(level.chapter).length + chapterPending(level.chapter).length;
    renderer.setDawn(size > 1 ? position / (size - 1) : 0);
    stepper.reset();
  }

  function goTitle(moveFocus = true) {
    const open = firstOpenLevel();
    loadLevel(open);
    screen = 'title';
    pause.player = false;
    updateHud();
    const started = FILAMENT_LEVELS.some(level => progress.best(level.id) >= 0);
    showOverlay({
      kicker: 'Arcade Docteur · préversion',
      title: 'Filament — Les Liens du Ciel',
      text: 'Coupez les fils au bon moment pour guider la bille lumineuse jusqu’au halo, en cueillant les étoiles du ciel.',
      detail: titleDetail(),
      buttons: [{ label: started ? `Continuer · Niveau ${open + 1}` : 'Commencer · Niveau 1', run: () => goIntro(open) }],
      levels: true,
    }, moveFocus);
    // [FILAMENT-4] keeps the chapter tab the player chose (chapter 2 = scenery preview behind the menu)
    selectChapter(selectedChapter);
    wake();
  }

  function goIntro(index: number) {
    loadLevel(index);
    screen = 'intro';
    pause.player = false;
    const level = attempt!.level;
    updateHud();
    showOverlay({
      kicker: `${getChapter(level.chapter).title} · ${levelLabel(level)}`,
      title: level.title,
      text: level.hint,
      detail: `${CONTROLS_TEXT}${fanControlsText(fanSlots)}`,
      buttons: [{ label: 'Jouer', run: startPlay }, { label: 'Menu', run: goTitle }],
    });
    wake();
  }

  function startPlay() {
    if (!attempt) return;
    screen = 'playing';
    pause.player = false;
    stepper.reset();
    // Docteur may still hold the game paused (host pause): show why instead of a frozen scene
    if (paused()) showPauseOverlay();
    else hideOverlay();
    updateHud();
    say(`Niveau ${attempt.level.number} : ${attempt.level.title}. Coupez le fil quand vous êtes prêt.`);
    wake();
  }

  function restartLevel() {
    loadLevel(levelIndex);
    startPlay();
  }

  function showPauseOverlay() {
    const hostOnly = pause.host && !pause.player;
    showOverlay({
      title: 'Pause',
      text: hostOnly ? 'Docteur a mis le jeu en pause : utilisez « Reprendre » sous le jeu.' : 'La bille attend. Reprenez quand vous voulez.',
      buttons: hostOnly
        ? [{ label: 'Menu', run: goTitle }]
        : [{ label: 'Reprendre', run: resumePlayer }, { label: 'Recommencer', run: restartLevel }, { label: 'Menu', run: goTitle }],
    });
  }

  function pausePlayer() {
    if (screen !== 'playing' || pause.player) return;
    pause.player = true;
    updateHud();
    showPauseOverlay();
    say('Pause');
    wake();
  }

  function resumePlayer() {
    if (screen !== 'playing') return;
    pause.player = false;
    stepper.reset();
    if (paused()) showPauseOverlay();
    else { hideOverlay(); say('Reprise'); }
    updateHud();
    wake();
  }

  function finishAttempt() {
    if (!attempt) return;
    const total = attempt.level.physics.stars.length;
    const count = attempt.starCount;
    const next = getLevel(levelIndex + 1);
    if (attempt.phase === 'won') {
      screen = 'won';
      wonAtMs = performance.now();
      const before = progress.best(attempt.level.id);
      // one write per meaningful change (first win, more stars, or a retry after a failed write); never per frame
      writeProgress(progress.recordWin(attempt.level.id, count));
      const record = before >= 0 && before > count ? ` · meilleur résultat : ${starsText(before, total)}` : '';
      updateHud();
      say(`Niveau réussi, ${count} étoile${count > 1 ? 's' : ''} sur ${total}.`);
      const chapter = attempt.level.chapter;
      const later = pendingText(chapter);
      // [FILAMENT-4 CH2-A] chapter 1 ends when the next level belongs to another chapter (or there is none)
      if (next && next.chapter === chapter) {
        showOverlay({
          kicker: `Niveau ${attempt.level.number} réussi`,
          title: 'La bille a rejoint le halo',
          text: `${count} étoile${count > 1 ? 's' : ''} sur ${total}.`,
          detail: `${starsText(count, total)}${record}`,
          buttons: [{ label: `Niveau suivant · ${next.title}`, run: () => goIntro(levelIndex + 1) }, { label: 'Rejouer', run: restartLevel }, { label: 'Menu', run: () => goTitle() }],
        });
      } else if (chapter === 'ch1') {
        const ch2 = getChapter('ch2').title;
        const sequel = next
          ? `La suite : le chapitre 2 « ${ch2} » commence avec « ${next.title} » (niveau ${next.number})${pendingText('ch2') ? ` ; ${pendingText('ch2')}` : ''}.`
          : `La suite, le chapitre 2 « ${ch2} » (niveaux 9 à 14), est en préparation : il s’ouvrira après la validation de ses niveaux.`;
        showOverlay({
          kicker: 'Fin du chapitre 1',
          title: 'Les Jardins de l’Aube sont traversés',
          text: `${count} étoile${count > 1 ? 's' : ''} sur ${total} pour ce dernier niveau. Étoiles du chapitre : ${chapterStars('ch1')} sur ${chapterStarTotal('ch1')}. ${sequel}`,
          detail: `${starsText(count, total)}${record}`,
          buttons: next
            ? [{ label: `Chapitre 2 · ${next.title}`, run: () => goIntro(levelIndex + 1) }, { label: 'Rejouer ce niveau', run: restartLevel }, { label: 'Menu', run: () => goTitle() }]
            : [{ label: 'Rejouer ce niveau', run: restartLevel }, { label: 'Aperçu du chapitre 2', run: () => { selectedChapter = 'ch2'; goTitle(); } }, { label: 'Menu', run: () => goTitle() }],
        });
      } else if (!later) {
        // [CH2-F v3] last level of a complete chapter (same convention as the end of chapter 1)
        // [FILAMENT-5] a following chapter that has only pending levels is announced and previewed, never played
        const done = getChapter(chapter);
        const following = FILAMENT_CHAPTERS.find(c => c.number === done.number + 1);
        const upcoming = following ? chapterPending(following.id) : [];
        // [FILAMENT-5 CH3] the following chapter already has a playable level: offer it (as the end of chapter 1 does)
        const nextOpen = next && following && next.chapter === following.id ? next : null;
        const pendingNext = following ? pendingText(following.id) : '';
        // [FILAMENT-5 CH3-E] [FILAMENT-6] no playable level follows: the kicker names the finale just won
        // (« Fin du chapitre 3 — Le cœur du verger »); the following chapter, if pending, is previewed, never played
        // [FILAMENT-6 CH4] chapters 3 and 4 end on named finales: their kicker keeps the finale's title even when the next
        // chapter is open; chapter 2's validated end screen (« Fin du chapitre 2 ») is unchanged
        const closing = !nextOpen || done.number >= 3;
        // [FILAMENT-6] the end of the whole game: only once all PLANNED_LEVELS levels are integrated and the last one is won
        const gameComplete = !following && FILAMENT_LEVELS.length === PLANNED_LEVELS && PENDING_LEVELS.length === 0;
        const sequel = following && nextOpen
          ? `La suite : le chapitre ${following.number} « ${following.title} » commence avec « ${nextOpen.title} » (niveau ${nextOpen.number})${pendingNext ? ` ; ${pendingNext}` : ''}.`
          : following && upcoming.length > 0
            ? `La suite, le chapitre ${following.number} « ${following.title} » (niveaux ${upcoming[0].number} à ${upcoming[upcoming.length - 1].number}), est en préparation : il s’ouvrira après la validation de ses niveaux. ${FILAMENT_LEVELS.length} niveaux sur ${PLANNED_LEVELS} sont jouables.`
            : 'La suite est en préparation.';
        const endButtons: OverlayButton[] = following && nextOpen
          ? [{ label: `Chapitre ${following.number} · ${nextOpen.title}`, run: () => goIntro(levelIndex + 1) }, { label: 'Rejouer ce niveau', run: restartLevel }, { label: 'Menu', run: () => goTitle() }]
          : following && upcoming.length > 0
            ? [{ label: 'Rejouer ce niveau', run: restartLevel }, { label: `Aperçu du chapitre ${following.number}`, run: () => { selectedChapter = following.id; goTitle(); } }, { label: 'Menu', run: () => goTitle() }]
            : [{ label: 'Rejouer ce niveau', run: restartLevel }, { label: 'Menu', run: () => goTitle() }];
        if (gameComplete) {
          // [FILAMENT-6] prepared, NOT active yet: with levels 20–24 pending, FILAMENT_LEVELS has 19 levels
          const journeyStars = FILAMENT_CHAPTERS.reduce((n, c) => n + chapterStars(c.id), 0);
          const journeyTotal = FILAMENT_CHAPTERS.reduce((n, c) => n + chapterStarTotal(c.id), 0);
          showOverlay({
            kicker: `Fin du chapitre ${done.number} — ${attempt.level.title}`,
            title: `Filament — Les ${PLANNED_LEVELS} fils du voyage`,
            text: `La bille a traversé les ${FILAMENT_CHAPTERS.length} chapitres, de l’aube au crépuscule. ${count} étoile${count > 1 ? 's' : ''} sur ${total} pour ce dernier niveau. Étoiles du voyage : ${journeyStars} sur ${journeyTotal}. Merci d’avoir joué.`,
            detail: `${starsText(count, total)}${record}`,
            buttons: [{ label: 'Rejouer ce niveau', run: restartLevel }, { label: 'Menu', run: () => goTitle() }],
          });
        } else {
          showOverlay({
            kicker: closing ? `Fin du chapitre ${done.number} — ${attempt.level.title}` : `Fin du chapitre ${done.number}`,
            title: `Les ${done.title} sont traversés`,
            text: `${count} étoile${count > 1 ? 's' : ''} sur ${total} pour ce dernier niveau. Étoiles du chapitre : ${chapterStars(chapter)} sur ${chapterStarTotal(chapter)}. ${sequel}`,
            detail: `${starsText(count, total)}${record}`,
            buttons: endButtons,
          });
        }
      } else {
        // last open level of a chapter whose next levels are still pending
        showOverlay({
          kicker: `Niveau ${attempt.level.number} réussi`,
          title: 'La bille a rejoint le halo',
          text: `${count} étoile${count > 1 ? 's' : ''} sur ${total}.${later ? ` La suite du chapitre ${getChapter(chapter).number} : ${later}.` : ''}`,
          detail: `${starsText(count, total)}${record}`,
          buttons: [{ label: 'Rejouer', run: restartLevel }, { label: 'Menu', run: () => goTitle() }],
        });
      }
    } else {
      screen = 'lost';
      updateHud();
      const reason = LOSS_TEXT[attempt.loss ?? 'INVALID'];
      say(`La bille s’est égarée. ${reason}`);
      showOverlay({
        kicker: `Niveau ${attempt.level.number} · ${attempt.level.title}`,
        title: 'La bille s’est égarée',
        text: reason,
        detail: `${count} étoile${count > 1 ? 's' : ''} sur ${total} avant la chute.`,
        buttons: [{ label: 'Réessayer', run: restartLevel }, { label: 'Menu', run: goTitle }],
      });
    }
    wake();
  }

  // ── cutting ───────────────────────────────────────────────────────────────────────────────────────────────────
  function cut(thread: number): boolean {
    if (!canPlay() || !attempt || !attempt.requestCut(thread)) return false;
    const orb = attempt.state.p;
    if (cuts.length < attempt.level.physics.threads.length) cuts.push({ thread, x: orb.x, y: orb.y, atMs: performance.now() });
    highlightThread = -1;
    updateHud();
    return true;
  }

  /** [FILAMENT-4] a validated fan switch request (applied on the next tick; announced when it happens) */
  function toggleFan(index: number): boolean {
    if (!canPlay() || !attempt || !attempt.requestToggle(index)) return false;
    highlightFan = -1;
    return true;
  }

  /** Attached threads as straight anchor → orb lines (slots built once per attempt, ≤ 8; no allocation here). */
  function cuttableLines(): readonly ThreadLine[] {
    lines.length = 0;
    if (!attempt) return lines;
    for (const slot of lineSlots) if (attempt.state.attached[slot.index]) lines.push(slot);
    return lines;
  }

  // ── pointer: tap / click near a thread, or swipe across it ───────────────────────────────────────────────────
  const pointer = { id: -1, last: { x: 0, y: 0 }, here: { x: 0, y: 0 } };
  const toWorld = (event: PointerEvent, out: Vec) => {
    const box = canvas.getBoundingClientRect();
    return renderer.toWorld(event.clientX - box.left, event.clientY - box.top, out);
  };

  listen(canvas, 'pointerdown', (event: PointerEvent) => {
    if (!canPlay() || pointer.id !== -1 || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    toWorld(event, pointer.last);
    // [FILAMENT-4] a fan device is a button: a tap on it switches the fan and starts no swipe
    const fan = pickFan(pointer.last, fanSlots, event.pointerType === 'mouse' ? FAN_RADIUS_MOUSE : FAN_RADIUS_TOUCH);
    if (fan >= 0) { toggleFan(fan); return; }
    pointer.id = event.pointerId;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* capture is a convenience only */ }
    const radius = event.pointerType === 'mouse' ? PICK_RADIUS_MOUSE : PICK_RADIUS_TOUCH;
    const hit = pickThread(pointer.last, cuttableLines(), radius);
    if (hit >= 0) cut(hit);
  });
  listen(canvas, 'pointermove', (event: PointerEvent) => {
    if (pointer.id === event.pointerId) {
      toWorld(event, pointer.here);
      if (canPlay()) for (const thread of threadsCrossed(pointer.last, pointer.here, cuttableLines(), crossed)) cut(thread);
      pointer.last.x = pointer.here.x; pointer.last.y = pointer.here.y;
      return;
    }
    if (event.pointerType !== 'mouse' || !canPlay()) return;
    toWorld(event, pointer.here);
    const fanHover = pickFan(pointer.here, fanSlots, FAN_RADIUS_MOUSE);
    const hover = fanHover >= 0 ? -1 : pickThread(pointer.here, cuttableLines(), PICK_RADIUS_MOUSE);
    if (hover !== highlightThread || fanHover !== highlightFan) {
      highlightThread = hover;
      highlightFan = fanHover;
      if (fanHover >= 0) canvas.style.cursor = 'pointer';
      else canvas.style.cursor = hover >= 0 ? 'crosshair' : '';
    }
  });
  const endPointer = (event: PointerEvent) => { if (pointer.id === event.pointerId) pointer.id = -1; };
  listen(canvas, 'pointerup', endPointer);
  listen(canvas, 'pointercancel', endPointer);
  listen(canvas, 'pointerleave', () => {
    if (highlightThread !== -1 || highlightFan !== -1) { highlightThread = -1; highlightFan = -1; canvas.style.cursor = ''; }
  });

  // ── buttons and keyboard ─────────────────────────────────────────────────────────────────────────────────────
  ui.buttons.forEach((button, i) => listen(button, 'click', () => { const run = overlayActions[i]; if (run) run(); }));
  listen(ui.pause, 'click', () => { if (pause.player) resumePlayer(); else pausePlayer(); });
  listen(ui.restart, 'click', () => { if (screen === 'playing' || screen === 'won' || screen === 'lost') restartLevel(); });
  listen(ui.cut, 'click', () => { if (attempt) cut(attempt.nextCuttableThread()); });
  listen(ui.fan, 'click', () => { if (attempt && attempt.firstFan() >= 0) toggleFan(attempt.firstFan()); });
  listen(ui.exit, 'click', () => document.dispatchEvent(new CustomEvent('filament:exit-request')));

  listen(window, 'keydown', (event: KeyboardEvent) => {
    if (screen === 'stopped' || event.altKey || event.ctrlKey || event.metaKey) return;
    const command = keyCommand(event.key);
    if (!command) return;
    const onButton = event.target instanceof HTMLButtonElement;
    // Space / Enter on a focused button activate that button, never a cut
    if (onButton && command.kind === 'CUT_NEXT') return;
    if (event.repeat) {
      // a held key never repeats an action; it only keeps Space from scrolling
      if (command.kind === 'CUT_NEXT' || command.kind === 'CUT') event.preventDefault();
      return;
    }
    switch (command.kind) {
      case 'CUT_NEXT':
        if (canPlay() && attempt) { event.preventDefault(); cut(attempt.nextCuttableThread()); }
        return;
      case 'CUT':
        if (canPlay()) { event.preventDefault(); cut(command.thread); }
        return;
      case 'PAUSE':
        if (screen !== 'playing') return;
        event.preventDefault();
        if (pause.player) resumePlayer(); else pausePlayer();
        return;
      case 'RESTART':
        if (screen === 'playing' || screen === 'won' || screen === 'lost') { event.preventDefault(); restartLevel(); }
        return;
      case 'NEXT':
        if (screen === 'won' && getLevel(levelIndex + 1)) { event.preventDefault(); goIntro(levelIndex + 1); }
        return;
      case 'FAN': {
        // [FILAMENT-6] F = first fan (fanSlots[0] is attempt.firstFan(): unchanged), G = second fan when the level has one
        const slot = fanSlots[command.slot];
        if (canPlay() && attempt && slot) { event.preventDefault(); toggleFan(slot.index); }
        return;
      }
    }
  });

  // ── page visibility, size, motion preference ─────────────────────────────────────────────────────────────────
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      pause.hidden = true;
      if (screen === 'playing' && !pause.player) { pause.player = true; showPauseOverlay(); updateHud(); }
    } else {
      pause.hidden = false;
      stepper.reset();
    }
    wake();
  });

  const resize = () => {
    const box = stage.getBoundingClientRect();
    renderer.resize(box.width, box.height, window.devicePixelRatio || 1);
    wake();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (observer) { observer.observe(stage); cleanups.push(() => observer.disconnect()); }
  else listen(window, 'resize', resize);

  const applyMotion = () => {
    reducedMotion = hostReducedMotion || motionQuery?.matches === true;
    document.documentElement.setAttribute('data-reduced-motion', reducedMotion ? 'true' : 'false');
    renderer.setReducedMotion(reducedMotion);
    wake();
  };
  if (motionQuery && typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', applyMotion);
    cleanups.push(() => motionQuery.removeEventListener('change', applyMotion));
  }

  // ── host commands (already validated by host.js) ─────────────────────────────────────────────────────────────
  function teardown() {
    if (screen === 'stopped') return;
    screen = 'stopped';
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
    while (cleanups.length > 0) cleanups.pop()!();
    renderer.destroy();
    attempt = null;
    cuts.length = 0;
    ui.cut.hidden = ui.fan.hidden = ui.pause.hidden = ui.restart.hidden = ui.exit.hidden = true;
    showOverlay({ title: 'Filament est arrêté', text: 'Vous pouvez revenir à la liste des jeux de l’Arcade.', buttons: [] });
  }

  function onHost(detail: HostDetail) {
    switch (detail.type) {
      case 'PAUSE':
        if (!pause.host) {
          pause.host = true;
          if (screen === 'playing') showPauseOverlay();
          updateHud();
          wake();
        }
        return;
      case 'RESUME':
        if (pause.host) {
          pause.host = false;
          stepper.reset();
          if (screen === 'playing') { if (paused()) showPauseOverlay(); else hideOverlay(); }
          updateHud();
          wake();
        }
        return;
      case 'STOP':
        teardown();
        return;
      case 'INIT':
        return; // only the first INIT starts the game (see below)
    }
  }

  ui.exit.hidden = false;
  buildLevelGrid();
  resize();
  applyMotion();
  goTitle();
  updateSaveLine();
  return { onHost, onSaveResult };
}

// ── module evaluation: one listener, nothing else ───────────────────────────────────────────────────────────────
let game: ReturnType<typeof startGame> | null = null;
let stopped = false;
document.addEventListener('filament:host', (event: Event) => {
  const detail = (event as CustomEvent<HostDetail>).detail;
  if (!detail || typeof detail !== 'object' || stopped) return;
  if (detail.type === 'INIT') {
    if (!game) game = startGame(detail.reducedMotion === true);
    return;
  }
  if (detail.type === 'STOP') stopped = true;
  game?.onHost(detail);
});
// [FILAMENT-3] save results (host.js asks for the save right after INIT, i.e. after the game exists); ignored after STOP
document.addEventListener('filament:save-result', (event: Event) => {
  const detail = (event as CustomEvent<SaveResultDetail>).detail;
  if (!game || stopped || !detail || typeof detail !== 'object' || (detail.op !== 'LOAD' && detail.op !== 'WRITE') || typeof detail.status !== 'string') return;
  game.onSaveResult(detail);
});
