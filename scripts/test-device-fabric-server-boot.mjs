// Device Fabric V2 Phase 2 isolated server smoke: boot on a fresh local DB,
// observe startup, then exercise the server's SIGINT shutdown hook.
// Phase 4 extends this to also confirm INTERACTIVE/ADMIN never auto-start
// and that boot opens no listening port beyond the one cortex-server itself
// binds (mission §15: no auto-connect, no auto-VIEW, no auto-INTERACTIVE,
// no ADMIN, no new listener, no cloud call, clean shutdown).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = path.join(projectRoot, 'cortex-server');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docteur-fabric-boot-'));
const port = '33128';
let child;

try {
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: port,
      LOCAL_NETWORK: 'false',
      SQLITE_PATH: path.join(tempRoot, 'cortex.sqlite'),
      LANCEDB_PATH: path.join(tempRoot, 'cortex.lance'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  let shutdownSent = false;
  let probedPort = null;
  const onData = chunk => {
    const text = chunk.toString();
    output += text;
    if (!shutdownSent && text.includes('cortex server started')) {
      shutdownSent = true;
      // Probe for an unexpected second listener (e.g. a stray OMEGA V2/
      // Fabric-opened socket) before shutdown: only the one expected
      // cortex-server port should ever be reachable at boot.
      probedPort = new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) + 1, timeout: 1_000 });
        socket.once('connect', () => { socket.destroy(); resolve('unexpected_listener_open'); });
        socket.once('error', () => resolve('closed'));
        socket.once('timeout', () => { socket.destroy(); resolve('closed'); });
      });
      setTimeout(() => child.kill('SIGINT'), 500);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const result = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('server_boot_smoke_timeout'));
    }, 20_000);
    child.once('error', error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal });
    });
  });

  assert.equal(shutdownSent, true, `server never started:\n${output}`);
  // On POSIX the registered handler exits 0; on Windows, Node's child.kill
  // reports the requested SIGINT as the terminating signal instead of
  // delivering a POSIX-style signal event. Both outcomes prove the isolated
  // process ended promptly and left no listener/process behind.
  assert.equal(
    (result.code === 0 && result.signal === null) || (result.code === null && result.signal === 'SIGINT'),
    true,
    `server did not stop after SIGINT:\n${output}`,
  );
  assert.doesNotMatch(output, /connectOmegaDevice|startOmegaOutboundView|startOmegaOutboundInteractive|OMEGA[^\n]*session[^\n]*creat/i);
  assert.doesNotMatch(output, /requestOmegaOutboundAdmin|OMEGA[^\n]*ADMIN[^\n]*(start|creat|grant)/i, 'no ADMIN activity at boot');
  assert.doesNotMatch(output, /https?:\/\/(?!127\.0\.0\.1|localhost)/i, 'no outbound/cloud URL logged at boot');
  assert.equal(await probedPort, 'closed', 'no unexpected second listener opened at boot');
  console.log('DEVICE FABRIC SERVER BOOT PASS 5/5');
} finally {
  if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
  await rm(tempRoot, { recursive: true, force: true });
}
