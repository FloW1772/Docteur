/**
 * DEVICE FABRIC local API — Phase 2 inventory/linking + Phase 3 safe
 * RASSILON routing.
 *
 * Control plane only: the same loopback + Host + Origin guard as
 * routes/omega.js and routes/rassilon.js. It is never mounted on the
 * RASSILON LAN listener and accepts no OMEGA/RASSILON session material.
 *
 * The single routing endpoint is POST /device-fabric/route with a closed
 * semantic action enum (lib/device-fabric-routing.js). There is no generic
 * /execute, /run, /command, /shell, /tool, /rpc, /action or /dispatch
 * surface, and GET endpoints never route anything.
 */
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import {
  DeviceFabricError, createFabricDevice, getFabricDeviceView, linkAgent, listAgentsForFabricWithErrors,
  listFabricAuditEvents, listFabricDeviceViews, removeFabricDevice, renameFabricDevice, unlinkAgent,
} from '../lib/device-fabric.js';
import {
  FabricRouteRejection, getFabricOperationView, listFabricOperationViews, probeRassilonWorker, routeFabricAction,
} from '../lib/device-fabric-routing.js';

const LOCAL_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ROUTE_BODY_BYTES = 64 * 1024;

function readJsonObject(c) {
  return c.req.json().then(
    body => (body && typeof body === 'object' && !Array.isArray(body) ? body : Promise.reject(new DeviceFabricError('json_object_required'))),
    () => Promise.reject(new DeviceFabricError('json_invalid')),
  );
}

function onlyFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new DeviceFabricError('unknown_field');
  }
  return body;
}

export function createDeviceFabricRoute({
  logger,
  isLocal = c => { try { return LOCAL_ADDRESSES.includes(getConnInfo(c).remote.address); } catch { return false; } },
  // Test-only injection point (fixture RASSILON transport, fast polling).
  // Production passes nothing: RASSILON's own pinned-TLS transport is used.
  routing = {},
} = {}) {
  const route = new Hono();

  route.use('/device-fabric/*', async (c, next) => {
    if (!isLocal(c)) return c.json({ ok: false, error: 'local_access_required' }, 403);
    if (!LOCAL_HOSTNAMES.includes(new URL(c.req.url).hostname)) return c.json({ ok: false, error: 'host_denied' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || !LOCAL_HOSTNAMES.includes(parsed.hostname)) {
          return c.json({ ok: false, error: 'origin_denied' }, 403);
        }
      } catch { return c.json({ ok: false, error: 'origin_denied' }, 403); }
    }
    if (['POST', 'PATCH'].includes(c.req.method) && !c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ ok: false, error: 'json_required' }, 415);
    }
    await next();
  });
  const smallBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: c => c.json({ ok: false, error: 'request_too_large' }, 413) });
  const routeBody = bodyLimit({ maxSize: MAX_ROUTE_BODY_BYTES, onError: c => c.json({ ok: false, error: 'request_too_large' }, 413) });
  route.use('/device-fabric/*', (c, next) => (new URL(c.req.url).pathname.endsWith('/device-fabric/route') ? routeBody(c, next) : smallBody(c, next)));

  // Every handler goes through here: known errors become a code, anything
  // else a generic 500. No message, stack or internal detail is returned.
  const handle = fn => async c => {
    try { return await fn(c); } catch (error) {
      if (error instanceof FabricRouteRejection && error.operation) return c.json({ ok: false, error: error.code, operation: error.operation }, error.status);
      if (error instanceof DeviceFabricError) return c.json({ ok: false, error: error.code }, error.status);
      logger?.warn?.({ error_name: error?.name }, 'DEVICE_FABRIC_ROUTE_UNEXPECTED_ERROR');
      return c.json({ ok: false, error: 'internal_error' }, 500);
    }
  };

  route.get('/device-fabric/devices', handle(c => c.json({ ok: true, devices: listFabricDeviceViews() })));

  route.get('/device-fabric/devices/:id', handle(c => c.json({ ok: true, device: getFabricDeviceView(c.req.param('id')) })));

  route.post('/device-fabric/devices', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['displayName']);
    return c.json({ ok: true, device: createFabricDevice(body) }, 201);
  }));

  route.patch('/device-fabric/devices/:id', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['displayName']);
    return c.json({ ok: true, device: renameFabricDevice(c.req.param('id'), body) });
  }));

  route.delete('/device-fabric/devices/:id', handle(c => {
    const confirm = c.req.query('confirm') ?? null;
    return c.json({ ok: true, ...removeFabricDevice(c.req.param('id'), { confirm }) });
  }));

  route.get('/device-fabric/agents', handle(c => {
    const { agents, errors } = listAgentsForFabricWithErrors();
    return c.json({ ok: true, agents, agentErrors: errors });
  }));

  route.post('/device-fabric/devices/:id/link', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['agentType', 'agentDeviceId', 'confirmFingerprint']);
    return c.json({ ok: true, device: linkAgent(c.req.param('id'), body) });
  }));

  route.delete('/device-fabric/devices/:id/link/:agentType', handle(c => (
    c.json({ ok: true, device: unlinkAgent(c.req.param('id'), c.req.param('agentType')) })
  )));

  route.get('/device-fabric/audit', handle(c => {
    const raw = Number(c.req.query('limit') ?? 100);
    return c.json({ ok: true, events: listFabricAuditEvents({ limit: Number.isFinite(raw) ? Math.trunc(raw) : 100 }) });
  }));

  // ── Phase 3: explicit semantic RASSILON routing ──────────────────────────
  route.post('/device-fabric/route', handle(async c => {
    const body = await readJsonObject(c);
    const operation = await routeFabricAction(body, routing);
    return c.json({ ok: true, operation }, 202);
  }));

  route.get('/device-fabric/operations', handle(c => {
    const limit = Math.trunc(Number(c.req.query('limit') ?? 50));
    const offset = Math.trunc(Number(c.req.query('offset') ?? 0));
    return c.json({ ok: true, operations: listFabricOperationViews({ limit, offset }) });
  }));

  route.get('/device-fabric/operations/:id', handle(c => c.json({ ok: true, operation: getFabricOperationView(c.req.param('id')) })));

  route.post('/device-fabric/devices/:id/rassilon/probe', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    return c.json({ ok: true, device: await probeRassilonWorker(c.req.param('id'), routing) });
  }));

  route.all('/device-fabric/*', c => c.json({ ok: false, error: 'route_not_found' }, 404));

  return route;
}
