// DEVICE FABRIC Phase 2 — browser test of the real Devices tab against a
// stateful mocked /api/device-fabric. Phase 3 adds the closed VIEW-only path.
// Run with: node scripts/test-device-fabric-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

let browser;
let server;
let assertions = 0;
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const now = new Date().toISOString();
const harnessHtml = '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;const {mount}=await import("/scripts/device-fabric-harness.jsx");mount();</script>';
const watchdog = setTimeout(() => {
  console.error('DEVICE FABRIC browser deadline');
  void browser?.close();
  void server?.close();
  process.exitCode = 1;
}, 90_000);

const XSS_IMG = '<img src=x onerror="window.__xssFired=true">';
const FP = {
  omega: 'a1'.repeat(32), omegaLinked: 'b2'.repeat(32), omegaRevoked: 'c3'.repeat(32),
  worker: 'd4'.repeat(32), shared: 'e5'.repeat(32), omegaV2: 'f6'.repeat(32), omegaV2Cert: '17'.repeat(32),
  omegaV2Changed: '28'.repeat(32), omegaV2Revoked: '39'.repeat(32),
};
const cap = (name, supported, authorized, available) => ({ name, supported, authorized, available, routable: false });

const agents = {
  OMEGA: [
    { agentType: 'OMEGA', agentDeviceId: 'omega-laptop', displayName: XSS_IMG, fingerprint: FP.omega, role: 'OMEGA_CLIENT', trust: 'TRUSTED', revokedAt: null, lastSessionAt: now, permissionLevel: 2, linkedFabricDeviceId: null },
    { agentType: 'OMEGA', agentDeviceId: 'omega-elsewhere', displayName: 'Déjà lié', fingerprint: FP.omegaLinked, role: 'OMEGA_CLIENT', trust: 'TRUSTED', revokedAt: null, lastSessionAt: null, permissionLevel: 1, linkedFabricDeviceId: 'fdev-00000000-0000-4000-8000-000000000999' },
    { agentType: 'OMEGA', agentDeviceId: 'omega-revoked', displayName: 'Révoqué', fingerprint: FP.omegaRevoked, role: 'OMEGA_CLIENT', trust: 'REVOKED', revokedAt: now, lastSessionAt: null, permissionLevel: 3, linkedFabricDeviceId: null },
  ],
  RASSILON: [
    { agentType: 'RASSILON', agentDeviceId: 'rassilon-shared-key', displayName: 'Clé partagée', fingerprint: FP.shared, role: 'RASSILON_WORKER', trust: 'TRUSTED', revokedAt: null, lastSeenAt: null, linkedFabricDeviceId: null },
    { agentType: 'RASSILON', agentDeviceId: 'rassilon-gpu', displayName: 'GPU box', fingerprint: FP.worker, role: 'RASSILON_WORKER', trust: 'TRUSTED', revokedAt: null, lastSeenAt: now, linkedFabricDeviceId: null },
  ],
};

const devices = [];
const events = [];
const omegaV2Trusts = [
  {
    omegaV2HostId: 'ov2h-00000000-0000-4000-8000-000000000001', host: XSS_IMG, port: 9443,
    identityFingerprint: FP.omegaV2, certificateFingerprint: FP.omegaV2Cert,
    maxPermission: 'ADMIN', createdAt: now, revokedAt: null,
  },
  {
    omegaV2HostId: 'ov2h-00000000-0000-4000-8000-000000000002', host: 'revoked.example', port: 9443,
    identityFingerprint: FP.omegaV2Revoked, certificateFingerprint: '4a'.repeat(32),
    maxPermission: 'ADMIN', createdAt: now, revokedAt: now,
  },
];
// A second, always-available host added only right before the exact-target
// proof (never present during the earlier single-host dialog assertions): a
// Fabric device linked to A must never cause any event on B, and vice versa.
const OMEGA_V2_HOST_B = {
  omegaV2HostId: 'ov2h-00000000-0000-4000-8000-000000000003', host: 'second-host.example', port: 9443,
  identityFingerprint: '5c'.repeat(32), certificateFingerprint: '6d'.repeat(32),
  maxPermission: 'ADMIN', createdAt: now, revokedAt: null,
};
const omegaV2Links = new Map();
let omegaV2LinkState = 'OK';
let omegaV2SessionPermission = null;
let omegaViewState = null;
let omegaFrameFailure = null;
let omegaInteractiveDenied = false;
// Phase 5 ADMIN mock state. High-impact actions always answer
// PENDING_APPROVAL first (never execute inline); the test flips
// omegaAdminOutcome then advances the poll to make the *next*
// operations/status poll resolve to EXECUTED or DENIED, mirroring the real
// remote device's own local approval being asynchronous and out of band.
let omegaAdminSessionId = 'fabric-admin-session-1';
let omegaAdminDisabledReason = null; // set once STOP DEVICE has fired
const omegaAdminOperations = new Map(); // operationId -> { actionType, status, error }
let omegaAdminOutcome = 'APPROVE'; // 'APPROVE' | 'DENY', consulted the next time a pending op is polled
let apiDown = false;
let rassilonRevoked = false;
let safeCpuAuthorized = false;
let nextRouteRejection = null;
const operations = [];
const calls = {
  create: 0, rename: 0, link: [], unlink: [], remove: [], route: [], probe: 0, devicesGets: 0, routeAttempts: 0,
  omegaV2HostsGets: 0, omegaV2StatusGets: 0, omegaV2Link: [], omegaV2Unlink: [],
  omegaViewStart: [], omegaViewStatus: 0, omegaViewStop: 0, omegaSessionStop: 0,
  omegaFrames: 0, omegaInputs: 0, fileTransfers: 0,
  omegaInteractiveStart: [], omegaInteractiveStatus: 0, omegaInteractiveStop: 0,
  omegaAdminReads: [], omegaAdminHighImpact: [], omegaAdminOperationStatusPolls: 0,
  omegaAdminOperationCancel: 0, omegaAdminStopDevice: 0, omegaAdminStopAll: 0,
};
// sessionId -> { omegaV2HostId, events: [{category, payload}] }. Lets the
// exact-target test prove input reaches only the session's own OMEGA host,
// never a second one, without needing per-device global state everywhere.
const omegaSessions = new Map();
let internalError = false;
let abortNextRoute = false;

let presenceAgeMs = 1_000;
let sessionState = 'VALID';
let agentProjectionError = false;

function omegaLink() {
  const identity = agents.OMEGA[0];
  return {
    agentType: 'OMEGA', agentDeviceId: identity.agentDeviceId, linkedFingerprint: identity.fingerprint, linkedAt: now, linkState: 'OK',
    trust: 'TRUSTED', availability: 'UNKNOWN', routable: false, routingStatus: 'NOT_ROUTABLE', routingReason: 'omega_outbound_client_not_implemented', identity,
    directions: [{ direction: 'REMOTE_ACTS_ON_THIS_PC', capabilities: [cap('OMEGA_VIEW', 'YES', 'YES', 'UNKNOWN'), cap('OMEGA_INTERACTIVE', 'YES', 'YES', 'UNKNOWN'), cap('OMEGA_ADMIN', 'YES', 'NO', 'UNKNOWN')] }],
  };
}

function omegaV2HostsView() {
  return omegaV2Trusts.map(trust => ({
    ...trust,
    linkedFabricDeviceId: [...omegaV2Links.entries()].find(([, hostId]) => hostId === trust.omegaV2HostId)?.[0] ?? null,
  }));
}

