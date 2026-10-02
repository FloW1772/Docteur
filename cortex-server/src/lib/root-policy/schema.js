/**
 * ROOT POLICY V1 — semantic skeleton, hard ceilings, strict validation, canonical JSON.
 *
 * Two layers, on purpose:
 *   1. CODE (this file) fixes the vocabulary and the CEILINGS: which semantic actions exist, which trust domain / capability each belongs
 *      to, the minimum impact level, which actors may ever be allowed, and the actions that can NEVER be allowed (policy update, arbitrary
 *      shell, plugin/MCP installation by anything). A signed policy file can only configure things INSIDE these ceilings.
 *   2. The signed POLICY FILE (policy/root-policy.json) grants capabilities to modules and fixes per-capability constraints. A validly
 *      signed but over-permissive file is still refused by `validatePolicy` (defense in depth: signature ≠ permission to exceed the ceiling).
 *
 * No LLM, no network, no I/O in this file.
 */

import { validateExecutorsConstraint } from './process-rules.js';

export const POLICY_SCHEMA = 'docteur.root-policy/1';
/** Release floor: a policy older than this is refused (anti-rollback, together with the per-machine highest-seen version). */
export const MIN_POLICY_VERSION = 1;

export const ACTORS = Object.freeze(['USER', 'MODULE', 'AI_LOCAL', 'AI_CLOUD', 'AGENT', 'PLUGIN', 'MCP', 'REMOTE', 'CONNECTOR', 'DOCUMENT']);
/** Origins that can carry attacker-influenced intent (model output, plugin, remote caller, imported text…). */
export const UNTRUSTED_ORIGIN_ACTORS = Object.freeze(new Set(['AI_LOCAL', 'AI_CLOUD', 'AGENT', 'PLUGIN', 'MCP', 'REMOTE', 'CONNECTOR', 'DOCUMENT']));
export const AI_ACTORS = Object.freeze(new Set(['AI_LOCAL', 'AI_CLOUD', 'AGENT']));

export const TRUST_DOMAINS = Object.freeze([
  'AI', 'WEB', 'MEDIA', 'FILES', 'PROCESS', 'RUNTIME', 'CONNECTOR', 'OMEGA', 'RASSILON', 'DEVICE_FABRIC', 'MAITRE',
  'TRANSFER', 'AGENCY', 'PLUGIN', 'POLICY',
]);
export const IMPACTS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
const IMPACT_RANK = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2 });

const HUMAN_OR_MODULE = Object.freeze(['USER', 'MODULE']);
const WITH_AI = Object.freeze(['USER', 'MODULE', 'AI_LOCAL', 'AI_CLOUD', 'AGENT']);
const EVERYONE = Object.freeze([...ACTORS]);

/**
 * The action catalogue. `domains` = trust domains in which the action may be requested. `capability` = what a module must have been granted.
 * `protected` = relevant to Root Policy rule 9 (fail closed when the policy cannot be trusted). `stop` = STOP/revocation class (always allowed).
 * `never` = no actor, no module, no policy file can ever allow it.
 */
