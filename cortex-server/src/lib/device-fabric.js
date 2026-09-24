/**
 * DEVICE FABRIC Phase 2 — inventory + explicit linking (no routing).
 *
 * A fabric device is a local inventory label ("PC Bureau") that may carry
 * zero or one OMEGA link and zero or one RASSILON link. A link records that
 * the local user asserted two agent identities belong to the same machine.
 * It grants nothing: OMEGA and RASSILON never read Fabric, and every state
 * shown here is recomputed from the agents' own records at read time
 * (reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md §5-§7, §11-§12).
 *
 * Out of scope by design: routing, dispatch, sessions, keys, pairing,
 * revocation, enable/stop. Unlink and removal only close fabric_* rows.
 */
import crypto from 'node:crypto';
import {
  countFabricDevices, getFabricDevice, insertFabricAgentLink, insertFabricAudit, insertFabricDevice,
  listActiveFabricAgentLinks, listFabricAudit, listFabricDevices, removeFabricDeviceAndLinks,
  renameFabricDevice as renameFabricDeviceRow, unlinkFabricAgentLink,
} from './sqlite.js';
import {
  AVAILABILITY, TRUST, describeAgentState, getAgentIdentity, listAgentIdentities, publicIdentity,
} from './device-fabric-agents.js';

export const FABRIC_AGENT_TYPES = Object.freeze(['OMEGA', 'RASSILON']);
export const FABRIC_AUDIT_EVENTS = Object.freeze([
  'FABRIC_DEVICE_CREATED', 'FABRIC_DEVICE_RENAMED', 'FABRIC_DEVICE_REMOVED',
  'FABRIC_AGENT_LINKED', 'FABRIC_AGENT_UNLINKED', 'FABRIC_LINK_REJECTED',
]);
export const FABRIC_DEVICE_STATES = Object.freeze(['ONLINE', 'PARTIAL', 'OFFLINE', 'UNKNOWN', 'ERROR']);
export const MAX_FABRIC_DEVICES = 256;
export const REMOVE_WITH_LINKS_CONFIRMATION = 'REMOVE_LINKS';

const FABRIC_DEVICE_ID = /^fdev-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENT_DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
// Letters (any script), combining marks, digits, space and a small set of
// punctuation. No <, >, quotes, backslash, control or bidi characters.
const DISPLAY_NAME = /^[\p{L}\p{M}\p{N} ._\-'()#&+:/@!?]+$/u;

export class DeviceFabricError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DeviceFabricError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new DeviceFabricError(code, status);
}

export function isFabricDeviceId(value) {
  return typeof value === 'string' && FABRIC_DEVICE_ID.test(value);
}

export function validateDisplayName(value) {
  if (typeof value !== 'string') fail('display_name_required');
  const name = value.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  if (name.length < 1 || name.length > 64) fail('display_name_length_invalid');
  if (!DISPLAY_NAME.test(name)) fail('display_name_charset_invalid');
  return name;
}

function audit(eventType, fields = {}) {
  insertFabricAudit({ eventType, ...fields });
}

function requireDevice(fabricDeviceId) {
  if (!isFabricDeviceId(fabricDeviceId)) fail('fabric_device_id_invalid');
  const device = getFabricDevice(fabricDeviceId);
  if (!device) fail('fabric_device_not_found', 404);
  return device;
}

function assertNameAvailable(name, exceptId = null) {
  const lower = name.toLocaleLowerCase('fr');
  if (listFabricDevices().some(d => d.fabricDeviceId !== exceptId && d.displayName.toLocaleLowerCase('fr') === lower)) {
    fail('display_name_taken', 409);
  }
}

// ── State ──────────────────────────────────────────────────────────────────

// Why OMEGA can never be routed from Fabric in V1 (architecture F1).
export const OMEGA_ROUTING_REASON = 'omega_outbound_client_not_implemented';

const LINK_STATE_REASONS = Object.freeze({
  MISSING: 'rassilon_identity_missing',
  FINGERPRINT_MISMATCH: 'rassilon_fingerprint_mismatch',
  CROSS_AGENT_KEY_REUSE: 'cross_agent_key_reuse',
  AGENT_ERROR: 'agent_projection_error',
});

/**
 * The first reason a RASSILON link is not routable, in the same order the
 * router checks it (lib/device-fabric-routing.js), or null when READY.
 */
