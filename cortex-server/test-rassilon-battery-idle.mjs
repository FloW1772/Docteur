// Battery/idle/auto-pause/auto-resume tests (mission §46 Phase 3, §52/§53
// Phase 2): exercise the pause-decision LOGIC with injected provider
// values rather than depending on real laptop hardware or spawning
// PowerShell — runSafetyGuardSweep accepts powerProvider/idleProvider
// parameters specifically so this stays deterministic and hardware-
// independent. detectPowerStatus()/detectIdleStatus() themselves are
// thin WMI/P-Invoke probes already following the same fixed-script/
// execFile/shell:false shape as every other Windows probe in this
// codebase (maitre-windows-exec.js).
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import { initRassilonScratch } from './src/lib/rassilon-scratch.js';
import {
  initRassilonWorker, enableRassilon, pauseRassilon, getRassilonState, resetRassilonWorkerForTests,
  __runSafetyGuardSweepForTests,
} from './src/lib/rassilon-worker.js';

const TEST_DB = './data-test-rassilon-battery-idle/test.db';
const SCRATCH_DIR = './data-test-rassilon-battery-idle/scratch';

test.before(() => {
  fs.rmSync('./data-test-rassilon-battery-idle', { recursive: true, force: true });
  initSqlite(TEST_DB);
  initRassilonScratch(SCRATCH_DIR);
});

test.beforeEach(() => {
  resetRassilonWorkerForTests();
  initRassilonWorker({ logger: { info() {}, warn() {}, error() {} } });
});

function settings(overrides = {}) {
  return { maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1, maxJobDurationSec: 300, maxScratchMb: 1024, pauseOnBattery: false, minimumBatteryPercent: 30, pauseWhenUserActive: false, ...overrides };
}

const AC_POWER = async () => ({ status: 'AC_ONLY', batteryPercent: null, source: 'test' });
const ON_BATTERY_HIGH = async () => ({ status: 'ON_BATTERY', batteryPercent: 80, source: 'test' });
const ON_BATTERY_LOW = async () => ({ status: 'ON_BATTERY', batteryPercent: 5, source: 'test' });
const NO_BATTERY = async () => ({ status: 'NOT_PRESENT', batteryPercent: null, source: 'test' });
const POWER_UNKNOWN = async () => ({ status: 'UNKNOWN', batteryPercent: null, source: 'test' });
const USER_AWAY = async () => ({ idleMs: 999_999, source: 'test' });
const USER_ACTIVE = async () => ({ idleMs: 500, source: 'test' });
const IDLE_UNKNOWN = async () => ({ idleMs: null, source: 'test' });

// ── Auto-pause triggers (mission §46) ──────────────────────────────────────

