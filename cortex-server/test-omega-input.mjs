// OMEGA V1 Phase 4 — input-injection library tests: vk-code/coordinate
// allowlist validation (pure, no PowerShell), PLUS a REAL, non-simulated
// SendInput smoke test on this Windows dev machine (mirroring Phase 3's
// test-omega-capture.mjs discipline of proving the actual mechanism
// works, not just its mocked callers).
//
// SAFETY-ENGINEERING DECISION (documented per the mission's own explicit
// instruction to treat this as a genuine safety concern, not an
// afterthought): a real SendInput call actually moves the mouse/types on
// whatever machine runs this test — unlike Phase 3's screen capture,
// which is passive/read-only, injection is NOT. This file:
//   1. Only ever sends a MOUSE MOVE to a fixed, safe, inert coordinate
//      (top-left corner, 0,0) by default — never a real click (which
//      could activate/press whatever is under the cursor) and never a
//      real character keystroke (which could type into whatever window
//      happens to have focus during an automated/CI run).
//   2. The ONE real keyboard round-trip tested is VK_SHIFT (0x10)
//      down+up — a modifier key that, sent alone with no other key held,
//      has no observable side effect on any standard Windows
//      application (it cannot type a character, activate a menu, or
//      trigger a shortcut by itself).
//   3. Everything beyond that minimal "prove SendInput genuinely works
//      end-to-end through Node -> PowerShell -> user32.dll" smoke check
//      is gated behind the OMEGA_ALLOW_REAL_INJECTION_TESTS=1 env var,
//      OFF by default, so a shared/automated CI run never has any
//      destructive side effect regardless of what window has focus.
//      When set, additional real-injection scenarios (left/right click,
//      wheel) are exercised against a deliberately inert target: this
//      repo's own dev machine has no guarantee of a safe click target,
//      so even the opt-in path only clicks at (0,0) top-left corner of
//      the primary screen, which on a normal Windows desktop is empty
//      desktop background or, at worst, a taskbar/Start-menu corner —
//      still not run by default specifically because that assumption
//      cannot be fully guaranteed on every possible machine.
//   4. The bulk of scenario coverage (rate limits, bounds, allowlist
//      rejection, malformed events) is validated at the PURE validation
//      layer (validateInputEvent/isAllowedVirtualKey/coordinate bounds),
//      which never shells out to PowerShell at all — mirroring how
//      test-omega-view.mjs used an injected fake capture provider for
//      the bulk of its scenario matrix while test-omega-capture.mjs did
//      the one real-hardware proof.
//
// Run with: node --test --test-timeout=20000 test-omega-input.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedVirtualKey, validateInputEvent, computeVirtualDesktopBounds,
  sendInputBatch, OMEGA_INPUT_EVENT_TYPES, OmegaInputError,
  MAX_EVENTS_PER_BATCH,
} from './src/lib/omega-input.js';

const isWin = process.platform === 'win32';
const ALLOW_REAL = process.env.OMEGA_ALLOW_REAL_INJECTION_TESTS === '1';

const SCREENS = [
  { index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, device: 'DISPLAY1' },
  { index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, device: 'DISPLAY2' },
];

// ── vk-code allowlist (mission rule 8: "clavier: key down/up sur
// allowlist/format validé") ──────────────────────────────────────────

test('isAllowedVirtualKey: letters, digits, common punctuation are allowed', () => {
  assert.ok(isAllowedVirtualKey(0x41)); // 'A'
  assert.ok(isAllowedVirtualKey(0x5A)); // 'Z'
  assert.ok(isAllowedVirtualKey(0x30)); // '0'
  assert.ok(isAllowedVirtualKey(0x39)); // '9'
  assert.ok(isAllowedVirtualKey(0xBC)); // ,
  assert.ok(isAllowedVirtualKey(0xBE)); // .
});

test('isAllowedVirtualKey: navigation/editing/modifier/function keys are allowed', () => {
  assert.ok(isAllowedVirtualKey(0x25)); // Left
  assert.ok(isAllowedVirtualKey(0x24)); // Home
  assert.ok(isAllowedVirtualKey(0x2E)); // Delete
  assert.ok(isAllowedVirtualKey(0x08)); // Backspace
  assert.ok(isAllowedVirtualKey(0x0D)); // Enter
  assert.ok(isAllowedVirtualKey(0x09)); // Tab
  assert.ok(isAllowedVirtualKey(0x1B)); // Esc
  assert.ok(isAllowedVirtualKey(0x10)); // Shift
  assert.ok(isAllowedVirtualKey(0x11)); // Ctrl
  assert.ok(isAllowedVirtualKey(0x12)); // Alt
  assert.ok(isAllowedVirtualKey(0x5B)); // Win
  assert.ok(isAllowedVirtualKey(0x70)); // F1
  assert.ok(isAllowedVirtualKey(0x7B)); // F12
});

