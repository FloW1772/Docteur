// BATCH B — Notebook pagination/performance measurement (autorisé 2026-09-16).
//
// Mesure AVANT/APRÈS demandée explicitement : Notebook 10 sources, 100
// sources, 1000 chunks. Le backend (routes/notebook.js, lib/notebook.js)
// était déjà borné depuis la Phase 5 (LIMIT/OFFSET paramétrés, index sur
// notebook_id, SUMMARY_SOURCE_CHAR_BUDGET) — ce fichier mesure le temps réel
// sur volume synthétique pour le documenter, pas pour découvrir un bug.
//
// DB synthétique en mémoire uniquement — jamais la base réelle.
// Run: node --test test-batch-b-notebook-performance.mjs
import './test-setup.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  initSqlite, createNotebook, addNotebookSource, listNotebookSources, countNotebookSources,
} from './src/lib/sqlite.js';
import { chunkSourceContent } from './src/lib/notebook.js';

initSqlite(':memory:');

function makeNotebookWithSources(count) {
  const notebookId = crypto.randomUUID();
  createNotebook({ id: notebookId, title: `Perf test ${count}`, description: '' });
  for (let i = 0; i < count; i++) {
    addNotebookSource({
      id: crypto.randomUUID(),
      notebookId,
      sourceType: 'neuron',
      sourceId: crypto.randomUUID(),
      title: `Source ${i}`,
      provenance: '',
      privacy: false,
      egressPolicy: 'cloud_allowed',
    });
  }
  return notebookId;
}

let results = {};

before(() => {
  results = {};
});

test('perf: Notebook with 10 sources — paginated fetch (limit=100)', () => {
  const notebookId = makeNotebookWithSources(10);
  const start = performance.now();
  const page = listNotebookSources(notebookId, { limit: 100, offset: 0 });
  const elapsedMs = performance.now() - start;
  assert.equal(page.length, 10);
  assert.equal(countNotebookSources(notebookId), 10);
  results.notebook10 = elapsedMs;
});

test('perf: Notebook with 100 sources — paginated fetch (limit=100)', () => {
  const notebookId = makeNotebookWithSources(100);
  const start = performance.now();
  const page = listNotebookSources(notebookId, { limit: 100, offset: 0 });
  const elapsedMs = performance.now() - start;
  assert.equal(page.length, 100);
  assert.equal(countNotebookSources(notebookId), 100);
  results.notebook100 = elapsedMs;
});

test('perf: Notebook with 100 sources — second page via offset', () => {
  const notebookId = makeNotebookWithSources(150);
  const start = performance.now();
  const page2 = listNotebookSources(notebookId, { limit: 100, offset: 100 });
  const elapsedMs = performance.now() - start;
  assert.equal(page2.length, 50);
  results.notebook150Page2 = elapsedMs;
});

test('perf: 1000 chunks — chunking cost for a large single source (synthetic content)', () => {
  // 1000 chunks of ~1200 chars each (CHUNK_MAX_CHARS in lib/notebook.js) means
  // ~1.2M chars of source content — a genuinely large single document.
  const bigContent = 'Ceci est une phrase de test répétée pour générer un contenu volumineux. '.repeat(16_000);
  const source = { id: crypto.randomUUID(), title: 'Gros document synthétique', content: bigContent };

  const start = performance.now();
  const chunks = chunkSourceContent(source);
  const elapsedMs = performance.now() - start;

  assert.ok(chunks.length >= 900, `expected ~1000 chunks, got ${chunks.length}`);
  results.chunking1000 = { elapsedMs, chunkCount: chunks.length };
});

test('perf: report summary (informational — always passes)', () => {
  console.log('\n=== NOTEBOOK PERFORMANCE (synthétique, DB en mémoire) ===');
  console.log(`Notebook 10 sources   : ${results.notebook10?.toFixed(2)} ms`);
  console.log(`Notebook 100 sources  : ${results.notebook100?.toFixed(2)} ms`);
  console.log(`Notebook 150 sources, page 2 (offset=100) : ${results.notebook150Page2?.toFixed(2)} ms`);
  console.log(`Chunking ~1000 chunks : ${results.chunking1000?.elapsedMs.toFixed(2)} ms (${results.chunking1000?.chunkCount} chunks générés)`);
  console.log('===========================================================\n');
  assert.ok(true);
});
