// [RS-KIWIX-RESTART] Runtime Supervisor — local restart ceremony + INTERNAL restart authorization (Root Policy V2 pre-sign).
//
// The only component allowed to ask Root Policy for SERVICE_RESTART with `certifiedBoundary: true`, and only right after a
// local restart challenge has been CONSUMED (static tests pin both facts). Nothing here comes from a request body as a flag:
// the HTTP layer can only name a serviceId, echo an opaque challenge id and describe the trusted gesture that confirmed it.
//
//   1. issueChallenge   USER actor + closed service list + a policy that declares the runtime boundary (read-only view) +
//                       an OWNED, running instance ⇒ a 256-bit random challenge id, memory only, ≤ 90 s, one per service,
//                       bound to: serviceId, action SERVICE_RESTART, definition digest, generation, state, pid, startedAt and
//                       the browser origin that asked for it.
//   2. confirmChallenge synchronous from lookup to mint (no await ⇒ two concurrent confirmations cannot both pass): replay /
//                       unknown / expired / other service / other origin / changed binding refused; the challenge is BURNT
//                       before anything else is evaluated; THEN Root Policy decides; only ALLOW_CERTIFIED_BOUNDARY on the exact
//                       runtime boundary mints an authorization.
//   3. redeem           the delegate (process owner) checks the authorization against ITS live binding; single use, ≤ 10 s.
//
// The authorization is an instance of a module-private class whose binding lives in a WeakMap: it carries no data, cannot be
// rebuilt from JSON, a copy or another object, and serializes to a fixed marker. Challenge ids are never logged or audited.
// What this does NOT prove: that a person (and not a local process driving the same browser / UI session, or forging its
// headers) clicked — LOCAL_PROCESS_UI_IMPERSONATION_RESIDUAL_RISK, accepted or not by the user before any policy signing.

import crypto from 'node:crypto';
import { currentActorContext, decide as rootPolicyDecide, getPolicyView as rootPolicyView } from './root-policy/index.js';

export const RESTART_ACTION = 'SERVICE_RESTART';
export const RESTART_POLICY_MODULE = 'runtime-supervisor';
export const RUNTIME_RESTART_BOUNDARY = 'runtime-supervisor-certified';
export const RESTART_CEREMONY_LIMITS = Object.freeze({ challengeTtlMs: 90_000, maxOpenChallenges: 8, consumedMemory: 256, authorizationTtlMs: 10_000 });
export const GESTURE_KINDS = Object.freeze(['POINTER', 'KEYBOARD']);
export const CEREMONY_CODES = Object.freeze({
  ACTOR_NOT_PERMITTED: 'ACTOR_NOT_PERMITTED', SERVICE_NOT_DELEGATED: 'SERVICE_NOT_DELEGATED', POLICY_APPROVAL_REQUIRED: 'ROOT_POLICY_APPROVAL_REQUIRED',
  POLICY_DENIED: 'ROOT_POLICY_DENIED', NOT_RUNNING: 'NOT_RUNNING', CHALLENGE_INVALID: 'CHALLENGE_INVALID', CHALLENGE_UNKNOWN: 'CHALLENGE_UNKNOWN',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED', CHALLENGE_REPLAYED: 'CHALLENGE_REPLAYED', CHALLENGE_WRONG_SERVICE: 'CHALLENGE_WRONG_SERVICE',
  CHALLENGE_ORIGIN_MISMATCH: 'CHALLENGE_ORIGIN_MISMATCH', DEFINITION_CHANGED: 'DEFINITION_CHANGED', INSTANCE_CHANGED: 'INSTANCE_CHANGED',
  STATE_CHANGED: 'STATE_CHANGED', GESTURE_INVALID: 'GESTURE_INVALID',
});
const C = CEREMONY_CODES;
const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RESTARTABLE_STATES = Object.freeze(['HEALTHY', 'DEGRADED']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const refuse = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });

/** The opaque restart authorization. Not exported: only this module can construct one; its binding lives in `minted`. */
class RuntimeRestartAuthorization {
  toJSON() { return '[runtime-restart-authorization]'; }
  toString() { return '[runtime-restart-authorization]'; }
}

/**
 * The active policy view, verified and FRESH: Root Policy loads lazily and re-checks its files only inside decide(), so a
 * read-only POLICY_READ decision (LOW, unprotected, result unused) runs that same load / integrity path first. Without it a
 * process that never booted Root Policy — or a policy file replaced since the last decision — would be read stale.
 */