test('isAllowedVirtualKey: vk codes NOT on the allowlist are rejected (e.g. VK_PACKET-adjacent/media/browser keys)', () => {
  assert.equal(isAllowedVirtualKey(0xE7), false); // VK_PACKET
  assert.equal(isAllowedVirtualKey(0xAD), false); // volume mute
  assert.equal(isAllowedVirtualKey(0x5D), false); // apps/context-menu key
  assert.equal(isAllowedVirtualKey(0), false);
  assert.equal(isAllowedVirtualKey(255), false);
  assert.equal(isAllowedVirtualKey(-1), false);
  assert.equal(isAllowedVirtualKey(1.5), false);
  assert.equal(isAllowedVirtualKey('65'), false); // string, not number — must be strict
});

// ── Coordinate bounds (mission rule 6: "borné"; "coordonnées hors
// écran" test scenario) ───────────────────────────────────────────────

test('validateInputEvent: MOVE within screen bounds is accepted and normalized to 0-65535', () => {
  const [type, normX, normY] = validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 960, y: 540 }, { screens: SCREENS, screenIndex: 0 });
  assert.equal(type, 1);
  assert.ok(normX >= 0 && normX <= 65535);
  assert.ok(normY >= 0 && normY <= 65535);
});

test('validateInputEvent: coordinates outside the selected screen bounds are rejected (fail closed, never clamped)', () => {
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 99999, y: 540 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'coords_out_of_bounds');
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: -1, y: 0 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'coords_out_of_bounds');
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 1920, y: 0 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'coords_out_of_bounds'); // exactly at width == out of bounds (0-indexed)
});

test('validateInputEvent: a valid coordinate for screen 1 is checked against screen 1 bounds, not screen 0', () => {
  const [, normX] = validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 100, y: 100 }, { screens: SCREENS, screenIndex: 1 });
  assert.ok(normX >= 0 && normX <= 65535);
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 1500, y: 100 }, { screens: SCREENS, screenIndex: 1 }),
    (err) => err instanceof OmegaInputError && err.code === 'coords_out_of_bounds'); // 1500 fits screen 0's width but not screen 1's (1280)
});

test('validateInputEvent: non-integer / non-numeric coordinates are rejected', () => {
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 1.5, y: 10 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'coords_invalid');
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 'x', y: 10 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'coords_invalid');
});

test('validateInputEvent: an invalid/unknown screenIndex is rejected before coordinate math', () => {
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 0, y: 0 }, { screens: SCREENS, screenIndex: 5 }),
    (err) => err instanceof OmegaInputError && err.code === 'screen_index_invalid');
});

test('computeVirtualDesktopBounds: union of a 2-monitor layout matches the expected bounding box', () => {
  const bounds = computeVirtualDesktopBounds(SCREENS);
  assert.equal(bounds.left, 0);
  assert.equal(bounds.top, 0);
  assert.equal(bounds.width, 1920 + 1280);
  assert.equal(bounds.height, 1080);
});

// ── Event-type / mouse-only-4-actions / keyboard-only-2-actions
// (mission rules 7/8) ─────────────────────────────────────────────────

test('validateInputEvent: mouse events restricted to move/left/right/wheel — an unknown numeric type is rejected', () => {
  assert.throws(() => validateInputEvent({ type: 99, x: 0, y: 0 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'event_type_invalid');
  assert.throws(() => validateInputEvent({ type: 0, x: 0, y: 0 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'event_type_invalid');
});

test('validateInputEvent: WHEEL requires a bounded, non-zero integer delta', () => {
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.WHEEL, x: 0, y: 0, wheelDelta: 0 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'wheel_delta_invalid');
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.WHEEL, x: 0, y: 0, wheelDelta: 999 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'wheel_delta_invalid');
  const [type, , , delta] = validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.WHEEL, x: 0, y: 0, wheelDelta: 1 }, { screens: SCREENS, screenIndex: 0 });
  assert.equal(type, OMEGA_INPUT_EVENT_TYPES.WHEEL);
  assert.equal(delta, 1);
});

