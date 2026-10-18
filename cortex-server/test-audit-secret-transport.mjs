import './test-setup.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';

const calls = [];
const plain = '__AUDIT_SYNTHETIC_SECRET__é';
const cipher = Buffer.from('synthetic encrypted bytes').toString('base64');
const { default: ignored, ...named } = childProcess;
mock.module('node:child_process', { namedExports: { ...named, spawnSync: (exe, args, options) => {
  calls.push({ exe, args, options });
  return { status: 0, stdout: args.at(-1).includes('::Unprotect') ? Buffer.from(plain).toString('base64') : cipher, stderr: '' };
} } });
const { initSqlite } = await import('./src/lib/sqlite.js');
const { setSecret } = await import('./src/lib/secret-store.js');
initSqlite(':memory:');

test('protect transports synthetic plaintext only via stdin, never the process command line', () => {
  setSecret('audit', plain);
  const call = calls.at(-1);
  assert.ok(!JSON.stringify(call.args).includes(plain));
  assert.ok(!JSON.stringify(call.args).includes(Buffer.from(plain).toString('base64')));
  assert.equal(call.options.input, Buffer.from(plain).toString('base64'));
  assert.equal(call.options.windowsHide, true);
});
test('unprotect uses stdin for the validated ciphertext and preserves the returned secret', async () => {
  const fresh = await import('./src/lib/secret-store.js?audit-empty-cache');
  assert.equal(fresh.getSecret('audit', { migrateLegacy: false }), plain);
  const call = calls.at(-1);
  assert.ok(!JSON.stringify(call.args).includes(cipher));
  assert.equal(call.options.input, cipher);
});
