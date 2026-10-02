// ROOT POLICY V1 CLOSURE — RPC-2C: the Policy V2 CANDIDATE. Nothing here installs, signs with a real key, boots on, or wires anything.
//   • the candidate is built in memory / a temporary directory and loaded ONLY into throw-away engines;
//   • the REAL forms the current Browser / Kiwix / ComfyUI callsites produce (captured through their own functions, with spawn replaced by a
//     recorder — no process is ever started) must be ALLOWED by the candidate, and forged ones DENIED;
//   • V1 behaviour and every other module must be identical under V2;
//   • the human signing ceremony is rehearsed ONLY with a throw-away key in a temporary directory (the real key is never read).
import './test-setup.mjs';
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as realChildProcess from 'node:child_process';
import sevenBin from '7zip-bin';
import { createEngine } from './src/lib/root-policy/engine.js';
import { ACTION_IDS, ACTION_CEILING, ACTORS, canonicalize, validatePolicy } from './src/lib/root-policy/schema.js';
import { buildDefaultPolicy } from './src/lib/root-policy/default-policy.js';
import { loadAndVerify } from './src/lib/root-policy/loader.js';
import { evaluateProcessRules, parseAbsoluteWindowsPath, isNormalisedHttpUrl, ARG_TEMPLATE_IDS } from './src/lib/root-policy/process-rules.js';
import { buildCandidateText, semanticDiff, writeCandidate, sha256Hex } from './root-policy-v2-candidate.mjs';
import { signPolicy, keyIdOf } from './root-policy-tool.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_DIR = path.join(HERE, 'policy');
const win = process.platform === 'win32';

// ── process recorder: the REAL callsites run, their spawn() is captured, nothing starts ─────────────────────────────────────────────────────
const spawned = [];
const fakeChild = () => { const c = new EventEmitter(); c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true; c.unref = () => {}; return c; };
const { default: _ignored, ...cpNamed } = realChildProcess;
mock.module('node:child_process', { namedExports: { ...cpNamed, spawn: (command, args, options) => { spawned.push({ command, args: [...args], options }); return fakeChild(); } } });

const db = await import('./src/lib/sqlite.js');
db.initSqlite(':memory:');
const browser = await import('./src/lib/browser.js');
const kiwix = await import('./src/lib/kiwix.js');
const comfy = await import('./src/lib/comfyui-install-manager.js');

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rpc2c-')));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const touch = (p, text = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

// ── the three policies under test ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const activeBytesBefore = ['root-policy.json', 'root-policy.sig.json', 'signing-log.jsonl'].map(f => sha256Hex(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf8')));
const V1_TEXT = fs.readFileSync(path.join(ACTIVE_DIR, 'root-policy.json'), 'utf8');
const V1 = JSON.parse(V1_TEXT);
const ISSUED = '2026-10-02T00:00:00.000Z';
const V2_TEXT = buildCandidateText({ issuedAt: ISSUED });
const V2 = JSON.parse(V2_TEXT);
const engineFor = (policy) => createEngine({ getPolicy: () => ({ valid: true, policy, version: policy.version }) });
const e1 = engineFor(V1);
const e2 = engineFor(V2);
const eInvalid = createEngine({ getPolicy: () => ({ valid: false }) });

const processRequest = (module, executorId, form) => ({
  action: 'PROCESS_START', module, trustDomain: 'PROCESS', actor: { kind: 'MODULE' },
  context: { executorId, argsTyped: true, executable: form.command ?? form.executable, args: form.args, ...(form.cwd ? { cwd: form.cwd } : {}) },
});
const verdict = (engine, request) => { const d = engine.decide(request); return `${d.decision}:${d.code}`; };
const ALLOW = 'ALLOW:ALLOW_INTERNAL_TYPED_EXECUTOR';
const DENY = 'DENY:DENY_ARBITRARY_EXECUTION';

// ═══════════════════════════ the candidate itself ═════════════════════════════════════════════════════════════════════════════════════════
test('CANDIDATE: version 2, schema-valid, canonical, reproducible, unsigned — and V1 regenerates byte for byte', () => {
  assert.equal(V2.version, 2);
  assert.deepEqual(validatePolicy(V2), { ok: true });
  assert.equal(canonicalize(V2), V2_TEXT, 'the file IS its canonical form (what the signing step would sign)');
  assert.equal(buildCandidateText({ issuedAt: ISSUED }), V2_TEXT, 'same inputs ⇒ same bytes ⇒ same hash for any reviewer');
  assert.equal(canonicalize(buildDefaultPolicy({ version: 1, issuedAt: V1.issuedAt })), V1_TEXT, 'V1 generation is unchanged: the signed V1 file is reproduced exactly');
  assert.equal('signature' in V2, false);
  assert.deepEqual(Object.keys(V2).sort(), Object.keys(V1).sort(), 'same document shape / schema');
});

test('CANDIDATE: semantic diff V1 → V2 — REMOVED 0, no unrelated CHANGED, ADDED = the 3 modules + their process rules', () => {
  const diff = semanticDiff(V1, V2);
  assert.equal(diff.counts.REMOVED, 0);
  assert.deepEqual(diff.changed.map(c => c.path).sort(), ['$.issuedAt', '$.version']);
  assert.ok(diff.counts.UNCHANGED > 200);
  const addedTop = new Set(diff.added.map(p => p.split('.').slice(0, 3).join('.')));
  assert.deepEqual([...addedTop].sort(), ['$.capabilities.PROCESS', '$.modules.browser', '$.modules.image-generation', '$.modules.kiwix']);
  assert.ok(diff.added.every(p => p.startsWith('$.modules.') || p.startsWith('$.capabilities.PROCESS.START_TYPED.constraints.executors.')), 'nothing else is added');
  // every V1 module / capability / action / boundary is deeply equal
  for (const section of ['invariants', 'trustDomains', 'actions', 'approvalBoundaries']) assert.deepEqual(V2[section], V1[section], section);
  for (const [name, def] of Object.entries(V1.modules)) assert.deepEqual(V2.modules[name], def, `module ${name}`);
  for (const [name, def] of Object.entries(V1.capabilities)) if (name !== 'PROCESS.START_TYPED') assert.deepEqual(V2.capabilities[name], def, `capability ${name}`);
  assert.equal(V2.capabilities['PROCESS.START_TYPED'].grantable, V1.capabilities['PROCESS.START_TYPED'].grantable);
  for (const name of ['browser', 'kiwix', 'image-generation']) assert.deepEqual(V2.modules[name], { domains: ['PROCESS'], capabilities: ['PROCESS.START_TYPED'], approvalBoundary: null });
  const grantsBefore = new Set(Object.entries(V1.modules).flatMap(([m, d]) => d.capabilities.map(c => `${m}:${c}`)));
  const grantsAfter = new Set(Object.entries(V2.modules).flatMap(([m, d]) => d.capabilities.map(c => `${m}:${c}`)));
  assert.deepEqual([...grantsBefore].filter(g => !grantsAfter.has(g)), [], 'no V1 capability removed');
  assert.deepEqual([...grantsAfter].filter(g => !grantsBefore.has(g)).sort(), ['browser:PROCESS.START_TYPED', 'image-generation:PROCESS.START_TYPED', 'kiwix:PROCESS.START_TYPED'], 'only the three PROCESS_START grants are new');
});

