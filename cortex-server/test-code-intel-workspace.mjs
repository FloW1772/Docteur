// Unit tests for code-intel-workspace.js — the shared path-resolution
// boundary every other code-intel module builds on.
// Run with: node --test test-code-intel-workspace.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspacePath, WorkspacePathError, isPathExcludedByDefault } from './src/lib/code-intel-workspace.js';

test('resolveWorkspacePath: accepts a real, non-excluded relative path', () => {
  const result = resolveWorkspacePath('cortex-server/src/server.js');
  assert.equal(result.relativePath, 'cortex-server/src/server.js');
  assert.ok(result.absolutePath.endsWith('server.js'));
});

test('resolveWorkspacePath: rejects "../" traversal', () => {
  assert.throws(() => resolveWorkspacePath('../../../Windows/System32'), (err) => {
    assert.ok(err instanceof WorkspacePathError);
    assert.equal(err.code, 'code_intel_path_traversal_denied');
    return true;
  });
});

test('resolveWorkspacePath: rejects a Windows absolute path', () => {
  assert.throws(() => resolveWorkspacePath('C:\\Windows\\System32'), (err) => {
    assert.equal(err.code, 'code_intel_path_absolute_denied');
    return true;
  });
});

test('resolveWorkspacePath: rejects a POSIX absolute path', () => {
  assert.throws(() => resolveWorkspacePath('/etc/passwd'), (err) => {
    assert.equal(err.code, 'code_intel_path_absolute_denied');
    return true;
  });
});

test('resolveWorkspacePath: rejects a UNC path', () => {
  assert.throws(() => resolveWorkspacePath('\\\\server\\share\\file.txt'), (err) => {
    assert.equal(err.code, 'code_intel_path_absolute_denied');
    return true;
  });
});

test('resolveWorkspacePath: rejects an excluded directory (node_modules)', () => {
  assert.throws(() => resolveWorkspacePath('node_modules/.package-lock.json'), (err) => {
    assert.equal(err.code, 'code_intel_path_excluded');
    return true;
  });
});

test('resolveWorkspacePath: rejects a nested node_modules path', () => {
  assert.throws(() => resolveWorkspacePath('cortex-server/node_modules/hono/package.json'), (err) => {
    assert.equal(err.code, 'code_intel_path_excluded');
    return true;
  });
});

test('resolveWorkspacePath: rejects external/MetaGPT (nested repo, excluded by default)', () => {
  assert.throws(() => resolveWorkspacePath('external/MetaGPT/README.md'), (err) => {
    assert.equal(err.code, 'code_intel_path_excluded');
    return true;
  });
});

test('resolveWorkspacePath: rejects a secret-shaped runtime DB path', () => {
  assert.throws(() => resolveWorkspacePath('cortex-server/data/cortex.sqlite'), (err) => {
    assert.equal(err.code, 'code_intel_path_excluded');
    return true;
  });
});

test('resolveWorkspacePath: rejects a non-existent path with not_found', () => {
  assert.throws(() => resolveWorkspacePath('cortex-server/src/this-file-does-not-exist.js'), (err) => {
    assert.equal(err.code, 'code_intel_path_not_found');
    return true;
  });
});

test('resolveWorkspacePath: rejects an empty string', () => {
  assert.throws(() => resolveWorkspacePath(''), (err) => {
    assert.equal(err.code, 'code_intel_path_invalid');
    return true;
  });
});

test('resolveWorkspacePath: rejects a non-string input', () => {
  assert.throws(() => resolveWorkspacePath(null), (err) => {
    assert.equal(err.code, 'code_intel_path_invalid');
    return true;
  });
  assert.throws(() => resolveWorkspacePath(42), (err) => {
    assert.equal(err.code, 'code_intel_path_invalid');
    return true;
  });
});

test('resolveWorkspacePath: rejects an oversized path string', () => {
  assert.throws(() => resolveWorkspacePath('a'.repeat(5000)), (err) => {
    assert.equal(err.code, 'code_intel_path_too_long');
    return true;
  });
});

test('resolveWorkspacePath: rejects a null-byte-injected path', () => {
  assert.throws(() => resolveWorkspacePath('cortex-server/src/server.js\0.txt'), (err) => {
    assert.equal(err.code, 'code_intel_path_invalid');
    return true;
  });
});

test('isPathExcludedByDefault: matches a bare directory-name prefix, not a substring elsewhere', () => {
  assert.equal(isPathExcludedByDefault('node_modules/foo.js'), true);
  // A directory that merely CONTAINS "node_modules" as a substring in a
  // different position must not be excluded — only a genuine path-segment match.
  assert.equal(isPathExcludedByDefault('src/not-node_modules-related/foo.js'), false);
});

test('isPathExcludedByDefault: matches data-test-* glob-style directories', () => {
  assert.equal(isPathExcludedByDefault('data-test-abc123/db.sqlite'), true);
  assert.equal(isPathExcludedByDefault('cortex-server/data-test-xyz/file.js'), true);
});