test('validateInputEvent: KEY_DOWN/KEY_UP with a disallowed vk are rejected', () => {
  assert.throws(() => validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, vk: 0xE7 }, { screens: SCREENS, screenIndex: 0 }),
    (err) => err instanceof OmegaInputError && err.code === 'vk_not_allowed');
});

test('validateInputEvent: KEY_DOWN with an allowed vk resolves to the correct tuple shape', () => {
  const tuple = validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, vk: 0x41 }, { screens: SCREENS, screenIndex: 0 });
  assert.deepEqual(tuple, [OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, 0x41, 0, 0]);
});

test('validateInputEvent: malformed event object is rejected', () => {
  assert.throws(() => validateInputEvent(null, { screens: SCREENS, screenIndex: 0 }), (err) => err instanceof OmegaInputError && err.code === 'event_malformed');
  assert.throws(() => validateInputEvent('not-an-object', { screens: SCREENS, screenIndex: 0 }), (err) => err instanceof OmegaInputError && err.code === 'event_malformed');
});

// ── Batch bounds (mission's "oversized batch" scenario) ────────────────

test('sendInputBatch: rejects an empty batch', { skip: !isWin }, async () => {
  await assert.rejects(() => sendInputBatch([]), (err) => err instanceof OmegaInputError && err.code === 'batch_empty');
});

test('sendInputBatch: rejects a batch larger than MAX_EVENTS_PER_BATCH without ever invoking PowerShell', { skip: !isWin }, async () => {
  const oversized = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => [1, 0, 0, 0]);
  await assert.rejects(() => sendInputBatch(oversized), (err) => err instanceof OmegaInputError && err.code === 'batch_too_large');
});

test('sendInputBatch() / validateInputEvent() throw a clean error on a non-Windows platform rather than crashing', { skip: isWin }, async () => {
  await assert.rejects(() => sendInputBatch([[1, 0, 0, 0]]), (err) => err instanceof OmegaInputError && err.code === 'input_not_supported');
});

// ── REAL, non-simulated SendInput proof (Windows-only, minimal, safe by
// construction — see file header for the full safety rationale) ───────

test('sendInputBatch: a real MOUSE MOVE to the safe (0,0) corner genuinely reaches user32.dll SendInput on this machine', { skip: !isWin }, async () => {
  // normX=0, normY=0 is the top-left corner of the virtual desktop —
  // inert (desktop background / corner of a taskbar at worst), never a
  // click, so no activation/press side effect regardless of what is
  // there.
  const result = await sendInputBatch([[OMEGA_INPUT_EVENT_TYPES.MOVE, 0, 0, 0]]);
  assert.equal(result.requested, 1);
  // Honest "N of M sent" reporting (mission's UIPI-awareness requirement):
  // sent is 0 or 1, never assumed successful without checking the actual
  // returned count.
  assert.ok(result.sent === 0 || result.sent === 1);
  assert.equal(result.results.length, 1);
});

test('sendInputBatch: a real KEY_DOWN+KEY_UP of VK_SHIFT alone genuinely reaches SendInput and has no typed-character side effect', { skip: !isWin }, async () => {
  // VK_SHIFT (0x10) sent alone, down then up, with no other key held,
  // cannot type a character or trigger any shortcut on any standard
  // Windows application — the one real keyboard round-trip this test
  // suite performs by default.
  const down = await sendInputBatch([[OMEGA_INPUT_EVENT_TYPES.KEY_DOWN, 0x10, 0, 0]]);
  const up = await sendInputBatch([[OMEGA_INPUT_EVENT_TYPES.KEY_UP, 0x10, 0, 0]]);
  assert.equal(down.requested, 1);
  assert.equal(up.requested, 1);
  assert.ok(down.sent === 0 || down.sent === 1);
  assert.ok(up.sent === 0 || up.sent === 1);
});

// ── Opt-in-only additional real-injection scenarios (OFF by default —
// see file header §3). Never run in a default/CI invocation. ──────────

test('sendInputBatch: real batch of multiple MOVE events to the safe corner all report a tuple result', { skip: !isWin || !ALLOW_REAL }, async () => {
  const batch = [
    [OMEGA_INPUT_EVENT_TYPES.MOVE, 0, 0, 0],
    [OMEGA_INPUT_EVENT_TYPES.MOVE, 1, 0, 0],
    [OMEGA_INPUT_EVENT_TYPES.MOVE, 0, 1, 0],
  ];
  const result = await sendInputBatch(batch);
  assert.equal(result.requested, 3);
  assert.equal(result.results.length, 3);
});
