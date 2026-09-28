import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { initSqlite } from '../src/lib/sqlite.js';
import { createOmegaOutboundRoute } from '../src/routes/omega-outbound.js';
import { ensureOmegaV2Identity } from '../src/lib/omega-outbound-identity.js';
import { upsertInboundTrust, revokeInboundTrust, endSession, expireSession } from '../src/lib/omega-outbound-store.js';
import * as realCapture from '../src/lib/omega-capture.js';
import { createOmegaOutboundViewManager } from '../src/lib/omega-outbound-view.js';
import { createOmegaOutboundInteractiveManager } from '../src/lib/omega-outbound-interactive.js';

const required = ['OMEGA_HARNESS_DB', 'OMEGA_HARNESS_CERT', 'OMEGA_HARNESS_KEY',
  'OMEGA_HARNESS_CONTROLLER_ID', 'OMEGA_HARNESS_CONTROLLER_KEY', 'OMEGA_HARNESS_CONTROLLER_FP'];
for (const key of required) if (!process.env[key]) throw new Error(`missing_${key}`);

initSqlite(process.env.OMEGA_HARNESS_DB);
const certificatePem = fs.readFileSync(process.env.OMEGA_HARNESS_CERT, 'utf8');
const keyPem = fs.readFileSync(process.env.OMEGA_HARNESS_KEY, 'utf8');
const certificateFingerprint = new crypto.X509Certificate(certificatePem).fingerprint256;
const host = ensureOmegaV2Identity('HOST');
const controllerTrust = {
  controllerDeviceId: process.env.OMEGA_HARNESS_CONTROLLER_ID,
  publicKeyPem: Buffer.from(process.env.OMEGA_HARNESS_CONTROLLER_KEY, 'base64').toString('utf8'),
  identityFingerprint: process.env.OMEGA_HARNESS_CONTROLLER_FP,
  maxPermission: 'ADMIN', createdAt: new Date().toISOString(),
};
upsertInboundTrust(controllerTrust);

const app = new Hono();
const fixtureFrame = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const viewProvider = process.env.OMEGA_HARNESS_REAL_VIEW === '1' ? {
  listScreens: realCapture.listScreens,
  captureFrame: realCapture.captureFrame,
  showSessionIndicator: async (_kind, _sessionId, _deviceId, _expiresAt, onLocalStop) => ({ ok: true, onLocalStop }),
} : process.env.OMEGA_HARNESS_VIEW === '1' ? {
  listScreens: async () => [{ index: 0, primary: true, width: 1, height: 1 }],
  captureFrame: async () => ({ buffer: Buffer.from(fixtureFrame), width: 1, height: 1, byteLength: fixtureFrame.length }),
  showSessionIndicator: async (_kind, _sessionId, _deviceId, _expiresAt, onLocalStop) => ({ ok: true, onLocalStop }),
} : undefined;
const outboundViewManager = createOmegaOutboundViewManager(viewProvider);
const inputEvents = [];
const interactiveProvider = {
  listScreens: async () => (await (viewProvider?.listScreens?.() ?? [{ index: 0, primary: true, width: 1, height: 1 }]))
    .map(screen => ({ ...screen, x: screen.x ?? 0, y: screen.y ?? 0 })),
  showSessionIndicator: async (_kind, _sessionId, _deviceId, _expiresAt, onLocalStop) => ({ ok: true, onLocalStop }),
  executeSemanticInput: async prepared => { inputEvents.push({ category: prepared.category, key: prepared.key,
    button: prepared.button, state: prepared.state, tuple: prepared.tuple, middle: prepared.middle === true });
    return { requested: 1, sent: 1, results: [{ ok: true, sent: 1 }] }; },
  releaseSemanticInput: async (kind, value) => { inputEvents.push({ release: true, kind, value });
    return { requested: 1, sent: 1, results: [{ ok: true, sent: 1 }] }; },
};
const outboundInteractiveManager = createOmegaOutboundInteractiveManager({ viewManager: outboundViewManager, provider: interactiveProvider });
// ADMIN is always a recorder here: the harness can never reach a real Windows
// probe or a real LOCK/LOGOFF/RESTART/SHUTDOWN. Approval is driven over IPC,
// standing in for the host's visible local prompt.
const adminCalls = [];
const adminApprovals = new Map();
let adminApprovalMode = 'manual';
const V1_ACTIONS = { requestLock: 'LOCK_WORKSTATION', requestLogoff: 'REQUEST_LOGOFF', requestRestart: 'REQUEST_RESTART', requestShutdown: 'REQUEST_SHUTDOWN' };
const adminExecutor = {
  getSystemInfo: async () => { adminCalls.push('getSystemInfo'); return { ok: true, action: 'GET_SYSTEM_INFO', system: { computerName: 'HARNESS-B',
    osCaption: 'Harness OS', osVersion: '10.0', architecture: '64-bit', lastBootUpTime: 'boot', productKey: 'HARNESS-SECRET-KEY' } }; },
  listProcesses: async () => { adminCalls.push('listProcesses'); return { ok: true, action: 'GET_PROCESS_LIST', processes: Array.from({ length: 5_000 },
    (_, index) => ({ pid: 5_000 - index, name: `proc-${5_000 - index}`, memoryBytes: 4096, cpuSeconds: 0.25, commandLine: 'HARNESS-SECRET-CMD' })) }; },
  getServiceStatus: async () => { adminCalls.push('getServiceStatus'); return { ok: true, action: 'GET_SERVICE_STATUS', services: Array.from({ length: 900 },
    (_, index) => ({ name: `svc${String(index).padStart(4, '0')}`, displayName: 'S'.repeat(300), state: 'Running', startMode: 'Auto', pathName: 'HARNESS-SECRET-PATH' })) }; },
  getNetworkStatus: async () => { adminCalls.push('getNetworkStatus'); return { ok: true, action: 'GET_NETWORK_STATUS', interfaces: [{ description: 'Harness NIC',
    macAddress: 'AA:BB:CC:00:11:22', dhcpEnabled: false, addresses: ['192.168.50.2'], gateways: ['192.168.50.1'], dnsServers: [], wifiKey: 'HARNESS-SECRET-WIFI' }] }; },
  getDiskStatus: async () => { adminCalls.push('getDiskStatus'); return { ok: true, action: 'GET_DISK_STATUS', disks: [{ drive: 'C:', filesystem: 'NTFS', totalBytes: 1000, freeBytes: 400 }] }; },
  ...Object.fromEntries(Object.entries(V1_ACTIONS).map(([method, action]) => [method, async () => { adminCalls.push(method); return { ok: true, action, accepted: true }; }])),
};
const adminApprovalProvider = { request(request) {
  if (adminApprovalMode === 'unavailable') return { ok: false };
  adminApprovals.set(request.operationId, request);
  return { ok: true, cancel: () => { request.cancelled = true; } };
} };
const adminLimits = process.env.OMEGA_HARNESS_ADMIN_FAST === '1' ? { highImpactMinIntervalMs: 0, approvalTimeoutMs: 3_000 } : undefined;
app.route('/api', createOmegaOutboundRoute({ certificateFingerprint, outboundViewManager, outboundInteractiveManager,
  adminExecutor, adminApprovalProvider, adminLimits,
  adminIndicatorProvider: { showSessionIndicator: async () => ({ ok: true }) } }));
