// ROOT POLICY V1 CLOSURE — RPC-2B: AI-driven apply paths (external agents, MetaGPT) can never create / overwrite / delete / move
// a file of the Root Policy perimeter — and every legitimate write keeps working.
// Everything runs in temporary directories. The real policy, engine and state are only ever READ (path decisions, no I/O on them).
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRootPolicyProtected, assertNotRootPolicyPath, rootPolicyProtectedPaths, canonicalForProtection } from './src/lib/root-policy/protected-paths.js';
import { checkedPath, checkedMutationPath, sanitize } from './src/lib/external-agent-policy.js';
import { ExternalAgents } from './src/lib/external-agents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const BS = String.fromCharCode(92);

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rpc2b-')));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const put = (p, text = 'x\n') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

// ── a miniature repository with the same shape as the real one ───────────────────────────────────────────────────────────
const repo = path.join(scratch, 'repo');
const cs = path.join(repo, 'cortex-server');
const tree = {
  policyJson: put(path.join(cs, 'policy', 'root-policy.json'), '{"v":1}'),
  policySig: put(path.join(cs, 'policy', 'root-policy.sig.json'), '{"sig":1}'),
  policyLog: put(path.join(cs, 'policy', 'signing-log.jsonl'), '{}\n'),
  recovery: put(path.join(cs, 'policy', 'recovery', 'root-policy.json'), '{}'),
  engine: put(path.join(cs, 'src', 'lib', 'root-policy', 'engine.js'), '//'),
  anchors: put(path.join(cs, 'src', 'lib', 'root-policy', 'trust-anchors.js'), '//'),
  route: put(path.join(cs, 'src', 'routes', 'root-policy.js'), '//'),
  tool: put(path.join(cs, 'root-policy-tool.mjs'), '//'),
  state: put(path.join(cs, 'data', 'root-policy', 'state.json'), '{"highestVersionSeen":1}'),
  audit: put(path.join(cs, 'data', 'root-policy', 'audit.jsonl'), ''),
  // innocent neighbours: similar names, similar prefixes, tests, reports, docs, ordinary code
  backup: put(path.join(cs, 'policy-backup', 'root-policy.json')),
  policy2: put(path.join(cs, 'policy2', 'x.json')),
  policyNotes: put(path.join(cs, 'policy-notes.txt')),
  libNotes: put(path.join(cs, 'src', 'lib', 'root-policy-notes.txt')),
  libOther: put(path.join(cs, 'src', 'lib', 'root-policy2', 'x.js')),
  routeDocs: put(path.join(cs, 'src', 'routes', 'root-policy-docs.md')),
  routeBak: put(path.join(cs, 'src', 'routes', 'root-policy.js.bak')),
  testFile: put(path.join(cs, 'test-root-policy-engine.mjs'), '//'),
  report: put(path.join(repo, 'reports', 'ROOT_POLICY_V1_2026-10.md'), '# r'),
  ordinary: put(path.join(cs, 'src', 'lib', 'router.js'), '//'),
  notebook: put(path.join(cs, 'src', 'lib', 'notebook-docs-store.js'), '//'),
  media: put(path.join(cs, 'src', 'lib', 'ytdlp.js'), '//'),
  dataOther: put(path.join(cs, 'data', 'images', 'out.png'), 'png'),
  dataLookalike: put(path.join(cs, 'data', 'root-policy-export', 'a.json')),
};
const PERIMETER = {
  dirs: [path.join(cs, 'policy'), path.join(cs, 'src', 'lib', 'root-policy'), path.join(cs, 'data', 'root-policy')],
  files: [path.join(cs, 'src', 'routes', 'root-policy.js'), path.join(cs, 'root-policy-tool.mjs')],
};
const blocked = (p) => isRootPolicyProtected(p, { paths: PERIMETER });
const rel = (p) => path.relative(process.cwd(), p);

// ═════════════════════════════ NEGATIVE — direct, any operation (write / create / overwrite / delete / rename / move share ONE decision) ═════════
test('NEGATIVE: every file and directory of the perimeter is protected — existing or not-yet-created', () => {
  for (const key of ['policyJson', 'policySig', 'policyLog', 'recovery', 'engine', 'anchors', 'route', 'tool', 'state', 'audit']) assert.equal(blocked(tree[key]), true, key);
  assert.equal(blocked(path.join(cs, 'policy')), true, 'the directory itself');
  assert.equal(blocked(path.join(cs, 'policy', 'brand-new.json')), true, 'CREATE inside');
  assert.equal(blocked(path.join(cs, 'policy', 'deep', 'er', 'new.json')), true, 'CREATE in a not-yet-existing subdirectory');
  assert.equal(blocked(path.join(cs, 'src', 'lib', 'root-policy', 'evil.js')), true);
  assert.equal(blocked(path.join(cs, 'data', 'root-policy', 'state.json.tmp')), true);
});

