import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { initSqlite } from './src/lib/sqlite.js';
import { createPromptGeneratorRoute } from './src/routes/prompt-generator.js';

initSqlite(':memory:');

const app = new Hono();
app.route('/api', createPromptGeneratorRoute({
  services: { ollamaHealth: async () => ({ connected: false, models: [] }) },
  ollamaClient: null,
  logger: null,
}));

// The 5 built-in templates ship as ordinary rows seeded on first empty read
// (same pattern as candidature_saved_prompts in sqlite.js) — no is_system
// flag. These tests lock in: seeding happens exactly once, all 5 are
// present with the right categories, they're fully editable/deletable like
// any user-created template, and none of these routes ever touch an AI
// provider (no fetch mock needed anywhere in this file — if one were
// required, it would mean a route wrongly called out to a model).

test('GET /prompt-generator/templates seeds the 5 built-in templates on first read', async () => {
  const res = await app.request('/api/prompt-generator/templates');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.templates.length, 5);

  const names = body.templates.map(t => t.name);
  assert.ok(names.some(n => n.includes('Présentation d’offre')));
  assert.ok(names.some(n => n.includes('Prompting inversé')));
  assert.ok(names.some(n => n.includes('portrait professionnel')));
  assert.ok(names.some(n => n.includes('Résumé court')));
  assert.ok(names.some(n => n.includes('CV optimisé ATS')));

  const categories = new Set(body.templates.map(t => t.category));
  assert.deepEqual(categories, new Set(['Business', 'Prompting', 'Image', 'Rédaction', 'Emploi']));
});

test('placeholders like [ACTIVITÉ] and [TEXTE] survive seeding verbatim', async () => {
  const res = await app.request('/api/prompt-generator/templates');
  const { templates } = await res.json();

  const pitch = templates.find(t => t.name.includes('Présentation d’offre'));
  assert.ok(pitch.prompt_text.includes('[ACTIVITÉ]'));
  assert.ok(pitch.prompt_text.includes('[OFFRE]'));

  const resume = templates.find(t => t.name.includes('Résumé court'));
  assert.ok(resume.prompt_text.includes('[TEXTE]'));

  const cv = templates.find(t => t.name.includes('CV optimisé ATS'));
  assert.ok(cv.prompt_text.includes('[POSTE]'));
  assert.ok(cv.prompt_text.includes('[EXPÉRIENCES]'));

  const portrait = templates.find(t => t.name.includes('portrait professionnel'));
  assert.ok(portrait.description.toLowerCase().includes('image fournie'));
});

test('GET /prompt-generator/templates does not re-seed on a second call (idempotent)', async () => {
  const first = await (await app.request('/api/prompt-generator/templates')).json();
  const second = await (await app.request('/api/prompt-generator/templates')).json();
  assert.equal(second.templates.length, first.templates.length);
  assert.deepEqual(second.templates.map(t => t.id).sort(), first.templates.map(t => t.id).sort());
});

test('a seeded template can be edited exactly like a user-created one (no is_system distinction)', async () => {
  const list = await (await app.request('/api/prompt-generator/templates')).json();
  const target = list.templates[0];

  const res = await app.request(`/api/prompt-generator/templates/${target.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '__E2E_TEST__ renamed', prompt_text: 'edited content' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.template.name, '__E2E_TEST__ renamed');
  assert.equal(body.template.prompt_text, 'edited content');
});

test('a seeded template can be deleted exactly like a user-created one', async () => {
  const list = await (await app.request('/api/prompt-generator/templates')).json();
  const target = list.templates.find(t => t.name !== '__E2E_TEST__ renamed');

  const res = await app.request(`/api/prompt-generator/templates/${target.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const after = await (await app.request('/api/prompt-generator/templates')).json();
  assert.ok(!after.templates.some(t => t.id === target.id));
});

test('POST /prompt-generator/templates creates a new user template alongside the built-ins', async () => {
  const res = await app.request('/api/prompt-generator/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '__E2E_TEST__ custom template', category: 'Test', prompt_text: 'custom prompt text' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.template.name, '__E2E_TEST__ custom template');
  assert.equal(body.template.category, 'Test');

  const list = await (await app.request('/api/prompt-generator/templates')).json();
  assert.ok(list.templates.some(t => t.id === body.template.id));

  // cleanup
  await app.request(`/api/prompt-generator/templates/${body.template.id}`, { method: 'DELETE' });
});

test('POST /prompt-generator/templates rejects a missing name or prompt_text', async () => {
  const noName = await app.request('/api/prompt-generator/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt_text: 'x' }),
  });
  assert.equal(noName.status, 400);

  const noPrompt = await app.request('/api/prompt-generator/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(noPrompt.status, 400);
});

test('DELETE /prompt-generator/templates/:id on an unknown id returns 404, not a crash', async () => {
  const res = await app.request('/api/prompt-generator/templates/does-not-exist', { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('PUT /prompt-generator/templates/reorder changes order_index without losing any template', async () => {
  const before = await (await app.request('/api/prompt-generator/templates')).json();
  const ids = before.templates.map(t => t.id);
  const reversed = [...ids].reverse();

  const res = await app.request('/api/prompt-generator/templates/reorder', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_ids: reversed }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.templates.length, before.templates.length);
  assert.equal(body.templates[0].id, reversed[0]);
});

test('POST /prompt-generator/templates/:id/touch only updates last_used_at — never triggers an AI call or changes prompt_text', async () => {
  const list = await (await app.request('/api/prompt-generator/templates')).json();
  const target = list.templates[0];
  assert.equal(target.last_used_at, null);

  const res = await app.request(`/api/prompt-generator/templates/${target.id}/touch`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.template.last_used_at);
  assert.equal(body.template.prompt_text, target.prompt_text); // untouched
});

test('this route file never calls fetch or any AI provider module for template CRUD (structural guard)', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('./src/routes/prompt-generator.js', import.meta.url), 'utf8');
  const templatesBlockStart = source.indexOf("route.get('/prompt-generator/templates'");
  const templatesBlockEnd = source.indexOf("// ── GET /prompt-generator — list with filters");
  assert.ok(templatesBlockStart !== -1 && templatesBlockEnd !== -1 && templatesBlockEnd > templatesBlockStart);
  const block = source.slice(templatesBlockStart, templatesBlockEnd);
  assert.equal(block.includes('runAiTask'), false);
  assert.equal(block.includes('ollamaClient'), false);
  assert.equal(/fetch\(/.test(block), false);
});
