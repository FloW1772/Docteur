import { useState, useEffect, useRef, useCallback } from 'react';

export type GestureState = 'idle' | 'loading' | 'active' | 'error';
// Named after the finger-count scheme, not shape heuristics — see detectFingerCount().
export type GestureName = 'rotate' | 'zoom' | 'swipe' | 'scroll' | 'fist' | null;
// 'gestures': hand-tracking loop + MediaPipe loaded, drives the 3D cortex.
// 'photo': camera stream only, no MediaPipe loaded at all — pure resource
// saving, and the source for capturePhoto()'s OCR flow (screen-share's
// ScreenCaptureModal reused as-is, see useScreenOcr).
export type CameraMode = 'gestures' | 'photo';

// Local WASM (copied from node_modules in postinstall) + local model
const WASM_PATH  = '/mediapipe/';
const MODEL_LOCAL = '/mediapipe/hand_landmarker.task';
const MODEL_CDN   = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const DETECT_FPS      = 15;
const DETECT_INTERVAL = 1000 / DETECT_FPS;
const DEAD_ZONE        = 0.010; // normalized coords — below this = jitter, ignore
const SMOOTH           = 0.30;  // exponential smoothing factor
const HOLD_FRAMES      = 3;     // consecutive consistent frames before the finger count "confirms"
// MediaPipe's handedness score below this is treated as an unreliable frame
// and skipped rather than fed into detection — 0.7 is a common practical
// cutoff for this model (scores cluster near 0.95-1.0 for a clean, unoccluded
// hand and drop sharply, not gradually, when the detection is marginal).
const CONFIDENCE_THRESHOLD = 0.7;

// Base multipliers at sensitivity=5 (the Settings slider default) land on the
// values requested for testing (×20 rotation, ×30 zoom); the 1..10 slider
// then scales linearly around that point.
const ROTATE_BASE = 4;  // × sensitivity(1..10) → 4..40, default(5) = 20
const ZOOM_BASE   = 6;  // × sensitivity(1..10) → 6..60,  default(5) = 30

// Swipe / scroll (1 or 3 fingers): distance + timing window for a deliberate
// directional move, measured on the raw fingertip position.
const SWIPE_MIN_DIST  = 0.09;  // normalized displacement
const SWIPE_MIN_MS    = 80;
const SWIPE_MAX_MS    = 600;

const DEBUG_KEY       = 'docteur-gesture-debug';
const SENSITIVITY_KEY = 'docteur-gesture-sensitivity';
const EASTER_EGG_KEY  = 'docteur-gesture-easter-egg';

// Middle-finger-only gesture (easter egg trigger): held longer than the
// regular HOLD_FRAMES to make an accidental/incidental raise very unlikely —
// this is a deliberate, unmissable prank gesture, not a normal control.
const EASTER_EGG_HOLD_FRAMES = HOLD_FRAMES * 3;

export function getGestureSensitivity(): number {
  try {
    const raw = Number(localStorage.getItem(SENSITIVITY_KEY));
    return raw >= 1 && raw <= 10 ? raw : 5;
  } catch { return 5; }
}

export function setGestureSensitivity(value: number): void {
  try { localStorage.setItem(SENSITIVITY_KEY, String(Math.max(1, Math.min(10, value)))); } catch { /* ignore */ }
}

// Enabled by default — the user explicitly opted into keeping it on unless
// they turn it off in Settings.
export function getEasterEggEnabled(): boolean {
  try {
    const raw = localStorage.getItem(EASTER_EGG_KEY);
    return raw === null ? true : raw === 'true';
  } catch { return true; }
}

export function setEasterEggEnabled(value: boolean): void {
  try { localStorage.setItem(EASTER_EGG_KEY, String(value)); } catch { /* ignore */ }
}

interface HandLandmark { x: number; y: number; z: number }

// Minimal type for HandLandmarker instance
interface HandLandmarkerInstance {
  detectForVideo(video: HTMLVideoElement, timestamp: number): {
    landmarks: HandLandmark[][];
    // handedness classification confidence — the closest thing MediaPipe's
    // HandLandmarker exposes to a per-hand detection-quality score. Low
    // values correlate with a marginal/ambiguous detection (motion blur,
    // partial occlusion, poor lighting) — see CONFIDENCE_THRESHOLD below.
    handednesses?: { score: number; categoryName: string }[][];
  };
  close(): void;
}