test('CANDIDATE: the schema refuses malformed or over-permissive process rules (a signed file still cannot exceed the ceilings)', () => {
  const mutate = (fn) => { const p = JSON.parse(V2_TEXT); fn(p.capabilities['PROCESS.START_TYPED'].constraints.executors, p); return validatePolicy(p); };
  const refused = {
    'unknown module': (ex) => { ex.ghost = { x: { executables: ['a.exe'], argsTemplates: ['url'] } }; },
    'module without the capability': (ex, p) => { p.modules.web.capabilities = ['WEB.PUBLIC_FETCH']; ex.web = { x: { executables: ['a.exe'], argsTemplates: ['url'] } }; },
    'unknown template': (ex) => { ex.kiwix['kiwix-serve'].argsTemplates = ['free-form']; },
    'no template': (ex) => { ex.kiwix['kiwix-serve'].argsTemplates = []; },
    'both allow and deny lists': (ex) => { ex.kiwix['kiwix-serve'].deniedExecutables = ['cmd.exe']; },
    'neither list': (ex) => { delete ex.kiwix['kiwix-serve'].executables; },
    'deny list without .exe extension rule': (ex) => { delete ex.browser['browser-open-custom'].executableExtension; },
    'path in a base name': (ex) => { ex.kiwix['kiwix-serve'].executables = ['..\\kiwix-serve.exe']; },
    'not an .exe': (ex) => { ex.kiwix['kiwix-serve'].executables = ['kiwix-serve.bat']; },
    'empty list': (ex) => { ex.kiwix['kiwix-serve'].executables = []; },
    'unknown key in an entry': (ex) => { ex.kiwix['kiwix-serve'].anyExecutable = true; },
    'invalid executor id': (ex) => { ex.kiwix['Kiwix Serve!'] = { executables: ['a.exe'], argsTemplates: ['url'] }; },
    'parentDir with a separator': (ex) => { ex['image-generation']['comfyui-launch'].parentDir = 'a\\b'; },
    'extension rule with an allow list': (ex) => { ex.kiwix['kiwix-serve'].executableExtension = '.exe'; },
    'other key under constraints': (ex, p) => { p.capabilities['PROCESS.START_TYPED'].constraints.wildcard = true; },
  };
  for (const [label, fn] of Object.entries(refused)) assert.equal(mutate(fn).ok, false, `must refuse: ${label}`);
  // and the V1 shape (no constraints at all) is still valid
  assert.deepEqual(validatePolicy(V1), { ok: true });
});

// ═══════════════════════════ nothing else changes: R1–R9, strict local, STOP, approvals, AI/plugin/MCP, fail-closed ═════════════════════
test('V2 vs V1: identical decisions for every module other than the three new ones, across the whole action × actor × module × domain × context space', () => {
  const modules = [...Object.keys(V1.modules), 'unknown-module'];
  const contexts = [{}, { executorId: 'x', argsTyped: true }, { executorId: 'x', argsTyped: true, viaShell: true }, { accessMode: 'public', networkClass: 'public' },
    { containsSecret: true, cloudEnabled: true }, { strictLocal: true }, { serviceId: 's' }];
  let compared = 0;
  for (const action of ACTION_IDS) for (const actor of ACTORS) for (const module of modules) {
    for (const trustDomain of new Set([...ACTION_CEILING[action].domains, 'WEB'])) for (const context of contexts) for (const userInitiated of [true, false]) {
      const request = { action, actor: { kind: actor }, module, trustDomain, context, userInitiated, certifiedBoundary: true };
      assert.equal(verdict(e2, request), verdict(e1, request), JSON.stringify({ action, actor, module, trustDomain, context }));
      compared++;
    }
  }
  assert.ok(compared > 100_000, `${compared} decisions compared`);
});

