// [FILAMENT-3] Unit tests for the saved progression. Status when written: NOT RUN.
//   node --experimental-strip-types --no-warnings --test scripts/test-filament-progress-unit.mjs
// Pure parts only: no browser, no storage, no physics step. Covered:
//   * progress.ts: format, validation of untrusted payloads, best-result merge, save-session states, coalesced writes
//   * public/arcade/filament/host.js save bridge, in a vm with fake window / document: LOAD after INIT, only answers to
//     its own pending requests, no other game, nothing after STOP, write requests bounded and shape-checked
//   * registry: Filament declares LOCAL_SAVE_V1 with saveVersion window 1..1; Synapse Run's entry is unchanged
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { FILAMENT_SAVE_VERSION, PROGRESS_FORMAT, createProgressSession, serializeProgress, validateProgress } from '../src/arcade/filament/progress.ts';
import { ARCADE_GAMES, getArcadeGame } from '../src/lib/arcade/registry.ts';

const KNOWN = [{ id: 'ch1-a', stars: 3 }, { id: 'ch1-g', stars: 3 }, { id: 'ch1-d', stars: 3 }];
const payload = (levels) => ({ format: PROGRESS_FORMAT, levels });

test('valid payloads load into a fresh map; canonical serialisation in level order', () => {
  const best = validateProgress(payload({ 'ch1-g': 2, 'ch1-a': 3 }), KNOWN);
  assert.deepEqual([...best], [['ch1-g', 2], ['ch1-a', 3]]);
  assert.deepEqual(serializeProgress(best, KNOWN), payload({ 'ch1-a': 3, 'ch1-g': 2 }));
  assert.deepEqual([...validateProgress(payload({}), KNOWN)], []);
});

test('untrusted payloads are refused: shape, format, unknown level, star bounds, size', () => {
  const bad = [
    null, [], 'x', 1, {}, { format: PROGRESS_FORMAT }, { levels: {} }, { ...payload({}), extra: 1 },
    { format: 'filament-progress-v2', levels: {} }, payload([]), payload(null),
    payload({ 'ch1-z': 1 }), payload(JSON.parse('{"__proto__":1}')), payload({ 'ch1-a': 4 }), payload({ 'ch1-a': -1 }),
    payload({ 'ch1-a': 1.5 }), payload({ 'ch1-a': '3' }), payload({ 'ch1-a': NaN }),
    payload({ 'ch1-a': 1, 'ch1-g': 1, 'ch1-d': 1, 'ch1-x': 1 }),
    { format: PROGRESS_FORMAT, levels: { 'ch1-a': 1 }, padding: 'x'.repeat(5000) },
  ];
  for (const data of bad) assert.equal(validateProgress(data, KNOWN), null, JSON.stringify(data)?.slice(0, 80));
});

test('session: empty save → READY; first win writes; a worse result never lowers the best; 3 stars upgrades', () => {
  const s = createProgressSession(KNOWN);
  assert.equal(s.saveStatus, 'LOADING');
  assert.equal(s.onLoad({ status: 'EMPTY' }), null);
  assert.equal(s.saveStatus, 'READY');
  assert.deepEqual(s.recordWin('ch1-a', 2), payload({ 'ch1-a': 2 }));
  assert.equal(s.writeStatus, 'WRITING');
  assert.equal(s.onWriteResult(true), null);
  assert.equal(s.writeStatus, 'SAVED');
  assert.equal(s.recordWin('ch1-a', 1), null); // worse: nothing written, best kept
  assert.equal(s.best('ch1-a'), 2);
  assert.deepEqual(s.recordWin('ch1-a', 3), payload({ 'ch1-a': 3 }));
  assert.equal(s.best('ch1-a'), 3);
  assert.equal(s.recordWin('ch1-x', 3), null); // unknown level
  assert.equal(s.recordWin('ch1-g', 4), null); // impossible star count
});

test('session: writes coalesce (one in flight), a failed write is retried by the next win only', () => {
  const s = createProgressSession(KNOWN);
  s.onLoad({ status: 'EMPTY' });
  assert.ok(s.recordWin('ch1-a', 1));
  assert.equal(s.recordWin('ch1-g', 2), null); // in flight: coalesced
  assert.deepEqual(s.onWriteResult(true), payload({ 'ch1-a': 1, 'ch1-g': 2 }));
  assert.equal(s.onWriteResult(false), null);
  assert.equal(s.writeStatus, 'FAILED');
  assert.deepEqual(s.recordWin('ch1-a', 0), payload({ 'ch1-a': 1, 'ch1-g': 2 })); // not better, but retries the failed write
  assert.equal(s.onWriteResult(true), null);
  assert.equal(s.recordWin('ch1-a', 0), null);
});

