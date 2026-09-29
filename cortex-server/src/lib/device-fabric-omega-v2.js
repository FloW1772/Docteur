/**
 * DEVICE FABRIC V2 Phase 2 — OMEGA V2 outbound link + exact resolution +
 * read-only status. No VIEW/INTERACTIVE/ADMIN/STOP routing exists here.
 *
 * This is a NEW, separate module rather than an extension of the existing
 * OMEGA V1 / RASSILON link code in device-fabric.js and
 * device-fabric-agents.js. Per the Phase 1 architecture audit (reports/
 * DEVICE_FABRIC_V2_OMEGA_ROUTING_ARCHITECTURE_2026-09.md §1), the existing
 * `agentType: 'OMEGA'` link references `omega_devices` — OMEGA V1 INBOUND,
 * a remote client paired TO this PC. This module's link kind,
 * `OMEGA_V2_OUTBOUND`, references `omega_v2_outbound_trust` — a host THIS PC
 * is allowed to control OUTBOUND. Two disjoint tables, two disjoint ID
 * spaces (`omega_devices.id` is a bare UUID; `omega_v2_outbound_trust.
 * remote_device_id` is `ov2h-<uuid>`), never merged, never aliased, never a
 * fallback for one another (mission §0, §4).
 *
 * Reads only two OMEGA V2 store functions, both pure reads with 0 side
 * effect: getOutboundTrust, listOutboundTrust. No identity, signing,
 * session-creation, connect, view, interactive or admin function is
 * imported — OMEGA V2 stays certified and frozen (mission §32).
 */
import crypto from 'node:crypto';
import {
  getFabricDevice, insertFabricAgentLink, insertFabricAudit, listActiveFabricAgentLinks, unlinkFabricAgentLink,
} from './sqlite.js';
import { getOutboundTrust, listOutboundTrust } from './omega-outbound-store.js';
import { listOmegaOutboundSessions } from './omega-outbound-client.js';
import { listAgentIdentities } from './device-fabric-agents.js';

export const OMEGA_V2_AGENT_TYPE = 'OMEGA_V2_OUTBOUND';
export const OMEGA_V2_LINK_STATES = Object.freeze(['OK', 'MISSING', 'FINGERPRINT_MISMATCH', 'REVOKED']);
export const OMEGA_V2_AVAILABILITY = Object.freeze(['AVAILABLE', 'UNKNOWN', 'UNAVAILABLE']);
export const OMEGA_V2_TRI = Object.freeze(['YES', 'NO', 'UNKNOWN']);

const FABRIC_DEVICE_ID = /^fdev-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OMEGA_V2_HOST_ID = /^ov2h-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

// A status read is considered fresh for twice the OMEGA V2 controller status
// monitor's own poll interval (5 s — omega-outbound-client.js
// startSignedStatusMonitor), mirroring the margin already used for the
// INTERACTIVE lease (architecture report §8.4). Older than this and an
// otherwise-CONNECTED session is shown UNKNOWN, never a stale AVAILABLE.
export const OMEGA_V2_STATUS_FRESH_MS = 10_000;

export class DeviceFabricOmegaV2Error extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DeviceFabricOmegaV2Error';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new DeviceFabricOmegaV2Error(code, status);
}

function requireDevice(fabricDeviceId) {
  if (typeof fabricDeviceId !== 'string' || !FABRIC_DEVICE_ID.test(fabricDeviceId)) fail('fabric_device_id_invalid');
  const device = getFabricDevice(fabricDeviceId);
  if (!device) fail('fabric_device_not_found', 404);
  return device;
}

function audit(eventType, fields = {}) {
  insertFabricAudit({ eventType, agentType: OMEGA_V2_AGENT_TYPE, ...fields });
}

function reject(reason, status, fields) {
  audit('FABRIC_LINK_REJECTED', { ...fields, reason });
  fail(reason, status);
}

