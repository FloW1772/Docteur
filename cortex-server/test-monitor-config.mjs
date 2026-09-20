// Unit tests for monitor-config.js — server-side enum validation, never
// trusting a client-sent enum value.
// Run with: node --test test-monitor-config.mjs
import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSqlite } from './src/lib/sqlite.js';
import { getMonitorSettings, updateMonitorSettings } from './src/lib/monitor-config.js';

const TEST_DB_DIR = './data-test-monitor-config';

before(() => {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  initSqlite(`${TEST_DB_DIR}/test.db`);
});

after(() => {
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('getMonitorSettings: defaults are safe (disabled, autostart off, cloud AI off)', () => {
  const settings = getMonitorSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.autostart, false);
  assert.equal(settings.cloudAiEnabled, false);
});

test('updateMonitorSettings: rejects an invalid reportMode enum, falls back to default', () => {
  const settings = updateMonitorSettings({ reportMode: 'DELETE_EVERYTHING' });
  assert.equal(settings.reportMode, 'ON_SUMMARY');
});

test('updateMonitorSettings: rejects an invalid reportFrequency enum, falls back to default', () => {
  const settings = updateMonitorSettings({ reportFrequency: 'EVERY_MILLISECOND' });
  assert.equal(settings.reportFrequency, 'DAILY');
});

test('updateMonitorSettings: rejects an invalid notifyMode enum, falls back to default', () => {
  const settings = updateMonitorSettings({ notifyMode: 'SPAM_ME' });
  assert.equal(settings.notifyMode, 'IMPORTANT_ONLY');
});

test('updateMonitorSettings: clamps collectionIntervalMs to a sane bounded range', () => {
  const tooLow = updateMonitorSettings({ collectionIntervalMs: 1 });
  assert.equal(tooLow.collectionIntervalMs, 2000);
  const tooHigh = updateMonitorSettings({ collectionIntervalMs: 10_000_000 });
  assert.equal(tooHigh.collectionIntervalMs, 300000);
});

test('updateMonitorSettings: clamps retentionDays to [1, 30]', () => {
  const tooLow = updateMonitorSettings({ retentionDays: 0 });
  assert.equal(tooLow.retentionDays, 1);
  const tooHigh = updateMonitorSettings({ retentionDays: 9999 });
  assert.equal(tooHigh.retentionDays, 30);
});

test('updateMonitorSettings: persists across calls (round-trips via getMeta/setMeta)', () => {
  updateMonitorSettings({ enabled: true, autostart: true });
  const settings = getMonitorSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.autostart, true);
});

test('updateMonitorSettings: cloudAiEnabled is always coerced to a strict boolean', () => {
  const settings = updateMonitorSettings({ cloudAiEnabled: 'yes-please-send-everything' });
  assert.equal(settings.cloudAiEnabled, true);
  assert.equal(typeof settings.cloudAiEnabled, 'boolean');
});
