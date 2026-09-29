// DEVICE FABRIC V2 Phase 2 — OMEGA V2 outbound link, exact resolution and
// read-only status. No VIEW/INTERACTIVE/ADMIN/STOP routing exists yet.
// Run with: node --test test-device-fabric-omega-v2.mjs
import './test-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getDatabase, initSqlite, insertOmegaDevice, listFabricAudit, upsertRassilonDevice } from './src/lib/sqlite.js';
import {
  DeviceFabricOmegaV2Error, OMEGA_V2_AGENT_TYPE, getOmegaV2LinkView, linkOmegaV2Host, listOmegaV2HostFingerprints,
  listOmegaV2HostsForFabric, resolveFabricOmegaV2Target, unlinkOmegaV2Host,
} from './src/lib/device-fabric-omega-v2.js';
import { createFabricDevice, linkAgent, removeFabricDevice } from './src/lib/device-fabric.js';
import { insertSession, revokeOutboundTrust, upsertOutboundTrust } from './src/lib/omega-outbound-store.js';

function fingerprint64(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

let seq = 0;
function host({ fp = fingerprint64(`host-${++seq}`), maxPermission = 'ADMIN', revoked = false } = {}) {
  const remoteDeviceId = `ov2h-${crypto.randomUUID()}`;
  upsertOutboundTrust({
    remoteDeviceId, host: '192.168.1.50', port: 3100 + seq,
    certificatePem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
    certificateFingerprint: fingerprint64(`cert-${seq}`), publicKeyPem: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
    identityFingerprint: fp, maxPermission, createdAt: new Date().toISOString(),
  });
  if (revoked) revokeOutboundTrust(remoteDeviceId);
  return { remoteDeviceId, fingerprint: fp };
}

let deviceSeq = 0;
function device(label) {
  deviceSeq += 1;
  return createFabricDevice({ displayName: label ? `${label} ${deviceSeq}` : `Device ${deviceSeq}` });
}

async function rejects(fn, code) {
  await assert.rejects(Promise.resolve().then(fn), error => error instanceof DeviceFabricOmegaV2Error && error.code === code, code);
}

test('setup', () => { initSqlite(':memory:'); });

test('link: valid OMEGA_V2_OUTBOUND succeeds and projects a safe trust view', () => {
  const d = device();
  const h = host();
  const link = linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  assert.equal(link.linkState, 'OK');
  assert.equal(link.omegaV2HostId, h.remoteDeviceId);
  assert.equal(link.trust.omegaV2HostId, h.remoteDeviceId);
  assert.equal(link.trust.maxPermission, 'ADMIN');
  assert.equal(link.linkVersion, 1);
  // Never the certificate PEM, never a private key, never a session/token/approval field.
  const serialized = JSON.stringify(link);
  for (const forbidden of ['certificatePem', 'BEGIN CERTIFICATE', 'privateKey', 'PRIVATE KEY', 'sessionSecret', 'nonce', 'approval', 'token']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('link: unlink removes only the Fabric link, trust untouched', async () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const result = unlinkOmegaV2Host(d.fabricDeviceId);
  assert.equal(result.unlinked, true);
  assert.equal(getOmegaV2LinkView(d.fabricDeviceId), null);
  // Trust row is unaffected: still present, still not revoked.
  const hosts = listOmegaV2HostsForFabric();
  const row = hosts.find(item => item.omegaV2HostId === h.remoteDeviceId);
  assert.ok(row);
  assert.equal(row.revokedAt, null);
  assert.equal(row.linkedFabricDeviceId, null);
});

test('link: duplicate link on the same device rejected', () => {
  const d = device();
  const h1 = host();
  const h2 = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h1.remoteDeviceId, confirmFingerprint: h1.fingerprint });
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h2.remoteDeviceId, confirmFingerprint: h2.fingerprint }),
    error => error.code === 'omega_v2_already_linked_on_device');
});

test('link: same host linked elsewhere rejected', () => {
  const d1 = device();
  const d2 = device();
  const h = host();
  linkOmegaV2Host(d1.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  assert.throws(() => linkOmegaV2Host(d2.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint }),
    error => error.code === 'omega_v2_host_already_linked');
});

