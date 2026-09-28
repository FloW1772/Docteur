import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initSqlite } from './src/lib/sqlite.js';
import { createOmegaOutboundInteractiveManager, OMEGA_V2_INPUT_LIMITS } from './src/lib/omega-outbound-interactive.js';
import { validateSemanticInput } from './src/lib/omega-outbound-input.js';
import { validateInputEvent, OMEGA_INPUT_EVENT_TYPES } from './src/lib/omega-input.js';

initSqlite(':memory:');
const screens = [{ index: 0, x: 0, y: 0, width: 100, height: 50, primary: true }];
const baseSession = permission => ({ id: crypto.randomUUID(), local_device_id: `ov2h-${crypto.randomUUID()}`,
  remote_device_id: `ov2c-${crypto.randomUUID()}`, permission, expires_at: new Date(Date.now() + 60_000).toISOString() });
const op = () => crypto.randomUUID();

function fixture(overrides = {}) {
  const executed = [];
  const released = [];
  const viewStops = [];
  const viewManager = { status: (_id, streamId) => ({ status: 'VIEWING', streamId, screenIndex: 0 }),
    stop: async (...args) => { viewStops.push(args); }, onStop: () => {} };
  const provider = { listScreens: async () => screens, showSessionIndicator: async () => ({ ok: true }),
    executeSemanticInput: async prepared => { executed.push(prepared); return { requested: 1, sent: 1 }; },
    releaseSemanticInput: async (kind, value) => { released.push({ kind, value }); return { requested: 1, sent: 1 }; },
    ...overrides };
  return { manager: createOmegaOutboundInteractiveManager({ viewManager, provider }), executed, released, viewStops };
}

test('INTERACTIVE requires permission and an explicit active VIEW stream', async () => {
  const denied = fixture();
  await assert.rejects(denied.manager.start(baseSession('VIEW'), { streamId: 'stream-1', screenIndex: 0 }), /PERMISSION_DENIED/);
  const inactiveView = { status: () => ({ status: 'STOPPED' }), stop: async () => {}, onStop: () => {} };
  const manager = createOmegaOutboundInteractiveManager({ viewManager: inactiveView, provider: {
    listScreens: async () => screens, showSessionIndicator: async () => ({ ok: true }),
    executeSemanticInput: async () => ({ sent: 1 }), releaseSemanticInput: async () => ({ sent: 1 }),
  } });
  await assert.rejects(manager.start(baseSession('INTERACTIVE'), { streamId: 'stream-1', screenIndex: 0 }), /VIEW_NOT_ACTIVE/);
});

test('semantic input validates bounds, enums, finite coordinates and unknown keys', () => {
  const context = { screens, screenIndex: 0 };
  assert.doesNotThrow(() => validateSemanticInput('pointer', { operationId: op(), streamId: 's', screenIndex: 0, x: 0, y: 0 }, context));
  assert.doesNotThrow(() => validateSemanticInput('pointer', { operationId: op(), streamId: 's', screenIndex: 0, x: 0.999, y: 0.999 }, context));
  for (const x of [-1, 1, Infinity, NaN]) assert.throws(() => validateSemanticInput('pointer',
    { operationId: op(), streamId: 's', screenIndex: 0, x, y: 0.5 }, context), /POINTER_OUT_OF_BOUNDS/);
  assert.throws(() => validateSemanticInput('button', { operationId: op(), streamId: 's', screenIndex: 0,
    button: 'BACK', state: 'DOWN', x: 0.5, y: 0.5 }, context), /BUTTON_INVALID/);
  assert.throws(() => validateSemanticInput('wheel', { operationId: op(), streamId: 's', screenIndex: 0,
    delta: 99, x: 0.5, y: 0.5 }, context), /WHEEL_DELTA_INVALID/);
  assert.throws(() => validateSemanticInput('key', { operationId: op(), streamId: 's', screenIndex: 0,
    key: 'Unidentified', state: 'DOWN' }, context), /KEY_INVALID/);
  assert.throws(() => validateSemanticInput('key', { operationId: op(), streamId: 's', screenIndex: 0,
    key: 'KeyA', state: 'DOWN', __protoPollution: true }, context), /INPUT_INVALID/);
});