export interface GestureSettings {
  cortex3dEnabled:   boolean;
  navigationEnabled: boolean;
  sensitivity:       number; // 1 .. 10, Settings slider — see ROTATE_BASE/ZOOM_BASE
  easterEggEnabled:  boolean;
}

export interface GestureDebugInfo {
  handsDetected:  number;
  fingerCount:    number | null; // raw count this frame, 0..5
  confirmedCount: number | null; // hysteresis-stabilized count actually driving actions
  position:       { x: number; y: number } | null;
  videoSize:      { w: number; h: number } | null;
  rawGesture:     GestureName;
  swipeDist:      number;
  swipeThreshold: number;
  confidence:     number | null; // handedness score for this frame's hand, 0..1
  metrics:        FingerMetrics | null; // per-finger raw value + threshold
}

function dist3D(a: HandLandmark, b: HandLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Bend angle (radians) at the middle joint of a finger, between the
// MCP→PIP and PIP→TIP bone segments — 0 = perfectly straight, larger = more
// curled. Uses the full 3D landmark (x, y, AND z, not just the 2D screen
// projection), which is what makes this invariant to hand rotation:
// a straight finger has near-0° bend at this joint no matter which way the
// hand faces the camera, whereas the earlier tip-to-wrist 2D DISTANCE ratio
// changed depending on whether the palm or the back of the hand faced the
// camera (foreshortening), causing curled fingers to sometimes measure as
// "extended" — exactly the false 2-or-3-fingers-detected-instead-of-1 bug
// reported when only the middle finger was raised. Used for the four fingers
// (index/middle/ring/pinky) — NOT the thumb, see isThumbExtended below.
function bendAngle(lm: HandLandmark[], mcp: number, mid: number, tip: number): number {
  const v1 = { x: lm[mid].x - lm[mcp].x, y: lm[mid].y - lm[mcp].y, z: lm[mid].z - lm[mcp].z };
  const v2 = { x: lm[tip].x - lm[mid].x, y: lm[tip].y - lm[mid].y, z: lm[tip].z - lm[mid].z };
  const mag1 = Math.hypot(v1.x, v1.y, v1.z);
  const mag2 = Math.hypot(v2.x, v2.y, v2.z);
  if (mag1 === 0 || mag2 === 0) return 0;
  const cos = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (mag1 * mag2);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

// A finger reads as extended when its middle-joint bend is below ~50° —
// generous enough for a naturally slightly-curved straight finger, strict
// enough to reject a curled one.
const BEND_THRESHOLD_DEG = 50;

// The thumb doesn't fold toward the palm like the other four fingers — it
// abducts sideways, away from the hand — so a bend-angle-at-the-joint
// heuristic (built for a hinge motion) reads it inconsistently. Instead:
// how far the thumb TIP sits from the palm (proxied by the index MCP),
// relative to the hand's own size (wrist→middle-MCP as a scale reference so
// this works at any distance from the camera). A folded thumb sits close to
// the palm; an extended/abducted thumb sits clearly farther from it.
const THUMB_RATIO_THRESHOLD = 0.55;

function isThumbExtended(lm: HandLandmark[]): boolean {
  const handSize = dist3D(lm[0], lm[9]); // wrist → middle MCP
  if (handSize === 0) return false;
  return dist3D(lm[4], lm[5]) / handSize > THUMB_RATIO_THRESHOLD;
}

interface FingerExtension {
  count:  number;
  thumb:  boolean;
  index:  boolean;
  middle: boolean;
  ring:   boolean;
  pinky:  boolean;
}

// Per-finger raw metric + threshold, surfaced in the debug panel so it's
// possible to see exactly why a given finger did or didn't count — instead
// of guessing at thresholds blind.
export interface FingerMetrics {
  thumb:  { value: number; threshold: number; unit: 'ratio' };
  index:  { value: number; threshold: number; unit: 'deg' };
  middle: { value: number; threshold: number; unit: 'deg' };
  ring:   { value: number; threshold: number; unit: 'deg' };
  pinky:  { value: number; threshold: number; unit: 'deg' };
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

// Analyzes which fingers are extended (not just how many). Invariant to hand
// rotation — including front/back facing the camera, see bendAngle() above —
// and, critically, to MOVEMENT — unlike the previous shape-based gestures
// (pinch, "index only moving") which lost recognition as soon as the hand
// moved because the shape heuristic itself was movement-sensitive. This only
// depends on landmark geometry within a single frame.
function analyzeFingers(lm: HandLandmark[]): FingerExtension & { metrics: FingerMetrics } {
  const thumbRatio  = dist3D(lm[4], lm[5]) / (dist3D(lm[0], lm[9]) || 1);
  const indexDeg    = toDeg(bendAngle(lm, 5, 6, 8));
  const middleDeg   = toDeg(bendAngle(lm, 9, 10, 12));
  const ringDeg     = toDeg(bendAngle(lm, 13, 14, 16));
  const pinkyDeg    = toDeg(bendAngle(lm, 17, 18, 20));

  const thumb  = thumbRatio > THUMB_RATIO_THRESHOLD;
  const index  = indexDeg   < BEND_THRESHOLD_DEG;
  const middle = middleDeg  < BEND_THRESHOLD_DEG;
  const ring   = ringDeg    < BEND_THRESHOLD_DEG;
  const pinky  = pinkyDeg   < BEND_THRESHOLD_DEG;
  const count  = [thumb, index, middle, ring, pinky].filter(Boolean).length;

  return {
    count, thumb, index, middle, ring, pinky,
    metrics: {
      thumb:  { value: thumbRatio, threshold: THUMB_RATIO_THRESHOLD, unit: 'ratio' },
      index:  { value: indexDeg,   threshold: BEND_THRESHOLD_DEG,    unit: 'deg' },
      middle: { value: middleDeg,  threshold: BEND_THRESHOLD_DEG,    unit: 'deg' },
      ring:   { value: ringDeg,    threshold: BEND_THRESHOLD_DEG,    unit: 'deg' },
      pinky:  { value: pinkyDeg,   threshold: BEND_THRESHOLD_DEG,    unit: 'deg' },
    },
  };
}

// "1 finger" gestures (swipe navigation) must only fire for the INDEX finger
// specifically — never confused with the middle-finger-only easter egg, which
// also happens to be a single extended finger.
function isIndexOnly(f: FingerExtension): boolean {
  return f.index && !f.thumb && !f.middle && !f.ring && !f.pinky;
}

function isMiddleOnly(f: FingerExtension): boolean {
  return f.middle && !f.thumb && !f.index && !f.ring && !f.pinky;
}

function gestureNameForCount(count: number | null): GestureName {
  switch (count) {
    case 5: return 'rotate';
    case 2: return 'zoom';
    case 1: return 'swipe';
    case 3: return 'scroll';
    case 0: return 'fist';
    default: return null;
  }
}

// Turns a getUserMedia failure into an explicit, actionable message — never a silent failure.
function describeCameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : (e as { name?: string })?.name;
  const msg  = e instanceof Error ? e.message : String(e);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Permission caméra refusée — autorise l\'accès dans les paramètres du navigateur';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Aucune caméra trouvée sur cet appareil';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Caméra occupée par une autre application — ferme-la et réessaie';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Aucune caméra ne correspond aux réglages demandés';
    case 'SecurityError':
      return 'Accès caméra bloqué (contexte non sécurisé — HTTPS requis)';
    default:
      return `Caméra : ${msg.slice(0, 120)}`;
  }
}

export function useGestureCamera({
  settings,
  onRotate,
  onZoom,
  onNext,
  onPrev,
  onScroll,
  onEasterEgg,
}: {
  settings:  GestureSettings;
  onRotate:  (dx: number, dy: number) => void;
  onZoom:    (delta: number) => void;
  onNext:    () => void;
  onPrev:    () => void;
  onScroll?: (direction: 1 | -1) => void;
  onEasterEgg?: () => void;
}) {
  const [gestureState, setGestureState] = useState<GestureState>('idle');
  const [lastGesture,  setLastGesture]  = useState<GestureName>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [mode,         setModeState]    = useState<CameraMode>('gestures');
  const [debugEnabled, setDebugEnabled] = useState(() => {
    try { return localStorage.getItem(DEBUG_KEY) === 'true'; } catch { return false; }
  });
  const [debugInfo, setDebugInfo] = useState<GestureDebugInfo>({
    handsDetected: 0, fingerCount: null, confirmedCount: null, position: null, videoSize: null,
    rawGesture: null, swipeDist: 0, swipeThreshold: SWIPE_MIN_DIST, confidence: null, metrics: null,
  });

  const videoRef     = useRef<HTMLVideoElement | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const detectorRef  = useRef<HandLandmarkerInstance | null>(null);
  const rafRef       = useRef<number | null>(null);
  const activeRef    = useRef(false);
  const lastDetRef   = useRef(0);

  // Smoothing + gesture tracking state
  const prevWristRef      = useRef<{ x: number; y: number } | null>(null);
  const prevFingerYRef    = useRef<number | null>(null); // 2-finger zoom: avg tip Y
  const smoothRef         = useRef({ dx: 0, dy: 0 });
  const swipeStartRef     = useRef<{ x: number; y: number; time: number } | null>(null);
  // Hysteresis: raw count must hold for HOLD_FRAMES consecutive frames before
  // it becomes `confirmed`. Actions are gated on `confirmed`, so a single
  // noisy frame (raw count briefly off) never flips which branch runs and
  // therefore never wipes the position reference needed for continuous
  // tracking — that reference is only reset when `confirmed` actually changes.
  const rawStreakRef  = useRef<{ count: number | null; streak: number }>({ count: null, streak: 0 });
  const confirmedRef  = useRef<number | null>(null);

  // Middle-finger-only easter egg: its own independent streak/fired guard so
  // it never interferes with the count-based hysteresis above. `fired` resets
  // as soon as the pose breaks so re-raising the finger can trigger again.
  const middleOnlyStreakRef = useRef(0);
  const easterEggFiredRef   = useRef(false);

  const settingsRef   = useRef(settings);
  settingsRef.current = settings;

  const onRotateRef = useRef(onRotate); onRotateRef.current = onRotate;
  const onZoomRef   = useRef(onZoom);   onZoomRef.current   = onZoom;
  const onNextRef   = useRef(onNext);   onNextRef.current   = onNext;
  const onPrevRef   = useRef(onPrev);   onPrevRef.current   = onPrev;
  const onScrollRef = useRef<(direction: 1 | -1) => void>(() => {});
  onScrollRef.current = onScroll ?? (() => {});
  const onEasterEggRef = useRef<() => void>(() => {});
  onEasterEggRef.current = onEasterEgg ?? (() => {});

  const toggleDebug = useCallback(() => {
    setDebugEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem(DEBUG_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const runLoop = useCallback((timestamp: number) => {
    if (!activeRef.current) return;
    rafRef.current = requestAnimationFrame(runLoop);

    if (timestamp - lastDetRef.current < DETECT_INTERVAL) return;
    lastDetRef.current = timestamp;

    const video    = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector || video.readyState < 2) return;

    let result: { landmarks: HandLandmark[][]; handednesses?: { score: number }[][] };
    try {
      result = detector.detectForVideo(video, timestamp);
    } catch (err) {
      if (debugEnabled) console.warn('[gesture] detectForVideo failed:', err);
      return;
    }

    const handsDetected = result.landmarks?.length ?? 0;
    const lm = result.landmarks?.[0];
    const confidence = result.handednesses?.[0]?.[0]?.score ?? null;

    if (!lm || lm.length < 21) {
      prevWristRef.current   = null;
      prevFingerYRef.current = null;
      swipeStartRef.current  = null;
      rawStreakRef.current   = { count: null, streak: 0 };
      confirmedRef.current   = null;
      middleOnlyStreakRef.current = 0;
      easterEggFiredRef.current  = false;
      setLastGesture(null);
      setDebugInfo({
        handsDetected, fingerCount: null, confirmedCount: null, position: null,
        videoSize: { w: video.videoWidth, h: video.videoHeight },
        rawGesture: null, swipeDist: 0, swipeThreshold: SWIPE_MIN_DIST, confidence, metrics: null,
      });
      return;
    }

    // Low-confidence frame (motion blur, partial occlusion, poor lighting) —
    // skip processing entirely rather than feeding a shaky detection into the
    // hysteresis/gesture logic as if it were reliable. The debug panel still
    // reflects the low score so it's visible, not silently dropped.
    if (confidence !== null && confidence < CONFIDENCE_THRESHOLD) {
      if (debugEnabled) console.debug('[gesture] low-confidence frame skipped', { confidence });
      setDebugInfo(prev => ({ ...prev, handsDetected, confidence, videoSize: { w: video.videoWidth, h: video.videoHeight } }));
      return;
    }

    const fingers     = analyzeFingers(lm);
    const fingerCount = fingers.count;
    if (debugEnabled) console.debug('[gesture] raw finger count:', fingerCount);

    // ── Easter egg: middle-finger-only, independent of the count hysteresis ──
    const s0 = settingsRef.current;
    if (s0.easterEggEnabled && isMiddleOnly(fingers)) {
      middleOnlyStreakRef.current++;
      if (middleOnlyStreakRef.current >= EASTER_EGG_HOLD_FRAMES && !easterEggFiredRef.current) {
        easterEggFiredRef.current = true;
        if (debugEnabled) console.info('[gesture] middle finger only → easter egg');
        onEasterEggRef.current();
      }
    } else {
      middleOnlyStreakRef.current = 0;
      easterEggFiredRef.current   = false;
    }

    // ── Hysteresis: only "confirm" a new count after HOLD_FRAMES consistent reads ──
    if (fingerCount === rawStreakRef.current.count) {
      rawStreakRef.current.streak++;
    } else {
      rawStreakRef.current = { count: fingerCount, streak: 1 };
    }
    const previousConfirmed = confirmedRef.current;
    if (rawStreakRef.current.streak >= HOLD_FRAMES) {
      confirmedRef.current = fingerCount;
    }
    const confirmed = confirmedRef.current;
    const justSwitched = confirmed !== previousConfirmed;
    // Only reset tracking refs on an ACTUAL confirmed-category change — never
    // on a single noisy raw frame. This is what keeps the reference point
    // alive through brief misreads while the hand is moving (the bug hit
    // twice before: resetting on every raw flicker meant a delta almost
    // never had a valid "previous frame" to compare against).
    if (justSwitched) {
      prevWristRef.current   = null;
      prevFingerYRef.current = null;
      swipeStartRef.current  = null;
      smoothRef.current      = { dx: 0, dy: 0 };
    }

    const stableName = gestureNameForCount(confirmed);
    setLastGesture(prev => prev !== stableName ? stableName : prev);

    const s = settingsRef.current;
    const sensitivity = Math.max(1, Math.min(10, s.sensitivity || 5));
    let swipeDist = 0;

    if (confirmed === 5 && s.cortex3dEnabled) {
      // ── 5 fingers: rotation, tracked via wrist position ─────────────────────
      const wrist = lm[0];
      if (prevWristRef.current) {
        const rawDeltaX = wrist.x - prevWristRef.current.x;
        const rawDeltaY = wrist.y - prevWristRef.current.y;
        if (Math.abs(rawDeltaX) > DEAD_ZONE || Math.abs(rawDeltaY) > DEAD_ZONE) {
          const dx = rawDeltaX * sensitivity * ROTATE_BASE;
          const dy = rawDeltaY * sensitivity * ROTATE_BASE;
          smoothRef.current.dx = smoothRef.current.dx * (1 - SMOOTH) + dx * SMOOTH;
          smoothRef.current.dy = smoothRef.current.dy * (1 - SMOOTH) + dy * SMOOTH;
          onRotateRef.current(smoothRef.current.dx, smoothRef.current.dy);
          if (debugEnabled) console.info('[gesture] 5 fingers → rotate', { dx: smoothRef.current.dx.toFixed(4), dy: smoothRef.current.dy.toFixed(4), sensitivity });
        } else {
          smoothRef.current = { dx: 0, dy: 0 };
        }
      }
      prevWristRef.current = { x: wrist.x, y: wrist.y };
    } else if (confirmed === 2 && s.cortex3dEnabled) {
      // ── 2 fingers: zoom via vertical movement (up = in, down = out) ─────────
      const fingerY = (lm[8].y + lm[12].y) / 2; // index + middle tip average
      if (prevFingerYRef.current !== null) {
        const rawDelta = prevFingerYRef.current - fingerY; // up (smaller y) → positive → zoom in
        if (Math.abs(rawDelta) > DEAD_ZONE) {
          const delta = rawDelta * sensitivity * ZOOM_BASE;
          onZoomRef.current(delta);
          if (debugEnabled) console.info('[gesture] 2 fingers → zoom', { delta: delta.toFixed(4), sensitivity });
        }
      }
      prevFingerYRef.current = fingerY;
    } else if (confirmed === 1 && s.navigationEnabled && isIndexOnly(fingers)) {
      // ── 1 finger: horizontal swipe → next/prev neuron ────────────────────────
      // Gated on isIndexOnly (not just the count) so a middle-finger-only pose
      // — same count of 1 — never triggers navigation, and vice versa.
      const tip = lm[8];
      if (!swipeStartRef.current) {
        swipeStartRef.current = { x: tip.x, y: tip.y, time: timestamp };
      } else {
        const elapsed = timestamp - swipeStartRef.current.time;
        const deltaX  = tip.x - swipeStartRef.current.x;
        const deltaY  = tip.y - swipeStartRef.current.y;
        swipeDist = Math.abs(deltaX);
        if (elapsed >= SWIPE_MIN_MS && elapsed <= SWIPE_MAX_MS && Math.abs(deltaX) > SWIPE_MIN_DIST && Math.abs(deltaX) > Math.abs(deltaY)) {
          if (deltaX < 0) onPrevRef.current(); else onNextRef.current();
          if (debugEnabled) console.info('[gesture] 1 finger swipe →', deltaX < 0 ? 'prev' : 'next', { dist: swipeDist.toFixed(3) });
          swipeStartRef.current = null;
        } else if (elapsed > SWIPE_MAX_MS) {
          swipeStartRef.current = { x: tip.x, y: tip.y, time: timestamp };
        } else if (debugEnabled) {
          console.debug('[gesture] 1-finger tracking', { elapsed, dist: swipeDist.toFixed(3), threshold: SWIPE_MIN_DIST });
        }
      }
    } else if (confirmed === 3 && s.navigationEnabled) {
      // ── 3 fingers: vertical swipe → scroll content ───────────────────────────
      const tip = lm[8];
      if (!swipeStartRef.current) {
        swipeStartRef.current = { x: tip.x, y: tip.y, time: timestamp };
      } else {
        const elapsed = timestamp - swipeStartRef.current.time;
        const deltaX  = tip.x - swipeStartRef.current.x;
        const deltaY  = tip.y - swipeStartRef.current.y;
        swipeDist = Math.abs(deltaY);
        if (elapsed >= SWIPE_MIN_MS && elapsed <= SWIPE_MAX_MS && Math.abs(deltaY) > SWIPE_MIN_DIST && Math.abs(deltaY) > Math.abs(deltaX)) {
          onScrollRef.current(deltaY > 0 ? 1 : -1);
          if (debugEnabled) console.info('[gesture] 3 fingers swipe → scroll', deltaY > 0 ? 'down' : 'up', { dist: swipeDist.toFixed(3) });
          swipeStartRef.current = null;
        } else if (elapsed > SWIPE_MAX_MS) {
          swipeStartRef.current = { x: tip.x, y: tip.y, time: timestamp };
        } else if (debugEnabled) {
          console.debug('[gesture] 3-finger tracking', { elapsed, dist: swipeDist.toFixed(3), threshold: SWIPE_MIN_DIST });
        }
      }
    } else if (confirmed === 0) {
      if (debugEnabled && justSwitched) console.info('[gesture] fist → release control');
    }

    setDebugInfo({
      handsDetected,
      fingerCount: fingerCount,
      confirmedCount: confirmed,
      position:  { x: lm[0].x, y: lm[0].y },
      videoSize: { w: video.videoWidth, h: video.videoHeight },
      rawGesture: stableName,
      swipeDist,
      swipeThreshold: SWIPE_MIN_DIST,
      confidence,
      metrics: fingers.metrics,
    });
  }, [debugEnabled]);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    detectorRef.current?.close();
    detectorRef.current = null;
    // Stopping every track turns off the hardware camera indicator light.
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    prevWristRef.current   = null;
    prevFingerYRef.current = null;
    swipeStartRef.current  = null;
    smoothRef.current      = { dx: 0, dy: 0 };
    rawStreakRef.current   = { count: null, streak: 0 };
    confirmedRef.current   = null;
    middleOnlyStreakRef.current = 0;
    easterEggFiredRef.current  = false;
    setGestureState('idle');
    setLastGesture(null);
    setError(null);
    setDebugInfo({
      handsDetected: 0, fingerCount: null, confirmedCount: null, position: null, videoSize: null,
      rawGesture: null, swipeDist: 0, swipeThreshold: SWIPE_MIN_DIST, confidence: null, metrics: null,
    });
  }, []);

  // Lazy-loads MediaPipe (WASM from /mediapipe/ — served locally) and returns
  // a ready HandLandmarker. Only ever called in 'gestures' mode — 'photo' mode
  // never imports MediaPipe at all, saving the WASM/model load entirely.
  const loadDetector = useCallback(async (): Promise<HandLandmarkerInstance> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mpModule = await import('@mediapipe/tasks-vision') as any;
    const { HandLandmarker, FilesetResolver } = mpModule as {
      HandLandmarker: {
        createFromOptions(
          resolver: unknown,
          opts: {
            baseOptions: { modelAssetPath: string; delegate: string };
            runningMode: string;
            numHands: number;
          }
        ): Promise<HandLandmarkerInstance>;
      };
      FilesetResolver: {
        forVisionTasks(wasmPath: string): Promise<unknown>;
      };
    };

    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

    // Try local model first (offline), fallback to CDN
    try {
      return await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_LOCAL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      });
    } catch {
      // Fallback to CDN model (first use without postinstall)
      return HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_CDN, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      });
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setGestureState('loading');
    try {
      // 1. Camera stream
      // Gestures mode requests a SQUARE frame: MediaPipe's HandLandmarker
      // (via NORM_RECT without explicit IMAGE_DIMENSIONS) only reliably maps
      // landmarks across a square ROI — a non-square 4:3 frame like the old
      // 320×240 request left hand detection working only in a square region
      // near one corner of the frame, and made the farthest-reaching
      // fingertip (middle) the most likely to land outside it and read as
      // not-extended. 480×480 is a deliberate compromise, not a limit worth
      // raising further: MediaPipe's HandLandmarker resizes its input to a
      // fixed internal resolution regardless of the source stream, so a
      // bigger capture buys no landmark precision here — it only costs more
      // per-frame decode work, which is the actual budget that matters at
      // 15 detections/sec.
      //
      // Photo mode requests the webcam's MAXIMUM resolution instead: it never
      // runs the hand detector (no FPS budget to protect), and unlike hand
      // tracking, OCR quality is directly resolution-bound — the earlier
      // fixed 320×240 request produced a photographed document far too small
      // for Tesseract to read reliably (the likely cause behind "OCR ne
      // fonctionne pas du tout": not a broken pipeline, but text pixels too
      // sparse to recognize). `ideal` is a soft hint the browser honors up to
      // the camera's real ceiling — most webcams top out well above 1080p
      // for stills, driver-dependent.
      const videoConstraints = mode === 'gestures'
        ? { width: { ideal: 480 }, height: { ideal: 480 }, aspectRatio: { ideal: 1 }, frameRate: { ideal: 20, max: 30 } }
        : { width: { ideal: 3840 }, height: { ideal: 2160 } };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch (err) {
        console.error('[gesture] getUserMedia failed:', err);
        throw err;
      }
      if (debugEnabled) console.info('[gesture] getUserMedia OK', stream.getVideoTracks()[0]?.getSettings());
      streamRef.current = stream;
      // Attaching srcObject happens in the effect below (keyed on gestureState) —
      // it cannot be done reliably here because the <video> element only exists
      // once React has committed the 'loading' render, which may not have
      // happened yet at this point in the async flow.

      if (mode === 'gestures') {
        detectorRef.current = await loadDetector();
        activeRef.current   = true;
        rafRef.current = requestAnimationFrame(runLoop);
      }
      // 'photo' mode: camera stream only — no detector, no detection loop.
      setGestureState('active');
    } catch (e) {
      activeRef.current = false;
      setError(describeCameraError(e));
      setGestureState('error');
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, [runLoop, debugEnabled, mode, loadDetector]);

  // Switches between 'gestures' and 'photo' — the two never run at once.
  // If the camera is off, this just changes the preference for the next
  // start(). If it's active, it live-swaps: stopping detection frees
  // MediaPipe immediately going into photo mode, and loading it going back.
  const setCameraMode = useCallback((next: CameraMode) => {
    setModeState(next);
    if (gestureState !== 'active') return; // idle/error/loading — just a preference now

    if (next === 'photo') {
      activeRef.current = false;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      detectorRef.current?.close();
      detectorRef.current = null;
      prevWristRef.current   = null;
      prevFingerYRef.current = null;
      swipeStartRef.current  = null;
      rawStreakRef.current   = { count: null, streak: 0 };
      confirmedRef.current   = null;
      middleOnlyStreakRef.current = 0;
      easterEggFiredRef.current  = false;
      setLastGesture(null);
    } else {
      setGestureState('loading');
      void loadDetector()
        .then(landmarker => {
          detectorRef.current = landmarker;
          activeRef.current   = true;
          setGestureState('active');
          rafRef.current = requestAnimationFrame(runLoop);
        })
        .catch(e => {
          setError(describeCameraError(e));
          setGestureState('error');
        });
    }
  }, [gestureState, loadDetector, runLoop]);

  // Freezes the current camera frame as a PNG data URL — same mechanism as
  // useScreenShare.captureFrame, feeds the same ScreenCaptureModal/OCR flow.
  const capturePhoto = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Deliberately NOT mirrored: the preview is CSS-flipped (scaleX(-1)) for a
    // natural "selfie" feel in gesture mode, but a photographed document must
    // stay in its real orientation or the text comes out backwards and OCR
    // fails completely.
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
  }, []);

  // Attach the stream to the <video> element whenever both are available.
  // Decoupled from start()'s async flow on purpose: getUserMedia resolves on
  // its own schedule and there's no guarantee the <video> element (rendered
  // by GestureOverlay only once gestureState leaves 'idle') is already in the
  // DOM at that exact moment. Re-running this on every gestureState change
  // guarantees it eventually runs after the element exists.
  useEffect(() => {
    if (gestureState === 'idle') return;
    const video  = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    if (video.paused) {
      video.play().catch(err => { if (debugEnabled) console.warn('[gesture] video.play() failed:', err); });
    }
    if (debugEnabled) {
      console.info('[gesture] video element', {
        readyState: video.readyState,
        width:      video.videoWidth,
        height:     video.videoHeight,
        paused:     video.paused,
      });
    }
  }, [gestureState, debugEnabled]);

  const toggle = useCallback(() => {
    if (gestureState === 'idle' || gestureState === 'error') {
      void start();
    } else {
      stop();
    }
  }, [gestureState, start, stop]);

  // Alt+C global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

  // Cleanup on unmount
  useEffect(() => () => { stop(); }, [stop]);

  return {
    gestureState, lastGesture, error, videoRef, toggle, stop, debugEnabled, toggleDebug, debugInfo,
    mode, setCameraMode, capturePhoto,
  };
}