test('V2 keeps the root rules: R1 strict local, cloud opt-in, R2 secrets, R3 auth bypass, R4 approval, R5 no shell, R6 domains, R7 STOP, R8 policy immutable, R9 fail-closed', () => {
  const same = (request) => { const a = verdict(e1, request); assert.equal(verdict(e2, request), a); return a; };
  const user = { kind: 'USER' }; const mod = { kind: 'MODULE' };
  assert.equal(same({ action: 'AI_CLOUD_REQUEST', module: 'ai', trustDomain: 'AI', actor: mod, context: { strictLocal: true, cloudEnabled: true } }), 'DENY:DENY_STRICT_LOCAL');
  assert.equal(same({ action: 'AI_CLOUD_REQUEST', module: 'ai', trustDomain: 'AI', actor: mod, context: { strictLocal: false, cloudEnabled: true } }), 'ALLOW:ALLOW_CLOUD_OPT_IN');
  assert.equal(same({ action: 'AI_CLOUD_REQUEST', module: 'ai', trustDomain: 'AI', actor: mod, context: { strictLocal: false, cloudEnabled: false } }), 'DENY:DENY_CLOUD_NOT_ENABLED');
  assert.equal(same({ action: 'AI_CLOUD_REQUEST', module: 'ai', trustDomain: 'AI', actor: mod, context: { strictLocal: false, cloudEnabled: true, containsSecret: true } }), 'DENY:DENY_SECRET_EXPOSURE');
  assert.equal(same({ action: 'WEB_FETCH', module: 'web', trustDomain: 'WEB', actor: mod, context: { credentialsInPayload: true } }), 'DENY:DENY_SECRET_EXPOSURE');
  assert.equal(same({ action: 'MEDIA_DOWNLOAD', module: 'media', trustDomain: 'MEDIA', actor: user, userInitiated: true, context: { accessMode: 'circumvented' } }), 'DENY:DENY_AUTH_BYPASS');
  assert.equal(same({ action: 'EMAIL_SEND', module: 'agency', trustDomain: 'AGENCY', actor: user, userInitiated: true }), 'REQUIRE_APPROVAL:REQUIRE_LOCAL_APPROVAL');
  assert.equal(same({ action: 'SHELL_ARBITRARY', module: 'code-intel', trustDomain: 'PROCESS', actor: user }), 'DENY:DENY_ARBITRARY_EXECUTION');
  assert.equal(same({ action: 'PROCESS_START', module: 'code-intel', trustDomain: 'PROCESS', actor: mod, context: { executorId: 'git', argsTyped: true, freeFormCommand: true } }), DENY);
  assert.equal(same({ action: 'PROCESS_START', module: 'code-intel', trustDomain: 'PROCESS', actor: mod, context: { executorId: 'git', argsTyped: true } }), ALLOW, 'a V1 module keeps its V1 behaviour');
  assert.equal(same({ action: 'PROCESS_START', module: 'external-agents', trustDomain: 'PROCESS', actor: mod, context: { executorId: 'external-agent-cli', argsTyped: true } }), ALLOW);
  assert.equal(same({ action: 'WEB_FETCH', module: 'media', trustDomain: 'FILES', actor: mod }), 'DENY:DENY_TRUST_DOMAIN_MISMATCH');
  assert.equal(same({ action: 'DEVICE_STOP', module: 'omega', trustDomain: 'OMEGA', actor: { kind: 'AI_CLOUD' } }), 'ALLOW:ALLOW_STOP_ALWAYS');
  assert.equal(verdict(createEngine({ getPolicy: () => ({ valid: false }) }), { action: 'DEVICE_STOP', module: 'omega', trustDomain: 'OMEGA', actor: user }), 'ALLOW:ALLOW_STOP_ALWAYS', 'STOP wins even with an untrusted policy');
  for (const actor of ACTORS) assert.equal(same({ action: 'POLICY_UPDATE', module: 'policy', trustDomain: 'POLICY', actor: { kind: actor } }), 'DENY:DENY_POLICY_IMMUTABLE', `${actor} cannot update the policy`);
  for (const action of ['PLUGIN_INSTALL', 'PLUGIN_UPDATE', 'MCP_START']) for (const actor of ['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'PLUGIN', 'MCP', 'REMOTE', 'DOCUMENT']) {
    assert.match(same({ action, module: 'ai', trustDomain: 'PLUGIN', actor: { kind: actor }, userInitiated: true }), /^DENY:/, `${actor} cannot ${action}`);
  }
  assert.equal(verdict(e1, { action: 'NOT_AN_ACTION', module: 'web', trustDomain: 'WEB', actor: mod }), 'DENY:DENY_UNKNOWN_ACTION');
  assert.equal(verdict(e2, { action: 'NOT_AN_ACTION', module: 'web', trustDomain: 'WEB', actor: mod }), 'DENY:DENY_UNKNOWN_ACTION');
});

test('V2: untrusted origins can NEVER start a process through the new modules; unknown protected state fails closed', () => {
  const form = { executable: 'C:\\Program Files\\Kiwix\\kiwix-serve.exe', cwd: 'C:\\Program Files\\Kiwix', args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'D:\\zim\\a.zim'] };
  for (const actor of ['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'PLUGIN', 'MCP', 'REMOTE', 'CONNECTOR', 'DOCUMENT', 'USER']) {
    const request = { ...processRequest('kiwix', 'kiwix-serve', form), actor: { kind: actor } };
    assert.match(verdict(e2, request), /^DENY:DENY_ACTOR_NOT_PERMITTED$/, `${actor} must not start kiwix`);
  }
  assert.equal(verdict(eInvalid, processRequest('kiwix', 'kiwix-serve', form)), 'DENY:DENY_POLICY_INVALID', 'untrusted policy ⇒ protected operation refused');
  assert.equal(verdict(e1, processRequest('kiwix', 'kiwix-serve', form)), 'DENY:DENY_UNKNOWN_MODULE', 'under V1 the three modules do not exist yet (fail-closed): this is what V2 changes');
  assert.equal(verdict(e2, { ...processRequest('kiwix', 'kiwix-serve', form), module: 'someone-new' }), 'DENY:DENY_UNKNOWN_MODULE');
  assert.equal(verdict(e2, { ...processRequest('kiwix', 'kiwix-serve', form), trustDomain: 'WEB' }), 'DENY:DENY_TRUST_DOMAIN_MISMATCH');
  assert.equal(verdict(e2, { ...processRequest('kiwix', 'kiwix-serve', form), context: { executorId: 'kiwix-serve', argsTyped: false, ...form } }), DENY);
  assert.equal(verdict(e2, { ...processRequest('kiwix', 'kiwix-serve', form), context: { executorId: 'kiwix-serve', argsTyped: true, viaShell: true, ...form } }), DENY);
  assert.equal(verdict(e2, { ...processRequest('kiwix', 'kiwix-serve', form), context: { argsTyped: true, ...form } }), DENY, 'no executor id');
});

// ═══════════════════════════ REAL forms from the current callsites: ALLOWED ═══════════════════════════════════════════════════════════════
test('BROWSER: every form the current browser launcher produces (system, detected, custom) is ALLOWED — no approval', () => {
  const URLS = ['https://example.com/', 'https://fr.wikipedia.org/wiki/Caf%C3%A9_(boisson)', 'http://localhost:5173/#/notebook'];
  const customDir = path.join(scratch, 'Zen Browser'); const customExe = touch(path.join(customDir, 'zen.exe'));
  const idFor = (settings) => (settings.selected === 'system' ? 'browser-open-system' : settings.selected === 'custom' ? 'browser-open-custom' : `browser-open-${settings.selected}`);
  const forms = [];   // [settings, url, the command+args the launcher really builds FOR THOSE settings]
  const capture = (url) => forms.push([browser.getBrowserSettings(), url, browser.resolveOpenCommand(browser.assertOpenableUrl(url))]);
  for (const installed of browser.detectInstalledBrowsers()) { browser.setBrowserSettings({ selected: installed.id, customPath: null }); for (const url of URLS) capture(url); }
  browser.setBrowserSettings({ selected: 'custom', customPath: customExe }); for (const url of URLS) capture(url);
  assert.ok(forms.length >= URLS.length * 2, 'at least system + custom were exercised');
  const seen = new Set();
  for (const [settings, url, form] of forms) {
    const request = processRequest('browser', idFor(settings), form);
    if (settings.selected === 'system') {
      // the legacy dispatch is cmd.exe /c start "" <url>: the policy accepts it for a URL cmd.exe cannot reinterpret (all URLs above)
      assert.equal(path.basename(form.command).toLowerCase(), 'cmd.exe');
      assert.deepEqual(form.args.slice(0, 3), ['/c', 'start', '']);
    }
    assert.equal(verdict(e2, request), ALLOW, `${settings.selected} ${url} → ${form.command}`);
    assert.equal(e2.decide(request).decision, 'ALLOW', 'no approval prompt');
    seen.add(settings.selected);
  }
  assert.ok(seen.has('system') && seen.has('custom'));
  browser.setBrowserSettings({ selected: 'system', customPath: null });
});

test('BROWSER: the safe system dispatch (explorer.exe <url>) is ALLOWED for every URL — including the ones cmd.exe would mis-parse (what RPC-2D wires)', () => {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  for (const url of ['https://www.youtube.com/watch?v=abc&t=10s', 'https://example.com/?a=1&b=2', 'https://example.com/a%20b?x=%26', 'https://example.com/']) {
    const explorer = { command: path.join(sysRoot, 'explorer.exe'), args: [new URL(url).href] };
    assert.equal(verdict(e2, processRequest('browser', 'browser-open-system', explorer)), ALLOW, url);
    assert.equal(verdict(e2, processRequest('browser', 'browser-open-edge', { command: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args: [new URL(url).href] })), ALLOW, `direct browser ${url}`);
  }
  // FINDING (documented, not executed): today's default dispatch is cmd.exe /c start "" <url> with the URL as one unquoted argument. cmd.exe re-parses its
  // command line, so a URL containing & | < > ^ " or %…% is cut / reinterpreted. The candidate refuses exactly those URLs for cmd.exe and offers explorer.exe.
  for (const url of ['https://example.com/?a=1&b=2', 'https://example.com/?x=1|y', 'https://example.com/?x=<z>', 'https://example.com/?x=^y', 'https://example.com/%PATH%']) {
    const viaCmd = { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'start', '', new URL(url).href] };
    assert.equal(verdict(e2, processRequest('browser', 'browser-open-system', viaCmd)), DENY, `cmd.exe + ${url}`);
  }
});

