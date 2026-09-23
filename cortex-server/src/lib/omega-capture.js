/**
 * OMEGA V1 Phase 3 — screen capture (VIEW ONLY).
 *
 * Windows screen-capture mechanism (pre-decided by the mission, not
 * re-derived here): PowerShell + System.Windows.Forms/System.Drawing,
 * invoked via the OMEGA-owned runFixedPowerShellScript() helper
 * (omega-windows-exec.js), which mirrors maitre-windows-exec.js's exact
 * safe-process-execution discipline. Zero new npm dependency.
 *
 * Flow per frame:
 *   1. Node picks a fresh temp PNG path (crypto-random name, OS temp dir
 *      it owns).
 *   2. Runs the fixed omega-capture.ps1 script with two numeric args:
 *      screenIndex, outputPath.
 *   3. The script does Add-Type → Screen.AllScreens[index].Bounds →
 *      Graphics.CopyFromScreen → Bitmap.Save(PNG) → prints a small JSON
 *      status line to stdout.
 *   4. Node reads the PNG file into a Buffer, deletes the temp file
 *      (always, even on error — try/finally), and returns the buffer.
 *
 * Streaming bounds (mission rule 9), enforced HERE, not just at the
 * route layer:
 *   - MAX_FRAME_BYTES: a captured PNG larger than this is rejected
 *     rather than ever handed to a route (an oversized/resource-
 *     exhaustion frame fails closed, never truncated-and-sent).
 *   - CAPTURE_TIMEOUT_MS: the PowerShell invocation itself is bounded
 *     (via runFixedPowerShellScript's execFile timeout) — a hung
 *     capture cannot block a session indefinitely.
 *   - Resolution is whatever the selected physical screen's Bounds are
 *     (no artificial downscale in V1) but is always reported back to
 *     the caller so a resolution CHANGE (user changed display mode
 *     mid-session) is detectable and surfaced, never silently ignored.
 *
 * Backpressure (mission rule 9): capture is pull-based by construction —
 * Node only invokes the next PowerShell capture after the previous one's
 * promise has resolved and the resulting frame has been consumed by the
 * route handler. There is no independent producer loop pushing frames
 * into an unbounded queue; the "producer" (capture) and "consumer"
 * (HTTP response) are the same call stack for the polling transport
 * (see omega-view.js), so backpressure is structural, not a separate
 * stream-controller mechanism bolted on top.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWindows, runFixedPowerShellScript } from './omega-windows-exec.js';
import { startPersistentIndicator, stopPersistentIndicator, INDICATOR_SCRIPT_PATH as PERSISTENT_INDICATOR_SCRIPT_PATH } from './omega-indicator.js';

const SCRIPT_PATH = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'omega-capture.ps1');
const INDICATOR_SCRIPT_PATH = PERSISTENT_INDICATOR_SCRIPT_PATH;

// ── Streaming bounds (mission rule 9) ───────────────────────────────
export const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MB — generous for a single 4K PNG screenshot, still bounded
export const MAX_FPS = 5; // V1 is a polling/pull transport, not a live video feed — 5 fps is a deliberately conservative ceiling
export const MIN_FRAME_INTERVAL_MS = Math.ceil(1000 / MAX_FPS);
export const CAPTURE_TIMEOUT_MS = 5_000;
export const MAX_SCREEN_DIMENSION = 7680; // bounds against a pathological/spoofed Bounds value (8K width ceiling)

export class OmegaCaptureError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'OmegaCaptureError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new OmegaCaptureError(code, detail);
}

function freshTempPngPath() {
  const name = `omega-frame-${crypto.randomBytes(12).toString('hex')}.png`;
  return path.join(os.tmpdir(), name);
}

/**
 * Lists available monitors (mission rule 10 — detect, then require
 * explicit selection; never capture all screens silently). Returns
 * [{ index, primary, x, y, width, height, device }].
 */
export async function listScreens() {
  if (!isWindows()) fail('capture_not_supported', { platform: process.platform });

  const result = await runFixedPowerShellScript(SCRIPT_PATH, ['list', 'unused'], { timeoutMs: CAPTURE_TIMEOUT_MS });
  if (!result.ok) fail('screen_enumeration_failed', { reason: result.reason, detail: result.detail });

  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { fail('screen_enumeration_malformed_output'); }
  if (!parsed.ok || !Array.isArray(parsed.screens)) fail('screen_enumeration_malformed_output');

  return parsed.screens;
}

