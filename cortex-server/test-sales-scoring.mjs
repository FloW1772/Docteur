import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead } from './src/lib/sales-scoring.js';

test('no criteria returns null score and empty detail', () => {
  const result = scoreLead({ criteria: [], sources: [] });
  assert.equal(result.score, null);
  assert.equal(result.dataCompleteness, 0);
});

test('all criteria matched yields score 100', () => {
  const result = scoreLead({
    criteria: [{ id: 'a', keyword: 'hiring', weight: 5, label: 'Hiring' }],
    sources: [{ content: 'We are hiring across the company.' }],
  });
  assert.equal(result.score, 100);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].occurrences, 1);
});

test('no criteria matched yields score 0, not null (data was evaluable, just absent)', () => {
  const result = scoreLead({
    criteria: [{ id: 'a', keyword: 'unicorn-startup-xyz', weight: 5, label: 'Unicorn' }],
    sources: [{ content: 'Standard boring company page with no special terms.' }],
  });
  assert.equal(result.score, 0);
  assert.equal(result.unmatched.length, 1);
});

test('missing source text marks criterion insufficient_data, never scored 0 silently', () => {
  const result = scoreLead({
    criteria: [{ id: 'a', keyword: 'hiring', weight: 5, label: 'Hiring' }],
    sources: [],
  });
  assert.equal(result.score, null);
  assert.deepEqual(result.missingData, ['a']);
});

test('weighted score reflects relative weights, not a simple average', () => {
  const result = scoreLead({
    criteria: [
      { id: 'heavy', keyword: 'cloud', weight: 9, label: 'Cloud' },
      { id: 'light', keyword: 'unicorn-xyz', weight: 1, label: 'Unicorn' },
    ],
    sources: [{ content: 'We run a cloud platform for enterprises.' }],
  });
  // matchedWeight=9, totalWeight=10 → 90
  assert.equal(result.score, 90);
});

test('multiple sources are combined into one corpus for matching', () => {
  const result = scoreLead({
    criteria: [{ id: 'a', keyword: 'expansion', weight: 1, label: 'Expansion' }],
    sources: [{ content: 'Company overview page.' }, { content: 'Recent news about our expansion plans.' }],
  });
  assert.equal(result.score, 100);
});

test('case-insensitive matching', () => {
  const result = scoreLead({
    criteria: [{ id: 'a', keyword: 'hiring', weight: 1, label: 'Hiring' }],
    sources: [{ content: 'WE ARE HIRING NOW.' }],
  });
  assert.equal(result.score, 100);
});

test('every returned criterion carries full audit detail, never opaque', () => {
  const result = scoreLead({
    criteria: [{ id: 'a', keyword: 'hiring', weight: 5, label: 'Hiring' }],
    sources: [{ content: 'hiring hiring hiring' }],
  });
  assert.equal(result.criteria[0].occurrences, 3);
  assert.equal(result.criteria[0].status, 'matched');
});
