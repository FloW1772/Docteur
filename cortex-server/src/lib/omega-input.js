/**
 * OMEGA V1 Phase 4 — OMEGA_INTERACTIVE mouse/keyboard input injection.
 *
 * Mechanism (per the mission's pre-made technical decision — not
 * re-derived here): user32.dll!SendInput, invoked via a fixed,
 * repo-shipped `.ps1` script (`omega-input.ps1`) consuming ONLY
 * numeric/enum positional $args, run through Phase 3's
 * `runFixedPowerShellScript()` UNCHANGED (zero modification to
 * omega-windows-exec.js) — mirrors omega-capture.js's exact structure:
 * all validation happens in THIS module, before PowerShell is ever
 * invoked; the .ps1 script itself is "dumb"/mechanical with only a thin
 * defense-in-depth range check of its own.
 *
 * NOT mouse_event/keybd_event (legacy, superseded). NOT SendKeys
 * (keyboard-only, string-parsing-based — wrong fit for an allowlist
 * architecture, skipped entirely per the mission's own research).
 *
 * UIPI (User Interface Privilege Isolation) — confirmed from Microsoft's
 * own docs: a non-elevated Cortex/OMEGA process cannot inject into an
 * elevated (Administrator) window; Windows blocks this itself, silently
 * (fewer events reported sent than requested, no distinguishing error).
 * This is an intentional, Windows-enforced structural limitation, not a
 * bug — omega-input.ps1 reports back "sent" vs "requested" event counts
 * so partial/zero success is surfaced honestly rather than assumed
 * successful; this module propagates that count to the caller/route
 * rather than collapsing it into a bare boolean.
 *
 * Secure desktop (UAC consent, Ctrl+Alt+Del): structurally unreachable
 * by SendInput from the normal interactive desktop — a separate
 * desktop-object boundary enforced by Windows itself. OMEGA does not
 * implement or check for this; nothing here needs to.
 *
 * Mission rule 9 ("refuser séquences dangereuses ou réservées si
 * nécessaire") — judgment call, documented: Ctrl+Alt+Del itself is
 * intercepted by Windows before SendInput could ever matter (per the
 * secure-desktop finding above), so blocking that specific chord in
 * allowlist logic would be redundant-but-harmless defense-in-depth. No
 * OTHER combination is judged to deserve explicit exclusion: the vk-code
 * allowlist below already bounds the injectable-key universe to a small,
 * enumerated safe set (letters, digits, common punctuation, navigation,
 * editing keys, function keys, and the four modifier keys) with no path
 * to launch a system dialog, task manager, or shell by itself — Win+R,
 * Win+X, Alt+F4, etc. are combinations of otherwise-individually-allowed
 * keys, and OMEGA has no concept of a "combination" at all: each
 * KEY_DOWN/KEY_UP event is injected independently and whether two keys
 * are "held together" is a product of the CONTROLLING operator's own
 * timing, not something this API can distinguish from two unrelated
 * keypresses — the same is true of a real physical keyboard, so no
 * additional server-side sequence-blocking was judged necessary beyond
 * the vk allowlist itself.
 */
import path from 'node:path';
import { isWindows, runFixedPowerShellScript } from './omega-windows-exec.js';

const SCRIPT_PATH = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'omega-input.ps1');

export class OmegaInputError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaInputError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaInputError(code, detail);
}

// ── Event-type enum (mirrors omega-input.ps1's own comment — the two
// sides are kept in sync manually, documented on both ends). ──
export const OMEGA_INPUT_EVENT_TYPES = Object.freeze({
  MOVE: 1,
  LEFT_DOWN: 2,
  LEFT_UP: 3,
  RIGHT_DOWN: 4,
  RIGHT_UP: 5,
  WHEEL: 6,
  KEY_DOWN: 7,
  KEY_UP: 8,
});

const MOUSE_EVENT_TYPES = new Set([1, 2, 3, 4, 5, 6]);
const KEY_EVENT_TYPES = new Set([7, 8]);
const ALL_EVENT_TYPES = new Set([...MOUSE_EVENT_TYPES, ...KEY_EVENT_TYPES]);

// ── Virtual-key allowlist (mission rules 6/8: "API Windows documentées",
// "clavier: key down/up sur allowlist/format validé"). A small, explicit,
// enumerated set — NOT "any vk 0-254". Grouped and documented: ──
const VK_ALLOWLIST = new Set([
  // Letters A-Z
  0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D,
  0x4E, 0x4F, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A,
  // Digits 0-9 (top row)
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  // Common punctuation (VK_OEM_*)
  0xBA, // ; :
  0xBB, // = +
  0xBC, // , <
  0xBD, // - _
  0xBE, // . >
  0xBF, // / ?
  0xC0, // ` ~
  0xDB, // [ {
  0xDC, // \ |
  0xDD, // ] }
  0xDE, // ' "
  // Space, Tab, Enter, Escape, Backspace, Delete, Insert
  0x20, 0x09, 0x0D, 0x1B, 0x08, 0x2E, 0x2D,
  // Navigation: Left, Up, Right, Down, Home, End, PageUp, PageDown
  0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22,
  // Modifiers: Shift, Ctrl, Alt, Win (left/right generic + specific)
  0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5,
  // Function keys F1-F12
  0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x7B,
]);

export function isAllowedVirtualKey(vk) {
  return Number.isInteger(vk) && VK_ALLOWLIST.has(vk);
}

