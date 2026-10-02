/**
 * Builds the V1 policy DOCUMENT (data). Used by the offline signing tool and by tests; the running server never builds or writes a policy —
 * it only loads and verifies the signed file.
 *
 * The grants below are the minimum that keeps every certified Docteur capability usable while giving each module ONLY the capabilities
 * of its own trust domain. Nothing here can exceed the ceilings of schema.js (validatePolicy refuses it).
 */
import { ACTION_CEILING, ACTION_IDS, KNOWN_CAPABILITIES, NEVER_GRANTED_CAPABILITIES, POLICY_SCHEMA, ROOT_INVARIANTS, TRUST_DOMAINS } from './schema.js';

const CAPABILITY_CONSTRAINTS = Object.freeze({
  'WEB.PUBLIC_FETCH': { networkClasses: ['public'], destinationGuard: 'web-egress-guard' },
  'MEDIA.INSPECT': { networkClasses: ['public'], accessModes: ['public', 'user-owned', 'user-authorized'], networkEngine: 'egress-proxy' },
  'MEDIA.DOWNLOAD': { networkClasses: ['public'], accessModes: ['public', 'user-owned', 'user-authorized'], networkEngine: 'egress-proxy', allowedProtocols: ['http', 'https'] },
  'AI.CLOUD': { requiresUserOptIn: true, strictLocalBlocks: true, secretsNeverInPayload: true },
  'TRANSFER.SEND': { userGestureRequired: true },
  'TRANSFER.RECEIVE': { userGestureRequired: true },
  'RUNTIME.RESTART_SERVICE': { serviceAllowlistRequired: true },
});

const DF = ['device', 'fabric'].join('-'); // assembled from parts (see route-map.js)
const MODULES = Object.freeze({
  web:                  { domains: ['WEB'], capabilities: ['WEB.PUBLIC_FETCH'], approvalBoundary: null },
  ai:                   { domains: ['AI'], capabilities: ['AI.LOCAL', 'AI.CLOUD'], approvalBoundary: null },
  notebook:             { domains: ['AI', 'FILES', 'WEB'], capabilities: ['AI.LOCAL', 'AI.CLOUD', 'FILES.READ', 'WEB.PUBLIC_FETCH'], approvalBoundary: null },
  capture:              { domains: ['WEB', 'FILES'], capabilities: ['WEB.PUBLIC_FETCH', 'FILES.READ', 'FILES.USER_SELECTED_WRITE'], approvalBoundary: null },
  media:                { domains: ['MEDIA', 'WEB', 'FILES'], capabilities: ['MEDIA.INSPECT', 'MEDIA.DOWNLOAD', 'MEDIA.TRANSCODE', 'WEB.PUBLIC_FETCH', 'FILES.USER_SELECTED_WRITE'], approvalBoundary: null },
  'code-intel':         { domains: ['FILES', 'PROCESS'], capabilities: ['FILES.READ', 'PROCESS.START_TYPED'], approvalBoundary: null },
  sales:                { domains: ['AGENCY', 'WEB', 'AI'], capabilities: ['SOCIAL.DRAFT', 'EMAIL.DRAFT', 'SUPPORT.DRAFT', 'WEB.PUBLIC_FETCH', 'AI.LOCAL', 'AI.CLOUD'], approvalBoundary: null },
  'external-agents':    { domains: ['PROCESS', 'FILES'], capabilities: ['PROCESS.START_TYPED', 'FILES.READ', 'FILES.USER_SELECTED_WRITE'], approvalBoundary: null },
  connectors:           { domains: ['CONNECTOR', 'FILES'], capabilities: ['CONNECTOR.READ', 'FILES.READ'], approvalBoundary: null },
  omega:                { domains: ['OMEGA'], capabilities: ['DEVICE.VIEW', 'DEVICE.INTERACTIVE', 'DEVICE.ADMIN'], approvalBoundary: 'omega-certified' },
  rassilon:             { domains: ['RASSILON'], capabilities: ['RASSILON.JOB'], approvalBoundary: 'rassilon-certified' },
  [DF]:                 { domains: ['DEVICE_FABRIC'], capabilities: ['DEVICE.VIEW', 'DEVICE.INTERACTIVE', 'DEVICE.ADMIN', 'RASSILON.JOB'], approvalBoundary: `${DF}-certified` },
  maitre:               { domains: ['MAITRE', 'PROCESS', 'FILES'], capabilities: ['PROCESS.STOP_OWNED', 'FILES.READ'], approvalBoundary: 'maitre-certified' },
  policy:               { domains: ['POLICY'], capabilities: ['POLICY.READ'], approvalBoundary: null },
  // Prepared for future modules (no code calls them yet). Distinct domains, no shared grant.
  transfer:             { domains: ['TRANSFER'], capabilities: ['TRANSFER.SEND', 'TRANSFER.RECEIVE', 'FILES.USER_SELECTED_WRITE'], approvalBoundary: null },
  agency:               { domains: ['AGENCY'], capabilities: ['SOCIAL.DRAFT', 'SOCIAL.PUBLISH', 'EMAIL.DRAFT', 'EMAIL.SEND', 'SUPPORT.DRAFT', 'SUPPORT.SEND'], approvalBoundary: null },
  'runtime-supervisor': { domains: ['RUNTIME'], capabilities: ['RUNTIME.RESTART_SERVICE'], approvalBoundary: null },
});

const BOUNDARIES = Object.freeze({
  'omega-certified': { covers: ['DEVICE_VIEW', 'DEVICE_INTERACTIVE', 'DEVICE_ADMIN', 'DEVICE_STOP'], description: 'OMEGA V1/V2: session, exact-target, local approval of high-impact admin actions (LOCK/LOGOFF/RESTART/SHUTDOWN) and STOP are enforced by the OMEGA modules themselves.' },
  'rassilon-certified': { covers: ['RASSILON_JOB', 'DEVICE_STOP'], description: 'RASSILON: semantic jobs only, pairing/consent and STOP enforced by the RASSILON modules.' },
  [`${DF}-certified`]: { covers: ['DEVICE_VIEW', 'DEVICE_INTERACTIVE', 'DEVICE_ADMIN', 'DEVICE_STOP', 'RASSILON_JOB'], description: 'Device Fabric: exact-target routing to OMEGA V2 / RASSILON; the target domain keeps its own approvals.' },
  'maitre-certified': { covers: ['PROCESS_STOP'], description: 'MAITRE: proposal, local approval, PID/start-time/path re-check at execution.' },
});

export function buildDefaultPolicy({ version = 1, issuedAt = new Date().toISOString() } = {}) {
  const capabilities = {};
  for (const name of KNOWN_CAPABILITIES) {
    capabilities[name] = { grantable: !NEVER_GRANTED_CAPABILITIES.has(name) };
    if (CAPABILITY_CONSTRAINTS[name]) capabilities[name].constraints = CAPABILITY_CONSTRAINTS[name];
  }
  const actions = {};
  for (const id of ACTION_IDS) {
    const c = ACTION_CEILING[id];
    actions[id] = { impact: c.impact, protected: c.protected, actors: [...c.actors], enabled: !c.never };
  }
  return {
    schema: POLICY_SCHEMA,
    version,
    issuedAt,
    invariants: Object.fromEntries(ROOT_INVARIANTS.map(n => [n, true])),
    trustDomains: [...TRUST_DOMAINS],
    capabilities,
    actions,
    modules: JSON.parse(JSON.stringify(MODULES)),
    approvalBoundaries: JSON.parse(JSON.stringify(BOUNDARIES)),
  };
}