test('NEGATIVE: traversal, dot segments, mixed and doubled separators, trailing separator all land in the perimeter and are blocked', () => {
  const j = tree.policyJson;
  const variants = [
    path.join(cs, 'policy', '..', 'policy', 'root-policy.json'),
    path.join(cs, 'src', '..', 'policy', 'root-policy.json'),
    path.join(cs, 'src', 'lib', '..', '..', 'policy', 'root-policy.json'),
    path.join(cs, 'policy', '.', 'root-policy.json'),
    j.replaceAll(BS, '/'),
    j.replaceAll(BS, '//'),
    `${path.join(cs, 'policy')}/${BS}root-policy.json`,
    j.replace('policy', `policy${BS}${BS}${BS}`),
    `${path.join(cs, 'policy')}${path.sep}`,
    `${path.join(cs, 'policy')}/`,
    rel(j),                                   // relative to the current directory
    rel(j).replaceAll(BS, '/'),
    path.join(cs, 'src', 'lib', 'root-policy', '..', 'root-policy', 'engine.js'),
  ];
  for (const v of variants) assert.equal(blocked(v), true, `must block ${v}`);
});

test('NEGATIVE (Windows): case differences, trailing dots and spaces, verbatim prefix do not escape', { skip: !win }, () => {
  const upper = tree.policyJson.toUpperCase();
  assert.equal(blocked(upper), true, 'upper case');
  assert.equal(blocked(tree.engine.replace('root-policy', 'ROOT-Policy')), true, 'mixed case');
  assert.equal(blocked(tree.tool.toUpperCase()), true, 'exact file, other case');
  assert.equal(blocked(path.join(cs, 'policy.', 'root-policy.json')), true, 'trailing dot on a directory');
  assert.equal(blocked(path.join(cs, 'policy ', 'root-policy.json')), true, 'trailing space on a directory');
  assert.equal(blocked(path.join(cs, 'policy', 'root-policy.json.')), true, 'trailing dot on the file');
  assert.equal(blocked(path.join(cs, 'policy', 'root-policy.json ')), true, 'trailing space on the file');
  assert.equal(blocked(path.join(cs, 'src', 'routes', 'root-policy.js.')), true);
  assert.equal(blocked(`${BS}${BS}?${BS}${tree.policyJson}`), true, 'verbatim \\\\?\\ prefix');
});

test('NEGATIVE (Windows): an alias through a junction cannot reach the perimeter', { skip: !win }, () => {
  const work = path.join(scratch, 'workspace'); fs.mkdirSync(work, { recursive: true });
  const link = path.join(work, 'innocent');
  fs.symlinkSync(path.join(cs, 'policy'), link, 'junction');
  assert.equal(blocked(path.join(link, 'root-policy.json')), true, 'existing file through the junction');
  assert.equal(blocked(path.join(link, 'new.json')), true, 'CREATE through the junction');
  assert.equal(blocked(path.join(link, 'recovery', 'x.json')), true, 'nested CREATE through the junction');
  assert.equal(blocked(link), true, 'the junction itself designates the perimeter');
  const libLink = path.join(work, 'engine-alias'); fs.symlinkSync(path.join(cs, 'src', 'lib', 'root-policy'), libLink, 'junction');
  assert.equal(blocked(path.join(libLink, 'engine.js')), true);
  // a junction to an innocent folder is not blocked
  const okLink = path.join(work, 'ordinary'); fs.symlinkSync(path.join(cs, 'src', 'lib', 'root-policy2'), okLink, 'junction');
  assert.equal(blocked(path.join(okLink, 'x.js')), false);
});

test('NEGATIVE: a FILE symbolic link cannot alias a protected file, even a dangling one (needs symlink privilege — reported as SKIPPED, never as passed, without it)', (t) => {
  const work = path.join(scratch, 'ws-symlinks'); fs.mkdirSync(work, { recursive: true });
  try {
    fs.symlinkSync(tree.policyJson, path.join(work, 'file-alias.json'), 'file');
    fs.symlinkSync(path.join(cs, 'policy', 'not-yet.json'), path.join(work, 'dangling.json'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      // NOT_EXECUTED_ENVIRONMENT_LIMITATION: creating a file symlink needs SeCreateSymbolicLinkPrivilege (elevation / Developer Mode). We do not elevate the machine to
      // manufacture a pass. The same code path is exercised without privilege by the junction tests and by the dangling-junction test below.
      t.skip(`NOT_EXECUTED_ENVIRONMENT_LIMITATION: file symlink creation refused (${error.code})`);
      return;
    }
    throw error;
  }
  assert.equal(blocked(path.join(work, 'file-alias.json')), true, 'link to an existing protected file');
  assert.equal(blocked(path.join(work, 'dangling.json')), true, 'link that would CREATE a protected file');
});

test('NEGATIVE (Windows, no privilege needed): a DANGLING junction (its target removed) that pointed into the perimeter is still refused — readlink fallback', { skip: !win }, () => {
  const work = path.join(scratch, 'ws-dangling'); fs.mkdirSync(work, { recursive: true });
  // 1. a junction whose target sits INSIDE the perimeter and is then removed => the OS can no longer resolve it (realpath fails, lstat still sees the link)
  const inner = path.join(cs, 'policy', 'will-vanish'); fs.mkdirSync(inner, { recursive: true });
  const link = path.join(work, 'dangling-into-policy'); fs.symlinkSync(inner, link, 'junction');
  fs.rmdirSync(inner);
  assert.throws(() => fs.realpathSync.native(link), 'precondition: the link is really dangling for the OS');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'precondition: lstat still sees the junction');
  assert.equal(blocked(path.join(link, 'new.json')), true, 'CREATE through the dangling junction would land in policy/ — refused');
  assert.equal(blocked(link), true, 'the dangling junction itself designates the perimeter');
  // 2. a dangling junction that pointed at an ordinary place stays usable: an unresolvable ordinary entry never becomes unwritable
  const ordinary = path.join(work, 'will-vanish-too'); fs.mkdirSync(ordinary);
  const okLink = path.join(work, 'dangling-ordinary'); fs.symlinkSync(ordinary, okLink, 'junction'); fs.rmdirSync(ordinary);
  assert.equal(blocked(path.join(okLink, 'x.txt')), false, 'ordinary dangling link is not blocked by this guard');
  // 3. the same decision is reached through the real agent guard (checkedMutationPath refuses links on top of that)
  const before = process.env.DOCTEUR_ROOT_POLICY_DIR; process.env.DOCTEUR_ROOT_POLICY_DIR = path.join(cs, 'policy');
  try { assert.throws(() => checkedMutationPath(work, 'dangling-into-policy/new.md'), (e) => ['symlink_denied', 'root_policy_protected'].includes(e.code)); }
  finally { if (before === undefined) delete process.env.DOCTEUR_ROOT_POLICY_DIR; else process.env.DOCTEUR_ROOT_POLICY_DIR = before; }
});

