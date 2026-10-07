// ROOT POLICY V1 — static bypass audit: "ROOT POLICY PROTECTED ACTIONS V1" perimeter, executors that could act without the engine, immutability.
// Run: node --test test-root-policy-static-audit.mjs
//
// This audit is the reason the report can state PRECISELY what is covered. It FAILS when:
//   • a subprocess-capable file appears (or changes class) without being classified,
//   • a certified device route appears that is neither gated nor explicitly listed as ungated,
//   • a yt-dlp launch site loses its Root Policy + media-egress preparation,
//   • a cloud provider loses the single cloud choke point,
//   • anything under src/ gains a way to write / replace / reload the policy, or imports the offline tool / test seams,
//   • the decision engine acquires network / filesystem / process / LLM dependencies.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRoute, ROUTE_MAP_SIZE } from './src/lib/root-policy/route-map.js';
import * as rootPolicy from './src/lib/root-policy/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
const ALL = walk(SRC).map(f => ({ rel: rel(f), text: fs.readFileSync(f, 'utf8') }));
const code = (text) => text.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── The offline signing tool ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS PROTECTS (intent): nothing under src/ may IMPORT, LAUNCH or re-implement the human signing ceremony (import / spawn / exec / reseal / a signing or
// private-key capability), because the runtime must never be able to sign a policy. A purely textual "the name never appears" check is evaded by assembling the
// name, so the audit also rejects every fragment that could be used to build it, and checks the capabilities themselves.
// ONE narrow, defensive exception (RPC-2C): lib/root-policy/protected-paths.js DESIGNATES the tool's path as a file the AI-driven apply flows must never write.
// That is a path declaration, not a use: it is allowed only as the single exact line below, in a file that has no execution, network or dynamic-load primitive
// and imports nothing but fs / os / path / url. Anything else naming or assembling the tool — in that file or any other — is a finding.
const DEFENSIVE_FILE = 'lib/root-policy/protected-paths.js';
const DEFENSIVE_LINE = /^\s*path\.join\(CORTEX_SERVER, 'root-policy-tool\.mjs'\),?\s*$/;
const TOOL_TEXT = /root-policy-tool|tool\.mjs|root-policy['"`]\s*[,+]\s*['"`]-?tool/;
const SIGNING_CAPABILITY = /\b(signPolicy|ROOT_POLICY_PASSPHRASE)\b/;
const KEY_CAPABILITY = /createPrivateKey|crypto\.sign\(|generateKeyPair|createSign\(/;
const EXEC_PRIMITIVE = /child_process|\bspawn\w*\(|\bexec\w*\(|\bfork\(|import\s*\(|\brequire\s*\(|\beval\s*\(|new\s+Function|\bfetch\s*\(|node:(net|http|https|dns|tls|worker_threads|vm)/;
export function signingToolFindings(relPath, text) {
  const body = code(text);
  const found = [];
  const named = body.split(/\r?\n/).filter(l => TOOL_TEXT.test(l));
  if (relPath === DEFENSIVE_FILE) {
    if (named.length !== 1 || !DEFENSIVE_LINE.test(named[0])) found.push('the defensive file may name the tool exactly once, as the exact protected-path declaration');
    if (EXEC_PRIMITIVE.test(body)) found.push('the defensive file contains an execution / network / dynamic-load primitive');
    const imports = [...body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    if (imports.some(i => !['node:fs', 'node:os', 'node:path', 'node:url'].includes(i))) found.push('the defensive file imports something other than fs / os / path / url');
  } else if (named.length) {
    found.push('the offline signing tool is referenced or its name assembled');
  }
  if (SIGNING_CAPABILITY.test(body)) found.push('signing capability (signPolicy / passphrase) under src/');
  if ((relPath.startsWith('lib/root-policy/') || relPath === 'routes/root-policy.js') && KEY_CAPABILITY.test(body)) found.push('private-key capability in the Root Policy runtime');
  return found;
}

test('the decision engine is pure: no network, no filesystem, no process, no LLM, no database, no clock-driven randomness', () => {
  for (const file of ['schema.js', 'default-policy.js', 'engine.js', 'route-map.js']) {
    const text = code(read(`lib/root-policy/${file}`));
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const i of imports) assert.ok(i.startsWith('./') || i === 'node:crypto', `${file} imports ${i}`);
    assert.doesNotMatch(text, /\b(fetch|spawn|exec|execFile|readFileSync|writeFileSync|createServer|Math\.random|ollama|runAiTask|completion)\b/i, file);
  }
  for (const file of ['loader.js', 'audit.js', 'index.js']) {
    const text = code(read(`lib/root-policy/${file}`));
    for (const i of [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])) {
      assert.ok(i.startsWith('./') || ['node:crypto', 'node:fs', 'node:path', 'node:url', 'node:async_hooks'].includes(i), `${file} imports ${i}`);
    }
    assert.doesNotMatch(text, /\b(fetch|spawn|execFile|createServer|ollama|runAiTask|routedCompletion|openai|anthropic|gemini)\b/i, `${file}: no network / process / LLM`);
  }
  assert.doesNotMatch(read('lib/root-policy/index.js') + read('lib/root-policy/engine.js'), /sqlite|router\.js|providers\//, 'no database / router / provider dependency');
});

test('IMMUTABILITY: nothing under src/ can write, replace, reload or disable the policy; the offline tool and test seams are never imported', () => {
  const exported = Object.keys(rootPolicy);
  const forbidden = exported.filter(name => /update|write|save|install|replace|disable|override|grant|setPolicy|loadPolicy/i.test(name));
  assert.deepEqual(forbidden, [], 'public surface of the Root Policy runtime');
  for (const f of ALL) {
    assert.deepEqual(signingToolFindings(f.rel, f.text), [], `${f.rel}: offline tool / signing capability`);
    if (!f.rel.startsWith('lib/root-policy/')) {
      if (/root-policy\//.test(f.text)) assert.doesNotMatch(code(f.text), /__testing|createApprovalRegistry/, `${f.rel} uses a Root Policy test seam`);
      assert.doesNotMatch(code(f.text), /root-policy\.json|root-policy\.sig\.json|signing-key/, `${f.rel} touches the policy files`);
    }
  }
  // The only file that reads the policy files is the loader; the only thing the server writes is the tiny anti-rollback state file.
  const loader = code(read('lib/root-policy/loader.js'));
  const writes = [...loader.matchAll(/(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|copyFileSync)\(([^)]*)\)/g)].map(m => m[2]);
  assert.ok(writes.length >= 1 && writes.every(w => /tmp|state\.json/.test(w)), `loader writes: ${writes.join(' | ')}`);
  for (const f of ['lib/root-policy/engine.js', 'lib/root-policy/index.js', 'lib/root-policy/schema.js', 'lib/root-policy/default-policy.js']) {
    assert.doesNotMatch(code(read(f)), /writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|copyFileSync/, f);
  }
});

test('HTTP: the Root Policy API is READ-ONLY and no other route can reach the policy', () => {
  const route = code(read('routes/root-policy.js'));
  assert.doesNotMatch(route, /\.(post|put|patch|delete|all|on)\(/);
  assert.deepEqual([...route.matchAll(/route\.(\w+)\('([^']+)'/g)].map(m => `${m[1]} ${m[2]}`).sort(), ['get /root-policy/policy', 'get /root-policy/status']);
  for (const f of ALL.filter(f => f.rel.startsWith('routes/') && f.rel !== 'routes/root-policy.js')) assert.doesNotMatch(f.text, /root-policy\/index\.js/, `${f.rel}`);
});

test('boot order in server.js: policy loaded BEFORE listening, web hook set, gate mounted after the local API guard, media egress started before serve()', () => {
  const server = read('server.js');
  const at = (needle) => { const i = server.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('initRootPolicy(') < at('const httpServer = serve('));
  assert.ok(at('setEgressPolicyHook(webFetchHook)') < at('const httpServer = serve('));
  assert.ok(at('applyLocalApiSecurity(app') < at('createRootPolicyMiddleware()'));
  assert.ok(at('createRootPolicyMiddleware()') < at("app.route('/api', createHealthRoute"));
  assert.ok(at('await startMediaEgress()') < at('const httpServer = serve('));
  assert.ok(at("createRootPolicyRoute()") > 0);
});

test('CLOUD AI: every provider keeps the single choke point; the choke point asks Root Policy; Groq STT and cloud image providers are gated too', () => {
  for (const f of ['anthropic', 'claude-oauth', 'codex', 'freellmapi', 'gemini', 'groq', 'openai', 'openrouter']) assert.match(read(`lib/providers/${f}.js`), /guardCloudCall\(/, f);
  const guard = code(read('lib/privacy-guard.js'));
  assert.match(guard, /enforceCloudAi\(/); assert.match(guard, /if \(!simulate\)/);
  assert.match(read('lib/whisper-groq.js'), /enforceCloudAi\(/);
  const images = read('lib/image-router.js');
  for (const p of ['cloudflare', 'huggingface', 'pollinations']) assert.match(images, new RegExp(`cloudGate\\('${p}'`), p);
});

test('WEB: the Web Egress Guard asks Root Policy for every entry point (safeFetch, external check, browser / media proxy)', () => {
  const guard = code(read('lib/web-egress-guard.js'));
  const calls = [...guard.matchAll(/checkRootPolicy\('([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(calls, ['external-check', 'proxy', 'proxy', 'safeFetch']);
  assert.match(guard, /refused = true; \}/, 'a hook that throws refuses the request (fail closed)');
});

test('yt-dlp: EVERY launch site prepares through Root Policy + the egress proxy (only `--version` probes are exempt); credentials never reach logs', () => {
  const sites = ['lib/ytdlp.js', 'lib/youtube-discovery.js', 'lib/whisper.js', 'lib/video-audio-download.js'];
  for (const f of sites) { assert.match(read(f), /prepareYtDlp\(/, f); assert.match(read(f), /from '\.\/media-egress\.js'/, f); }
  // Every `YTDLP_BIN` spawn in src/ is in one of those files
  for (const f of ALL.filter(f => /spawn\w*\(\s*YTDLP_BIN|spawnProcess\(\s*YTDLP_BIN|spawnImpl\(\s*YTDLP_BIN/.test(f.text))) assert.ok(sites.includes(f.rel), `${f.rel} spawns yt-dlp without Root Policy`);
  const ytdlp = read('lib/ytdlp.js');
  const spawns = [...ytdlp.matchAll(/(spawn|spawnImpl)\(YTDLP_BIN, ([^,]+),/g)].map(m => m[2]);
  assert.deepEqual(spawns.sort(), ["['--version']", 'args', 'args', 'args'].sort(), 'checkYtDlp (--version) + 3 prepared launches');
  const audio = read('lib/video-audio-download.js');
  assert.match(audio, /const spawnArgs = \[\.\.\.args\.slice\(0, -2\), \.\.\.egressArgs, '--', url\]/);
  assert.ok(audio.indexOf('const safeArgs') < audio.indexOf('const egressArgs'), 'the proxy argument is added after the loggable safeArgs were built');
  assert.match(read('lib/media-egress.js'), /requireAuth: false/, 'no credential in the yt-dlp command line / verbose output');
  // The unit-test seam may only be derived from an injected spawn function, never hard-coded.
  for (const f of ALL) assert.doesNotMatch(code(f.text), /spawnInjected:\s*(true|1)/, `${f.rel}: spawnInjected must be computed from the injected spawn`);
  assert.equal(ALL.filter(f => /spawnInjected:\s*\w+ !== spawn/.test(f.text)).map(f => f.rel).sort().join(), 'lib/video-audio-download.js,lib/youtube-discovery.js,lib/ytdlp.js');
});

test('SUBPROCESS REGISTRY: every file that can start a process is classified; WIRED ones really call Root Policy', () => {
  const importers = ALL.filter(f => /from ['"](node:)?child_process['"]/.test(f.text)).map(f => f.rel).sort();
  const REGISTRY = {
    // WIRED to Root Policy in V1
    'lib/external-agent-process.js': 'WIRED:PROCESS_START',
    'lib/ytdlp.js': 'WIRED:MEDIA', 'lib/youtube-discovery.js': 'WIRED:MEDIA', 'lib/whisper.js': 'WIRED:MEDIA', 'lib/video-audio-download.js': 'WIRED:MEDIA',
    'lib/media-studio.js': 'WIRED:MEDIA', // Media Studio V1: enforce(MEDIA_TRANSCODE) before every ffprobe/ffmpeg start, fixed binaries, argv, shell:false
    'lib/providers/claude-oauth.js': 'WIRED:AI_CLOUD(guardCloudCall)', 'lib/providers/codex.js': 'WIRED:AI_CLOUD(guardCloudCall)',
    // TYPED_INTERNAL: fixed binary in code, typed argv, shell:false, no model-controlled string (Phase C: progressive wiring)
    'lib/browser.js': 'TYPED_INTERNAL', 'lib/code-intel-git.js': 'TYPED_INTERNAL', 'lib/code-intel-search.js': 'TYPED_INTERNAL', 'lib/comfyui-install-manager.js': 'TYPED_INTERNAL',
    'lib/disk-space.js': 'TYPED_INTERNAL', 'lib/kiwix.js': 'TYPED_INTERNAL', 'lib/metagpt-orchestrator.js': 'TYPED_INTERNAL', 'lib/openmontage-adapter.js': 'TYPED_INTERNAL',
    'lib/process-tree.js': 'TYPED_INTERNAL', 'lib/secret-store.js': 'TYPED_INTERNAL', 'lib/sherlock-gateway.js': 'TYPED_INTERNAL',
    // FROZEN / CERTIFIED modules: own approval boundaries, untouched; gated at the HTTP layer (route map) not inside
    'lib/maitre-windows-exec.js': 'FROZEN', 'lib/omega-admin.js': 'FROZEN', 'lib/omega-indicator.js': 'FROZEN', 'lib/omega-outbound-network.js': 'FROZEN',
    'lib/omega-windows-exec.js': 'FROZEN', 'lib/monitor-collector.js': 'FROZEN',
  };
  assert.deepEqual(importers, Object.keys(REGISTRY).sort(), 'a process-capable file was added/removed without being classified');
  assert.match(read('lib/external-agent-process.js'), /enforce\(\{ action: 'PROCESS_START'/);
  for (const f of ['lib/providers/claude-oauth.js', 'lib/providers/codex.js']) assert.match(read(f), /guardCloudCall\(/, f);
  // `shell: true` is a PRE-EXISTING finding, kept visible here: exactly four probe sites in the two CLI providers (fixed `--version` / `auth status` /
  // `login status` arguments, no model- or user-controlled argument; `cliPath` comes from the CLI resolver). A new occurrence anywhere fails this audit.
  const shellTrue = Object.fromEntries(ALL.map(f => [f.rel, (code(f.text).match(/shell:\s*true/g) ?? []).length]).filter(([, n]) => n > 0));
  assert.deepEqual(shellTrue, { 'lib/providers/claude-oauth.js': 2, 'lib/providers/codex.js': 2 });
  for (const f of ['lib/providers/claude-oauth.js', 'lib/providers/codex.js']) {
    for (const m of code(read(f)).matchAll(/execFile\([^,]+, (\[[^\]]*\]), \{ timeout: PROBE_TIMEOUT_MS, shell: true \}/g)) assert.match(m[1], /^\['(--version|auth|login)'(, '(status)')?\]$/, `${f}: probe args must stay literal`);
  }
});

test('CERTIFIED DEVICE ROUTES: every route of OMEGA / RASSILON / Device Fabric / MAÎTRE is gated or explicitly listed as ungated (a new route cannot slip through)', () => {
  const files = ['omega.js', 'omega-view.js', 'omega-interactive.js', 'omega-admin.js', 'omega-outbound.js', 'rassilon.js', 'rassilon-lan.js', 'device-fabric.js', 'maitre.js'];
  // Ungated = inventory / status / pairing / settings / approve-deny / audit / reads: they act on Docteur's OWN registry or are certified approvals.
  const UNGATED = [
    /\/(status|devices|identity|audit|sessions|settings|jobs|pairing|challenge|trust|incidents|events|evidence|processes|persistence|defender|isolation|overview|agents|hosts|actions|screens|probe|operations)(\/|$)/,
    /\/(enable|disable|pause|resume|link|revoke|approve|deny|complete|confirm|reject|heartbeat|request|verify|start|analyze|propose|request-approval|approve-local|deny-local|cancel|validate)(\/|$)/,
  ];
  const problems = [];
  let gated = 0; let ungated = 0; let total = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(SRC, 'routes', f), 'utf8');
    for (const m of text.matchAll(/(?:route|app)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      total++;
      const method = m[1].toUpperCase();
      const route = `/api${m[2].replace(/:[A-Za-z]+/g, 'x')}`;
      if (classifyRoute(method, route)) { gated++; continue; }
      // Local approvals / denials and plain reads are certified module flows, not requests for an action
      if (/\/(approve-local|deny-local|approve|deny)$/.test(route) || (method === 'GET' && UNGATED.some(re => re.test(route)))) { ungated++; continue; }
      // Anything with a dangerous verb in it must be gated: it cannot hide behind the ungated patterns
      if (/\/(input|frame|execute|lock|logoff|restart|shutdown|stop|stop-all|dispatch)(\/|$)/.test(route) || /\/(view|interactive|admin)\/(start|input|frame|actions)/.test(route)) { problems.push(`${method} ${route}: dangerous verb but not gated`); continue; }
      if (UNGATED.some(re => re.test(route))) { ungated++; continue; }
      problems.push(`${method} ${route}: neither gated nor in the ungated inventory`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(gated >= 30 && total > gated, `gated ${gated} / ungated ${ungated} / total ${total}`);
  assert.ok(ROUTE_MAP_SIZE >= 20);
});

test('the route map recognises STOP / revocation routes as STOP-class (they must always pass, even with an invalid policy)', () => {
  const stops = [['POST', '/api/omega/outbound/stop-all'], ['POST', '/api/omega/outbound/sessions/s1/stop'], ['POST', '/api/omega/view/s1/stop'], ['POST', '/api/omega/interactive/s1/stop'],
    ['DELETE', '/api/omega/sessions/s1'], ['POST', '/api/omega/devices/d1/revoke'], ['POST', '/api/device-fabric/omega-v2/stop-all'], ['POST', '/api/device-fabric/devices/d1/omega-v2/stop'],
    ['POST', '/api/rassilon/stop'], ['POST', '/api/omega-v2/sessions/s1/view/stop'], ['POST', '/api/rassilon-lan/jobs/j1/cancel']];
  for (const [m, p] of stops) assert.equal(classifyRoute(m, p)?.action, 'DEVICE_STOP', `${m} ${p}`);
  assert.equal(classifyRoute('GET', '/api/omega/status'), null);
  assert.equal(classifyRoute('POST', '/api/capture'), null);
});

test('FROZEN modules: none imports Root Policy; none of their files differs from HEAD', () => {
  const FROZEN = /^lib\/(device-fabric|omega|rassilon|maitre|monitor|cyber|notebook|chat-memory|local-request-guard|local-api-policy)/;
  for (const f of ALL.filter(f => FROZEN.test(f.rel) || /^routes\/(device-fabric|omega|rassilon|maitre|monitor|cyber|notebook)/.test(f.rel))) assert.doesNotMatch(f.text, /root-policy|media-egress/, f.rel);
  const git = spawnSync('git', ['status', '--porcelain', '--', 'src/lib/device-fabric*', 'src/lib/omega*', 'src/lib/rassilon*', 'src/lib/maitre*', 'src/lib/monitor*', 'src/lib/cyber*', 'src/routes/device-fabric.js', 'src/routes/omega*', 'src/routes/rassilon*', 'src/routes/maitre.js', 'src/routes/monitor.js', 'src/routes/cyber-audit.js'], { cwd: HERE, encoding: 'utf8', windowsHide: true });
  if (git.status === 0) assert.equal(git.stdout.trim(), '', `frozen files modified:\n${git.stdout}`);
});

test('SIGNING TOOL (RPC-2C): the real tree is clean, a DEFENSIVE path reference is allowed, every way to RUN, import, assemble or re-implement signing is detected', () => {
  // the real defensive file is accepted, and nothing else under src/ names or assembles the tool
  const real = ALL.find(f => f.rel === DEFENSIVE_FILE);
  assert.ok(real, 'the defensive file exists');
  assert.deepEqual(signingToolFindings(DEFENSIVE_FILE, real.text), []);
  assert.equal(ALL.filter(f => f.rel !== DEFENSIVE_FILE && TOOL_TEXT.test(code(f.text))).length, 0);

  const DECL = "const files = [\n  path.join(CORTEX_SERVER, 'root-policy-tool.mjs'),\n];";
  const SAFE_HEAD = "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n";
  const defensive = (extra = '') => `${SAFE_HEAD}${DECL}\n${extra}`;

  // ALLOWED: the defensive reference (and mentions in comments, which are documentation)
  assert.deepEqual(signingToolFindings(DEFENSIVE_FILE, defensive()), []);
  assert.deepEqual(signingToolFindings(DEFENSIVE_FILE, `// see root-policy-tool.mjs\n/**\n * root-policy-tool.mjs signs offline\n */\n${defensive()}`), []);
  assert.deepEqual(signingToolFindings('lib/other.js', '// the human signs with root-policy-tool.mjs (offline)\nexport const x = 1;\n'), []);

  // DETECTED: execution, import, assembly, re-implementation — in any other file …
  const bad = {
    'import of the tool': "import { signPolicy } from '../../root-policy-tool.mjs';",
    'dynamic import': "const t = await import('./root-policy-tool.mjs');",
    'spawn of the tool': "spawn(process.execPath, ['root-policy-tool.mjs', 'sign', '--yes']);",
    'execFile of the tool by path': "execFile('node', [path.join(HERE, 'root-policy-tool.mjs')]);",
    'name assembled with join (the RPC-2B workaround)': "const f = ['root-policy', 'tool.mjs'].join('-');",
    'name assembled with +': "const f = 'root-policy' + '-tool' + '.mjs';",
    'bare fragment': "const f = path.join(dir, 'tool.mjs');",
    'signPolicy call (reseal)': "signPolicy({ policy, privateKeyPem, publicKeyPem, policyDir });",
    'passphrase for unattended signing': "process.env.ROOT_POLICY_PASSPHRASE = secret;",
  };
  for (const [label, text] of Object.entries(bad)) assert.notDeepEqual(signingToolFindings('lib/some-runtime.js', text), [], `must detect: ${label}`);
  // … including a signing / key capability inside the Root Policy runtime itself
  for (const text of ["crypto.sign(null, data, key);", "crypto.createPrivateKey(pem);", "crypto.generateKeyPairSync('ed25519');", "crypto.createSign('sha256');"]) {
    assert.notDeepEqual(signingToolFindings('lib/root-policy/engine.js', text), [], `must detect in the engine: ${text}`);
    assert.notDeepEqual(signingToolFindings('routes/root-policy.js', text), [], `must detect in the route: ${text}`);
  }

  // … and the defensive exception is NARROW: it cannot be used to execute, to name the tool twice, or to change the declaration
  const narrow = {
    'spawn in the defensive file': defensive("import { spawn } from 'node:child_process';\nspawn('node', [path.join(CORTEX_SERVER, 'root-policy-tool.mjs')]);"),
    'child_process import': `import { execFile } from 'node:child_process';\n${defensive()}`,
    'second mention of the tool': defensive("const again = path.join(CORTEX_SERVER, 'root-policy-tool.mjs');"),
    'declaration used as an argument': `${SAFE_HEAD}execFileSync('node', [path.join(CORTEX_SERVER, 'root-policy-tool.mjs')]);`,
    'declaration changed (different line shape)': `${SAFE_HEAD}const tool = require('./root-policy-tool.mjs');`,
    'dynamic import': defensive('await import(someVariable);'),
    'network primitive': defensive("await fetch('https://example.invalid');"),
    'extra import': `import crypto from 'node:crypto';\n${defensive()}`,
    'assembled name next to the declaration': defensive("const f = ['root-policy', 'tool.mjs'].join('-');"),
    'eval': defensive('eval(code);'),
    'no declaration at all is not a pass for a hidden one': `${SAFE_HEAD}const x = 'root-policy' + '-tool.mjs';`,
  };
  for (const [label, text] of Object.entries(narrow)) assert.notDeepEqual(signingToolFindings(DEFENSIVE_FILE, text), [], `defensive exception must not allow: ${label}`);
});

test('NO second ADMIN engine: Root Policy contains no OMEGA admin vocabulary (no LOCK / LOGOFF / RESTART / SHUTDOWN handling of its own)', () => {
  const text = ['engine.js', 'index.js', 'route-map.js'].map(f => code(read(`lib/root-policy/${f}`))).join('\n');
  assert.doesNotMatch(text, /\b(LOGOFF|SHUTDOWN|GET_SYSTEM_INFO|PROCESS_LIST|SERVICE_STATUS)\b/);
});
