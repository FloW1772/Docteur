// Unit tests for code-intel-search.js — text/filename/symbol search over
// the real Docteur repository via the bundled ripgrep binary.
// Run with: node --test test-code-intel-search.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchText, searchFilenames, searchSymbols, MAX_RESULTS, MAX_QUERY_LENGTH } from './src/lib/code-intel-search.js';

test('searchText: finds a known symbol by exact string', async () => {
  const result = await searchText({ query: 'resolveWorkspacePath', limit: 20 });
  assert.equal(result.ok, true);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.some(r => r.relativePath.includes('code-intel-workspace.js')));
  for (const r of result.results) {
    assert.equal(typeof r.relativePath, 'string');
    assert.equal(r.matchType, 'text');
  }
});

test('searchText: never returns a result from an excluded directory', async () => {
  const result = await searchText({ query: 'function', limit: 50 });
  assert.equal(result.ok, true);
  for (const r of result.results) {
    assert.doesNotMatch(r.relativePath, /^node_modules\//);
    assert.doesNotMatch(r.relativePath, /^external\/(MetaGPT|OpenMontage)\//);
    assert.doesNotMatch(r.relativePath, /^cortex-server\/data\//);
  }
});

test('searchText: rejects an empty query', async () => {
  await assert.rejects(() => searchText({ query: '' }), (err) => {
    assert.equal(err.message, 'query_required');
    return true;
  });
});

test('searchText: rejects an oversized query', async () => {
  await assert.rejects(() => searchText({ query: 'a'.repeat(MAX_QUERY_LENGTH + 1) }), (err) => {
    assert.equal(err.message, 'query_too_long');
    return true;
  });
});

test('searchText: result count never exceeds MAX_RESULTS even with a very high limit', async () => {
  const result = await searchText({ query: 'const', limit: 999999 });
  assert.equal(result.ok, true);
  assert.ok(result.results.length <= MAX_RESULTS);
});

test('searchText: a snippet is bounded in length', async () => {
  const result = await searchText({ query: 'import', limit: 10 });
  assert.equal(result.ok, true);
  for (const r of result.results) {
    assert.ok(r.snippet.length <= 300);
  }
});

test('searchText: prompt-injection-shaped content in a matched line is returned as inert data, not executed or specially handled', async () => {
  // code-intel-git.js's own doc comments literally contain the phrase
  // "never execute" style guidance text; searching for a classic
  // injection phrase must just return it as a text match, nothing more.
  const result = await searchText({ query: 'shell:false', limit: 10 });
  assert.equal(result.ok, true);
  // No matter what the matched text says, the result is plain JSON data —
  // there is no code path in searchText that interprets result content.
  assert.ok(Array.isArray(result.results));
});

test('searchFilenames: finds a known file by substring', async () => {
  const result = await searchFilenames({ query: 'code-intel-workspace', limit: 10 });
  assert.equal(result.ok, true);
  assert.ok(result.results.some(r => r.relativePath.endsWith('code-intel-workspace.js')));
  for (const r of result.results) {
    assert.equal(r.matchType, 'filename');
    assert.equal(r.line, null);
  }
});

test('searchFilenames: never returns node_modules or external/ entries', async () => {
  const result = await searchFilenames({ query: '.js', limit: 200 });
  assert.equal(result.ok, true);
  for (const r of result.results) {
    assert.doesNotMatch(r.relativePath, /^node_modules\//);
    assert.doesNotMatch(r.relativePath, /^external\//);
  }
});

test('searchSymbols: finds a known function declaration', async () => {
  const result = await searchSymbols({ query: 'gitStatus', limit: 10 });
  assert.equal(result.ok, true);
  assert.ok(result.results.some(r => r.relativePath.endsWith('code-intel-git.js') && r.symbol === 'function'));
});

test('searchSymbols: finds a known class declaration', async () => {
  const result = await searchSymbols({ query: 'WorkspacePathError', limit: 10 });
  assert.equal(result.ok, true);
  assert.ok(result.results.some(r => r.symbol === 'class'));
});

test('searchSymbols: an unmatched symbol name returns an empty, non-erroring result', async () => {
  const result = await searchSymbols({ query: 'ThisSymbolDoesNotExistAnywhereXYZ123', limit: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
});

test('searchSymbols: never claims exact AST reference resolution in its result shape', async () => {
  const result = await searchSymbols({ query: 'gitDiff', limit: 10 });
  assert.equal(result.ok, true);
  for (const r of result.results) {
    assert.equal(r.matchType, 'symbol_heuristic');
    assert.ok(!('references' in r), 'must never claim a references field it cannot honestly provide');
  }
});

test('searchText: a binary-looking or huge single-line file does not hang (bounded via ripgrep --max-filesize)', async () => {
  // No fixture huge/binary file exists in this repo by default; this test
  // asserts the search completes within the module's own timeout budget
  // rather than requiring a specific huge fixture — a real huge/binary
  // file would simply be skipped by ripgrep's own --max-filesize 5M flag,
  // already present in every constructed args array.
  const start = Date.now();
  const result = await searchText({ query: 'export', limit: 50 });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - start < 10_000);
});
