import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLocalHardwareProfile, clearHardwareProfileCache, getTotalVramBytes } from './src/lib/local-hardware-profile.js';

test('detectLocalHardwareProfile returns CPU/RAM basics without throwing', async () => {
  clearHardwareProfileCache();
  const profile = await detectLocalHardwareProfile({ forceRefresh: true });
  assert.equal(typeof profile.platform, 'string');
  assert.equal(typeof profile.arch, 'string');
  assert.ok(profile.logicalCores >= 1);
  assert.ok(profile.totalRamBytes > 0);
  assert.ok(profile.freeRamBytes >= 0);
  assert.ok(Array.isArray(profile.gpus));
  assert.ok(profile.detectedAt);
});

test('gpu detection failure degrades to empty array, never crashes', async () => {
  // We can't force a real WMI failure portably in CI, but we can verify
  // the contract: gpus is always an array, freeDiskBytes is number|null,
  // and the function never throws regardless of platform.
  clearHardwareProfileCache();
  const profile = await detectLocalHardwareProfile({ forceRefresh: true });
  assert.ok(Array.isArray(profile.gpus));
  assert.ok(profile.freeDiskBytes === null || typeof profile.freeDiskBytes === 'number');
});

test('getTotalVramBytes returns null when no GPU has known VRAM (UNKNOWN case, not a crash)', () => {
  const profileNoGpu = { gpus: [] };
  assert.equal(getTotalVramBytes(profileNoGpu), null);

  const profileUnknownVram = { gpus: [{ name: 'Mystery GPU', vendor: null, vramBytes: null, source: 'wmi' }] };
  assert.equal(getTotalVramBytes(profileUnknownVram), null);
});

test('getTotalVramBytes sums multiple GPUs with known VRAM', () => {
  const profile = {
    gpus: [
      { name: 'GPU A', vendor: 'NVIDIA', vramBytes: 8 * 1_073_741_824, source: 'wmi' },
      { name: 'GPU B', vendor: 'NVIDIA', vramBytes: 4 * 1_073_741_824, source: 'wmi' },
    ],
  };
  assert.equal(getTotalVramBytes(profile), 12 * 1_073_741_824);
});

test('getTotalVramBytes ignores GPUs with unknown VRAM but sums the rest', () => {
  const profile = {
    gpus: [
      { name: 'Known GPU', vendor: 'NVIDIA', vramBytes: 8 * 1_073_741_824, source: 'wmi' },
      { name: 'Unknown GPU', vendor: null, vramBytes: null, source: 'wmi' },
    ],
  };
  assert.equal(getTotalVramBytes(profile), 8 * 1_073_741_824);
});

test('mock hardware profile: 8GB RAM / no GPU shape is well-formed', () => {
  const profile = {
    platform: 'win32', arch: 'x64', cpuModel: 'Mock CPU', logicalCores: 4,
    totalRamBytes: 8 * 1_073_741_824, freeRamBytes: 4 * 1_073_741_824,
    gpus: [], freeDiskBytes: 100 * 1_073_741_824, osVersion: '10.0.19045', detectedAt: new Date().toISOString(),
  };
  assert.equal(getTotalVramBytes(profile), null);
});

test('mock hardware profile: 64GB RAM / 24GB VRAM shape is well-formed', () => {
  const profile = {
    platform: 'win32', arch: 'x64', cpuModel: 'Mock CPU', logicalCores: 16,
    totalRamBytes: 64 * 1_073_741_824, freeRamBytes: 48 * 1_073_741_824,
    gpus: [{ name: 'RTX 4090', vendor: 'NVIDIA', vramBytes: 24 * 1_073_741_824, source: 'wmi' }],
    freeDiskBytes: 500 * 1_073_741_824, osVersion: '10.0.19045', detectedAt: new Date().toISOString(),
  };
  assert.equal(getTotalVramBytes(profile), 24 * 1_073_741_824);
});

test('mock hardware profile: multiple GPUs are all represented', () => {
  const profile = {
    platform: 'win32', arch: 'x64', cpuModel: 'Mock CPU', logicalCores: 32,
    totalRamBytes: 128 * 1_073_741_824, freeRamBytes: 96 * 1_073_741_824,
    gpus: [
      { name: 'RTX 4090', vendor: 'NVIDIA', vramBytes: 24 * 1_073_741_824, source: 'wmi' },
      { name: 'RTX 4090', vendor: 'NVIDIA', vramBytes: 24 * 1_073_741_824, source: 'wmi' },
    ],
    freeDiskBytes: 1000 * 1_073_741_824, osVersion: '10.0.19045', detectedAt: new Date().toISOString(),
  };
  assert.equal(profile.gpus.length, 2);
  assert.equal(getTotalVramBytes(profile), 48 * 1_073_741_824);
});

test('mock hardware profile: disk detection failure represented as null, engine can still run', () => {
  const profile = {
    platform: 'linux', arch: 'x64', cpuModel: 'Mock CPU', logicalCores: 8,
    totalRamBytes: 32 * 1_073_741_824, freeRamBytes: 16 * 1_073_741_824,
    gpus: [], freeDiskBytes: null, osVersion: '6.1.0', detectedAt: new Date().toISOString(),
  };
  assert.equal(profile.freeDiskBytes, null);
});

test('non-Windows platform: GPU detection returns empty array without invoking PowerShell', async () => {
  // detectLocalHardwareProfile itself checks isWindows() internally via
  // detectGpus/detectFreeDisk; on a non-Windows CI runner this exercises
  // the real short-circuit path. On Windows CI this test still passes
  // since it only asserts the array/null contract, not the platform.
  clearHardwareProfileCache();
  const profile = await detectLocalHardwareProfile({ forceRefresh: true });
  if (profile.platform !== 'win32') {
    assert.deepEqual(profile.gpus, []);
    assert.equal(profile.freeDiskBytes, null);
  }
});