/**
 * Captures exactly ONE frame from the explicitly-selected screenIndex.
 * Returns { buffer, width, height, capturedAt, byteLength }. Throws
 * OmegaCaptureError (fails closed) on any malformed/oversized/failed
 * capture — never returns a partial or truncated frame.
 */
export async function captureFrame(screenIndex) {
  if (!isWindows()) fail('capture_not_supported', { platform: process.platform });
  if (!Number.isInteger(screenIndex) || screenIndex < 0 || screenIndex > 63) {
    fail('screen_index_invalid', { screenIndex });
  }

  const outputPath = freshTempPngPath();
  try {
    const result = await runFixedPowerShellScript(SCRIPT_PATH, [String(screenIndex), outputPath], { timeoutMs: CAPTURE_TIMEOUT_MS });
    if (!result.ok) fail('capture_failed', { reason: result.reason, detail: result.detail });

    let parsed;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { fail('capture_malformed_output'); }
    if (!parsed.ok) fail('capture_failed', { reason: parsed.reason ?? 'unknown' });

    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)
      || parsed.width <= 0 || parsed.height <= 0
      || parsed.width > MAX_SCREEN_DIMENSION || parsed.height > MAX_SCREEN_DIMENSION) {
      fail('capture_resolution_invalid', { width: parsed.width, height: parsed.height });
    }

    let stat;
    try { stat = fs.statSync(outputPath); } catch { fail('capture_file_missing'); }
    if (stat.size === 0) fail('capture_file_empty');
    if (stat.size > MAX_FRAME_BYTES) fail('capture_frame_too_large', { size: stat.size, max: MAX_FRAME_BYTES });

    const buffer = fs.readFileSync(outputPath);
    // PNG magic-byte sanity check — defends against a corrupted/partial
    // write being forwarded downstream as if it were a valid frame
    // (mission's "frame malformée" test scenario).
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
      fail('capture_frame_malformed');
    }

    return {
      buffer,
      width: parsed.width,
      height: parsed.height,
      byteLength: buffer.length,
      capturedAt: new Date().toISOString(),
    };
  } finally {
    // Always clean up the temp file, success or failure — never leave
    // screen-content PNGs lying around in the OS temp dir.
    try { fs.unlinkSync(outputPath); } catch { /* already gone / never created */ }
  }
}

// Closed enum of indicator states (Phase 3 VIEW + Phase 4 INTERACTIVE —
// see omega-indicator.ps1's own header comment for the exact mapping).
// Parameterized via a fixed enum rather than free text, per the mission's
// own guidance for this phase's indicator requirement.
const INDICATOR_KINDS = new Set(['start', 'stop', 'interactive_start', 'interactive_stop', 'admin_start', 'admin_stop']);

/**
 * Shows the mandatory visible session indicator (mission rule 12/14) on
 * THIS machine (the one being captured/controlled). Fire-and-forget from
 * the caller's perspective (route handlers don't block the HTTP response
 * on this), but awaited internally so a genuine failure is observable in
 * tests/logs rather than silently swallowed. `kind` is a closed enum:
 * 'start' | 'stop' | 'interactive_start' | 'interactive_stop'.
 */
export async function showSessionIndicator(kind, sessionId, deviceId, expiresAt, onLocalStop) {
  if (!INDICATOR_KINDS.has(kind)) fail('indicator_kind_invalid', { kind });
  if (!isWindows()) return { ok: false, reason: 'not_windows' };
  if (!sessionId) return { ok: false, persistent: false, reason: 'session_id_required' };
  if (kind === 'start') {
    return startPersistentIndicator({ sessionId, deviceId, mode: 'view', expiresAt, onLocalStop });
  }
  if (kind === 'interactive_start') {
    return startPersistentIndicator({ sessionId, deviceId, mode: 'interactive', expiresAt, onLocalStop });
  }
  if (kind === 'admin_start') {
    return startPersistentIndicator({ sessionId, deviceId, mode: 'admin', expiresAt, onLocalStop });
  }
  const mode = kind === 'stop' ? null : kind === 'interactive_stop' ? 'interactive' : 'admin';
  return { ok: stopPersistentIndicator(sessionId, mode), persistent: true, stopped: true };
}

export { SCRIPT_PATH, INDICATOR_SCRIPT_PATH };
