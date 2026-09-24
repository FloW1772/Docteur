/**
 * RASSILON V1 Phase 2 — settings validation and conservative defaults.
 *
 * Default values (mission §6 — documented, not blindly copied from the
 * mission's own conceptual example, chosen as min(example, reasonable
 * fraction of a typical machine) since Phase 2 has no per-machine
 * calibration step yet):
 *
 *   maxCpuPercent:        25   — mission's own conceptual ceiling; a
 *                                fraction low enough to stay unnoticeable
 *                                on any machine this runs on, including
 *                                modest dual/quad-core laptops.
 *   maxRamMb:              2048 — mission's own conceptual ceiling; small
 *                                relative to a typical 8-16GB+ machine,
 *                                deliberately not computed as a fraction
 *                                of THIS machine's RAM (which
 *                                local-hardware-profile.js could report)
 *                                because RASSILON's budget must stay
 *                                small and predictable across very
 *                                different machines, not scale up simply
 *                                because a machine has more RAM.
 *   maxConcurrentJobs:      1   — mission §29 default, avoids any
 *                                fairness/starvation design question in
 *                                V1.
 *   maxJobDurationSec:      300 — 5 minutes; long enough for the bounded
 *                                SAFE_CPU_TASK payloads Phase 2 ships
 *                                (mission §21 sizes), short enough that a
 *                                stuck/misbehaving job self-terminates
 *                                quickly.
 *   maxScratchMb:           1024 — mission's own conceptual ceiling;
 *                                Phase 2's only executor writes no scratch
 *                                files at all, so this is a forward-
 *                                looking ceiling for Phase 3+, not
 *                                exercised by any Phase 2 job.
 *   pauseOnBattery:         true — mission §11's explicit recommendation
 *                                ("pauseOnBattery = true si batterie
 *                                existe").
 *   minimumBatteryPercent:  30  — conservative floor; pausing well before
 *                                a laptop reaches a critical low-battery
 *                                warning threshold (typically 10-20% on
 *                                Windows), leaving headroom.
 *   pauseWhenUserActive:    true — mission §27's "priorité utilisateur
 *                                absolue" invariant, defaulted on rather
 *                                than opt-in.
 *   approvalMode:      'ASK_EACH_JOB' — Phase 1 architecture report §33's
 *                                explicit conservative-default
 *                                recommendation.
 */

import { JOB_TYPES } from './rassilon-job-schema.js';

export class RassilonSettingsError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'RassilonSettingsError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) {
  throw new RassilonSettingsError(code, detail);
}

// Hard platform ceilings — no setting may exceed these regardless of what
// a caller requests, keeping "conservative defaults" meaningful even if
// a future UI lets a user raise the numbers (mission §6 — "Ne pas
// reprendre aveuglément ces nombres" cuts both ways: don't let a
// misconfigured settings write silently create an unbounded worker
// either).
const LIMITS = Object.freeze({
  maxCpuPercent: { min: 1, max: 90 },
  maxRamMb: { min: 64, max: 16_384 },
  maxConcurrentJobs: { min: 1, max: 4 },
  maxJobDurationSec: { min: 1, max: 3_600 },
  maxScratchMb: { min: 16, max: 16_384 },
  minimumBatteryPercent: { min: 0, max: 100 },
});

export const APPROVAL_MODES = Object.freeze(['ASK_EACH_JOB', 'AUTO_ACCEPT_ALLOWED_TYPES']);

function assertIntInRange(value, { min, max }, field) {
  if (!Number.isInteger(value) || value < min || value > max) fail('setting_out_of_range', { field, value, min, max });
  return value;
}

/**
 * Validates a partial settings update payload (only fields present are
 * checked/returned — this is a PATCH shape, matching
 * updateRassilonSettings()'s mutable-field allowlist in sqlite.js).
 * Throws RassilonSettingsError on any invalid field. Never accepts or
 * touches `enabled` — that field is exclusively controlled via the
 * enable/disable transition, not a generic settings write (mission §3/
 * §31, mirrored by sqlite.js's RASSILON_SETTINGS_MUTABLE_FIELDS).
 */
export function validateSettingsPatch(input) {
  if (!input || typeof input !== 'object') fail('settings_payload_required');
  if ('enabled' in input) fail('enabled_not_settable_via_patch');

  const patch = {};

  if ('maxCpuPercent' in input) patch.max_cpu_percent = assertIntInRange(input.maxCpuPercent, LIMITS.maxCpuPercent, 'maxCpuPercent');
  if ('maxRamMb' in input) patch.max_ram_mb = assertIntInRange(input.maxRamMb, LIMITS.maxRamMb, 'maxRamMb');
  if ('maxConcurrentJobs' in input) patch.max_concurrent_jobs = assertIntInRange(input.maxConcurrentJobs, LIMITS.maxConcurrentJobs, 'maxConcurrentJobs');
  if ('maxJobDurationSec' in input) patch.max_job_duration_sec = assertIntInRange(input.maxJobDurationSec, LIMITS.maxJobDurationSec, 'maxJobDurationSec');
  if ('maxScratchMb' in input) patch.max_scratch_mb = assertIntInRange(input.maxScratchMb, LIMITS.maxScratchMb, 'maxScratchMb');
  if ('minimumBatteryPercent' in input) patch.minimum_battery_percent = assertIntInRange(input.minimumBatteryPercent, LIMITS.minimumBatteryPercent, 'minimumBatteryPercent');

  if ('pauseOnBattery' in input) {
    if (typeof input.pauseOnBattery !== 'boolean') fail('setting_type_invalid', { field: 'pauseOnBattery' });
    patch.pause_on_battery = input.pauseOnBattery ? 1 : 0;
  }
  if ('pauseWhenUserActive' in input) {
    if (typeof input.pauseWhenUserActive !== 'boolean') fail('setting_type_invalid', { field: 'pauseWhenUserActive' });
    patch.pause_when_user_active = input.pauseWhenUserActive ? 1 : 0;
  }
  if ('acceptedJobTypes' in input) {
    if (!Array.isArray(input.acceptedJobTypes) || !input.acceptedJobTypes.every(t => typeof t === 'string')) {
      fail('setting_type_invalid', { field: 'acceptedJobTypes' });
    }
    if (input.acceptedJobTypes.some(type => !JOB_TYPES.includes(type))) {
      fail('accepted_job_type_invalid', { acceptedJobTypes: input.acceptedJobTypes });
    }
    patch.accepted_job_types = JSON.stringify([...new Set(input.acceptedJobTypes)]);
  }
  if ('approvalMode' in input) {
    if (!APPROVAL_MODES.includes(input.approvalMode)) fail('approval_mode_invalid', { approvalMode: input.approvalMode });
    patch.approval_mode = input.approvalMode;
  }

  if (Object.keys(patch).length === 0) fail('settings_payload_empty');
  return patch;
}
