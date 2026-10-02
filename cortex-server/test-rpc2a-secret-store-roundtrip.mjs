// ROOT POLICY V1 CLOSURE — RPC-2A (secret-store, POSITIVE side): real Windows DPAPI round trips on SYNTHETIC values prove the
// strict base64 guard accepts everything Docteur really writes and reads, and that behaviour is unchanged.
// (The negative side, with a mocked spawnSync, is in test-rpc2a-secret-store-negative.mjs.)
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSqlite, getMeta, setMeta } from './src/lib/sqlite.js';
import * as store from './src/lib/secret-store.js';

const win = process.platform === 'win32';
initSqlite(':memory:');
const META = (p) => `secret_dpapi:${p}`;

// A second, independent module instance = an empty plaintext cache = a real decrypt, like a fresh process.
const freshStore = () => import(`./src/lib/secret-store.js?fresh=${Math.random().toString(36).slice(2)}`);

test('POSITIVE: real DPAPI round trip — synthetic secrets of every length class decrypt to exactly what was stored', { skip: !win, timeout: 120_000 }, async () => {
  const values = {
    p0: 'abc', p1: 'abcd', p2: 'abcde',
    unicode: 'clé-secrète-été-日本語', json: '{"k":"v","n":[1,2,3]}', long: 'L'.repeat(4000),
    awkward: `it's "quoted" ; & | \`tick\` $(not-code)`, one: 'x',
  };
  const paddings = new Set();
  for (const [provider, plain] of Object.entries(values)) {
    store.setSecret(provider, plain);
    const { ciphertext } = getMeta(META(provider), null);
    assert.equal(store.isStrictBase64(ciphertext), true, `${provider}: what DPAPI produces passes the guard`);
    assert.notEqual(ciphertext, Buffer.from(plain).toString('base64'), 'it is encrypted, not merely encoded');
    paddings.add(ciphertext.match(/=*$/)[0].length);
    const fresh = await freshStore();
    assert.equal(fresh.getSecret(provider, { migrateLegacy: false }), plain, `${provider}: decrypts to the original`);
    assert.equal(fresh.getSecretStatus(provider), 'valid');
  }
  assert.ok(paddings.size >= 1);
});

test('POSITIVE: lengths 1..14 — whatever padding DPAPI emits, the guard accepts it and the value round-trips', { skip: !win, timeout: 180_000 }, async () => {
  const seen = new Set();
  for (let n = 1; n <= 14; n++) {
    const plain = 'k'.repeat(n);
    const provider = `len${n}`;
    store.setSecret(provider, plain);
    const { ciphertext } = getMeta(META(provider), null);
    seen.add(ciphertext.match(/=*$/)[0].length);
    assert.equal(store.isStrictBase64(ciphertext), true);
    assert.equal((await freshStore()).getSecret(provider, { migrateLegacy: false }), plain);
  }
  assert.ok([...seen].every(p => p <= 2));
});

test('POSITIVE: absent / deleted / replaced secrets behave exactly as before', { skip: !win, timeout: 60_000 }, async () => {
  assert.equal(store.getSecret('never-set', { migrateLegacy: false }), null);
  assert.equal(store.getSecretStatus('never-set'), 'absent');
  assert.equal(store.hasSecret('never-set', { migrateLegacy: false }), false);
  store.setSecret('prov', 'first');
  store.setSecret('prov', 'second');
  assert.equal((await freshStore()).getSecret('prov', { migrateLegacy: false }), 'second');
  assert.equal(store.hasSecret('prov', { migrateLegacy: false }), true);
  store.deleteSecret('prov');
  assert.equal(store.hasSecret('prov', { migrateLegacy: false }), false);
  assert.equal(store.getSecret('prov', { migrateLegacy: false }), null);
  store.setSecret('prov', '');                                   // empty plaintext clears, as before
  assert.equal(getMeta(META('prov'), null), null);
});

test('POSITIVE: an undecryptable but well-formed blob keeps the existing contract (null, status invalid, blob kept)', { skip: !win, timeout: 60_000 }, async () => {
  const wellFormedGarbage = Buffer.from('this is not a DPAPI blob at all').toString('base64');
  assert.equal(store.isStrictBase64(wellFormedGarbage), true);
  setMeta(META('garbage'), { ciphertext: wellFormedGarbage });
  const fresh = await freshStore();
  assert.equal(fresh.getSecret('garbage', { migrateLegacy: false }), null);
  assert.equal(fresh.getSecretStatus('garbage'), 'invalid');
  assert.equal(getMeta(META('garbage'), null).ciphertext, wellFormedGarbage, 'blob is not deleted');
});
