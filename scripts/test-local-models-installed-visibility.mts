import { test } from 'node:test';
import assert from 'node:assert/strict';

// AI-6 §21 regression: an Ollama model installed but absent from the AI-3
// catalog must remain visible as Installed, never silently hidden. This
// tests the pure derivation logic extracted from LocalModelsSettingsSection
// (mirrored here since the component itself has no test framework — see
// AI-4/AI-5 reports for that gap), matching the exact computation the
// component performs.

function deriveUncatalogedInstalled(
  cataloged: { ollamaPullName: string | null }[],
  allInstalledOllamaNames: string[],
): string[] {
  const catalogedPullNames = new Set(
    cataloged.map(d => d.ollamaPullName).filter((n): n is string => !!n),
  );
  return allInstalledOllamaNames.filter(name => !catalogedPullNames.has(name));
}

test('a real Ollama model absent from the catalog is reported as uncataloged-but-installed, not hidden', () => {
  const catalogDistributions = [{ ollamaPullName: 'qwen3.8:27b' }, { ollamaPullName: 'gpt-oss:20b' }];
  const allInstalled = ['qwen3.8:27b', 'my-custom-finetune:latest'];
  const result = deriveUncatalogedInstalled(catalogDistributions, allInstalled);
  assert.deepEqual(result, ['my-custom-finetune:latest']);
});

test('a fully-cataloged installed model produces an empty uncataloged list', () => {
  const catalogDistributions = [{ ollamaPullName: 'qwen3.8:27b' }];
  const allInstalled = ['qwen3.8:27b'];
  assert.deepEqual(deriveUncatalogedInstalled(catalogDistributions, allInstalled), []);
});

test('empty installed list produces an empty result, no crash', () => {
  assert.deepEqual(deriveUncatalogedInstalled([{ ollamaPullName: 'x' }], []), []);
});

test('distributions with null ollamaPullName never match by accident', () => {
  const catalogDistributions = [{ ollamaPullName: null }];
  const allInstalled = ['some-model:latest'];
  assert.deepEqual(deriveUncatalogedInstalled(catalogDistributions, allInstalled), ['some-model:latest']);
});
