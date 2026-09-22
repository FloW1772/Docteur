// Unit tests for code-intel-gitignore.js — .gitignore-aware exclusion,
// layered on top of the fixed default exclusions.
// Run with: node --test test-code-intel-gitignore.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGitignoredOrExcluded, clearGitignoreCache } from './src/lib/code-intel-gitignore.js';

test('isGitignoredOrExcluded: a path matching a real root .gitignore rule is excluded (dist/)', () => {
  clearGitignoreCache();
  assert.equal(isGitignoredOrExcluded('dist/index.js'), true);
});

test('isGitignoredOrExcluded: a path matching *.log is excluded', () => {
  clearGitignoreCache();
  assert.equal(isGitignoredOrExcluded('cortex-server/debug.log'), true);
});

test('isGitignoredOrExcluded: a normal tracked source file is never excluded', () => {
  clearGitignoreCache();
  assert.equal(isGitignoredOrExcluded('cortex-server/src/server.js'), false);
  assert.equal(isGitignoredOrExcluded('src/App.tsx'), false);
});

test('isGitignoredOrExcluded: a report markdown file is never excluded', () => {
  clearGitignoreCache();
  assert.equal(isGitignoredOrExcluded('reports/KIWIX_POC_INTEGRATION_2026-09.md'), false);
});

test('isGitignoredOrExcluded: the fixed default exclusions still apply independent of .gitignore content', () => {
  clearGitignoreCache();
  assert.equal(isGitignoredOrExcluded('node_modules/foo/index.js'), true);
  assert.equal(isGitignoredOrExcluded('external/MetaGPT/README.md'), true);
});
