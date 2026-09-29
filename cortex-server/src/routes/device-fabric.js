/**
 * DEVICE FABRIC local API — Phase 2 inventory/linking + Phase 3 safe
 * RASSILON routing.
 *
 * Control plane only: the same loopback + Host + Origin guard as
 * routes/omega.js and routes/rassilon.js. It is never mounted on the
 * RASSILON LAN listener and accepts no OMEGA/RASSILON session material.
 *
 * RASSILON keeps its closed semantic route; OMEGA V2 adds named VIEW,
 * INTERACTIVE (Phase 4: requires an already-active VIEW) and ADMIN
 * (Phase 5: closed 9-action semantic allowlist, own session) primitives,
 * plus Fabric-scoped STOP DEVICE / STOP ALL. VIEW/INTERACTIVE and ADMIN use
 * deliberately separate sessions (`.../session/stop` vs `.../stop`) since
 * OMEGA V2 sessions are permission-locked at connect time. There is no
 * generic /execute, /run, /command, /shell, /tool, /rpc, /action or
 * /dispatch surface, and GET endpoints never route or execute anything.
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
import {
  DeviceFabricOmegaV2Error, getOmegaV2LinkView, linkOmegaV2Host, listOmegaV2HostsForFabric, unlinkOmegaV2Host,
} from '../lib/device-fabric-omega-v2.js';
import {
  DeviceFabricOmegaV2ViewError, getInteractiveStateForFabricDevice, getViewStateForFabricDevice,
  startInteractiveForFabricDevice, startViewForFabricDevice, stopInteractiveForFabricDevice,
  stopSessionForFabricDevice, stopViewForFabricDevice,
} from '../lib/device-fabric-omega-v2-routing.js';
import {
  DeviceFabricOmegaV2AdminError, cancelOperationForFabricDevice, getAdminStateForFabricDevice,
  getDiskStatusForFabricDevice, getNetworkStatusForFabricDevice, getServiceStatusForFabricDevice,
  getSystemInfoForFabricDevice, listProcessesForFabricDevice, lockFabricDevice, logoffFabricDevice,
  operationStatusForFabricDevice, restartFabricDevice, shutdownFabricDevice, stopAllForFabricDevices,
  stopDeviceForFabricDevice,
} from '../lib/device-fabric-omega-v2-admin.js';

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
  // Closed VIEW-only injection point for tests. Production uses the exact
  // OMEGA V2 controller functions imported by the dedicated Fabric module.
  omegaV2View = {},
  // Same closed injection pattern for the ADMIN + STOP orchestration module.
  omegaV2Admin = {},
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
      if (error instanceof DeviceFabricOmegaV2Error) return c.json({ ok: false, error: error.code }, error.status);
      if (error instanceof DeviceFabricOmegaV2ViewError) return c.json({ ok: false, error: error.code }, error.status);
      if (error instanceof DeviceFabricOmegaV2AdminError) return c.json({ ok: false, error: error.code }, error.status);
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

  // ── Phase 2 (V2): OMEGA V2 outbound link + read-only status ──────────────
  // These GET handlers never connect, create a session or start VIEW;
  // actions use the separate explicit POST routes below.
  route.get('/device-fabric/omega-v2/hosts', handle(c => c.json({ ok: true, hosts: listOmegaV2HostsForFabric() })));

  route.get('/device-fabric/devices/:id/omega-v2', handle(c => c.json({ ok: true, link: getOmegaV2LinkView(c.req.param('id')) })));

  route.get('/device-fabric/devices/:id/omega-v2/status', handle(c => c.json({ ok: true, link: getOmegaV2LinkView(c.req.param('id')) })));

  route.post('/device-fabric/devices/:id/omega-v2/link', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['omegaV2HostId', 'confirmFingerprint']);
    return c.json({ ok: true, link: linkOmegaV2Host(c.req.param('id'), body) }, 201);
  }));

  route.delete('/device-fabric/devices/:id/omega-v2/link', handle(c => c.json({ ok: true, ...unlinkOmegaV2Host(c.req.param('id')) })));

  // Phase 3: explicit VIEW-only orchestration. Frame bytes deliberately keep
  // using the certified /api/omega/outbound session endpoint; Fabric never
  // copies, stores, signs or re-encodes a frame.
  route.post('/device-fabric/devices/:id/omega-v2/view/start', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['screenIndex', 'linkId', 'linkVersion', 'omegaV2HostId', 'fingerprint']);
    const start = omegaV2View.startViewForFabricDevice ?? startViewForFabricDevice;
    return c.json({ ok: true, view: await start(c.req.param('id'), body) }, 201);
  }));

  route.get('/device-fabric/devices/:id/omega-v2/view/status', handle(c => {
    const status = omegaV2View.getViewStateForFabricDevice ?? getViewStateForFabricDevice;
    return c.json({ ok: true, view: status(c.req.param('id')) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/view/stop', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const stop = omegaV2View.stopViewForFabricDevice ?? stopViewForFabricDevice;
    return c.json({ ok: true, view: await stop(c.req.param('id')) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/session/stop', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const stop = omegaV2View.stopSessionForFabricDevice ?? stopSessionForFabricDevice;
    return c.json({ ok: true, view: await stop(c.req.param('id')) });
  }));

  // Phase 4: explicit INTERACTIVE-only orchestration, requiring an already
  // active VIEW on the same session. Pointer/keyboard/wheel events are never
  // sent through a Fabric route: the browser calls OMEGA V2's own certified
  // /api/omega/outbound/sessions/:id/input/* directly with the sessionId
  // this VIEW/INTERACTIVE state already exposes (mission §12, §13, §32).
  route.post('/device-fabric/devices/:id/omega-v2/interactive/start', handle(async c => {
    const body = onlyFields(await readJsonObject(c), []);
    const start = omegaV2View.startInteractiveForFabricDevice ?? startInteractiveForFabricDevice;
    return c.json({ ok: true, view: await start(c.req.param('id'), body) }, 201);
  }));

  route.get('/device-fabric/devices/:id/omega-v2/interactive/status', handle(c => {
    const status = omegaV2View.getInteractiveStateForFabricDevice ?? getInteractiveStateForFabricDevice;
    return c.json({ ok: true, view: status(c.req.param('id')) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/interactive/stop', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const stop = omegaV2View.stopInteractiveForFabricDevice ?? stopInteractiveForFabricDevice;
    return c.json({ ok: true, view: await stop(c.req.param('id')) });
  }));

  // Phase 5: closed ADMIN semantic allowlist (5 read-only + 4 high-impact)
  // and Fabric controller STOP. Every route is a typed wrapper over OMEGA
  // V2's own certified functions; there is no generic /admin route and no
  // free-form action string anywhere (mission §7, §12, §34).
  route.post('/device-fabric/devices/:id/omega-v2/admin/system-info', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const read = omegaV2Admin.getSystemInfoForFabricDevice ?? getSystemInfoForFabricDevice;
    return c.json({ ok: true, admin: await read(c.req.param('id')) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/processes', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const read = omegaV2Admin.listProcessesForFabricDevice ?? listProcessesForFabricDevice;
    return c.json({ ok: true, admin: await read(c.req.param('id')) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/service-status', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const read = omegaV2Admin.getServiceStatusForFabricDevice ?? getServiceStatusForFabricDevice;
    return c.json({ ok: true, admin: await read(c.req.param('id')) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/network-status', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const read = omegaV2Admin.getNetworkStatusForFabricDevice ?? getNetworkStatusForFabricDevice;
    return c.json({ ok: true, admin: await read(c.req.param('id')) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/disk-status', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const read = omegaV2Admin.getDiskStatusForFabricDevice ?? getDiskStatusForFabricDevice;
    return c.json({ ok: true, admin: await read(c.req.param('id')) });
  }));

  route.get('/device-fabric/devices/:id/omega-v2/admin/status', handle(c => {
    const status = omegaV2Admin.getAdminStateForFabricDevice ?? getAdminStateForFabricDevice;
    return c.json({ ok: true, admin: status(c.req.param('id')) });
  }));

  // Each high-impact route requires the exact typed confirmation naming the
  // action (mirrors OMEGA V2's own local route guard); this confirms only
  // that Fabric should ask OMEGA — it never substitutes for the remote
  // device's own local approval (mission §9, §19).
  route.post('/device-fabric/devices/:id/omega-v2/admin/lock', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['confirm']);
    const start = omegaV2Admin.lockFabricDevice ?? lockFabricDevice;
    return c.json({ ok: true, admin: await start(c.req.param('id'), body) }, 202);
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/logoff', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['confirm']);
    const start = omegaV2Admin.logoffFabricDevice ?? logoffFabricDevice;
    return c.json({ ok: true, admin: await start(c.req.param('id'), body) }, 202);
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/restart', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['confirm']);
    const start = omegaV2Admin.restartFabricDevice ?? restartFabricDevice;
    return c.json({ ok: true, admin: await start(c.req.param('id'), body) }, 202);
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/shutdown', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['confirm']);
    const start = omegaV2Admin.shutdownFabricDevice ?? shutdownFabricDevice;
    return c.json({ ok: true, admin: await start(c.req.param('id'), body) }, 202);
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/operations/status', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['operationId']);
    const status = omegaV2Admin.operationStatusForFabricDevice ?? operationStatusForFabricDevice;
    return c.json({ ok: true, admin: await status(c.req.param('id'), body) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/admin/operations/cancel', handle(async c => {
    const body = onlyFields(await readJsonObject(c), ['operationId']);
    const cancel = omegaV2Admin.cancelOperationForFabricDevice ?? cancelOperationForFabricDevice;
    return c.json({ ok: true, admin: await cancel(c.req.param('id'), body) });
  }));

  route.post('/device-fabric/devices/:id/omega-v2/stop', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const stop = omegaV2Admin.stopDeviceForFabricDevice ?? stopDeviceForFabricDevice;
    return c.json({ ok: true, ...(await stop(c.req.param('id'))) });
  }));

  // Fabric-scoped only: iterates Fabric's own known ADMIN bindings, never
  // the global OMEGA V2 stop-all (mission §27, §30, §31).
  route.post('/device-fabric/omega-v2/stop-all', handle(async c => {
    onlyFields(await readJsonObject(c), []);
    const stopAll = omegaV2Admin.stopAllForFabricDevices ?? stopAllForFabricDevices;
    return c.json({ ok: true, results: await stopAll() });
  }));

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