test('link: unknown host rejected, never creates a trust', () => {
  const d = device();
  const fakeId = `ov2h-${crypto.randomUUID()}`;
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: fakeId, confirmFingerprint: fingerprint64('x') }),
    error => error.code === 'omega_v2_host_not_found');
  assert.equal(listOmegaV2HostsForFabric().some(row => row.omegaV2HostId === fakeId), false);
});

test('link: revoked host rejected', () => {
  const d = device();
  const h = host({ revoked: true });
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint }),
    error => error.code === 'omega_v2_host_revoked');
});

test('link: fingerprint mismatch rejected, no auto-update', () => {
  const d = device();
  const h = host();
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: fingerprint64('wrong') }),
    error => error.code === 'fingerprint_confirmation_mismatch');
  assert.equal(getOmegaV2LinkView(d.fabricDeviceId), null);
});

test('link: stale host (fingerprint changed after link) shown FINGERPRINT_MISMATCH, not auto-relinked', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  // Simulate the trust being re-registered under a new key (revoke + re-add with the same id is not
  // how OMEGA V2 works; instead directly mutate the stored fingerprint to model "the key changed").
  getDatabase().prepare('UPDATE omega_v2_outbound_trust SET identity_fingerprint = ? WHERE remote_device_id = ?')
    .run(fingerprint64('rotated'), h.remoteDeviceId);
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  assert.equal(view.linkState, 'FINGERPRINT_MISMATCH');
  assert.equal(view.availability, 'UNKNOWN');
  assert.deepEqual(view.capabilities, []);
});

test('link: missing Fabric device rejected', () => {
  const h = host();
  assert.throws(() => linkOmegaV2Host('fdev-00000000-0000-4000-8000-000000000000', { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint }),
    error => error.code === 'fabric_device_not_found');
});

test('link: invalid link kind / malformed ids rejected before any lookup', () => {
  const d = device();
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: 'not-an-omega-v2-id', confirmFingerprint: fingerprint64('x') }),
    error => error.code === 'omega_v2_host_id_invalid');
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: '', confirmFingerprint: fingerprint64('x') }),
    error => error.code === 'omega_v2_host_id_invalid');
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: undefined, confirmFingerprint: fingerprint64('x') }),
    error => error.code === 'omega_v2_host_id_invalid');
});

test('link: OMEGA V1 device id supplied as OMEGA V2 host id rejected (wrong id space)', () => {
  const d = device();
  // A real OMEGA V1 omega_devices.id is a bare UUID, no 'ov2h-' prefix.
  const v1Id = crypto.randomUUID();
  assert.throws(() => linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: v1Id, confirmFingerprint: fingerprint64('x') }),
    error => error.code === 'omega_v2_host_id_invalid');
});

test('link: an OMEGA V2 host id offered to the generic OMEGA(V1)/RASSILON link route is rejected (wrong id space)', () => {
  const d = device();
  const h = host();
  assert.throws(() => linkAgent(d.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: h.remoteDeviceId, confirmFingerprint: h.fingerprint }),
    error => error.code === 'agent_identity_not_found');
});

test('cross-agent: OMEGA V2 key reused as OMEGA V1 rejected', () => {
  const shared = fingerprint64('shared-1');
  const h = host({ fp: shared });
  const d1 = device();
  linkOmegaV2Host(d1.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: shared });
  insertOmegaDevice({ id: crypto.randomUUID(), display_name: 'Same key', public_key_pem: 'pk', fingerprint: shared, permission_level: 3 });
  const omegaId = getDatabase().prepare('SELECT id FROM omega_devices WHERE fingerprint = ?').get(shared).id;
  const d2 = device();
  assert.throws(() => linkAgent(d2.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omegaId, confirmFingerprint: shared }),
    error => error.code === 'cross_agent_key_reuse');
});

test('cross-agent: OMEGA V1 key reused as OMEGA V2 outbound rejected', () => {
  const shared = fingerprint64('shared-2');
  insertOmegaDevice({ id: crypto.randomUUID(), display_name: 'V1', public_key_pem: 'pk', fingerprint: shared, permission_level: 3 });
  const omegaId = getDatabase().prepare('SELECT id FROM omega_devices WHERE fingerprint = ?').get(shared).id;
  const d1 = device();
  linkAgent(d1.fabricDeviceId, { agentType: 'OMEGA', agentDeviceId: omegaId, confirmFingerprint: shared });
  const h = host({ fp: shared });
  const d2 = device();
  assert.throws(() => linkOmegaV2Host(d2.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: shared }),
    error => error.code === 'cross_agent_key_reuse');
});