test('NEGATIVE: assertNotRootPolicyPath refuses with a constant code and leaks no path or content', () => {
  assert.throws(() => assertNotRootPolicyPath(tree.policyJson, { paths: PERIMETER, operation: 'delete' }), (error) => {
    assert.equal(error.code, 'root_policy_protected');
    assert.equal(error.message, 'root_policy_protected');
    assert.ok(!error.message.includes(scratch) && !/policy/i.test(error.message.replace('root_policy_protected', '')));
    return true;
  });
  assert.doesNotThrow(() => assertNotRootPolicyPath(tree.ordinary, { paths: PERIMETER }));
});

// ═════════════════════════════ POSITIVE — look-alikes and ordinary writes are untouched ═════════════════════════════════════════════════
test('POSITIVE: prefix confusion and look-alike names are NOT protected', () => {
  for (const key of ['backup', 'policy2', 'policyNotes', 'libNotes', 'libOther', 'routeDocs', 'routeBak', 'testFile', 'report', 'ordinary', 'notebook', 'media', 'dataOther', 'dataLookalike']) {
    assert.equal(blocked(tree[key]), false, `${key} must stay writable`);
  }
  assert.equal(blocked(path.join(cs, 'policy-backup')), false, 'policy-backup is not policy');
  assert.equal(blocked(path.join(cs, 'policy-backup', 'brand', 'new.json')), false);
  assert.equal(blocked(path.join(cs, 'policyX')), false);
  assert.equal(blocked(path.join(cs, 'src', 'lib', 'root-policy-extra', 'a.js')), false);
  assert.equal(blocked(path.join(cs, 'src', 'routes', 'root-policy.json')), false, 'same stem, other extension');
  assert.equal(blocked(path.join(cs, 'root-policy-tool.md')), false);
  assert.equal(blocked(path.join(cs, 'root-policy-tool.mjs.old')), false);
});

test('POSITIVE: ordinary, temp, export, notebook and media destinations (including odd but legitimate names) are not protected', () => {
  const ok = [
    path.join(scratch, 'workspace', 'new-file.ts'), path.join(os.tmpdir(), 'docteur-agent-abc', 'x.ts'),
    path.join(scratch, 'exports', 'rapport final — été 日本語.pdf'), path.join(scratch, 'Mes Documents', 'policy.txt'),
    path.join(repo, 'src', 'App.tsx'), path.join(cs, 'data', 'cortex.sqlite'), path.join(cs, 'data', 'fichiers', 'a.pdf'),
    path.join(cs, 'data', 'tmp', 'notebook-upload.docx'), path.join(cs, 'data', 'video-jobs', 'job1', 'out.mp4'),
    path.join(scratch, 'a'.repeat(120), 'b'.repeat(120), 'c.txt'),
  ];
  for (const p of ok) assert.equal(blocked(p), false, `must stay writable: ${p.slice(0, 60)}`);
  // unusual input never makes an ordinary path unwritable
  assert.equal(blocked(path.join(scratch, 'x\0y')), false);
});

test('POSITIVE: reading is never restricted — a protected file can still be read as agent context', () => {
  assert.equal(checkedPath(path.join(cs, 'policy', '..', '..'), 'cortex-server/policy/root-policy.json'), path.join(cs, 'policy', 'root-policy.json'));
  assert.equal(checkedPath(repo, 'cortex-server/policy/root-policy.json'), tree.policyJson);
  const before = process.env.DOCTEUR_ROOT_POLICY_DIR;
  process.env.DOCTEUR_ROOT_POLICY_DIR = path.join(cs, 'policy');          // make the temporary repo's policy directory the active perimeter
  try {
    assert.throws(() => checkedMutationPath(repo, 'cortex-server/policy/root-policy.json'), /root_policy_protected/);
    assert.equal(checkedMutationPath(repo, 'cortex-server/policy-backup/root-policy.json'), tree.backup, 'look-alike stays mutable');
  } finally { if (before === undefined) delete process.env.DOCTEUR_ROOT_POLICY_DIR; else process.env.DOCTEUR_ROOT_POLICY_DIR = before; }
});

