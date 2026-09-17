import fs from 'node:fs';
import path from 'node:path';

// Node-side filesystem/env sandboxing for the MetaGPT orchestrator (MG-6),
// mirroring openmontage-policy.js's shape exactly: same containment check,
// same forbidden-substring list, same env allowlist philosophy. This module
// governs the Node process's OWN file operations and the env it hands to
// the spawned MetaGPT Python child — it does not replace, and must never
// weaken, the Python-side guards already certified in MG-2G/MG-2H/MG-4/MG-5
// (cortex-server/src/lib/metagpt_policy.py, metagpt_git_guard.py,
// metagpt_codegen_policy.py, metagpt_apply_policy.py).

export function policyError(code) { return Object.assign(new Error(code), { code }); }

export function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

const UNC_PATTERN = /^\\\\|^\/\/[^/]/;

const FORBIDDEN_SUBSTRINGS = [
  'cortex.sqlite',
  `${path.sep}.env`,
  '.env.',
  `${path.sep}secret-store${path.sep}`,
  'secret-store.js',
  `${path.sep}certs${path.sep}`,
  `${path.sep}.claude${path.sep}`,
  `${path.sep}.ssh${path.sep}`,
  `${path.sep}.aws${path.sep}`,
  `${path.sep}.git${path.sep}`,
  `${path.sep}external${path.sep}`,
  `${path.sep}node_modules${path.sep}`,
];

function assertNotForbidden(resolved) {
  const lower = resolved.toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(needle.toLowerCase())) throw policyError('path_denied');
  }
}

// Job IDs are always Docteur-generated (crypto.randomUUID()) — never
// accepted free-form from the client (MG-6E: "Pas de job-id libre fourni
// par utilisateur"). This validator is defense-in-depth, not the source of
// trust.
export function resolveJobWorkspace(workspacesRoot, jobId) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) throw policyError('job_id_invalid');
  if (UNC_PATTERN.test(jobId)) throw policyError('path_denied');
  const root = path.resolve(workspacesRoot);
  const target = path.resolve(root, jobId);
  if (!within(root, target)) throw policyError('path_denied');
  assertNotForbidden(target);
  return target;
}

export function checkedWorkspacePath(jobWorkspace, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) throw policyError('path_denied');
  if (UNC_PATTERN.test(candidate)) throw policyError('path_denied');
  const target = path.resolve(jobWorkspace, candidate);
  if (!within(jobWorkspace, target)) throw policyError('path_denied');
  assertNotForbidden(target);
  let current = jobWorkspace;
  const rel = path.relative(jobWorkspace, target);
  if (rel === '') return target;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) throw policyError('symlink_denied');
  }
  return target;
}

// Minimal environment for the spawned MetaGPT Python process. Deliberately
// excludes every Docteur provider/API key and secret-store material — the
// MetaGPT child must never receive Groq/OpenRouter/OpenAI/Anthropic/Google/
// GitHub credentials, only the bare OS plumbing plus a redirected
// HOME/USERPROFILE pointed at the sandboxed .metagpt config dir (see
// METAGPT_HOME_SANDBOX below), consistent with MG-2E/MG-3/MG-4/MG-5.
const ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PYTHONUTF8', 'PYTHONIOENCODING',
]);

export function filteredEnv(source = process.env, extra = {}) {
  const base = Object.fromEntries(Object.entries(source).filter(([key]) => ENV_ALLOWLIST.has(key.toUpperCase())));
  for (const [key, value] of Object.entries(extra)) {
    if (/token|secret|key|password|credential/i.test(key)) throw policyError('env_key_denied');
    base[key] = value;
  }
  return base;
}

// V1 allowed mission modes only (MG-6C). Anything else is DENIED, never
// silently coerced to a default.
export const ALLOWED_MISSION_MODES = Object.freeze(new Set(['PLAN_ONLY', 'PLAN_AND_CODE_TEXT_ONLY']));

export function isAllowedMissionMode(mode) {
  return typeof mode === 'string' && ALLOWED_MISSION_MODES.has(mode);
}

// MG-6D — explicit state machine. No arbitrary jump is permitted; every
// transition must be listed here. Terminal/error states never transition
// onward.
export const MISSION_STATES = Object.freeze({
  CREATED: 'CREATED',
  PLANNING: 'PLANNING',
  PRD_READY: 'PRD_READY',
  DESIGN_READY: 'DESIGN_READY',
  TASKS_READY: 'TASKS_READY',
  GENERATING: 'GENERATING',
  CODE_READY: 'CODE_READY',
  PREPARING_DIFF: 'PREPARING_DIFF',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPLYING: 'APPLYING',
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY',
  APPROVAL_INVALIDATED: 'APPROVAL_INVALIDATED',
});

const TERMINAL_STATES = new Set([
  MISSION_STATES.APPLIED,
  MISSION_STATES.FAILED,
  MISSION_STATES.CANCELLED,
  MISSION_STATES.BLOCKED_BY_POLICY,
  MISSION_STATES.APPROVAL_INVALIDATED,
]);

// Forward edges of the pipeline. Any state may additionally transition to
// FAILED, CANCELLED, or BLOCKED_BY_POLICY (error escape hatches), checked
// separately below — those are not listed per-row to avoid repeating them
// 11 times.
const FORWARD_EDGES = {
  [MISSION_STATES.CREATED]: [MISSION_STATES.PLANNING],
  [MISSION_STATES.PLANNING]: [MISSION_STATES.PRD_READY],
  [MISSION_STATES.PRD_READY]: [MISSION_STATES.DESIGN_READY],
  [MISSION_STATES.DESIGN_READY]: [MISSION_STATES.TASKS_READY],
  [MISSION_STATES.TASKS_READY]: [MISSION_STATES.GENERATING],
  [MISSION_STATES.GENERATING]: [MISSION_STATES.CODE_READY],
  [MISSION_STATES.CODE_READY]: [MISSION_STATES.PREPARING_DIFF],
  [MISSION_STATES.PREPARING_DIFF]: [MISSION_STATES.AWAITING_APPROVAL],
  [MISSION_STATES.AWAITING_APPROVAL]: [MISSION_STATES.APPLYING],
  [MISSION_STATES.APPLYING]: [MISSION_STATES.APPLIED],
};

const ERROR_ESCAPE_STATES = new Set([
  MISSION_STATES.FAILED,
  MISSION_STATES.CANCELLED,
  MISSION_STATES.BLOCKED_BY_POLICY,
  MISSION_STATES.APPROVAL_INVALIDATED,
]);

export function isValidTransition(fromState, toState) {
  if (!Object.values(MISSION_STATES).includes(fromState)) return false;
  if (!Object.values(MISSION_STATES).includes(toState)) return false;
  if (TERMINAL_STATES.has(fromState)) return false; // no transition out of a terminal state
  if (ERROR_ESCAPE_STATES.has(toState)) return true; // any non-terminal state may escape to an error state
  const allowedForward = FORWARD_EDGES[fromState] || [];
  return allowedForward.includes(toState);
}