function freshRootPolicyView() {
  try { rootPolicyDecide({ action: 'POLICY_READ', module: 'policy', trustDomain: 'POLICY', actor: { kind: 'USER' } }); } catch { /* the view then reports INVALID */ }
  return rootPolicyView();
}

/** The actor the current async work is attributed to (Root Policy's own context), or null for a plain local HTTP request. */
export function ceremonyActorKind() {
  const kind = currentActorContext()?.kind;
  return typeof kind === 'string' ? kind : null;
}

/** The live values a challenge and an authorization are bound to, read from the delegate's own status (never from a request). */
export function restartBinding(status, serviceId) {
  if (!status || typeof status !== 'object') return null;
  const { definitionDigest, generation, state, pid, startedAt, owned } = status;
  if (status.serviceId !== serviceId || owned !== true || typeof definitionDigest !== 'string' || !HEX64.test(definitionDigest)) return null;
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(pid) || pid < 1 || typeof startedAt !== 'string' || typeof state !== 'string') return null;
  return Object.freeze({ serviceId, action: RESTART_ACTION, definitionDigest, generation, state, pid, startedAt });
}

/**
 * @param {object} deps
 *   services      closed list of serviceIds that may be restarted through the ceremony (product: ['kiwix-serve'])
 *   policyDecide  Root Policy decide (default: the real one — under the signed V1 policy it never ALLOWs this)
 *   policyView    read-only view of the active policy (default: the real one) — used ONLY to say whether a restart could be offered
 *   now, random   clock / CSPRNG (tests)
 */