function omegaV2Status(fabricDeviceId) {
  const omegaV2HostId = omegaV2Links.get(fabricDeviceId);
  if (!omegaV2HostId) return null;
  const originalTrust = omegaV2Trusts.find(trust => trust.omegaV2HostId === omegaV2HostId) ?? null;
  const base = {
    linkId: 'flnk-00000000-0000-4000-8000-000000000001', omegaV2HostId,
    linkedFingerprint: FP.omegaV2, linkVersion: 1, linkedAt: now,
  };
  if (omegaV2LinkState === 'MISSING') return { ...base, linkState: 'MISSING', trust: null, availability: 'UNKNOWN', capabilities: [] };
  const trust = originalTrust ? {
    ...originalTrust,
    identityFingerprint: omegaV2LinkState === 'FINGERPRINT_MISMATCH' ? FP.omegaV2Changed : originalTrust.identityFingerprint,
    revokedAt: omegaV2LinkState === 'REVOKED' ? now : originalTrust.revokedAt,
  } : null;
  if (omegaV2LinkState === 'FINGERPRINT_MISMATCH') return { ...base, linkState: omegaV2LinkState, trust, availability: 'UNKNOWN', capabilities: [] };
  if (omegaV2LinkState === 'REVOKED') return { ...base, linkState: omegaV2LinkState, trust, availability: 'UNAVAILABLE', capabilities: [] };
  const rank = { VIEW: 1, INTERACTIVE: 2, ADMIN: 3 };
  const capabilities = ['VIEW', 'INTERACTIVE', 'ADMIN'].map(name => ({
    name,
    supported: 'YES',
    authorized: rank[name] <= rank[trust.maxPermission] ? 'YES' : 'NO',
    available: omegaV2SessionPermission === null ? 'UNKNOWN' : rank[name] <= rank[omegaV2SessionPermission] ? 'YES' : 'NO',
  }));
  return {
    ...base, linkState: 'OK', trust,
    availability: omegaV2SessionPermission === null ? 'UNKNOWN' : 'AVAILABLE', capabilities,
    session: omegaV2SessionPermission === null ? null : { permission: omegaV2SessionPermission, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
}

// Mirrors the server view: presence VERIFIED only inside the 30 s window,
// session state, routable only when all three capability values are YES.
function rassilonLink() {
  const identity = { ...agents.RASSILON[1], trust: rassilonRevoked ? 'REVOKED' : 'TRUSTED' };
  if (agentProjectionError) {
    return {
      agentType: 'RASSILON', agentDeviceId: identity.agentDeviceId, linkedFingerprint: identity.fingerprint, linkedAt: now, linkState: 'AGENT_ERROR',
      trust: 'UNKNOWN', availability: 'ERROR', routable: false, routingStatus: 'NOT_AVAILABLE', routingReason: 'agent_projection_error', identity: null, directions: [],
    };
  }
  const expired = sessionState === 'EXPIRED';
  const presenceState = rassilonRevoked ? 'REVOKED' : presenceAgeMs <= 30_000 ? 'VERIFIED' : presenceAgeMs <= 90_000 ? 'STALE' : 'NOT_VERIFIED';
  const availability = rassilonRevoked || expired ? 'UNAVAILABLE' : presenceState === 'VERIFIED' ? 'AVAILABLE' : 'UNKNOWN';
  const value = authorized => (availability === 'UNAVAILABLE' || !authorized ? 'NO' : availability === 'AVAILABLE' ? 'YES' : 'UNKNOWN');
  const capability = (name, authorized) => {
    const a = rassilonRevoked || !authorized ? 'NO' : 'YES';
    const v = value(authorized && !rassilonRevoked);
    return { ...cap(name, 'YES', a, v), routable: a === 'YES' && v === 'YES' };
  };
  const capabilities = [capability('SAFE_CPU_TASK', safeCpuAuthorized), capability('EMBEDDING_BATCH', true)];
  const routable = capabilities.some(c => c.routable);
  const routingReason = routable ? null : rassilonRevoked ? 'rassilon_identity_revoked' : expired ? 'session_expired' : presenceState !== 'VERIFIED' ? 'presence_not_verified' : 'capability_not_authorized';
  return {
    agentType: 'RASSILON', agentDeviceId: identity.agentDeviceId, linkedFingerprint: identity.fingerprint, linkedAt: now, linkState: 'OK',
    trust: identity.trust, availability, routable, routingStatus: routable ? 'READY' : 'NOT_AVAILABLE', routingReason, identity,
    directions: [{
      direction: 'THIS_PC_SENDS_COMPUTE', availability, capabilities,
      presence: { state: presenceState, lastVerifiedAt: new Date(Date.now() - presenceAgeMs).toISOString(), ageMs: presenceAgeMs, freshnessWindowMs: 30_000 },
      session: expired ? { state: 'EXPIRED', expiresAt: now, expiresInMs: 0 } : { state: sessionState, expiresAt: new Date(Date.now() + 600_000).toISOString(), expiresInMs: 600_000 },
    }],
  };
}

// Phase 5 ADMIN read-only fake results. Small, obviously-fake data; one
// field per action carries XSS_IMG to prove the panel renders it inert
// (process name / service name / disk label / network interface name).
function omegaAdminReadResult(fabricDeviceId, actionType) {
  const omegaV2HostId = omegaV2Links.get(fabricDeviceId);
  const base = { fabricDeviceId, omegaV2HostId, sessionId: omegaAdminSessionId, status: 'EXECUTED', actionType, error: null };
  const result = {
    GET_SYSTEM_INFO: { system: { computerName: 'MOCK-PC', osVersion: 'MockOS 1.0', uptimeSeconds: '3600' } },
    PROCESS_LIST: { processes: [{ pid: 111, name: XSS_IMG, memoryBytes: 1024, cpuSeconds: 1 }, { pid: 222, name: 'mock.exe', memoryBytes: 2048, cpuSeconds: 2 }], truncated: false },
    SERVICE_STATUS: { services: [{ name: 'mocksvc', displayName: XSS_IMG, state: 'RUNNING', startMode: 'AUTO' }], truncated: false },
    NETWORK_STATUS: { interfaces: [{ description: XSS_IMG, dhcpEnabled: true, addresses: ['10.0.0.5'], gateways: ['10.0.0.1'], dnsServers: ['10.0.0.1'] }] },
    DISK_STATUS: { disks: [{ drive: 'C:', filesystem: 'NTFS', totalBytes: 1000, freeBytes: 500 }, { drive: XSS_IMG, filesystem: 'NTFS', totalBytes: 1, freeBytes: 1 }] },
  }[actionType];
  return { ...base, result };
}

function newOperation(fabricDeviceId, actionType, status, extra = {}) {
  const op = {
    operationId: `fop-00000000-0000-4000-8000-00000000000${operations.length + 1}`, correlationId: `fcor-00000000-0000-4000-8000-00000000000${operations.length + 1}`,
    fabricDeviceId, agentType: 'RASSILON', agentDeviceId: 'rassilon-gpu', actionType, jobType: actionType === 'RASSILON_SAFE_CPU' ? 'SAFE_CPU_TASK' : 'EMBEDDING_BATCH',
    agentOperationId: status === 'NOT_AVAILABLE' ? null : `job-${operations.length + 1}`, status, inputSummary: {}, resultSummary: null, safeError: null,
    createdAt: now, startedAt: now, completedAt: null, updatedAt: now, pollsLeft: 1, ...extra,
  };
  operations.unshift(op);
  return op;
}

function operationsView() {
  for (const op of operations) {
    if (op.status !== 'RUNNING') continue;
    if (op.pollsLeft > 0) { op.pollsLeft -= 1; continue; }
    op.status = 'COMPLETED';
    op.completedAt = new Date(Date.parse(now) + 42).toISOString();
    op.resultSummary = op.jobType === 'SAFE_CPU_TASK'
      ? { kind: 'HASH_BUFFER', algorithm: 'sha256', inputBytes: 26, digest: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12' }
      : { kind: 'EMBEDDING_BATCH', model: '<script>window.__xssFired=true</script>', vectorCount: 2, dimensions: 768, durationMs: 12 };
  }
  return operations.map(({ pollsLeft: _p, ...op }) => op);
}

function stateOf(device) {
  const links = Object.values(device.agents).filter(Boolean).map(link => link.availability);
  if (links.length === 0) return 'UNKNOWN';
  const available = links.filter(a => a === 'AVAILABLE').length;
  if (available === links.length) return 'ONLINE';
  if (available > 0) return 'PARTIAL';
  if (links.every(a => a === 'UNAVAILABLE')) return 'OFFLINE';
  return 'UNKNOWN';
}

function view(device) {
  const agentsView = { OMEGA: device.links.OMEGA ? omegaLink() : null, RASSILON: device.links.RASSILON ? rassilonLink() : null };
  const out = { fabricDeviceId: device.fabricDeviceId, displayName: device.displayName, createdAt: now, updatedAt: now, agents: agentsView };
  return { ...out, state: stateOf(out) };
}

function agentsView() {
  const linked = new Map();
  for (const device of devices) for (const [type, id] of Object.entries(device.links)) if (id) linked.set(`${type}:${id}`, device.fabricDeviceId);
  const withLinks = list => list.map(identity => ({ ...identity, linkedFabricDeviceId: identity.linkedFabricDeviceId ?? linked.get(`${identity.agentType}:${identity.agentDeviceId}`) ?? null }));
  return { OMEGA: withLinks(agents.OMEGA), RASSILON: withLinks(agents.RASSILON) };
}

try {
  server = await createServer({
    configFile: false,
    cacheDir: '.tmp/vite-device-fabric',
    plugins: [react()],
    optimizeDeps: { entries: ['scripts/device-fabric-harness.jsx'] },
    server: { watch: null, host: '127.0.0.1', port: 5219, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => { window.__xssFired = undefined; });

  await page.route('**/api/device-fabric/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace('/api/device-fabric', '');
    const method = request.method();
    let status = 200;
    let body;
    const match = pathname.match(/^\/devices\/(fdev-[^/]+)(?:\/link(?:\/(OMEGA|RASSILON))?)?$/);
    const device = match ? devices.find(d => d.fabricDeviceId === match[1]) : null;
    const omegaV2Match = pathname.match(/^\/devices\/(fdev-[^/]+)\/omega-v2\/(status|link)$/);
    const omegaV2Device = omegaV2Match ? devices.find(d => d.fabricDeviceId === omegaV2Match[1]) : null;
    const omegaViewMatch = pathname.match(/^\/devices\/(fdev-[^/]+)\/omega-v2\/(?:(view)\/(start|status|stop)|(interactive)\/(start|status|stop)|(session)\/(stop))$/);
    const omegaViewDevice = omegaViewMatch ? devices.find(d => d.fabricDeviceId === omegaViewMatch[1]) : null;
    const omegaViewKind = omegaViewMatch ? (omegaViewMatch[2] ?? omegaViewMatch[4] ?? omegaViewMatch[6]) : null;
    const omegaViewAction = omegaViewMatch ? (omegaViewMatch[3] ?? omegaViewMatch[5] ?? omegaViewMatch[7]) : null;
    // Phase 5 ADMIN: 5 read-only + 4 high-impact + operations status/cancel,
    // all POST under /admin/*, plus the Fabric-scoped STOP (/omega-v2/stop,
    // no /admin/ segment — matches the real route file exactly).
    const omegaAdminMatch = pathname.match(/^\/devices\/(fdev-[^/]+)\/omega-v2\/admin\/(system-info|processes|service-status|network-status|disk-status|status|lock|logoff|restart|shutdown|operations\/status|operations\/cancel)$/);
    const omegaAdminDevice = omegaAdminMatch ? devices.find(d => d.fabricDeviceId === omegaAdminMatch[1]) : null;
    const omegaAdminAction = omegaAdminMatch ? omegaAdminMatch[2] : null;
    const omegaAdminStopMatch = pathname.match(/^\/devices\/(fdev-[^/]+)\/omega-v2\/stop$/);
    const omegaAdminStopDevice = omegaAdminStopMatch ? devices.find(d => d.fabricDeviceId === omegaAdminStopMatch[1]) : null;

    if (pathname === '/devices' && method === 'GET') calls.devicesGets += 1;
    if (pathname === '/omega-v2/hosts' && method === 'GET') calls.omegaV2HostsGets += 1;
    if (omegaV2Match?.[2] === 'status' && method === 'GET') calls.omegaV2StatusGets += 1;
    if (pathname === '/route' && method === 'POST') {
      calls.routeAttempts += 1;
      if (abortNextRoute) { abortNextRoute = false; await route.abort('failed'); return; }
    }

    if (apiDown) { status = 503; body = { ok: false, error: `<b>down</b>${XSS_IMG}` }; }
    else if (internalError && pathname === '/devices' && method === 'GET') { status = 500; body = { ok: false, error: 'internal_error' }; }
    else if (pathname === '/devices' && method === 'GET') body = { ok: true, devices: devices.map(view) };
    else if (pathname === '/agents') body = { ok: true, agents: agentsView(), agentErrors: agentProjectionError ? { RASSILON: 'agent_projection_error' } : {} };
    else if (pathname === '/audit') body = { ok: true, events };
    else if (pathname === '/operations' && method === 'GET') body = { ok: true, operations: operationsView() };
    else if (pathname === '/omega-v2/hosts' && method === 'GET') body = { ok: true, hosts: omegaV2HostsView() };
    else if (omegaViewDevice && omegaViewKind === 'view' && omegaViewAction === 'start' && method === 'POST') {
      const payload = request.postDataJSON();
      calls.omegaViewStart.push({ fabricDeviceId: omegaViewDevice.fabricDeviceId, ...payload });
      const current = omegaV2Status(omegaViewDevice.fabricDeviceId);
      if (!current) { status = 409; body = { ok: false, error: 'OMEGA_V2_NOT_LINKED' }; }
      else if (current.linkState === 'REVOKED') { status = 409; body = { ok: false, error: 'OMEGA_V2_REVOKED' }; }
      else if (current.linkState !== 'OK') { status = 409; body = { ok: false, error: 'OMEGA_V2_LINK_STALE' }; }
      else if (payload.linkId !== current.linkId || payload.linkVersion !== current.linkVersion
        || payload.omegaV2HostId !== current.omegaV2HostId || payload.fingerprint !== current.linkedFingerprint) {
        status = 409; body = { ok: false, error: 'OMEGA_V2_LINK_CHANGED' };
      } else {
        omegaV2SessionPermission = 'VIEW';
        const sessionId = `fabric-view-session-${omegaSessions.size + 1}`;
        omegaSessions.set(sessionId, { omegaV2HostId: current.omegaV2HostId, events: [] });
        omegaViewState = { fabricDeviceId: omegaViewDevice.fabricDeviceId, omegaV2HostId: current.omegaV2HostId,
          linkId: current.linkId, linkVersion: current.linkVersion, sessionId,
          sessionStatus: 'CONNECTED', sessionReason: null, viewStatus: 'VIEWING', streamId: 'fabric-stream-1',
          screenIndex: payload.screenIndex, interactiveStatus: 'STOPPED', linkChanged: false };
        status = 201; body = { ok: true, view: omegaViewState };
      }
    }
    else if (omegaViewDevice && omegaViewKind === 'view' && omegaViewAction === 'status' && method === 'GET') {
      calls.omegaViewStatus += 1;
      body = { ok: true, view: omegaViewState ?? { fabricDeviceId: omegaViewDevice.fabricDeviceId,
        omegaV2HostId: omegaV2Links.get(omegaViewDevice.fabricDeviceId) ?? null, linkId: null, linkVersion: null,
        sessionId: null, sessionStatus: 'DISCONNECTED', sessionReason: null, viewStatus: 'STOPPED',
        streamId: null, screenIndex: null, interactiveStatus: 'STOPPED', linkChanged: false } };
    }
    else if (omegaViewDevice && omegaViewKind === 'view' && omegaViewAction === 'stop' && method === 'POST') {
      calls.omegaViewStop += 1;
      // OMEGA V2's own certified stopOmegaOutboundView already stops
      // INTERACTIVE internally whenever VIEW stops (mission §2: "STOP VIEW →
      // INTERACTIVE arrêté") — mirrored here, not decided by Fabric.
      omegaViewState = { ...omegaViewState, viewStatus: 'STOPPED', streamId: null, interactiveStatus: 'STOPPED' };
      body = { ok: true, view: omegaViewState };
    }
    else if (omegaViewDevice && omegaViewKind === 'session' && method === 'POST') {
      calls.omegaSessionStop += 1;
      omegaV2SessionPermission = null;
      omegaViewState = { ...omegaViewState, viewStatus: 'STOPPED', streamId: null, interactiveStatus: 'STOPPED',
        sessionStatus: 'DISCONNECTED', sessionReason: 'client_stop' };
      body = { ok: true, view: omegaViewState };
    }
    else if (omegaViewDevice && omegaViewKind === 'interactive' && omegaViewAction === 'start' && method === 'POST') {
      // Mirrors the real route's onlyFields(body, []) — INTERACTIVE start
      // takes no fields at all (mission: closed request schema).
      const interactiveBody = request.postDataJSON();
      if (interactiveBody && typeof interactiveBody === 'object' && Object.keys(interactiveBody).length > 0) {
        status = 400; body = { ok: false, error: 'unknown_field' };
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        return;
      }
      calls.omegaInteractiveStart.push(omegaViewDevice.fabricDeviceId);
      if (!omegaViewState || omegaViewState.fabricDeviceId !== omegaViewDevice.fabricDeviceId || omegaViewState.viewStatus === 'STOPPED') {
        status = 409; body = { ok: false, error: 'OMEGA_V2_VIEW_NOT_ACTIVE' };
      } else if (omegaInteractiveDenied) {
        status = 409; body = { ok: false, error: 'OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED' };
      } else {
        omegaViewState = { ...omegaViewState, interactiveStatus: 'INTERACTIVE' };
        status = 201; body = { ok: true, view: omegaViewState };
      }
    }
    else if (omegaViewDevice && omegaViewKind === 'interactive' && omegaViewAction === 'status' && method === 'GET') {
      calls.omegaInteractiveStatus += 1;
      body = { ok: true, view: omegaViewState ?? { fabricDeviceId: omegaViewDevice.fabricDeviceId,
        omegaV2HostId: omegaV2Links.get(omegaViewDevice.fabricDeviceId) ?? null, linkId: null, linkVersion: null,
        sessionId: null, sessionStatus: 'DISCONNECTED', sessionReason: null, viewStatus: 'STOPPED',
        streamId: null, screenIndex: null, interactiveStatus: 'STOPPED', linkChanged: false } };
    }
    else if (omegaViewDevice && omegaViewKind === 'interactive' && omegaViewAction === 'stop' && method === 'POST') {
      calls.omegaInteractiveStop += 1;
      omegaViewState = omegaViewState ? { ...omegaViewState, interactiveStatus: 'STOPPED' } : omegaViewState;
      body = { ok: true, view: omegaViewState };
    }
    // Phase 5 ADMIN: 5 read-only actions execute inline (mirrors OMEGA V2's
    // own certified read-only semantics — no local approval needed); the 4
    // high-impact actions always start PENDING_APPROVAL and only settle once
    // the test flips omegaAdminOutcome and polls operations/status, exactly
    // mirroring the remote device's own out-of-band local approval.
    else if (omegaAdminDevice && omegaAdminAction && ['system-info', 'processes', 'service-status', 'network-status', 'disk-status'].includes(omegaAdminAction) && method === 'POST') {
      if (omegaAdminDisabledReason) { status = 409; body = { ok: false, error: omegaAdminDisabledReason }; }
      else {
        const actionType = { 'system-info': 'GET_SYSTEM_INFO', processes: 'PROCESS_LIST', 'service-status': 'SERVICE_STATUS', 'network-status': 'NETWORK_STATUS', 'disk-status': 'DISK_STATUS' }[omegaAdminAction];
        calls.omegaAdminReads.push({ fabricDeviceId: omegaAdminDevice.fabricDeviceId, actionType });
        body = { ok: true, admin: omegaAdminReadResult(omegaAdminDevice.fabricDeviceId, actionType) };
      }
    }
    else if (omegaAdminDevice && ['lock', 'logoff', 'restart', 'shutdown'].includes(omegaAdminAction) && method === 'POST') {
      const payload = request.postDataJSON();
      const actionType = omegaAdminAction.toUpperCase();
      if (omegaAdminDisabledReason) { status = 409; body = { ok: false, error: omegaAdminDisabledReason }; }
      else if (payload?.confirm !== actionType) { status = 400; body = { ok: false, error: 'confirm_mismatch' }; }
      else {
        calls.omegaAdminHighImpact.push({ fabricDeviceId: omegaAdminDevice.fabricDeviceId, actionType });
        const operationId = `fadm-op-${omegaAdminOperations.size + 1}`;
        const op = { fabricDeviceId: omegaAdminDevice.fabricDeviceId, omegaV2HostId: omegaV2Links.get(omegaAdminDevice.fabricDeviceId), sessionId: omegaAdminSessionId, operationId, actionType, status: 'PENDING_APPROVAL', error: null };
        omegaAdminOperations.set(operationId, op);
        status = 202; body = { ok: true, admin: op };
      }
    }
    else if (omegaAdminDevice && omegaAdminAction === 'operations/status' && method === 'POST') {
      calls.omegaAdminOperationStatusPolls += 1;
      const { operationId } = request.postDataJSON();
      const op = omegaAdminOperations.get(operationId);
      if (!op) { status = 404; body = { ok: false, error: 'operation_not_found' }; }
      else {
        if (op.status === 'PENDING_APPROVAL' && omegaAdminOutcome === 'APPROVE') { op.status = 'EXECUTED'; op.result = { executedFake: true }; }
        else if (op.status === 'PENDING_APPROVAL' && omegaAdminOutcome === 'DENY') { op.status = 'DENIED'; op.error = 'OMEGA_V2_ADMIN_DENIED_BY_REMOTE'; }
        body = { ok: true, admin: op };
      }
    }
    else if (omegaAdminDevice && omegaAdminAction === 'operations/cancel' && method === 'POST') {
      calls.omegaAdminOperationCancel += 1;
      const { operationId } = request.postDataJSON();
      const op = omegaAdminOperations.get(operationId);
      if (!op) { status = 404; body = { ok: false, error: 'operation_not_found' }; }
      else { op.status = 'CANCELLED'; body = { ok: true, admin: op }; }
    }
    else if (omegaAdminDevice && omegaAdminAction === 'status' && method === 'GET') {
      body = { ok: true, admin: { fabricDeviceId: omegaAdminDevice.fabricDeviceId, omegaV2HostId: omegaV2Links.get(omegaAdminDevice.fabricDeviceId) ?? null, sessionId: omegaAdminDisabledReason ? null : omegaAdminSessionId, sessionStatus: omegaAdminDisabledReason ? 'DISCONNECTED' : 'CONNECTED', linkChanged: false } };
    }
    else if (omegaAdminStopDevice && method === 'POST') {
      calls.omegaAdminStopDevice += 1;
      omegaAdminDisabledReason = 'OMEGA_V2_SESSION_EXPIRED';
      body = { ok: true, fabricDeviceId: omegaAdminStopDevice.fabricDeviceId, sessionId: omegaAdminSessionId, stopped: true };
    }
    else if (pathname === '/omega-v2/stop-all' && method === 'POST') {
      calls.omegaAdminStopAll += 1;
      omegaAdminDisabledReason = 'OMEGA_V2_SESSION_EXPIRED';
      body = { ok: true, results: devices.map(d => ({ fabricDeviceId: d.fabricDeviceId, sessionId: omegaAdminSessionId, stopped: true })) };
    }
    else if (omegaV2Device && omegaV2Match[2] === 'status' && method === 'GET') body = { ok: true, link: omegaV2Status(omegaV2Device.fabricDeviceId) };
    else if (omegaV2Device && omegaV2Match[2] === 'link' && method === 'POST') {
      const payload = request.postDataJSON();
      calls.omegaV2Link.push(payload);
      const trust = omegaV2Trusts.find(item => item.omegaV2HostId === payload.omegaV2HostId);
      if (!trust) { status = 404; body = { ok: false, error: 'omega_v2_host_not_found' }; }
      else if (trust.revokedAt) { status = 409; body = { ok: false, error: 'omega_v2_host_revoked' }; }
      else if (payload.confirmFingerprint !== trust.identityFingerprint) { status = 409; body = { ok: false, error: 'fingerprint_confirmation_mismatch' }; }
      else {
        omegaV2Links.set(omegaV2Device.fabricDeviceId, trust.omegaV2HostId);
        omegaV2LinkState = 'OK'; omegaV2SessionPermission = null;
        status = 201; body = { ok: true, link: omegaV2Status(omegaV2Device.fabricDeviceId) };
      }
    }
    else if (omegaV2Device && omegaV2Match[2] === 'link' && method === 'DELETE') {
      calls.omegaV2Unlink.push(omegaV2Device.fabricDeviceId);
      omegaV2Links.delete(omegaV2Device.fabricDeviceId);
      body = { ok: true, unlinked: true };
    }
    else if (pathname === '/route' && method === 'POST') {
      const payload = request.postDataJSON();
      calls.route.push(payload);
      if (nextRouteRejection) {
        const op = newOperation(payload.fabricDeviceId, payload.actionType, 'NOT_AVAILABLE', { safeError: nextRouteRejection, completedAt: now });
        status = 409; body = { ok: false, error: nextRouteRejection, operation: op };
        nextRouteRejection = null;
      } else {
        status = 202; body = { ok: true, operation: newOperation(payload.fabricDeviceId, payload.actionType, 'RUNNING') };
      }
    } else if (/^\/devices\/fdev-[^/]+\/rassilon\/probe$/.test(pathname) && method === 'POST') {
      calls.probe += 1;
      body = { ok: true, device: view(devices.find(d => pathname.includes(d.fabricDeviceId))) };
    }
    else if (pathname === '/devices' && method === 'POST') {
      const { displayName } = request.postDataJSON();
      calls.create += 1;
      const created = { fabricDeviceId: `fdev-00000000-0000-4000-8000-00000000000${devices.length + 1}`, displayName, links: { OMEGA: null, RASSILON: null } };
      devices.push(created);
      events.unshift({ id: events.length + 1, createdAt: now, eventType: 'FABRIC_DEVICE_CREATED', fabricDeviceId: created.fabricDeviceId, agentType: null, agentDeviceId: null, reason: null });
      status = 201; body = { ok: true, device: view(created) };
    } else if (device && method === 'PATCH' && !match[2]) {
      calls.rename += 1; device.displayName = request.postDataJSON().displayName; body = { ok: true, device: view(device) };
    } else if (device && method === 'POST' && pathname.endsWith('/link')) {
      const payload = request.postDataJSON();
      calls.link.push(payload);
      if (payload.agentDeviceId === 'rassilon-shared-key') {
        status = 409; body = { ok: false, error: 'cross_agent_key_reuse' };
        events.unshift({ id: events.length + 1, createdAt: now, eventType: 'FABRIC_LINK_REJECTED', fabricDeviceId: device.fabricDeviceId, agentType: 'RASSILON', agentDeviceId: payload.agentDeviceId, reason: 'cross_agent_key_reuse' });
      } else {
        device.links[payload.agentType] = payload.agentDeviceId; body = { ok: true, device: view(device) };
      }
    } else if (device && method === 'DELETE' && match[2]) {
      calls.unlink.push(match[2]); device.links[match[2]] = null; body = { ok: true, device: view(device) };
    } else if (device && method === 'DELETE') {
      calls.remove.push(url.searchParams.get('confirm'));
      omegaV2Links.delete(device.fabricDeviceId);
      devices.splice(devices.indexOf(device), 1); body = { ok: true, removed: true };
    } else { status = 404; body = { ok: false, error: 'route_not_found' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });

  // Frames keep using the certified OMEGA endpoint directly. No Fabric frame
  // endpoint exists. Pointer/keyboard/wheel input also goes straight here
  // (never through a Fabric route) and is recorded per-sessionId so the
  // exact-target test can prove host A receives events and host B receives
  // zero, exactly mirroring the real two-process TLS harness's proof.
  await page.route('**/api/omega/outbound/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (/\/view\/frame$/.test(pathname)) {
      calls.omegaFrames += 1;
      if (omegaFrameFailure) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: omegaFrameFailure }) });
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    const inputMatch = pathname.match(/\/sessions\/([^/]+)\/input\/(pointer|button|wheel|key)$/);
    if (inputMatch) {
      calls.omegaInputs += 1;
      const [, sessionId, category] = inputMatch;
      const session = omegaSessions.get(sessionId);
      const interactiveLive = omegaViewState?.sessionId === sessionId && omegaViewState.interactiveStatus === 'INTERACTIVE';
      if (!session || !interactiveLive) {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'INTERACTIVE_NOT_STARTED' }) });
      }
      session.events.push({ category, payload: request.postDataJSON() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (/upload|file|clipboard/i.test(pathname)) calls.fileTransfers += 1;
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'route_not_found' }) });
  });

  await page.route('**/__device_fabric_test', route => route.fulfill({ contentType: 'text/html', body: harnessHtml }));
  await page.goto(`${origin}/__device_fabric_test`);
  await page.getByRole('button', { name: 'OPEN DEVICES' }).click();
  await page.getByTestId('device-fabric-panel').waitFor();
  check(true, 'Devices page opens');
  await page.getByText(/Aucun appareil\./).waitFor();
  check(await page.getByText(/Aucun appareil\./).isVisible(), 'empty state');
  check(await page.getByText(/il n’accorde aucun droit OMEGA ni RASSILON/).isVisible(), 'no-authority notice');

  // Create + rename.
  await page.getByLabel('Nom du nouvel appareil').fill('PC Bureau');
  await page.getByRole('button', { name: /CREATE DEVICE/ }).click();
  await page.getByTestId('fabric-device-card').waitFor();
  check(calls.create === 1, 'create reached API');
  const card = page.getByTestId('fabric-device-card');
  check(await card.getByText('Overall UNKNOWN').isVisible(), 'new device is UNKNOWN (no agent)');
  await card.getByRole('button', { name: /RENAME/ }).click();
  await card.getByLabel('Nouveau nom').fill('PC Salon');
  await card.getByRole('button', { name: /ENREGISTRER/ }).click();
  await card.getByText('PC Salon', { exact: true }).waitFor();
  check(calls.rename === 1, 'rename reached API');

  // ── Phase 2: OMEGA V1 inbound and OMEGA V2 outbound are visibly distinct. ──
  const omegaV1Section = card.getByLabel('OMEGA V1 — inbound PC Salon');
  const omegaV2Section = card.getByTestId('omega-v2-section');
  check(await omegaV1Section.getByText('OMEGA V1 — INBOUND', { exact: true }).isVisible(), 'OMEGA V1 inbound section visible');
  check(await omegaV2Section.getByText('OMEGA V2 — OUTBOUND', { exact: true }).isVisible(), 'OMEGA V2 outbound section visible and separate');
  check(await omegaV2Section.getByRole('button', { name: /VIEW|INTERACTIVE|ADMIN|STOP|CONNECT/i }).count() === 0, 'unlinked OMEGA V2 has no control button');
  check(calls.omegaV2HostsGets >= 1 && calls.omegaV2StatusGets >= 1 && calls.omegaV2Link.length === 0, 'initial OMEGA V2 refresh is read-only');

  // Explicit host selection + exact fingerprint confirmation. Revoked hosts
  // are excluded and host-controlled text remains inert.
  await omegaV2Section.getByRole('button', { name: /LIER UN HÔTE OMEGA V2/ }).click();
  const omegaV2Dialog = omegaV2Section.getByRole('dialog');
  await omegaV2Dialog.waitFor();
  check(await omegaV2Dialog.getByRole('radio').count() === 1, 'OMEGA V2 dialog lists only an unlinked, non-revoked host');
  check(await omegaV2Dialog.getByText(/revoked\.example/).count() === 0, 'revoked OMEGA V2 host excluded');
  check(await omegaV2Dialog.getByText(XSS_IMG, { exact: false }).count() === 1, 'OMEGA V2 host text rendered literally');
  check(await omegaV2Dialog.locator('img, script, b').count() === 0, 'OMEGA V2 host text creates no active HTML');
  await omegaV2Dialog.getByRole('radio').check();
  check(await omegaV2Dialog.getByTestId('omega-v2-link-fingerprint').innerText() === FP.omegaV2, 'full OMEGA V2 fingerprint displayed');
  const confirmOmegaV2 = omegaV2Dialog.getByRole('button', { name: /CONFIRMER LE LIEN/ });
  check(await confirmOmegaV2.isDisabled(), 'OMEGA V2 link blocked until explicit fingerprint confirmation');
  await omegaV2Dialog.getByRole('checkbox').check();
  await confirmOmegaV2.click();
  await omegaV2Section.getByText(/Hôte :/).waitFor();
  check(calls.omegaV2Link.length === 1 && calls.omegaV2Link[0].confirmFingerprint === FP.omegaV2, 'OMEGA V2 link sends the exact confirmed fingerprint');
  check(await omegaV2Section.getByText('Disponibilité UNKNOWN', { exact: true }).isVisible(), 'OMEGA V2 availability is UNKNOWN without an existing session');
  const noSessionView = await omegaV2Section.locator('tr').filter({ hasText: 'VIEW' }).innerText();
  check(/VIEW\s+YES\s+YES\s+UNKNOWN/.test(noSessionView), `OMEGA V2 SUPPORTED/AUTHORIZED/AVAILABLE separated (${noSessionView})`);
  check(await omegaV2Section.getByText(/ONLINE|AVAILABLE YES/, { exact: false }).count() === 0, 'trust/link alone never produces ONLINE or AVAILABLE YES');

  // Phase 3 VIEW: nothing connects before the explicit click. The frame is
  // fetched from OMEGA's existing endpoint, never through Device Fabric.
  const fabricView = omegaV2Section.getByTestId('fabric-omega-v2-view');
  await fabricView.waitFor();
  check(await fabricView.getByText('OMEGA VIEW', { exact: true }).isVisible(), 'Fabric panel shows the OMEGA VIEW section');
  check(calls.omegaViewStart.length === 0 && calls.omegaFrames === 0, 'page load/status refresh performs zero VIEW start and zero frame pull');
  const viewButton = fabricView.getByTestId('fabric-omega-v2-view-start');
  check(await viewButton.isEnabled(), 'VIEW remains available while AVAILABLE is UNKNOWN but VIEW is authorized');
  await viewButton.click();
  await fabricView.getByAltText('Fabric remote screen').waitFor();
  check(calls.omegaViewStart.length === 1 && calls.omegaViewStart[0].omegaV2HostId === omegaV2Trusts[0].omegaV2HostId,
    'explicit VIEW click sends the exact linked host and version binding');
  check(calls.omegaFrames > 0, 'authenticated remote frame is displayed through the OMEGA frame path');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="omega-v2-section"] tr')]
    .some(row => /VIEW\s*YES\s*YES\s*YES/.test(row.textContent ?? '')));
  check(true, 'availability becomes evidence-based only after the real session start');

  const viewport = fabricView.getByLabel('Read-only Fabric remote viewport');
  const beforeInput = calls.omegaInputs;
  const beforeFiles = calls.fileTransfers;
  await viewport.click({ position: { x: 20, y: 20 } });
  await viewport.press('KeyA');
  await viewport.dispatchEvent('wheel', { deltaY: 120 });
  await viewport.dispatchEvent('dragover');
  await viewport.dispatchEvent('drop');
  await page.waitForTimeout(100);
  check(calls.omegaInputs === beforeInput, 'viewport click, keyboard and wheel generate zero remote input');
  check(calls.fileTransfers === beforeFiles, 'viewport drag/drop generates zero file transfer');
  check(await fabricView.getByText(/INTERACTIVE: STOPPED/).isVisible(), 'INTERACTIVE initially OFF while VIEW is live');

  // ── Phase 4 INTERACTIVE: explicit activation only, then real forwarding ──
  const interactiveStartButton = fabricView.getByTestId('fabric-omega-v2-interactive-start');
  check(await interactiveStartButton.isEnabled(), 'ACTIVER INTERACTIVE enabled once VIEW is VIEWING');
  const startsBeforeInteractive = calls.omegaInteractiveStart.length;
  await interactiveStartButton.click();
  await fabricView.getByText(/INTERACTIVE: INTERACTIVE/).waitFor();
  check(calls.omegaInteractiveStart.length === startsBeforeInteractive + 1, 'INTERACTIVE activation is one explicit click, one Fabric call');
  check(await fabricView.getByLabel('Fabric remote viewport (INTERACTIVE)').isVisible(), 'viewport reflects the live INTERACTIVE label');

  const interactiveViewport = fabricView.getByLabel('Fabric remote viewport (INTERACTIVE)');
  const activeSessionId = omegaViewState.sessionId;
  const eventsFor = id => omegaSessions.get(id)?.events ?? [];
  // The 1x1 test PNG scales down to a near-zero-size image centered (via
  // object-fit: contain) inside the viewport, so any click must land on
  // that exact center — Playwright's default (no `position`) targets an
  // element's visual center, which is what mapPointer needs to succeed.
  const beforeMove = eventsFor(activeSessionId).filter(e => e.category === 'pointer').length;
  await interactiveViewport.hover();
  await page.waitForTimeout(120);
  check(eventsFor(activeSessionId).some(e => e.category === 'pointer'), `pointer move forwarded (before=${beforeMove})`);

  const clicksBefore = eventsFor(activeSessionId).filter(e => e.category === 'button').length;
  await interactiveViewport.click({ button: 'left' });
  await page.waitForTimeout(80);
  await interactiveViewport.click({ button: 'right' });
  await page.waitForTimeout(80);
  const buttonEvents = eventsFor(activeSessionId).filter(e => e.category === 'button');
  check(buttonEvents.length > clicksBefore, 'mouse click forwarded as button DOWN/UP');
  check(buttonEvents.some(e => e.payload.button === 'LEFT'), 'left click sends LEFT');
  check(buttonEvents.some(e => e.payload.button === 'RIGHT'), 'right click sends RIGHT');

  const wheelBefore = eventsFor(activeSessionId).filter(e => e.category === 'wheel').length;
  const viewportBox = await interactiveViewport.boundingBox();
  await interactiveViewport.dispatchEvent('wheel', { deltaY: 120, clientX: viewportBox.x + viewportBox.width / 2, clientY: viewportBox.y + viewportBox.height / 2 });
  await page.waitForTimeout(50);
  check(eventsFor(activeSessionId).filter(e => e.category === 'wheel').length > wheelBefore, 'wheel forwarded');

  // Keyboard only reaches OMEGA with focus; unfocused key presses are inert.
  // The panel heading is plain inert text: clicking it moves focus off the
  // viewport without triggering any action or state refresh.
  await fabricView.getByText('OMEGA VIEW', { exact: true }).click();
  const keysBeforeUnfocused = eventsFor(activeSessionId).filter(e => e.category === 'key').length;
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(50);
  check(eventsFor(activeSessionId).filter(e => e.category === 'key').length === keysBeforeUnfocused, 'keyboard without viewport focus generates zero remote key event');
  await interactiveViewport.focus();
  await interactiveViewport.press('KeyA');
  await page.waitForTimeout(50);
  const keyEvents = eventsFor(activeSessionId).filter(e => e.category === 'key');
  check(keyEvents.length > keysBeforeUnfocused, 'focused keyboard forwarded');
  check(keyEvents.some(e => e.payload.key === 'KeyA' && e.payload.state === 'DOWN'), 'key DOWN sent');
  check(keyEvents.some(e => e.payload.key === 'KeyA' && e.payload.state === 'UP'), 'key UP sent');

  // A held button released outside the viewport still sends UP (no stuck remote input).
  await interactiveViewport.hover();
  await page.mouse.down();
  await page.mouse.move(5000, 5000);
  await page.mouse.up();
  await page.waitForTimeout(50);
  check(true, 'button released outside the viewport does not hang (UP path exercised)');

  // Escape stops INTERACTIVE locally and is never itself forwarded as a remote key.
  const keysBeforeEscape = eventsFor(activeSessionId).filter(e => e.category === 'key').length;
  await interactiveViewport.focus();
  await interactiveViewport.press('Escape');
  await fabricView.getByText(/INTERACTIVE: STOPPED/).waitFor();
  check(!eventsFor(activeSessionId).some(e => e.category === 'key' && e.payload.key === 'Escape'), 'Escape never forwarded as a remote key');
  check(eventsFor(activeSessionId).filter(e => e.category === 'key').length >= keysBeforeEscape, 'Escape stop still allows prior key releases to have been sent');
  check(calls.omegaInteractiveStop >= 1, 'Escape calls the dedicated INTERACTIVE stop primitive');
  check(await fabricView.getByText(/VIEW: VIEWING/).isVisible(), 'VIEW survives Escape/STOP INTERACTIVE');

  // Blur/focus loss releases any locally-held keys (defense in depth: none
  // should be held here after Escape, but the release path must be a no-op,
  // never an error, and must not resurrect INTERACTIVE).
  await interactiveStartButton.click();
  await fabricView.getByText(/INTERACTIVE: INTERACTIVE/).waitFor();
  const liveViewport = fabricView.getByLabel('Fabric remote viewport (INTERACTIVE)');
  await liveViewport.focus();
  await liveViewport.press('KeyA', { delay: 0 });
  await page.keyboard.down('KeyA');
  await page.locator('body').focus();
  await page.waitForTimeout(50);
  const afterBlur = eventsFor(omegaViewState.sessionId).filter(e => e.category === 'key' && e.payload.key === 'KeyA' && e.payload.state === 'UP');
  check(afterBlur.length > 0, 'blur releases locally-held keys');
  await page.keyboard.up('KeyA').catch(() => {});

  check(await fabricView.getByText(/INTERACTIVE: INTERACTIVE/).isVisible(), 'INTERACTIVE remains active after a key-release-only blur');
  await fabricView.getByTestId('fabric-omega-v2-interactive-stop').click();
  await fabricView.getByText(/INTERACTIVE: STOPPED/).waitFor();
  check(await fabricView.getByText(/VIEW: VIEWING/).isVisible(), 'STOP INTERACTIVE leaves VIEW active');

  // No ADMIN, no clipboard, no file transfer anywhere in this flow.
  check(await fabricView.getByRole('button', { name: /ADMIN/i }).count() === 0, 'no ADMIN button in the Fabric INTERACTIVE panel');
  const clipboardBefore = calls.fileTransfers;
  await interactiveStartButton.click();
  await fabricView.getByText(/INTERACTIVE: INTERACTIVE/).waitFor();
  await fabricView.getByLabel('Fabric remote viewport (INTERACTIVE)').dispatchEvent('paste');
  await fabricView.getByLabel('Fabric remote viewport (INTERACTIVE)').dispatchEvent('copy');
  await fabricView.getByLabel('Fabric remote viewport (INTERACTIVE)').dispatchEvent('dragover');
  await fabricView.getByLabel('Fabric remote viewport (INTERACTIVE)').dispatchEvent('drop');
  await page.waitForTimeout(50);
  check(calls.fileTransfers === clipboardBefore, 'clipboard/drag/drop still generate zero file transfer while INTERACTIVE is live');

  // STOP VIEW must also stop INTERACTIVE (mirrors OMEGA's own certified behavior).
  await fabricView.getByTestId('fabric-omega-v2-view-stop').click();
  await fabricView.getByText(/VIEW: STOPPED/).waitFor();
  check(calls.omegaViewStop === 1, 'STOP VIEW uses the dedicated Fabric/Omega stop primitive');
  check(await fabricView.getByText(/INTERACTIVE: STOPPED/).isVisible(), 'STOP VIEW also stops INTERACTIVE');

  await viewButton.click();
  await fabricView.getByAltText('Fabric remote screen').waitFor();
  await interactiveStartButton.click();
  await fabricView.getByText(/INTERACTIVE: INTERACTIVE/).waitFor();
  await fabricView.getByTestId('fabric-omega-v2-session-stop').click();
  await fabricView.getByText(/CONNEXION: DISCONNECTED/).waitFor();
  check(calls.omegaSessionStop === 1, 'STOP SESSION stops only the Fabric-created OMEGA session');
  check(await fabricView.getByText(/INTERACTIVE: STOPPED/).isVisible(), 'STOP SESSION also stops INTERACTIVE');

  // Remote STOP is learned from local OMEGA session state; no reconnect and
  // no new target is attempted by the GET status poll.
  await viewButton.click();
  await fabricView.getByAltText('Fabric remote screen').waitFor();
  await interactiveStartButton.click();
  await fabricView.getByText(/INTERACTIVE: INTERACTIVE/).waitFor();
  const startsBeforeRemoteStop = calls.omegaViewStart.length;
  omegaViewState = { ...omegaViewState, sessionStatus: 'DISCONNECTED', sessionReason: 'remote_stop', viewStatus: 'STOPPED', streamId: null, interactiveStatus: 'STOPPED' };
  await fabricView.getByText(/CONNEXION: DISCONNECTED/).waitFor({ timeout: 3_000 });
  check(calls.omegaViewStart.length === startsBeforeRemoteStop, 'remote STOP is reflected with zero automatic reconnect');
  check(await fabricView.getByText(/INTERACTIVE: STOPPED/).isVisible(), 'remote STOP also clears the local INTERACTIVE state');

  // Network loss from the direct OMEGA frame endpoint fails closed.
  omegaFrameFailure = 'NETWORK_UNAVAILABLE';
  await viewButton.click();
  await fabricView.getByRole('alert').filter({ hasText: 'NETWORK_UNAVAILABLE' }).waitFor();
  check(calls.omegaViewStart.length === startsBeforeRemoteStop + 1, 'network drop stops the view without retargeting');
  check(await fabricView.getByTestId('fabric-omega-v2-interactive-start').isDisabled(), 'network drop leaves INTERACTIVE unreachable, not auto-retried');
  omegaFrameFailure = null;

  // OMEGA itself may deny INTERACTIVE (session permission ceiling below
  // INTERACTIVE) even while VIEW is live; Fabric surfaces OMEGA's own
  // verdict rather than inferring authorization from the link.
  await viewButton.click();
  await fabricView.getByAltText('Fabric remote screen').waitFor();
  omegaInteractiveDenied = true;
  await fabricView.getByTestId('fabric-omega-v2-interactive-start').click();
  await fabricView.getByRole('alert').filter({ hasText: 'OMEGA_V2_INTERACTIVE_NOT_AUTHORIZED' }).waitFor();
  check(await fabricView.getByText(/INTERACTIVE: STOPPED/).isVisible(), 'denied INTERACTIVE leaves the local state STOPPED, never a fake ACTIVE');
  omegaInteractiveDenied = false;
  await fabricView.getByTestId('fabric-omega-v2-session-stop').click();
  await fabricView.getByText(/CONNEXION: DISCONNECTED/).waitFor();

  // Expiry is reflected by the side-effect-free Fabric status read.
  await viewButton.click();
  omegaViewState = { ...omegaViewState, sessionStatus: 'DISCONNECTED', sessionReason: 'session_expired', viewStatus: 'STOPPED', streamId: null, interactiveStatus: 'STOPPED' };
  await fabricView.getByText(/CONNEXION: DISCONNECTED/).waitFor({ timeout: 3_000 });
  check(calls.omegaViewStatus > 0, 'expired session is reflected by local status polling');

  // Browser-layer wrong Fabric and wrong OMEGA bindings fail; neither can
  // cause a second target to be selected.
  const wrongResults = await page.evaluate(async ({ deviceId, link }) => {
    const headers = { 'content-type': 'application/json' };
    const body = JSON.stringify({ screenIndex: 0, linkId: link.linkId, linkVersion: link.linkVersion,
      omegaV2HostId: 'ov2h-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fingerprint: link.linkedFingerprint });
    const wrongFabric = await fetch('/api/device-fabric/devices/fdev-99999999-9999-4999-8999-999999999999/omega-v2/view/start', { method: 'POST', headers, body });
    const wrongOmega = await fetch(`/api/device-fabric/devices/${deviceId}/omega-v2/view/start`, { method: 'POST', headers, body });
    return { wrongFabric: wrongFabric.status, wrongOmega: (await wrongOmega.json()).error };
  }, { deviceId: devices[0].fabricDeviceId, link: omegaV2Status(devices[0].fabricDeviceId) });
  check(wrongResults.wrongFabric === 404, 'wrong Fabric device is rejected');
  check(wrongResults.wrongOmega === 'OMEGA_V2_LINK_CHANGED', 'wrong OMEGA device binding is rejected');

  // INTERACTIVE start against a wrong/nonexistent Fabric device fails the
  // same way, and never starts INTERACTIVE on any session (exact target).
  const wrongInteractive = await page.evaluate(async deviceId => {
    const wrongFabric = await fetch('/api/device-fabric/devices/fdev-99999999-9999-4999-8999-999999999999/omega-v2/interactive/start',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const unknownField = await fetch(`/api/device-fabric/devices/${deviceId}/omega-v2/interactive/start`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'forged' }) });
    return { wrongFabric: wrongFabric.status, unknownField: unknownField.status };
  }, devices[0].fabricDeviceId);
  check(wrongInteractive.wrongFabric === 404, 'INTERACTIVE start against a wrong Fabric device is rejected');
  check(wrongInteractive.unknownField === 400, 'INTERACTIVE start rejects any body field (closed request schema)');

  omegaV2SessionPermission = null;
  omegaViewState = null;

  // Existing local sessions are observed read-only. Their permission ceiling
  // produces exact YES/NO availability and never causes a network connect.
  omegaV2SessionPermission = 'VIEW';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForTimeout(500);
  let omegaRows = await omegaV2Section.locator('tbody').innerText();
  check(/VIEW\s+YES\s+YES\s+YES/.test(omegaRows) && /INTERACTIVE\s+YES\s+YES\s+NO/.test(omegaRows) && /ADMIN\s+YES\s+YES\s+NO/.test(omegaRows), `VIEW session availability ceiling (${omegaRows})`);
  omegaV2SessionPermission = 'INTERACTIVE';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="omega-v2-section"] tr')].some(row => /INTERACTIVE\s+YES\s+YES\s+YES/.test(row.innerText)));
  omegaRows = await omegaV2Section.locator('tbody').innerText();
  check(/VIEW\s+YES\s+YES\s+YES/.test(omegaRows) && /INTERACTIVE\s+YES\s+YES\s+YES/.test(omegaRows) && /ADMIN\s+YES\s+YES\s+NO/.test(omegaRows), `INTERACTIVE session leaves ADMIN unavailable (${omegaRows})`);
  omegaV2SessionPermission = 'ADMIN';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="omega-v2-section"] tr')].filter(row => /^(VIEW|INTERACTIVE|ADMIN)/.test(row.innerText.trim())).every(row => (row.innerText.match(/YES/g) ?? []).length === 3));
  omegaRows = await omegaV2Section.locator('tbody').innerText();
  check((omegaRows.match(/YES/g) ?? []).length === 9, 'ADMIN session makes all permitted capabilities available');
  omegaV2SessionPermission = null;

  // ── Exact-target proof: Fabric A -> OMEGA A, Fabric B -> OMEGA B ──────────
  // Driven directly against the API (like the wrong-device checks above)
  // rather than through the UI, because the mock's single global
  // omegaViewState only ever reflects the most recent view/start call — the
  // real per-sessionId isolation this proves lives in the omegaSessions map,
  // exactly mirroring the two-process TLS harness's own host-B-stays-at-0 proof.
  omegaV2Trusts.push(OMEGA_V2_HOST_B);
  const deviceB = await page.evaluate(async displayName => {
    const res = await fetch('/api/device-fabric/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) });
    return (await res.json()).device;
  }, 'PC Exact Target B');
  const hostBId = OMEGA_V2_HOST_B.omegaV2HostId;
  const linkB = await page.evaluate(async ({ fabricDeviceId, omegaV2HostId, confirmFingerprint }) => {
    const res = await fetch(`/api/device-fabric/devices/${fabricDeviceId}/omega-v2/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ omegaV2HostId, confirmFingerprint }) });
    return (await res.json()).link;
  }, { fabricDeviceId: deviceB.fabricDeviceId, omegaV2HostId: hostBId, confirmFingerprint: OMEGA_V2_HOST_B.identityFingerprint });
  check(linkB.omegaV2HostId === hostBId, 'Fabric device B links to OMEGA host B only');

  const linkA = omegaV2Status(devices[0].fabricDeviceId);
  const exact = await page.evaluate(async ({ aId, aLink, bId, bLink }) => {
    const headers = { 'content-type': 'application/json' };
    const startA = await fetch(`/api/device-fabric/devices/${aId}/omega-v2/view/start`, { method: 'POST', headers,
      body: JSON.stringify({ screenIndex: 0, linkId: aLink.linkId, linkVersion: aLink.linkVersion, omegaV2HostId: aLink.omegaV2HostId, fingerprint: aLink.linkedFingerprint }) });
    const viewA = (await startA.json()).view;
    const interactiveA = await fetch(`/api/device-fabric/devices/${aId}/omega-v2/interactive/start`, { method: 'POST', headers, body: '{}' });
    const sessionIdA = (await interactiveA.json()).view.sessionId;
    await fetch(`/api/omega/outbound/sessions/${sessionIdA}/input/pointer`, { method: 'POST', headers, body: JSON.stringify({ x: 0.4, y: 0.4 }) });
    await fetch(`/api/omega/outbound/sessions/${sessionIdA}/input/key`, { method: 'POST', headers, body: JSON.stringify({ key: 'KeyZ', state: 'DOWN' }) });

    const startB = await fetch(`/api/device-fabric/devices/${bId}/omega-v2/view/start`, { method: 'POST', headers,
      body: JSON.stringify({ screenIndex: 0, linkId: bLink.linkId, linkVersion: bLink.linkVersion, omegaV2HostId: bLink.omegaV2HostId, fingerprint: bLink.linkedFingerprint }) });
    const viewB = (await startB.json()).view;
    return { viewAHost: viewA.omegaV2HostId, sessionIdA, viewBHost: viewB.omegaV2HostId, viewBStatus: startB.status };
  }, { aId: devices[0].fabricDeviceId, aLink: linkA, bId: deviceB.fabricDeviceId, bLink: linkB });

  check(exact.viewAHost === omegaV2Trusts[0].omegaV2HostId, 'Fabric A VIEW connects to exact OMEGA host A');
  check(exact.viewBHost === hostBId && exact.viewBStatus === 201, 'Fabric B VIEW connects to exact OMEGA host B, independently of A');
  const sessionAEvents = omegaSessions.get(exact.sessionIdA)?.events ?? [];
  check(sessionAEvents.some(e => e.category === 'pointer') && sessionAEvents.some(e => e.category === 'key'), 'INTERACTIVE input on A is recorded on A\'s own session');
  check([...omegaSessions.values()].filter(s => s.omegaV2HostId === hostBId).every(s => s.events.length === 0), 'OMEGA host B recorded exactly 0 input events from A\'s INTERACTIVE activity');

  // If A becomes unavailable, B is never attempted and stays at 0 events.
  const failoverProbe = await page.evaluate(async ({ aId, aLink }) => {
    const res = await fetch(`/api/device-fabric/devices/${aId}/omega-v2/view/start`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screenIndex: 0, linkId: aLink.linkId, linkVersion: 999, omegaV2HostId: aLink.omegaV2HostId, fingerprint: aLink.linkedFingerprint }) });
    return { status: res.status, error: (await res.json()).error };
  }, { aId: devices[0].fabricDeviceId, aLink: linkA });
  check(failoverProbe.status === 409 && failoverProbe.error === 'OMEGA_V2_LINK_CHANGED', 'a stale/failed A attempt is rejected, never silently retargeted');
  check([...omegaSessions.values()].filter(s => s.omegaV2HostId === hostBId).every(s => s.events.length === 0), 'host B remains at 0 events after A fails, with zero fallback attempt');

  // Cleanup: remove the exact-target probe device and host so neither
  // interferes with the remaining single-device assertions below. The probe
  // delete itself is not part of the later "delete with links" assertion,
  // so calls.remove is reset rather than left with this extra entry.
  await page.evaluate(async id => { await fetch(`/api/device-fabric/devices/${id}?confirm=REMOVE_LINKS`, { method: 'DELETE' }); }, deviceB.fabricDeviceId);
  calls.remove.length = 0;
  omegaV2Trusts.pop();
  omegaSessions.clear();
  omegaViewState = null;
  omegaV2SessionPermission = null;

  // Safe degraded states stay linked and never claim availability.
  omegaV2LinkState = 'REVOKED';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await omegaV2Section.getByText(/confiance OMEGA V2 révoquée/).waitFor();
  check(await omegaV2Section.getByText('REVOKED', { exact: true }).isVisible(), 'revoked OMEGA V2 trust shown');
  check(await omegaV2Section.getByTestId('fabric-omega-v2-view-start').count() === 0, 'revoked OMEGA V2 trust blocks VIEW');
  check(await omegaV2Section.getByTestId('fabric-omega-v2-interactive-start').count() === 0, 'revoked OMEGA V2 trust blocks INTERACTIVE too');
  omegaV2LinkState = 'FINGERPRINT_MISMATCH';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await omegaV2Section.getByText(/clé OMEGA V2 a changé/).waitFor();
  check(await omegaV2Section.getByText('Disponibilité UNKNOWN', { exact: true }).isVisible(), 'fingerprint mismatch is UNKNOWN, never positive');
  check(await omegaV2Section.getByTestId('fabric-omega-v2-view-start').count() === 0, 'stale fingerprint blocks VIEW');
  check(await omegaV2Section.getByTestId('fabric-omega-v2-interactive-start').count() === 0, 'stale fingerprint blocks INTERACTIVE too');
  omegaV2LinkState = 'MISSING';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await omegaV2Section.getByText(/hôte OMEGA V2 introuvable/).waitFor();
  check(await omegaV2Section.getByRole('button', { name: /DÉLIER/ }).isVisible(), 'missing trust keeps the stale Fabric link visible for explicit unlink');
  omegaV2LinkState = 'OK';
  await page.getByRole('button', { name: /REFRESH/ }).click();

  // ── Phase 5 ADMIN: read-only status + high-impact actions + STOP ──────────
  // Mounted only when linkState is OK and ADMIN is authorized — exactly the
  // state right here, before the OMEGA V2 unlink below removes the section.
  const fabricAdmin = omegaV2Section.getByLabel(/OMEGA ADMIN/);
  await fabricAdmin.waitFor();
  check(await fabricAdmin.getByLabel('ADMIN state').getByText('ADMIN: AVAILABLE').isVisible(), 'ADMIN section visible and available while ADMIN is authorized');

  // 1. ADMIN section presence follows authorization, not just link state.
  omegaV2Trusts[0].maxPermission = 'INTERACTIVE';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label^="OMEGA ADMIN"]'));
  check(await omegaV2Section.getByLabel(/OMEGA ADMIN/).count() === 0, 'ADMIN section absent once ADMIN authorization is withdrawn');
  omegaV2Trusts[0].maxPermission = 'ADMIN';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await omegaV2Section.getByLabel(/OMEGA ADMIN/).waitFor();
  check(await omegaV2Section.getByLabel(/OMEGA ADMIN/).isVisible(), 'ADMIN section reappears once ADMIN authorization is restored');

  // 2. Each read-only action: exact mock action recorded + some result rendered + inert XSS.
  const adminReadsBefore = calls.omegaAdminReads.length;
  await fabricAdmin.getByTestId('fabric-omega-v2-admin-read-systemInfo').click();
  await fabricAdmin.getByLabel('ADMIN system info').waitFor();
  check(calls.omegaAdminReads[calls.omegaAdminReads.length - 1].actionType === 'GET_SYSTEM_INFO', 'system info read hits the exact mock action');
  check(await fabricAdmin.getByLabel('ADMIN system info').getByText('MOCK-PC', { exact: false }).isVisible(), 'system info dl renders the fake result');

  await fabricAdmin.getByTestId('fabric-omega-v2-admin-read-processes').click();
  await fabricAdmin.getByLabel('ADMIN result').waitFor();
  check(calls.omegaAdminReads[calls.omegaAdminReads.length - 1].actionType === 'PROCESS_LIST', 'processes read hits the exact mock action');
  check(await fabricAdmin.getByLabel('ADMIN result').getByText('mock.exe').isVisible(), 'process table renders a fake row');
  let admInert = await fabricAdmin.evaluate(el => ({ img: el.querySelectorAll('img').length, script: el.querySelectorAll('script').length, b: el.querySelectorAll('b').length }));
  check(admInert.img === 0 && admInert.script === 0 && admInert.b === 0, `process name XSS renders inert (${JSON.stringify(admInert)})`);

  await fabricAdmin.getByTestId('fabric-omega-v2-admin-read-services').click();
  await fabricAdmin.getByLabel('ADMIN result').getByText('mocksvc').waitFor();
  check(calls.omegaAdminReads[calls.omegaAdminReads.length - 1].actionType === 'SERVICE_STATUS', 'services read hits the exact mock action');
  check(await fabricAdmin.getByLabel('ADMIN result').getByText('RUNNING').isVisible(), 'service table renders a fake row');
  admInert = await fabricAdmin.evaluate(el => ({ img: el.querySelectorAll('img').length, script: el.querySelectorAll('script').length, b: el.querySelectorAll('b').length }));
  check(admInert.img === 0 && admInert.script === 0 && admInert.b === 0, `service displayName XSS renders inert (${JSON.stringify(admInert)})`);

  await fabricAdmin.getByTestId('fabric-omega-v2-admin-read-network').click();
  await fabricAdmin.getByLabel('ADMIN result').getByText('10.0.0.5').waitFor();
  check(calls.omegaAdminReads[calls.omegaAdminReads.length - 1].actionType === 'NETWORK_STATUS', 'network read hits the exact mock action');
  admInert = await fabricAdmin.evaluate(el => ({ img: el.querySelectorAll('img').length, script: el.querySelectorAll('script').length, b: el.querySelectorAll('b').length }));
  check(admInert.img === 0 && admInert.script === 0 && admInert.b === 0, `network interface XSS renders inert (${JSON.stringify(admInert)})`);

  await fabricAdmin.getByTestId('fabric-omega-v2-admin-read-disks').click();
  await fabricAdmin.getByLabel('ADMIN result').getByText('NTFS').first().waitFor();
  check(calls.omegaAdminReads[calls.omegaAdminReads.length - 1].actionType === 'DISK_STATUS', 'disks read hits the exact mock action');
  admInert = await fabricAdmin.evaluate(el => ({ img: el.querySelectorAll('img').length, script: el.querySelectorAll('script').length, b: el.querySelectorAll('b').length }));
  check(admInert.img === 0 && admInert.script === 0 && admInert.b === 0, `disk label XSS renders inert (${JSON.stringify(admInert)})`);
  check(calls.omegaAdminReads.length === adminReadsBefore + 5, 'exactly 5 read-only ADMIN calls made, one per button');

  // 3a. LOCK end-to-end: click → confirm dialog → confirm → PENDING_APPROVAL
  // (zero real execution yet) → flip outcome to APPROVE → poll to EXECUTED.
  check(calls.omegaAdminHighImpact.filter(c => c.actionType === 'LOCK').length === 0, 'no LOCK executed before the flow starts');
  await fabricAdmin.getByTestId('fabric-omega-v2-admin-lock').click();
  const admConfirmDialog = fabricAdmin.getByRole('dialog', { name: 'Confirm high-impact ADMIN action' });
  await admConfirmDialog.waitFor();
  check(await admConfirmDialog.locator('p').getByText(/Confirmer LOCK/).isVisible(), 'confirm dialog names the exact pending action');
  omegaAdminOutcome = 'APPROVE';
  await admConfirmDialog.getByTestId('fabric-omega-v2-admin-confirm').click();
  await fabricAdmin.getByLabel('ADMIN operation status').getByText('PENDING_APPROVAL', { exact: false }).waitFor();
  check(calls.omegaAdminHighImpact.length === 1 && calls.omegaAdminHighImpact[0].actionType === 'LOCK', 'confirm sends exactly one LOCK request');
  check(calls.omegaAdminOperationStatusPolls === 0 || (await fabricAdmin.getByLabel('ADMIN operation status').innerText()).includes('PENDING_APPROVAL'),
    'nothing executed yet: still PENDING_APPROVAL immediately after confirm');
  await page.waitForFunction(() => {
    const el = document.querySelector('[aria-label="ADMIN operation status"]');
    return el && /EXECUTED/.test(el.textContent);
  }, { timeout: 15_000 });
  check(await fabricAdmin.getByLabel('ADMIN operation status').getByText('EXECUTED', { exact: false }).isVisible(), 'LOCK settles to EXECUTED only after the mock approval trigger flips');
  check(calls.omegaAdminHighImpact.filter(c => c.actionType === 'LOCK').length === 1, 'exactly one LOCK execution happened end-to-end');

  // 3b. LOGOFF denied path: confirm → PENDING_APPROVAL → flip outcome to DENY
  // → settles DENIED with an error, zero real executions recorded.
  omegaAdminOutcome = 'DENY';
  await fabricAdmin.getByTestId('fabric-omega-v2-admin-logoff').click();
  await admConfirmDialog.waitFor();
  await admConfirmDialog.getByTestId('fabric-omega-v2-admin-confirm').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[aria-label="ADMIN operation status"]');
    return el && /DENIED/.test(el.textContent);
  }, { timeout: 15_000 });
  check(await fabricAdmin.getByLabel('ADMIN operation status').getByText('DENIED', { exact: false }).isVisible(), 'LOGOFF settles to DENIED once the mock denies it');
  check(await fabricAdmin.getByLabel('ADMIN error').isVisible(), 'denial surfaces an ADMIN error');
  check(calls.omegaAdminHighImpact.filter(c => c.actionType === 'LOGOFF').length === 1, 'LOGOFF was requested exactly once, and never actually executed (only DENIED)');
  omegaAdminOutcome = 'APPROVE';

  // 4. STOP DEVICE: fires once, then the ADMIN section shows disabled/reason.
  check(calls.omegaAdminStopDevice === 0, 'no STOP DEVICE call before the click');
  await fabricAdmin.getByTestId('fabric-omega-v2-admin-stop-device').click();
  await fabricAdmin.getByLabel('ADMIN state').getByText(/ADMIN DISABLED:/).waitFor();
  check(calls.omegaAdminStopDevice === 1, 'STOP DEVICE reached the mock exactly once');
  check(await fabricAdmin.getByLabel('ADMIN state').getByText(/ADMIN DISABLED: OMEGA_V2_SESSION_EXPIRED/).isVisible(), 'ADMIN section shows a disabled reason after STOP DEVICE');
  check(await fabricAdmin.getByTestId('fabric-omega-v2-admin-read-systemInfo').isDisabled(), 'read buttons disabled after STOP DEVICE');
  check(await fabricAdmin.getByTestId('fabric-omega-v2-admin-lock').isDisabled(), 'high-impact buttons disabled after STOP DEVICE');
  omegaAdminDisabledReason = null;

  // 5. No shell/command/file/clipboard/credential surface in the ADMIN section.
  const adminButtons = await fabricAdmin.getByRole('button').allInnerTexts();
  check(adminButtons.length > 0, 'ADMIN section exposes at least its own buttons');
  check(!adminButtons.some(text => /SHELL|COMMAND|POWERSHELL|EXECUTE|RUN\b|RPC|RAW|FILE|CLIPBOARD|CREDENTIAL/i.test(text)),
    `ADMIN section exposes only its typed read/high-impact/stop actions (${adminButtons.join(' | ')})`);

  // 6. Hostile text in a fresh read result (error field) still renders inert.
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await omegaV2Section.getByLabel(/OMEGA ADMIN/).waitFor();
  const admInertFinal = await omegaV2Section.getByLabel(/OMEGA ADMIN/).evaluate(el => ({
    img: el.querySelectorAll('img').length, script: el.querySelectorAll('script').length, b: el.querySelectorAll('b').length,
  }));
  check(admInertFinal.img === 0 && admInertFinal.script === 0 && admInertFinal.b === 0, `ADMIN section stays free of active HTML after the full flow (${JSON.stringify(admInertFinal)})`);
  check(await page.evaluate(() => window.__xssFired === undefined), 'no XSS fired anywhere during the ADMIN flow');

  await omegaV2Section.getByRole('button', { name: /DÉLIER/ }).click();
  await page.getByText(/Lien OMEGA V2 supprimé\. La confiance OMEGA V2 est inchangée\./).waitFor();
  check(calls.omegaV2Unlink.length === 1 && omegaV2Trusts.length === 2, 'OMEGA V2 unlink removes only the Fabric link and preserves trust');
  await omegaV2Section.getByRole('button', { name: /LIER UN HÔTE OMEGA V2/ }).waitFor();

  // OMEGA link dialog: only unlinked, non-revoked identities; full confirmation fields.
  await card.getByRole('button', { name: 'LINK OMEGA' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lier OMEGA' });
  await dialog.waitFor();
  const radios = dialog.getByRole('radio');
  check(await radios.count() === 1, 'OMEGA dialog lists only the unlinked, non-revoked identity');
  check(await dialog.getByText(/Déjà lié|Révoqué/).count() === 0, 'linked and revoked identities hidden');
  check(await dialog.getByText(XSS_IMG, { exact: false }).count() === 1, 'agent XSS name rendered as text');
  await radios.first().check();
  check(await dialog.getByTestId('fabric-link-fingerprint').innerText() === FP.omega, 'full fingerprint displayed');
  check(await dialog.getByText('PC Salon').isVisible() && await dialog.getByText('omega-laptop').isVisible(), 'fabric device + agent id displayed');
  const confirmLink = dialog.getByRole('button', { name: /CONFIRMER LE LIEN/ });
  check(await confirmLink.isDisabled(), 'link blocked until explicit fingerprint confirmation');
  await dialog.getByRole('checkbox').check();
  await confirmLink.click();
  await card.getByText(/Lié : OUI/).first().waitFor();
  check(calls.link[0].confirmFingerprint === FP.omega && calls.link[0].agentType === 'OMEGA', 'link sends explicit fingerprint confirmation');
  check(await card.getByText('Cet appareil peut agir sur ce PC').isVisible(), 'OMEGA direction label');
  check(await card.getByText('Disponibilité UNKNOWN').isVisible(), 'OMEGA availability UNKNOWN');
  check(await card.getByText(/Raison : OMEGA outbound client not implemented/).isVisible(), 'OMEGA: routing NOT AVAILABLE with explicit reason');
  check(await card.getByRole('button', { name: /VIEW|CONTROL|INTERACTIVE|ADMIN|SCREEN/i }).count() === 0, 'no OMEGA view/control button');
  check(await card.getByText('Overall UNKNOWN').isVisible(), 'OMEGA-only device stays UNKNOWN, never ONLINE');

  // RASSILON: same-key conflict, then a valid worker.
  await card.getByRole('button', { name: 'LINK RASSILON' }).click();
  const rdialog = page.getByRole('dialog', { name: 'Lier RASSILON' });
  await rdialog.getByRole('radio').first().check();
  await rdialog.getByRole('checkbox').check();
  await rdialog.getByRole('button', { name: /CONFIRMER LE LIEN/ }).click();
  await page.getByRole('alert').getByText(/même clé existe dans OMEGA et RASSILON/).waitFor();
  check(true, 'same-key conflict shown as a safe error');
  check(await rdialog.isVisible(), 'dialog stays open after a rejected link');
  await rdialog.getByRole('radio').nth(1).check();
  await rdialog.getByRole('checkbox').check();
  await rdialog.getByRole('button', { name: /CONFIRMER LE LIEN/ }).click();
  await card.getByText('Overall PARTIAL').waitFor();
  check(true, 'PARTIAL state (OMEGA UNKNOWN + RASSILON AVAILABLE)');
  check(await card.getByText('Ce PC peut envoyer du calcul à cet appareil').isVisible(), 'RASSILON direction label');
  check(await card.getByText('READY — worker exact uniquement').isVisible(), 'RASSILON routing READY (exact worker)');
  const rows = await card.locator('tr').filter({ hasText: 'SAFE_CPU_TASK' }).innerText();
  check(/YES\s+NO\s+NO/.test(rows), `SUPPORTED/AUTHORIZED/AVAILABLE stay distinct (${rows})`);
  check(await card.getByText('Trust TRUSTED').count() === 2, 'OMEGA and RASSILON trust shown separately');
  check(await card.getByText(/DEVICE TRUSTED/).count() === 0, 'no global device trust');

  // ── Phase 3 routing ──
  check(calls.route.length === 0, 'nothing routed on load, link or refresh');
  const compute = card.getByRole('button', { name: 'CALCUL TEST' });
  check(await compute.isDisabled(), 'CALCUL TEST disabled while SAFE_CPU_TASK is not AUTHORIZED');
  await card.getByRole('button', { name: /VÉRIFIER LA DISPONIBILITÉ/ }).click();
  await page.getByText(/Disponibilité vérifiée/).waitFor();
  check(calls.probe === 1 && calls.route.length === 0, 'probe is explicit and never routes');
  safeCpuAuthorized = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'CALCUL TEST' && !b.disabled));
  await compute.click();
  check(await card.getByText(/envoyé uniquement à : GPU box/).isVisible(), 'confirmation names the exact worker');
  check(calls.route.length === 0, 'first click only asks for confirmation');
  await card.getByRole('button', { name: 'CONFIRMER LE CALCUL TEST' }).click();
  await page.getByTestId('fabric-operations').getByText('COMPLETED').waitFor({ timeout: 10_000 });
  const routed = calls.route[0];
  check(JSON.stringify(Object.keys(routed).sort()) === '["actionType","fabricDeviceId","semanticPayload"]', `strict route body ${JSON.stringify(routed)}`);
  check(routed.actionType === 'RASSILON_SAFE_CPU' && routed.semanticPayload.kind === 'HASH_BUFFER', 'fixed SAFE_CPU_TASK payload');
  const opRow = await page.getByTestId('fabric-operations').locator('tr').nth(1).innerText();
  check(/PC Salon/.test(opRow) && /CALCUL TEST/.test(opRow) && /42 ms/.test(opRow) && /sha256 ab12cd34/.test(opRow), `operation row: target, action, duration, safe summary (${opRow})`);

  await card.getByRole('button', { name: 'EMBEDDINGS' }).click();
  const embed = card.getByLabel('Embeddings RASSILON');
  check(await embed.getByText(/16 textes, 2000 caractères par texte, 16000 au total/).isVisible(), 'embedding limits visible');
  check(await embed.getByText(/aucun cloud, aucun téléchargement/).isVisible(), 'local-only notice');
  await embed.getByLabel('Textes à vectoriser (un par ligne)').fill(Array.from({ length: 17 }, (_, i) => `ligne ${i}`).join('\n'));
  check(await embed.getByText('Au plus 16 textes.').isVisible(), 'frontend validation message');
  check(await embed.getByRole('button', { name: /ENVOYER LES EMBEDDINGS/ }).isDisabled(), 'invalid batch cannot be sent');
  await embed.getByLabel('Textes à vectoriser (un par ligne)').fill('premier texte\nsecond texte');
  await embed.getByRole('button', { name: /ENVOYER LES EMBEDDINGS/ }).click();
  await embed.getByRole('button', { name: /CONFIRMER L’ENVOI/ }).click();
  await page.getByTestId('fabric-operations').getByText(/2 vecteur\(s\) × 768/).waitFor({ timeout: 10_000 });
  const embedCall = calls.route[1];
  check(embedCall.actionType === 'RASSILON_EMBEDDING' && JSON.stringify(embedCall.semanticPayload) === JSON.stringify({ texts: ['premier texte', 'second texte'], model: 'nomic-embed-text' }), 'embedding request is exactly texts + allowlisted model');
  check(await page.getByTestId('fabric-operations').getByText(/<script>window.__xssFired=true<\/script>/).count() === 1, 'model name from a result rendered as inert text');

  nextRouteRejection = 'target_availability_unknown';
  await compute.click();
  await card.getByRole('button', { name: 'CONFIRMER LE CALCUL TEST' }).click();
  await page.getByRole('alert').getByText(/disponibilité inconnue/).waitFor();
  check(await page.getByTestId('fabric-operations').getByText('NOT_AVAILABLE').count() >= 1, 'NOT_AVAILABLE operation shown, never COMPLETED');
  check(calls.route.length === 3, 'exactly one request per explicit confirmation');

  // ── Phase 4: freshness, session, failures, no retry, projection errors ──
  check(await card.getByText('Présence VERIFIED', { exact: true }).isVisible() && await card.getByText('Session VALID', { exact: true }).isVisible(), 'presence VERIFIED + session VALID shown');
  check(await card.getByText(/fraîcheur 1 s \/ fenêtre 30 s/).isVisible(), 'probe freshness and window shown');
  check(await page.getByRole('button', { name: /CANCEL|ANNULER L/i }).count() === 0, 'no cancel button (no certified primitive)');
  check(await page.getByText(/Annulation depuis ce PC : indisponible en V1/).isVisible(), 'cancellation limitation documented in the UI');

  presenceAgeMs = 26_000;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'CALCUL TEST' && !b.disabled));
  const readsBefore = calls.devicesGets;
  const probesBefore = calls.probe;
  await card.getByText('Présence STALE', { exact: true }).waitFor({ timeout: 10_000 });
  check(calls.devicesGets === readsBefore && calls.probe === probesBefore, 'display aging needs no network call (no heartbeat, no probe)');
  check(await card.getByRole('button', { name: 'CALCUL TEST' }).isDisabled(), 'stale presence → routing disabled');
  check(await card.getByText('Disponibilité UNKNOWN').count() >= 1, 'AVAILABLE turns UNKNOWN after the freshness window');
  check(await card.getByText(/présence non vérifiée récemment/).isVisible(), 'stale reason shown');
  presenceAgeMs = 1_000;

  sessionState = 'EXPIRED';
  await page.getByRole('button', { name: /REFRESH/ }).click();

  await card.getByText('Session EXPIRED', { exact: true }).waitFor();
  check(await card.getByText(/SESSION EXPIRED — refaire le pairing dans RASSILON/).isVisible(), 'expired session: explicit reason, no renewal');
  check(await card.getByRole('button', { name: 'CALCUL TEST' }).isDisabled() && await card.getByRole('button', { name: 'EMBEDDINGS' }).isDisabled(), 'expired session → routing disabled');
  sessionState = 'VALID';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('Session VALID', { exact: true }).waitFor();

  abortNextRoute = true;
  const attemptsBefore = calls.routeAttempts;
  await compute.click();
  await card.getByRole('button', { name: 'CONFIRMER LE CALCUL TEST' }).click();
  await page.getByRole('alert').getByText(/injoignable/).waitFor();
  await page.waitForTimeout(1_500);
  check(calls.routeAttempts === attemptsBefore + 1, `network failure → exactly one route attempt, no retry (${calls.routeAttempts - attemptsBefore})`);

  newOperation(devices[0].fabricDeviceId, 'RASSILON_SAFE_CPU', 'FAILED', { safeError: 'result_schema_invalid', completedAt: now });
  newOperation(devices[0].fabricDeviceId, 'RASSILON_EMBEDDING', 'FAILED', { safeError: 'interrupted_by_restart', completedAt: now });
  newOperation(devices[0].fabricDeviceId, 'RASSILON_SAFE_CPU', 'FAILED', { safeError: XSS_IMG, completedAt: now });
  events.unshift({ id: 900, createdAt: now, eventType: 'FABRIC_ROUTE_REJECTED', fabricDeviceId: devices[0].fabricDeviceId, agentType: 'OMEGA', agentDeviceId: 'javascript:alert(1)', reason: '<script>window.__xssFired=true</script>' });
  await page.getByRole('button', { name: /REFRESH/ }).click();
  const opsTable = page.getByTestId('fabric-operations');
  await opsTable.getByText(/résultat non conforme/).waitFor();
  check(await opsTable.getByText(/interrompue par un redémarrage \(non reprise\)/).isVisible(), 'restart-interrupted operation shown as such, never COMPLETED');
  check(await opsTable.getByText(XSS_IMG, { exact: false }).count() === 1, 'operation error rendered as inert text');
  check(await page.getByText('<script>window.__xssFired=true</script>', { exact: true }).count() >= 1, 'audit reason rendered as inert text');

  agentProjectionError = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText(/illisible \(projection en erreur\) : rien n’est supposé/).waitFor();
  check(await page.getByText(/Projection RASSILON illisible/).isVisible(), 'agent projection error banner');
  check(await card.getByText('Overall ERROR').isVisible(), 'projection error → overall ERROR, never ONLINE');
  check(await card.getByTestId('rassilon-actions').count() === 0, 'no routing action on a link in error');
  agentProjectionError = false;

  internalError = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.getByRole('alert').getByText(/Erreur interne Device Fabric/).waitFor();
  check(await card.getByText('Overall UNKNOWN').isVisible(), 'Fabric DB error → UNKNOWN');
  internalError = false;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('Overall PARTIAL').waitFor();

  // Revoked RASSILON identity.
  rassilonRevoked = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('Trust REVOKED').waitFor();
  check(await card.getByText('Trust TRUSTED').count() === 1, 'OMEGA stays TRUSTED while RASSILON is REVOKED');
  check(await card.getByText('Disponibilité UNAVAILABLE').isVisible(), 'revoked → AVAILABLE = NO');

  check(await card.getByRole('button', { name: 'CALCUL TEST' }).isDisabled() && await card.getByRole('button', { name: 'EMBEDDINGS' }).isDisabled(), 'revoked worker → routing actions disabled');

  // No generic control actions at all.
  const buttons = await page.getByRole('button').allInnerTexts();
  check(!buttons.some(text => /FULL CONTROL|CONTROL DEVICE|\bRUN\b|ROUTE|DISPATCH|EXECUTE|COMMAND|VIEW SCREEN|REVOKE|PAIR|STOP|ENABLE|\bADMIN\b/i.test(text)), `only Phase 3 actions (${buttons.join(' | ')})`);

  // Unlink OMEGA (explicit two-step).
  await card.getByRole('button', { name: 'UNLINK OMEGA' }).click();
  await card.getByRole('button', { name: 'CONFIRMER UNLINK OMEGA' }).click();
  await card.getByRole('button', { name: 'LINK OMEGA' }).waitFor();
  check(calls.unlink.join() === 'OMEGA', 'unlink reached API for OMEGA only');

  // XSS: Fabric display name and error reasons from the API.
  devices[0].displayName = '<script>window.__xssFired=true</script>';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText('<script>window.__xssFired=true</script>').waitFor();
  const active = await page.getByTestId('device-fabric-panel').evaluate(root => ({
    img: root.querySelectorAll('img').length, script: root.querySelectorAll('script').length, bold: root.querySelectorAll('b').length,
  }));
  check(active.img === 0 && active.script === 0 && active.bold === 0, `no active HTML from Fabric data ${JSON.stringify(active)}`);

  // javascript: URLs, HTML entities, bidi controls and very long Unicode names.
  const longName = 'javascript:alert(1) &lt;img src=x onerror=1&gt; ‮evil ' + '𝔘'.repeat(400);
  devices[0].displayName = longName;
  agents.RASSILON[1].displayName = `&amp;&lt;b&gt;${'é'.repeat(500)}`;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await card.getByText(/^javascript:alert\(1\) &lt;img src=x onerror=1&gt;/).waitFor();
  const rendered = await card.evaluate(root => ({
    links: root.querySelectorAll('a, [href], [src]').length,
    bidi: /[‪-‮⁦-⁩]/.test(root.textContent),
    longest: Math.max(...[...root.querySelectorAll('strong, p')].map(el => el.textContent.length)),
    entitiesDecoded: root.querySelectorAll('b, img').length,
  }));
  check(rendered.links === 0 && !rendered.bidi && rendered.entitiesDecoded === 0, `javascript:/entities/bidi inert ${JSON.stringify(rendered)}`);
  check(rendered.longest < 400, `long Unicode names are truncated (${rendered.longest})`);
  check(await page.evaluate(() => window.__xssFired === undefined), 'no XSS fired from long/unicode/entity names');
  agents.RASSILON[1].displayName = 'GPU box';

  // Delete with links requires explicit confirmation and says nothing is revoked.
  await card.getByRole('button', { name: 'DELETE' }).click();
  check(await card.getByText(/ne révoque ni OMEGA V1, ni la confiance OMEGA V2, ni RASSILON/).isVisible(), 'delete warns all three trust domains are not revoked');
  await card.getByRole('button', { name: 'CONFIRMER DELETE' }).click();
  await page.getByText(/Aucun appareil\./).waitFor();
  check(calls.remove.join() === 'REMOVE_LINKS', 'delete with links sends explicit confirmation');

  // API unreachable → UNKNOWN, alert, actions disabled; XSS in the error inert.
  await page.getByLabel('Nom du nouvel appareil').fill('Laptop');
  await page.getByRole('button', { name: /CREATE DEVICE/ }).click();
  await page.getByTestId('fabric-device-card').waitFor();
  rassilonRevoked = false;
  devices[0].links.RASSILON = 'rassilon-gpu';
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.getByText('Overall ONLINE').waitFor();
  check(true, 'ONLINE only with a fresh AVAILABLE agent');
  apiDown = true;
  await page.getByRole('button', { name: /REFRESH/ }).click();
  await page.getByRole('alert').waitFor();
  check(await page.getByRole('alert').getByText(/injoignable/).isVisible(), 'API error state visible');
  check(await page.getByText('Overall UNKNOWN').isVisible(), 'unreachable API → UNKNOWN');
  check(await page.getByText('Overall ONLINE').count() === 0, 'stale ONLINE not shown when API unreachable');
  check(await page.getByText('Disponibilité AVAILABLE').count() === 0 && await page.getByText('Trust TRUSTED').count() === 0, 'stale agent states replaced by UNKNOWN');
  check(await page.getByRole('button', { name: /CREATE DEVICE/ }).isDisabled(), 'mutating actions disabled while unreachable');
  check(await page.evaluate(() => window.__xssFired === undefined), 'no XSS fired anywhere');
  check(pageErrors.length === 0, `page errors: ${pageErrors.join(', ')}`);
  console.log(`DEVICE FABRIC BROWSER PASS ${assertions}/${assertions}`);
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await server?.close();
}
