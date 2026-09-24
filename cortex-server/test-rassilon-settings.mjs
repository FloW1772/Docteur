import './test-setup.mjs';
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite, getRassilonSettings, updateRassilonSettings, setRassilonEnabled } from './src/lib/sqlite.js';
import { validateSettingsPatch, RassilonSettingsError } from './src/lib/rassilon-settings.js';

const TEST_DB = './data-test-rassilon-settings/test.db';

before(() => {
  fs.rmSync('./data-test-rassilon-settings', { recursive: true, force: true });
  initSqlite(TEST_DB);
});

test('default settings: disabled, conservative quotas', () => {
  const settings = getRassilonSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.maxCpuPercent, 25);
  assert.equal(settings.maxRamMb, 2048);
  assert.equal(settings.maxConcurrentJobs, 1);
  assert.equal(settings.maxJobDurationSec, 300);
  assert.equal(settings.maxScratchMb, 1024);
  assert.equal(settings.pauseOnBattery, true);
  assert.equal(settings.minimumBatteryPercent, 30);
  assert.equal(settings.pauseWhenUserActive, true);
  assert.equal(settings.approvalMode, 'ASK_EACH_JOB');
});

test('enable/disable via setRassilonEnabled toggles the enabled flag only', () => {
  setRassilonEnabled(true);
  assert.equal(getRassilonSettings().enabled, true);
  setRassilonEnabled(false);
  assert.equal(getRassilonSettings().enabled, false);
});

test('updateRassilonSettings persists and reloads correctly', () => {
  updateRassilonSettings({ max_cpu_percent: 40, max_ram_mb: 4096 });
  const settings = getRassilonSettings();
  assert.equal(settings.maxCpuPercent, 40);
  assert.equal(settings.maxRamMb, 4096);
});

test('updateRassilonSettings ignores unknown/forbidden fields (e.g. enabled)', () => {
  const before1 = getRassilonSettings().enabled;
  updateRassilonSettings({ enabled: 1, max_cpu_percent: 33 });
  const after = getRassilonSettings();
  assert.equal(after.enabled, before1, 'enabled must not change via generic settings update');
  assert.equal(after.maxCpuPercent, 33);
});

test('validateSettingsPatch: rejects enabled field entirely', () => {
  assert.throws(() => validateSettingsPatch({ enabled: true }), RassilonSettingsError);
});

test('validateSettingsPatch: rejects out-of-range CPU/RAM/duration/concurrency/scratch/battery values', () => {
  assert.throws(() => validateSettingsPatch({ maxCpuPercent: 0 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxCpuPercent: 91 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxRamMb: 10 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxRamMb: 999_999 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxConcurrentJobs: 0 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxConcurrentJobs: 5 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxJobDurationSec: 0 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxJobDurationSec: 4000 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ maxScratchMb: 1 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ minimumBatteryPercent: -1 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ minimumBatteryPercent: 101 }), RassilonSettingsError);
});

test('validateSettingsPatch: accepts values at the boundary (min/max inclusive)', () => {
  assert.doesNotThrow(() => validateSettingsPatch({ maxCpuPercent: 1 }));
  assert.doesNotThrow(() => validateSettingsPatch({ maxCpuPercent: 90 }));
  assert.doesNotThrow(() => validateSettingsPatch({ maxConcurrentJobs: 1 }));
  assert.doesNotThrow(() => validateSettingsPatch({ maxConcurrentJobs: 4 }));
});

test('validateSettingsPatch: rejects wrong types for booleans/arrays/enum', () => {
  assert.throws(() => validateSettingsPatch({ pauseOnBattery: 'yes' }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ pauseWhenUserActive: 1 }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ acceptedJobTypes: 'SAFE_CPU_TASK' }), RassilonSettingsError);
  assert.throws(() => validateSettingsPatch({ approvalMode: 'YOLO' }), RassilonSettingsError);
});

test('validateSettingsPatch: rejects empty patch', () => {
  assert.throws(() => validateSettingsPatch({}), RassilonSettingsError);
});

test('validateSettingsPatch: accepted patch is exactly the snake_case DB shape', () => {
  const patch = validateSettingsPatch({ maxCpuPercent: 50, pauseOnBattery: false, approvalMode: 'AUTO_ACCEPT_ALLOWED_TYPES' });
  assert.deepEqual(patch, { max_cpu_percent: 50, pause_on_battery: 0, approval_mode: 'AUTO_ACCEPT_ALLOWED_TYPES' });
});