test('signed semantic operations are stream-bound, replay-safe and release only session-owned input', async () => {
  const { manager, executed, released } = fixture();
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const keyDown = { operationId: op(), streamId: 'stream-1', screenIndex: 0, key: 'KeyA', state: 'DOWN' };
  await manager.input(session.id, 'key', keyDown);
  await assert.rejects(manager.input(session.id, 'key', keyDown), /OPERATION_REPLAYED/);
  await assert.rejects(manager.input(session.id, 'key', { ...keyDown, operationId: op() }), /DUPLICATE_DOWN/);
  await manager.input(session.id, 'button', { operationId: op(), streamId: 'stream-1', screenIndex: 0,
    button: 'MIDDLE', state: 'DOWN', x: 0.5, y: 0.5 });
  await assert.rejects(manager.input(session.id, 'pointer', { operationId: op(), streamId: 'wrong', screenIndex: 0, x: 0.5, y: 0.5 }), /WRONG_STREAM/);
  await manager.stop(session.id, 'test_stop');
  assert.equal(executed.length, 2);
  assert.deepEqual(released.map(value => `${value.kind}:${value.value}`).sort(), ['button:MIDDLE', 'key:KeyA']);
});

test('pointer latest-position coalescing and category rate limits stay bounded', async () => {
  let releaseFirst;
  let calls = 0;
  const { manager } = fixture({ executeSemanticInput: async () => {
    calls += 1;
    if (calls === 1) await new Promise(resolve => { releaseFirst = resolve; });
    return { requested: 1, sent: 1 };
  } });
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const first = manager.input(session.id, 'pointer', { operationId: op(), streamId: 'stream-1', screenIndex: 0, x: 0.1, y: 0.1 });
  const coalesced = [];
  for (let index = 0; index < 10; index += 1) coalesced.push(manager.input(session.id, 'pointer', {
    operationId: op(), streamId: 'stream-1', screenIndex: 0, x: 0.2 + index / 100, y: 0.2,
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(manager._streams.get(session.id).queue.length + (manager._streams.get(session.id).pendingMove ? 1 : 0) <= 1);
  releaseFirst();
  await Promise.all([first, ...coalesced]);
  assert.ok(calls <= 2);
  for (let index = 0; index < OMEGA_V2_INPUT_LIMITS.wheelPerSecond; index += 1) await manager.input(session.id, 'wheel', {
    operationId: op(), streamId: 'stream-1', screenIndex: 0, delta: 1, x: 0.5, y: 0.5,
  });
  await assert.rejects(manager.input(session.id, 'wheel', {
    operationId: op(), streamId: 'stream-1', screenIndex: 0, delta: 1, x: 0.5, y: 0.5,
  }), /RATE_LIMITED/);
  await manager.stop(session.id, 'test_stop');
});

test('STOP waits for an in-flight DOWN then releases it and rejects future input', async () => {
  let releaseExecution;
  const released = [];
  const { manager } = fixture({ executeSemanticInput: async () => {
    await new Promise(resolve => { releaseExecution = resolve; }); return { requested: 1, sent: 1 };
  }, releaseSemanticInput: async (kind, value) => { released.push({ kind, value }); return { sent: 1 }; } });
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const pending = manager.input(session.id, 'key', { operationId: op(), streamId: 'stream-1', screenIndex: 0, key: 'KeyB', state: 'DOWN' });
  await new Promise(resolve => setImmediate(resolve));
  const stopped = manager.stop(session.id, 'stop_session');
  releaseExecution();
  await pending; await stopped;
  assert.deepEqual(released, [{ kind: 'key', value: 'KeyB' }]);
  await assert.rejects(manager.input(session.id, 'key', { operationId: op(), streamId: 'stream-1', screenIndex: 0, key: 'KeyB', state: 'UP' }), /INTERACTIVE_NOT_STARTED/);
});

test('VIEW stop, remote STOP and revocation invalidate INTERACTIVE and release held state', async () => {
  let remoteStop;
  const released = [];
  const { manager, viewStops } = fixture({
    showSessionIndicator: async (_kind, _sessionId, _deviceId, _expiresAt, callback) => { if (callback) remoteStop = callback; return { ok: true }; },
    releaseSemanticInput: async (kind, value) => { released.push(`${kind}:${value}`); return { sent: 1 }; },
  });
  const first = baseSession('INTERACTIVE');
  await manager.start(first, { streamId: 'stream-1', screenIndex: 0 });
  await manager.input(first.id, 'key', { operationId: op(), streamId: 'stream-1', screenIndex: 0, key: 'KeyC', state: 'DOWN' });
  await remoteStop();
  assert.equal(manager._streams.has(first.id), false);
  assert.ok(released.includes('key:KeyC'));
  assert.equal(viewStops.length, 1);

  const second = baseSession('INTERACTIVE');
  await manager.start(second, { streamId: 'stream-2', screenIndex: 0 });
  manager.onViewStopped(second.id, 'controller_view_stop');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager._streams.has(second.id), false);

  const third = baseSession('INTERACTIVE');
  await manager.start(third, { streamId: 'stream-3', screenIndex: 0 });
  assert.equal(await manager.stopForController(third.remote_device_id, 'controller_revoked'), 1);
  assert.equal(manager._streams.has(third.id), false);
});

test('missing signed heartbeat triggers bounded network-drop cleanup', { timeout: 10_000 }, async () => {
  const released = [];
  const { manager, viewStops } = fixture({ releaseSemanticInput: async (kind, value) => {
    released.push(`${kind}:${value}`); return { sent: 1 };
  } });
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  await manager.input(session.id, 'button', { operationId: op(), streamId: 'stream-1', screenIndex: 0,
    button: 'LEFT', state: 'DOWN', x: 0.5, y: 0.5 });
  await new Promise(resolve => setTimeout(resolve, OMEGA_V2_INPUT_LIMITS.leaseMs + 150));
  assert.equal(manager._streams.has(session.id), false);
  assert.ok(released.includes('button:LEFT'));
  assert.equal(viewStops.length, 1);
});

test('coalesced moves never overtake later DOWN/UP or key events', async () => {
  let unblock;
  let calls = 0;
  const order = [];
  const { manager } = fixture({ executeSemanticInput: async prepared => {
    calls += 1;
    order.push(prepared.category === 'pointer' ? `move:${prepared.tuple[1]}` : `${prepared.category}:${prepared.button ?? prepared.key}:${prepared.state}`);
    if (calls === 1) await new Promise(resolve => { unblock = resolve; });
    return { requested: 1, sent: 1 };
  } });
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const base = { streamId: 'stream-1', screenIndex: 0 };
  const pending = [manager.input(session.id, 'pointer', { ...base, operationId: op(), x: 0.1, y: 0.5 })];
  await new Promise(resolve => setImmediate(resolve));
  pending.push(manager.input(session.id, 'pointer', { ...base, operationId: op(), x: 0.2, y: 0.5 }));
  pending.push(manager.input(session.id, 'pointer', { ...base, operationId: op(), x: 0.3, y: 0.5 }));
  pending.push(manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'DOWN', x: 0.3, y: 0.5 }));
  pending.push(manager.input(session.id, 'pointer', { ...base, operationId: op(), x: 0.6, y: 0.5 }));
  pending.push(manager.input(session.id, 'pointer', { ...base, operationId: op(), x: 0.7, y: 0.5 }));
  pending.push(manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'UP', x: 0.7, y: 0.5 }));
  pending.push(manager.input(session.id, 'key', { ...base, operationId: op(), key: 'KeyA', state: 'DOWN' }));
  pending.push(manager.input(session.id, 'key', { ...base, operationId: op(), key: 'KeyA', state: 'UP' }));
  pending.push(manager.input(session.id, 'pointer', { ...base, operationId: op(), x: 0.9, y: 0.5 }));
  await new Promise(resolve => setImmediate(resolve));
  unblock();
  await Promise.all(pending);
  await manager._streams.get(session.id)?.drainPromise;
  const norm = x => validateSemanticInput('pointer', { ...base, operationId: op(), x, y: 0.5 }, { screens, screenIndex: 0 }).tuple[1];
  const index = label => order.indexOf(label);
  assert.ok(index(`move:${norm(0.3)}`) !== -1 && index(`move:${norm(0.3)}`) < index('button:LEFT:DOWN'), `latest move before DOWN: ${order}`);
  assert.equal(order.includes(`move:${norm(0.2)}`), false, 'intermediate move coalesced');
  assert.ok(index(`move:${norm(0.7)}`) > index('button:LEFT:DOWN') && index(`move:${norm(0.7)}`) < index('button:LEFT:UP'), `drag move between DOWN and UP: ${order}`);
  assert.ok(index('button:LEFT:UP') < index('key:KeyA:DOWN') && index('key:KeyA:DOWN') < index('key:KeyA:UP'), `DOWN/UP order preserved: ${order}`);
  assert.equal(order.at(-1), `move:${norm(0.9)}`, `final position is the latest move: ${order}`);
  await manager.stop(session.id, 'test_stop');
});

