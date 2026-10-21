// [GAME-3] Arcade local save store, save protocol and foundation save diagnostic — deterministic, synthetic data,
// in-memory backend (the real IndexedDB adapter is exercised by test-arcade-saves-browser.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ARCADE_GAMES, getArcadeGame } from '../src/lib/arcade/registry.ts';
import {
  ARCADE_SAVE_MAX_BYTES, ARCADE_SAVE_SCHEMA_VERSION, ArcadeSaveStorageError, createArcadeSaveStore, createIdbSaveBackend,
  measureArcadeSaveData,
} from '../src/lib/arcade/saves.ts';
import { buildArcadeSaveResult, parseArcadeGameEvent } from '../src/lib/arcade/protocol.ts';
import { answerArcadeSaveRequest } from '../src/lib/arcade/save-bridge.ts';

const GAME = 'synapse-run', KEY = 'arcade:v1:synapse-run';
const id = 'a'.repeat(32), rid = '0123456789abcdef';
const expected = { gameId: GAME, instanceId: id };
const request = (type, payload = {}, extra = {}) => ({ channel: 'docteur-arcade', v: 1, type, gameId: GAME, instanceId: id, requestId: rid, payload, ...extra });
const UNKNOWN_IDS = ['other', '../synapse-run', 'synapse-run/../other', '/arcade/synapse-run/index.html', 'https://example.invalid/synapse-run', 'arcade:v1:synapse-run', 'SYNAPSE-RUN', 'synapse-run ', '', '__proto__', 'constructor', 'toString', null, undefined, 1, {}, ['synapse-run']];

/** Same contract as the IndexedDB adapter: update() writes all or nothing; values are structured-cloned. */
function memoryBackend() {
  const map = new Map(), calls = [];
  const fail = { get: null, update: null, delete: null };
  return {
    map, calls, fail,
    async get(key) { calls.push(['get', key]); if (fail.get) throw new ArcadeSaveStorageError(fail.get); return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async update(key, next) {
      calls.push(['update', key]);
      const value = next(map.has(key) ? structuredClone(map.get(key)) : undefined);
      if (fail.update) throw new ArcadeSaveStorageError(fail.update);
      map.set(key, structuredClone(value));
    },
    async delete(key) { calls.push(['delete', key]); if (fail.delete) throw new ArcadeSaveStorageError(fail.delete); map.delete(key); },
  };
}

function setup({ policy, clock = 1_000 } = {}) {
  const backend = memoryBackend();
  let now = clock;
  const game = ARCADE_GAMES[0];
  const getGame = policy ? value => (value === GAME ? { ...game, save: policy } : null) : getArcadeGame;
  const store = createArcadeSaveStore({ backend, now: () => now, getGame });
  return { backend, store, tick: ms => { now = ms; } };
}

const record = (changes = {}) => ({ schema: 1, gameId: GAME, saveVersion: 1, createdAt: 10, updatedAt: 20, bytes: 2, payload: {}, ...changes });

test('A valid save is accepted and stored as one exact, host-owned record', async () => {
  const { store, backend } = setup();
  const data = { label: 'synthetic', level: 3, flags: [true, false, null], nested: { ratio: 0.5 } };
  const result = await store.write(GAME, 1, data);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'SAVED');
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  assert.deepEqual(result.save, { saveVersion: 1, createdAt: 1_000, updatedAt: 1_000, bytes });
  assert.deepEqual([...backend.map.keys()], [KEY]);
  assert.deepEqual(backend.map.get(KEY), { schema: ARCADE_SAVE_SCHEMA_VERSION, gameId: GAME, saveVersion: 1, createdAt: 1_000, updatedAt: 1_000, bytes, payload: data });
  assert.equal(ARCADE_GAMES[0].capabilities.includes('LOCAL_SAVE_V1'), true);
  assert.deepEqual(ARCADE_GAMES[0].save, { currentVersion: 1, minSupportedVersion: 1 });
  assert.ok(Object.isFrozen(ARCADE_GAMES[0].save));
});

