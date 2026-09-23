// OMEGA ADMIN V1 safe live read-only Windows checks.
// No high-impact action is called from this file.
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeRealAdminAction, OMEGA_ADMIN_READ_ACTIONS } from './src/lib/omega-admin.js';

for (const action of OMEGA_ADMIN_READ_ACTIONS) {
  test(`${action} executes as a bounded read-only semantic action`, async () => {
    const result = await executeRealAdminAction(action);
    assert.equal(result.ok, true, `${action} failed with ${result.error ?? 'unknown error'}`);
    assert.equal(result.action, action);
    if (action === 'GET_PROCESS_LIST') assert.ok(Array.isArray(result.processes) && result.processes.length <= 200);
    if (action === 'GET_SERVICE_STATUS') assert.ok(Array.isArray(result.services) && result.services.length <= 200);
    if (action === 'GET_NETWORK_STATUS') assert.ok(Array.isArray(result.interfaces) && result.interfaces.length <= 64);
    if (action === 'GET_DISK_STATUS') assert.ok(Array.isArray(result.disks) && result.disks.length <= 32);
  });
}