function rassilonRoutingReason(view) {
  if (view.linkState !== 'OK') return LINK_STATE_REASONS[view.linkState] ?? 'rassilon_link_unsafe';
  if (view.trust === TRUST.REVOKED) return 'rassilon_identity_revoked';
  if (view.trust !== TRUST.TRUSTED) return 'rassilon_identity_untrusted';
  const block = view.directions.find(d => d.direction === 'THIS_PC_SENDS_COMPUTE');
  if (!block) return 'rassilon_target_not_a_worker';
  if (block.capabilities.some(cap => cap.routable)) return null;
  const session = block.session?.state;
  if (session === 'EXPIRED') return 'session_expired';
  if (session === 'REVOKED') return 'session_revoked';
  if (session === 'NONE') return 'session_missing';
  if (session === 'UNKNOWN') return 'session_unknown';
  if (block.presence?.state !== 'VERIFIED') return 'presence_not_verified';
  if (block.capabilities.every(cap => cap.authorized !== 'YES')) return 'capability_not_authorized';
  if (block.capabilities.every(cap => cap.supported !== 'YES')) return 'capability_not_supported';
  return 'target_not_available';
}

function withRouting(view) {
  if (view.agentType === 'OMEGA') return { ...view, routable: false, routingStatus: 'NOT_ROUTABLE', routingReason: OMEGA_ROUTING_REASON };
  const reason = rassilonRoutingReason(view);
  return { ...view, routingStatus: reason ? 'NOT_AVAILABLE' : 'READY', routingReason: reason };
}

function linkView(link, now, otherDomainFingerprints) {
  const base = {
    agentType: link.agentType,
    agentDeviceId: link.agentDeviceId,
    linkedFingerprint: link.agentFingerprint,
    linkedAt: link.linkedAt,
    routable: false,
  };
  // A projection that fails (agent store unreadable, unexpected data) never
  // takes the whole inventory down and is never read as healthy: that link
  // alone is shown AGENT_ERROR and cannot be routed.
  const agentError = () => ({ ...base, linkState: 'AGENT_ERROR', trust: TRUST.UNKNOWN, availability: AVAILABILITY.ERROR, identity: null, directions: [] });
  let identity;
  try { identity = getAgentIdentity(link.agentType, link.agentDeviceId); } catch { return withRouting(agentError()); }
  // Identity gone: keep the link visible, never auto-delete (mission §45).
  if (!identity) {
    return withRouting({ ...base, linkState: 'MISSING', trust: TRUST.UNKNOWN, availability: AVAILABILITY.UNAVAILABLE, identity: null, directions: [] });
  }
  // Same agentDeviceId but a different key: this is no longer the identity
  // the user confirmed, so nothing about it is projected onto the link.
  if (identity.fingerprint !== link.agentFingerprint) {
    return withRouting({ ...base, linkState: 'FINGERPRINT_MISMATCH', trust: TRUST.UNKNOWN, availability: AVAILABILITY.UNKNOWN, identity: publicIdentity(identity), directions: [] });
  }
  // The key-reuse check needs the other domain; if it could not be read the
  // link cannot be vouched for.
  if (otherDomainFingerprints === null) return withRouting(agentError());
  // A key that (now) also exists in the other trust domain is a violation:
  // surfaced, and never presented as a trusted identity.
  if (otherDomainFingerprints.has(identity.fingerprint)) {
    return withRouting({ ...base, linkState: 'CROSS_AGENT_KEY_REUSE', trust: TRUST.UNKNOWN, availability: AVAILABILITY.UNKNOWN, identity: publicIdentity(identity), directions: [] });
  }
  let state;
  try { state = describeAgentState(identity, now); } catch { return withRouting(agentError()); }
  const trusted = identity.trust === TRUST.TRUSTED;
  const directions = state.directions.map(block => ({
    ...block,
    capabilities: block.capabilities.map(cap => ({ ...cap, routable: isRoutableCapability(link.agentType, trusted, block.direction, cap) })),
  }));
  return withRouting({
    ...base,
    linkState: 'OK',
    trust: identity.trust,
    availability: trusted ? state.availability : AVAILABILITY.UNAVAILABLE,
    routable: directions.some(block => block.capabilities.some(cap => cap.routable)),
    identity: publicIdentity(identity),
    directions,
  });
}

/**
 * Phase 3 routability: RASSILON only (OMEGA V1 has no outbound client), only
 * towards a worker (this PC sends compute), only from a TRUSTED identity
 * whose link is intact, and only when SUPPORTED, AUTHORIZED and AVAILABLE
 * are all YES. UNKNOWN is never treated as YES.
 */
