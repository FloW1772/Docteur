// Unit tests for port-preflight.js — the single-instance startup guard for
// the Cortex backend's canonical port. Covers mission scenarios A-F:
//   A. port free -> server can proceed
//   B. port occupied by a recognized cortex-server -> refuse cleanly, no kill
//   C. port occupied by an unknown process -> refuse cleanly, no kill
//   D. EADDRINUSE at listen() time still exits non-zero (belt-and-suspenders
//      to the preflight check, exercised at the server.js level manually —
//      see CORTEX_PORT_3001_MAITRE_FIX_2026-09.md for the live validation)
//   E. no automatic fallback to a different port (grep-style static check)
//   F. no global-kill command anywhere in this module (grep-style static check)
// Run with: node --test test-port-preflight.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { isWindows } from './src/lib/maitre-windows-exec.js';
import { checkPortOwnership } from './src/lib/port-preflight.js';

const SCRATCH_PORT = 31741; // unlikely to collide with anything else on a dev box

function listenOnScratchPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(SCRATCH_PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ── A. Port free ─────────────────────────────────────────────────────────
test('checkPortOwnership: free port reports state "free"', { skip: !isWindows() }, async () => {
  const result = await checkPortOwnership('127.0.0.1', SCRATCH_PORT);
  assert.equal(result.state, 'free');
});

// ── C. Unknown process occupying the port ───────────────────────────────
test('checkPortOwnership: port held by an unrelated process reports "owned_by_unknown" with PID surfaced, never kills it', { skip: !isWindows() }, async () => {
  const srv = await listenOnScratchPort();
  try {
    const result = await checkPortOwnership('127.0.0.1', SCRATCH_PORT);
    assert.equal(result.state, 'owned_by_unknown');
    assert.equal(typeof result.pid, 'number');
    assert.ok(result.pid > 0);
    // The unrelated process must still be alive and still listening —
    // checkPortOwnership must never have attempted to stop it.
    const stillListening = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(true)); // EADDRINUSE => original still bound
      probe.once('listening', () => { probe.close(); resolve(false); });
      probe.listen(SCRATCH_PORT, '127.0.0.1');
    });
    assert.equal(stillListening, true, 'the unrelated process must still hold the port after the check');
  } finally {
    srv.close();
  }
});

// ── B. Recognized cortex-server occupying the port ──────────────────────
// This test's own Node process's command line is "node --test
// test-port-preflight.mjs", NOT src/server.js — so it exercises the
// negative arm here (mission's own "don't guess from process name alone").
// The positive arm (a real "node src/server.js" listener correctly
// classified as owned_by_cortex) was validated manually against a live
// cortex-server instance — see CORTEX_PORT_3001_MAITRE_FIX_2026-09.md.
test('checkPortOwnership: current test process (not src/server.js) is correctly classified as owned_by_unknown, not owned_by_cortex', { skip: !isWindows() }, async () => {
  const srv = await listenOnScratchPort();
  try {
    const result = await checkPortOwnership('127.0.0.1', SCRATCH_PORT);
    assert.notEqual(result.state, 'owned_by_cortex', 'a non-server.js Node process must never be misclassified as the Cortex backend');
  } finally {
    srv.close();
  }
});

// ── E. No automatic fallback to a different port ────────────────────────
test('static safety: port-preflight.js never references a fallback/alternate port', () => {
  const source = readFileSync(new URL('./src/lib/port-preflight.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /30(0[1-9]|1\d|2\d)\b/, 'must not hardcode a neighboring fallback port like 3002/3003');
  assert.doesNotMatch(source, /fallback.*port|port.*fallback/i);
});

test('static safety: server.js listen-error handling never falls back to a different port', () => {
  const source = readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
  const errorHandlerMatch = /httpServer\.on\('error'[\s\S]{0,600}/.exec(source);
  assert.ok(errorHandlerMatch, 'expected an httpServer error handler to exist');
  assert.doesNotMatch(errorHandlerMatch[0], /port:\s*env\.PORT\s*\+\s*1|port\+\+|3002|3003/);
});

// ── F. No global-kill command anywhere in this module ───────────────────
test('static safety: port-preflight.js contains no process-kill command of any kind', () => {
  const source = readFileSync(new URL('./src/lib/port-preflight.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /taskkill/i);
  assert.doesNotMatch(source, /Stop-Process/i);
  // Precise on actual kill APIs/commands, not the English word "kill" —
  // the file's own doc comments legitimately say "never kills anything".
  assert.doesNotMatch(source, /child_process\.kill|process\.kill\(|\bkill\s+-/);
  assert.doesNotMatch(source, /shell:\s*true/);
});

test('static safety: server.js single-instance guard block contains no kill command', () => {
  const source = readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
  const guardMatch = /Single-instance guard[\s\S]{0,1200}/.exec(source);
  assert.ok(guardMatch, 'expected the single-instance guard comment block to exist');
  assert.doesNotMatch(guardMatch[0], /taskkill/i);
  assert.doesNotMatch(guardMatch[0], /Stop-Process/i);
  assert.doesNotMatch(guardMatch[0], /\bkill\(/i);
});

// ── D. EADDRINUSE still exits non-zero (documented, exercised live) ─────
test('static safety: server.js EADDRINUSE handler always calls process.exit with a non-zero code', () => {
  const source = readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
  const handlerMatch = /httpServer\.on\('error'[\s\S]{0,600}/.exec(source);
  assert.ok(handlerMatch);
  assert.match(handlerMatch[0], /process\.exit\(1\)/);
  assert.doesNotMatch(handlerMatch[0], /process\.exit\(0\)/);
});