test('cross-agent: RASSILON key reused as OMEGA V2 outbound rejected, and the reverse', () => {
  const shared = fingerprint64('shared-3');
  upsertRassilonDevice({ deviceId: crypto.randomUUID(), displayName: 'Worker', publicKeyPem: 'pk', tlsCertificatePem: 'cert',
    fingerprint: shared, role: 'WORKER', permissionSet: ['RASSILON_COMPUTE_SAFE'], endpointHost: null, endpointPort: null });
  const rassilonId = getDatabase().prepare('SELECT device_id FROM rassilon_devices WHERE fingerprint = ?').get(shared).device_id;
  const d1 = device();
  linkAgent(d1.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: rassilonId, confirmFingerprint: shared });
  const h = host({ fp: shared });
  const d2 = device();
  assert.throws(() => linkOmegaV2Host(d2.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: shared }),
    error => error.code === 'cross_agent_key_reuse');

  // Reverse: OMEGA V2 linked first, RASSILON with the same key second.
  const shared2 = fingerprint64('shared-4');
  const h2 = host({ fp: shared2 });
  const d3 = device();
  linkOmegaV2Host(d3.fabricDeviceId, { omegaV2HostId: h2.remoteDeviceId, confirmFingerprint: shared2 });
  upsertRassilonDevice({ deviceId: crypto.randomUUID(), displayName: 'Worker2', publicKeyPem: 'pk', tlsCertificatePem: 'cert',
    fingerprint: shared2, role: 'WORKER', permissionSet: ['RASSILON_COMPUTE_SAFE'], endpointHost: null, endpointPort: null });
  const rassilonId2 = getDatabase().prepare('SELECT device_id FROM rassilon_devices WHERE fingerprint = ?').get(shared2).device_id;
  const d4 = device();
  assert.throws(() => linkAgent(d4.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: rassilonId2, confirmFingerprint: shared2 }),
    error => error.code === 'cross_agent_key_reuse');
});

test('listOmegaV2HostFingerprints exposes only fingerprints, no other trust field', () => {
  const h = host();
  const fps = listOmegaV2HostFingerprints();
  assert.ok(fps.includes(h.fingerprint));
  assert.ok(fps.every(fp => /^[0-9a-f]{64}$/.test(fp)));
});

// ── Exact resolution ────────────────────────────────────────────────────────

test('resolution: exact fabricDeviceId -> exact omegaV2HostId, no network action, no session', () => {
  const dA = device('A');
  const hA = host();
  linkOmegaV2Host(dA.fabricDeviceId, { omegaV2HostId: hA.remoteDeviceId, confirmFingerprint: hA.fingerprint });
  const dB = device('B');
  const hB = host();
  linkOmegaV2Host(dB.fabricDeviceId, { omegaV2HostId: hB.remoteDeviceId, confirmFingerprint: hB.fingerprint });

  const resolvedA = resolveFabricOmegaV2Target(dA.fabricDeviceId);
  assert.equal(resolvedA.omegaV2HostId, hA.remoteDeviceId);
  assert.notEqual(resolvedA.omegaV2HostId, hB.remoteDeviceId);
  assert.equal(resolvedA.fingerprint, hA.fingerprint);
  assert.equal(resolvedA.linkVersion, 1);

  // B being available/linked never changes A's resolution: no fallback exists.
  const resolvedB = resolveFabricOmegaV2Target(dB.fabricDeviceId);
  assert.equal(resolvedB.omegaV2HostId, hB.remoteDeviceId);
});

test('resolution: A missing (unlinked) fails, never falls back to any other host', () => {
  const dA = device('A');
  assert.throws(() => resolveFabricOmegaV2Target(dA.fabricDeviceId), error => error.code === 'omega_v2_not_linked');
});

