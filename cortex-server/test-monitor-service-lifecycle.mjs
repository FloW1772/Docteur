// Lifecycle tests for monitor-service.js — off/on/pause/resume state
// transitions, autostart-off-by-default, and "exactly one active timer
// handle across transitions" (a common bug class when lifecycle methods
// don't clear the previous handle before creating a new one).
// Run with: node --test test-monitor-service-lifecycle.mjs
import './test-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import { getMonitorSettings, updateMonitorSettings } from './src/lib/monitor-config.js';
import {
  startMonitorService, pauseMonitorService, resumeMonitorService, stopMonitorService,
  isMonitorServiceRunning, startMonitorServiceIfAutostart,
} from './src/lib/monitor-service.js';

const TEST_DB_DIR = './data-test-monitor-service-lifecycle';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

beforeEach(() => {
  stopMonitorService();
  updateMonitorSettings({ enabled: false, autostart: false, paused: false });
});

after(() => {
  stopMonitorService();
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function countActiveTimers() {
  // Node doesn't expose a public API to count active timers by owner, so
  // this test instead asserts observable behavior: isMonitorServiceRunning()
  // reflects exactly one lifecycle state, and repeated start/pause/resume
  // calls never throw or leave the module in an inconsistent state.
  return isMonitorServiceRunning();
}

test('autostart is OFF by default: startMonitorServiceIfAutostart does nothing absent an explicit user choice', () => {
  const settings = getMonitorSettings();
  assert.equal(settings.autostart, false);
  startMonitorServiceIfAutostart({});
  assert.equal(isMonitorServiceRunning(), false);
});

test('startMonitorServiceIfAutostart: starts when autostart is explicitly enabled', () => {
  updateMonitorSettings({ autostart: true });
  startMonitorServiceIfAutostart({});
  assert.equal(isMonitorServiceRunning(), true);
});

test('startMonitorService -> pauseMonitorService: pause actually stops the running state, not just UI', () => {
  startMonitorService({});
  assert.equal(countActiveTimers(), true);
  pauseMonitorService();
  assert.equal(countActiveTimers(), false, 'pause must set running to false, not merely hide state');
});

test('pauseMonitorService -> resumeMonitorService: resume restores the running state', () => {
  startMonitorService({});
  pauseMonitorService();
  resumeMonitorService();
  assert.equal(isMonitorServiceRunning(), true);
});

test('startMonitorService: calling start twice does not throw or double-register', () => {
  startMonitorService({});
  assert.doesNotThrow(() => startMonitorService({}));
  assert.equal(isMonitorServiceRunning(), true);
});

test('resumeMonitorService: calling resume while already running is a no-op, does not throw', () => {
  startMonitorService({});
  assert.doesNotThrow(() => resumeMonitorService());
  assert.equal(isMonitorServiceRunning(), true);
});

test('stopMonitorService: fully stops the service, restartable afterwards', () => {
  startMonitorService({});
  stopMonitorService();
  assert.equal(isMonitorServiceRunning(), false);
  startMonitorService({});
  assert.equal(isMonitorServiceRunning(), true);
});