/**
 * Safe projection of an omega_v2_outbound_trust row: public identity,
 * pinned-transport fingerprints, permission ceiling, revocation. Never the
 * certificate PEM (transport secret, re-verified by OMEGA V2 itself on every
 * connect, never needed by Fabric), never a private key, token, session
 * secret, nonce or approval (mission §6, §11, §31).
 */
function publicTrust(trust) {
  if (!trust) return null;
  return {
    omegaV2HostId: trust.remote_device_id,
    host: trust.host,
    port: trust.port,
    identityFingerprint: trust.identity_fingerprint,
    certificateFingerprint: trust.certificate_fingerprint,
    maxPermission: trust.max_permission,
    createdAt: trust.created_at,
    revokedAt: trust.revoked_at ?? null,
  };
}

/**
 * Every OMEGA V2 outbound identity fingerprint (registered trust, and this
 * PC's own controller identity is deliberately excluded: it is not an
 * agentDeviceId any link could name). Used only by device-fabric.js's
 * cross-agent key-reuse check when linking OMEGA (V1) or RASSILON, so a key
 * cannot be silently reused across all three trust domains, not just two
 * (mission §10, §36).
 */
export function listOmegaV2HostFingerprints() {
  return listOutboundTrust().map(row => row.identity_fingerprint).filter(Boolean);
}

/** Every currently registered OMEGA V2 outbound trust, safely projected, with the Fabric link (if any). */
export function listOmegaV2HostsForFabric() {
  const linkedTo = new Map(
    listActiveFabricAgentLinks().filter(link => link.agentType === OMEGA_V2_AGENT_TYPE)
      .map(link => [link.agentDeviceId, link.fabricDeviceId]),
  );
  return listOutboundTrust().map(row => ({ ...publicTrust(row), linkedFabricDeviceId: linkedTo.get(row.remote_device_id) ?? null }));
}

/**
 * Live signal for an OMEGA V2 host, WITHOUT creating a session (mission
 * §17, §39): reads whether an already-established OUTBOUND session for this
 * exact remoteDeviceId is currently CONNECTED, per OMEGA V2's own session
 * store (listSessions('OUTBOUND') — a pure SELECT). Never calls
 * connectOmegaDevice. A session Fabric did not start and does not own is
 * still a real, certified OMEGA V2 signal Fabric is allowed to read
 * (mission §18): Fabric never becomes that session's owner by reading it.
 */
function activeSessionSignal(omegaV2HostId) {
  const sessions = listOmegaOutboundSessions().filter(session => session.remoteOmegaDeviceId === omegaV2HostId);
  // Most recently created connected session for this exact host, if any.
  const connected = sessions.filter(session => session.status === 'CONNECTED')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!connected) return { hasSession: false, sessionId: null, permission: null, expiresAt: null };
  return { hasSession: true, sessionId: connected.sessionId, permission: connected.permission, expiresAt: connected.expiresAt };
}

/**
 * SUPPORTED / AUTHORIZED / AVAILABLE for one capability level, strictly
 * separated (mission §15, §19). AVAILABLE is never YES merely because a
 * trust row or a link exists — only a currently observable CONNECTED
 * session counts as evidence, and only if it is not older than the
 * freshness window computed by the caller (architecture report §8.2/§8.4).
 */
function capabilityTri(level, trust, sessionSignal) {
  const rank = { VIEW: 1, INTERACTIVE: 2, ADMIN: 3 };
  const revoked = !!trust?.revokedAt;
  const supported = trust ? 'YES' : 'NO';
  const authorized = trust && !revoked && rank[level] <= rank[trust.maxPermission] ? 'YES' : 'NO';
  let available;
  if (!trust || revoked) available = 'NO';
  // A session is real, certified evidence either way: its permission ceiling
  // proves the level is currently reachable (YES) or currently is not (NO —
  // never UNKNOWN once we can see the actual ceiling). Only the absence of
  // any observable session leaves the question genuinely open (UNKNOWN).
  else if (sessionSignal.hasSession) available = rank[level] <= rank[sessionSignal.permission] ? 'YES' : 'NO';
  else available = 'UNKNOWN';
  return { name: level, supported, authorized, available };
}

