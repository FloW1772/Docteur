import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { loadConfigFromFile } from 'vite';

test('development and preview both reject LAN sockets by default', async () => {
  const previous = process.env.LOCAL_NETWORK;
  process.env.LOCAL_NETWORK = 'false';
  try {
    const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' });
    assert.equal(config.preview.host, '::'); assert.equal(config.preview.strictPort, true);
    assert.equal(config.preview.https, undefined);
    const guard = config.plugins.find(plugin => plugin?.name === 'loopback-only');
    for (const hook of ['configureServer', 'configurePreviewServer']) {
      let onConnection;
      guard[hook]({ httpServer: { on: (event, callback) => { assert.equal(event, 'connection'); onConnection = callback; } } });
      for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.5', '10.0.0.1', undefined]) {
        let destroyed = false;
        onConnection({ remoteAddress, destroy: () => { destroyed = true; } });
        assert.equal(destroyed, !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress));
      }
    }
  } finally { if (previous === undefined) delete process.env.LOCAL_NETWORK; else process.env.LOCAL_NETWORK = previous; }
});

test('native Node watcher restarts on a source edit and ignores data writes', { timeout: 20000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-audit-watch-'));
  fs.mkdirSync(path.join(scratch, 'src')); fs.mkdirSync(path.join(scratch, 'data'));
  const filename = path.join(scratch, 'src', 'main.mjs');
  const content = version => `console.log('WATCH_VERSION_${version}'); setInterval(() => {}, 1000);`;
  fs.writeFileSync(filename, content(1));
  const child = spawn(process.execPath, ['--watch-path=src', '--watch-preserve-output', 'src/main.mjs'], {
    cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = ''; child.stdout.on('data', data => { output += String(data); });
  const waitFor = marker => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(`Watcher never produced ${marker}`)); }, 7000);
    const poll = setInterval(() => { if (output.includes(marker)) { clearTimeout(deadline); clearInterval(poll); resolve(); } }, 50);
  });
  try {
    await waitFor('WATCH_VERSION_1');
    fs.writeFileSync(path.join(scratch, 'data', 'fixture.json'), '{}');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(output.split('WATCH_VERSION_1').length - 1, 1);
    fs.writeFileSync(filename, content(2));
    await waitFor('WATCH_VERSION_2');
  } finally {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
    } else { child.kill('SIGTERM'); }
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
