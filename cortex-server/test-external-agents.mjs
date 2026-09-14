import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExternalAgents, classifyFailure } from './src/lib/external-agents.js';
import { filteredEnv, sanitize, checkedPath, authorizeRoot } from './src/lib/external-agent-policy.js';
import { lineSink, commandArgs, launchProcess, resolveCli } from './src/lib/external-agent-process.js';
import { createExternalAgentsRoute } from './src/routes/external-agents.js';

function fixture(t, options = {}) {
  const testRoot = path.resolve('.tmp/external-agent-tests'); fs.mkdirSync(testRoot, {recursive: true});
  const root = fs.mkdtempSync(path.join(testRoot, 'fixture-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'sample.ts'), 'export const value = 1;\n');
  const calls = [];
  const launch = config => {
    calls.push(config);
    let resolve;
    const done = new Promise(r => resolve = r);
    queueMicrotask(() => {
      const emit = line => config.onLine?.('stdout', sanitize(line));
      if (config.args.includes('--version')) emit(config.executable.command === 'codex' ? 'codex-cli 0.153.4' : '2.1.248 (Claude Code)');
      else if (config.args.includes('--help')) emit('--ignore-user-config --ephemeral --json --restricted --safe-mode --tools --no-session-persistence');
      else if (config.args.includes('status')) { resolve({exitCode: options.authCode ?? 0}); return; }
      else {
        if (options.hold) return;
        options.run?.(config);
        emit(options.output ?? '{"type":"result","result":"done"}');
        resolve({exitCode: options.exitCode ?? 0, reason: options.reason}); return;
      }
      resolve({exitCode: 0});
    });
    return {done, stop(reason) { resolve({exitCode: null, reason}); }};
  };
  const service = new ExternalAgents({projectRoot: project, dataDir: path.join(root, 'history'), launch, resolve: p => options.absent ? null : {command: p, prefix: []}, strictLocal: options.strictLocal});
  t.after(async () => { await service.shutdown(); assert.equal(path.dirname(root), testRoot); fs.rmSync(root, {recursive: true, force: true}); });
  const input = {provider: 'codex', feature: 'code_analysis', prompt: 'Analyse ce fichier.', cwd: project, files: ['sample.ts'], mode: 'read', permissions: 'SAFE'};
  return {root, project, service, calls, input};
}
async function terminal(service, id) {
  const finished = j => ['completed', 'failed', 'timeout', 'cancelled'].includes(j.status);
  if (finished(service.get(id))) return service.get(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { service.off('job', listener); reject(new Error('test job did not finish')); }, 3000);
    const listener = j => { if (j.id === id && finished(j)) { clearTimeout(timer); service.off('job', listener); resolve(j); } };
    service.on('job', listener);
  });
}
async function start(f, overrides = {}) {
  const job = f.service.preview({...f.input, ...overrides});
  await f.service.approve(job.id, true); return terminal(f.service, job.id);
}
test('Codex absent et Claude absent', async t => {
  const f = fixture(t, {absent: true});
  assert.deepEqual((await f.service.detect()).codex, {installed: false, ready: false, reason: 'not_installed', version: null});
  assert.equal((await f.service.detect()).claude.reason, 'not_installed');
});
test('détection officielle : version, aide et auth seulement, aucune inférence', async t => {
  const f = fixture(t); const clients = await f.service.detect();
  assert.equal(clients.codex.ready, true); assert.equal(clients.claude.ready, true);
  assert.equal(f.calls.length, 6); assert.ok(f.calls.every(c => !c.input));
  assert.ok(!JSON.stringify(clients).includes('credential'));
});
test('auth manquante classifiée', async t => { const f = fixture(t, {authCode: 1}); assert.equal((await f.service.probe('codex')).reason, 'authentication_required'); });
test('un job ne part pas avant confirmation et refus ne lance rien', async t => {
  const f = fixture(t); const job = f.service.preview(f.input);
  assert.equal(job.status, 'waiting_approval'); assert.equal(f.calls.length, 0);
  assert.equal((await f.service.approve(job.id, false)).status, 'cancelled'); assert.equal(f.calls.length, 0);
});
test('succès, prompt stdin et historique sans prompt intégral', async t => {
  const f = fixture(t); const job = await start(f);
  assert.equal(job.status, 'completed'); assert.equal(job.exit_code, 0);
  const run = f.calls.at(-1); assert.ok(run.input.includes(f.input.prompt)); assert.ok(!run.args.includes(f.input.prompt));
  assert.ok(!fs.readFileSync(f.service.historyFile, 'utf8').includes(f.input.prompt));
});
test('erreur et quota sans boucle ni fallback automatique', async t => {
  const f = fixture(t, {exitCode: 1, output: 'usage limit reached'}); const job = await start(f);
  assert.equal(job.status, 'failed'); assert.equal(job.error, 'quota_exhausted');
  assert.equal(f.calls.filter(c => c.input).length, 1); assert.equal(f.service.settings().fallback, 'ask');
});
test('événement structuré erreur malgré exit 0', async t => {
  const f = fixture(t, {output: '{"type":"turn.failed","error":{"message":"authentication required"}}'});
  assert.equal((await start(f)).error, 'authentication_required');
});
test('timeout marque le job', async t => { const f = fixture(t, {reason: 'timeout', exitCode: null}); assert.equal((await start(f)).status, 'timeout'); });
test('cancel conserve les logs et termine le job', async t => {
  const f = fixture(t, {hold: true}); const job = f.service.preview(f.input); await f.service.approve(job.id, true);
  await new Promise(resolve => { const poll = () => f.calls.some(c => c.input) ? resolve() : setImmediate(poll); poll(); });
  f.calls.at(-1).onLine('stdout', 'partial output'); f.service.cancel(job.id);
  const result = await terminal(f.service, job.id); assert.equal(result.status, 'cancelled'); assert.match(result.output, /partial output/);
});
test('env : seuls noms système autorisés, casse comprise', () => {
  const env = filteredEnv({PATH: 'x', SystemRoot: 'win', HOME: 'home', OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake', GROQ_API_KEY: 'fake', GEMINI_API_KEY: 'fake', OPENROUTER_API_KEY: 'fake', NODE_OPTIONS: '--require bad', CODEX_HOME: 'alternate-session', CORTEX_TOKEN: 'fake', OTHER: 'private'});
  assert.deepEqual(env, {PATH: 'x', SystemRoot: 'win', HOME: 'home'});
});
test('redaction sur tokens, cookies, clés, JWT et chunks séparés', () => {
  const lines = []; const sink = lineSink(line => lines.push(line));
  sink.write(Buffer.from('sk-abcdef')); assert.equal(lines.length, 0);
  sink.write(Buffer.from('ghijklmnopqrst\nAuthorization: Bearer abcdefghijk\nrefresh_token=abcdefghi\nCookie: session=private\n'));
  sink.end(); const text = lines.join('\n');
  for (const secret of ['abcdefghijklmnopqrst', 'abcdefghijk', 'abcdefghi', 'session=private']) assert.ok(!text.includes(secret));
  assert.equal(sanitize('eyJabcdefgh.abcdefgh.abcdefghi'), '[REDACTED]');
});
test('clé privée multi-lignes et ligne trop longue supprimées', () => {
  const lines = []; const sink = lineSink(l => lines.push(l));
  sink.write(Buffer.from('-----BEGIN PRIVATE KEY-----\nprivatebytes\n-----END PRIVATE KEY-----\n' + 'x'.repeat(70000) + '\n'));
  sink.end(); assert.ok(!lines.join('').includes('privatebytes')); assert.match(lines.at(-1), /OMITTED/);
});
test('path traversal, chemins absolus, ADS, dossiers auth, racines disque refusés', t => {
  const f = fixture(t);
  for (const file of ['../sample.ts', '/tmp/a.ts', 'C:\\x.ts', 'sample.ts:stream', '.codex/auth.json', '.ssh/id_rsa', 'credentials.json', 'nul.txt']) assert.throws(() => f.service.preview({...f.input, files: [file]}));
  assert.throws(() => authorizeRoot(path.parse(f.project).root));
  assert.throws(() => f.service.preview({...f.input, cwd: f.root}), /workspace_not_authorized/);
});
test('junction hors workspace refusée sans lire sa cible', t => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'outside.ts'), 'outside');
  fs.symlinkSync(outside, path.join(f.project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => checkedPath(f.project, 'escape/outside.ts'), /symlink_denied/);
});
test('lecture seule refuse toute modification produite par le mock', async t => {
  const f = fixture(t, {run: c => fs.writeFileSync(path.join(c.cwd, 'sample.ts'), 'changed')});
  assert.equal((await start(f)).error, 'read_only_violation'); assert.match(fs.readFileSync(path.join(f.project, 'sample.ts'), 'utf8'), /value = 1/);
});
test('édition isolée, diff, acceptation et rollback sans git destructif', async t => {
  const f = fixture(t, {run: c => { fs.writeFileSync(path.join(c.cwd, 'sample.ts'), 'export const value = 2;\n'); fs.writeFileSync(path.join(c.cwd, 'new.ts'), 'new file'); }});
  const job = await start(f, {mode: 'edit', permissions: 'EDIT'});
  assert.equal(job.review, 'pending'); assert.equal(job.changes.length, 2); assert.match(job.changes[0].diff, /value = 2/);
  assert.match(fs.readFileSync(path.join(f.project, 'sample.ts'), 'utf8'), /value = 1/);
  f.service.review(job.id, true); assert.match(fs.readFileSync(path.join(f.project, 'sample.ts'), 'utf8'), /value = 2/);
  f.service.undo(job.id); assert.match(fs.readFileSync(path.join(f.project, 'sample.ts'), 'utf8'), /value = 1/); assert.equal(fs.existsSync(path.join(f.project, 'new.ts')), false);
});
test('refus changements conserve le projet', async t => {
  const f = fixture(t, {run: c => fs.unlinkSync(path.join(c.cwd, 'sample.ts'))});
  const job = await start(f, {mode: 'edit', permissions: 'EDIT'}); assert.equal(job.changes[0].kind, 'deleted');
  f.service.review(job.id, false); assert.ok(fs.existsSync(path.join(f.project, 'sample.ts')));
});
test('conflit avec travail utilisateur interdit acceptation et undo', async t => {
  const f = fixture(t, {run: c => fs.writeFileSync(path.join(c.cwd, 'sample.ts'), 'agent change')});
  const job = await start(f, {mode: 'edit', permissions: 'EDIT'});
  fs.writeFileSync(path.join(f.project, 'sample.ts'), 'user change');
  assert.throws(() => f.service.review(job.id, true), /review_conflict/);
  assert.equal(fs.readFileSync(path.join(f.project, 'sample.ts'), 'utf8'), 'user change');
});
test('commandes dangereuses et modes non protégés bloqués', t => {
  const f = fixture(t);
  for (const prompt of ['git push --force', 'git reset --hard', 'git clean -fd', 'npm publish', 'sudo do-something', 'git commit -am message']) assert.throws(() => f.service.preview({...f.input, prompt}), /dangerous_action_denied/);
  assert.throws(() => f.service.preview({...f.input, permissions: 'FULL'}), /mode_unsupported/);
});
test('strict local gagne même après la prévisualisation', async t => {
  let strict = false; const f = fixture(t, {strictLocal: () => strict}); const job = f.service.preview(f.input); strict = true;
  await assert.rejects(f.service.approve(job.id, true), /strict_local/); assert.equal(f.calls.length, 0);
});
test('neurones, chat et autres usages LLM exclus', t => {
  const f = fixture(t); for (const feature of ['chat', 'vision', 'teacher', 'research', 'embedding', 'video']) assert.throws(() => f.service.preview({...f.input, feature}), /feature_incompatible/);
});
test('aucun token dans prompt accepté, logs stockés ou historique', async t => {
  const fake = 'sk-fixtureabcdefghijklmnop'; const f = fixture(t, {output: `failure ${fake}`});
  assert.throws(() => f.service.preview({...f.input, prompt: fake}), /secret_or_credentials_denied/);
  await start(f); assert.ok(!fs.readFileSync(f.service.historyFile, 'utf8').includes(fake));
  f.service.deleteHistory(); assert.deepEqual(JSON.parse(fs.readFileSync(f.service.historyFile, 'utf8')), []);
});
test('racine supplémentaire nécessite confirmation distincte', t => {
  const f = fixture(t); const root = path.join(f.root, 'second'); fs.mkdirSync(root);
  const preview = f.service.requestRoot(root); assert.ok(!f.service.roots.includes(root));
  f.service.approveRoot(preview.id, true); assert.ok(f.service.roots.includes(root));
  assert.throws(() => f.service.approveRoot(preview.id, true), /approval_expired/);
});
test('révisions EDIT sérialisées jusqu’à décision sur les changements', async t => {
  const f = fixture(t, {run: c => fs.writeFileSync(path.join(c.cwd, 'sample.ts'), 'edit')});
  const first = await start(f, {mode: 'edit', permissions: 'EDIT'});
  const next = f.service.preview({...f.input, mode: 'edit', permissions: 'EDIT'}); await f.service.approve(next.id, true);
  assert.equal(f.service.get(next.id).status, 'queued'); f.service.review(first.id, false);
  assert.equal((await terminal(f.service, next.id)).status, 'completed');
});
test('commandes natives : aucune désactivation de sandbox, shell/MCP bloqués', () => {
  const codex = commandArgs('codex', {cwd: 'C:\\test path', permissions: 'SAFE'}).join(' ');
  assert.match(codex, /permissions.docteur.filesystem/); assert.match(codex, /features.shell_tool=false/);
  assert.ok(!codex.includes('danger-full-access')); assert.ok(!codex.includes('bypass'));
  const claude = commandArgs('claude', {cwd: 'C:\\test path'});
  assert.ok(claude.includes('--restricted')); assert.ok(claude.includes('Read,Glob,Grep')); assert.ok(!claude.includes('bypassPermissions'));
});
test('API locale : refus réseau et origin hostile, confirmation et strict local', async t => {
  const f = fixture(t);
  const denied = createExternalAgentsRoute({service: f.service, isLocal: () => false});
  assert.equal((await denied.request('/external-agents/settings')).status, 403);
  const route = createExternalAgentsRoute({service: f.service, isLocal: () => true});
  assert.equal((await route.request('http://evil.example/external-agents/settings')).status, 403);
  assert.equal((await route.request('/external-agents/settings', {headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await route.request('/external-agents/jobs', {method: 'POST', body: '{}'})).status, 415);
  const response = await route.request('/external-agents/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(f.input)});
  assert.equal(response.status, 201); assert.equal((await response.json()).status, 'waiting_approval'); assert.equal(f.calls.length, 0);
});
test('processus réel Node : timeout et stdout secret fractionné, sans CLI payant', {timeout: 10000}, async () => {
  const lines = [];
  const process = launchProcess({executable: {command: globalThis.process.execPath, prefix: []}, args: ['-e', 'process.stdout.write("sk-fixture");setTimeout(()=>process.stdout.write("abcdefghijklmnop\\n"),20);setInterval(()=>{},1000)'], cwd: os.tmpdir(), timeout: 500, onLine: (_, line) => lines.push(line)});
  const result = await process.done; assert.equal(result.reason, 'timeout'); assert.ok(!lines.join('').includes('fixtureabcdefghijklmnop'));
});
test('processus réel Windows/POSIX : annulation termine aussi le processus enfant', {timeout: 15000}, async () => {
  let descendant;
  const runner = launchProcess({executable: {command: process.execPath, prefix: []}, args: ['-e', 'const {spawn}=require("child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);setInterval(()=>{},1000);'], cwd: os.tmpdir(), timeout: 10000, onLine: (_, line) => { descendant = Number(line); runner.stop(); }});
  const result = await runner.done; assert.equal(result.reason, 'cancelled'); assert.ok(descendant);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.throws(() => process.kill(descendant, 0));
});
test('résolution .cmd : préfère entrée npm officielle, sans shell', t => {
  const f = fixture(t); const dir = path.join(f.root, 'bin with spaces'); const entry = path.join(dir, 'node_modules/@openai/codex/bin'); fs.mkdirSync(entry, {recursive: true}); fs.writeFileSync(path.join(entry, 'codex.js'), '');
  const cli = resolveCli('codex', {PATH: dir}, 'win32'); assert.equal(cli.command, process.execPath); assert.ok(cli.prefix[0].endsWith('codex.js'));
});
