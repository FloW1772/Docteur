import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ARCADE_GAMES, ARCADE_ROUTE_PATTERN, getArcadeGame } from '../src/lib/arcade/registry.ts';
import { ARCADE_IFRAME_SANDBOX, arcadeFrameSrc, buildArcadeHostCommand, parseArcadeGameEvent } from '../src/lib/arcade/protocol.ts';
import { createLocalRequestGuard } from '../cortex-server/src/lib/local-request-guard.js';
import { applyLocalApiSecurity } from '../cortex-server/src/lib/local-api-policy.js';
import { DASHBOARD_CARDS } from '../src/lib/dashboard/dashboard-layout.ts';
import { getFeatureDefinition } from '../src/content/featureRegistry.ts';

const id = 'a'.repeat(32), other = 'b'.repeat(32);
const expected = { gameId: 'synapse-run', instanceId: id };
const event = (type, payload = {}) => ({ channel: 'docteur-arcade', v: 1, ...expected, type, payload });

test('registry: exactly one immutable original foundation, local approved route only', () => {
  assert.equal(ARCADE_GAMES.length, 1);
  const game = ARCADE_GAMES[0];
  assert.deepEqual([game.id, game.title, game.route, game.status, game.availability], ['synapse-run', 'Synapse Run', '/arcade/synapse-run/index.html', 'FOUNDATION_ONLY', 'COMING_NEXT']);
  assert.ok(Object.isFrozen(ARCADE_GAMES) && Object.isFrozen(game) && Object.isFrozen(game.capabilities));
  assert.equal(getArcadeGame('synapse-run'), game);
  for (const bad of [null, {}, '../synapse-run', 'https://example.invalid', 'other']) assert.equal(getArcadeGame(bad), null);
  assert.equal(arcadeFrameSrc(game.route, id), `${game.route}#instance=${id}`);
  for (const route of ['https://example.invalid/index.html', '//example.invalid', '/arcade/other/index.html', '/arcade/../index.html', game.route + '?url=x', game.route + '#x', '/api/health']) assert.throws(() => arcadeFrameSrc(route, id), /ARCADE_BAD_ROUTE/);
  assert.ok(ARCADE_ROUTE_PATTERN.test(game.route));
  assert.throws(() => arcadeFrameSrc(game.route, 'invalid'), /ARCADE_BAD_INSTANCE_ID/);
});

test('sandbox is scripts only; feature is opt-in and explainable', () => {
  assert.equal(ARCADE_IFRAME_SANDBOX, 'allow-scripts');
  assert.equal(DASHBOARD_CARDS.find(c => c.id === 'arcade').defaultVisible, false);
  assert.ok(getFeatureDefinition('arcade'));
  assert.equal(getFeatureDefinition('arcade').status, 'PARTIAL');
  assert.equal(getFeatureDefinition('arcade').available, true);
});

test('standalone page keeps the exact restrictive page CSP and only local bootstrap assets', () => {
  const html = fs.readFileSync(new URL('../public/arcade/synapse-run/index.html', import.meta.url), 'utf8');
  const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.equal(policy, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'");
  assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]), ['./foundation.css', './foundation.js']);
});

test('game protocol accepts every exact allowed payload', () => {
  for (const data of [event('ARCADE_READY'), ...['active', 'paused', 'stopped'].map(state => event('ARCADE_STATE', { state })), event('ARCADE_ERROR', { code: 'GAME_RUNTIME_ERROR' })]) assert.deepEqual(parseArcadeGameEvent(data, expected), data);
});

test('game protocol rejects unknown types, malformed envelopes and payloads', () => {
  const valid = event('ARCADE_READY');
  const bad = [null, [], 1, 'ARCADE_READY', {}, event('UNKNOWN'), event('ARCADE_INIT'), event('ARCADE_READY', { extra: 1 }), event('ARCADE_STATE', { state: 'playing' }), event('ARCADE_STATE', { state: 'active', extra: 1 }), event('ARCADE_ERROR', { code: 'arbitrary text' }), event('ARCADE_READY', []), event('ARCADE_READY', null), { ...valid, extra: 1 }, { ...valid, v: 2 }, { ...valid, channel: 'other' }, { ...valid, gameId: 'other' }, { ...valid, instanceId: other }, { ...valid, instanceId: '' }];
  for (const data of bad) assert.equal(parseArcadeGameEvent(data, expected), null, JSON.stringify(data));
  for (const key of Object.keys(valid)) { const missing = { ...valid }; delete missing[key]; assert.equal(parseArcadeGameEvent(missing, expected), null); }
});

