import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixedPowerShellScript, isWindows } from './omega-windows-exec.js';
import { OMEGA_INPUT_EVENT_TYPES, validateInputEvent, sendInputBatch } from './omega-input.js';

const MIDDLE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'omega-outbound-middle-input.ps1');

export const OMEGA_OUTBOUND_KEYS = Object.freeze({
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46, KeyG: 0x47,
  KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4A, KeyK: 0x4B, KeyL: 0x4C, KeyM: 0x4D, KeyN: 0x4E,
  KeyO: 0x4F, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52, KeyS: 0x53, KeyT: 0x54, KeyU: 0x55,
  KeyV: 0x56, KeyW: 0x57, KeyX: 0x58, KeyY: 0x59, KeyZ: 0x5A,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  Space: 0x20, Tab: 0x09, Enter: 0x0D, Backspace: 0x08, Delete: 0x2E, Insert: 0x2D,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3,
  AltLeft: 0xA4, AltRight: 0xA5, MetaLeft: 0x5B, MetaRight: 0x5C,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE,
  Slash: 0xBF, Backquote: 0xC0, BracketLeft: 0xDB, Backslash: 0xDC,
  BracketRight: 0xDD, Quote: 0xDE,
});

// Escape is deliberately absent: it is the controller's local INTERACTIVE stop
// and must never be transmitted to the remote host.
export const POINTER_BUTTONS = Object.freeze(['LEFT', 'RIGHT', 'MIDDLE']);
export const INPUT_STATES = Object.freeze(['DOWN', 'UP']);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function plainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INPUT_INVALID');
}

function normalizedPoint(input, screen) {
  const x = input.x;
  const y = input.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || y < 0 || x >= 1 || y >= 1) fail('POINTER_OUT_OF_BOUNDS');
  return { x: Math.min(screen.width - 1, Math.floor(x * screen.width)),
    y: Math.min(screen.height - 1, Math.floor(y * screen.height)) };
}

export function validateSemanticInput(category, input, { screens, screenIndex }) {
  if (!Array.isArray(screens) || !screens[screenIndex]) fail('SCREEN_INDEX_INVALID');
  const screen = screens[screenIndex];
  if (!Number.isInteger(screen.width) || !Number.isInteger(screen.height) || screen.width < 1 || screen.height < 1) fail('SCREEN_BOUNDS_UNAVAILABLE');
  if (category === 'pointer') {
    exactKeys(input, ['operationId', 'streamId', 'screenIndex', 'x', 'y']);
    const point = normalizedPoint(input, screen);
    return { category, tuple: validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, ...point }, { screens, screenIndex }) };
  }
  if (category === 'button') {
    exactKeys(input, ['operationId', 'streamId', 'screenIndex', 'button', 'state', 'x', 'y']);
    if (!POINTER_BUTTONS.includes(input.button) || !INPUT_STATES.includes(input.state)) fail('BUTTON_INVALID');
    const point = normalizedPoint(input, screen);
    if (input.button === 'MIDDLE') {
      const move = validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, ...point }, { screens, screenIndex });
      return { category, middle: true, button: input.button, state: input.state, x: move[1], y: move[2] };
    }
    const type = OMEGA_INPUT_EVENT_TYPES[`${input.button}_${input.state}`];
    return { category, button: input.button, state: input.state,
      tuple: validateInputEvent({ type, ...point }, { screens, screenIndex }) };
  }
  if (category === 'wheel') {
    exactKeys(input, ['operationId', 'streamId', 'screenIndex', 'delta', 'x', 'y']);
    if (!Number.isInteger(input.delta) || input.delta === 0 || input.delta < -3 || input.delta > 3) fail('WHEEL_DELTA_INVALID');
    const point = normalizedPoint(input, screen);
    return { category, tuple: validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.WHEEL, wheelDelta: input.delta, ...point }, { screens, screenIndex }) };
  }
  if (category === 'key') {
    exactKeys(input, ['operationId', 'streamId', 'screenIndex', 'key', 'state']);
    if (!Object.hasOwn(OMEGA_OUTBOUND_KEYS, input.key) || !INPUT_STATES.includes(input.state)) fail('KEY_INVALID');
    const vk = OMEGA_OUTBOUND_KEYS[input.key];
    const type = input.state === 'DOWN' ? OMEGA_INPUT_EVENT_TYPES.KEY_DOWN : OMEGA_INPUT_EVENT_TYPES.KEY_UP;
    return { category, key: input.key, state: input.state,
      tuple: validateInputEvent({ type, vk }, { screens, screenIndex }) };
  }
  fail('INPUT_CATEGORY_INVALID');
}

async function sendMiddle(prepared) {
  if (!isWindows()) fail('INPUT_NOT_SUPPORTED');
  const result = await runFixedPowerShellScript(MIDDLE_SCRIPT,
    [prepared.state === 'DOWN' ? '1' : '2', String(prepared.x), String(prepared.y)], { timeoutMs: 4_000 });
  if (!result.ok) return { requested: 1, sent: 0, results: [{ ok: false, reason: result.reason }] };
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return { requested: 1, sent: parsed.ok && parsed.sent > 0 ? 1 : 0, results: [parsed] };
  } catch { return { requested: 1, sent: 0, results: [{ ok: false, reason: 'malformed_output' }] }; }
}

export async function executeSemanticInput(prepared) {
  return prepared.middle ? sendMiddle(prepared) : sendInputBatch([prepared.tuple]);
}

export async function releaseSemanticInput(kind, value, screens, screenIndex, heldPrepared) {
  if (kind === 'key') return executeSemanticInput(validateSemanticInput('key', {
    operationId: 'release', streamId: 'release', screenIndex, key: value, state: 'UP',
  }, { screens, screenIndex }));
  if (heldPrepared?.middle) return executeSemanticInput({ ...heldPrepared, state: 'UP' });
  if (heldPrepared?.tuple) {
    const type = value === 'LEFT' ? OMEGA_INPUT_EVENT_TYPES.LEFT_UP : OMEGA_INPUT_EVENT_TYPES.RIGHT_UP;
    return executeSemanticInput({ ...heldPrepared, state: 'UP', tuple: [type, heldPrepared.tuple[1], heldPrepared.tuple[2], 0] });
  }
  const screen = screens[screenIndex];
  return executeSemanticInput(validateSemanticInput('button', {
    operationId: 'release', streamId: 'release', screenIndex, button: value, state: 'UP',
    x: 0.5 / screen.width, y: 0.5 / screen.height,
  }, { screens, screenIndex }));
}

export { MIDDLE_SCRIPT };