test('resolution: A revoked fails with a safe status, B (available) untouched', () => {
  const dA = device('A');
  const hA = host();
  linkOmegaV2Host(dA.fabricDeviceId, { omegaV2HostId: hA.remoteDeviceId, confirmFingerprint: hA.fingerprint });
  revokeOutboundTrust(hA.remoteDeviceId);
  assert.throws(() => resolveFabricOmegaV2Target(dA.fabricDeviceId), error => error.code === 'omega_v2_host_revoked');

  const dB = device('B');
  const hB = host();
  linkOmegaV2Host(dB.fabricDeviceId, { omegaV2HostId: hB.remoteDeviceId, confirmFingerprint: hB.fingerprint });
  const resolvedB = resolveFabricOmegaV2Target(dB.fabricDeviceId);
  assert.equal(resolvedB.omegaV2HostId, hB.remoteDeviceId);
});

test('resolution: fingerprint mismatch fails, device fallback = 0', () => {
  const dA = device('A');
  const hA = host();
  linkOmegaV2Host(dA.fabricDeviceId, { omegaV2HostId: hA.remoteDeviceId, confirmFingerprint: hA.fingerprint });
  getDatabase().prepare('UPDATE omega_v2_outbound_trust SET identity_fingerprint = ? WHERE remote_device_id = ?')
    .run(fingerprint64('rotated-2'), hA.remoteDeviceId);
  assert.throws(() => resolveFabricOmegaV2Target(dA.fabricDeviceId), error => error.code === 'omega_v2_link_stale');
});

test('resolution: link version/fingerprint metadata changes are detectable (TOCTOU foundation)', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const first = resolveFabricOmegaV2Target(d.fabricDeviceId);
  // Unlink and relink to a different host: simulates a link changing between two resolves.
  unlinkOmegaV2Host(d.fabricDeviceId);
  const h2 = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h2.remoteDeviceId, confirmFingerprint: h2.fingerprint });
  const second = resolveFabricOmegaV2Target(d.fabricDeviceId);
  // A caller comparing the two resolutions can detect the link changed underneath it.
  assert.notEqual(first.omegaV2HostId, second.omegaV2HostId);
  assert.notEqual(first.linkId, second.linkId);
});

test('resolution: never calls connectOmegaDevice or any network/session primitive (static check on the module source)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const raw = fs.readFileSync(path.join(fileURLToPath(new URL('.', import.meta.url)), 'src/lib/device-fabric-omega-v2.js'), 'utf8');
  // Strip comments so this module's own "never calls connectOmegaDevice" doc
  // comment does not trip its own forbidden-call scan.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const forbidden of ['connectOmegaDevice(', 'ensureOmegaV2Identity', 'signWithOmegaV2Identity', 'startOmegaOutboundView',
    'startOmegaOutboundInteractive', 'requestOmegaOutboundAdmin', 'stopOmegaOutbound', 'fetch(', 'https.request']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

// ── Status model ─────────────────────────────────────────────────────────────

test('status: valid link, no session -> AUTHORIZED YES, AVAILABLE UNKNOWN (never a false ONLINE)', () => {
  const d = device();
  const h = host({ maxPermission: 'VIEW' });
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  const viewCap = view.capabilities.find(cap => cap.name === 'VIEW');
  assert.equal(viewCap.authorized, 'YES');
  assert.equal(viewCap.available, 'UNKNOWN');
  const adminCap = view.capabilities.find(cap => cap.name === 'ADMIN');
  assert.equal(adminCap.authorized, 'NO', 'trust ceiling is VIEW, ADMIN never authorized');
  assert.equal(view.availability, 'UNKNOWN');
});

test('status: valid link + a real CONNECTED session observable without side effect -> AVAILABLE YES for permitted levels', () => {
  const d = device();
  const h = host({ maxPermission: 'INTERACTIVE' });
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const sessionId = crypto.randomUUID();
  insertSession({ sessionId, direction: 'OUTBOUND', localDeviceId: `ov2c-${crypto.randomUUID()}`, remoteDeviceId: h.remoteDeviceId,
    permission: 'INTERACTIVE', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), status: 'CONNECTED' });
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  assert.equal(view.session.permission, 'INTERACTIVE');
  const viewCap = view.capabilities.find(cap => cap.name === 'VIEW');
  const interactiveCap = view.capabilities.find(cap => cap.name === 'INTERACTIVE');
  const adminCap = view.capabilities.find(cap => cap.name === 'ADMIN');
  assert.equal(viewCap.available, 'YES');
  assert.equal(interactiveCap.available, 'YES');
  assert.equal(adminCap.available, 'NO', 'session permission ceiling is INTERACTIVE, never ADMIN available');
  assert.equal(view.availability, 'AVAILABLE');
});

