// ROOT POLICY V1 — integration at the wired choke points: cloud AI (single guard + Groq STT + image providers), Web Egress hook, external agents.
// Run: node --test test-root-policy-integration.mjs
//
// Uses an isolated throw-away database (never the real one) and fake transports: no cloud call, no network, no process is ever started.
import './test-setup.mjs';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase, initSqlite, setRouterSettings } from './src/lib/sqlite.js';
import { guardCloudCall, markPrivate, PrivacyViolationError } from './src/lib/privacy-guard.js';
import { transcribeWithGroq } from './src/lib/whisper-groq.js';
import { safeFetch, setEgressPolicyHook } from './src/lib/web-egress-guard.js';
import { launchProcess } from './src/lib/external-agent-process.js';
import { currentActorContext, getRootPolicyStatus, initRootPolicy, runWithActor, webFetchHook } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REAL = path.join(HERE, 'policy');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-rp-int-'));
const useValid = () => initRootPolicy({ policyDir: REAL, trustAnchors: TRUST_ANCHORS });
const useBroken = () => initRootPolicy({ policyDir: path.join(scratch, 'none'), trustAnchors: TRUST_ANCHORS });

before(() => { initSqlite(path.join(scratch, 'test.db')); useValid(); });
after(() => { setEgressPolicyHook(null); useValid(); getDatabase()?.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => { useValid(); setRouterSettings({ strict_local_mode: false, cloud_enabled: true }); });

const msg = (text) => [{ role: 'user', content: text }];
const rejection = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('fresh install is Strict Local and cloud is disabled until the user explicitly opts in', () => {
  const sqliteUrl = new URL('./src/lib/sqlite.js', import.meta.url).href;
  const dbPath = path.join(scratch, 'production-defaults.db');
  const source = `import { getDatabase, getRouterSettings, initSqlite } from ${JSON.stringify(sqliteUrl)}; initSqlite(${JSON.stringify(dbPath)}); console.log(JSON.stringify(getRouterSettings())); getDatabase().close();`;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, DOCTEUR_TEST_MODE: '0' }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const settings = JSON.parse(probe.stdout);
  assert.equal(settings.strict_local_mode, true);
  assert.equal(settings.cloud_enabled, false);
});