test('pointer mapping: scaled screens, exact bounds, resolution change and invalid coordinates', async () => {
  const context = size => ({ screens: [{ index: 0, x: 0, y: 0, width: size[0], height: size[1], primary: true }], screenIndex: 0 });
  const map = (x, y, size) => validateSemanticInput('pointer', { operationId: op(), streamId: 's', screenIndex: 0, x, y }, context(size)).tuple;
  assert.deepEqual(map(0, 0, [1920, 1080]).slice(1, 3), [0, 0], 'origin maps to 0,0');
  const edge = validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 1919, y: 1079 }, context([1920, 1080]));
  assert.deepEqual(map(0.9999999, 0.9999999, [1920, 1080]), edge, 'right/bottom edge maps to pixel max-1');
  assert.deepEqual(map(0.5, 0.5, [1920, 1080]).slice(1, 3), map(0.5, 0.5, [3840, 2160]).slice(1, 3), 'scaled screens keep the relative point');
  for (const bad of [-0.0001, 1, 1.5, -1, NaN, Infinity, -Infinity, 1e308, '0.5', null, undefined, true, [0.5], { v: 0.5 }]) {
    assert.throws(() => map(bad, 0.5, [1920, 1080]), /POINTER_OUT_OF_BOUNDS/, `x=${String(bad)}`);
    assert.throws(() => map(0.5, bad, [1920, 1080]), /POINTER_OUT_OF_BOUNDS/, `y=${String(bad)}`);
  }
  let current = [100, 50];
  const executed = [];
  const { manager } = fixture({ listScreens: async () => [{ index: 0, x: 0, y: 0, width: current[0], height: current[1], primary: true }],
    executeSemanticInput: async prepared => { executed.push(prepared.tuple); return { requested: 1, sent: 1 }; } });
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  await manager.input(session.id, 'pointer', { operationId: op(), streamId: 'stream-1', screenIndex: 0, x: 0.5, y: 0.5 });
  current = [4, 2];
  await manager.input(session.id, 'pointer', { operationId: op(), streamId: 'stream-1', screenIndex: 0, x: 0.99, y: 0.99 });
  assert.deepEqual(executed.at(-1), validateInputEvent({ type: OMEGA_INPUT_EVENT_TYPES.MOVE, x: 3, y: 1 }, context([4, 2])),
    'remote resolution change uses the current screen bounds');
  await assert.rejects(manager.input(session.id, 'pointer', { operationId: op(), streamId: 'stream-1', screenIndex: 1, x: 0.5, y: 0.5 }), /WRONG_SCREEN/);
  await assert.rejects(manager.input(session.id, 'pointer', { operationId: op(), streamId: 'stream-2', screenIndex: 0, x: 0.5, y: 0.5 }), /WRONG_STREAM/);
  await manager.stop(session.id, 'test_stop');
});