test('provider: AC power — worker stays IDLE, not auto-paused', async () => {
  enableRassilon(settings({ pauseOnBattery: true, pauseWhenUserActive: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'IDLE');
});

test('provider: on battery with pauseOnBattery=true — worker AUTO_PAUSED (not manual PAUSED)', async () => {
  enableRassilon(settings({ pauseOnBattery: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_HIGH, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'AUTO_PAUSED');
});

test('provider: on battery with pauseOnBattery=false — worker does not auto-pause for battery alone', async () => {
  enableRassilon(settings({ pauseOnBattery: false }));
  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_HIGH, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'IDLE');
});

test('provider: low battery below minimumBatteryPercent — worker AUTO_PAUSED', async () => {
  enableRassilon(settings({ pauseOnBattery: true, minimumBatteryPercent: 30 }));
  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_LOW, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'AUTO_PAUSED');
});

test('provider: NOT_PRESENT (desktop, no battery) — never blocks the worker', async () => {
  enableRassilon(settings({ pauseOnBattery: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: NO_BATTERY, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'IDLE');
});

test('provider: idle (user away) with pauseWhenUserActive=true — worker does not pause for idle alone', async () => {
  enableRassilon(settings({ pauseWhenUserActive: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'IDLE');
});

test('provider: active (user present) with pauseWhenUserActive=true — worker AUTO_PAUSED', async () => {
  enableRassilon(settings({ pauseWhenUserActive: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_ACTIVE });
  assert.equal(getRassilonState(), 'AUTO_PAUSED');
});

test('provider: active (user present) with pauseWhenUserActive=false — worker does not auto-pause for activity', async () => {
  enableRassilon(settings({ pauseWhenUserActive: false }));
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_ACTIVE });
  assert.equal(getRassilonState(), 'IDLE');
});

test('idle provider result shape carries only a millisecond duration — no keystroke/mouse content field', async () => {
  const status = await USER_ACTIVE();
  assert.deepEqual(Object.keys(status).sort(), ['idleMs', 'source']);
  assert.equal(typeof status.idleMs, 'number');
});

// ── Idle-probe-failure conservative policy (mission §44) ───────────────────

test('idle probe UNKNOWN (idleMs=null) with pauseWhenUserActive=true: conservative — treated as NOT healthy, worker AUTO_PAUSED', async () => {
  enableRassilon(settings({ pauseWhenUserActive: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: IDLE_UNKNOWN });
  assert.equal(getRassilonState(), 'AUTO_PAUSED');
});

test('idle probe UNKNOWN with pauseWhenUserActive=false: no effect (the guard is disabled, so the failure is moot)', async () => {
  enableRassilon(settings({ pauseWhenUserActive: false }));
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: IDLE_UNKNOWN });
  assert.equal(getRassilonState(), 'IDLE');
});

// ── Power-probe-failure distinct from NOT_PRESENT (mission §43) ────────────

test('power probe UNKNOWN (genuine failure) is distinct from NOT_PRESENT — does not auto-pause on its own (only ON_BATTERY does)', async () => {
  enableRassilon(settings({ pauseOnBattery: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: POWER_UNKNOWN, idleProvider: USER_AWAY });
  // UNKNOWN is not ON_BATTERY, so pauseOnBattery's own check does not
  // fire for it — this documents the real behavior (UNKNOWN only matters
  // if some other check treats it specially; today it does not, which is
  // itself worth having a regression test for so behavior stays deliberate).
  assert.equal(getRassilonState(), 'IDLE');
});

// ── Auto-resume with hysteresis (mission §14/§15/§46) ───────────────────────

test('auto-resume: AUTO_PAUSED does not resume on a single healthy sweep (hysteresis requires 2 consecutive)', async () => {
  enableRassilon(settings({ pauseOnBattery: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_HIGH, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'AUTO_PAUSED');

  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY }); // 1st healthy sweep
  assert.equal(getRassilonState(), 'AUTO_PAUSED', 'should still be AUTO_PAUSED after only 1 healthy sweep');
});

test('auto-resume: AUTO_PAUSED resumes to IDLE after 2 consecutive healthy sweeps', async () => {
  enableRassilon(settings({ pauseOnBattery: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_HIGH, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'AUTO_PAUSED');

  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY }); // 1st healthy
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY }); // 2nd healthy
  assert.equal(getRassilonState(), 'IDLE');
});

test('auto-resume: hysteresis counter resets if a healthy streak is interrupted by an unhealthy sweep', async () => {
  enableRassilon(settings({ pauseOnBattery: true }));
  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_HIGH, idleProvider: USER_AWAY }); // AUTO_PAUSED
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY }); // healthy 1
  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_HIGH, idleProvider: USER_AWAY }); // unhealthy again — resets counter
  assert.equal(getRassilonState(), 'AUTO_PAUSED');
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY }); // healthy 1 (post-reset)
  assert.equal(getRassilonState(), 'AUTO_PAUSED', 'one healthy sweep after a reset should not be enough to resume');
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY }); // healthy 2 (post-reset)
  assert.equal(getRassilonState(), 'IDLE');
});

test('manual PAUSE is never auto-resumed by the safety-guard sweep, even under healthy conditions', async () => {
  enableRassilon(settings());
  pauseRassilon();
  assert.equal(getRassilonState(), 'PAUSED');

  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY });
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY });
  await __runSafetyGuardSweepForTests({ powerProvider: AC_POWER, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'PAUSED', 'manual PAUSED must stay PAUSED regardless of how many healthy sweeps run');
});

test('manual PAUSE is unaffected by an auto-pause-triggering condition too (stays PAUSED, not overwritten to AUTO_PAUSED)', async () => {
  enableRassilon(settings({ pauseOnBattery: true }));
  pauseRassilon();
  assert.equal(getRassilonState(), 'PAUSED');

  await __runSafetyGuardSweepForTests({ powerProvider: ON_BATTERY_HIGH, idleProvider: USER_AWAY });
  assert.equal(getRassilonState(), 'PAUSED');
});