describe('AI CLOUD — single choke point (guardCloudCall)', () => {
  test('cloud explicitly enabled + normal prompt ⇒ allowed (cloud AI stays usable); prose about keys is not censored', () => {
    assert.equal(rejection(() => guardCloudCall({ messages: msg('Explique la différence entre une clé API et un jeton OAuth.'), provider: 'openai', functionCalled: 'complete' })), null);
    assert.equal(rejection(() => guardCloudCall({ messages: msg('Code: const headers = { Authorization: `Bearer ${token}` };'), provider: 'gemini', functionCalled: 'complete' })), null);
  });

  test('strict local ON ⇒ DENY_STRICT_LOCAL (rule 1); cloud switched off ⇒ DENY_CLOUD_NOT_ENABLED', () => {
    setRouterSettings({ strict_local_mode: true });
    assert.equal(rejection(() => guardCloudCall({ messages: msg('bonjour'), provider: 'openai', functionCalled: 'complete' }))?.decisionCode, 'DENY_STRICT_LOCAL');
    setRouterSettings({ strict_local_mode: false, cloud_enabled: false });
    assert.equal(rejection(() => guardCloudCall({ messages: msg('bonjour'), provider: 'groq', functionCalled: 'complete' }))?.decisionCode, 'DENY_CLOUD_NOT_ENABLED');
  });

  test('a credential inside the payload ⇒ DENY_SECRET_EXPOSURE (rule 2) for every provider id; the exception carries no payload', () => {
    for (const provider of ['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'freellmapi', 'claude-oauth', 'codex']) {
      const e = rejection(() => guardCloudCall({ messages: msg(`ma config: OPENAI_API_KEY=sk-${'a1B2c3D4'.repeat(5)}`), provider, functionCalled: 'complete' }));
      assert.equal(e?.decisionCode, 'DENY_SECRET_EXPOSURE', provider);
      assert.ok(!JSON.stringify({ message: e.message, ...e }).includes('a1B2c3D4'), 'no secret in the error');
    }
  });

  test('private content keeps its own, earlier, certified block (PrivacyViolationError) — Root Policy adds, never replaces', () => {
    const e = rejection(() => guardCloudCall({ messages: msg(markPrivate('dossier')), provider: 'openai', functionCalled: 'complete' }));
    assert.ok(e instanceof PrivacyViolationError);
  });

  test('untrusted / missing policy ⇒ cloud AI fails closed (protected operation), local AI is untouched by this module', () => {
    useBroken();
    assert.equal(getRootPolicyStatus().state, 'INVALID');
    assert.equal(rejection(() => guardCloudCall({ messages: msg('bonjour'), provider: 'openai', functionCalled: 'complete' }))?.decisionCode, 'DENY_POLICY_INVALID');
    assert.equal(rejection(() => guardCloudCall({ messages: msg('bonjour'), provider: 'openai', functionCalled: 'complete', simulate: true })), null, 'the synthetic self-test never reaches a provider');
  });

  test('Groq speech-to-text (audio leaves the machine) is gated before the file is even read', async () => {
    setRouterSettings({ strict_local_mode: true });
    await assert.rejects(() => transcribeWithGroq(path.join(scratch, 'missing.wav'), 'k'), (e) => e.decisionCode === 'DENY_STRICT_LOCAL');
    useBroken(); setRouterSettings({ strict_local_mode: false });
    await assert.rejects(() => transcribeWithGroq(path.join(scratch, 'missing.wav'), 'k'), (e) => e.decisionCode === 'DENY_POLICY_INVALID');
  });
});

describe('WEB — Root Policy asks "may this be attempted?", the Web Egress Guard asks "is this destination safe?"', () => {
  test('hook installed + valid policy: the destination decision still belongs to the guard (loopback ⇒ BLOCKED_LOOPBACK)', async () => {
    setEgressPolicyHook(webFetchHook);
    await assert.rejects(() => safeFetch('http://127.0.0.1/'), (e) => e.code === 'BLOCKED_LOOPBACK');
    await assert.rejects(() => safeFetch('http://[::ffff:127.0.0.1]/'), (e) => e.code === 'BLOCKED_LOOPBACK');
  });

  test('invalid policy: WEB_FETCH is refused BEFORE any destination logic or network (BLOCKED_ROOT_POLICY); a throwing hook also fails closed', async () => {
    useBroken(); setEgressPolicyHook(webFetchHook);
    await assert.rejects(() => safeFetch('https://example.com/'), (e) => e.code === 'BLOCKED_ROOT_POLICY');
    setEgressPolicyHook(() => { throw new Error('hook bug'); });
    await assert.rejects(() => safeFetch('https://example.com/'), (e) => e.code === 'BLOCKED_ROOT_POLICY');
    setEgressPolicyHook(null);
  });

  test('actor context: a document / remote origin cannot trigger a fetch (DENY_ACTOR_NOT_PERMITTED), a user request or module can', () => {
    const decide = (kind) => runWithActor({ kind, userInitiated: kind === 'USER' }, () => webFetchHook({ surface: 'safeFetch' }));
    assert.equal(decide('USER'), null); assert.equal(decide('MODULE'), null);
    assert.equal(decide('DOCUMENT')?.code, 'DENY_ACTOR_NOT_PERMITTED'); assert.equal(decide('REMOTE')?.code, 'DENY_ACTOR_NOT_PERMITTED');
    assert.equal(currentActorContext(), null, 'no ambient actor leaks outside runWithActor');
  });
});

describe('EXTERNAL AGENTS — PROCESS_START is a typed, known-executor action (no arbitrary command)', () => {
  const fakeSpawn = (calls) => (command, args) => {
    calls.push({ command, args });
    const { EventEmitter } = require_('node:events'); const { PassThrough } = require_('node:stream');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.pid = 4242;
    child.kill = () => true; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); });
    return child;
  };

  test('valid policy: the certified launcher still starts (no behaviour change)', async () => {
    const calls = [];
    const { done } = launchProcess({ executable: { command: 'claude.exe', prefix: [] }, args: ['-p', 'hello'], cwd: scratch, spawnImpl: fakeSpawn(calls), timeout: 5000 });
    await done; assert.equal(calls.length, 1); assert.equal(calls[0].command, 'claude.exe');
  });

  test('invalid policy: the launcher refuses BEFORE spawning anything (fail closed)', () => {
    useBroken(); const calls = [];
    assert.throws(() => launchProcess({ executable: { command: 'claude.exe', prefix: [] }, args: ['-p', 'hello'], cwd: scratch, spawnImpl: fakeSpawn(calls) }), (e) => e.decisionCode === 'DENY_POLICY_INVALID');
    assert.equal(calls.length, 0);
  });
});

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