test('B unknown, path-like and URL-like game ids are rejected with zero storage access', async () => {
  const { store, backend } = setup();
  for (const gameId of UNKNOWN_IDS) {
    assert.deepEqual(await store.load(gameId), { ok: false, code: 'UNKNOWN_GAME' }, String(gameId));
    assert.deepEqual(await store.write(gameId, 1, { x: 1 }), { ok: false, code: 'UNKNOWN_GAME' });
    assert.deepEqual(await store.remove(gameId), { ok: false, code: 'UNKNOWN_GAME' });
  }
  // a registered game without the LOCAL_SAVE_V1 capability has no save either
  const noCapability = createArcadeSaveStore({ backend, getGame: v => (v === GAME ? { ...ARCADE_GAMES[0], capabilities: ['HOST_PROTOCOL_V1'] } : null) });
  assert.deepEqual(await noCapability.write(GAME, 1, {}), { ok: false, code: 'UNKNOWN_GAME' });
  assert.deepEqual(backend.calls, []);
});

test('C payload of exactly 65536 UTF-8 bytes is accepted', async () => {
  const { store, backend } = setup();
  const data = 'x'.repeat(ARCADE_SAVE_MAX_BYTES - 2); // + 2 quote characters
  assert.equal(Buffer.byteLength(JSON.stringify(data)), 65_536);
  const result = await store.write(GAME, 1, data);
  assert.equal(result.ok, true);
  assert.equal(result.save.bytes, 65_536);
  assert.equal(backend.map.get(KEY).payload, data);
});

test('D payload of 65537 bytes is rejected before any write, without truncation', async () => {
  const { store, backend } = setup();
  await store.write(GAME, 1, { keep: 'previous' });
  backend.calls.length = 0;
  for (const data of ['x'.repeat(ARCADE_SAVE_MAX_BYTES - 1), Array(40_000).fill(0), { blob: 'y'.repeat(200_000) }, Array.from({ length: 70_000 }, () => 'z')]) {
    assert.deepEqual(await store.write(GAME, 1, data), { ok: false, code: 'SAVE_TOO_LARGE' });
  }
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(backend.map.get(KEY).payload, { keep: 'previous' });
});

test('E size is measured as UTF-8 bytes of the JSON, not characters', async () => {
  assert.deepEqual(measureArcadeSaveData('é'), { ok: true, json: '"é"', bytes: 4 });
  assert.equal(measureArcadeSaveData('€').bytes, 5);
  assert.equal(measureArcadeSaveData('😀').bytes, 6);
  assert.equal(measureArcadeSaveData('\ud800').bytes, 8); // lone surrogate → JSON escape \ud800
  assert.equal(measureArcadeSaveData({ a: [1, 'b'] }).bytes, 13);
  const { store } = setup();
  const fits = 'é'.repeat(32_767); // 32 769 characters of JSON, 65 536 bytes
  assert.equal((await store.write(GAME, 1, fits)).ok, true);
  const over = 'é'.repeat(32_768); // 32 770 characters (< 65 536) but 65 538 bytes
  assert.ok(JSON.stringify(over).length < ARCADE_SAVE_MAX_BYTES);
  assert.deepEqual(await store.write(GAME, 1, over), { ok: false, code: 'SAVE_TOO_LARGE' });
  assert.deepEqual(await store.write(GAME, 1, '😀'.repeat(16_384)), { ok: false, code: 'SAVE_TOO_LARGE' }); // 32 768 chars, 65 538 bytes
});

