import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  initRassilonScratch, getJobScratchDir, cleanupJobScratchDir, getScratchUsageBytes,
  sweepScratchOnBoot, resetRassilonScratchForTests,
} from './src/lib/rassilon-scratch.js';

const SCRATCH_DIR = './data-test-rassilon-scratch/scratch';

test.beforeEach(() => {
  fs.rmSync('./data-test-rassilon-scratch', { recursive: true, force: true });
  resetRassilonScratchForTests();
  initRassilonScratch(SCRATCH_DIR);
});

test('initRassilonScratch creates the root directory', () => {
  assert.ok(fs.existsSync(SCRATCH_DIR));
});

test('getJobScratchDir creates and returns a per-job directory', () => {
  const dir = getJobScratchDir('job-abc123');
  assert.ok(fs.existsSync(dir));
  assert.equal(path.basename(dir), 'job-abc123');
});

test('cleanupJobScratchDir removes a job\'s directory and its contents', () => {
  const dir = getJobScratchDir('job-cleanup-1');
  fs.writeFileSync(path.join(dir, 'output.json'), '{"result":true}');
  assert.ok(fs.existsSync(dir));
  cleanupJobScratchDir('job-cleanup-1');
  assert.ok(!fs.existsSync(dir));
});

test('getScratchUsageBytes reflects written file sizes', () => {
  const dir = getJobScratchDir('job-usage-1');
  fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.alloc(1024, 1));
  const usage = getScratchUsageBytes();
  assert.ok(usage >= 1024);
});

test('sweepScratchOnBoot removes every per-job subdirectory', () => {
  getJobScratchDir('job-sweep-1');
  getJobScratchDir('job-sweep-2');
  const before = fs.readdirSync(SCRATCH_DIR);
  assert.equal(before.length, 2);
  const removed = sweepScratchOnBoot();
  assert.equal(removed, 2);
  const after = fs.readdirSync(SCRATCH_DIR);
  assert.equal(after.length, 0);
});

test('sweepScratchOnBoot never removes a non-job-shaped entry (defensive, though none should exist)', () => {
  fs.writeFileSync(path.join(SCRATCH_DIR, 'not-a-job-dir.txt'), 'x');
  const removed = sweepScratchOnBoot();
  assert.equal(removed, 0);
  assert.ok(fs.existsSync(path.join(SCRATCH_DIR, 'not-a-job-dir.txt')));
});

test('cleanupJobScratchDir on a non-existent job is a no-op, never throws', () => {
  assert.doesNotThrow(() => cleanupJobScratchDir('job-never-existed'));
});
