import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNodeEntrypoint, planSafeSpawn as planSafeSpawnCodex, codexProvider } from './src/lib/providers/codex.js';
import { resolveNativeEntrypoint, planSafeSpawn as planSafeSpawnClaude, claudeOAuthProvider } from './src/lib/providers/claude-oauth.js';

// These tests build synthetic .cmd shim fixtures rather than depending on
// whatever CLI happens to be installed on the CI/dev machine — isolated and
// deterministic either way.

test('resolveNodeEntrypoint: extracts the real node_modules/.../bin/*.js path from an npm .cmd shim', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-cmd-shim-'));
  const pkgDir = path.join(tmpDir, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(pkgDir, { recursive: true });
  const entryJs = path.join(pkgDir, 'codex.js');
  fs.writeFileSync(entryJs, '// fake entry');
  const shimPath = path.join(tmpDir, 'codex.cmd');
  fs.writeFileSync(shimPath, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%\\node.exe"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n'));

  const resolved = resolveNodeEntrypoint(shimPath);
  assert.ok(resolved, 'must resolve a .cmd shim pointing at a real .js entry');
  assert.equal(resolved.command, process.execPath);
  assert.equal(path.resolve(resolved.prefixArgs[0]), path.resolve(entryJs));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('resolveNodeEntrypoint: returns null for a non-.cmd path (falls back to shell:true path)', () => {
  assert.equal(resolveNodeEntrypoint('/usr/local/bin/codex'), null);
  assert.equal(resolveNodeEntrypoint('C:\\some\\path\\codex.exe'), null);
});

test('resolveNodeEntrypoint: returns null when the shim references a script that does not exist on disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-cmd-shim-missing-'));
  const shimPath = path.join(tmpDir, 'codex.cmd');
  fs.writeFileSync(shimPath, '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
  assert.equal(resolveNodeEntrypoint(shimPath), null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('resolveNativeEntrypoint: extracts the real .exe path from an npm .cmd shim', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-cmd-shim-native-'));
  const pkgDir = path.join(tmpDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  fs.mkdirSync(pkgDir, { recursive: true });
  const entryExe = path.join(pkgDir, 'claude.exe');
  fs.writeFileSync(entryExe, 'fake binary');
  const shimPath = path.join(tmpDir, 'claude.cmd');
  fs.writeFileSync(shimPath, [
    '@ECHO off',
    'GOTO start',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ].join('\r\n'));

  const resolved = resolveNativeEntrypoint(shimPath);
  assert.ok(resolved);
  assert.equal(path.resolve(resolved), path.resolve(entryExe));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('resolveNativeEntrypoint: returns null for a non-.cmd path or unresolvable shim', () => {
  assert.equal(resolveNativeEntrypoint('/usr/local/bin/claude'), null);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-cmd-shim-bad-'));
  const shimPath = path.join(tmpDir, 'claude.cmd');
  fs.writeFileSync(shimPath, '@ECHO off\r\necho no useful path here\r\n');
  assert.equal(resolveNativeEntrypoint(shimPath), null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Live, opt-in only: actually resolve THIS machine's real installed CLI shim
// (if any) and confirm the extracted path exists — read-only, no spawn.
test('resolveNodeEntrypoint / resolveNativeEntrypoint: resolve this machine\'s real installed CLI shims, if present (informational, never fails the suite)', () => {
  if (process.env.DOCTEUR_LIVE_TESTS !== '1') {
    return; // skip by default — this is an environment-dependent sanity check, not a hard requirement
  }
  const npmDir = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
  const codexShim = path.join(npmDir, 'codex.cmd');
  const claudeShim = path.join(npmDir, 'claude.cmd');
  if (fs.existsSync(codexShim)) {
    const resolved = resolveNodeEntrypoint(codexShim);
    console.log('codex.cmd resolved to:', resolved);
  }
  if (fs.existsSync(claudeShim)) {
    const resolved = resolveNativeEntrypoint(claudeShim);
    console.log('claude.cmd resolved to:', resolved);
  }
});

// ── Fail-closed behavior: an unresolvable .cmd shim must NEVER fall back to
// shell:true — it must be treated as SAFE_CLI_ENTRYPOINT_NOT_RESOLVED and the
// call blocked outright. This is the P2-A/P3 hardening on top of the earlier
// resolution work: a non-.cmd path is always 'direct' (shell:false, always
// was safe); a .cmd path is either 'resolved' (shim parsed) or a hard null
// that the provider must refuse to spawn under a shell for.

test('planSafeSpawn (codex): a non-.cmd path is always mode "direct" (shell:false, never needed a shell)', () => {
  const plan = planSafeSpawnCodex('/usr/local/bin/codex');
  assert.deepEqual(plan, { mode: 'direct', command: '/usr/local/bin/codex', prefixArgs: [] });
});

test('planSafeSpawn (codex): a parseable .cmd shim resolves to mode "resolved"', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-plan-safe-spawn-'));
  const pkgDir = path.join(tmpDir, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'codex.js'), '// fake entry');
  const shimPath = path.join(tmpDir, 'codex.cmd');
  fs.writeFileSync(shimPath, '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');

  const plan = planSafeSpawnCodex(shimPath);
  assert.ok(plan);
  assert.equal(plan.mode, 'resolved');
  assert.equal(plan.command, process.execPath);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('planSafeSpawn (codex): an unparseable .cmd shim returns null — the caller must fail closed, never shell:true', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-plan-safe-spawn-bad-'));
  const shimPath = path.join(tmpDir, 'codex.cmd');
  fs.writeFileSync(shimPath, '@ECHO off\r\necho this shim has no recognizable entry point\r\n');
  assert.equal(planSafeSpawnCodex(shimPath), null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('planSafeSpawn (claude): a non-.cmd path is always mode "direct"', () => {
  const plan = planSafeSpawnClaude('/usr/local/bin/claude');
  assert.deepEqual(plan, { mode: 'direct', command: '/usr/local/bin/claude' });
});

test('planSafeSpawn (claude): an unparseable .cmd shim returns null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-plan-safe-spawn-claude-bad-'));
  const shimPath = path.join(tmpDir, 'claude.cmd');
  fs.writeFileSync(shimPath, '@ECHO off\r\necho no useful path here\r\n');
  assert.equal(planSafeSpawnClaude(shimPath), null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('codexProvider.testConnection(): an unresolvable .cmd shim returns ok:false with SAFE_CLI_ENTRYPOINT_NOT_RESOLVED, never attempts shell:true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-codex-unresolvable-'));
  const shimPath = path.join(tmpDir, 'codex.cmd');
  fs.writeFileSync(shimPath, '@ECHO off\r\necho unresolvable\r\n');

  const originalAuthenticated = codexProvider.isAuthenticated;
  const originalCliPath = codexProvider._cliPath;
  const originalLiveTests = process.env.DOCTEUR_LIVE_TESTS;
  codexProvider.isAuthenticated = async () => true;
  codexProvider._cliPath = shimPath;
  // Bypass only the test-mode egress guard (assertLiveCallAllowed) so we can
  // reach the fail-closed check below it — planSafeSpawn() returning null
  // means the function returns/throws before any spawn is ever attempted, so
  // this is still 100% safe: no real CLI process starts either way.
  process.env.DOCTEUR_LIVE_TESTS = '1';
  try {
    const result = await codexProvider.testConnection();
    assert.equal(result.ok, false);
    assert.match(result.error, /SAFE_CLI_ENTRYPOINT_NOT_RESOLVED/);
  } finally {
    codexProvider.isAuthenticated = originalAuthenticated;
    codexProvider._cliPath = originalCliPath;
    process.env.DOCTEUR_LIVE_TESTS = originalLiveTests;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('codexProvider.generate(): an unresolvable .cmd shim throws SAFE_CLI_ENTRYPOINT_NOT_RESOLVED, never attempts shell:true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-codex-unresolvable-generate-'));
  const shimPath = path.join(tmpDir, 'codex.cmd');
  fs.writeFileSync(shimPath, '@ECHO off\r\necho unresolvable\r\n');

  const originalAuthenticated = codexProvider.isAuthenticated;
  const originalCliPath = codexProvider._cliPath;
  const originalLiveTests = process.env.DOCTEUR_LIVE_TESTS;
  codexProvider.isAuthenticated = async () => true;
  codexProvider._cliPath = shimPath;
  process.env.DOCTEUR_LIVE_TESTS = '1';
  try {
    await assert.rejects(
      codexProvider.generate({ messages: [{ role: 'user', content: 'hi' }] }),
      /SAFE_CLI_ENTRYPOINT_NOT_RESOLVED/,
    );
  } finally {
    codexProvider.isAuthenticated = originalAuthenticated;
    codexProvider._cliPath = originalCliPath;
    process.env.DOCTEUR_LIVE_TESTS = originalLiveTests;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('claudeOAuthProvider.testConnection(): an unresolvable .cmd shim returns ok:false with SAFE_CLI_ENTRYPOINT_NOT_RESOLVED', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-claude-unresolvable-'));
  const shimPath = path.join(tmpDir, 'claude.cmd');
  fs.writeFileSync(shimPath, '@ECHO off\r\necho unresolvable\r\n');

  const originalGetAuthMode = claudeOAuthProvider.getAuthMode;
  const originalCliPath = claudeOAuthProvider._cliPath;
  const originalLiveTests = process.env.DOCTEUR_LIVE_TESTS;
  claudeOAuthProvider.getAuthMode = async () => 'cli_session';
  claudeOAuthProvider._cliPath = shimPath;
  process.env.DOCTEUR_LIVE_TESTS = '1';
  try {
    const result = await claudeOAuthProvider.testConnection();
    assert.equal(result.ok, false);
    assert.match(result.error, /SAFE_CLI_ENTRYPOINT_NOT_RESOLVED/);
  } finally {
    claudeOAuthProvider.getAuthMode = originalGetAuthMode;
    claudeOAuthProvider._cliPath = originalCliPath;
    process.env.DOCTEUR_LIVE_TESTS = originalLiveTests;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('claudeOAuthProvider.generate(): an unresolvable .cmd shim throws SAFE_CLI_ENTRYPOINT_NOT_RESOLVED', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-claude-unresolvable-generate-'));
  const shimPath = path.join(tmpDir, 'claude.cmd');
  fs.writeFileSync(shimPath, '@ECHO off\r\necho unresolvable\r\n');

  const originalGetAuthMode = claudeOAuthProvider.getAuthMode;
  const originalCliPath = claudeOAuthProvider._cliPath;
  const originalLiveTests = process.env.DOCTEUR_LIVE_TESTS;
  claudeOAuthProvider.getAuthMode = async () => 'cli_session';
  claudeOAuthProvider._cliPath = shimPath;
  process.env.DOCTEUR_LIVE_TESTS = '1';
  try {
    await assert.rejects(
      claudeOAuthProvider.generate({ messages: [{ role: 'user', content: 'hi' }] }),
      /SAFE_CLI_ENTRYPOINT_NOT_RESOLVED/,
    );
  } finally {
    claudeOAuthProvider.getAuthMode = originalGetAuthMode;
    claudeOAuthProvider._cliPath = originalCliPath;
    process.env.DOCTEUR_LIVE_TESTS = originalLiveTests;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
