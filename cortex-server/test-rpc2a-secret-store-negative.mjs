// ROOT POLICY V1 CLOSURE — RPC-2A (secret-store, NEGATIVE side): a ciphertext read back from the database that is not
// strict base64 must be refused BEFORE any PowerShell process exists. child_process.spawnSync is replaced by a recorder
// (nothing is ever started with a hostile value). The positive side (real DPAPI round trips) is in
// test-rpc2a-secret-store-roundtrip.mjs; the two are separate files because a module mock is process-wide.
import './test-setup.mjs';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as realChildProcess from 'node:child_process';

const spawnCalls = [];
const { default: _unused, ...named } = realChildProcess;
mock.module('node:child_process', { namedExports: { ...named, spawnSync: (...args) => { spawnCalls.push(args); return { status: 1, stdout: '', stderr: 'RECORDED_NOT_EXECUTED' }; } } });

const { initSqlite, setMeta, getMeta } = await import('./src/lib/sqlite.js');
const store = await import('./src/lib/secret-store.js');
initSqlite(':memory:');

const META = (p) => `secret_dpapi:${p}`;
const HOSTILE = [
  "QUJD'; calc; '",                       // quote break-out
  "QUJD'); Start-Process calc; ('",
  'QUJD";calc;"',
  'AAAA;calc',                            // command separators
  'AAAA|calc',
  'AAAA&&calc',
  'AAAA&calc',
  'AAAA`ncalc',
  '$(calc)AAAA',
  'AAAA\ncalc',                           // control characters
  'AAAA\r\n',
  'AAAA\0AAAA',
  'AA\tAA',
  'QUJD ',                                // whitespace (never produced by Docteur)
  ' QUJD',
  'abc',                                  // malformed base64: bad length / bad padding / padding in the middle / too much padding
  'QUJ',
  'QU=D',
  'Q===',
  'QUJD====',
  '====',
  'QUJD-_-_',                             // base64url (never produced by Docteur)
  'é'.repeat(8),                          // non-ASCII
  '日本語日本語日本語日本語',
  'A'.repeat(9 * 1024 * 1024),            // absurdly long
  '',
];

test('NEGATIVE: isStrictBase64 refuses every hostile or malformed shape and nothing else', () => {
  for (const value of HOSTILE) assert.equal(store.isStrictBase64(value), false, `must refuse ${JSON.stringify(value.slice(0, 24))}`);
  for (const value of [null, undefined, 12, {}, [], true, Buffer.from('QUJD')]) assert.equal(store.isStrictBase64(value), false);
});

test('NEGATIVE: a stored blob that is not strict base64 never starts PowerShell, reads as null/invalid, and is left untouched', () => {
  const spoken = [];
  const spy = (name) => mock.method(console, name, (...a) => { spoken.push(a.map(String).join(' ')); });
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(spy);
  try {
    HOSTILE.forEach((payload, index) => {
      const provider = `evil${index}`;
      setMeta(META(provider), { ciphertext: payload });
      const before = JSON.stringify(getMeta(META(provider), null));
      assert.equal(store.getSecret(provider, { migrateLegacy: false }), null, `null for ${JSON.stringify(payload.slice(0, 24))}`);
      assert.equal(store.getSecretStatus(provider), payload === '' ? 'absent' : 'invalid');
      assert.equal(JSON.stringify(getMeta(META(provider), null)), before, 'the stored blob is not modified or deleted');
    });
    // non-string ciphertext values stored by a damaged database
    for (const [i, bad] of [[1, 12345], [2, { a: 1 }], [3, ['x']], [4, true]]) {
      setMeta(META(`odd${i}`), { ciphertext: bad });
      assert.equal(store.getSecret(`odd${i}`, { migrateLegacy: false }), null);
    }
  } finally { spies.forEach(s => s.mock.restore()); }
  assert.equal(spawnCalls.length, 0, `PowerShell must never be started for a refused value (started ${spawnCalls.length}×)`);
  const all = spoken.join('\n');
  assert.ok(!/calc|Start-Process|QUJD/.test(all), 'no hostile value in any console output');
});

test('NEGATIVE: the refusal message carries no value (static) and the interpolation sites are all guarded', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./src/lib/secret-store.js', import.meta.url)), 'utf8');
  const message = src.match(/throw new Error\('DPAPI: valeur chiffrée invalide[^']*'\)/);
  assert.ok(message, 'refusal throws a constant message');
  assert.doesNotMatch(message[0], /\$\{/, 'no interpolation in the message');
  // every `FromBase64String('${…}')` splice must go through the guard
  const splices = [...src.matchAll(/FromBase64String\('\$\{([^}]*)\}'\)/g)].map(m => m[1]);
  assert.equal(splices.length, 2, 'protect + unprotect');
  for (const expr of splices) assert.match(expr, /^assertStrictBase64\(\w+\)$/, 'guarded');
});

test('CONTROL: the recorder is really wired — a WELL-FORMED blob does reach the (mocked) launcher exactly once', () => {
  const before = spawnCalls.length;
  setMeta(META('wellformed'), { ciphertext: 'QUJDREVGR0g=' });
  assert.equal(store.getSecret('wellformed', { migrateLegacy: false }), null);   // the mocked process "fails" → null, as for any undecryptable blob
  assert.equal(spawnCalls.length, before + 1, 'one launch recorded');
  const script = spawnCalls.at(-1)[1].at(-1);
  assert.ok(script.includes("FromBase64String('QUJDREVGR0g=')"), 'the validated value is what is spliced');
});

test('POSITIVE (pure): the shapes Docteur actually writes are accepted — every padding class, long values', () => {
  const sample = (n) => Buffer.alloc(n, 7).toString('base64');
  for (const n of [1, 2, 3, 4, 5, 6, 100, 101, 102, 4000, 4001, 4002]) assert.equal(store.isStrictBase64(sample(n)), true, `${n} bytes → ${sample(n).slice(-3)}`);
  assert.equal(store.isStrictBase64('QUJD'), true);
  assert.equal(store.isStrictBase64('QUI='), true);
  assert.equal(store.isStrictBase64('QQ=='), true);
  assert.equal(store.isStrictBase64('+/+/'), true);
});