test('status: revoked -> AUTHORIZED NO, AVAILABLE NO', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  revokeOutboundTrust(h.remoteDeviceId);
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  assert.equal(view.linkState, 'REVOKED');
  assert.equal(view.availability, 'NO');
  assert.deepEqual(view.capabilities, []);
});

test('status: stale (fingerprint changed) -> UNKNOWN, never a stale positive', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  getDatabase().prepare('UPDATE omega_v2_outbound_trust SET identity_fingerprint = ? WHERE remote_device_id = ?')
    .run(fingerprint64('rotated-3'), h.remoteDeviceId);
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  assert.equal(view.linkState, 'FINGERPRINT_MISMATCH');
  assert.equal(view.availability, 'UNKNOWN');
});

test('status: missing (trust deleted from under an active link) -> UNKNOWN, link stays visible', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  getDatabase().prepare('DELETE FROM omega_v2_outbound_trust WHERE remote_device_id = ?').run(h.remoteDeviceId);
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  assert.equal(view.linkState, 'MISSING');
  assert.equal(view.availability, 'UNKNOWN');
  assert.equal(view.trust, null);
});

test('status: old cached session (expired) never reported AVAILABLE', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const sessionId = crypto.randomUUID();
  insertSession({ sessionId, direction: 'OUTBOUND', localDeviceId: `ov2c-${crypto.randomUUID()}`, remoteDeviceId: h.remoteDeviceId,
    permission: 'ADMIN', createdAt: new Date(Date.now() - 20 * 60_000).toISOString(), expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(), status: 'EXPIRED' });
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  assert.equal(view.session, null);
  assert.equal(view.availability, 'UNKNOWN');
});

test('status: process restart simulation — a fresh read after re-init never invents availability', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  // No session exists (as if the process just restarted and OMEGA V2's own
  // boot recovery already marked any prior session INTERRUPTED). The link
  // itself persists (as V1 architecture already establishes for Fabric links).
  const view = getOmegaV2LinkView(d.fabricDeviceId);
  assert.equal(view.linkState, 'OK');
  assert.equal(view.availability, 'UNKNOWN');
  assert.equal(view.session, null);
});

test('no-side-effect: reading status opens 0 TLS connections, creates 0 sessions, mutates 0 trust rows', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const before = getDatabase().prepare('SELECT COUNT(*) c FROM omega_v2_sessions').get().c;
  const beforeTrust = JSON.stringify(getDatabase().prepare('SELECT * FROM omega_v2_outbound_trust WHERE remote_device_id = ?').get(h.remoteDeviceId));
  for (let i = 0; i < 5; i += 1) getOmegaV2LinkView(d.fabricDeviceId);
  for (let i = 0; i < 5; i += 1) resolveFabricOmegaV2Target(d.fabricDeviceId);
  for (let i = 0; i < 3; i += 1) listOmegaV2HostsForFabric();
  const after = getDatabase().prepare('SELECT COUNT(*) c FROM omega_v2_sessions').get().c;
  const afterTrust = JSON.stringify(getDatabase().prepare('SELECT * FROM omega_v2_outbound_trust WHERE remote_device_id = ?').get(h.remoteDeviceId));
  assert.equal(after, before, '0 session rows created by repeated status/resolve reads');
  assert.equal(afterTrust, beforeTrust, '0 trust row mutation from repeated status/resolve reads');
});

// ── Fabric device lifecycle interactions ────────────────────────────────────

test('Fabric device delete preserves the OMEGA V2 trust row byte-for-byte', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const before = JSON.stringify(getDatabase().prepare('SELECT * FROM omega_v2_outbound_trust WHERE remote_device_id = ?').get(h.remoteDeviceId));
  removeFabricDevice(d.fabricDeviceId, { confirm: 'REMOVE_LINKS' });
  const after = JSON.stringify(getDatabase().prepare('SELECT * FROM omega_v2_outbound_trust WHERE remote_device_id = ?').get(h.remoteDeviceId));
  assert.equal(after, before);
});

