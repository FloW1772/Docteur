// OMEGA V1 Phase 3 — screen capture mechanism tests (real PowerShell
// invocation on this Windows dev machine, per Phase 1/2's own testing
// discipline: "live smoke: user-owned device only and explicit" — this
// machine IS the user-owned device, so real capture is exercised here
// rather than mocked, proving the actual mechanism works end-to-end).
// Run with: node --test --test-timeout=20000 test-omega-capture.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import {
  listScreens, captureFrame, showSessionIndicator,
  MAX_FRAME_BYTES, MAX_SCREEN_DIMENSION, OmegaCaptureError,
} from './src/lib/omega-capture.js';

const isWin = process.platform === 'win32';

// ── Multi-monitor detection (mission rule 10) ───────────────────────

test('listScreens() enumerates at least one real screen with plausible bounds', { skip: !isWin }, async () => {
  const screens = await listScreens();
  assert.ok(Array.isArray(screens));
  assert.ok(screens.length >= 1);
  for (const s of screens) {
    assert.equal(typeof s.index, 'number');
    assert.equal(typeof s.primary, 'boolean');
    assert.ok(s.width > 0 && s.width <= MAX_SCREEN_DIMENSION);
    assert.ok(s.height > 0 && s.height <= MAX_SCREEN_DIMENSION);
  }
});

test('exactly one screen is reported primary', { skip: !isWin }, async () => {
  const screens = await listScreens();
  const primaries = screens.filter(s => s.primary);
  assert.equal(primaries.length, 1);
});

// ── Real screen capture (mission: "vue écran normale") ──────────────

test('captureFrame(0) returns a valid, non-empty, bounded PNG buffer', { skip: !isWin }, async () => {
  const frame = await captureFrame(0);
  assert.ok(Buffer.isBuffer(frame.buffer));
  assert.ok(frame.byteLength > 0);
  assert.ok(frame.byteLength <= MAX_FRAME_BYTES);
  assert.ok(frame.width > 0);
  assert.ok(frame.height > 0);
  // PNG magic bytes
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(frame.buffer.subarray(0, 8).equals(PNG_MAGIC));
});

test('captureFrame() does not leave a temp PNG file behind on success', { skip: !isWin }, async () => {
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()));
  await captureFrame(0);
  const tmpAfter = new Set(fs.readdirSync(os.tmpdir()));
  const leaked = [...tmpAfter].filter(f => f.startsWith('omega-frame-') && !tmpBefore.has(f));
  assert.equal(leaked.length, 0, `leaked temp frame files: ${leaked.join(', ')}`);
});

test('multi-monitor: capturing each detected screen returns a frame with matching resolution', { skip: !isWin }, async () => {
  const screens = await listScreens();
  for (const s of screens) {
    const frame = await captureFrame(s.index);
    assert.equal(frame.width, s.width);
    assert.equal(frame.height, s.height);
  }
});

// ── Bounds / malformed-input handling (mission: "frame malformée",
// "frame surdimensionnée") ──────────────────────────────────────────

test('captureFrame() rejects a negative screen index without ever invoking PowerShell', { skip: !isWin }, async () => {
  await assert.rejects(() => captureFrame(-1), (err) => err instanceof OmegaCaptureError && err.code === 'screen_index_invalid');
});

test('captureFrame() rejects a non-integer screen index', { skip: !isWin }, async () => {
  await assert.rejects(() => captureFrame(1.5), (err) => err instanceof OmegaCaptureError && err.code === 'screen_index_invalid');
});

test('captureFrame() rejects an out-of-range screen index (fails closed, not silently clamped)', { skip: !isWin }, async () => {
  // 50 passes the cheap 0..63 sanity bound in captureFrame() itself, so
  // this exercises the PowerShell script's OWN out-of-range check
  // (screen_index_out_of_range from omega-capture.ps1) rather than the
  // Node-side pre-check — a genuinely different failure path.
  await assert.rejects(() => captureFrame(50), (err) => err instanceof OmegaCaptureError && err.code === 'capture_failed');
});

test('captureFrame() rejects a screen index above the 0..63 sanity ceiling before ever invoking PowerShell', { skip: !isWin }, async () => {
  await assert.rejects(() => captureFrame(999), (err) => err instanceof OmegaCaptureError && err.code === 'screen_index_invalid');
});

test('listScreens()/captureFrame() throw a clean error on a non-Windows platform rather than crashing', { skip: isWin }, async () => {
  await assert.rejects(() => listScreens(), (err) => err instanceof OmegaCaptureError && err.code === 'capture_not_supported');
  await assert.rejects(() => captureFrame(0), (err) => err instanceof OmegaCaptureError && err.code === 'capture_not_supported');
});

// ── Visible session indicator (mission rule 12) ─────────────────────

test('showSessionIndicator() accepts only the closed "start"|"stop" enum', { skip: !isWin }, async () => {
  await assert.rejects(() => showSessionIndicator('anything-else'), /indicator_kind_invalid/);
  await assert.rejects(() => showSessionIndicator('<script>alert(1)</script>'), /indicator_kind_invalid/);
});

test('showSessionIndicator("start") creates a persistent indicator and STOP removes it', { skip: !isWin }, async () => {
  const sessionId = 'capture-indicator-test-session';
  const result = await showSessionIndicator('start', sessionId, 'capture-indicator-test-device', new Date(Date.now() + 30_000).toISOString());
  assert.equal(result.ok, true);
  assert.equal(result.persistent, true);
  const stopped = await showSessionIndicator('stop', sessionId, 'capture-indicator-test-device');
  assert.equal(stopped.ok, true);
});