// ── Rate limits / bounds (mission's own list — explicit, documented,
// deliberately conservative numbers; documented reasoning, not tied to
// any external spec). ──
export const MAX_EVENTS_PER_BATCH = 20; // a short mouse-move trajectory or a few keystrokes, not an unbounded macro
export const MAX_REQUESTS_PER_SECOND = 20; // per session — generous for interactive use (mouse moves are naturally chunked into MOVE batches), still bounded
export const MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_REQUESTS_PER_SECOND);
export const MAX_BODY_BYTES = 8 * 1024; // small JSON only — a batch of <=20 integer-tuple events comfortably fits in a few hundred bytes; this bounds a pathological oversized-body attempt (mission's "oversized batch" scenario)

function validateCoordinateAgainstScreen(x, y, screen) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) fail('coords_invalid', { x, y });
  if (!screen || !Number.isFinite(screen.width) || !Number.isFinite(screen.height)) fail('screen_bounds_unavailable');
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    fail('coords_out_of_bounds', { x, y, screenWidth: screen.width, screenHeight: screen.height });
  }
}

/**
 * Normalizes a pixel coordinate on the given screen into the
 * MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK 0-65535 space, per the
 * mission's exact formula: the virtual-desktop-absolute pixel is
 * screen.x + localX / screen.y + localY (screen.x/y are already the
 * virtual-desktop-relative origin from Screen.AllScreens' Bounds, which
 * Phase 3's listScreens() already exposes), then
 * normVal = (virtualDesktopPixel) * 65536 / virtualDesktopDimension,
 * clamped 0-65535. The "virtual desktop" bounding box is the union of
 * all monitors — approximated here as the smallest box containing every
 * screen from listScreens() (min x/y to max x+width/y+height), matching
 * SystemInformation.VirtualScreen's own semantics.
 */
export function computeVirtualDesktopBounds(screens) {
  if (!Array.isArray(screens) || screens.length === 0) fail('screens_unavailable');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of screens) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width);
    maxY = Math.max(maxY, s.y + s.height);
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

function normalize(pixel, origin, dimension) {
  const norm = Math.round(((pixel - origin) * 65536) / dimension);
  return Math.max(0, Math.min(65535, norm));
}

/**
 * Validates ONE input event against the explicit allowlists/bounds and
 * returns the fully-resolved PowerShell-ready args tuple
 * [eventType, p1, p2, p3]. Throws OmegaInputError on anything
 * malformed/out-of-range/disallowed — never best-effort-clamps a bad
 * value into range (mission rule 6: "input injection bornée et
 * allowlistée").
 */
export function validateInputEvent(event, { screens, screenIndex }) {
  if (!event || typeof event !== 'object') fail('event_malformed');
  const type = Number(event.type);
  if (!ALL_EVENT_TYPES.has(type)) fail('event_type_invalid', { type: event.type });

  if (MOUSE_EVENT_TYPES.has(type)) {
    const screen = screens[screenIndex];
    if (!screen) fail('screen_index_invalid', { screenIndex });
    const x = Number(event.x);
    const y = Number(event.y);
    validateCoordinateAgainstScreen(x, y, screen);

    const vdesk = computeVirtualDesktopBounds(screens);
    const virtualX = screen.x + x;
    const virtualY = screen.y + y;
    const normX = normalize(virtualX, vdesk.left, vdesk.width);
    const normY = normalize(virtualY, vdesk.top, vdesk.height);

    if (type === OMEGA_INPUT_EVENT_TYPES.WHEEL) {
      const delta = Number(event.wheelDelta);
      if (!Number.isInteger(delta) || delta < -3 || delta > 3 || delta === 0) {
        fail('wheel_delta_invalid', { wheelDelta: event.wheelDelta });
      }
      return [type, normX, normY, delta];
    }
    return [type, normX, normY, 0];
  }

  // KEY_DOWN / KEY_UP
  const vk = Number(event.vk);
  if (!isAllowedVirtualKey(vk)) fail('vk_not_allowed', { vk: event.vk });
  return [type, vk, 0, 0];
}

/**
 * Sends a batch of already-validated events (array of [eventType, p1, p2,
 * p3] tuples), ONE SendInput call per event (never batched into a single
 * PowerShell invocation containing multiple events — keeps each
 * mechanical call small, bounded, and independently timeoutable).
 * Returns { requested, sent, results[] } — never collapses a
 * partial-success batch (e.g. UIPI-blocked target window) into a bare
 * boolean, per the mission's own "N of M events successfully sent"
 * honesty requirement.
 */
export async function sendInputBatch(validatedTuples) {
  if (!isWindows()) fail('input_not_supported', { platform: process.platform });
  if (!Array.isArray(validatedTuples) || validatedTuples.length === 0) fail('batch_empty');
  if (validatedTuples.length > MAX_EVENTS_PER_BATCH) {
    fail('batch_too_large', { size: validatedTuples.length, max: MAX_EVENTS_PER_BATCH });
  }

  const results = [];
  let sent = 0;
  for (const tuple of validatedTuples) {
    const result = await runFixedPowerShellScript(SCRIPT_PATH, tuple.map(String), { timeoutMs: 4_000 });
    if (!result.ok) {
      results.push({ ok: false, reason: result.reason, detail: result.detail });
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { parsed = { ok: false, reason: 'malformed_output' }; }
    if (parsed.ok && Number(parsed.sent) > 0) sent += 1;
    results.push(parsed);
  }

  return { requested: validatedTuples.length, sent, results };
}

export { SCRIPT_PATH };