// ═════════════════════════════ the REAL perimeter (read-only: path decisions only) ══════════════════════════════════════════════════════
test('REAL perimeter: exact, small, anchored on the real layout — and no real file is touched', () => {
  const real = rootPolicyProtectedPaths({ env: {}, home: path.join(scratch, 'home') });
  const rootOf = (p) => path.relative(HERE, p).replaceAll(BS, '/');
  assert.deepEqual(real.dirs.map(rootOf).filter(p => !p.startsWith('..')), ['policy', 'src/lib/root-policy', 'data/root-policy']);
  assert.ok(real.dirs.some(d => d.endsWith(path.join('home', '.docteur', 'root-policy'))), 'the human key location');
  assert.deepEqual(real.files.map(rootOf), ['src/routes/root-policy.js', 'root-policy-tool.mjs']);
  const realProtected = ['policy/root-policy.json', 'policy/root-policy.sig.json', 'policy/signing-log.jsonl', 'policy/recovery/root-policy.json', 'src/lib/root-policy/engine.js',
    'src/lib/root-policy/trust-anchors.js', 'src/lib/root-policy/protected-paths.js', 'src/routes/root-policy.js', 'root-policy-tool.mjs', 'data/root-policy/state.json', 'data/root-policy/audit.jsonl'];
  for (const r of realProtected) assert.equal(isRootPolicyProtected(path.join(HERE, r)), true, r);
  const realFree = ['src/lib/router.js', 'src/lib/disk-space.js', 'src/lib/secret-store.js', 'src/lib/ytdlp.js', 'src/lib/notebook-documents.js', 'src/lib/web-egress-guard.js', 'src/routes/notebook.js',
    'test-root-policy-engine.mjs', 'test-rpc2b-root-policy-path-protection.mjs', 'root-policy-boot-proof.mjs', 'data/cortex.sqlite', 'data/images/x.png', 'policy-backup/x.json', 'src/lib/root-policy-notes.md',
    '../reports/ROOT_POLICY_V1_2026-10.md', '../src/App.tsx', '../package.json'];
  for (const r of realFree) assert.equal(isRootPolicyProtected(path.join(HERE, r)), false, r);
  // the env overrides are honoured (a relocated policy dir / database dir stay protected)
  const moved = rootPolicyProtectedPaths({ env: { DOCTEUR_ROOT_POLICY_DIR: path.join(scratch, 'elsewhere', 'policy'), SQLITE_PATH: path.join(scratch, 'db', 'cortex.sqlite') }, home: scratch });
  assert.ok(moved.dirs.includes(path.join(scratch, 'elsewhere', 'policy')) && moved.dirs.includes(path.join(scratch, 'db', 'root-policy')));
});

test('PERFORMANCE: the guard is a handful of stat calls — negligible per decision, no scan, no network', () => {
  const targets = [tree.policyJson, tree.ordinary, path.join(scratch, 'workspace', 'new.ts'), path.join(cs, 'policy', '..', 'src', 'lib', 'router.js')];
  for (let i = 0; i < 50; i++) blocked(targets[i % targets.length]);               // warm-up
  const started = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i++) blocked(targets[i % targets.length]);
  const perDecision = (performance.now() - started) / N;
  assert.ok(perDecision < 2, `${perDecision.toFixed(3)} ms per decision (budget 2 ms; typically ≪ 1 ms)`);
  const src = fs.readFileSync(path.join(HERE, 'src', 'lib', 'root-policy', 'protected-paths.js'), 'utf8');
  const code = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /readdirSync|readdir\(|opendir|glob|fetch\(|https?:|spawn|exec|node:(net|http|https|dns|child_process)/i, 'no directory scan, no network, no process');
});

test('FAIL-CLOSED only inside the perimeter: an unreadable link under the perimeter is refused, an unreadable ordinary entry is not', () => {
  assert.throws(() => canonicalForProtection(`${scratch}${path.sep}bad\0name`), /unresolvable/);
  // lexically inside + unresolvable ⇒ protected ; lexically outside + unresolvable ⇒ not protected
  assert.equal(blocked(`${path.join(cs, 'policy')}${path.sep}evil\0.json`), true);
  assert.equal(blocked(`${path.join(scratch, 'workspace')}${path.sep}evil\0.json`), false);
});

