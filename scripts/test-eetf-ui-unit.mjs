// [EETF V1] EETF-7 — unit tests of the pure UI view model (Node type stripping).
// Usage: node --test scripts/test-eetf-ui-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_LABELS, MAP_ORDER, mapStatusLabel, mapDetail, materialStatusLabel, seamStatusLabel, warningLabel, progressInfo,
  providerStateLabel, generationBlockedReason, FORBIDDEN_CLAIMS, JOB_LABELS,
} from '../src/lib/eetf/ui-model.ts';

const noForbidden = (s, where) => { for (const w of FORBIDDEN_CLAIMS) assert.equal(s.includes(w), false, `${where}: "${w}" in "${s}"`); assert.equal(/\bPBR\b/.test(s), false, `${where}: PBR in "${s}"`); };

test('maps: 8 roles in order, honest statuses, unknown status shown as UNSUPPORTED, constants are not maps', () => {
  assert.deepEqual(MAP_ORDER, ['baseColor', 'normal', 'roughness', 'metallic', 'height', 'ao', 'opacity', 'emissive']);
  assert.equal(Object.keys(ROLE_LABELS).length, 8);
  assert.equal(mapStatusLabel('PBR_COMPLETE'), 'UNSUPPORTED');
  assert.equal(mapStatusLabel('MAGIC'), 'UNSUPPORTED');
  assert.match(mapDetail({ role: 'ROUGHNESS', status: 'USER_CONSTANT', exists: true, value: 0.7 }), /0\.70 \(pas une carte générée\)/);
  assert.match(mapDetail({ role: 'NORMAL', status: 'UNSUPPORTED', exists: false }), /Non pris en charge en V1/);
  assert.match(mapDetail({ role: 'OPACITY', status: 'FROM_SOURCE_ALPHA', exists: true }), /Canal alpha réel/);
  for (const s of ['GENERATED', 'DERIVED', 'ESTIMATED', 'USER_CONSTANT', 'FROM_SOURCE_ALPHA', 'UNSUPPORTED']) noForbidden(mapDetail({ role: 'X', status: s, exists: true, value: 0 }), s);
});

test('material status: V1 labels only; a "PBR complete" value is shown as refused, never as a capability', () => {
  assert.equal(materialStatusLabel('PARTIAL_MATERIAL'), 'Matériau partiel');
  assert.equal(materialStatusLabel('BASE_COLOR_ONLY'), 'Base color seule');
  for (const s of ['PBR_COMPLETE', 'pbr', '<script>']) { const l = materialStatusLabel(s); assert.equal(l, 'Statut non reconnu (refusé en V1)'); noForbidden(l, s); }
});

test('seams and warnings: measurements, never "seamless"; unknown codes sanitised', () => {
  for (const s of ['LOW_SEAM', 'HIGH_SEAM', 'MEASURED', undefined, 'SEAMLESS']) noForbidden(seamStatusLabel(s), String(s));
  assert.match(seamStatusLabel('LOW_SEAM'), /pas une garantie/);
  assert.equal(warningLabel('<img onerror=1>'), '1', 'only [A-Z0-9_] survives an unknown code');
  assert.match(warningLabel('LDR_CONTENT_IN_HDR_CONTAINER'), /pas un HDRI/);
  assert.match(warningLabel('NOT_CERTIFIED_EQUIRECTANGULAR'), /non vérifiée/);
});

test('progress is honest: a percentage only when RUNNING with a reported value', () => {
  assert.deepEqual(progressInfo({ status: 'RUNNING', progress: 0 }), { determinate: false, percent: null, text: 'En cours — progression inconnue' });
  assert.deepEqual(progressInfo({ status: 'RUNNING', progress: 0.42 }), { determinate: true, percent: 42, text: 'En cours — 42 %' });
  assert.deepEqual(progressInfo({ status: 'QUEUED', progress: 0 }), { determinate: false, percent: null, text: JOB_LABELS.QUEUED });
  assert.equal(progressInfo({ status: 'COMPLETED', progress: 1 }).percent, 100);
  assert.equal(progressInfo({ status: 'FAILED', progress: 0.3 }).determinate, false);
});

test('provider states and the generation button reason', () => {
  const st = (status, gen = false) => ({ enabled: true, provider: { id: 'comfyui', displayName: 'ComfyUI (local)', locality: 'LOOPBACK', status, reason: null, capabilities: [], models: [], engineVersion: null }, generation: { available: gen, reason: gen ? null : 'LOCAL_PROVIDER_UNAVAILABLE' } });
  assert.deepEqual(providerStateLabel(st('UNAVAILABLE')), { tone: 'warn', text: 'ComfyUI local non disponible' });
  assert.equal(providerStateLabel(st('AVAILABLE', true)).tone, 'ok');
  assert.match(providerStateLabel(st('REFUSED')).text, /refusé/);
  assert.match(providerStateLabel({ enabled: false }).text, /désactivé/);
  assert.equal(generationBlockedReason(st('UNAVAILABLE')), 'LOCAL_PROVIDER_UNAVAILABLE');
  assert.equal(generationBlockedReason(st('AVAILABLE', true)), null);
  assert.equal(generationBlockedReason({ enabled: false }), 'EETF_DISABLED');
  assert.equal(generationBlockedReason(null), 'EETF_DISABLED');
});