test('input matrix: operation ids, enums, key codes, prototype keys and text category are rejected', async () => {
  const { manager, executed } = fixture();
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const base = { streamId: 'stream-1', screenIndex: 0 };
  const reject = (category, payload, code) => assert.rejects(manager.input(session.id, category, { ...base, operationId: op(), ...payload }), code);
  for (const operationId of [undefined, '', 'not-a-uuid', 42, 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
    await assert.rejects(manager.input(session.id, 'key', { ...base, operationId, key: 'KeyA', state: 'DOWN' }), /OPERATION_ID_INVALID/);
  }
  for (const button of ['BACK', 'FORWARD', 'left', 4, null, '__proto__']) await reject('button', { button, state: 'DOWN', x: 0.5, y: 0.5 }, /BUTTON_INVALID/);
  await reject('button', { button: 'LEFT', state: 'CLICK', x: 0.5, y: 0.5 }, /BUTTON_INVALID/);
  for (const key of ['Escape', 'Unidentified', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 65, 0x1B, 'a', 'MediaPlayPause', 'PrintScreen', 'Pause']) {
    await reject('key', { key, state: 'DOWN' }, /KEY_INVALID/);
  }
  await reject('key', { key: 'KeyA', state: 'PRESS' }, /KEY_INVALID/);
  for (const delta of [0, 4, -4, 1e9, 1.5, NaN, '1']) await reject('wheel', { delta, x: 0.5, y: 0.5 }, /WHEEL_DELTA_INVALID/);
  await reject('pointer', { x: 1e12, y: 1e12 }, /POINTER_OUT_OF_BOUNDS/);
  const polluted = JSON.parse(`{"operationId":"${op()}","streamId":"stream-1","screenIndex":0,"key":"KeyA","state":"DOWN","__proto__":{"polluted":true}}`);
  await assert.rejects(manager.input(session.id, 'key', polluted), /INPUT_INVALID/);
  const constructorPolluted = { ...base, operationId: op(), key: 'KeyA', state: 'DOWN', constructor: { prototype: { polluted: true } } };
  await assert.rejects(manager.input(session.id, 'key', constructorPolluted), /INPUT_INVALID/);
  assert.equal(({}).polluted, undefined, 'Object prototype untouched');
  await assert.rejects(manager.input(session.id, 'text', { ...base, operationId: op(), text: 'dir' }), /INPUT_CATEGORY_INVALID/);
  await assert.rejects(manager.input(session.id, 'key', null), /INPUT_INVALID/);
  assert.equal(executed.length, 0, 'no rejected input reached SendInput');
  await manager.stop(session.id, 'test_stop');
});

test('input state machine: orphan UP, duplicate DOWN/UP and rapid DOWN/UP ordering', async () => {
  const { manager, executed } = fixture();
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const base = { streamId: 'stream-1', screenIndex: 0 };
  await manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'UP', x: 0.5, y: 0.5 });
  assert.equal(executed.length, 0, 'orphan UP is an idempotent no-op');
  await manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'DOWN', x: 0.5, y: 0.5 });
  await assert.rejects(manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'DOWN', x: 0.5, y: 0.5 }), /DUPLICATE_DOWN/);
  await manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'UP', x: 0.5, y: 0.5 });
  const second = await manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'UP', x: 0.5, y: 0.5 });
  assert.equal(second.idempotent, true, 'duplicate UP is not re-sent');
  const rapid = [];
  for (let index = 0; index < 4; index += 1) {
    rapid.push(manager.input(session.id, 'key', { ...base, operationId: op(), key: 'KeyZ', state: 'DOWN' }));
    rapid.push(manager.input(session.id, 'key', { ...base, operationId: op(), key: 'KeyZ', state: 'UP' }));
  }
  await Promise.all(rapid);
  const keySequence = executed.filter(value => value.category === 'key').map(value => value.state);
  assert.deepEqual(keySequence, ['DOWN', 'UP', 'DOWN', 'UP', 'DOWN', 'UP', 'DOWN', 'UP'], 'rapid DOWN/UP keeps strict order');
  assert.equal(manager.status(session.id, 'stream-1').heldKeyCount, 0);
  await manager.stop(session.id, 'test_stop');
});

