// DEVICE FABRIC Phase 2 — inventory, explicit linking, read-only agent
// projections, status/capability aggregation and trust separation.
// Agent records are seeded in an isolated test DB through the agents' own
// store helpers; Device Fabric itself only ever reads them.
// Run with: node --test test-device-fabric-core.mjs
import './test-setup.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  createRassilonSession, getDatabase, getRassilonLocalDevice, getRassilonSettings, initSqlite, insertOmegaDevice,
  listRassilonIdentities, revokeOmegaDevice, revokeRassilonDevice, setRassilonLocalDevice, updateRassilonDevicePresence,
  upsertRassilonDevice, upsertRassilonIdentity, upsertRassilonOutboundSession,
} from './src/lib/sqlite.js';
import {
  computeDeviceState, createFabricDevice, getFabricDeviceView, linkAgent, listAgentsForFabric, listFabricAuditEvents,
  listFabricDeviceViews, removeFabricDevice, renameFabricDevice, unlinkAgent, validateDisplayName,
} from './src/lib/device-fabric.js';
import { OMEGA_CAPABILITY_LEVELS, RASSILON_CAPABILITY_PERMISSIONS } from './src/lib/device-fabric-agents.js';
import { OMEGA_PERMISSION_LEVELS } from './src/lib/omega-pairing.js';
import { EXECUTOR_PERMISSION } from './src/lib/rassilon-lan-auth.js';
import { enableRassilon, resetRassilonWorkerForTests, __forceErrorStateForTests } from './src/lib/rassilon-worker.js';
import { initRassilonScratch } from './src/lib/rassilon-scratch.js';

const TEST_ROOT = './data-test-device-fabric-core';

function keyPair() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const fingerprint = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { publicKeyPem, fingerprint };
}

let seq = 0;
function omegaDevice({ name = 'Laptop', level = 3, key = keyPair() } = {}) {
  const id = `omega-dev-${++seq}`;
  insertOmegaDevice({ id, display_name: name, public_key_pem: key.publicKeyPem, fingerprint: key.fingerprint, permission_level: level });
  return { id, fingerprint: key.fingerprint, key };
}

function rassilonDevice({ role = 'WORKER', permissions = ['RASSILON_COMPUTE_SAFE', 'RASSILON_EMBEDDING'], key = keyPair(), name = 'GPU box' } = {}) {
  const deviceId = `rassilon-dev-${String(++seq).padStart(4, '0')}`;
  upsertRassilonDevice({
    deviceId, displayName: name, publicKeyPem: key.publicKeyPem, fingerprint: key.fingerprint, role, permissionSet: permissions,
    endpointHost: '192.168.1.40', endpointPort: 3443, tlsCertificatePem: null, tlsCertificateFingerprint: null,
    capabilities: {}, status: 'OFFLINE',
  });
  return { deviceId, fingerprint: key.fingerprint, key };
}

function markOnline(deviceId, executors = ['SAFE_CPU_TASK', 'EMBEDDING_BATCH'], at = new Date().toISOString()) {
  updateRassilonDevicePresence(deviceId, { status: 'ONLINE', capabilities: { safeExecutorTypes: executors }, lastSeenAt: at });
}