test('session: a stored save is merged with wins made while loading (max per level)', () => {
  const s = createProgressSession(KNOWN);
  assert.equal(s.recordWin('ch1-a', 3), null); // still loading: kept in memory, nothing written yet
  assert.deepEqual(s.onLoad({ status: 'FOUND', saveVersion: FILAMENT_SAVE_VERSION, data: payload({ 'ch1-a': 1, 'ch1-g': 2 }) }), payload({ 'ch1-a': 3, 'ch1-g': 2 }));
  assert.equal(s.firstOpen(), 2);
  assert.equal(s.totalStars(), 5);
  const t = createProgressSession(KNOWN);
  assert.equal(t.onLoad({ status: 'FOUND', saveVersion: 1, data: payload({ 'ch1-a': 2 }) }), null); // nothing new: no write
  assert.equal(t.best('ch1-a'), 2);
});

test('session: corrupt, newer or unreadable saves are PROTECTED and never written; unavailable storage plays on', () => {
  for (const result of [
    { status: 'FOUND', saveVersion: 1, data: payload({ 'ch1-a': 9 }) },
    { status: 'FOUND', saveVersion: 2, data: payload({}) },
    { status: 'ERROR', code: 'CORRUPT_SAVE' },
    { status: 'ERROR', code: 'UNSUPPORTED_SAVE_VERSION' },
  ]) {
    const s = createProgressSession(KNOWN);
    assert.equal(s.onLoad(result), null);
    assert.equal(s.saveStatus, 'PROTECTED', JSON.stringify(result));
    assert.equal(s.recordWin('ch1-a', 3), null);
    assert.equal(s.best('ch1-a'), 3); // still shown for this session
  }
  for (const code of ['STORAGE_UNAVAILABLE', 'STORAGE_FAILED', 'UNKNOWN_GAME', 'SAVE_BUSY']) {
    const s = createProgressSession(KNOWN);
    s.onLoad({ status: 'ERROR', code });
    assert.equal(s.saveStatus, 'UNAVAILABLE', code);
    assert.equal(s.recordWin('ch1-a', 2), null);
    assert.equal(s.writeStatus, 'IDLE'); // never claims a save
  }
  const once = createProgressSession(KNOWN);
  once.onLoad({ status: 'EMPTY' });
  assert.equal(once.onLoad({ status: 'FOUND', saveVersion: 1, data: payload({ 'ch1-a': 3 }) }), null); // a second load is ignored
  assert.equal(once.best('ch1-a'), -1);
});

test('registry: Filament saves through the host store; Synapse Run entry unchanged', () => {
  const filament = getArcadeGame('filament');
  assert.ok(filament.capabilities.includes('LOCAL_SAVE_V1'));
  assert.deepEqual(filament.save, { currentVersion: FILAMENT_SAVE_VERSION, minSupportedVersion: 1 });
  const synapse = ARCADE_GAMES[0];
  assert.deepEqual([synapse.id, synapse.save, [...synapse.capabilities]], ['synapse-run', { currentVersion: 1, minSupportedVersion: 1 }, ['HOST_PROTOCOL_V1', 'PAUSE_RESUME', 'REDUCED_MOTION', 'LOCAL_SAVE_V1']]);
});