// ═════════════════════════════ external agents — the real service in a temporary project ═══════════════════════════════════════════════
const ORIGINAL_POLICY_DIR = process.env.DOCTEUR_ROOT_POLICY_DIR;
const TEST_ROOT = path.resolve('.tmp/external-agent-tests'); fs.mkdirSync(TEST_ROOT, { recursive: true });
function fixture(t, run) {
  const base = fs.mkdtempSync(path.join(TEST_ROOT, 'rpc2b-'));
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  const files = {
    'sample.ts': 'export const value = 1;\n',
    'cortex-server/policy/root-policy.json': '{"fake":"policy"}\n',
    'cortex-server/policy/signing-log.jsonl.md': 'log\n',
    'cortex-server/policy-backup/notes.md': 'backup notes\n',
    'docs/root-policy-notes.md': 'notes\n',
    'cortex-server/src/lib/other.js': 'export const a = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) put(path.join(project, name), text);
  const launch = (config) => {
    let resolve; const done = new Promise(r => { resolve = r; });
    queueMicrotask(() => {
      const emit = (line) => config.onLine?.('stdout', sanitize(line));
      if (config.args.includes('--version')) emit('codex-cli 0.153.4');
      else if (config.args.includes('--help')) emit('--ignore-user-config --ephemeral --json --restricted --safe-mode --tools --no-session-persistence');
      else if (config.args.includes('status')) { resolve({ exitCode: 0 }); return; }
      else { run?.(config); emit('{"type":"result","result":"done"}'); resolve({ exitCode: 0 }); return; }
      resolve({ exitCode: 0 });
    });
    return { done, stop(reason) { resolve({ exitCode: null, reason }); } };
  };
  const service = new ExternalAgents({ projectRoot: project, dataDir: path.join(base, 'history'), launch, resolve: p => ({ command: p, prefix: [] }), strictLocal: () => false });
  process.env.DOCTEUR_ROOT_POLICY_DIR = path.join(project, 'cortex-server', 'policy');   // the temporary project's own policy directory is the perimeter
  t.after(async () => {
    if (ORIGINAL_POLICY_DIR === undefined) delete process.env.DOCTEUR_ROOT_POLICY_DIR; else process.env.DOCTEUR_ROOT_POLICY_DIR = ORIGINAL_POLICY_DIR;
    await service.shutdown(); fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, project, service, input: { provider: 'codex', feature: 'code_fix', prompt: 'Corrige.', cwd: project, files: ['sample.ts'], mode: 'edit', permissions: 'EDIT' } };
}
async function run(f, overrides = {}) {
  const job = f.service.preview({ ...f.input, ...overrides });
  await f.service.approve(job.id, true);
  const finished = (j) => ['completed', 'failed', 'timeout', 'cancelled'].includes(j.status);
  if (finished(f.service.get(job.id))) return f.service.get(job.id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('job did not finish')), 4000);
    const listener = (j) => { if (j.id === job.id && finished(j)) { clearTimeout(timer); f.service.off('job', listener); resolve(j); } };
    f.service.on('job', listener);
  });
}
const read = (f, name) => fs.readFileSync(path.join(f.project, name), 'utf8');
const policyFile = 'cortex-server/policy/root-policy.json';

test('AGENTS NEGATIVE: an agent proposal that overwrites the policy is refused before any review — and the file is untouched', async t => {
  const g = fixture(t, c => fs.writeFileSync(path.join(c.cwd, policyFile), '{"evil":true}'));
  const job = await run(g, { files: ['sample.ts', policyFile] });
  assert.equal(job.status, 'failed'); assert.equal(job.error, 'root_policy_protected');
  assert.equal(read(g, policyFile), '{"fake":"policy"}\n'); assert.notEqual(job.review, 'pending');
});

test('AGENTS NEGATIVE: create inside, delete, and rename (= delete + create) of the policy are all refused', async t => {
  const create = fixture(t, c => { fs.mkdirSync(path.join(c.cwd, 'cortex-server', 'policy'), { recursive: true }); fs.writeFileSync(path.join(c.cwd, 'cortex-server', 'policy', 'root-policy.sig.json.md'), 'forged'); });
  assert.equal((await run(create)).error, 'root_policy_protected');
  assert.equal(fs.existsSync(path.join(create.project, 'cortex-server', 'policy', 'root-policy.sig.json.md')), false);

  const del = fixture(t, c => fs.unlinkSync(path.join(c.cwd, policyFile)));
  assert.equal((await run(del, { files: ['sample.ts', policyFile] })).error, 'root_policy_protected');
  assert.ok(fs.existsSync(path.join(del.project, policyFile)));

  const ren = fixture(t, c => { fs.renameSync(path.join(c.cwd, policyFile), path.join(c.cwd, 'cortex-server', 'policy', 'moved.md')); });
  assert.equal((await run(ren, { files: ['sample.ts', policyFile] })).error, 'root_policy_protected');
  assert.equal(read(ren, policyFile), '{"fake":"policy"}\n');

  const into = fixture(t, c => { fs.writeFileSync(path.join(c.cwd, 'cortex-server', 'policy', 'incoming.md'), 'export const value = 1;\n'); });
  assert.equal((await run(into, { files: ['sample.ts', 'cortex-server/policy/signing-log.jsonl.md'] })).error, 'root_policy_protected');
});

test('AGENTS NEGATIVE: the review step refuses on its own (defence in depth) — nothing is written, the whole batch is refused', async t => {
  const f = fixture(t, c => { fs.writeFileSync(path.join(c.cwd, 'sample.ts'), 'export const value = 2;\n'); fs.writeFileSync(path.join(c.cwd, 'docs', 'root-policy-notes.md'), 'edited\n'); });
  const job = await run(f, { files: ['sample.ts', 'docs/root-policy-notes.md'] });
  assert.equal(job.review, 'pending'); assert.equal(job.changes.length, 2);
  // the perimeter changes between proposal and review (e.g. DOCTEUR_ROOT_POLICY_DIR relocated onto docs/)
  process.env.DOCTEUR_ROOT_POLICY_DIR = path.join(f.project, 'docs');
  assert.throws(() => f.service.review(job.id, true), (error) => error.code === 'root_policy_protected');
  assert.equal(read(f, 'sample.ts'), 'export const value = 1;\n', 'the legitimate file of the same batch is not written either');
  assert.equal(read(f, 'docs/root-policy-notes.md'), 'notes\n');
});