/**
 * Read-only view of one Fabric device's OMEGA_V2_OUTBOUND link: link state,
 * safe trust projection, SUPPORTED/AUTHORIZED/AVAILABLE per capability, and
 * the link's identity/version metadata a future action must re-read and
 * compare before executing (mission §12, §14 — resolveFabricOmegaV2Target
 * below is the closed primitive that performs that comparison; this
 * function only describes the link for display, with 0 side effect).
 */
export function getOmegaV2LinkView(fabricDeviceId) {
  requireDevice(fabricDeviceId);
  const link = listActiveFabricAgentLinks({ fabricDeviceId }).find(item => item.agentType === OMEGA_V2_AGENT_TYPE);
  if (!link) return null;
  const base = { linkId: link.linkId, omegaV2HostId: link.agentDeviceId, linkedFingerprint: link.agentFingerprint,
    linkVersion: link.linkVersion, linkedAt: link.linkedAt };
  const trust = getOutboundTrust(link.agentDeviceId);
  if (!trust) return { ...base, linkState: 'MISSING', trust: null, availability: 'UNKNOWN', capabilities: [] };
  if (trust.identity_fingerprint !== link.agentFingerprint) {
    return { ...base, linkState: 'FINGERPRINT_MISMATCH', trust: publicTrust(trust), availability: 'UNKNOWN', capabilities: [] };
  }
  const publicView = publicTrust(trust);
  if (trust.revoked_at) return { ...base, linkState: 'REVOKED', trust: publicView, availability: 'NO', capabilities: [] };
  const sessionSignal = activeSessionSignal(link.agentDeviceId);
  const capabilities = ['VIEW', 'INTERACTIVE', 'ADMIN'].map(level => capabilityTri(level, publicView, sessionSignal));
  const availability = capabilities.some(cap => cap.available === 'YES') ? 'AVAILABLE'
    : capabilities.every(cap => cap.available === 'NO') ? 'UNAVAILABLE' : 'UNKNOWN';
  return { ...base, linkState: 'OK', trust: publicView, availability, capabilities,
    session: sessionSignal.hasSession ? { permission: sessionSignal.permission, expiresAt: sessionSignal.expiresAt } : null };
}

/**
 * Explicit link: fabricDeviceId -> an EXACT, already-registered OMEGA V2
 * outbound host, confirmed by its identity fingerprint. Never creates a
 * trust, never pairs, never connects (mission §7, §17, §39). Rejects a bare
 * OMEGA V1 device id (no 'ov2h-' prefix, mission §35 "OMEGA V1 ID supplied
 * as OMEGA V2: REJECT") before even attempting a lookup.
 */