test('separate category floods are bounded and do not starve other categories', async t => {
  // Freeze Date only: the whole flood falls in one rate window even on a loaded machine.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { manager, executed } = fixture();
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const base = { streamId: 'stream-1', screenIndex: 0 };
  const rssBefore = process.memoryUsage().rss;
  const started = process.hrtime.bigint();
  const payloads = {
    pointer: () => ({ x: Math.random() * 0.99, y: Math.random() * 0.99 }),
    button: index => ({ button: 'RIGHT', state: index % 2 ? 'UP' : 'DOWN', x: 0.5, y: 0.5 }),
    wheel: () => ({ delta: 1, x: 0.5, y: 0.5 }),
    key: index => ({ key: 'KeyQ', state: index % 2 ? 'UP' : 'DOWN' }),
  };
  const accepted = {};
  for (const category of Object.keys(payloads)) {
    const results = await Promise.allSettled(Array.from({ length: 2_000 }, (_value, index) =>
      manager.input(session.id, category, { ...base, operationId: op(), ...payloads[category](index) })));
    accepted[category] = results.filter(result => result.status === 'fulfilled').length;
    const limited = results.filter(result => result.status === 'rejected' && result.reason.code === 'RATE_LIMITED').length;
    assert.ok(accepted[category] <= OMEGA_V2_INPUT_LIMITS[`${category}PerSecond`], `${category} accepted ${accepted[category]}`);
    assert.ok(limited >= 2_000 - OMEGA_V2_INPUT_LIMITS[`${category}PerSecond`] - 1, `${category} flood rate limited`);
    assert.ok(accepted[category] >= 1, `${category} not starved by previous floods`);
    const state = manager._streams.get(session.id);
    assert.ok(state.queue.length <= OMEGA_V2_INPUT_LIMITS.maxQueue && state.operationIds.size <= OMEGA_V2_INPUT_LIMITS.maxOperationIds);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const rssGrowth = process.memoryUsage().rss - rssBefore;
  assert.ok(elapsedMs < 10_000, `flood handled in bounded time (${elapsedMs.toFixed(0)} ms)`);
  assert.ok(rssGrowth < 128 * 1024 * 1024, `bounded RAM growth (${Math.round(rssGrowth / 1024 / 1024)} MiB)`);
  assert.ok(executed.length <= 30 + 10 + 8 + 20);
  await manager.stop(session.id, 'test_stop');
});

test('coalescing burst keeps a bounded queue and lands on the latest position', async () => {
  let unblock;
  let calls = 0;
  const executed = [];
  const { manager } = fixture({ executeSemanticInput: async prepared => {
    calls += 1; executed.push(prepared.tuple);
    if (calls === 1) await new Promise(resolve => { unblock = resolve; });
    return { requested: 1, sent: 1 };
  } });
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  const base = { streamId: 'stream-1', screenIndex: 0 };
  const first = manager.input(session.id, 'pointer', { ...base, operationId: op(), x: 0.01, y: 0.01 });
  await new Promise(resolve => setImmediate(resolve));
  const burst = [];
  for (let index = 1; index < 29; index += 1) burst.push(manager.input(session.id, 'pointer', { ...base, operationId: op(), x: index / 30, y: 0.5 }));
  await Promise.all(burst);
  assert.equal(manager.status(session.id, 'stream-1').queueDepth, 1, 'burst collapses to one pending move');
  unblock();
  await first;
  await manager._streams.get(session.id)?.drainPromise;
  assert.equal(executed.length, 2, 'first move plus the single latest move');
  const expected = validateSemanticInput('pointer', { ...base, operationId: op(), x: 28 / 30, y: 0.5 }, { screens, screenIndex: 0 }).tuple;
  assert.deepEqual(executed.at(-1), expected, 'final position is exactly the latest move');
  await manager.stop(session.id, 'test_stop');
});

test('stuck input is released on every stop path and only for the owning session', async () => {
  const released = [];
  let localStop;
  const { manager, viewStops } = fixture({
    showSessionIndicator: async (_kind, sessionId, _deviceId, _expiresAt, callback) => { if (callback) localStop = { sessionId, callback }; return { ok: true }; },
    releaseSemanticInput: async (kind, value, _screens, _index, held) => { released.push({ kind, value, session: held?.sessionTag }); return { sent: 1 }; },
    executeSemanticInput: async () => ({ requested: 1, sent: 1 }),
  });
  const holdAll = async session => {
    const base = { streamId: session.stream, screenIndex: 0 };
    await manager.input(session.id, 'key', { ...base, operationId: op(), key: 'ShiftLeft', state: 'DOWN' });
    await manager.input(session.id, 'button', { ...base, operationId: op(), button: 'LEFT', state: 'DOWN', x: 0.5, y: 0.5 });
    await manager.input(session.id, 'button', { ...base, operationId: op(), button: 'MIDDLE', state: 'DOWN', x: 0.5, y: 0.5 });
  };
  const paths = {
    interactive_stop: session => manager.stop(session.id, 'controller_interactive_stop'),
    view_stop: async session => { manager.onViewStopped(session.id, 'controller_view_stop'); await new Promise(resolve => setTimeout(resolve, 20)); },
    session_stop: session => manager.stop(session.id, 'controller_stop'),
    remote_local_stop: async session => { assert.equal(localStop.sessionId, session.id); await localStop.callback(); },
    revocation: session => manager.stopForController(session.remote_device_id, 'controller_revoked'),
    terminal_envelope: session => manager.stop(session.id, 'SESSION_EXPIRED', { stopView: true }),
  };
  for (const [name, trigger] of Object.entries(paths)) {
    const target = { ...baseSession('INTERACTIVE'), stream: `stream-${name}` };
    const bystander = { ...baseSession('INTERACTIVE'), stream: `stream-bystander-${name}` };
    await manager.start(bystander, { streamId: bystander.stream, screenIndex: 0 });
    await manager.start(target, { streamId: target.stream, screenIndex: 0 });
    await holdAll(target); await holdAll(bystander);
    released.length = 0;
    await trigger(target);
    assert.equal(manager._streams.has(target.id), false, `${name} stops the target`);
    assert.deepEqual(released.map(value => `${value.kind}:${value.value}`).sort(), ['button:LEFT', 'button:MIDDLE', 'key:ShiftLeft'], `${name} releases held input`);
    assert.equal(manager.status(bystander.id, bystander.stream).heldKeyCount, 1, `${name} leaves the other session alone`);
    assert.equal(manager.status(bystander.id, bystander.stream).heldButtonCount, 2);
    await assert.rejects(manager.input(target.id, 'key', { streamId: target.stream, screenIndex: 0, operationId: op(), key: 'KeyA', state: 'DOWN' }), /INTERACTIVE_NOT_STARTED/);
    await manager.stop(bystander.id, 'cleanup');
  }
  assert.ok(viewStops.length >= 3, 'remote/revocation/terminal paths also stop VIEW');
});

test('session expiry stops INTERACTIVE and releases held input without further traffic', async () => {
  const released = [];
  const { manager, viewStops } = fixture({ releaseSemanticInput: async (kind, value) => { released.push(`${kind}:${value}`); return { sent: 1 }; } });
  const session = { ...baseSession('INTERACTIVE'), expires_at: new Date(Date.now() + 400).toISOString() };
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  await manager.input(session.id, 'key', { operationId: op(), streamId: 'stream-1', screenIndex: 0, key: 'ControlLeft', state: 'DOWN' });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(manager._streams.has(session.id), false);
  assert.deepEqual(released, ['key:ControlLeft']);
  assert.equal(viewStops.at(-1)?.[1], 'session_expired');
});

test('network lease: signed keepalive keeps INTERACTIVE alive, silence stops it, no auto-reconnect', { timeout: 20_000 }, async () => {
  const { manager, viewStops } = fixture();
  const session = baseSession('INTERACTIVE');
  await manager.start(session, { streamId: 'stream-1', screenIndex: 0 });
  for (let index = 0; index < 4; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.equal(manager.status(session.id, 'stream-1').status, 'INTERACTIVE', 'keepalive refreshes the lease');
  }
  await new Promise(resolve => setTimeout(resolve, OMEGA_V2_INPUT_LIMITS.leaseMs + 250));
  assert.equal(manager._streams.has(session.id), false, 'missing keepalive stops INTERACTIVE');
  assert.equal(viewStops.at(-1)?.[1], 'network_timeout');
  assert.equal(manager.status(session.id, 'stream-1').status, 'STOPPED', 'no automatic restart');
  await assert.rejects(manager.input(session.id, 'pointer', { operationId: op(), streamId: 'stream-1', screenIndex: 0, x: 0.5, y: 0.5 }), /INTERACTIVE_NOT_STARTED/);
});

test('no text, command, RPC or ADMIN surface exists in the INTERACTIVE modules', async () => {
  const modules = [await import('./src/lib/omega-outbound-interactive.js'), await import('./src/lib/omega-outbound-input.js'),
    await import('./src/lib/omega-outbound-client.js')];
  const { manager } = fixture();
  // Phase 5 adds a closed set of typed ADMIN functions to the shared outbound client only.
  const phase5Admin = new Set(['OMEGA_V2_ADMIN_CLIENT_LIMITS', 'verifyOmegaOutboundAdminPayload',
    'getOmegaOutboundAdminSystemInfo', 'listOmegaOutboundAdminProcesses', 'getOmegaOutboundAdminServiceStatus',
    'getOmegaOutboundAdminNetworkStatus', 'getOmegaOutboundAdminDiskStatus', 'requestOmegaOutboundAdminLock',
    'requestOmegaOutboundAdminLogoff', 'requestOmegaOutboundAdminRestart', 'requestOmegaOutboundAdminShutdown',
    'getOmegaOutboundAdminOperation', 'cancelOmegaOutboundAdminOperation']);
  const interactiveNames = [...Object.keys(modules[0]), ...Object.keys(modules[1]), ...Object.keys(manager)];
  const clientNames = Object.keys(modules[2]);
  for (const name of [...interactiveNames, ...clientNames]) {
    assert.doesNotMatch(name, /text|command|execute(?!Semantic)|rpc|raw|clipboard|file|shell/i, name);
  }
  for (const name of [...interactiveNames, ...clientNames.filter(value => !phase5Admin.has(value))]) {
    assert.doesNotMatch(name, /admin|lock|logoff|restart|shutdown/i, name);
  }
  assert.deepEqual(clientNames.filter(value => /admin/i.test(value)).sort(), [...phase5Admin].sort());
});