export function isRoutableCapability(agentType, trusted, direction, cap) {
  return agentType === 'RASSILON' && trusted && direction === 'THIS_PC_SENDS_COMPUTE'
    && cap.supported === 'YES' && cap.authorized === 'YES' && cap.available === 'YES';
}

/**
 * Overall device state from its active links, computed at read time:
 *   no link                              → UNKNOWN (nothing is known)
 *   any link ERROR                       → ERROR
 *   every link AVAILABLE                 → ONLINE
 *   ≥1 AVAILABLE and ≥1 not AVAILABLE    → PARTIAL
 *   every link UNAVAILABLE               → OFFLINE (revoked/missing/no session)
 *   otherwise (no AVAILABLE, ≥1 UNKNOWN) → UNKNOWN
 * ONLINE therefore always requires a fresh positive signal from an agent.
 */
export function computeDeviceState(availabilities) {
  if (availabilities.length === 0) return 'UNKNOWN';
  if (availabilities.includes(AVAILABILITY.ERROR)) return 'ERROR';
  const available = availabilities.filter(a => a === AVAILABILITY.AVAILABLE).length;
  if (available === availabilities.length) return 'ONLINE';
  if (available > 0) return 'PARTIAL';
  if (availabilities.every(a => a === AVAILABILITY.UNAVAILABLE)) return 'OFFLINE';
  return 'UNKNOWN';
}

// null for a domain that could not be read (its links then show AGENT_ERROR).
function fingerprintsByDomain() {
  const sets = {};
  for (const agentType of FABRIC_AGENT_TYPES) {
    try {
      sets[agentType] = new Set(listAgentIdentities(agentType).map(identity => identity.fingerprint).filter(Boolean));
    } catch {
      sets[agentType] = null;
    }
  }
  return sets;
}

function deviceView(device, now = Date.now(), domains = fingerprintsByDomain()) {
  const links = listActiveFabricAgentLinks({ fabricDeviceId: device.fabricDeviceId });
  const agents = { OMEGA: null, RASSILON: null };
  for (const link of links) {
    agents[link.agentType] = linkView(link, now, domains[link.agentType === 'OMEGA' ? 'RASSILON' : 'OMEGA']);
  }
  const linkedStates = Object.values(agents).filter(Boolean).map(link => link.availability);
  return {
    fabricDeviceId: device.fabricDeviceId,
    displayName: device.displayName,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    state: computeDeviceState(linkedStates),
    agents,
  };
}

// ── Devices ────────────────────────────────────────────────────────────────

export function listFabricDeviceViews() {
  const now = Date.now();
  const domains = fingerprintsByDomain();
  return listFabricDevices().map(device => deviceView(device, now, domains));
}

export function getFabricDeviceView(fabricDeviceId) {
  return deviceView(requireDevice(fabricDeviceId));
}

export function createFabricDevice({ displayName }) {
  const name = validateDisplayName(displayName);
  if (countFabricDevices() >= MAX_FABRIC_DEVICES) fail('fabric_device_limit_reached', 409);
  assertNameAvailable(name);
  // Random and opaque: never derived from an IP, hostname, MAC, username or agent id.
  const fabricDeviceId = `fdev-${crypto.randomUUID()}`;
  const device = insertFabricDevice({ fabricDeviceId, displayName: name });
  audit('FABRIC_DEVICE_CREATED', { fabricDeviceId });
  return deviceView(device);
}

export function renameFabricDevice(fabricDeviceId, { displayName }) {
  requireDevice(fabricDeviceId);
  const name = validateDisplayName(displayName);
  assertNameAvailable(name, fabricDeviceId);
  const device = renameFabricDeviceRow(fabricDeviceId, name);
  audit('FABRIC_DEVICE_RENAMED', { fabricDeviceId });
  return deviceView(device);
}

export function removeFabricDevice(fabricDeviceId, { confirm = null } = {}) {
  requireDevice(fabricDeviceId);
  const links = listActiveFabricAgentLinks({ fabricDeviceId });
  if (links.length > 0 && confirm !== REMOVE_WITH_LINKS_CONFIRMATION) fail('removal_requires_link_confirmation', 409);
  removeFabricDeviceAndLinks(fabricDeviceId);
  for (const link of links) audit('FABRIC_AGENT_UNLINKED', { fabricDeviceId, agentType: link.agentType, agentDeviceId: link.agentDeviceId, reason: 'device_removed' });
  audit('FABRIC_DEVICE_REMOVED', { fabricDeviceId });
  return { fabricDeviceId, removed: true, unlinkedAgents: links.map(link => link.agentType) };
}

// ── Agents ─────────────────────────────────────────────────────────────────