test('F non-JSON-safe payloads are rejected (no functions, DOM-like objects, binary, class instances, accessors)', async () => {
  const { store, backend } = setup();
  class Synthetic { constructor() { this.x = 1; } }
  const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get: () => 1 });
  const hidden = {}; Object.defineProperty(hidden, 'x', { enumerable: false, value: 1 });
  const extraArray = [1, 2]; extraArray.name = 'extra';
  const holeAndExtra = [, 1]; holeAndExtra.name = 'extra'; // eslint-disable-line no-sparse-arrays
  const cyclic = { a: {} }; cyclic.a.self = cyclic;
  let deep = 0; for (let i = 0; i < 40; i++) deep = [deep];
  const bad = [undefined, () => 1, Symbol('x'), 1n, NaN, Infinity, -Infinity, new Date(0), /x/, new Map(), new Set(), new Uint8Array(1), new ArrayBuffer(1), new Blob(['x']),
    new Synthetic(), Object.create({ inherited: 1 }), [, 1], extraArray, holeAndExtra, getter, hidden, { [Symbol('k')]: 1 }, JSON.parse('{"__proto__":{"polluted":true}}'), // eslint-disable-line no-sparse-arrays
    { ok: [1, { nested: undefined }] }, { fn() {} }, cyclic, deep, new String('boxed'), new Number(1), Object(true), new Error('x')];
  for (const data of bad) assert.deepEqual(await store.write(GAME, 1, data), { ok: false, code: 'INVALID_SAVE_PAYLOAD' }, Object.prototype.toString.call(data));
  assert.deepEqual(backend.calls, []);
  assert.equal({}.polluted, undefined);
  // allowed edge values
  for (const data of [null, true, 0, -1.25, '', [], {}, Object.create(null), [[[]]], { '': 'empty key' }]) assert.equal((await store.write(GAME, 1, data)).ok, true);
});

test('G createdAt / updatedAt come from the host clock only', async () => {
  const { store, backend, tick } = setup({ clock: 5_000 });
  await store.write(GAME, 1, { createdAt: 1, updatedAt: 2 }); // game data cannot set metadata
  assert.deepEqual([backend.map.get(KEY).createdAt, backend.map.get(KEY).updatedAt], [5_000, 5_000]);
  tick(9_000);
  const second = await store.write(GAME, 1, { createdAt: 3 });
  assert.deepEqual([second.save.createdAt, second.save.updatedAt], [5_000, 9_000]);
  tick(7_000); // clock went backwards: updatedAt never goes below the stored one
  const third = await store.write(GAME, 1, {});
  assert.deepEqual([third.save.createdAt, third.save.updatedAt], [5_000, 9_000]);
  assert.deepEqual(backend.map.get(KEY).payload, {});
  // the protocol has no field for timestamps: an extra key drops the whole message
  assert.equal(parseArcadeGameEvent(request('ARCADE_SAVE_WRITE', { saveVersion: 1, data: {}, createdAt: 1 }), expected), null);
});

test('H saveVersion must be a bounded integer inside the game policy', async () => {
  const { store, backend } = setup();
  for (const version of [0, -1, 1.5, '1', 2, 1e9, NaN, Infinity, null, undefined, true, [1]]) {
    assert.deepEqual(await store.write(GAME, version, {}), { ok: false, code: 'INVALID_SAVE_VERSION' }, String(version));
  }
  assert.deepEqual(backend.calls, []);
  const windowed = setup({ policy: { currentVersion: 3, minSupportedVersion: 2 } });
  assert.deepEqual(await windowed.store.write(GAME, 1, {}), { ok: false, code: 'INVALID_SAVE_VERSION' });
  assert.equal((await windowed.store.write(GAME, 2, {})).ok, true);
  assert.equal((await windowed.store.write(GAME, 3, {})).ok, true);
  assert.deepEqual(await windowed.store.write(GAME, 4, {}), { ok: false, code: 'INVALID_SAVE_VERSION' });
});

