/**
 * MAÎTRE — policy engine (MA-7). Decides ALLOW / CONFIRM / DENY for a
 * validated action proposal. No system access — this file only reads
 * already-persisted incident data and evaluates fixed rules. LEVEL 2/3
 * actions are NEVER auto-executed: CONFIRM always means "an explicit
 * human approval is required before this can proceed," never "proceed
 * now."
 */
import { getIncident } from './maitre-store.js';

export const POLICY_DECISIONS = Object.freeze(['ALLOW', 'CONFIRM', 'DENY']);

function decision(value, reason, { requirements = [], riskLevel = 'low' } = {}) {
  return { decision: value, reason, requirements, riskLevel };
}

/**
 * Evaluates policy for an already-validated action (see
 * maitre-actions.js's validateActionInput — this function assumes its
 * input has already passed that schema/target validation; policy
 * decides WHETHER, not WHETHER-WELL-FORMED).
 *
 * @param {object} action - { incidentId, actionType, level, target, parameters }
 */
export function evaluateActionPolicy(action) {
  if (!action || typeof action !== 'object') {
    return decision('DENY', 'action_missing');
  }

  const incident = getIncident(action.incidentId);
  if (!incident) {
    return decision('DENY', 'incident_not_found');
  }

  // Level/action-type combination sanity — a defense-in-depth check
  // even though maitre-actions.js's ACTION_LEVELS already fixes this;
  // policy must never trust a caller-supplied level that disagrees
  // with the canonical mapping.
  const EXPECTED_LEVEL = {
    SCAN_WITH_DEFENDER: 1, COLLECT_EVIDENCE: 1,
    TERMINATE_PROCESS: 2, QUARANTINE_WITH_DEFENDER: 2, BLOCK_REMOTE_IP: 2, DISABLE_PERSISTENCE_ENTRY: 2,
    HOST_ISOLATION: 3, RESTORE_HOST_NETWORK: 3,
  };
  if (EXPECTED_LEVEL[action.actionType] === undefined) {
    return decision('DENY', 'unknown_action_type', { riskLevel: 'high' });
  }
  if (action.level !== EXPECTED_LEVEL[action.actionType]) {
    return decision('DENY', 'invalid_level_action_combination', { riskLevel: 'high' });
  }

  // LEVEL 1 — ALLOW or CONFIRM depending on the specific action.
  // COLLECT_EVIDENCE is passive/non-destructive: ALLOW. A Defender scan
  // consumes system resources and can take a while, so it gets a light
  // CONFIRM rather than a silent ALLOW, even at LEVEL 1.
  if (action.level === 1) {
    if (action.actionType === 'COLLECT_EVIDENCE') {
      return decision('ALLOW', 'level1_passive_action');
    }
    if (action.actionType === 'SCAN_WITH_DEFENDER') {
      return decision('CONFIRM', 'level1_resource_intensive_action', { requirements: ['user_confirmation'], riskLevel: 'low' });
    }
  }

  // LEVEL 2 — CONFIRM always required (mission §9), plus action-
  // specific DENY conditions.
  if (action.level === 2) {
    if (action.actionType === 'TERMINATE_PROCESS') {
      // maitre-actions.js's validator already denies SYSTEM_CRITICAL/
      // DOCTEUR_CRITICAL targets before a proposal can even be built,
      // but policy re-checks structurally in case this function is
      // ever called with a hand-built action bypassing that path.
      return decision('CONFIRM', 'level2_process_termination', { requirements: ['user_confirmation'], riskLevel: 'medium' });
    }
    if (action.actionType === 'BLOCK_REMOTE_IP') {
      return decision('CONFIRM', 'level2_firewall_change', { requirements: ['user_confirmation'], riskLevel: 'medium' });
    }
    if (action.actionType === 'QUARANTINE_WITH_DEFENDER') {
      return decision('CONFIRM', 'level2_quarantine', { requirements: ['user_confirmation'], riskLevel: 'medium' });
    }
    if (action.actionType === 'DISABLE_PERSISTENCE_ENTRY') {
      return decision('CONFIRM', 'level2_persistence_change', { requirements: ['user_confirmation'], riskLevel: 'medium' });
    }
    return decision('CONFIRM', 'level2_default', { requirements: ['user_confirmation'], riskLevel: 'medium' });
  }

  // LEVEL 3 — CONFIRM renforcé obligatoire (strengthened confirmation).
  if (action.level === 3) {
    if (action.actionType === 'HOST_ISOLATION') {
      if (!action.target?.rollbackPlanAvailable) {
        return decision('DENY', 'host_isolation_missing_rollback_plan', { riskLevel: 'high' });
      }
      if (!action.target?.previewMetadata) {
        return decision('DENY', 'host_isolation_missing_preview', { riskLevel: 'high' });
      }
      if (!action.target?.reason) {
        return decision('DENY', 'host_isolation_missing_reason', { riskLevel: 'high' });
      }
      return decision('CONFIRM', 'level3_host_isolation', { requirements: ['user_confirmation', 'strengthened_confirmation'], riskLevel: 'high' });
    }
    if (action.actionType === 'RESTORE_HOST_NETWORK') {
      return decision('CONFIRM', 'level3_restore_network', { requirements: ['user_confirmation'], riskLevel: 'medium' });
    }
    return decision('CONFIRM', 'level3_default', { requirements: ['user_confirmation', 'strengthened_confirmation'], riskLevel: 'high' });
  }

  // Should be unreachable given the EXPECTED_LEVEL check above — fail
  // closed rather than silently ALLOW an unrecognized level.
  return decision('DENY', 'unrecognized_level', { riskLevel: 'high' });
}