function gameHarness() {
  const listeners = {}, sent = [], attrs = {}, status = {};
  const origin = 'http://127.0.0.1:5173';
  const parent = { postMessage: (data, target) => { assert.equal(target, origin); sent.push(data); } };
  const window = { parent, location: { hash: `#instance=${id}`, origin }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/arcade/synapse-run/foundation.js', import.meta.url), 'utf8'), { window, document: { getElementById: () => status, documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } } });
  return { sent, attrs, send: (data, source = parent, messageOrigin = origin) => listeners.message({ data, source, origin: messageOrigin }) };
}

test('real foundation accepts only exact host commands and current parent/instance', () => {
  const g = gameHarness();
  assert.deepEqual(JSON.parse(JSON.stringify(g.sent)), [event('ARCADE_READY')]);
  const init = buildArcadeHostCommand('ARCADE_INIT', 'synapse-run', id, { reducedMotion: true });
  for (const data of [event('UNKNOWN'), { ...init, gameId: 'other' }, { ...init, instanceId: other }, { ...init, v: 2 }, { ...init, channel: 'bad' }, { ...init, extra: 1 }, { ...init, payload: { reducedMotion: 1 } }, { ...init, payload: { reducedMotion: true, extra: 1 } }, event('ARCADE_PAUSE', { extra: true })]) g.send(data);
  g.send(init, {});
  g.send(init, undefined, 'https://other.invalid');
  assert.equal(g.attrs['data-state'], 'waiting');
  g.send(init);
  assert.equal(g.attrs['data-state'], 'active');
  assert.equal(g.attrs['data-reduced-motion'], 'true');
  for (const [type, state] of [['ARCADE_PAUSE', 'paused'], ['ARCADE_RESUME', 'active'], ['ARCADE_STOP', 'stopped']]) {
    const command = buildArcadeHostCommand(type, 'synapse-run', id);
    assert.deepEqual(command, event(type));
    g.send(command);
    assert.equal(g.attrs['data-state'], state);
  }
  g.send(init);
  g.send(buildArcadeHostCommand('ARCADE_RESUME', 'synapse-run', id));
  assert.equal(g.attrs['data-state'], 'stopped');
});

test('existing backend middleware rejects opaque Origin/null before any synthetic privileged handler', async () => {
  const require = createRequire(new URL('../cortex-server/package.json', import.meta.url));
  const { Hono } = require('hono');
  const app = new Hono(); let hits = 0;
  app.use('*', createLocalRequestGuard());
  app.all('*', c => { hits++; return c.json({ synthetic: true }); });
  for (const path of ['/api/notebooks', '/api/companion/status', '/api/devices', '/api/omega/admin/actions', '/api/rassilon/jobs']) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await app.request(`http://127.0.0.1:3001${path}`, { method, headers: { origin: 'null' } });
      assert.equal(response.status, 403, `STOP: opaque origin accepted: ${method} ${path}`);
      assert.equal((await response.json()).code, 'FORBIDDEN_ORIGIN');
    }
  }
  assert.equal(hits, 0);
});

test('production central policy and frozen control-plane guards refuse null origin (no stores opened)', async () => {
  const require = createRequire(new URL('../cortex-server/package.json', import.meta.url));
  const { Hono } = require('hono');
  const app = new Hono();
  applyLocalApiSecurity(app);
  const { createOmegaRoute } = await import('../cortex-server/src/routes/omega.js');
  const { createRassilonRoute } = await import('../cortex-server/src/routes/rassilon.js');
  const { createDeviceFabricRoute } = await import('../cortex-server/src/routes/device-fabric.js');
  // Supply loopback transport only, so a 403 proves the Origin guard, not a missing socket.
  for (const factory of [createOmegaRoute, createRassilonRoute, createDeviceFabricRoute]) app.route('/api', factory({ isLocal: () => true }));
  for (const path of ['/api/notebooks', '/api/companion/status', '/api/omega/status', '/api/omega/admin/actions', '/api/rassilon/jobs', '/api/device-fabric/devices']) {
    for (const method of ['GET', 'POST']) {
      const response = await app.request(`http://127.0.0.1:3001${path}`, { method, headers: { origin: 'null' } });
      assert.equal(response.status, 403, `STOP: opaque origin reached privileged route: ${method} ${path}`);
      assert.match(JSON.stringify(await response.json()), /FORBIDDEN_ORIGIN|origin_denied/);
    }
  }
});