const server = serve({
  fetch: app.fetch, hostname: '127.0.0.1', port: 0,
  createServer: (_, handler) => https.createServer({ key: keyPem, cert: certificatePem }, handler),
}, () => {
  process.send?.({ type: 'ready', port: server.address().port, host });
});

process.on('message', message => {
  if (message?.type === 'revoke-controller') {
    outboundInteractiveManager.stopForController(process.env.OMEGA_HARNESS_CONTROLLER_ID, 'controller_revoked').then(() => {
      process.send?.({ type: 'revoked', changed: revokeInboundTrust(process.env.OMEGA_HARNESS_CONTROLLER_ID) });
    });
  } else if (message?.type === 'restore-controller') {
    const restored = upsertInboundTrust({ ...controllerTrust, createdAt: new Date().toISOString() });
    process.send?.({ type: 'restored', controllerDeviceId: restored.controller_device_id });
  } else if (message?.type === 'remote-stop') {
    const changed = endSession(message.sessionId, 'remote_stop');
    outboundInteractiveManager.stop(message.sessionId, 'remote_stop', { stopView: true }).then(() => {
      process.send?.({ type: 'remote-stopped', changed });
    });
  } else if (message?.type === 'remote-view-stop') {
    outboundViewManager.stop(message.sessionId, 'remote_local_stop').then(result => {
      process.send?.({ type: 'remote-view-stopped', result });
    });
  } else if (message?.type === 'expire-session') {
    process.send?.({ type: 'expired', changed: expireSession(message.sessionId) });
  } else if (message?.type === 'admin-approval-mode') {
    adminApprovalMode = message.mode === 'unavailable' ? 'unavailable' : 'manual';
    process.send?.({ type: 'admin-approval-mode-set', mode: adminApprovalMode });
  } else if (message?.type === 'admin-pending') {
    process.send?.({ type: 'admin-pending-result', pending: [...adminApprovals.values()].map(request => ({
      operationId: request.operationId, sessionId: request.sessionId, controllerDeviceId: request.controllerDeviceId,
      actionType: request.actionType, cancelled: request.cancelled === true })) });
  } else if (message?.type === 'admin-decide') {
    const request = adminApprovals.get(message.operationId);
    if (request) request.onDecision(message.decision, { operationId: request.operationId, sessionId: request.sessionId,
      controllerDeviceId: request.controllerDeviceId, actionType: request.actionType, approvalNonce: request.approvalNonce,
      ...(message.override ?? {}) });
    setTimeout(() => process.send?.({ type: 'admin-decided', found: !!request, calls: [...adminCalls] }), 50);
  } else if (message?.type === 'admin-calls') {
    process.send?.({ type: 'admin-calls-result', calls: [...adminCalls] });
  } else if (message?.type === 'input-events') {
    process.send?.({ type: 'input-events-result', events: inputEvents });
  } else if (message?.type === 'drop' || message?.type === 'shutdown') {
    server.close(() => {
      process.send?.({ type: 'closed' });
      process.exit(0);
    });
  }
});
