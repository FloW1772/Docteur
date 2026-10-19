// Companion V1 - COMP-8B wiring tests.
// Tests specifically the model action proposal flow to the UI.
// [COMP-REMED-1] Ported to node:test: the COMP-8B script printed PASS / FAIL lines but never counted them ("0 passed,
// 0 failed") and never set a failing exit code. Same checks, one test each; a failure now fails the run.
import './test-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CompanionStore } from './src/lib/companion-store.js';
import { createCompanionActions } from './src/lib/companion-actions.js';
import { createCompanionUiService } from './src/lib/companion-ui-service.js';
import { parseModelActionOutput } from './src/lib/companion-action-registry.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comp8b-wiring-'));
const stores = [];
after(() => { for (const s of stores) { try { s.close(); } catch { /* closed */ } } try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });
let n = 0;
// Create a minimal companion mock for tests (no memory is needed for these actions)
const mockCompanion = () => ({
  preferences: () => ({ memoryEnabled: true, sessionMemoryEnabled: true, proposalEnabled: true, cloudContextEnabled: false }),
  setPreferences: () => ({ preferences: { memoryEnabled: true, sessionMemoryEnabled: true, proposalEnabled: true, cloudContextEnabled: false } }),
  view: () => null, setCompanionEnabled: () => null, setPrivacyScope: () => null, forget: () => ({ status: 'COMPLETE' }),
});
function rig(approvalChannel) {
  const store = CompanionStore.open({ dbPath: path.join(TMP, `c-${++n}.sqlite`) }); stores.push(store);
  const companion = mockCompanion();
  const actions = createCompanionActions({ store, companion, approvalChannel });
  // the UI service only exists on the product channel (it refuses DIRECT_TEST_ONLY by design)
  return { store, actions, ui: approvalChannel === 'UI_GESTURE' ? createCompanionUiService({ actions, companion, store, activation: 'DISABLED_PENDING_HUMAN_ACTIVATION' }) : null };
}

test('Parse model output - valid action proposal', () => {
  assert.equal(parseModelActionOutput(JSON.stringify({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} })).actionId, 'COMPANION.MEMORY.LIST');
});

test('actions.model.proposeFromModelOutput - READ_ONLY and LOCAL_MUTATION', () => {
  const { actions } = rig('DIRECT_TEST_ONLY');
  const ro = actions.model.proposeFromModelOutput(JSON.stringify({ actionId: 'COMPANION.MEMORY.LIST', parameters: {} }));
  assert.ok(ro.proposalId); assert.equal(ro.actionId, 'COMPANION.MEMORY.LIST'); assert.equal(ro.proposedBy, 'MODEL');
  const mu = actions.model.proposeFromModelOutput(JSON.stringify({ actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { memoryEnabled: true } }));
  assert.ok(mu.proposalId); assert.equal(mu.proposedBy, 'MODEL'); assert.equal(mu.requiresApproval, true);
});

test('UI Service proposeFromModel - READ_ONLY and LOCAL_MUTATION (full proposal view)', async () => {
  const { ui } = rig('UI_GESTURE');
  const ro = await ui.proposeFromModel({ rawOutput: JSON.stringify({ actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} } }) });
  assert.ok(ro.proposalId); assert.equal(ro.proposedBy, 'MODEL'); assert.equal(ro.confirmationKind, 'NONE');
  const mu = await ui.proposeFromModel({ rawOutput: JSON.stringify({ actionProposal: { actionId: 'COMPANION.PREFERENCES.UPDATE', parameters: { memoryEnabled: true } } }) });
  assert.ok(mu.proposalId); assert.equal(mu.proposedBy, 'MODEL'); assert.equal(mu.requiresApproval, true);
  assert.ok(mu.preview && mu.expiresAt, 'the review gets a preview and an expiry');
});

test('Proposal origin distinction - MODEL vs USER', async () => {
  const { ui } = rig('UI_GESTURE');
  const modelProposal = await ui.proposeFromModel({ rawOutput: JSON.stringify({ actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {} } }) });
  const userProposal = await ui.propose('COMPANION.MEMORY.LIST', {});
  assert.equal(modelProposal.proposedBy, 'MODEL');
  assert.equal(userProposal.proposedBy, 'USER');
});

test('Rejections: forbidden field, privacy loosening, unknown action', async () => {
  const { ui } = rig('UI_GESTURE');
  await assert.rejects(ui.proposeFromModel({ rawOutput: JSON.stringify({ actionProposal: { actionId: 'COMPANION.MEMORY.LIST', parameters: {}, approved: true } }) }), (e) => e.code === 'ACTION_NOT_ALLOWED' && e.details?.reason === 'MODEL_SELF_APPROVAL');
  await assert.rejects(ui.proposeFromModel({ rawOutput: JSON.stringify({ actionProposal: { actionId: 'COMPANION.MEMORY.SET_PRIVACY', parameters: { memoryId: 'x', scope: 'CLOUD_ALLOWED' } } }) }), (e) => e.code === 'ACTION_NOT_ALLOWED');
  await assert.rejects(ui.proposeFromModel({ rawOutput: JSON.stringify({ actionProposal: { actionId: 'UNKNOWN_ACTION', parameters: {} } }) }), (e) => e.code === 'UNKNOWN_ACTION');
});
