/**
 * Kiwix process-policy adapter.
 *
 * Migration is deliberately exact:
 *   - a VALID signed V1 keeps the historical Kiwix lifecycle temporarily;
 *   - a VALID V2 must return ALLOW for the exact typed process request;
 *   - invalid, unavailable, or unknown policy versions never fall back.
 *
 * PROCESS_STOP is still evaluated for V2/invalid/future states because the
 * Root Policy's hard-coded stop-always invariant precedes policy validity and
 * module grants. This keeps owned-process safety cleanup available.
 */
import { DECISION, decide, getPolicyView } from './root-policy/index.js';

export const KIWIX_POLICY_MODULE = 'kiwix';

const denied = (code, policyVersion = 0) => Object.freeze({ decision: DECISION.DENY, code, policyVersion });

export function createKiwixProcessPolicyGate({ getPolicyViewFn = getPolicyView, decideFn = decide } = {}) {
  return Object.freeze({
    evaluate({ action, plan = null, actor, userInitiated = false }) {
      let view;
      try { view = getPolicyViewFn(); } catch { return denied('DENY_POLICY_INVALID'); }
      // getPolicyView is intentionally passive; force the same lazy verified
      // boot used by every normal decision before classifying V1 migration.
      if (view?.status?.state === 'UNINITIALIZED') {
        try { decideFn({ action: 'POLICY_READ', module: 'policy', trustDomain: 'POLICY', actor: { kind: 'MODULE' } }); } catch { /* classified below */ }
        try { view = getPolicyViewFn(); } catch { return denied('DENY_POLICY_INVALID'); }
      }
      const valid = view?.status?.state === 'VALID' && view?.policy;
      const version = valid && Number.isInteger(view.status.version) ? view.status.version : 0;

      if (action === 'PROCESS_START') {
        if (!valid) return denied('DENY_POLICY_INVALID');
        if (version === 1) return Object.freeze({ decision: DECISION.ALLOW, code: 'ALLOW_V1_KIWIX_MIGRATION', policyVersion: 1 });
        if (version !== 2) return denied('DENY_UNSUPPORTED_POLICY_VERSION', version);
        if (!plan || typeof plan !== 'object') return denied('DENY_ARBITRARY_EXECUTION', version);
        try {
          return decideFn({
            action: 'PROCESS_START', module: KIWIX_POLICY_MODULE, trustDomain: 'PROCESS', actor: { kind: actor }, userInitiated,
            context: {
              executorId: plan.executorId,
              executable: plan.executable,
              args: plan.args,
              cwd: plan.cwd,
              argsTyped: plan.argsTyped,
              freeFormCommand: plan.freeFormCommand,
              viaShell: plan.viaShell,
            },
          });
        } catch { return denied('DENY_POLICY_INVALID', version); }
      }

      if (action === 'PROCESS_STOP') {
        if (valid && version === 1) return Object.freeze({ decision: DECISION.ALLOW, code: 'ALLOW_V1_KIWIX_MIGRATION', policyVersion: 1 });
        try {
          return decideFn({ action: 'PROCESS_STOP', module: KIWIX_POLICY_MODULE, trustDomain: 'PROCESS', actor: { kind: actor }, userInitiated, context: { serviceId: 'kiwix-serve', ownership: 'OWNED_CHILD' } });
        } catch { return denied('DENY_POLICY_INVALID', version); }
      }
      return denied('DENY_UNKNOWN_ACTION', version);
    },
  });
}

export const productKiwixProcessPolicyGate = createKiwixProcessPolicyGate();
