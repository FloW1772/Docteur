import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_DEFINITION_BY_ID,
  FEATURE_DEFINITIONS,
  createFeatureDefinitionDraft,
  explainFeature,
  getExplainableFeatures,
  getFeatureDefinition,
  getMissingFeatureDefinitions,
  getRegisteredFeatures,
  registerFeatureDefinition,
  searchFeatures,
  validateFeatureRegistry,
} from '../src/content/featureRegistry.ts';

const ALL_FEATURES = FEATURE_DEFINITIONS.map(def => def.id);

test('all registered Help Center features are explainable', () => {
  const missing = getMissingFeatureDefinitions();
  assert.equal(missing.length, 0, `Missing FeatureDefinition: ${missing.join(', ') || 'none'}`);
  assert.ok(ALL_FEATURES.length > 0);
});

test('search finds registry features by canonical name, alias and text', () => {
  assert.ok(searchFeatures('strict local').some(item => item.id === 'settings-privacy'));
  assert.ok(searchFeatures('micro').some(item => item.id === 'settings-vocal' || item.aliases?.some(alias => alias.toLowerCase().includes('micro'))));
  assert.ok(searchFeatures('metagpt').some(item => item.id === 'metagpt'));
  assert.ok(searchFeatures('controle distant').some(item => item.id === 'settings-connections' || item.id === 'settings-external'));
});

test('future feature registration becomes explainable and searchable without manual UI changes', () => {
  const fixture = {
    id: 'future-test-feature',
    name: 'Future test feature',
    category: 'test',
    shortDescription: 'fixture for auto-sync verification',
    purpose: 'prove registry-driven discovery',
    howItWorks: 'registered definition is available across Help Center, Search and explanation',
    inputs: ['feature id'],
    outputs: ['visible in help', 'searchable'],
    security: ['no extra permission'],
    limitations: ['not yet user-facing beyond test'],
    prerequisites: ['registry registration'],
    relatedFeatures: ['settings-models'],
    status: 'AVAILABLE',
    available: true,
    verified: true,
    technicalReferences: ['src/content/featureRegistry.ts'],
    routes: ['help'],
    sourceModules: ['src/content/featureRegistry.ts'],
    sourceTests: ['scripts/test-feature-registry.mjs'],
    aliases: ['future fixture', 'fixture future'],
  };

  const previous = getFeatureDefinition('future-test-feature');
  const inserted = registerFeatureDefinition(fixture);
  try {
    assert.equal(inserted.id, 'future-test-feature');
    assert.equal(getFeatureDefinition('future-test-feature')?.status, 'AVAILABLE');
    assert.ok(getExplainableFeatures().some(item => item.id === 'future-test-feature'));
    assert.ok(searchFeatures('future fixture').some(item => item.id === 'future-test-feature'));
    assert.ok(searchFeatures('future test').some(item => item.id === 'future-test-feature'));
  } finally {
    if (previous) {
      FEATURE_DEFINITIONS.splice(
        FEATURE_DEFINITIONS.findIndex(item => item.id === 'future-test-feature'),
        1,
        previous,
      );
      FEATURE_DEFINITION_BY_ID.set('future-test-feature', previous);
    } else {
      FEATURE_DEFINITIONS.splice(
        FEATURE_DEFINITIONS.findIndex(item => item.id === 'future-test-feature'),
        1,
      );
      FEATURE_DEFINITION_BY_ID.delete('future-test-feature');
    }
  }
});

test('a missing future feature is detected as draft rather than available', () => {
  const draft = createFeatureDefinitionDraft('future-test-feature-draft', 'Future test feature draft', {
    category: 'test',
    shortDescription: 'fixture intended to prove missing auto-registration detection',
  });

  assert.equal(draft.id, 'future-test-feature-draft');
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.available, false);
  assert.equal(draft.verified, false);
  assert.ok(draft.limitations.length > 0);
  assert.match(explainFeature('future-test-feature-draft'), /non certifiée|DRAFT|pas encore/iu);
});

test('draft and invalid statuses are not explainable even if present', () => {
  const draft = createFeatureDefinitionDraft('draft-signal', 'Draft signal', {
    category: 'test',
    shortDescription: 'must never be explainable',
  });
  const invalid = { ...draft, id: 'invalid-signal', status: 'UNVERIFIED', available: false, verified: false };
  const previousDraft = getFeatureDefinition('draft-signal');
  const previousInvalid = getFeatureDefinition('invalid-signal');

  registerFeatureDefinition(draft);
  registerFeatureDefinition(invalid);

  try {
    assert.equal(getFeatureDefinition('draft-signal')?.status, 'DRAFT');
    assert.equal(getFeatureDefinition('invalid-signal')?.status, 'UNVERIFIED');
    assert.ok(!getExplainableFeatures().some(item => item.id === 'draft-signal'));
    assert.ok(!getExplainableFeatures().some(item => item.id === 'invalid-signal'));
  } finally {
    for (const [id, previous] of [['draft-signal', previousDraft], ['invalid-signal', previousInvalid]]) {
      const index = FEATURE_DEFINITIONS.findIndex(item => item.id === id);
      if (previous) {
        if (index >= 0) FEATURE_DEFINITIONS[index] = previous;
        else FEATURE_DEFINITIONS.push(previous);
        FEATURE_DEFINITION_BY_ID.set(id, previous);
      } else {
        if (index >= 0) FEATURE_DEFINITIONS.splice(index, 1);
        FEATURE_DEFINITION_BY_ID.delete(id);
      }
    }
  }
});

test('registry validation reports no duplicate or orphan definitions', () => {
  const report = validateFeatureRegistry();
  assert.deepEqual(report.missingDefinitions, []);
  assert.deepEqual(report.duplicateIds, []);
  assert.deepEqual(report.orphanAvailableDefinitions, []);
  assert.equal(report.valid, true, report.issues.join('; '));
});

test('registry exposes a stable central list', () => {
  const features = getRegisteredFeatures();
  assert.ok(features.length > 0);
  assert.ok(features.every(def => def.id && def.name));
});