test('I unknown future versions are preserved, reported and never overwritten', async () => {
  for (const stored of [record({ schema: 2, extraFutureField: 'kept' }), record({ schema: 99 }), record({ saveVersion: 2 })]) {
    const { store, backend } = setup();
    backend.map.set(KEY, stored);
    assert.deepEqual(await store.load(GAME), { ok: false, code: 'UNSUPPORTED_SAVE_VERSION' });
    assert.deepEqual(await store.write(GAME, 1, { replace: true }), { ok: false, code: 'UNSUPPORTED_SAVE_VERSION' });
    assert.deepEqual(backend.map.get(KEY), stored);
  }
  // an older version still inside the policy window is returned as-is (the game migrates it)
  const older = setup({ policy: { currentVersion: 2, minSupportedVersion: 1 } });
  older.backend.map.set(KEY, record({ saveVersion: 1, payload: { v1: true }, bytes: 11 }));
  const loaded = await older.store.load(GAME);
  assert.deepEqual(loaded, { ok: true, status: 'FOUND', save: { saveVersion: 1, createdAt: 10, updatedAt: 20, bytes: 11, data: { v1: true } } });
  const dropped = setup({ policy: { currentVersion: 3, minSupportedVersion: 2 } });
  dropped.backend.map.set(KEY, record({ saveVersion: 1 }));
  assert.deepEqual(await dropped.store.load(GAME), { ok: false, code: 'UNSUPPORTED_SAVE_VERSION' });
});

test('J corrupt records fail safely, stay untouched and remain deletable', async () => {
  const corrupt = ['garbage', 42, null, true, [], {}, { schema: 1 }, record({ schema: 0 }), record({ schema: '1' }), record({ extra: 1 }), record({ gameId: 'other' }), record({ saveVersion: 0 }),
    record({ saveVersion: 1.5 }), record({ createdAt: 30, updatedAt: 20 }), record({ createdAt: -1 }), record({ bytes: 3 }), record({ payload: new Date(0) }),
    record({ payload: 'x'.repeat(70_000), bytes: 70_002 }), record({ payload: { n: NaN }, bytes: 9 })];
  for (const stored of corrupt) {
    const { store, backend } = setup();
    backend.map.set(KEY, stored);
    assert.deepEqual(await store.load(GAME), { ok: false, code: 'CORRUPT_SAVE' }, JSON.stringify(stored)?.slice(0, 80));
    assert.deepEqual(await store.write(GAME, 1, { replace: true }), { ok: false, code: 'CORRUPT_SAVE' });
    assert.deepEqual(backend.map.get(KEY), stored);
    assert.deepEqual(await store.remove(GAME), { ok: true, status: 'DELETED' });
    assert.deepEqual(await store.load(GAME), { ok: true, status: 'EMPTY' });
  }
});

test('K write then load returns the same logical payload', async () => {
  const { store } = setup();
  assert.deepEqual(await store.load(GAME), { ok: true, status: 'EMPTY' });
  const data = { synthetic: true, list: [1, 2.5, 'trois', null, { deep: ['é', '😀'] }], empty: {} };
  const saved = await store.write(GAME, 1, data);
  const loaded = await store.load(GAME);
  assert.equal(loaded.status, 'FOUND');
  assert.deepEqual(loaded.save.data, data);
  assert.deepEqual({ ...loaded.save, data: undefined }, { ...saved.save, data: undefined });
  // the stored copy is the JSON-normalised one: what is measured is what is kept
  await store.write(GAME, 1, { negativeZero: -0 });
  assert.ok(Object.is((await store.load(GAME)).save.data.negativeZero, 0));
});

test('L a second write replaces the same game record atomically', async () => {
  const { store, backend, tick } = setup();
  await store.write(GAME, 1, { first: true, removedLater: 1 });
  tick(2_000);
  await store.write(GAME, 1, { second: true });
  assert.equal(backend.map.size, 1);
  assert.deepEqual((await store.load(GAME)).save.data, { second: true });
  assert.deepEqual(backend.calls.filter(([op]) => op === 'update').length, 2);
});

