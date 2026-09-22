// Unit tests for code-intel-git.js — the strictly read-only Git wrapper.
// Exercises the real repository's own git history (read-only commands
// only: status/diff/log/show); never mutates anything.
// Run with: node --test test-code-intel-git.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitStatus, gitDiff, gitLog, gitShow, isGitAvailable, GitUnavailableError, InvalidRefError } from './src/lib/code-intel-git.js';
import { WorkspacePathError } from './src/lib/code-intel-workspace.js';

test('isGitAvailable: resolves git.exe on this machine', () => {
  assert.equal(isGitAvailable(), true);
});

test('gitStatus: returns a machine-readable entry list, no mutation', async () => {
  const result = await gitStatus();
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.entries));
  for (const entry of result.entries) {
    assert.equal(typeof entry.statusCode, 'string');
    assert.equal(typeof entry.path, 'string');
  }
});

test('gitLog: returns bounded commits with the expected fields', async () => {
  const result = await gitLog({ limit: 3 });
  assert.equal(result.ok, true);
  assert.ok(result.commits.length <= 3);
  assert.ok(result.commits.length > 0, 'this repo has real commit history');
  for (const commit of result.commits) {
    assert.match(commit.hash, /^[0-9a-f]{40}$/);
    assert.equal(typeof commit.author, 'string');
    assert.equal(typeof commit.date, 'string');
    assert.equal(typeof commit.subject, 'string');
  }
});

test('gitLog: limit is clamped to MAX_LOG_COMMITS even with an absurd request', async () => {
  const result = await gitLog({ limit: 999999 });
  assert.equal(result.ok, true);
  assert.ok(result.commits.length <= 200);
});

test('gitDiff: working-tree diff succeeds and is bounded', async () => {
  const result = await gitDiff({});
  assert.equal(result.ok, true);
  assert.equal(typeof result.diff, 'string');
  assert.ok(result.diff.length <= 2 * 1024 * 1024);
});

test('gitDiff: staged diff succeeds (empty or not, both are valid states)', async () => {
  const result = await gitDiff({ staged: true });
  assert.equal(result.ok, true);
  assert.equal(typeof result.diff, 'string');
});

test('gitDiff: scoped to a specific tracked path succeeds', async () => {
  const result = await gitDiff({ relPath: 'cortex-server/src/server.js' });
  assert.equal(result.ok, true);
});

test('gitDiff: rejects a path-traversal attempt via WorkspacePathError, never reaches git', async () => {
  await assert.rejects(() => gitDiff({ relPath: '../../../Windows/System32' }), (err) => {
    assert.ok(err instanceof WorkspacePathError);
    assert.equal(err.code, 'code_intel_path_traversal_denied');
    return true;
  });
});

test('gitDiff: rejects an absolute path', async () => {
  await assert.rejects(() => gitDiff({ relPath: 'C:\\Windows\\System32\\config' }), (err) => {
    assert.equal(err.code, 'code_intel_path_absolute_denied');
    return true;
  });
});

test('gitShow: a valid ref (HEAD) succeeds and is bounded', async () => {
  const result = await gitShow({ ref: 'HEAD' });
  assert.equal(result.ok, true);
  assert.equal(typeof result.content, 'string');
  assert.ok(result.content.length <= 2 * 1024 * 1024);
});

test('gitShow: scoped to a specific tracked path at HEAD succeeds', async () => {
  const result = await gitShow({ ref: 'HEAD', relPath: 'cortex-server/package.json' });
  assert.equal(result.ok, true);
});

test('gitShow: rejects an invalid/malicious ref (shell-metacharacter-shaped)', async () => {
  const badRefs = ['; rm -rf /', 'HEAD; echo pwned', '$(whoami)', '`whoami`', '--upload-pack=evil', 'a'.repeat(300)];
  for (const ref of badRefs) {
    await assert.rejects(() => gitShow({ ref }), (err) => {
      assert.ok(err instanceof InvalidRefError, `expected InvalidRefError for ref ${JSON.stringify(ref)}`);
      return true;
    });
  }
});

test('gitShow: rejects a ref beginning with "-" (would otherwise be parsed as a git flag)', async () => {
  await assert.rejects(() => gitShow({ ref: '--force' }), (err) => {
    assert.ok(err instanceof InvalidRefError);
    return true;
  });
});

test('gitShow: a well-formed but non-existent ref fails cleanly, never throws unexpectedly', async () => {
  const result = await gitShow({ ref: 'refs/does-not-exist-xyz-123' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'git_command_failed');
});

test('gitShow: rejects a path-traversal attempt via WorkspacePathError', async () => {
  await assert.rejects(() => gitShow({ ref: 'HEAD', relPath: '../../etc/passwd' }), (err) => {
    assert.ok(err instanceof WorkspacePathError);
    return true;
  });
});

test('gitStatus/gitDiff/gitLog/gitShow: no export exists for any mutating git operation', async () => {
  const module = await import('./src/lib/code-intel-git.js');
  const exportedNames = Object.keys(module);
  const forbidden = ['gitCommit', 'gitCheckout', 'gitSwitch', 'gitRestore', 'gitReset', 'gitClean', 'gitRebase', 'gitMerge', 'gitCherryPick', 'gitTag', 'gitPush', 'gitPull', 'gitFetch', 'gitRemote', 'gitConfig', 'gitStash', 'runGit', 'runGitCommand', 'exec'];
  for (const name of forbidden) {
    assert.equal(exportedNames.includes(name), false, `${name} must never be exported by the read-only git wrapper`);
  }
  // Exactly the allowlisted four operations plus utility exports.
  const readOps = exportedNames.filter(n => n.startsWith('git'));
  assert.deepEqual(readOps.sort(), ['gitDiff', 'gitLog', 'gitShow', 'gitStatus'].sort());
});