test('AGENTS NEGATIVE: junction inside the project pointing at the policy stays refused (existing link guard + perimeter)', { skip: !win }, async t => {
  const f = fixture(t, null);
  fs.symlinkSync(path.join(f.project, 'cortex-server', 'policy'), path.join(f.project, 'alias'), 'junction');
  assert.throws(() => checkedMutationPath(f.project, 'alias/root-policy.json'), (error) => ['symlink_denied', 'root_policy_protected'].includes(error.code));
});

test('AGENTS POSITIVE: ordinary edits, new files, deletions, look-alike names and policy-as-context all keep working — review and undo included', async t => {
  const f = fixture(t, c => {
    fs.writeFileSync(path.join(c.cwd, 'sample.ts'), 'export const value = 2;\n');                                   // modify
    fs.writeFileSync(path.join(c.cwd, 'docs', 'root-policy-notes.md'), 'edited notes\n');                           // look-alike name, outside the perimeter
    fs.writeFileSync(path.join(c.cwd, 'cortex-server', 'policy-backup', 'notes.md'), 'edited backup\n');             // prefix confusion
    fs.writeFileSync(path.join(c.cwd, 'cortex-server', 'policy-backup', 'created.md'), 'new\n');                    // create next to it
    fs.writeFileSync(path.join(c.cwd, 'cortex-server', 'src', 'lib', 'root-policy-extra.js'), 'export {};\n');       // similar name next to the engine dir
    fs.unlinkSync(path.join(c.cwd, 'cortex-server', 'src', 'lib', 'other.js'));                                      // delete
    // the policy itself is only READ as context (selected file), never changed
  });
  const job = await run(f, { files: ['sample.ts', 'docs/root-policy-notes.md', 'cortex-server/policy-backup/notes.md', 'cortex-server/src/lib/other.js', policyFile] });
  assert.equal(job.status, 'completed'); assert.equal(job.review, 'pending');
  assert.deepEqual(job.changes.map(c => c.kind).sort(), ['created', 'created', 'deleted', 'modified', 'modified', 'modified']);
  f.service.review(job.id, true);
  assert.equal(read(f, 'sample.ts'), 'export const value = 2;\n');
  assert.equal(read(f, 'docs/root-policy-notes.md'), 'edited notes\n');
  assert.equal(read(f, 'cortex-server/policy-backup/created.md'), 'new\n');
  assert.equal(fs.existsSync(path.join(f.project, 'cortex-server', 'src', 'lib', 'other.js')), false);
  assert.equal(read(f, policyFile), '{"fake":"policy"}\n', 'the policy was readable context and is unchanged');
  f.service.undo(job.id);
  assert.equal(read(f, 'sample.ts'), 'export const value = 1;\n');
  assert.ok(fs.existsSync(path.join(f.project, 'cortex-server', 'src', 'lib', 'other.js')));
  assert.equal(fs.existsSync(path.join(f.project, 'cortex-server', 'policy-backup', 'created.md')), false);
});

test('AGENTS POSITIVE: read-only analysis of the policy file (SAFE mode) completes with no change and no approval step added', async t => {
  const f = fixture(t, null);
  const job = await run(f, { mode: 'read', permissions: 'SAFE', files: [policyFile, 'sample.ts'] });
  assert.equal(job.status, 'completed'); assert.equal(job.review, 'none'); assert.equal(job.error, null);
});