/** host.js in a vm: fake parent window, document events, location with an instance id. */
function hostHarness() {
  const id = 'c'.repeat(32), origin = 'http://127.0.0.1:5173';
  const sent = [], toGame = [], listeners = {}, docListeners = {};
  const parent = { postMessage: (data, target) => { assert.equal(target, origin); sent.push(data); } };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  const document = {
    documentElement: { setAttribute() {} },
    getElementById: () => ({ textContent: '' }),
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    removeEventListener: (type) => { delete docListeners[type]; },
    dispatchEvent: (event) => {
      // record what host.js sends to the game; requests coming from the game are only delivered to host.js
      const fromGame = event.type === 'filament:save-write' || event.type === 'filament:exit-request';
      if (!fromGame) toGame.push({ type: event.type, detail: event.detail });
      docListeners[event.type]?.(event);
    },
  };
  const window = { parent, location: { hash: `#instance=${id}`, origin }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/arcade/filament/host.js', import.meta.url), 'utf8'), { window, document, CustomEvent });
  const fromHost = (data) => listeners.message({ source: parent, origin, data });
  const envelope = (type, payload) => ({ channel: 'docteur-arcade', v: 1, gameId: 'filament', instanceId: id, type, payload });
  return { id, sent, toGame, docListeners, fromHost, envelope, CustomEvent, document };
}

test('host.js: READY, then INIT → one LOAD request; only its own pending answers are forwarded', () => {
  const h = hostHarness();
  assert.equal(h.sent[0].type, 'ARCADE_READY');
  h.fromHost(h.envelope('ARCADE_INIT', { reducedMotion: false }));
  const load = h.sent.find(m => m.type === 'ARCADE_SAVE_LOAD');
  assert.ok(load && /^[0-9a-f]{16}$/.test(load.requestId));
  // unknown request id, wrong op, other game: ignored
  h.fromHost({ ...h.envelope('ARCADE_SAVE_RESULT', { op: 'LOAD', status: 'EMPTY' }), requestId: 'f'.repeat(16) });
  h.fromHost({ ...h.envelope('ARCADE_SAVE_RESULT', { op: 'WRITE', status: 'SAVED' }), requestId: load.requestId });
  h.fromHost({ ...h.envelope('ARCADE_SAVE_RESULT', { op: 'LOAD', status: 'EMPTY' }), gameId: 'synapse-run', requestId: load.requestId });
  assert.equal(h.toGame.filter(e => e.type === 'filament:save-result').length, 0);
  h.fromHost({ ...h.envelope('ARCADE_SAVE_RESULT', { op: 'LOAD', status: 'FOUND', save: { saveVersion: 1, createdAt: 1, updatedAt: 1, data: { format: PROGRESS_FORMAT, levels: {} } } }), requestId: load.requestId });
  const forwarded = h.toGame.filter(e => e.type === 'filament:save-result');
  assert.equal(forwarded.length, 1);
  // host.js runs in a vm realm: compare the forwarded value, not that realm's Object prototype
  assert.deepEqual(structuredClone(forwarded[0].detail), { op: 'LOAD', status: 'FOUND', saveVersion: 1, data: { format: PROGRESS_FORMAT, levels: {} } });
  // the same answer twice: the request is no longer pending
  h.fromHost({ ...h.envelope('ARCADE_SAVE_RESULT', { op: 'LOAD', status: 'EMPTY' }), requestId: load.requestId });
  assert.equal(h.toGame.filter(e => e.type === 'filament:save-result').length, 1);
});

test('host.js: write requests are shape-checked and bounded; nothing is accepted after STOP', () => {
  const h = hostHarness();
  h.fromHost(h.envelope('ARCADE_INIT', { reducedMotion: false }));
  const write = (detail) => h.document.dispatchEvent(new h.CustomEvent('filament:save-write', { detail }));
  write({ saveVersion: 0, data: {} });
  write({ saveVersion: 1.5, data: {} });
  write(null);
  assert.equal(h.sent.filter(m => m.type === 'ARCADE_SAVE_WRITE').length, 0);
  assert.equal(h.toGame.filter(e => e.detail?.code === 'SAVE_BUSY').length, 3);
  for (let i = 0; i < 5; i++) write({ saveVersion: 1, data: { format: PROGRESS_FORMAT, levels: {} } });
  // LOAD is still pending: 1 + 3 writes = MAX_PENDING (4); the 4th and 5th writes are refused
  assert.equal(h.sent.filter(m => m.type === 'ARCADE_SAVE_WRITE').length, 3);
  const first = h.sent.find(m => m.type === 'ARCADE_SAVE_WRITE');
  h.fromHost(h.envelope('ARCADE_STOP', {}));
  const before = h.toGame.length;
  h.fromHost({ ...h.envelope('ARCADE_SAVE_RESULT', { op: 'WRITE', status: 'SAVED', save: { saveVersion: 1, createdAt: 1, updatedAt: 1 } }), requestId: first.requestId });
  assert.equal(h.toGame.length, before); // a late answer after STOP changes nothing
  assert.equal(h.docListeners['filament:save-write'], undefined);
});
