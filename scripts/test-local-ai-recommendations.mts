import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendedSubset, MAX_RECOMMENDED } from '../src/lib/localAiRecommendations.ts';
import type { LocalAiRecommendationEntry, FitRating, ModelCatalogEntry, ModelDistribution } from '../src/lib/cortex/client';

function mockEntry(overrides: {
  id: string;
  useCaseTags?: string[];
  rating?: FitRating;
  provenance?: ModelCatalogEntry['provenance'];
}): LocalAiRecommendationEntry {
  const { id, useCaseTags = ['GENERAL'], rating = 'GOOD', provenance = 'official' } = overrides;
  return {
    model: {
      canonicalId: id, name: id, family: 'test', publisher: 'test',
      provenance, trustLevel: 'OFFICIAL', upstreamCanonicalId: null,
      officialSourceUrl: null, huggingFaceUrl: null, githubUrl: null,
      releaseDate: null, lastVerifiedAt: '2026-09-21', license: 'Apache-2.0',
      commercialUse: 'unrestricted', additionalPolicies: [],
      architecture: { type: 'dense', totalParameters: 1_000_000_000, activeParameters: 1_000_000_000 },
      contextLength: null,
      capabilities: { reasoning: false, coding: false, toolCalling: false, vision: false, audio: false, video: false, multilingual: false },
      modalities: ['text'], strengths: [], limitations: [],
      lifecycle: { status: 'current', staleAfter: null, replacedBy: null },
      useCaseTags,
    } satisfies ModelCatalogEntry,
    distribution: {
      id: `${id}-dist`, canonicalId: id, runtime: 'OLLAMA', source: 'ollama-library',
      sourceUrl: null, ollamaPullName: `${id}:latest`, huggingFaceRepo: null, localArtifactPath: null,
      artifactSizeBytes: 1_000_000_000, precision: null, quantization: null,
      executionLocation: 'LOCAL', verified: true, lastVerifiedAt: '2026-09-21',
      requiresRemoteCode: false, estimatedRequirements: null,
    } satisfies ModelDistribution,
    fit: { rating, reasons: [], warnings: [], estimates: { ramBytes: null, vramBytes: null, diskBytes: null }, confidence: 'UNKNOWN' },
    installed: false,
  };
}

test('caps the recommended subset at MAX_RECOMMENDED even with many eligible entries', () => {
  const entries = Array.from({ length: 20 }, (_, i) => mockEntry({ id: `m${i}`, useCaseTags: ['LOW_RESOURCE', 'CODING', 'REASONING', 'MULTIMODAL', 'POWERFUL'] }));
  const result = buildRecommendedSubset(entries);
  assert.ok(result.length <= MAX_RECOMMENDED);
});

test('NOT_RECOMMENDED entries are never selected', () => {
  const entries = [mockEntry({ id: 'bad', rating: 'NOT_RECOMMENDED', useCaseTags: ['CODING'] })];
  const result = buildRecommendedSubset(entries);
  assert.equal(result.length, 0);
});

test('a slot is skipped, not forced, when nothing qualifies for it', () => {
  const entries = [mockEntry({ id: 'general-only', useCaseTags: ['GENERAL'] })];
  const result = buildRecommendedSubset(entries);
  // Only the "Best overall fit" (untagged) slot can match; CODING/REASONING/etc. slots must not force this entry in twice.
  assert.equal(result.length, 1);
});

test('prefers higher fit rating when multiple candidates qualify for the same slot', () => {
  const entries = [
    mockEntry({ id: 'excellent-coder', useCaseTags: ['CODING'], rating: 'EXCELLENT' }),
    mockEntry({ id: 'tight-coder', useCaseTags: ['CODING'], rating: 'TIGHT' }),
  ];
  const result = buildRecommendedSubset(entries);
  const codingPick = result.find(r => r.badge === 'Good fit for coding');
  assert.ok(codingPick, 'expected a "Good fit for coding" recommendation');
  assert.equal(codingPick!.entry.model.canonicalId, 'excellent-coder');
});

test('same entry is never duplicated across multiple badge slots', () => {
  const entries = [mockEntry({ id: 'versatile', useCaseTags: ['CODING', 'REASONING', 'LOW_RESOURCE'], rating: 'EXCELLENT' })];
  const result = buildRecommendedSubset(entries);
  const ids = result.map(r => r.entry.distribution.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('empty input produces an empty, well-formed result', () => {
  const result = buildRecommendedSubset([]);
  assert.deepEqual(result, []);
});

test('badges never contain "best model" / "#1" marketing language', () => {
  const entries = Array.from({ length: 10 }, (_, i) => mockEntry({ id: `m${i}`, useCaseTags: ['CODING', 'REASONING', 'MULTIMODAL', 'POWERFUL', 'LOW_RESOURCE'] }));
  const result = buildRecommendedSubset(entries);
  for (const r of result) {
    assert.doesNotMatch(r.badge, /best model|#1|number one/i);
  }
});