// ═════════════════════════════ MetaGPT apply policy (Python) — driven in a temporary DOCTEUR_ROOT ══════════════════════════════════════════
const PY = (() => { const r = spawnSync('python', ['--version'], { encoding: 'utf8' }); return r.status === 0 ? 'python' : null; })();
const DRIVER = `
import json, sys, shutil, hashlib, os
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(path.join(HERE, 'src', 'lib'))})
import metagpt_apply_policy as m
spec = json.loads(sys.argv[1])
m.DOCTEUR_ROOT = Path(spec['root'])
mode = spec['mode']
if mode == 'resolve':
    out = {}
    for case in spec['cases']:
        try:
            out[case] = 'OK:' + m.resolve_destination(case).relative_to(Path(spec['root']).resolve()).as_posix()
        except m.ApplyPolicyError as e:
            out[case] = 'ERR:' + str(e).split(':')[0]
    print(json.dumps(out))
elif mode == 'protected':
    print(json.dumps({c: m.is_root_policy_protected(c) for c in spec['cases']}))
elif mode == 'e2e':
    import metagpt_runner_prepare_apply as prep, metagpt_runner_apply as app
    job_dir = Path(spec['jobDir']); job_id = spec['jobId']
    p = prep._run_prepare_apply(job_dir, job_id)
    res = {'prepare_ok': p.get('ok'), 'prepare_error': p.get('error_code')}
    if p.get('ok'):
        a = app._run_apply(job_dir, job_id, p['diff_sha256'], p['package_sha256'])
        res['apply_ok'] = a.get('ok'); res['apply_error'] = a.get('error_code') or a.get('error')
    print(json.dumps(res))
`;
function py(spec) {
  const r = spawnSync(PY, ['-c', DRIVER, JSON.stringify(spec)], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `python driver failed: ${(r.stderr || '').slice(0, 300)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
const pyRoot = path.join(scratch, 'pyroot');
for (const d of ['src/_metagpt_generated_samples', 'src/components', 'cortex-server/policy', 'cortex-server/policy-backup', 'cortex-server/src/lib/root-policy', 'cortex-server/src/lib/root-policy-backup',
  'cortex-server/src/routes', 'cortex-server/data/root-policy']) fs.mkdirSync(path.join(pyRoot, d), { recursive: true });
put(path.join(pyRoot, 'cortex-server/policy/root-policy.json'), '{}'); put(path.join(pyRoot, 'cortex-server/src/lib/root-policy/engine.js'), '//');
put(path.join(pyRoot, 'cortex-server/src/routes/root-policy.js'), '//');
const ID = '11111111-2222-3333-4444-555555555555';

test('METAGPT NEGATIVE: traversal, aliases, case, decoration, junction and stream tricks never resolve into the perimeter', { skip: !PY }, () => {
  const junction = win ? 'src/alias/root-policy.json' : null;
  if (junction) fs.symlinkSync(path.join(pyRoot, 'cortex-server', 'policy'), path.join(pyRoot, 'src', 'alias'), 'junction');
  const cases = [
    'src/../cortex-server/policy/root-policy.json',                                  // starts with the allowlist, escapes it
    'cortex-server/src/../policy/root-policy.json',
    'src/_metagpt_generated_samples/../../cortex-server/policy/root-policy.json',
    `src/_metagpt_generated_samples/${ID}/../../../cortex-server/policy/root-policy.json`,
    'src\\..\\cortex-server\\policy\\root-policy.json',                            // backslashes
    'cortex-server\\src\\lib\\root-policy\\engine.js',                              // inside the perimeter, backslashes
    'cortex-server/src/lib/root-policy/engine.js',                                   // allowlisted prefix AND protected
    'cortex-server/src/lib/root-policy/new-file.js',
    'cortex-server/src/routes/root-policy.js',
    'cortex-server/src/lib/ROOT-POLICY/engine.js',                                   // case (allowlist is case sensitive, perimeter is folded)
    'CORTEX-SERVER/SRC/LIB/ROOT-POLICY/engine.js',
    'cortex-server/src/lib/root-policy./engine.js',                                  // trailing dot
    'cortex-server/src/lib/root-policy /engine.js',                                  // trailing space
    'cortex-server/src/routes/root-policy.js.',
    'src/_metagpt_generated_samples/a.js:evil',                                      // alternate data stream
    'src/a<b.js', 'src/a|b.js',
    ...(junction ? [junction, 'src/alias/new.json'] : []),
    '//server/share/x.js', 'C:\\\\dev\\\\Docteur\\\\src\\\\a.js', '/etc/passwd',      // unchanged denials
  ];
  const out = py({ mode: 'resolve', root: pyRoot, cases });
  for (const c of cases) assert.match(out[c], /^ERR:/, `${c} → ${out[c]}`);
  // the specific protection fires where the path really is in the perimeter
  assert.equal(out['cortex-server/src/lib/root-policy/engine.js'], 'ERR:destination_root_policy_protected');
  assert.equal(out['cortex-server/src/routes/root-policy.js'], 'ERR:destination_root_policy_protected');
  assert.equal(out['cortex-server/src/lib/root-policy./engine.js'], 'ERR:destination_root_policy_protected');
  assert.equal(out['src/../cortex-server/policy/root-policy.json'], 'ERR:destination_traversal_denied');
  if (junction) assert.equal(out[junction], 'ERR:destination_root_policy_protected', 'junction alias resolved, then refused');
});

test('METAGPT POSITIVE: the real destinations (and look-alike names under the allowlist) still resolve exactly as before', { skip: !PY }, () => {
  const cases = [
    `src/_metagpt_generated_samples/${ID}`, `src/_metagpt_generated_samples/${ID}/greeting.js`, `src/_metagpt_generated_samples/${ID}/sub/dir/Component.tsx`,
    `src/_metagpt_generated_samples/${ID}/root-policy.json`,                         // a GENERATED file that merely carries the name
    'src/components/Foo.tsx', 'cortex-server/src/lib/new-feature.js',
    'cortex-server/src/lib/root-policy-notes.md', 'cortex-server/src/lib/root-policy-backup/x.js', 'cortex-server/src/routes/root-policy-docs.md', 'cortex-server/src/routes/root-policy.json',
  ];
  const out = py({ mode: 'resolve', root: pyRoot, cases });
  for (const c of cases) assert.equal(out[c], `OK:${c}`, `${c} → ${out[c]}`);
  const prot = py({ mode: 'protected', root: pyRoot, cases: ['cortex-server/policy-backup/x', 'cortex-server/policy', 'cortex-server/policy/x', 'cortex-server/Policy./x', 'cortex-server/src/lib/root-policy2/x.js', 'cortex-server/data/root-policy/state.json', 'cortex-server/data/root-policy-export/a.json'] });
  assert.deepEqual(prot, { 'cortex-server/policy-backup/x': false, 'cortex-server/policy': true, 'cortex-server/policy/x': true, 'cortex-server/Policy./x': true,
    'cortex-server/src/lib/root-policy2/x.js': false, 'cortex-server/data/root-policy/state.json': true, 'cortex-server/data/root-policy-export/a.json': false });
});

test('METAGPT POSITIVE (end to end): prepare-diff then exact-approved apply still publishes a generated job into src/_metagpt_generated_samples', { skip: !PY, timeout: 90_000 }, () => {
  const jobDir = path.join(scratch, 'job'); const generated = path.join(jobDir, 'generated');
  const files = { 'greeting.js': 'export const hello = () => "bonjour";\n', 'sub/util.ts': 'export const n = 1;\n', 'root-policy.json': '{"just":"a generated file named like the policy"}\n' };
  const manifest = { files: [] };
  for (const [name, text] of Object.entries(files)) {
    put(path.join(generated, name), text);
    const bytes = Buffer.from(text, 'utf8');
    manifest.files.push({ path: name, sha256: crypto_sha256(bytes), size: bytes.length });
  }
  fs.writeFileSync(path.join(jobDir, 'manifest.json'), JSON.stringify(manifest));
  const res = py({ mode: 'e2e', root: pyRoot, jobDir, jobId: ID });
  assert.deepEqual(res, { prepare_ok: true, prepare_error: null, apply_ok: true, apply_error: null });
  for (const [name, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(pyRoot, 'src', '_metagpt_generated_samples', ID, name), 'utf8'), text);
  assert.equal(fs.readFileSync(path.join(pyRoot, 'cortex-server/policy/root-policy.json'), 'utf8'), '{}', 'the (temporary) policy was not touched');
});

test('METAGPT NEGATIVE (end to end): a manifest that tries to escape toward the policy is refused by the apply policy itself, nothing is written', { skip: !PY, timeout: 90_000 }, () => {
  // jobs/<x>/job-evil/generated/../../../cortex-server/policy/root-policy.json exists inside the scratch tree and its hash is right,
  // so the manifest passes source verification and the ONLY thing standing between it and the policy is resolve_destination().
  const jobDir = path.join(scratch, 'jobs', 'x', 'job-evil'); const generated = path.join(jobDir, 'generated');
  const evilName = '../../../cortex-server/policy/root-policy.json';
  const bytes = Buffer.from('{"evil":true}', 'utf8');
  fs.mkdirSync(generated, { recursive: true });
  put(path.join(scratch, 'jobs', 'cortex-server', 'policy', 'root-policy.json'), '{"evil":true}');
  fs.writeFileSync(path.join(jobDir, 'manifest.json'), JSON.stringify({ files: [{ path: evilName, sha256: crypto_sha256(bytes), size: bytes.length }] }));
  const evilId = '99999999-2222-3333-4444-555555555555';
  const res = py({ mode: 'e2e', root: pyRoot, jobDir, jobId: evilId });
  assert.deepEqual(res, { prepare_ok: false, prepare_error: 'BLOCKED_BY_POLICY' });
  assert.equal(fs.readFileSync(path.join(pyRoot, 'cortex-server/policy/root-policy.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(pyRoot, 'src', '_metagpt_generated_samples', evilId)), false);
});

// ═════════════════════════════ static audit ══════════════════════════════════════════════════════════════════════════════════════════════
test('STATIC: both apply flows go through the perimeter guard, JS and Python describe the SAME perimeter, and no other writer was weakened', () => {
  const agents = fs.readFileSync(path.join(HERE, 'src', 'lib', 'external-agents.js'), 'utf8');
  const policy = fs.readFileSync(path.join(HERE, 'src', 'lib', 'external-agent-policy.js'), 'utf8');
  assert.match(agents, /checkedMutationPath\(root, change\.path\)/, 'review() validates every target through the guard');
  assert.match(agents, /assertNotRootPolicyPath\(path\.resolve\(job\.workspace, change\.path\)/, 'the proposal is refused when it is computed');
  assert.doesNotMatch(agents, /checkedPath\(root, change\.path, true\)/, 'no apply target is validated by the read-only checker any more');
  assert.match(policy, /export function checkedMutationPath/);
  const writes = [...agents.matchAll(/fs\.(writeFileSync|unlinkSync)\(op\.target/g)];
  assert.ok(writes.length >= 3, 'the only apply writes are the ones that use validated operation targets');

  const pySrc = fs.readFileSync(path.join(HERE, 'src', 'lib', 'metagpt_apply_policy.py'), 'utf8');
  const pyDirs = [...pySrc.matchAll(/ROOT_POLICY_PROTECTED_DIRS = \(([\s\S]*?)\)/g)][0][1].match(/"([^"]+)"/g).map(s => s.slice(1, -1));
  const pyFiles = [...pySrc.matchAll(/ROOT_POLICY_PROTECTED_FILES = \(([\s\S]*?)\)/g)][0][1].match(/"([^"]+)"/g).map(s => s.slice(1, -1));
  const real = rootPolicyProtectedPaths({ env: {}, home: scratch });
  const toRel = (p) => path.relative(path.dirname(HERE), p).replaceAll(BS, '/');
  assert.deepEqual(pyDirs, real.dirs.filter(d => toRel(d).startsWith('cortex-server/')).map(toRel));
  assert.deepEqual(pyFiles, real.files.map(toRel));
  assert.match(pySrc, /real_relative = resolved\.relative_to\(DOCTEUR_ROOT\.resolve\(\)\)\.as_posix\(\)/);
  assert.match(pySrc, /raise ApplyPolicyError\("destination_root_policy_protected"\)/);
  assert.match(pySrc, /DESTINATION_ALLOWLIST_PREFIXES = \(\s*"src\/",\s*"cortex-server\/src\/",\s*\)/, 'the allowlist itself is unchanged: no capability was removed');
});

import crypto from 'node:crypto';
function crypto_sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
