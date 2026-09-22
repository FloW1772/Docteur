import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import * as db from './src/lib/sqlite.js';
import { createSalesRoute } from './src/routes/sales.js';

db.initSqlite(':memory:');

// Deterministic mocks for the web research pipeline — no real network call
// in this suite, same discipline as test-investment-route.mjs.
const mockSearch = async () => [{ title: 'Mock Company Page', url: 'https://example.com/about', domain: 'example.com' }];
const mockFetchContent = async () => ({ title: 'Mock Extracted', text: 'We are hiring engineers and expanding our cloud platform. '.repeat(5), fallback: false });
const mockCheckUrl = () => {};

const app = new Hono().route('/api', createSalesRoute({
  search: mockSearch, fetchContent: mockFetchContent, checkUrl: mockCheckUrl,
}));

const request = async (path, body, method = 'GET') => {
  const response = await app.request(`http://localhost/api${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

// ── Forbidden action route shapes — always 403, never wired to anything ──

test('send route explicitly denied', async () => {
  const r = await request('/sales/leads/whatever/send', {}, 'POST');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'forbidden_action_denied');
});

test('send-email route explicitly denied', async () => {
  const r = await request('/sales/leads/whatever/send-email', {}, 'POST');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'forbidden_action_denied');
});

test('crm-write route explicitly denied', async () => {
  const r = await request('/sales/leads/whatever/crm-write', {}, 'POST');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'forbidden_action_denied');
});

test('submit-form route explicitly denied', async () => {
  const r = await request('/sales/leads/whatever/submit-form', {}, 'POST');
  assert.equal(r.status, 403);
});

test('purchase route explicitly denied', async () => {
  const r = await request('/sales/leads/whatever/purchase', {}, 'POST');
  assert.equal(r.status, 403);
});

test('browser-login route explicitly denied', async () => {
  const r = await request('/sales/leads/whatever/browser-login', {}, 'POST');
  assert.equal(r.status, 403);
});

test('social-post route explicitly denied', async () => {
  const r = await request('/sales/leads/whatever/social-post', {}, 'POST');
  assert.equal(r.status, 403);
});

// ── Lead creation ────────────────────────────────────────────────────────

test('valid lead creation succeeds', async () => {
  const r = await request('/sales/leads', { name: 'Jane Doe', company: 'Acme Corp' }, 'POST');
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Jane Doe');
});

test('empty lead name denied', async () => {
  const r = await request('/sales/leads', { name: '' }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'lead_name_invalid');
});

test('lead not found returns 404', async () => {
  const r = await request('/sales/leads/00000000-0000-0000-0000-000000000000');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'lead_not_found');
});

// ── RESEARCH — provenance + untrusted tagging ───────────────────────────

test('research succeeds and records sources with untrusted provenance', async () => {
  const create = await request('/sales/leads', { name: 'John Smith', company: 'Example Inc' }, 'POST');
  const leadId = create.body.id;

  const r = await request(`/sales/leads/${leadId}/research`, {}, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.sources.length, 1);
  assert.equal(r.body.sources[0].url, 'https://example.com/about');
  assert.equal(r.body.sources[0].untrusted, true);
  assert.ok(r.body.sources[0].retrievedAt);
});

test('research on nonexistent lead returns 404', async () => {
  const r = await request('/sales/leads/00000000-0000-0000-0000-000000000000/research', {}, 'POST');
  assert.equal(r.status, 404);
});

// ── SCORE — deterministic, transparent ──────────────────────────────────

test('score with matching criteria returns matched factors and a numeric score', async () => {
  const create = await request('/sales/leads', { name: 'Score Target', company: 'Cloud Co' }, 'POST');
  const leadId = create.body.id;
  await request(`/sales/leads/${leadId}/research`, {}, 'POST');

  const r = await request(`/sales/leads/${leadId}/score`, {
    criteria: [{ id: 'hiring', keyword: 'hiring', weight: 5, label: 'Actively hiring' }, { id: 'cloud', keyword: 'cloud', weight: 3, label: 'Cloud platform' }],
  }, 'POST');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.score, 'number');
  assert.equal(r.body.matched.length, 2);
  assert.equal(r.body.missingData.length, 0);
});

test('score with no research data reports insufficient_data, not a fabricated score', async () => {
  const create = await request('/sales/leads', { name: 'No Research', company: '' }, 'POST');
  const leadId = create.body.id;
  const r = await request(`/sales/leads/${leadId}/score`, {
    criteria: [{ id: 'x', keyword: 'nonexistent-term-xyz', weight: 1, label: 'X' }],
  }, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.score, null);
  assert.deepEqual(r.body.missingData, ['x']);
});

test('invalid criteria (missing weight) denied', async () => {
  const create = await request('/sales/leads', { name: 'Bad Criteria' }, 'POST');
  const leadId = create.body.id;
  const r = await request(`/sales/leads/${leadId}/score`, { criteria: [{ id: 'x', keyword: 'x' }] }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'criteria_weight_invalid');
});

// ── DRAFT — always labeled, never sent, always persisted locally ───────

test('outreach draft is labeled DRAFT — NOT SENT and never marked sent', async () => {
  const create = await request('/sales/leads', { name: 'Draft Target', company: 'Widgets LLC' }, 'POST');
  const leadId = create.body.id;

  const r = await request(`/sales/leads/${leadId}/draft`, { kind: 'outreach_message' }, 'POST');
  assert.equal(r.status, 201);
  assert.equal(r.body.draft.status, 'DRAFT — NOT SENT');
  assert.equal(r.body.draft.sent, false);
  assert.ok(r.body.draft.body.includes('Draft Target'));

  const listed = await request(`/sales/leads/${leadId}/drafts`);
  assert.equal(listed.body.drafts.length, 1);
  assert.equal(listed.body.drafts[0].sent, false);
  assert.equal(listed.body.drafts[0].status, 'DRAFT — NOT SENT');
});

test('crm_note draft is labeled and stored, never written to a real CRM', async () => {
  const create = await request('/sales/leads', { name: 'CRM Target', company: 'Note Co' }, 'POST');
  const leadId = create.body.id;
  const r = await request(`/sales/leads/${leadId}/draft`, { kind: 'crm_note' }, 'POST');
  assert.equal(r.status, 201);
  assert.equal(r.body.draft.kind, 'crm_note');
  assert.equal(r.body.draft.status, 'DRAFT — NOT SENT');
});

test('draft on nonexistent lead returns 404', async () => {
  const r = await request('/sales/leads/00000000-0000-0000-0000-000000000000/draft', {}, 'POST');
  assert.equal(r.status, 404);
});

// ── Full lead dossier includes sources + drafts for human review ───────

test('lead dossier includes research sources and drafts', async () => {
  const create = await request('/sales/leads', { name: 'Dossier Target', company: 'Full Co' }, 'POST');
  const leadId = create.body.id;
  await request(`/sales/leads/${leadId}/research`, {}, 'POST');
  await request(`/sales/leads/${leadId}/draft`, {}, 'POST');

  const r = await request(`/sales/leads/${leadId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.sources.length, 1);
  assert.equal(r.body.drafts.length, 1);
  assert.equal(r.body.drafts[0].sent, false);
});