export function createRestartAuthority({ services, policyDecide = rootPolicyDecide, policyView = freshRootPolicyView, now = Date.now, random = crypto.randomBytes } = {}) {
  if (!Array.isArray(services) || services.length === 0 || services.some(s => typeof s !== 'string' || !s)) throw new Error('RESTART_AUTHORITY_INVALID');
  const allowed = new Set(services);
  const open = new Map();      // challengeId → challenge (memory only)
  const consumed = new Map();  // challengeId → consumedAt (bounded, replay recognition)
  const minted = new WeakMap(); // authorization → binding
  const L = RESTART_CEREMONY_LIMITS;
  const remember = (id) => { consumed.set(id, now()); while (consumed.size > L.consumedMemory) consumed.delete(consumed.keys().next().value); };
  const burn = (id) => { open.delete(id); remember(id); };
  const prune = () => { const t = now(); for (const [id, c] of open) if (t >= c.expiresAt) burn(id); };

  /** Whether the ACTIVE policy declares the runtime restart boundary exactly (read-only; never invokes the boundary). */
  function boundaryStatus() {
    let view;
    try { view = policyView(); } catch { view = null; }
    const policy = view?.status?.state === 'VALID' ? view.policy : null;
    if (!policy) return { available: false, code: C.POLICY_DENIED };
    const boundaryName = policy.modules?.[RESTART_POLICY_MODULE]?.approvalBoundary ?? null;
    if (boundaryName !== RUNTIME_RESTART_BOUNDARY) return { available: false, code: C.POLICY_APPROVAL_REQUIRED };
    const covers = policy.approvalBoundaries?.[boundaryName]?.covers;
    if (!Array.isArray(covers) || covers.length !== 1 || covers[0] !== RESTART_ACTION) return { available: false, code: C.POLICY_DENIED };
    return { available: true, code: 'BOUNDARY_DECLARED' };
  }

  function issueChallenge({ serviceId, status, origin, actor } = {}) {
    if (actor !== 'USER') return refuse(C.ACTOR_NOT_PERMITTED);
    if (!allowed.has(serviceId)) return refuse(C.SERVICE_NOT_DELEGATED);
    if (typeof origin !== 'string' || !origin) return refuse(C.ACTOR_NOT_PERMITTED);
    const boundary = boundaryStatus();
    if (!boundary.available) return refuse(boundary.code);
    const binding = restartBinding(status, serviceId);
    if (!binding || !RESTARTABLE_STATES.includes(binding.state)) return refuse(C.NOT_RUNNING);
    prune();
    for (const [id, c] of open) if (c.serviceId === serviceId) burn(id); // one outstanding ceremony per service
    while (open.size >= L.maxOpenChallenges) burn(open.keys().next().value);
    const challengeId = random(32).toString('base64url');
    const issuedAt = now();
    open.set(challengeId, { serviceId, binding, origin, issuedAt, expiresAt: issuedAt + L.challengeTtlMs });
    return Object.freeze({ ok: true, challengeId, expiresAt: new Date(issuedAt + L.challengeTtlMs).toISOString(), state: binding.state });
  }

  /** Synchronous on purpose (see header). Returns { ok:true, authorization } or { ok:false, code, policyCode? }. */
  function confirmChallenge({ serviceId, challengeId, gesture, origin, actor, status } = {}) {
    if (actor !== 'USER') return refuse(C.ACTOR_NOT_PERMITTED);
    if (typeof challengeId !== 'string' || !CHALLENGE_ID_RE.test(challengeId)) return refuse(C.CHALLENGE_INVALID);
    if (consumed.has(challengeId)) return refuse(C.CHALLENGE_REPLAYED);
    const c = open.get(challengeId);
    if (!c) return refuse(C.CHALLENGE_UNKNOWN);
    burn(challengeId); // single use: consumed BEFORE any other check and before Root Policy is asked
    if (now() >= c.expiresAt) return refuse(C.CHALLENGE_EXPIRED);
    if (c.serviceId !== serviceId || !allowed.has(serviceId)) return refuse(C.CHALLENGE_WRONG_SERVICE);
    if (c.origin !== origin) return refuse(C.CHALLENGE_ORIGIN_MISMATCH);
    if (!isPlain(gesture) || Object.keys(gesture).sort().join(',') !== 'kind,trusted' || !GESTURE_KINDS.includes(gesture.kind) || gesture.trusted !== true) return refuse(C.GESTURE_INVALID);
    const live = restartBinding(status, serviceId);
    if (!live) return refuse(C.INSTANCE_CHANGED);
    if (live.definitionDigest !== c.binding.definitionDigest) return refuse(C.DEFINITION_CHANGED);
    if (live.generation !== c.binding.generation || live.pid !== c.binding.pid || live.startedAt !== c.binding.startedAt) return refuse(C.INSTANCE_CHANGED);
    if (live.state !== c.binding.state) return refuse(C.STATE_CHANGED);
    // The ONLY Root Policy request with the certified flag: internal, after the consumed challenge, bound to the live digest.
    let d = null;
    try {
      d = policyDecide({
        action: RESTART_ACTION, module: RESTART_POLICY_MODULE, trustDomain: 'RUNTIME', actor: { kind: 'USER' }, userInitiated: true, certifiedBoundary: true,
        context: { serviceId, target: serviceId, payloadHash: live.definitionDigest },
      });
    } catch { d = null; }
    if (d?.decision !== 'ALLOW' || d?.code !== 'ALLOW_CERTIFIED_BOUNDARY' || d?.boundary !== RUNTIME_RESTART_BOUNDARY) {
      return refuse(d?.decision === 'REQUIRE_APPROVAL' ? C.POLICY_APPROVAL_REQUIRED : C.POLICY_DENIED, { policyCode: String(d?.code ?? 'UNKNOWN').slice(0, 60) });
    }
    const authorization = Object.freeze(new RuntimeRestartAuthorization());
    minted.set(authorization, { serviceId, action: RESTART_ACTION, definitionDigest: live.definitionDigest, generation: live.generation, expiresAt: now() + L.authorizationTtlMs, used: false });
    return Object.freeze({ ok: true, authorization, policyCode: d.code });
  }

  /** For the delegate only: true once for a genuine, unexpired authorization bound to exactly this live service. */
  function redeem(authorization, { serviceId, definitionDigest, generation } = {}) {
    const b = authorization && typeof authorization === 'object' ? minted.get(authorization) : undefined;
    if (!b || b.used) return false;
    b.used = true; // a mismatch burns it too
    return now() < b.expiresAt && b.serviceId === serviceId && b.action === RESTART_ACTION && b.definitionDigest === definitionDigest && b.generation === generation;
  }

  const stats = () => Object.freeze({ openChallenges: open.size, consumed: consumed.size });
  return Object.freeze({ boundaryStatus, issueChallenge, confirmChallenge, redeem, stats });
}
