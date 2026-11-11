// [PAI-1] The Knowledge Graph "unavailable" panel speaks from the real backend reason (kg-boot.js), never from a stale
// "certification pending" claim. Usage: node --test scripts/test-kg-availability-unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { kgDisabledMessage } from '../src/lib/kg/kg-availability.ts';

test('every production disabled reason of kg-boot.js has an explicit message', () => {
  const boot = fs.readFileSync(new URL('../cortex-server/src/lib/kg-boot.js', import.meta.url), 'utf8');
  for (const reason of ['KG_NOT_ACTIVATED', 'KG_SCHEMA_MISMATCH', 'KG_PRODUCTION_STATE_INVALID', 'KG_OPEN_FAILED']) {
    assert.ok(boot.includes(`'${reason}'`), `${reason} still produced by kg-boot.js`);
    const m = kgDisabledMessage(reason);
    assert.equal(m.reason, reason);
    assert.doesNotMatch(m.title, /indisponible\.$/, `${reason} has its own explanation`);
  }
  assert.match(kgDisabledMessage('KG_NOT_ACTIVATED').detail, /décision manuelle/);
});

test('no stale certification claim; unknown / malformed reasons are not invented', () => {
  const panel = fs.readFileSync(new URL('../src/components/modals/KnowledgeGraphModal.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /certification \(KG-CERT\)/);
  const help = fs.readFileSync(new URL('../src/content/capabilities.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(help, /désactivé tant que sa certification/);
  assert.deepEqual(kgDisabledMessage(undefined), { title: 'Le graphe de connaissances est indisponible.', detail: 'Le serveur n’a pas précisé le motif.', reason: null });
  assert.equal(kgDisabledMessage('KG_SOMETHING_NEW').reason, 'KG_SOMETHING_NEW');
  for (const bad of ['<img src=x>', 'kg_lower', 'A'.repeat(200), 42]) assert.equal(kgDisabledMessage(bad).reason, null, String(bad));
});