test('KIWIX: the form startKiwixServe really produces (binary, loopback arguments, own folder as cwd) is ALLOWED', async () => {
  const dir = path.join(scratch, 'Kiwix Tools'); touch(path.join(dir, 'kiwix-serve.exe'));
  const zims = path.join(scratch, 'ZIM archives été'); touch(path.join(zims, 'wikipedia_fr.zim')); touch(path.join(zims, 'pokepedia.ZIM'));
  db.setKiwixSettings({ kiwixServePath: dir, archivesFolder: zims, port: 18091 });
  const before = spawned.length;
  const started = await kiwix.startKiwixServe({ spawnFn: (command, args, options) => { spawned.push({ command, args: [...args], options }); return fakeChild(); }, healthCheckAttempts: 0, healthCheckIntervalMs: 1 });
  assert.equal(started.ok, true, JSON.stringify(started).slice(0, 200));
  const call = spawned.at(-1); assert.equal(spawned.length, before + 1);
  const form = { command: call.command, args: call.args, cwd: call.options.cwd };
  assert.equal(path.basename(form.command), 'kiwix-serve.exe'); assert.equal(form.args[1], '--address=127.0.0.1'); assert.ok(form.args.includes('--blockexternal'));
  const request = processRequest('kiwix', 'kiwix-serve', form);
  assert.equal(verdict(e2, request), ALLOW);
  assert.equal(e2.decide(request).decision, 'ALLOW', 'no approval prompt');
  // the configuration the user may use today: the .exe path itself instead of its folder
  db.setKiwixSettings({ kiwixServePath: path.join(dir, 'kiwix-serve.exe') });
  kiwix.stopKiwixServe();
});