test('M delete removes only that game record', async () => {
  const { store, backend } = setup();
  backend.map.set('arcade:v1:other-game', record({ gameId: 'other-game' }));
  backend.map.set('unrelated-key', 'unrelated');
  await store.write(GAME, 1, { x: 1 });
  assert.deepEqual(await store.remove(GAME), { ok: true, status: 'DELETED' });
  assert.deepEqual([...backend.map.keys()].sort(), ['arcade:v1:other-game', 'unrelated-key']);
  assert.deepEqual(await store.remove(GAME), { ok: true, status: 'DELETED' }); // idempotent
  for (const gameId of ['other-game', 'unrelated-key', 'arcade:v1:other-game', '*', '']) assert.deepEqual(await store.remove(gameId), { ok: false, code: 'UNKNOWN_GAME' });
  assert.deepEqual(backend.calls.filter(([op]) => op === 'delete').map(([, key]) => key), [KEY, KEY]);
  assert.equal(typeof store.list, 'undefined');
  assert.deepEqual(Object.keys(store).sort(), ['load', 'remove', 'write']);
});

test('N a failed write or delete preserves the previous record; storage errors are typed', async () => {
  const { store, backend } = setup();
  await store.write(GAME, 1, { previous: true });
  const before = structuredClone(backend.map.get(KEY));
  backend.fail.update = 'STORAGE_FAILED';
  assert.deepEqual(await store.write(GAME, 1, { next: true }), { ok: false, code: 'STORAGE_FAILED' });
  backend.fail.update = 'STORAGE_UNAVAILABLE';
  assert.deepEqual(await store.write(GAME, 1, { next: true }), { ok: false, code: 'STORAGE_UNAVAILABLE' });
  backend.fail.delete = 'STORAGE_FAILED';
  assert.deepEqual(await store.remove(GAME), { ok: false, code: 'STORAGE_FAILED' });
  backend.fail.get = 'STORAGE_UNAVAILABLE';
  assert.deepEqual(await store.load(GAME), { ok: false, code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(backend.map.get(KEY), before);
  // a non-typed backend exception maps to STORAGE_FAILED without leaking its message
  const leaky = createArcadeSaveStore({ backend: { get: async () => { throw new Error('C:\\private\\path'); }, update: async () => { throw new TypeError('x'); }, delete: async () => { throw 'raw'; } } });
  assert.deepEqual(await leaky.load(GAME), { ok: false, code: 'STORAGE_FAILED' });
  assert.deepEqual(await leaky.write(GAME, 1, {}), { ok: false, code: 'STORAGE_FAILED' });
  assert.deepEqual(await leaky.remove(GAME), { ok: false, code: 'STORAGE_FAILED' });
});

test('N2 IndexedDB adapter: missing or throwing IndexedDB is STORAGE_UNAVAILABLE and is retried, not cached', async () => {
  let calls = 0;
  const missing = createArcadeSaveStore({ backend: createIdbSaveBackend(() => { calls++; return undefined; }) });
  assert.deepEqual(await missing.load(GAME), { ok: false, code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(await missing.write(GAME, 1, {}), { ok: false, code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(await missing.remove(GAME), { ok: false, code: 'STORAGE_UNAVAILABLE' });
  assert.equal(calls, 3);
  const opened = [];
  const throwing = createArcadeSaveStore({ backend: createIdbSaveBackend(() => ({ open: (name, version) => { opened.push([name, version]); throw new Error('SecurityError'); } })) });
  assert.deepEqual(await throwing.load(GAME), { ok: false, code: 'STORAGE_UNAVAILABLE' });
  assert.deepEqual(opened, [['docteur-arcade', 1]]);
  const factoryThrows = createArcadeSaveStore({ backend: createIdbSaveBackend(() => { throw new Error('denied'); }) });
  assert.deepEqual(await factoryThrows.load(GAME), { ok: false, code: 'STORAGE_UNAVAILABLE' });
});

test('O save requests need a known operation, a 16-hex requestId and the exact payload', () => {
  const valid = [request('ARCADE_SAVE_LOAD'), request('ARCADE_SAVE_WRITE', { saveVersion: 1, data: { x: 1 } }), request('ARCADE_SAVE_DELETE')];
  for (const data of valid) assert.deepEqual(parseArcadeGameEvent(data, expected), data);
  const load = request('ARCADE_SAVE_LOAD');
  const bad = [
    { ...load, requestId: 'abc' }, { ...load, requestId: 'ABCDEF0123456789' }, { ...load, requestId: '0123456789abcdef0' }, { ...load, requestId: 1 }, { ...load, requestId: null },
    { ...load, requestId: '../../etc/passwd' }, request('ARCADE_SAVE_LOAD', { gameId: 'other' }), request('ARCADE_SAVE_LOAD', { key: KEY }), request('ARCADE_SAVE_DELETE', { all: true }),
    request('ARCADE_SAVE_WRITE', { saveVersion: 1 }), request('ARCADE_SAVE_WRITE', { data: {} }), request('ARCADE_SAVE_WRITE', { saveVersion: 1, data: {}, key: 'x' }),
    request('ARCADE_SAVE_WRITE', null), request('ARCADE_SAVE_WRITE', []), request('ARCADE_SAVE_LIST'), request('ARCADE_STORAGE_COMMAND'), request('ARCADE_DB'), request('ARCADE_EXEC'),
    request('ARCADE_SAVE_RESULT', { op: 'LOAD', status: 'EMPTY' }), request('ARCADE_READY'), request('ARCADE_STATE', { state: 'paused' }), request('ARCADE_SAVE_LOAD', {}, { extra: 1 }),
    request('ARCADE_SAVE_LOAD', {}, { v: 2 }), request('ARCADE_SAVE_LOAD', {}, { channel: 'other' }),
  ];
  for (const data of bad) assert.equal(parseArcadeGameEvent(data, expected), null, JSON.stringify(data));
  const noRequestId = { ...load }; delete noRequestId.requestId;
  assert.equal(parseArcadeGameEvent(noRequestId, expected), null);
  assert.deepEqual(buildArcadeSaveResult(GAME, id, rid, { op: 'LOAD', status: 'EMPTY' }), { channel: 'docteur-arcade', v: 1, type: 'ARCADE_SAVE_RESULT', gameId: GAME, instanceId: id, requestId: rid, payload: { op: 'LOAD', status: 'EMPTY' } });
  assert.throws(() => buildArcadeSaveResult(GAME, id, 'bad', { op: 'LOAD', status: 'EMPTY' }), /ARCADE_BAD_REQUEST_ID/);
  assert.throws(() => buildArcadeSaveResult(GAME, 'bad', rid, { op: 'LOAD', status: 'EMPTY' }), /ARCADE_BAD_INSTANCE_ID/);
});

test('P wrong game, instance or schema never reaches storage; the bridge answers with typed results', async () => {
  const { store, backend } = setup();
  const pipeline = async data => {
    const message = parseArcadeGameEvent(data, expected);
    return message && message.type.startsWith('ARCADE_SAVE_') ? answerArcadeSaveRequest(store, message) : null;
  };
  const forged = [];
  for (const gameId of UNKNOWN_IDS) for (const type of ['ARCADE_SAVE_LOAD', 'ARCADE_SAVE_DELETE']) forged.push(request(type, {}, { gameId }));
  for (const gameId of UNKNOWN_IDS) forged.push(request('ARCADE_SAVE_WRITE', { saveVersion: 1, data: {} }, { gameId }));
  forged.push(request('ARCADE_SAVE_WRITE', { saveVersion: 1, data: {} }, { instanceId: 'b'.repeat(32) }), request('ARCADE_SAVE_DELETE', {}, { instanceId: '' }));
  for (const data of forged) assert.equal(await pipeline(data), null);
  assert.deepEqual(backend.calls, []);
  // defence in depth: even a request object that skipped parsing cannot name another game
  assert.deepEqual(await answerArcadeSaveRequest(store, { ...request('ARCADE_SAVE_DELETE'), gameId: 'other' }), { op: 'DELETE', status: 'ERROR', code: 'UNKNOWN_GAME' });
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(await pipeline(request('ARCADE_SAVE_LOAD')), { op: 'LOAD', status: 'EMPTY' });
  assert.deepEqual(await pipeline(request('ARCADE_SAVE_WRITE', { saveVersion: 1, data: { n: 1 } })), { op: 'WRITE', status: 'SAVED', save: { saveVersion: 1, createdAt: 1_000, updatedAt: 1_000 } });
  assert.deepEqual(await pipeline(request('ARCADE_SAVE_LOAD')), { op: 'LOAD', status: 'FOUND', save: { saveVersion: 1, createdAt: 1_000, updatedAt: 1_000, data: { n: 1 } } });
  assert.deepEqual(await pipeline(request('ARCADE_SAVE_WRITE', { saveVersion: 1, data: 'x'.repeat(70_000) })), { op: 'WRITE', status: 'ERROR', code: 'SAVE_TOO_LARGE' });
  assert.deepEqual(await pipeline(request('ARCADE_SAVE_WRITE', { saveVersion: 'one', data: {} })), { op: 'WRITE', status: 'ERROR', code: 'INVALID_SAVE_VERSION' });
  assert.deepEqual(await pipeline(request('ARCADE_SAVE_DELETE')), { op: 'DELETE', status: 'DELETED' });
  assert.deepEqual(backend.calls.map(([op, key]) => [op, key === KEY]), [['get', true], ['update', true], ['get', true], ['delete', true]]);
});

test('Q foundation page asks for its save once after INIT and accepts only the matching result', () => {
  const listeners = {}, sent = [], attrs = {}, elements = {};
  const origin = 'http://127.0.0.1:5173';
  const parent = { postMessage: (data, target) => { assert.equal(target, origin); sent.push(JSON.parse(JSON.stringify(data))); } };
  const window = { parent, location: { hash: `#instance=${id}`, origin }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const document = { getElementById: key => (elements[key] ??= {}), documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/arcade/synapse-run/foundation.js', import.meta.url), 'utf8'), { window, document });
  const send = data => listeners.message({ data, source: parent, origin });
  const command = (type, payload = {}) => ({ channel: 'docteur-arcade', v: 1, type, gameId: GAME, instanceId: id, payload });
  assert.deepEqual(sent.map(m => m.type), ['ARCADE_READY']);
  send(command('ARCADE_INIT', { reducedMotion: false }));
  const load = sent.find(m => m.type === 'ARCADE_SAVE_LOAD');
  assert.deepEqual(load, { channel: 'docteur-arcade', v: 1, type: 'ARCADE_SAVE_LOAD', gameId: GAME, instanceId: id, payload: {}, requestId: '0000000000000001' });
  assert.equal(sent.filter(m => m.type.startsWith('ARCADE_SAVE_')).length, 1); // the foundation never writes or deletes
  const result = (payload, changes = {}) => ({ ...command('ARCADE_SAVE_RESULT', payload), requestId: load.requestId, ...changes });
  for (const data of [result({ op: 'LOAD', status: 'FOUND' }, { requestId: 'ffffffffffffffff' }), result({ op: 'WRITE', status: 'SAVED' }), result({ op: 'LOAD', status: 'WEIRD' }), result({ op: 'LOAD', status: 'FOUND' }, { instanceId: 'b'.repeat(32) }), result({ op: 'LOAD', status: 'FOUND' }, { extra: 1 })]) send(data);
  listeners.message({ data: result({ op: 'LOAD', status: 'FOUND' }), source: {}, origin });
  assert.equal(attrs['data-save'], undefined);
  send(result({ op: 'LOAD', status: 'EMPTY' }));
  assert.equal(attrs['data-save'], 'EMPTY');
  assert.equal(elements['sr-save'].textContent, 'Sauvegarde locale : aucune');
  send(result({ op: 'LOAD', status: 'FOUND' })); // already answered: ignored
  assert.equal(attrs['data-save'], 'EMPTY');
});