function outboundSession(deviceId, ttlMs = 600_000) {
  upsertRassilonOutboundSession({ workerDeviceId: deviceId, sessionId: `out-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + ttlMs).toISOString() });
}

function agentTablesSnapshot() {
  const db = getDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'omega\\_%' ESCAPE '\\' OR name LIKE 'rassilon\\_%' ESCAPE '\\') ORDER BY name").all();
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

function capability(view, agentType, name, direction = null) {
  const block = view.agents[agentType].directions.find(d => direction === null || d.direction === direction);
  return block.capabilities.find(cap => cap.name === name);
}

function newDevice(name) {
  return createFabricDevice({ displayName: `${name} ${++seq}` });
}

before(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  initSqlite(`${TEST_ROOT}/test.db`);
  initRassilonScratch(`${TEST_ROOT}/scratch`);
  getRassilonSettings(); // RASSILON's own boot creates this row; do the same before snapshots.
});

// ── Model / constants ──────────────────────────────────────────────────────

test('capability mirrors equal the frozen agents\' own constants', () => {
  assert.deepEqual({ ...OMEGA_CAPABILITY_LEVELS }, { ...OMEGA_PERMISSION_LEVELS });
  assert.deepEqual({ ...RASSILON_CAPABILITY_PERMISSIONS }, { ...EXECUTOR_PERMISSION });
});

test('create / get / list / rename / delete a fabric device', () => {
  const created = createFabricDevice({ displayName: '  PC   Bureau  ' });
  assert.match(created.fabricDeviceId, /^fdev-[0-9a-f-]{36}$/);
  assert.equal(created.displayName, 'PC Bureau');
  assert.equal(created.state, 'UNKNOWN');
  assert.deepEqual(created.agents, { OMEGA: null, RASSILON: null });
  assert.equal(getFabricDeviceView(created.fabricDeviceId).displayName, 'PC Bureau');
  assert.ok(listFabricDeviceViews().some(d => d.fabricDeviceId === created.fabricDeviceId));
  assert.equal(renameFabricDevice(created.fabricDeviceId, { displayName: 'PC Salon' }).displayName, 'PC Salon');
  assert.deepEqual(removeFabricDevice(created.fabricDeviceId), { fabricDeviceId: created.fabricDeviceId, removed: true, unlinkedAgents: [] });
  assert.throws(() => getFabricDeviceView(created.fabricDeviceId), /fabric_device_not_found/);
  assert.ok(!listFabricDeviceViews().some(d => d.fabricDeviceId === created.fabricDeviceId));
});

test('fabricDeviceId is random and never derived from a name or agent id', () => {
  const ids = new Set(Array.from({ length: 20 }, (_, i) => createFabricDevice({ displayName: `Machine ${i}` }).fabricDeviceId));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.doesNotMatch(id, /machine|omega|rassilon|192\.168/i);
});

test('displayName validation: length, charset, duplicates, XSS payloads rejected', () => {
  assert.equal(validateDisplayName('Portable de Léa (2e)'), 'Portable de Léa (2e)');
  for (const bad of ['', '   ', 'x'.repeat(65), '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a"b', 'tab\there', 'rtl‮evil', 'zero\u0000']) {
    assert.throws(() => validateDisplayName(bad), /display_name_/, JSON.stringify(bad));
  }
  assert.throws(() => validateDisplayName(42), /display_name_required/);
  createFabricDevice({ displayName: 'Unique Name' });
  assert.throws(() => createFabricDevice({ displayName: 'unique name' }), /display_name_taken/);
});

// ── Linking ────────────────────────────────────────────────────────────────

test('explicit OMEGA and RASSILON linking, one of each on the same device', () => {
  const device = newDevice('Both');
  const omega = omegaDevice();
  const rassilon = rassilonDevice();
  const afterOmega = linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint });
  assert.equal(afterOmega.agents.OMEGA.agentDeviceId, omega.id);
  assert.equal(afterOmega.agents.RASSILON, null);
  const both = linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: rassilon.deviceId, confirmFingerprint: rassilon.fingerprint.toUpperCase() });
  assert.equal(both.agents.RASSILON.agentDeviceId, rassilon.deviceId);
  assert.equal(both.agents.OMEGA.linkState, 'OK');
  assert.equal(both.agents.RASSILON.linkState, 'OK');
});

test('link requires the exact fingerprint confirmation', () => {
  const device = newDevice('Confirm');
  const omega = omegaDevice();
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: keyPair().fingerprint }), /fingerprint_confirmation_mismatch/);
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id }), /confirm_fingerprint_invalid/);
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'SHELL', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint }), /agent_type_invalid/);
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: '../etc', confirmFingerprint: omega.fingerprint }), /agent_device_id_invalid/);
  assert.equal(getFabricDeviceView(device.fabricDeviceId).agents.OMEGA, null);
});

test('same key in OMEGA and RASSILON: link rejected as cross_agent_key_reuse and audited', () => {
  const shared = keyPair();
  const omega = omegaDevice({ key: shared });
  const rassilon = rassilonDevice({ key: shared });
  const device = newDevice('Reuse');
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: shared.fingerprint }), /cross_agent_key_reuse/);
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: rassilon.deviceId, confirmFingerprint: shared.fingerprint }), /cross_agent_key_reuse/);
  const rejected = listFabricAuditEvents({ limit: 20 }).filter(e => e.eventType === 'FABRIC_LINK_REJECTED' && e.fabricDeviceId === device.fabricDeviceId);
  assert.deepEqual(rejected.map(e => e.reason), ['cross_agent_key_reuse', 'cross_agent_key_reuse']);
  assert.deepEqual(getFabricDeviceView(device.fabricDeviceId).agents, { OMEGA: null, RASSILON: null });
});

test('a key that later appears in the other domain turns an existing link into CROSS_AGENT_KEY_REUSE (never trusted)', () => {
  const key = keyPair();
  const omega = omegaDevice({ key });
  const device = newDevice('Late reuse');
  linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: key.fingerprint });
  rassilonDevice({ key });
  const view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.OMEGA.linkState, 'CROSS_AGENT_KEY_REUSE');
  assert.equal(view.agents.OMEGA.trust, 'UNKNOWN');
  assert.deepEqual(view.agents.OMEGA.directions, []);
});

test('duplicate protection: one identity on one device only; one link per agent type per device', () => {
  const first = newDevice('Dup A');
  const second = newDevice('Dup B');
  const omega = omegaDevice();
  const otherOmega = omegaDevice();
  linkAgent(first.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint });
  assert.throws(() => linkAgent(second.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint }), /agent_identity_already_linked/);
  assert.throws(() => linkAgent(first.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: otherOmega.id, confirmFingerprint: otherOmega.fingerprint }), /agent_type_already_linked_on_device/);
  // The database's partial unique indexes enforce the same rule underneath.
  assert.throws(() => getDatabase().prepare(`INSERT INTO fabric_agent_links (link_id, fabric_device_id, agent_type, agent_device_id, agent_fingerprint, link_status, linked_at)
    VALUES ('flnk-dup', ?, 'OMEGA', ?, ?, 'ACTIVE', 'now')`).run(second.fabricDeviceId, omega.id, omega.fingerprint), /UNIQUE/);
});

test('missing agent identity: link rejected and no agent record is created', () => {
  const device = newDevice('Missing');
  const before = agentTablesSnapshot();
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: 'omega-does-not-exist', confirmFingerprint: 'a'.repeat(64) }), /agent_identity_not_found/);
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: 'rassilon-does-not-exist', confirmFingerprint: 'a'.repeat(64) }), /agent_identity_not_found/);
  assert.equal(agentTablesSnapshot(), before);
});

test('revoked identity: new link rejected; an existing link stays visible as REVOKED with AVAILABLE = NO', () => {
  const device = newDevice('Revoked');
  const revokedEarly = omegaDevice();
  revokeOmegaDevice(revokedEarly.id);
  assert.throws(() => linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: revokedEarly.id, confirmFingerprint: revokedEarly.fingerprint }), /agent_identity_revoked/);

  const worker = rassilonDevice();
  markOnline(worker.deviceId);
  outboundSession(worker.deviceId);
  linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  assert.equal(getFabricDeviceView(device.fabricDeviceId).agents.RASSILON.trust, 'TRUSTED');
  revokeRassilonDevice(worker.deviceId);
  const view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.RASSILON.linkState, 'OK');
  assert.equal(view.agents.RASSILON.trust, 'REVOKED');
  assert.equal(view.agents.RASSILON.availability, 'UNAVAILABLE');
  assert.ok(view.agents.RASSILON.directions[0].capabilities.every(cap => cap.available === 'NO' && cap.authorized === 'NO'));
  assert.equal(view.state, 'OFFLINE');
});

test('stale links: identity removed → MISSING, key changed → FINGERPRINT_MISMATCH; never auto-deleted', () => {
  const device = newDevice('Stale');
  const worker = rassilonDevice();
  linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  const other = keyPair();
  upsertRassilonDevice({ deviceId: worker.deviceId, displayName: 'GPU box', publicKeyPem: other.publicKeyPem, fingerprint: other.fingerprint, role: 'WORKER', permissionSet: [], capabilities: {}, status: 'OFFLINE' });
  let view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.RASSILON.linkState, 'FINGERPRINT_MISMATCH');
  assert.equal(view.agents.RASSILON.trust, 'UNKNOWN');

  const omega = omegaDevice();
  linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint });
  getDatabase().prepare('DELETE FROM omega_devices WHERE id = ?').run(omega.id); // simulate an identity that no longer exists
  view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.OMEGA.linkState, 'MISSING');
  assert.equal(view.agents.OMEGA.trust, 'UNKNOWN');
  assert.equal(view.agents.OMEGA.availability, 'UNAVAILABLE');
});

test('unlink and removal only touch fabric_*: agent identities, keys and sessions untouched', () => {
  const device = newDevice('Untouched');
  const omega = omegaDevice();
  const worker = rassilonDevice();
  outboundSession(worker.deviceId);
  createRassilonSession({ sessionId: `in-${crypto.randomUUID()}`, deviceId: worker.deviceId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint });
  linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  const before = agentTablesSnapshot();
  unlinkAgent(device.fabricDeviceId, 'OMEGA');
  assert.equal(getFabricDeviceView(device.fabricDeviceId).agents.OMEGA, null);
  assert.throws(() => removeFabricDevice(device.fabricDeviceId), /removal_requires_link_confirmation/);
  assert.deepEqual(removeFabricDevice(device.fabricDeviceId, { confirm: 'REMOVE_LINKS' }).unlinkedAgents, ['RASSILON']);
  assert.equal(agentTablesSnapshot(), before);
  assert.throws(() => unlinkAgent(device.fabricDeviceId, 'OMEGA'), /fabric_device_not_found/);
});

test('no auto-link: same IP, same hostname-like name, same displayName never create a link', () => {
  const device = createFabricDevice({ displayName: 'Salon Box' });
  omegaDevice({ name: 'Salon Box' });
  rassilonDevice({ name: 'Salon Box' }); // same endpoint IP as every seeded worker
  rassilonDevice({ name: 'Salon Box' });
  assert.deepEqual(getFabricDeviceView(device.fabricDeviceId).agents, { OMEGA: null, RASSILON: null });
  assert.ok(listFabricDeviceViews().every(d => d.fabricDeviceId !== device.fabricDeviceId || (d.agents.OMEGA === null && d.agents.RASSILON === null)));
});

test('agent enumeration is read-only: no RASSILON identity is created when none exists', () => {
  assert.equal(getRassilonLocalDevice(), null);
  const before = agentTablesSnapshot();
  const agents = listAgentsForFabric();
  listFabricDeviceViews();
  assert.equal(getRassilonLocalDevice(), null);
  assert.equal(agentTablesSnapshot(), before);
  assert.ok(agents.OMEGA.length > 0 && agents.RASSILON.length > 0);
  const serialized = JSON.stringify(agents);
  assert.doesNotMatch(serialized, /publicKeyPem|PUBLIC KEY|tlsCertificate|endpointHost|192\.168|sessionId|nonce|_permissionSet|_presenceInput|_advertised/);
  const omegaFields = Object.keys(agents.OMEGA[0]).sort();
  assert.deepEqual(omegaFields, ['agentDeviceId', 'agentType', 'displayName', 'fingerprint', 'lastSessionAt', 'linkedFabricDeviceId', 'permissionLevel', 'revokedAt', 'role', 'trust']);
});

// ── Status / capabilities ──────────────────────────────────────────────────

test('device state rule: none/UNKNOWN, ONLINE, PARTIAL, OFFLINE, ERROR', () => {
  assert.equal(computeDeviceState([]), 'UNKNOWN');
  assert.equal(computeDeviceState(['AVAILABLE']), 'ONLINE');
  assert.equal(computeDeviceState(['AVAILABLE', 'AVAILABLE']), 'ONLINE');
  assert.equal(computeDeviceState(['UNKNOWN', 'AVAILABLE']), 'PARTIAL');
  assert.equal(computeDeviceState(['UNAVAILABLE', 'AVAILABLE']), 'PARTIAL');
  assert.equal(computeDeviceState(['UNAVAILABLE']), 'OFFLINE');
  assert.equal(computeDeviceState(['UNAVAILABLE', 'UNKNOWN']), 'UNKNOWN');
  assert.equal(computeDeviceState(['UNKNOWN']), 'UNKNOWN');
  assert.equal(computeDeviceState(['ERROR', 'AVAILABLE']), 'ERROR');
});

test('OMEGA only: availability UNKNOWN (no live projection), never ONLINE; never routable (no OMEGA client)', () => {
  const device = newDevice('Omega only');
  const omega = omegaDevice({ level: 2 });
  const view = linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint });
  assert.equal(view.state, 'UNKNOWN');
  const link = view.agents.OMEGA;
  assert.equal(link.trust, 'TRUSTED');
  assert.equal(link.availability, 'UNKNOWN');
  assert.equal(link.routable, false);
  assert.equal(link.routingStatus, 'NOT_ROUTABLE');
  assert.equal(link.directions[0].direction, 'REMOTE_ACTS_ON_THIS_PC');
  assert.equal(capability(view, 'OMEGA', 'OMEGA_VIEW').authorized, 'YES');
  assert.equal(capability(view, 'OMEGA', 'OMEGA_INTERACTIVE').authorized, 'YES');
  assert.equal(capability(view, 'OMEGA', 'OMEGA_ADMIN').authorized, 'NO');
  for (const cap of link.directions[0].capabilities) {
    assert.equal(cap.available, 'UNKNOWN');
    assert.equal(cap.routable, false);
    assert.equal(cap.supported, process.platform === 'win32' ? 'YES' : 'NO');
  }
});

test('RASSILON worker: SUPPORTED / AUTHORIZED / AVAILABLE stay three distinct values', () => {
  const device = newDevice('Worker');
  const worker = rassilonDevice({ permissions: ['RASSILON_EMBEDDING'] });
  let view = linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  // Never refreshed, no session: nothing can be sent → UNAVAILABLE; advertised executors unknown.
  assert.equal(view.agents.RASSILON.availability, 'UNAVAILABLE');
  assert.deepEqual(capability(view, 'RASSILON', 'EMBEDDING_BATCH'), { name: 'EMBEDDING_BATCH', supported: 'UNKNOWN', authorized: 'YES', available: 'NO', routable: false });
  assert.equal(view.agents.RASSILON.routingStatus, 'NOT_AVAILABLE');
  assert.equal(view.state, 'OFFLINE');

  outboundSession(worker.deviceId);
  markOnline(worker.deviceId, ['SAFE_CPU_TASK', 'EMBEDDING_BATCH']);
  view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.RASSILON.directions[0].direction, 'THIS_PC_SENDS_COMPUTE');
  assert.equal(view.agents.RASSILON.availability, 'AVAILABLE');
  assert.equal(view.state, 'ONLINE');
  // Phase 3: routable only because all three are YES, towards a worker.
  assert.deepEqual(capability(view, 'RASSILON', 'EMBEDDING_BATCH'), { name: 'EMBEDDING_BATCH', supported: 'YES', authorized: 'YES', available: 'YES', routable: true });
  assert.equal(view.agents.RASSILON.routingStatus, 'READY');
  // Supported by the worker but NOT authorized by it: available stays NO.
  assert.deepEqual(capability(view, 'RASSILON', 'SAFE_CPU_TASK'), { name: 'SAFE_CPU_TASK', supported: 'YES', authorized: 'NO', available: 'NO', routable: false });

  markOnline(worker.deviceId, ['SAFE_CPU_TASK']);
  view = getFabricDeviceView(device.fabricDeviceId);
  assert.deepEqual(capability(view, 'RASSILON', 'EMBEDDING_BATCH'), { name: 'EMBEDDING_BATCH', supported: 'NO', authorized: 'YES', available: 'NO', routable: false });
});

test('no false ONLINE: a session with a stale presence is UNKNOWN, not AVAILABLE', () => {
  const device = newDevice('Stale presence');
  const worker = rassilonDevice();
  outboundSession(worker.deviceId);
  markOnline(worker.deviceId, ['SAFE_CPU_TASK', 'EMBEDDING_BATCH'], new Date(Date.now() - 45_000).toISOString());
  let view = linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  assert.equal(view.agents.RASSILON.availability, 'UNKNOWN');
  assert.equal(view.state, 'UNKNOWN');
  assert.equal(capability(view, 'RASSILON', 'EMBEDDING_BATCH').available, 'UNKNOWN');
  markOnline(worker.deviceId, ['SAFE_CPU_TASK', 'EMBEDDING_BATCH'], new Date(Date.now() - 5_000).toISOString());
  view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.RASSILON.availability, 'AVAILABLE');
  outboundSession(worker.deviceId, -1_000); // expired session
  view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.RASSILON.availability, 'UNAVAILABLE');
});

test('PARTIAL: OMEGA UNKNOWN + RASSILON AVAILABLE', () => {
  const device = newDevice('Partial');
  const omega = omegaDevice();
  const worker = rassilonDevice();
  outboundSession(worker.deviceId);
  markOnline(worker.deviceId);
  linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint });
  const view = linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  assert.equal(view.agents.OMEGA.availability, 'UNKNOWN');
  assert.equal(view.agents.RASSILON.availability, 'AVAILABLE');
  assert.equal(view.state, 'PARTIAL');
});

test('trust separation: OMEGA trusted + RASSILON revoked, and the reverse, never inherit', () => {
  const first = newDevice('Trust A');
  const omegaOk = omegaDevice();
  const workerRevoked = rassilonDevice();
  linkAgent(first.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omegaOk.id, confirmFingerprint: omegaOk.fingerprint });
  linkAgent(first.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: workerRevoked.deviceId, confirmFingerprint: workerRevoked.fingerprint });
  revokeRassilonDevice(workerRevoked.deviceId);
  let view = getFabricDeviceView(first.fabricDeviceId);
  assert.equal(view.agents.OMEGA.trust, 'TRUSTED');
  assert.equal(view.agents.RASSILON.trust, 'REVOKED');
  assert.ok(!('trust' in view), 'no global device trust');

  const second = newDevice('Trust B');
  const omegaRevoked = omegaDevice({ level: 3 });
  const workerOk = rassilonDevice();
  outboundSession(workerOk.deviceId);
  markOnline(workerOk.deviceId);
  linkAgent(second.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omegaRevoked.id, confirmFingerprint: omegaRevoked.fingerprint });
  linkAgent(second.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: workerOk.deviceId, confirmFingerprint: workerOk.fingerprint });
  revokeOmegaDevice(omegaRevoked.id);
  view = getFabricDeviceView(second.fabricDeviceId);
  assert.equal(view.agents.OMEGA.trust, 'REVOKED');
  assert.ok(view.agents.OMEGA.directions[0].capabilities.every(cap => cap.authorized === 'NO' && cap.available === 'NO'));
  assert.equal(view.agents.RASSILON.trust, 'TRUSTED');
  assert.equal(view.state, 'PARTIAL');
});

test('permission separation: OMEGA ADMIN grants nothing to RASSILON and RASSILON grants nothing to OMEGA', () => {
  const device = newDevice('Perms');
  const omega = omegaDevice({ level: 3 });
  const worker = rassilonDevice({ permissions: [] });
  outboundSession(worker.deviceId);
  markOnline(worker.deviceId);
  linkAgent(device.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omega.id, confirmFingerprint: omega.fingerprint });
  const view = linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: worker.deviceId, confirmFingerprint: worker.fingerprint });
  assert.ok(view.agents.RASSILON.directions[0].capabilities.every(cap => cap.authorized === 'NO' && cap.available === 'NO'));

  const second = newDevice('Perms reverse');
  const viewer = omegaDevice({ level: 1 });
  const richWorker = rassilonDevice();
  linkAgent(second.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: richWorker.deviceId, confirmFingerprint: richWorker.fingerprint });
  const reverse = linkAgent(second.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: viewer.id, confirmFingerprint: viewer.fingerprint });
  assert.equal(capability(reverse, 'OMEGA', 'OMEGA_ADMIN').authorized, 'NO');
  assert.equal(capability(reverse, 'OMEGA', 'OMEGA_INTERACTIVE').authorized, 'NO');
});

test('RASSILON controller direction: device sends compute to THIS PC, gated by local policy', () => {
  resetRassilonWorkerForTests();
  const device = newDevice('Controller');
  const controller = rassilonDevice({ role: 'CONTROLLER', permissions: ['RASSILON_EMBEDDING'] });
  createRassilonSession({ sessionId: `in-${crypto.randomUUID()}`, deviceId: controller.deviceId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  markOnline(controller.deviceId, []);
  let view = linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: controller.deviceId, confirmFingerprint: controller.fingerprint });
  assert.equal(view.agents.RASSILON.directions[0].direction, 'DEVICE_SENDS_COMPUTE');
  // Local worker disabled → nothing can run here, whatever the remote grant.
  assert.equal(view.agents.RASSILON.availability, 'UNAVAILABLE');
  assert.equal(capability(view, 'RASSILON', 'EMBEDDING_BATCH').authorized, 'NO', 'local acceptedJobTypes is empty');

  enableRassilon({ maxCpuPercent: 25, maxRamMb: 2048, maxConcurrentJobs: 1, maxJobDurationSec: 300, maxScratchMb: 1024, pauseOnBattery: false, minimumBatteryPercent: 30, pauseWhenUserActive: false, acceptedJobTypes: ['EMBEDDING_BATCH'] });
  view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.RASSILON.availability, 'AVAILABLE');
  assert.deepEqual(capability(view, 'RASSILON', 'EMBEDDING_BATCH'), { name: 'EMBEDDING_BATCH', supported: 'YES', authorized: 'YES', available: 'YES', routable: false });
  assert.equal(capability(view, 'RASSILON', 'SAFE_CPU_TASK').authorized, 'NO');

  __forceErrorStateForTests();
  view = getFabricDeviceView(device.fabricDeviceId);
  assert.equal(view.agents.RASSILON.availability, 'ERROR');
  assert.equal(view.state, 'ERROR');
  resetRassilonWorkerForTests();
});

test('local RASSILON identity is linkable read-only (role RASSILON_LOCAL) once RASSILON itself created it', () => {
  const key = keyPair();
  setRassilonLocalDevice({ deviceId: 'rassilon-local-fabric-test', displayName: 'Ce PC' });
  upsertRassilonIdentity({ deviceId: 'rassilon-local-fabric-test', publicKeyPem: key.publicKeyPem, fingerprint: key.fingerprint });
  const identities = listRassilonIdentities().length;
  const local = listAgentsForFabric().RASSILON.find(a => a.agentDeviceId === 'rassilon-local-fabric-test');
  assert.equal(local.role, 'RASSILON_LOCAL');
  const device = newDevice('Ce PC');
  const view = linkAgent(device.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: local.agentDeviceId, confirmFingerprint: key.fingerprint });
  assert.equal(view.agents.RASSILON.directions[0].direction, 'LOCAL_WORKER');
  assert.equal(view.agents.RASSILON.availability, 'UNAVAILABLE'); // worker disabled
  assert.equal(listRassilonIdentities().length, identities);
});

test('audit: closed enum, bounded fields, no secrets', () => {
  const events = listFabricAuditEvents({ limit: 500 });
  const allowed = ['FABRIC_DEVICE_CREATED', 'FABRIC_DEVICE_RENAMED', 'FABRIC_DEVICE_REMOVED', 'FABRIC_AGENT_LINKED', 'FABRIC_AGENT_UNLINKED', 'FABRIC_LINK_REJECTED'];
  assert.ok(events.length > 10);
  for (const event of events) {
    assert.ok(allowed.includes(event.eventType), event.eventType);
    assert.deepEqual(Object.keys(event).sort(), ['agentDeviceId', 'agentType', 'correlationId', 'createdAt', 'eventType', 'fabricDeviceId', 'id', 'operationId', 'reason']);
  }
  for (const type of allowed) assert.ok(events.some(e => e.eventType === type), `${type} recorded`);
  assert.doesNotMatch(JSON.stringify(events), /PUBLIC KEY|PRIVATE|session|nonce|token|[0-9a-f]{64}/i);
  assert.throws(() => getDatabase().prepare("INSERT INTO fabric_audit (created_at, event_type) VALUES ('now', 'ARBITRARY')").run(), /CHECK/);
});