test('COMFYUI: the launch form startComfyUi really produces, and the 7-Zip archive operations of the installer, are ALLOWED', () => {
  const install = path.join(scratch, 'ComfyUI Portable'); touch(path.join(install, 'python_embeded', 'python.exe')); touch(path.join(install, 'ComfyUI', 'main.py'));
  db.setMeta('comfyui_install', { status: 'stopped', path: install, kind: 'external' });
  const before = spawned.length;
  comfy.startComfyUi();
  assert.equal(spawned.length, before + 1, 'the launcher called spawn exactly once (recorded, not started)');
  const call = spawned.at(-1);
  const launch = { command: call.command, args: call.args, cwd: call.options.cwd };
  assert.equal(path.basename(launch.command).toLowerCase(), 'python.exe'); assert.deepEqual([launch.args[0], launch.args[2]], ['-s', '--windows-standalone-build']);
  const request = processRequest('image-generation', 'comfyui-launch', launch);
  assert.equal(verdict(e2, request), ALLOW);
  assert.equal(e2.decide(request).decision, 'ALLOW', 'no approval prompt');
  // installer: node-7z is asked to list / extract `<dest>.download.7z.tmp` into `<dest>.extracting.tmp` with the bundled 7za.exe
  const dest = path.join(scratch, 'ComfyUI_windows_portable');
  const archive = `${dest}.download.7z.tmp`; const extractTmp = `${dest}.extracting.tmp`;
  assert.equal(path.basename(sevenBin.path7za).toLowerCase(), '7za.exe');
  for (const args of [['l', archive], ['x', archive, extractTmp]]) assert.equal(verdict(e2, processRequest('image-generation', 'comfyui-archive', { command: sevenBin.path7za, args })), ALLOW, args[0]);
  // the managed install location Docteur itself proposes (python_embeded one level below the install root, any drive / folder name)
  const managed = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\x\\AppData\\Local', 'Docteur', 'ComfyUI', 'ComfyUI_windows_portable');
  assert.equal(verdict(e2, processRequest('image-generation', 'comfyui-launch', { command: path.join(managed, 'python_embeded', 'python.exe'), cwd: managed, args: ['-s', path.join(managed, 'ComfyUI', 'main.py'), '--windows-standalone-build'] })), ALLOW);
});