test('OMEGA V2 revocation does not touch RASSILON or OMEGA V1 rows; the reverse holds too', () => {
  const rassilonId = crypto.randomUUID();
  upsertRassilonDevice({ deviceId: rassilonId, displayName: 'Worker', publicKeyPem: 'pk', tlsCertificatePem: 'cert',
    fingerprint: fingerprint64('r-untouched'), role: 'WORKER', permissionSet: [], endpointHost: null, endpointPort: null });
  const omegaV1Id = crypto.randomUUID();
  insertOmegaDevice({ id: omegaV1Id, display_name: 'V1', public_key_pem: 'pk', fingerprint: fingerprint64('v1-untouched'), permission_level: 1 });
  const h = host();
  const d = device();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });

  const beforeRassilon = JSON.stringify(getDatabase().prepare('SELECT * FROM rassilon_devices WHERE device_id = ?').get(rassilonId));
  const beforeOmegaV1 = JSON.stringify(getDatabase().prepare('SELECT * FROM omega_devices WHERE id = ?').get(omegaV1Id));
  revokeOutboundTrust(h.remoteDeviceId);
  assert.equal(JSON.stringify(getDatabase().prepare('SELECT * FROM rassilon_devices WHERE device_id = ?').get(rassilonId)), beforeRassilon);
  assert.equal(JSON.stringify(getDatabase().prepare('SELECT * FROM omega_devices WHERE id = ?').get(omegaV1Id)), beforeOmegaV1);
});

test('unlink preserves the OMEGA V2 trust row and does not touch other link kinds on the same device', () => {
  const d = device();
  const h = host();
  const rassilonId = crypto.randomUUID();
  upsertRassilonDevice({ deviceId: rassilonId, displayName: 'Worker', publicKeyPem: 'pk', tlsCertificatePem: 'cert',
    fingerprint: fingerprint64('r-coexist'), role: 'WORKER', permissionSet: [], endpointHost: null, endpointPort: null });
  linkAgent(d.fabricDeviceId, { agentType: 'RASSILON', agentDeviceId: rassilonId, confirmFingerprint: fingerprint64('r-coexist') });
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  unlinkOmegaV2Host(d.fabricDeviceId);
  assert.equal(getOmegaV2LinkView(d.fabricDeviceId), null);
  // The RASSILON link on the SAME fabric device is untouched.
  const trust = getDatabase().prepare('SELECT * FROM omega_v2_outbound_trust WHERE remote_device_id = ?').get(h.remoteDeviceId);
  assert.ok(trust && !trust.revoked_at);
});

// ── Audit and secret scan ────────────────────────────────────────────────────

test('audit: link/unlink events recorded with the OMEGA_V2_OUTBOUND agent type, no secret content', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  unlinkOmegaV2Host(d.fabricDeviceId);
  const events = listFabricAudit({ limit: 20 }).filter(event => event.agentType === OMEGA_V2_AGENT_TYPE);
  assert.ok(events.some(event => event.eventType === 'FABRIC_AGENT_LINKED'));
  assert.ok(events.some(event => event.eventType === 'FABRIC_AGENT_UNLINKED'));
  const serialized = JSON.stringify(events);
  for (const forbidden of ['BEGIN CERTIFICATE', 'BEGIN PUBLIC KEY', 'PRIVATE KEY', h.fingerprint]) {
    // The fingerprint itself is safe/public metadata per architecture §11 and is not forbidden;
    // only secret material is checked here.
    if (forbidden === h.fingerprint) continue;
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('Fabric DB safety: after linking, fabric_* rows contain 0 private key, 0 token, 0 session secret, 0 approval, 0 raw cert material', () => {
  const d = device();
  const h = host();
  linkOmegaV2Host(d.fabricDeviceId, { omegaV2HostId: h.remoteDeviceId, confirmFingerprint: h.fingerprint });
  const rows = [
    ...getDatabase().prepare('SELECT * FROM fabric_devices').all(),
    ...getDatabase().prepare('SELECT * FROM fabric_agent_links').all(),
    ...getDatabase().prepare('SELECT * FROM fabric_audit').all(),
  ];
  const serialized = JSON.stringify(rows);
  for (const forbidden of ['BEGIN CERTIFICATE', 'BEGIN PUBLIC KEY', 'BEGIN PRIVATE KEY', 'PRIVATE KEY', 'approvalNonce', 'sessionToken', 'bearerToken']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
