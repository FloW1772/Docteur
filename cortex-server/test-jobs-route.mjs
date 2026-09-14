import './test-setup.mjs'; // must be first: sets DOCTEUR_TEST_MODE before any provider import
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createJobsRoute } from './src/routes/jobs.js';

// Jobs are intentionally in-memory only (see comment at top of jobs.js) —
// they are wiped by any cortex-server restart. This is a deliberate design
// choice, not a persistence bug: these tests document and lock in the
// contract the frontend relies on (a 404 with code: 'JOB_NOT_FOUND', DELETE
// staying idempotent) rather than guessing at intended behavior.

const app = new Hono();
app.route('/api', createJobsRoute());

test('POST /api/jobs creates a job and returns an id', async () => {
  const res = await app.request('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: '__E2E_TEST__ batch', total: 10 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.id);
});

test('PUT /api/jobs/:id updates an existing job', async () => {
  const createRes = await app.request('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: '__E2E_TEST__ batch', total: 5 }),
  });
  const { id } = await createRes.json();

  const putRes = await app.request(`/api/jobs/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: 3 }),
  });
  assert.equal(putRes.status, 200);
  const putBody = await putRes.json();
  assert.equal(putBody.ok, true);

  const listRes = await app.request('/api/jobs');
  const { jobs } = await listRes.json();
  const job = jobs.find(j => j.id === id);
  assert.equal(job.current, 3);
});

// Regression test: simulates the real-world scenario of a cortex-server
// restart clearing the in-memory job registry mid-batch (nodemon restart,
// or any process restart) while the frontend still has a stale job id and
// keeps sending debounced progress updates for it.
test('PUT /api/jobs/:id on an unknown id (job registry reset by restart) returns 404 with code JOB_NOT_FOUND', async () => {
  const res = await app.request('/api/jobs/does-not-exist-after-restart', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: 1 }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'JOB_NOT_FOUND');
});

test('DELETE /api/jobs/:id on an unknown id is idempotent (no error)', async () => {
  const res = await app.request('/api/jobs/does-not-exist-after-restart', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

// The job registry is a module-level Map (src/routes/jobs.js), not scoped
// per Hono app instance — a real process restart clears it because the
// whole Node process (and thus the module state) is gone, not because a new
// route object was created. This test documents that GET never errors even
// when the registry only contains jobs unrelated to a given stale id — the
// meaningful "job is gone" signal is the per-id 404 tested above, not GET
// returning an empty array (which it won't, in-process, until every
// existing job's TTL expires or it's explicitly deleted).
test('GET /api/jobs always returns ok:true with an array, never an error shape', async () => {
  const res = await app.request('/api/jobs');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.jobs));
});
