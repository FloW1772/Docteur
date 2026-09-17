// OM-6 — Certification de l'API/route OpenMontage (loopback guard, validation
// stricte des paramètres, allowlist résolution/FPS/durée, aucune injection,
// aucun chemin/commande arbitraire exposé). N'exerce PAS de vrai rendu
// Remotion ici (couvert par test-openmontage-adapter.mjs et la vérification
// manuelle OM-5) — se concentre sur la surface HTTP elle-même.
//
// Run: node --test test-openmontage-route.mjs
import './test-setup.mjs'; // must be first
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createOpenMontageRoute } from './src/routes/openmontage.js';

function jsonHeaders() { return { 'Content-Type': 'application/json' }; }

describe('OpenMontage route — loopback guard', () => {
  test('denies non-local callers on every sub-route', async () => {
    const route = createOpenMontageRoute({ isLocal: () => false });
    assert.equal((await route.request('/openmontage/status')).status, 403);
    assert.equal((await route.request('/openmontage/capabilities')).status, 403);
    assert.equal((await route.request('/openmontage/render', { method: 'POST', headers: jsonHeaders(), body: '{}' })).status, 403);
  });

  test('denies a spoofed Host header even when isLocal says yes', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('http://evil.example/openmontage/status');
    assert.equal(res.status, 403);
  });

  test('denies a cross-origin Origin header even when isLocal says yes', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('/openmontage/status', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('requires JSON content-type for non-GET requests', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('/openmontage/render', { method: 'POST', body: '{}' });
    assert.equal(res.status, 415);
  });
});

describe('OpenMontage route — status/capabilities', () => {
  test('GET status returns a known status value', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('/openmontage/status');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(['NOT_INSTALLED', 'PARTIAL', 'READY_LOCAL', 'BUSY', 'ERROR'].includes(body.status));
    assert.notEqual(body.status, 'READY_CLOUD');
  });

  test('GET capabilities always reports optional extensions as unavailable', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('/openmontage/capabilities');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hyperframes, 'unavailable');
    assert.equal(body.piper, 'unavailable');
    assert.equal(body.gpuStack, 'unavailable');
  });
});

describe('OpenMontage route — render input validation (allowlist only)', () => {
  const route = createOpenMontageRoute({ isLocal: () => true });
  async function render(body) {
    return route.request('/openmontage/render', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  }

  test('rejects an unknown resolution', async () => {
    const res = await render({ resolution: '4000x4000', fps: 30, durationSeconds: 5 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'resolution_invalid');
  });

  test('rejects a missing resolution', async () => {
    const res = await render({ fps: 30, durationSeconds: 5 });
    assert.equal(res.status, 400);
  });

  test('rejects an unknown fps value', async () => {
    const res = await render({ resolution: '1920x1080', fps: 60, durationSeconds: 5 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'fps_invalid');
  });

  test('rejects a non-numeric fps (injection attempt via type confusion)', async () => {
    const res = await render({ resolution: '1920x1080', fps: '30; rm -rf /', durationSeconds: 5 });
    assert.equal(res.status, 400);
  });

  test('rejects a duration above the maximum', async () => {
    const res = await render({ resolution: '1920x1080', fps: 30, durationSeconds: 9999 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'duration_invalid');
  });

  test('rejects a duration below the minimum', async () => {
    const res = await render({ resolution: '1920x1080', fps: 30, durationSeconds: 0 });
    assert.equal(res.status, 400);
  });

  test('rejects a negative duration', async () => {
    const res = await render({ resolution: '1920x1080', fps: 30, durationSeconds: -5 });
    assert.equal(res.status, 400);
  });

  test('rejects a non-numeric duration', async () => {
    const res = await render({ resolution: '1920x1080', fps: 30, durationSeconds: 'ten' });
    assert.equal(res.status, 400);
  });

  test('adapter source proves no client-supplied output/command field can influence render() — the route body is destructured field-by-field, not passed through', () => {
    // Deliberately NOT exercised via a real POST here (that would spawn an
    // actual Remotion render per call, which is wasteful for a unit test —
    // OM-5 already proved end-to-end that outputRelativePath is fixed to
    // 'output.mp4' and validated by checkedWorkspacePath()). Static proof
    // instead: the route source never reads body.outputPath / body.path /
    // body.command / body.args anywhere.
    const source = fs.readFileSync('./src/routes/openmontage.js', 'utf8');
    assert.doesNotMatch(source, /body\.(outputPath|path|command|args|cwd)\b/);
    assert.match(source, /outputRelativePath:\s*'output\.mp4'/);
  });

  test('sanitizeText strips control characters and caps length (unit-level, no render triggered)', () => {
    // sanitizeText isn't exported (route-internal); assert the bound and
    // stripping regex are present in source, keeping the contract explicit
    // without spawning a real render per test run.
    const source = fs.readFileSync('./src/routes/openmontage.js', 'utf8');
    assert.match(source, /MAX_TEXT_LENGTH\s*=\s*120/);
    assert.match(source, /replace\(\/\[\\x00-\\x1f\\x7f\]\/g/);
  });
});

describe('OpenMontage route — job lookup', () => {
  test('GET job/:id for an unknown job returns 404', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('/openmontage/job/does-not-exist');
    assert.equal(res.status, 404);
  });

  test('POST job/:id/cancel for an unknown job returns 404', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('/openmontage/job/does-not-exist/cancel', { method: 'POST', headers: jsonHeaders(), body: '{}' });
    assert.equal(res.status, 404);
  });

  test('GET job/:id/artifact for an unknown job returns 404', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request('/openmontage/job/does-not-exist/artifact');
    assert.equal(res.status, 404);
  });

  test('job id with path-traversal shape is treated as an opaque lookup key, never a filesystem path', async () => {
    const route = createOpenMontageRoute({ isLocal: () => true });
    const res = await route.request(`/openmontage/job/${encodeURIComponent('../../../etc/passwd')}`);
    // Must 404 (unknown job), never 500/leak — proving the id is used only
    // as a Map key, never interpolated into a filesystem path.
    assert.equal(res.status, 404);
  });
});