export const ACTION_CEILING = Object.freeze({
  // ── web / media ────────────────────────────────────────────────────────────────────────────────────────────────
  WEB_FETCH:        { domains: ['WEB'], capability: 'WEB.PUBLIC_FETCH', impact: 'LOW', protected: true, actors: ['USER', 'MODULE', 'AI_LOCAL', 'AI_CLOUD', 'AGENT'] },
  MEDIA_INSPECT:    { domains: ['MEDIA'], capability: 'MEDIA.INSPECT', impact: 'LOW', protected: true, actors: WITH_AI, aiNeedsUserInitiated: false },
  MEDIA_DOWNLOAD:   { domains: ['MEDIA'], capability: 'MEDIA.DOWNLOAD', impact: 'MEDIUM', protected: true, actors: WITH_AI, aiNeedsUserInitiated: true },
  MEDIA_TRANSCODE:  { domains: ['MEDIA'], capability: 'MEDIA.TRANSCODE', impact: 'LOW', protected: false, actors: WITH_AI },
  // ── files / process / runtime ─────────────────────────────────────────────────────────────────────────────────
  FILE_READ:        { domains: ['FILES'], capability: 'FILES.READ', impact: 'LOW', protected: false, actors: EVERYONE },
  FILE_WRITE:       { domains: ['FILES'], capability: 'FILES.USER_SELECTED_WRITE', impact: 'MEDIUM', protected: true, actors: WITH_AI, aiNeedsUserInitiated: true },
  FILE_DELETE:      { domains: ['FILES'], capability: 'FILES.DELETE', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  PROCESS_START:    { domains: ['PROCESS'], capability: 'PROCESS.START_TYPED', impact: 'MEDIUM', protected: true, actors: ['MODULE'], typedExecutor: true },
  PROCESS_STOP:     { domains: ['PROCESS', 'MAITRE'], capability: 'PROCESS.STOP_OWNED', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  SERVICE_RESTART:  { domains: ['RUNTIME'], capability: 'RUNTIME.RESTART_SERVICE', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE, serviceAllowlist: true },
  SHELL_INTERNAL:   { domains: ['PROCESS'], capability: 'PROCESS.SHELL_INTERNAL', impact: 'MEDIUM', protected: true, actors: ['MODULE'], typedExecutor: true },
  SHELL_ARBITRARY:  { domains: ['PROCESS'], capability: null, impact: 'HIGH', protected: true, actors: [], never: 'DENY_ARBITRARY_EXECUTION' },
  // ── AI ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  AI_LOCAL_REQUEST: { domains: ['AI'], capability: 'AI.LOCAL', impact: 'LOW', protected: false, actors: EVERYONE },
  AI_CLOUD_REQUEST: { domains: ['AI'], capability: 'AI.CLOUD', impact: 'MEDIUM', protected: true, actors: WITH_AI },
  // ── connectors ─────────────────────────────────────────────────────────────────────────────────────────────────
  CONNECTOR_READ:   { domains: ['CONNECTOR'], capability: 'CONNECTOR.READ', impact: 'LOW', protected: false, actors: HUMAN_OR_MODULE },
  CONNECTOR_WRITE:  { domains: ['CONNECTOR'], capability: 'CONNECTOR.WRITE', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  // ── devices (certified trust domains stay distinct) ───────────────────────────────────────────────────────────
  DEVICE_VIEW:        { domains: ['OMEGA', 'DEVICE_FABRIC'], capability: 'DEVICE.VIEW', impact: 'MEDIUM', protected: true, actors: HUMAN_OR_MODULE },
  DEVICE_INTERACTIVE: { domains: ['OMEGA', 'DEVICE_FABRIC'], capability: 'DEVICE.INTERACTIVE', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  DEVICE_ADMIN:       { domains: ['OMEGA', 'DEVICE_FABRIC'], capability: 'DEVICE.ADMIN', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  DEVICE_STOP:        { domains: ['OMEGA', 'RASSILON', 'DEVICE_FABRIC'], capability: null, impact: 'LOW', protected: true, actors: EVERYONE, stop: true },
  RASSILON_JOB:       { domains: ['RASSILON', 'DEVICE_FABRIC'], capability: 'RASSILON.JOB', impact: 'MEDIUM', protected: true, actors: HUMAN_OR_MODULE },
  // ── transfer / agency (prepared, not implemented) ─────────────────────────────────────────────────────────────
  TRANSFER_SEND:    { domains: ['TRANSFER'], capability: 'TRANSFER.SEND', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE, userInitiatedRequired: true },
  TRANSFER_RECEIVE: { domains: ['TRANSFER'], capability: 'TRANSFER.RECEIVE', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE, userInitiatedRequired: true },
  SOCIAL_DRAFT:     { domains: ['AGENCY'], capability: 'SOCIAL.DRAFT', impact: 'LOW', protected: false, actors: WITH_AI },
  SOCIAL_PUBLISH:   { domains: ['AGENCY'], capability: 'SOCIAL.PUBLISH', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  EMAIL_DRAFT:      { domains: ['AGENCY'], capability: 'EMAIL.DRAFT', impact: 'LOW', protected: false, actors: WITH_AI },
  EMAIL_SEND:       { domains: ['AGENCY'], capability: 'EMAIL.SEND', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  SUPPORT_DRAFT:    { domains: ['AGENCY'], capability: 'SUPPORT.DRAFT', impact: 'LOW', protected: false, actors: WITH_AI },
  SUPPORT_SEND:     { domains: ['AGENCY'], capability: 'SUPPORT.SEND', impact: 'HIGH', protected: true, actors: HUMAN_OR_MODULE },
  // ── extension surfaces (no module may ever be granted these in V1) ────────────────────────────────────────────
  PLUGIN_INSTALL:   { domains: ['PLUGIN'], capability: 'PLUGIN.INSTALL', impact: 'HIGH', protected: true, actors: ['USER'], noModuleGrant: true },
  PLUGIN_UPDATE:    { domains: ['PLUGIN'], capability: 'PLUGIN.UPDATE', impact: 'HIGH', protected: true, actors: ['USER'], noModuleGrant: true },
  MCP_START:        { domains: ['PLUGIN'], capability: 'MCP.START', impact: 'HIGH', protected: true, actors: ['USER'], noModuleGrant: true },
  // ── the policy itself ──────────────────────────────────────────────────────────────────────────────────────────
  POLICY_READ:      { domains: ['POLICY'], capability: 'POLICY.READ', impact: 'LOW', protected: false, actors: EVERYONE },
  POLICY_UPDATE:    { domains: ['POLICY'], capability: null, impact: 'HIGH', protected: true, actors: [], never: 'DENY_POLICY_IMMUTABLE' },
});

export const ACTION_IDS = Object.freeze(Object.keys(ACTION_CEILING));
export const PROTECTED_ACTION_IDS = Object.freeze(new Set(ACTION_IDS.filter(id => ACTION_CEILING[id].protected)));
export const STOP_ACTION_IDS = Object.freeze(new Set(ACTION_IDS.filter(id => ACTION_CEILING[id].stop)));

/** Capabilities that no module may hold in V1 (and that no policy file can add). */
export const NEVER_GRANTED_CAPABILITIES = Object.freeze(new Set(['POLICY.UPDATE', 'PROCESS.SHELL_ARBITRARY', 'PLUGIN.INSTALL', 'PLUGIN.UPDATE', 'MCP.START']));
export const KNOWN_CAPABILITIES = Object.freeze(new Set([
  ...ACTION_IDS.map(id => ACTION_CEILING[id].capability).filter(Boolean),
]));

/** The nine root invariants. A policy must declare every one `true`; the engine hard-codes their semantics (they are not configurable). */
export const ROOT_INVARIANTS = Object.freeze([
  'strictLocalFirst', 'noSecretLeak', 'noAuthorizationBypass', 'highImpactRequiresApproval', 'noArbitraryExecution',
  'trustDomainsNeverMerge', 'stopAndRevocationWin', 'policyImmutableByAi', 'unknownProtectedDenies',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Canonical JSON (deterministic: sorted keys, no insignificant whitespace, UTF-8). Duplicate keys / reordering / reformatting of the
// FILE are therefore detectable: a file is valid only if its text is byte-identical to canonicalize(JSON.parse(text)).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalize: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalize: unsupported type ${t}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (obj, allowed, path, errors) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${path}.${k}: unknown key`); };
const isStrArray = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
const ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * Strict validation. Returns { ok:true } or { ok:false, errors:[…] } (errors are structural paths, never policy content).
 * Enforces the CEILINGS: a policy may be stricter than the skeleton, never more permissive.
 */
export function validatePolicy(policy) {
  const errors = [];
  if (!isObj(policy)) return { ok: false, errors: ['$: not an object'] };
  only(policy, ['schema', 'version', 'issuedAt', 'invariants', 'trustDomains', 'capabilities', 'actions', 'modules', 'approvalBoundaries'], '$', errors);
  if (policy.schema !== POLICY_SCHEMA) errors.push('$.schema: unsupported');
  if (!Number.isInteger(policy.version) || policy.version < MIN_POLICY_VERSION) errors.push('$.version: invalid');
  if (typeof policy.issuedAt !== 'string' || Number.isNaN(Date.parse(policy.issuedAt))) errors.push('$.issuedAt: invalid');

  // invariants: all nine present and true, nothing else
  if (!isObj(policy.invariants)) errors.push('$.invariants: missing');
  else {
    only(policy.invariants, ROOT_INVARIANTS, '$.invariants', errors);
    for (const name of ROOT_INVARIANTS) if (policy.invariants[name] !== true) errors.push(`$.invariants.${name}: must be true`);
  }

  if (!isStrArray(policy.trustDomains) || policy.trustDomains.length !== TRUST_DOMAINS.length || !TRUST_DOMAINS.every(d => policy.trustDomains.includes(d))) errors.push('$.trustDomains: must list exactly the known domains');

  // capabilities: known ones only, constraints are plain data
  const capabilityNames = new Set();
  if (!isObj(policy.capabilities)) errors.push('$.capabilities: missing');
  else for (const [name, def] of Object.entries(policy.capabilities)) {
    capabilityNames.add(name);
    if (!KNOWN_CAPABILITIES.has(name)) errors.push(`$.capabilities.${name}: unknown capability`);
    if (NEVER_GRANTED_CAPABILITIES.has(name) && def?.grantable !== false) errors.push(`$.capabilities.${name}: can never be grantable`);
    if (!isObj(def)) { errors.push(`$.capabilities.${name}: not an object`); continue; }
    only(def, ['grantable', 'constraints'], `$.capabilities.${name}`, errors);
    if (typeof def.grantable !== 'boolean') errors.push(`$.capabilities.${name}.grantable: boolean required`);
    if (def.constraints !== undefined && !isObj(def.constraints)) errors.push(`$.capabilities.${name}.constraints: object required`);
  }

  // typed process rules (RPC-2C): the only constraint PROCESS.START_TYPED accepts; structure and templates are checked here, so a malformed
  // (even validly signed) document is refused at load
  const processConstraints = isObj(policy.capabilities) ? policy.capabilities['PROCESS.START_TYPED']?.constraints : undefined;
  if (processConstraints !== undefined) {
    only(processConstraints, ['executors'], '$.capabilities.PROCESS.START_TYPED.constraints', errors);
    if (processConstraints.executors !== undefined) {
      const hasProcessCapability = (moduleName) => isObj(policy.modules) && isObj(policy.modules[moduleName]) && isStrArray(policy.modules[moduleName].capabilities) && policy.modules[moduleName].capabilities.includes('PROCESS.START_TYPED');
      validateExecutorsConstraint(processConstraints.executors, '$.capabilities.PROCESS.START_TYPED.constraints.executors', errors, { isModuleWithProcessCapability: hasProcessCapability });
    }
  }

  // actions: every catalogue action configured, within the ceiling
  if (!isObj(policy.actions)) errors.push('$.actions: missing');
  else {
    for (const id of ACTION_IDS) if (!(id in policy.actions)) errors.push(`$.actions.${id}: missing`);
    for (const [id, def] of Object.entries(policy.actions)) {
      const ceil = ACTION_CEILING[id];
      if (!ceil) { errors.push(`$.actions.${id}: unknown action`); continue; }
      if (!isObj(def)) { errors.push(`$.actions.${id}: not an object`); continue; }
      only(def, ['impact', 'protected', 'actors', 'enabled'], `$.actions.${id}`, errors);
      if (!IMPACTS.includes(def.impact) || IMPACT_RANK[def.impact] < IMPACT_RANK[ceil.impact]) errors.push(`$.actions.${id}.impact: below ceiling`);
      if (def.protected !== true && ceil.protected) errors.push(`$.actions.${id}.protected: ceiling is protected`);
      if (typeof def.protected !== 'boolean') errors.push(`$.actions.${id}.protected: boolean required`);
      if (!isStrArray(def.actors) || def.actors.some(a => !ceil.actors.includes(a))) errors.push(`$.actions.${id}.actors: exceeds ceiling`);
      if (ceil.never && (def.enabled !== false || (def.actors?.length ?? 0) > 0)) errors.push(`$.actions.${id}: can never be enabled`);
      if (typeof def.enabled !== 'boolean') errors.push(`$.actions.${id}.enabled: boolean required`);
    }
  }

  // modules: grants within the catalogue; no never-granted / noModuleGrant capability; domains known
  if (!isObj(policy.modules)) errors.push('$.modules: missing');
  else for (const [name, def] of Object.entries(policy.modules)) {
    if (!ID_RE.test(name)) errors.push(`$.modules.${name}: invalid id`);
    if (!isObj(def)) { errors.push(`$.modules.${name}: not an object`); continue; }
    only(def, ['domains', 'capabilities', 'approvalBoundary'], `$.modules.${name}`, errors);
    if (!isStrArray(def.domains) || def.domains.some(d => !TRUST_DOMAINS.includes(d))) errors.push(`$.modules.${name}.domains: invalid`);
    if (!isStrArray(def.capabilities)) { errors.push(`$.modules.${name}.capabilities: invalid`); continue; }
    for (const cap of def.capabilities) {
      if (!KNOWN_CAPABILITIES.has(cap)) errors.push(`$.modules.${name}.capabilities: unknown capability ${cap}`);
      if (NEVER_GRANTED_CAPABILITIES.has(cap)) errors.push(`$.modules.${name}.capabilities: ${cap} is never grantable`);
      if (!capabilityNames.has(cap)) errors.push(`$.modules.${name}.capabilities: ${cap} not declared`);
    }
    if (def.approvalBoundary !== null && typeof def.approvalBoundary !== 'string') errors.push(`$.modules.${name}.approvalBoundary: string or null`);
    if (typeof def.approvalBoundary === 'string' && !(policy.approvalBoundaries && def.approvalBoundary in policy.approvalBoundaries)) errors.push(`$.modules.${name}.approvalBoundary: undeclared`);
  }

  // approval boundaries: only HIGH/MEDIUM actions of certified device domains; never the policy
  if (!isObj(policy.approvalBoundaries)) errors.push('$.approvalBoundaries: missing');
  else for (const [name, def] of Object.entries(policy.approvalBoundaries)) {
    if (!isObj(def)) { errors.push(`$.approvalBoundaries.${name}: not an object`); continue; }
    only(def, ['covers', 'description'], `$.approvalBoundaries.${name}`, errors);
    if (!isStrArray(def.covers) || def.covers.some(a => !ACTION_CEILING[a] || ACTION_CEILING[a].never || ACTION_CEILING[a].noModuleGrant)) errors.push(`$.approvalBoundaries.${name}.covers: invalid`);
    if (typeof def.description !== 'string') errors.push(`$.approvalBoundaries.${name}.description: string required`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function impactAtLeast(a, b) { return IMPACT_RANK[a] >= IMPACT_RANK[b]; }