// ═══════════════════════════ forged forms: DENIED ═════════════════════════════════════════════════════════════════════════════════════════════
test('BROWSER FORGED: arbitrary executable through the browser capability is DENIED (shells, interpreters, script hosts, wrong place, wrong arguments)', () => {
  const url = 'https://example.com/';
  const deny = (id, executable, args = [url], cwd) => assert.equal(verdict(e2, processRequest('browser', id, { executable, args, cwd })), DENY, `${id} ${executable} ${JSON.stringify(args).slice(0, 60)}`);
  for (const exe of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'python.exe', 'node.exe', 'wsl.exe', 'certutil.exe', 'explorer.exe', 'CMD.EXE', 'PowerShell.EXE']) {
    deny('browser-open-custom', `C:\\Windows\\System32\\${exe}`);
    deny('browser-open-custom', `D:\\tools\\${exe}`);
  }
  deny('browser-open-custom', 'C:\\Users\\x\\Downloads\\payload.bat');                                  // not an .exe
  deny('browser-open-custom', 'C:\\Users\\x\\Downloads\\browser.exe', ['--remote-debugging-port=1', url]);   // flags smuggled next to the URL
  deny('browser-open-custom', 'C:\\Users\\x\\Downloads\\browser.exe', ['file:///C:/Windows/System32/calc.exe']); // not http(s)
  deny('browser-open-custom', 'C:\\Users\\x\\Downloads\\browser.exe', ['javascript:alert(1)']);
  deny('browser-open-custom', 'C:\\Users\\x\\Downloads\\browser.exe', ['-flag']);
  deny('browser-open-custom', 'C:\\Users\\x\\Downloads\\browser.exe', [url, url]);
  deny('browser-open-custom', 'C:\\Users\\x\\Downloads\\browser.exe', [url], 'C:\\Windows');            // inherited cwd only
  deny('browser-open-custom', '\\\\evil\\share\\browser.exe');                                           // UNC
  deny('browser-open-custom', 'C:\\Users\\x\\..\\..\\Windows\\System32\\cmd.exe');                       // traversal
  deny('browser-open-custom', 'C:\\Users\\x\\browser.exe:stream');                                       // alternate data stream
  deny('browser-open-custom', 'C:\\Users\\x\\browser.exe ');                                             // trailing space
  deny('browser-open-custom', 'browser.exe');                                                            // relative
  deny('browser-open-system', 'C:\\Windows\\System32\\cmd.exe', ['/c', 'calc.exe']);                     // cmd with another command line
  deny('browser-open-system', 'C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '', 'calc.exe']);        // start something that is not a URL
  deny('browser-open-system', 'C:\\Windows\\System32\\cmd.exe', ['/k', 'start', '', url]);
  deny('browser-open-system', 'C:\\Windows\\System32\\powershell.exe', ['/c', 'start', '', url]);
  deny('browser-open-system', 'C:\\Windows\\System32\\explorer.exe', ['/select,C:\\Windows\\System32\\cmd.exe']);
  deny('browser-open-system', 'C:\\Windows\\System32\\explorer.exe', [url, 'C:\\x']);
  // detected browsers are pinned to their install folder and base name
  deny('browser-open-chrome', 'C:\\Users\\x\\Downloads\\chrome.exe');
  deny('browser-open-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\evil-chrome.exe');
  deny('browser-open-chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe.exe');
  deny('browser-open-edge', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');               // another browser's executor
  deny('browser-open-firefox', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', ['-new-tab', url]);
  // unknown executor ids for the module
  deny('browser-open-anything', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  deny('kiwix-serve', 'C:\\Program Files\\Kiwix\\kiwix-serve.exe');                                      // another module's executor id
  assert.equal(verdict(e2, processRequest('browser', undefined, { executable: 'C:\\x\\a.exe', args: [url] })), DENY);
  // and the legitimate ones next to them still work
  assert.equal(verdict(e2, processRequest('browser', 'browser-open-custom', { executable: 'D:\\Navigateurs\\Zen\\zen.exe', args: [url] })), ALLOW);
  assert.equal(verdict(e2, processRequest('browser', 'browser-open-custom', { executable: 'C:\\Users\\Zoë\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe', args: [url] })), ALLOW);
  assert.equal(verdict(e2, processRequest('browser', 'browser-open-chrome', { executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: [url] })), ALLOW);
  assert.equal(verdict(e2, processRequest('browser', 'browser-open-firefox', { executable: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', args: [url] })), ALLOW);
});

test('KIWIX FORGED: only kiwix-serve.exe, with loopback arguments and its own folder as cwd — suffix tricks, other binaries, traversal and wrong arguments are DENIED', () => {
  const dir = 'C:\\Program Files\\Kiwix'; const ok = { executable: `${dir}\\kiwix-serve.exe`, cwd: dir, args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'D:\\zim\\wiki.zim'] };
  assert.equal(verdict(e2, processRequest('kiwix', 'kiwix-serve', ok)), ALLOW, 'the genuine form');
  assert.equal(verdict(e2, processRequest('kiwix', 'kiwix-serve', { ...ok, executable: `${dir.toLowerCase()}\\KIWIX-SERVE.EXE` })), ALLOW, 'case does not matter on Windows');
  const forged = {
    'evil-kiwix-serve.exe': { executable: `${dir}\\evil-kiwix-serve.exe` },
    'kiwix-serve.exe.exe': { executable: `${dir}\\kiwix-serve.exe.exe` },
    'kiwix-serve.exe.bat': { executable: `${dir}\\kiwix-serve.exe.bat` },
    'kiwix-serve.exe with a trailing dot': { executable: `${dir}\\kiwix-serve.exe.` },
    'kiwix-serve.exe with a trailing space': { executable: `${dir}\\kiwix-serve.exe ` },
    'kiwix-serve.exe as a stream': { executable: `${dir}\\kiwix-serve.exe:evil.exe` },
    'cmd.exe': { executable: 'C:\\Windows\\System32\\cmd.exe', cwd: 'C:\\Windows\\System32' },
    'powershell.exe': { executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cwd: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' },
    'path traversal': { executable: `${dir}\\..\\..\\Windows\\System32\\kiwix-serve.exe` },
    'dot segment': { executable: `${dir}\\.\\kiwix-serve.exe` },
    'UNC share': { executable: '\\\\evil\\share\\kiwix-serve.exe', cwd: '\\\\evil\\share' },
    'relative path': { executable: 'kiwix-serve.exe' },
    'empty path': { executable: '' },
    'no executable': { executable: undefined },
    'non-string executable': { executable: 12345 },
    'wildcard': { executable: `${dir}\\kiwix-*.exe` },
    'NUL in path': { executable: `${dir}\\kiwix-serve.exe\u0000.txt` },
    'binds all interfaces': { args: ['--port=8090', '--address=0.0.0.0', '--blockexternal', 'D:\\zim\\wiki.zim'] },
    'missing --blockexternal': { args: ['--port=8090', '--address=127.0.0.1', 'D:\\zim\\wiki.zim'] },
    'extra flag': { args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', '--library', 'D:\\zim\\wiki.zim'] },
    'archive that is not a zim': { args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'C:\\Windows\\System32\\cmd.exe'] },
    'relative archive': { args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'wiki.zim'] },
    'traversal in an archive': { args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'D:\\zim\\..\\..\\x.zim'] },
    'no archive': { args: ['--port=8090', '--address=127.0.0.1', '--blockexternal'] },
    'port out of range': { args: ['--port=70000', '--address=127.0.0.1', '--blockexternal', 'D:\\zim\\wiki.zim'] },
    'port not numeric': { args: ['--port=80;calc', '--address=127.0.0.1', '--blockexternal', 'D:\\zim\\wiki.zim'] },
    'non-string argument': { args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 42] },
    'arguments missing': { args: undefined },
    'working directory elsewhere': { cwd: 'C:\\Windows\\System32' },
    'working directory missing': { cwd: undefined },
    'working directory is a UNC share': { cwd: '\\\\evil\\share' },
  };
  for (const [label, override] of Object.entries(forged)) assert.equal(verdict(e2, processRequest('kiwix', 'kiwix-serve', { ...ok, ...override })), DENY, `must deny: ${label}`);
  // a kiwix-serve.exe in an unusual place is the user's own installation (their settings choose the folder): deterministic ALLOW by name, arguments and cwd
  assert.equal(verdict(e2, processRequest('kiwix', 'kiwix-serve', { executable: 'E:\\Portable\\kiwix\\kiwix-serve.exe', cwd: 'E:\\Portable\\kiwix', args: ok.args })), ALLOW);
  assert.equal(verdict(e2, processRequest('kiwix', 'kiwix-serve', { executable: 'E:\\Portable\\kiwix\\kiwix-serve.exe', cwd: 'E:\\Portable', args: ok.args })), DENY, '…but its cwd must be its own folder');
});

test('COMFYUI FORGED: arbitrary executables / arguments / locations are DENIED; the embedded python running ComfyUI\'s main.py is the only launch', () => {
  const root = 'D:\\AI\\ComfyUI_windows_portable';
  const ok = { executable: `${root}\\python_embeded\\python.exe`, cwd: root, args: ['-s', `${root}\\ComfyUI\\main.py`, '--windows-standalone-build'] };
  assert.equal(verdict(e2, processRequest('image-generation', 'comfyui-launch', ok)), ALLOW);
  const forged = {
    'system python': { executable: 'C:\\Python310\\python.exe', cwd: 'C:\\Python310' },
    'python outside python_embeded': { executable: `${root}\\tools\\python.exe` },
    'pythonw': { executable: `${root}\\python_embeded\\pythonw.exe` },
    'cmd.exe': { executable: 'C:\\Windows\\System32\\cmd.exe', cwd: 'C:\\Windows\\System32' },
    'cmd.exe pretending to live in python_embeded': { executable: `${root}\\python_embeded\\cmd.exe` },
    'powershell': { executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    'python_embeded elsewhere than <root>': { executable: 'D:\\evil\\python_embeded\\python.exe' },
    'traversal': { executable: `${root}\\python_embeded\\..\\..\\..\\Windows\\python.exe` },
    'inline code': { args: ['-c', 'import os; os.system("calc")'] },
    'code after the script': { args: ['-s', `${root}\\ComfyUI\\main.py`, '--windows-standalone-build', '-c', 'x'] },
    'missing windows flag': { args: ['-s', `${root}\\ComfyUI\\main.py`] },
    'another script': { args: ['-s', `${root}\\ComfyUI\\evil.py`, '--windows-standalone-build'] },
    'main.py outside ComfyUI': { args: ['-s', `${root}\\main.py`, '--windows-standalone-build'] },
    'main.py of another install': { args: ['-s', 'D:\\other\\ComfyUI\\main.py', '--windows-standalone-build'] },
    'script via traversal': { args: ['-s', `${root}\\ComfyUI\\..\\..\\evil\\main.py`, '--windows-standalone-build'] },
    'cwd is not the install root': { cwd: 'C:\\Windows\\System32' },
    'cwd missing': { cwd: undefined },
    'cwd is the python folder': { cwd: `${root}\\python_embeded` },
    'UNC install': { executable: '\\\\evil\\share\\python_embeded\\python.exe', cwd: '\\\\evil\\share', args: ['-s', '\\\\evil\\share\\ComfyUI\\main.py', '--windows-standalone-build'] },
  };
  for (const [label, override] of Object.entries(forged)) assert.equal(verdict(e2, processRequest('image-generation', 'comfyui-launch', { ...ok, ...override })), DENY, `must deny: ${label}`);
  const archive = 'D:\\AI\\ComfyUI_windows_portable.download.7z.tmp';
  const sz = 'C:\\Project\\node_modules\\7zip-bin\\win\\x64\\7za.exe';
  assert.equal(verdict(e2, processRequest('image-generation', 'comfyui-archive', { executable: sz, args: ['x', archive, 'D:\\AI\\ComfyUI_windows_portable.extracting.tmp'] })), ALLOW);
  const archiveDeny = {
    'another executable': { executable: 'C:\\Windows\\System32\\cmd.exe' },
    '7za renamed': { executable: 'C:\\x\\7za-evil.exe' },
    'unknown operation': { args: ['a', archive, 'D:\\x'] },
    'archive that is not a 7z': { args: ['x', 'D:\\AI\\payload.exe', 'D:\\x'] },
    'relative destination': { args: ['x', archive, 'dest'] },
    'switch smuggled': { args: ['x', archive, 'D:\\x', '-aoa'] },
    'cwd given': { cwd: 'C:\\x' },
  };
  for (const [label, override] of Object.entries(archiveDeny)) assert.equal(verdict(e2, processRequest('image-generation', 'comfyui-archive', { executable: sz, args: ['x', archive, 'D:\\x'], ...override })), DENY, `7z: ${label}`);
  assert.equal(verdict(e2, processRequest('image-generation', 'comfyui-launch', { ...ok, executable: sz })), DENY, '7za cannot launch ComfyUI');
  assert.equal(verdict(e2, processRequest('kiwix', 'comfyui-launch', ok)), DENY, 'ComfyUI executor under another module');
});

test('NO RECURRING APPROVAL: every legitimate PROCESS_START of the three modules is a plain ALLOW — the policy asks nobody (PROCESS_START is MEDIUM, never HIGH)', () => {
  assert.equal(V2.actions.PROCESS_START.impact, 'MEDIUM'); assert.equal(V1.actions.PROCESS_START.impact, 'MEDIUM');
  const sample = [
    processRequest('browser', 'browser-open-custom', { executable: 'D:\\Zen\\zen.exe', args: ['https://example.com/'] }),
    processRequest('kiwix', 'kiwix-serve', { executable: 'C:\\k\\kiwix-serve.exe', cwd: 'C:\\k', args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'C:\\z\\a.zim'] }),
    processRequest('image-generation', 'comfyui-launch', { executable: 'C:\\c\\python_embeded\\python.exe', cwd: 'C:\\c', args: ['-s', 'C:\\c\\ComfyUI\\main.py', '--windows-standalone-build'] }),
  ];
  for (const request of sample) { const d = e2.decide(request); assert.equal(d.decision, 'ALLOW'); assert.notEqual(d.decision, 'REQUIRE_APPROVAL'); }
});

// ═══════════════════════════ the pure rules, directly ═══════════════════════════════════════════════════════════════════════════════════════
test('PROCESS RULES: path and URL primitives accept ordinary Windows forms and refuse every ambiguous one; the evaluator is fast and pure', () => {
  for (const good of ['C:\\a.exe', 'c:/a/b/c.exe', 'D:\\Dossier avec espaces\\été\\日本語.exe', `C:\\${'x'.repeat(100)}\\y.exe`]) assert.notEqual(parseAbsoluteWindowsPath(good), null, good);
  for (const bad of ['', 'a.exe', '\\a.exe', '\\\\srv\\s\\a.exe', 'C:', 'C:\\', 'C:a.exe', 'C:\\a\\..\\b.exe', 'C:\\a\\.\\b.exe', 'C:\\a\\b.exe:s', 'C:\\a\\b.exe.', 'C:\\a\\b.exe ', 'C:\\a\\b*.exe', 'C:\\a\\b?.exe', 'C:\\a|b.exe', 'C:\\a\\b\u0001.exe', `C:\\${'x'.repeat(600)}.exe`, null, undefined, 5, {}]) assert.equal(parseAbsoluteWindowsPath(bad), null, String(bad).slice(0, 30));
  for (const good of ['https://a.b/', 'http://localhost:5173/#/x', 'https://a.b/?q=1&r=2']) assert.equal(isNormalisedHttpUrl(good), true, good);
  for (const bad of ['', 'ftp://a.b/', 'file:///C:/x', 'javascript:alert(1)', '-https://a.b/', 'https://a.b/ x', 'https://A.B', 'https://a.b/\n', 'https://', 'a.b', null]) assert.equal(isNormalisedHttpUrl(bad), false, String(bad));
  assert.ok(ARG_TEMPLATE_IDS.includes('url') && ARG_TEMPLATE_IDS.length >= 6);
  assert.deepEqual(evaluateProcessRules({}, { executorId: 'x' }), { ok: false, reason: 'EXECUTOR_NOT_DECLARED' });
  assert.equal(evaluateProcessRules({ broken: {} }, { executorId: 'broken', executable: 'C:\\a.exe', args: [] }).ok, false, 'a malformed rule fails closed instead of throwing or allowing');
  assert.equal(evaluateProcessRules({ broken: { executables: ['a.exe'], argsTemplates: ['url'] } }, { executorId: 'broken', executable: 'C:\\a.exe', args: { length: 1 } }).ok, false);
  assert.equal(evaluateProcessRules(null, { executorId: 'x' }).ok, false);
  assert.equal(evaluateProcessRules(V2.capabilities['PROCESS.START_TYPED'].constraints.executors.browser, { executorId: '__proto__', executable: 'C:\\a.exe', args: [] }).ok, false, 'prototype keys are not executors');
  const rules = V2.capabilities['PROCESS.START_TYPED'].constraints.executors.kiwix;
  const request = { executorId: 'kiwix-serve', executable: 'C:\\k\\kiwix-serve.exe', cwd: 'C:\\k', args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'D:\\z.zim'] };
  for (let i = 0; i < 200; i++) evaluateProcessRules(rules, request);
  const started = performance.now(); const N = 20_000;
  for (let i = 0; i < N; i++) evaluateProcessRules(rules, request);
  assert.ok((performance.now() - started) / N < 0.05, 'microseconds per decision');
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'root-policy', 'process-rules.js'), 'utf8').split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(src, /^import /m, 'process-rules.js has no import at all'); assert.doesNotMatch(src, /\b(fetch|spawn\w*|execFile\w*|execSync|child_process|readFileSync|writeFileSync|require|eval|process\.env|Date\.now|Math\.random)\b/);
});

// ═══════════════════════════ no signature, no activation, no key: the candidate tool and the rehearsal ═══════════════════════════════════
test('CANDIDATE TOOL: unsigned, never writes in the perimeter or over a file, never imports the signing tool nor touches a key', () => {
  const out = path.join(scratch, 'cand', 'root-policy.v2.candidate.json');
  assert.equal(writeCandidate(out, V2_TEXT), out);
  assert.equal(fs.readFileSync(out, 'utf8'), V2_TEXT);
  assert.throws(() => writeCandidate(out, V2_TEXT), /already exists/);
  for (const forbidden of [path.join(ACTIVE_DIR, 'root-policy.json'), path.join(ACTIVE_DIR, 'new.json'), path.join(ACTIVE_DIR, 'recovery', 'x.json'), path.join(HERE, 'src', 'lib', 'root-policy', 'x.json'), path.join(HERE, 'data', 'root-policy', 'state.json')]) {
    assert.throws(() => writeCandidate(forbidden, V2_TEXT), /perimeter/, forbidden);
  }
  const src = fs.readFileSync(path.join(HERE, 'root-policy-v2-candidate.mjs'), 'utf8').split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(src, /root-policy-tool|signPolicy|createPrivateKey|crypto\.sign\(|generateKeyPair|createSign|PASSPHRASE|passphrase|readline|child_process|\.sig\.json|signing-key/);
  assert.equal(buildCandidateText({ issuedAt: ISSUED }).includes('signature'), false);
  assert.throws(() => buildCandidateText({ issuedAt: 'not a date' }), /ISO-8601/);
});

test('REHEARSAL with a THROW-AWAY key in a temporary directory: the candidate bytes are exactly what gets signed and verifies; V1→V2 is an accepted upgrade; V2→V1 is a rollback', () => {
  const dir = path.join(scratch, 'rehearsal'); fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');          // ephemeral, test-only: never the human key
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }); const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const anchors = [{ keyId: keyIdOf(publicPem), alg: 'ed25519', publicKeyPem: publicPem }];
  const v1 = buildDefaultPolicy({ version: 1, issuedAt: V1.issuedAt });
  signPolicy({ policy: v1, privateKeyPem: privatePem, publicKeyPem: publicPem, policyDir: dir });
  assert.equal(loadAndVerify({ policyDir: dir, trustAnchors: anchors, highestVersionSeen: 0 }).ok, true);
  const candidate = JSON.parse(V2_TEXT);
  const { sig, canonical } = signPolicy({ policy: candidate, privateKeyPem: privatePem, publicKeyPem: publicPem, policyDir: dir });
  assert.equal(canonical, V2_TEXT, 'the tool signs the candidate\'s own canonical bytes');
  assert.equal(sig.sha256, sha256Hex(V2_TEXT), 'candidate hash shown before = hash printed by the signing step');
  const upgraded = loadAndVerify({ policyDir: dir, trustAnchors: anchors, highestVersionSeen: 1 });
  assert.equal(upgraded.ok, true); assert.equal(upgraded.version, 2);
  assert.equal(loadAndVerify({ policyDir: dir, trustAnchors: anchors, highestVersionSeen: 2 }).ok, true, 'same version after reboot');
  assert.equal(loadAndVerify({ policyDir: path.join(dir, 'recovery'), trustAnchors: anchors, highestVersionSeen: 2 }).code, 'ROLLBACK_DETECTED', 'putting V1 back after V2 was seen is refused');
  // an engine built from the VERIFIED V2 document gives the same answers as the candidate under test
  const loaded = engineFor(upgraded.policy);
  assert.equal(verdict(loaded, processRequest('kiwix', 'kiwix-serve', { executable: 'C:\\k\\kiwix-serve.exe', cwd: 'C:\\k', args: ['--port=8090', '--address=127.0.0.1', '--blockexternal', 'D:\\z.zim'] })), ALLOW);
  // a tampered candidate (one byte) does not verify
  const tampered = fs.readFileSync(path.join(dir, 'root-policy.json'), 'utf8').replace('"browser-open-custom"', '"browser-open-customs"');
  fs.writeFileSync(path.join(dir, 'root-policy.json'), tampered);
  assert.notEqual(loadAndVerify({ policyDir: dir, trustAnchors: anchors, highestVersionSeen: 0 }).ok, true);
});

test('NOTHING REAL CHANGED: the active V1 pair and signing log are byte-identical after every test above', () => {
  const after = ['root-policy.json', 'root-policy.sig.json', 'signing-log.jsonl'].map(f => sha256Hex(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf8')));
  assert.deepEqual(after, activeBytesBefore);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, 'root-policy.json'), 'utf8')).version, 1);
  assert.equal(fs.existsSync(path.join(ACTIVE_DIR, 'recovery')), false, 'no recovery copy was created in the real policy directory (the rehearsal used a temporary one)');
  assert.deepEqual(fs.readdirSync(ACTIVE_DIR).sort(), ['root-policy.json', 'root-policy.sig.json', 'signing-log.jsonl']);
});
