/**
 * ROOT POLICY V1 — deterministic decision engine.
 *
 * decide(request) → { decision, code, reason, policyVersion, action, domain, capability, hints }
 *   decision ∈ ALLOW | DENY | REQUIRE_APPROVAL | NOT_APPLICABLE
 *
 * Pure function of (policy, request, approval registry): no network, no LLM, no I/O, no clock other than the injected `now`.
 * It decides whether THIS action, in THIS context, may be attempted. It does not replace the guards below it (Web Egress Guard decides
 * whether a destination is safe; certified modules keep their own approval boundaries — the engine recognises them, it does not redo them).
 *
 * The nine root invariants are hard-coded here (their semantics are not configurable); the policy file only grants capabilities to
 * modules and fixes constraints inside the ceilings of schema.js.
 */
import crypto from 'node:crypto';
import { ACTION_CEILING, ACTORS, AI_ACTORS, PROTECTED_ACTION_IDS, STOP_ACTION_IDS, UNTRUSTED_ORIGIN_ACTORS, canonicalize } from './schema.js';

export const DECISION = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY', REQUIRE_APPROVAL: 'REQUIRE_APPROVAL', NOT_APPLICABLE: 'NOT_APPLICABLE' });

/** High-precision credential shapes only (no heuristics on ordinary text). Used for ROOT RULE 2 on outbound AI payloads. */
const SECRET_SHAPES = Object.freeze([
  /sk-ant-[A-Za-z0-9_-]{20,}/, /sk-or-[A-Za-z0-9_-]{20,}/, /gsk_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{35}/, /sk-[A-Za-z0-9]{32,}/,
  /ghp_[A-Za-z0-9]{36}/, /github_pat_[A-Za-z0-9_]{40,}/, /xox[baprs]-[A-Za-z0-9-]{20,}/, /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----/, /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
]);
export function containsSecretShape(text) {
  const s = typeof text === 'string' ? text : '';
  return SECRET_SHAPES.some(re => re.test(s));
}

/** Digest an approval is bound to: the exact action, module, domain, target and payload hash (nothing else). */
export function computeActionDigest(request) {
  return crypto.createHash('sha256').update(canonicalize({
    action: request.action, module: request.module ?? null, domain: request.trustDomain ?? null,
    target: request.context?.target ?? null, payload: request.context?.payloadHash ?? null,
  })).digest('hex');
}

const verdict = (decision, code, base, extra = {}) => ({ decision, code, reason: code, policyVersion: base.policyVersion, action: base.action, domain: base.domain ?? null, capability: base.capability ?? null, ...extra });

/**
 * @param {{ getPolicy:()=>({ valid:boolean, policy?:object, version?:number }), approvals?:{ consume:(token:string, digest:string)=>boolean }, now?:()=>number }} deps
 */