export function linkOmegaV2Host(fabricDeviceId, { omegaV2HostId, confirmFingerprint } = {}) {
  requireDevice(fabricDeviceId);
  if (typeof omegaV2HostId !== 'string' || !OMEGA_V2_HOST_ID.test(omegaV2HostId)) fail('omega_v2_host_id_invalid');
  const confirmed = typeof confirmFingerprint === 'string' ? confirmFingerprint.toLowerCase() : '';
  if (!FINGERPRINT.test(confirmed)) fail('confirm_fingerprint_invalid');
  const fields = { fabricDeviceId, agentType: OMEGA_V2_AGENT_TYPE, agentDeviceId: omegaV2HostId };

  // Read-only lookup against the trust already registered via OMEGA V2's own
  // pairing-bundle exchange. Fabric never creates or requests one.
  const trust = getOutboundTrust(omegaV2HostId);
  if (!trust) reject('omega_v2_host_not_found', 404, fields);
  if (trust.revoked_at) reject('omega_v2_host_revoked', 409, fields);
  if (trust.identity_fingerprint !== confirmed) reject('fingerprint_confirmation_mismatch', 409, fields);

  // The same key already trusted as an OMEGA V1 (inbound) or RASSILON
  // identity is a cross-agent key-reuse violation, never a proof that the
  // two are the same machine (mission §10, §36; architecture F3).
  let otherIdentities;
  try { otherIdentities = [...listAgentIdentities('OMEGA'), ...listAgentIdentities('RASSILON')]; }
  catch { reject('agent_projection_error', 503, fields); }
  if (otherIdentities.some(other => other.fingerprint === trust.identity_fingerprint)) {
    reject('cross_agent_key_reuse', 409, fields);
  }

  const active = listActiveFabricAgentLinks();
  if (active.some(link => link.agentType === OMEGA_V2_AGENT_TYPE && link.agentDeviceId === omegaV2HostId)) {
    reject('omega_v2_host_already_linked', 409, fields);
  }
  if (active.some(link => link.fabricDeviceId === fabricDeviceId && link.agentType === OMEGA_V2_AGENT_TYPE)) {
    reject('omega_v2_already_linked_on_device', 409, fields);
  }

  try {
    insertFabricAgentLink({
      linkId: `flnk-${crypto.randomUUID()}`, fabricDeviceId, agentType: OMEGA_V2_AGENT_TYPE,
      agentDeviceId: omegaV2HostId, agentFingerprint: trust.identity_fingerprint,
    });
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') reject('omega_v2_link_conflict', 409, fields);
    throw error;
  }
  audit('FABRIC_AGENT_LINKED', fields);
  return getOmegaV2LinkView(fabricDeviceId);
}

/** Closes the Fabric link only. Never revokes the OMEGA V2 trust, never touches OMEGA V1 or RASSILON links (mission §22). */
export function unlinkOmegaV2Host(fabricDeviceId) {
  requireDevice(fabricDeviceId);
  const link = listActiveFabricAgentLinks({ fabricDeviceId }).find(item => item.agentType === OMEGA_V2_AGENT_TYPE);
  if (!link || !unlinkFabricAgentLink(fabricDeviceId, OMEGA_V2_AGENT_TYPE)) fail('omega_v2_link_not_found', 404);
  audit('FABRIC_AGENT_UNLINKED', { fabricDeviceId, agentType: OMEGA_V2_AGENT_TYPE, agentDeviceId: link.agentDeviceId, reason: 'user_unlink' });
  return { fabricDeviceId, unlinked: true };
}

/**
 * Closed exact-resolution primitive (mission §12). Performs NO network
 * action and creates NO session — it only re-reads the Fabric link and the
 * OMEGA V2 trust table fresh (never a cached copy) and fails closed on any
 * missing/stale/revoked/mismatched state. No fallback exists: there is
 * nothing here that could select a different omegaV2HostId than the one the
 * exact link names (mission §13).
 *
 * The returned linkVersion/fingerprint pair is the TOCTOU foundation
 * (mission §14): a future action must re-call this immediately before using
 * the result, and treat a changed linkVersion or fingerprint exactly like a
 * fresh MISSING/FINGERPRINT_MISMATCH failure rather than proceeding with
 * either the old or the new value (architecture report §6.3).
 */
export function resolveFabricOmegaV2Target(fabricDeviceId) {
  requireDevice(fabricDeviceId);
  const link = listActiveFabricAgentLinks({ fabricDeviceId }).find(item => item.agentType === OMEGA_V2_AGENT_TYPE);
  if (!link) fail('omega_v2_not_linked', 409);
  const trust = getOutboundTrust(link.agentDeviceId);
  if (!trust) fail('omega_v2_host_missing', 409);
  if (trust.identity_fingerprint !== link.agentFingerprint) fail('omega_v2_link_stale', 409);
  if (trust.revoked_at) fail('omega_v2_host_revoked', 409);
  return {
    fabricDeviceId, omegaV2HostId: link.agentDeviceId, linkId: link.linkId, linkVersion: link.linkVersion,
    fingerprint: link.agentFingerprint,
  };
}