/** Existing agent identities (read-only) with the Fabric device each is linked to. */
export function listAgentsForFabricWithErrors() {
  const linkedTo = new Map(listActiveFabricAgentLinks().map(link => [`${link.agentType}:${link.agentDeviceId}`, link.fabricDeviceId]));
  const agents = {};
  const errors = {};
  for (const agentType of FABRIC_AGENT_TYPES) {
    try {
      agents[agentType] = listAgentIdentities(agentType).map(identity => ({
        ...publicIdentity(identity),
        linkedFabricDeviceId: linkedTo.get(`${agentType}:${identity.agentDeviceId}`) ?? null,
      }));
    } catch {
      // One unreadable agent never hides the other one; it is reported, not guessed.
      agents[agentType] = [];
      errors[agentType] = 'agent_projection_error';
    }
  }
  return { agents, errors };
}

export function listAgentsForFabric() {
  return listAgentsForFabricWithErrors().agents;
}

function reject(reason, status, fields) {
  audit('FABRIC_LINK_REJECTED', { ...fields, reason });
  fail(reason, status);
}

export function linkAgent(fabricDeviceId, { agentType, agentDeviceId, confirmFingerprint }) {
  requireDevice(fabricDeviceId);
  if (!FABRIC_AGENT_TYPES.includes(agentType)) fail('agent_type_invalid');
  if (typeof agentDeviceId !== 'string' || !AGENT_DEVICE_ID.test(agentDeviceId)) fail('agent_device_id_invalid');
  const confirmed = typeof confirmFingerprint === 'string' ? confirmFingerprint.toLowerCase() : '';
  if (!FINGERPRINT.test(confirmed)) fail('confirm_fingerprint_invalid');
  const fields = { fabricDeviceId, agentType, agentDeviceId };

  // Read-only lookup: a missing identity is rejected, never created.
  const identity = getAgentIdentity(agentType, agentDeviceId);
  if (!identity) reject('agent_identity_not_found', 404, fields);
  if (identity.trust === TRUST.REVOKED) reject('agent_identity_revoked', 409, fields);
  if (!identity.fingerprint) reject('agent_fingerprint_unavailable', 409, fields);
  if (identity.fingerprint !== confirmed) reject('fingerprint_confirmation_mismatch', 409, fields);

  // The same key in both trust domains is a key-reuse violation, never a
  // proof that two identities are the same machine (architecture F3).
  const otherType = agentType === 'OMEGA' ? 'RASSILON' : 'OMEGA';
  let otherIdentities;
  try { otherIdentities = listAgentIdentities(otherType); } catch { reject('agent_projection_error', 503, fields); }
  if (otherIdentities.some(other => other.fingerprint === identity.fingerprint)) {
    reject('cross_agent_key_reuse', 409, fields);
  }

  const active = listActiveFabricAgentLinks();
  if (active.some(link => link.agentType === agentType && link.agentDeviceId === agentDeviceId)) {
    reject('agent_identity_already_linked', 409, fields);
  }
  if (active.some(link => link.fabricDeviceId === fabricDeviceId && link.agentType === agentType)) {
    reject('agent_type_already_linked_on_device', 409, fields);
  }

  try {
    insertFabricAgentLink({ linkId: `flnk-${crypto.randomUUID()}`, fabricDeviceId, agentType, agentDeviceId, agentFingerprint: identity.fingerprint });
  } catch (error) {
    // The partial UNIQUE indexes are the last line of defence against a race.
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') reject('agent_link_conflict', 409, fields);
    throw error;
  }
  audit('FABRIC_AGENT_LINKED', fields);
  return getFabricDeviceView(fabricDeviceId);
}

/** Closes the Fabric link only: no agent revocation, key or session change. */
export function unlinkAgent(fabricDeviceId, agentType) {
  requireDevice(fabricDeviceId);
  if (!FABRIC_AGENT_TYPES.includes(agentType)) fail('agent_type_invalid');
  const link = listActiveFabricAgentLinks({ fabricDeviceId }).find(item => item.agentType === agentType);
  if (!link || !unlinkFabricAgentLink(fabricDeviceId, agentType)) fail('agent_link_not_found', 404);
  audit('FABRIC_AGENT_UNLINKED', { fabricDeviceId, agentType, agentDeviceId: link.agentDeviceId, reason: 'user_unlink' });
  return getFabricDeviceView(fabricDeviceId);
}

export function listFabricAuditEvents({ limit = 100 } = {}) {
  const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
  return listFabricAudit({ limit: bounded });
}
