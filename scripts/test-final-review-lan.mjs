import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const vite = new URL('../node_modules/vite/dist/node/index.js', import.meta.url).href;
const configPath = new URL('../vite.config.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
function readConfig(withCerts, { isPreview = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-review-lan-'));
  try {
    if (withCerts) {
      fs.mkdirSync(path.join(scratch, 'certs'));
      // Tests option wiring only; these are no real credentials/certificates.
      fs.writeFileSync(path.join(scratch, 'certs', 'key.pem'), 'synthetic-key');
      fs.writeFileSync(path.join(scratch, 'certs', 'cert.pem'), 'synthetic-certificate');
    }
    const code = `import { loadConfigFromFile } from ${JSON.stringify(vite)};
      const { config } = await loadConfigFromFile({command:'serve',mode:${JSON.stringify(isPreview ? 'production' : 'development')},isPreview:${isPreview}}, ${JSON.stringify(configPath)});
      console.log(JSON.stringify({devTLS:!!config.server.https,previewTLS:!!config.preview.https}));`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: scratch, env: { ...process.env, LOCAL_NETWORK: 'true' }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  } finally {
    // Windows can still hold the child's cwd for a moment after spawnSync returns (EBUSY): cleanup is best effort, never a verdict.
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
  }
}
// [SEC-REMED-1 / SEC-2] the Vite DEV server serves the project tree, so it is refused in LAN mode; preview (dist/ only) keeps TLS.
test('explicit LAN mode refuses the Vite dev server (LAN_DEV_SERVER_DISABLED)', () => {
  const result = readConfig(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LAN_DEV_SERVER_DISABLED/);
});
test('explicit LAN preview (dist/ only) uses TLS matching the backend', () => {
  const result = readConfig(true, { isPreview: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { devTLS: true, previewTLS: true });
});
test('explicit LAN mode refuses missing certificates instead of falling back to HTTP', () => {
  const result = readConfig(false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires TLS|certificat|refusing cleartext/i);
});