export function createEngine({ getPolicy, approvals = null, now = Date.now }) {
  function decide(input) {
    const request = input && typeof input === 'object' ? input : {};
    const action = typeof request.action === 'string' ? request.action : '';
    const state = getPolicy();
    const policyVersion = state?.valid ? state.version : 0;
    const base = { policyVersion, action };

    const ceiling = ACTION_CEILING[action];
    // Unknown action id presented to the Root Policy ⇒ DENY (rule 9: unknown ⇒ deny for operations that explicitly rely on it).
    if (!ceiling) return verdict(DECISION.DENY, 'DENY_UNKNOWN_ACTION', base);
    Object.assign(base, { domain: request.trustDomain ?? null, capability: ceiling.capability });

    // Rule 8 — nobody, ever, updates the policy (hard-coded, independent of the policy file).
    if (ceiling.never === 'DENY_POLICY_IMMUTABLE') return verdict(DECISION.DENY, 'DENY_POLICY_IMMUTABLE', base);
    // Rule 5 — arbitrary execution is never an allowed action for anyone.
    if (ceiling.never === 'DENY_ARBITRARY_EXECUTION') return verdict(DECISION.DENY, 'DENY_ARBITRARY_EXECUTION', base);

    const actor = ACTORS.includes(request.actor?.kind) ? request.actor.kind : null;
    if (!actor) return verdict(DECISION.DENY, 'DENY_UNKNOWN_ACTOR', base);

    // Rule 7 — STOP / revocation wins: always allowed, even when the policy cannot be trusted and whatever the actor/session says.
    if (STOP_ACTION_IDS.has(action)) return verdict(DECISION.ALLOW, 'ALLOW_STOP_ALWAYS', base);

    // Rule 9 — protected operations fail closed when the policy is missing, corrupt, tampered or not loaded.
    if (!state?.valid) {
      if (PROTECTED_ACTION_IDS.has(action)) return verdict(DECISION.DENY, 'DENY_POLICY_INVALID', base);
      return verdict(DECISION.NOT_APPLICABLE, 'NOT_APPLICABLE_UNPROTECTED', base);
    }
    const policy = state.policy;
    const cfg = policy.actions[action];
    if (!cfg?.enabled) return verdict(DECISION.DENY, 'DENY_ACTION_DISABLED', base);

    // Rule 7 (revocation) — a revoked / expired session, token or device beats any normal command.
    const session = request.session?.state;
    if (session && session !== 'ACTIVE') return verdict(DECISION.DENY, 'DENY_SESSION_REVOKED', base);

    // Actors: the policy lists who may ever request this action; attacker-influenced origins are further constrained below.
    if (!cfg.actors.includes(actor)) return verdict(DECISION.DENY, 'DENY_ACTOR_NOT_PERMITTED', base);

    // Rule 6 — trust domains never merge: the request's domain must be one this action belongs to AND one the calling module is entitled to.
    const domain = request.trustDomain;
    if (!ceiling.domains.includes(domain)) return verdict(DECISION.DENY, 'DENY_TRUST_DOMAIN_MISMATCH', base);

    const moduleName = typeof request.module === 'string' ? request.module : '';
    const mod = policy.modules[moduleName];
    if (!mod) return verdict(DECISION.DENY, 'DENY_UNKNOWN_MODULE', base);
    if (!mod.domains.includes(domain)) return verdict(DECISION.DENY, 'DENY_TRUST_DOMAIN_MISMATCH', base);

    // Capabilities: ALLOW(action, capability, context) — never ALLOW(module).
    const capability = ceiling.capability;
    if (capability) {
      const declared = policy.capabilities[capability];
      if (!declared) return verdict(DECISION.DENY, 'DENY_UNKNOWN_CAPABILITY', base);
      if (!declared.grantable || !mod.capabilities.includes(capability)) return verdict(DECISION.DENY, 'DENY_CAPABILITY_NOT_GRANTED', base);
    }

    const ctx = request.context && typeof request.context === 'object' ? request.context : {};
    const untrusted = UNTRUSTED_ORIGIN_ACTORS.has(actor);
    const hints = [];

    // Rule 3 — no authorization bypass (public / user-owned / user-authorized resources stay fully usable).
    const constraints = declared_constraints(policy, capability);
    if (ctx.accessMode !== undefined) {
      const allowedModes = constraints?.accessModes ?? ['public', 'user-owned', 'user-authorized'];
      if (!allowedModes.includes(ctx.accessMode)) return verdict(DECISION.DENY, 'DENY_AUTH_BYPASS', base);
    }
    if (ctx.circumvention === true || ctx.drmCircumvention === true || ctx.paywallBypass === true) return verdict(DECISION.DENY, 'DENY_AUTH_BYPASS', base);
    // A caller that merely LABELS a destination "public" is not trusted: the label must agree with the network guard's classification.
    if (constraints?.networkClasses && ctx.networkClass !== undefined && !constraints.networkClasses.includes(ctx.networkClass)) return verdict(DECISION.DENY, 'DENY_NOT_PUBLIC_NETWORK', base);

    // Rule 5 — typed executors only: a known executor id, no free-form command line, no shell interpretation.
    if (ceiling.typedExecutor) {
      if (typeof ctx.executorId !== 'string' || !ctx.executorId || ctx.argsTyped !== true || ctx.freeFormCommand === true || ctx.viaShell === true) {
        return verdict(DECISION.DENY, 'DENY_ARBITRARY_EXECUTION', base);
      }
      if (untrusted) return verdict(DECISION.DENY, 'DENY_ACTOR_NOT_PERMITTED', base);
    }
    if (ceiling.serviceAllowlist && (typeof ctx.serviceId !== 'string' || !ctx.serviceId)) return verdict(DECISION.DENY, 'DENY_UNKNOWN_CAPABILITY', base);

    // User gesture: required for attacker-influenceable origins on actions that move data / change state, always for transfer actions.
    const userInitiated = request.userInitiated === true;
    if ((ceiling.userInitiatedRequired || (ceiling.aiNeedsUserInitiated && AI_ACTORS.has(actor))) && !userInitiated) return verdict(DECISION.DENY, 'DENY_NOT_USER_INITIATED', base);
    if (untrusted && actor !== 'AI_LOCAL' && actor !== 'AI_CLOUD' && actor !== 'AGENT' && ceiling.impact !== 'LOW') return verdict(DECISION.DENY, 'DENY_ACTOR_NOT_PERMITTED', base);

    // ── per-action semantics ──────────────────────────────────────────────────────────────────────────────────────
    let allowCode = 'ALLOW_CAPABILITY';
    switch (action) {
      case 'AI_LOCAL_REQUEST':
        allowCode = 'ALLOW_LOCAL_AI';
        break;
      case 'AI_CLOUD_REQUEST': {
        // Rule 2 — no secret leak toward an LLM/provider; Rule 1 — strict local first, cloud stays usable when explicitly enabled.
        if (ctx.strictLocal === true) return verdict(DECISION.DENY, 'DENY_STRICT_LOCAL', base);
        if (ctx.cloudEnabled !== true || ctx.providerConfigured === false) return verdict(DECISION.DENY, 'DENY_CLOUD_NOT_ENABLED', base);
        if (ctx.containsSecret === true) return verdict(DECISION.DENY, 'DENY_SECRET_EXPOSURE', base);
        if (ctx.localEquivalentAvailable === true && ctx.userChoseCloud !== true) hints.push('PREFER_LOCAL');
        allowCode = 'ALLOW_CLOUD_OPT_IN';
        break;
      }
      case 'WEB_FETCH':
        if (ctx.credentialsInPayload === true || ctx.containsSecret === true) return verdict(DECISION.DENY, 'DENY_SECRET_EXPOSURE', base);
        allowCode = 'ALLOW_WEB_PUBLIC_FETCH';
        break;
      case 'MEDIA_INSPECT':
      case 'MEDIA_DOWNLOAD':
        // Cookies / tokens harvested from a browser may only be used when the USER configured it; never on behalf of model/remote/plugin origins.
        if (ctx.credentialSource === 'user-browser-session' && untrusted) return verdict(DECISION.DENY, 'DENY_AUTH_BYPASS', base);
        if (ctx.credentialsInPayload === true) return verdict(DECISION.DENY, 'DENY_SECRET_EXPOSURE', base);
        allowCode = userInitiated ? 'ALLOW_USER_INITIATED_MEDIA' : 'ALLOW_MEDIA_DOWNLOAD';
        break;
      case 'SOCIAL_DRAFT': case 'EMAIL_DRAFT': case 'SUPPORT_DRAFT':
        allowCode = 'ALLOW_DRAFT';
        break;
      case 'POLICY_READ':
        allowCode = 'ALLOW_POLICY_READ';
        break;
      case 'SHELL_INTERNAL': case 'PROCESS_START':
        allowCode = 'ALLOW_INTERNAL_TYPED_EXECUTOR';
        break;
      default:
        break;
    }

    // Rule 4 — HIGH impact ⇒ approval. A module with a CERTIFIED approval boundary covering the action keeps its own approval flow
    // (no double confirmation); otherwise a one-time LOCAL human approval bound to the exact action is required.
    if (cfg.impact === 'HIGH') {
      const boundaryName = mod.approvalBoundary;
      const boundary = boundaryName ? policy.approvalBoundaries[boundaryName] : null;
      if (boundary?.covers.includes(action) && request.certifiedBoundary === true && !untrusted) {
        return verdict(DECISION.ALLOW, 'ALLOW_CERTIFIED_BOUNDARY', base, { boundary: boundaryName });
      }
      const token = request.approval?.token;
      if (typeof token === 'string' && approvals && !untrusted && approvals.consume(token, computeActionDigest(request))) {
        return verdict(DECISION.ALLOW, 'ALLOW_LOCAL_APPROVAL', base);
      }
      return verdict(DECISION.REQUIRE_APPROVAL, 'REQUIRE_LOCAL_APPROVAL', base, { digest: computeActionDigest(request) });
    }
    return verdict(DECISION.ALLOW, allowCode, base, hints.length ? { hints } : {});
  }

  return { decide };
}

function declared_constraints(policy, capability) {
  return capability ? policy.capabilities[capability]?.constraints ?? null : null;
}

/** In-memory one-time local approvals. `issue` is deliberately NOT reachable from any HTTP route (see the static audit). */
export function createApprovalRegistry({ now = Date.now, ttlMs = 5 * 60_000, max = 256 } = {}) {
  const entries = new Map();
  const prune = () => { const t = now(); for (const [k, v] of entries) if (v.expiresAt <= t || v.used) entries.delete(k); while (entries.size > max) entries.delete(entries.keys().next().value); };
  return {
    issue(digest) { prune(); const token = crypto.randomBytes(24).toString('base64url'); entries.set(token, { digest, expiresAt: now() + ttlMs, used: false }); return token; },
    consume(token, digest) {
      prune();
      const entry = entries.get(token);
      if (!entry || entry.used || entry.expiresAt <= now() || entry.digest !== digest) return false;
      entry.used = true;
      return true;
    },
    size: () => entries.size,
  };
}
