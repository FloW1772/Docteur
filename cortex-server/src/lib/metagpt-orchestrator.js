import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveJobWorkspace, checkedWorkspacePath, filteredEnv, policyError,
  isAllowedMissionMode, MISSION_STATES, isValidTransition,
} from './metagpt-node-policy.js';
import * as db from './sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORTEX_ROOT = path.resolve(__dirname, '../..');
const DOCTEUR_ROOT = path.resolve(CORTEX_ROOT, '..');

// MG-6E — one workspace directory per mission, Docteur-generated job id
// only (never client-supplied), with the exact subdirectory structure the
// mission spec calls for.
export const WORKSPACES_ROOT = path.join(CORTEX_ROOT, 'data', 'metagpt-workspaces');
export const METAGPT_ROOT = path.join(DOCTEUR_ROOT, 'external', 'MetaGPT');
export const METAGPT_VENV = path.join(METAGPT_ROOT, '.venv');
export const METAGPT_HOME_SANDBOX = path.join(CORTEX_ROOT, 'data', 'metagpt-home-test');

const WORKSPACE_SUBDIRS = ['input', 'planning', 'generated', 'staging', 'logs', 'approval'];

// MG-6N — every mission must be able to reach these exact runner scripts.
// No raw exec()/shell()/customArgs()/rawPromptToPython() surface: each
// runner takes a small, fixed, positional argument list (workspace path,
// job id, and — for apply only — the exact approved diff hash), never an
// arbitrary string built from request input.
const RUNNER_PLAN = path.join(__dirname, 'metagpt_runner_plan.py');
const RUNNER_CODEGEN = path.join(__dirname, 'metagpt_runner_codegen.py');
const RUNNER_PREPARE_APPLY = path.join(__dirname, 'metagpt_runner_prepare_apply.py');
const RUNNER_APPLY = path.join(__dirname, 'metagpt_runner_apply.py');

const REGRESSION_RUNNER = path.join(CORTEX_ROOT, 'tests-python', 'run_metagpt_regression_sandboxed.py');

const DEFAULT_MODEL = 'qwen2.5:7b';
const TIMEOUTS_MS = Object.freeze({
  planning: 180_000,
  codegen: 240_000,
  prepareApply: 30_000,
  apply: 15_000,
});

function venvPythonPath() {
  return process.platform === 'win32'
    ? path.join(METAGPT_VENV, 'Scripts', 'python.exe')
    : path.join(METAGPT_VENV, 'bin', 'python');
}

function newJobId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------
// Runtime (in-memory, live) mission registry — mirrors the openmontage.js
// `jobs` Map convention: SQLite (via lib/sqlite.js) holds the durable
// record, this Map holds live process handles for cancellation.
// ---------------------------------------------------------------------
const runtime = new Map(); // missionId -> { child, stopReason, cancelled }

function logEvent(logger, missionId, fromState, toState, detail = {}) {
  db.insertMetaGptMissionEvent({ id: crypto.randomUUID(), mission_id: missionId, from_state: fromState, to_state: toState, detail });
  logger?.info?.({ mission_id: missionId, from_state: fromState, to_state: toState, ...detail }, 'METAGPT_MISSION_TRANSITION');
}

function transition(logger, missionId, fromState, toState, extraUpdates = {}) {
  if (!isValidTransition(fromState, toState)) {
    throw policyError(`invalid_transition:${fromState}->${toState}`);
  }
  db.updateMetaGptMission(missionId, { current_state: toState, ...extraUpdates });
  logEvent(logger, missionId, fromState, toState, extraUpdates.detail || {});
  return toState;
}

// ---------------------------------------------------------------------
// MG-6C — mission creation
// ---------------------------------------------------------------------

export function createMission({ title, requirement, target_scope, mode }, { logger } = {}) {
  if (typeof title !== 'string' || !title.trim()) throw policyError('title_required');
  if (typeof requirement !== 'string' || !requirement.trim()) throw policyError('requirement_required');
  if (!isAllowedMissionMode(mode)) throw policyError(`mode_denied:${mode}`);

  const id = newJobId();
  const workspaceDir = resolveJobWorkspace(WORKSPACES_ROOT, id);
  for (const sub of WORKSPACE_SUBDIRS) fs.mkdirSync(path.join(workspaceDir, sub), { recursive: true });

  const requirementPath = checkedWorkspacePath(workspaceDir, path.join('input', 'requirement.txt'));
  fs.writeFileSync(requirementPath, requirement, 'utf8');
  // Also drop a copy at the workspace root — metagpt_runner_plan.py and
  // metagpt_runner_codegen.py's WriteCode.input_args both expect
  // requirement.txt at the job root, consistent with the certified
  // MG-3/MG-4 scratchpad tests.
  fs.writeFileSync(checkedWorkspacePath(workspaceDir, 'requirement.txt'), requirement, 'utf8');

  db.insertMetaGptMission({ id, title: title.trim(), requirement, mode });
  db.updateMetaGptMission(id, { metadata: { target_scope: target_scope ?? null } });
  logEvent(logger, id, null, MISSION_STATES.CREATED, { mode });

  return { id, state: MISSION_STATES.CREATED };
}

export function getMission(id) {
  const mission = db.getMetaGptMissionById(id);
  if (!mission) return null;
  return { ...mission, events: db.getMetaGptMissionEvents(id) };
}

export function getMissionArtifacts(id) {
  const mission = getMission(id);
  if (!mission) return null;
  const workspace = resolveJobWorkspace(WORKSPACES_ROOT, id);
  const read = relative => {
    const filename = checkedWorkspacePath(workspace, relative);
    if (!fs.existsSync(filename)) return null;
    if (fs.statSync(filename).size > 1024 * 1024) throw policyError('artifact_too_large');
    return fs.readFileSync(filename, 'utf8');
  };
  return {
    planning: Object.fromEntries(['prd', 'design', 'tasks'].map(name => [name, read(`planning/${name}.json`)])),
    codegen: (mission.metadata.codegen?.files || []).map(file => ({ ...file, content: read(`generated/${file.path}`) })),
  };
}

export function listMissions() {
  return db.getAllMetaGptMissions();
}

// ---------------------------------------------------------------------
// MG-6N — permanent security gates, run BEFORE planning ever starts.
// Reuses the already-certified regression suite (MG-2G/MG-2H tests) via
// the same sandboxed launcher used throughout MG-3/MG-4/MG-5. If this
// fails, the mission is BLOCKED_BY_POLICY and nothing else runs.
// ---------------------------------------------------------------------

function runRegressionGuardSync() {
  const result = spawnSync(venvPythonPath(), [REGRESSION_RUNNER], {
    cwd: METAGPT_ROOT,
    env: filteredEnv(process.env, {
      HOME: METAGPT_HOME_SANDBOX,
      USERPROFILE: METAGPT_HOME_SANDBOX,
      TEMP: path.join(METAGPT_HOME_SANDBOX, 'tmp'),
      TMP: path.join(METAGPT_HOME_SANDBOX, 'tmp'),
    }),
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return result.status === 0;
}

// ---------------------------------------------------------------------
// Runner invocation — spawn only, never shell:true, args always an array.
// ---------------------------------------------------------------------

export function runPythonScript(scriptPath, args, { cwd, timeout, envExtra = {}, missionId = null }) {
  return new Promise((resolve) => {
    const env = filteredEnv(process.env, {
      HOME: METAGPT_HOME_SANDBOX,
      USERPROFILE: METAGPT_HOME_SANDBOX,
      TEMP: path.join(METAGPT_HOME_SANDBOX, 'tmp'),
      TMP: path.join(METAGPT_HOME_SANDBOX, 'tmp'),
      METAGPT_HOME_SANDBOX,
      METAGPT_MODEL: DEFAULT_MODEL,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...envExtra,
    });
    fs.mkdirSync(env.TEMP, { recursive: true });

    let out = '', err = '', settled = false, child, timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        } else child.kill('SIGKILL');
      } catch {}
    }, timeout);

    try {
      child = spawn(venvPythonPath(), [scriptPath, ...args], { cwd: cwd || METAGPT_ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, stdout: '', stderr: String(e), result: null });
      return;
    }

    // Registered immediately (not after close) so cancelMission() can find
    // and kill this exact child while it is still running.
    if (missionId) runtime.set(missionId, { child, cancelled: false });

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.once('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, stdout: out, stderr: String(e), result: null, pid: child.pid });
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Contract (see runner docstrings): parse only the LAST non-empty
      // stdout line — MetaGPT's own retry/repair machinery may print
      // diagnostic [CONTENT]...[/CONTENT] noise before the real result.
      let result = null;
      const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length > 0) {
        try { result = JSON.parse(lines[lines.length - 1]); } catch { result = null; }
      }
      if (missionId && runtime.get(missionId)?.child === child) runtime.delete(missionId);
      resolve({ ok: !timedOut && code === 0 && result?.ok === true, timedOut, stdout: out, stderr: err, result, exitCode: code, pid: child.pid });
    });
  });
}

// ---------------------------------------------------------------------
// MG-6F/6G/6H/6J — pipeline steps. Each step: preflight guard check,
// explicit state transition, spawn the certified runner, persist result,
// transition again (or FAILED/BLOCKED_BY_POLICY on error).
// ---------------------------------------------------------------------

export async function runPlanning(missionId, { logger } = {}) {
  const mission = db.getMetaGptMissionById(missionId);
  if (!mission) throw policyError('mission_not_found');
  if (mission.current_state !== MISSION_STATES.CREATED) throw policyError(`invalid_state_for_planning:${mission.current_state}`);

  if (!runRegressionGuardSync()) {
    transition(logger, missionId, mission.current_state, MISSION_STATES.BLOCKED_BY_POLICY, { error_message: 'regression_guard_failed', detail: { reason: 'MG-2G/MG-2H regression suite failed preflight' } });
    return { ok: false, state: MISSION_STATES.BLOCKED_BY_POLICY };
  }

  const workspaceDir = resolveJobWorkspace(WORKSPACES_ROOT, missionId);
  const requirementPath = checkedWorkspacePath(workspaceDir, 'requirement.txt');

  transition(logger, missionId, mission.current_state, MISSION_STATES.PLANNING);

  const { ok, result, stderr, timedOut } = await runPythonScript(RUNNER_PLAN, [workspaceDir, requirementPath], { timeout: TIMEOUTS_MS.planning, missionId });

  if (db.getMetaGptMissionById(missionId)?.cancelled) {
    return { ok: false, state: MISSION_STATES.CANCELLED };
  }

  if (!ok) {
    const errorMessage = timedOut ? 'planning_timeout' : (result?.error || stderr?.slice(0, 2000) || 'planning_failed');
    transition(logger, missionId, MISSION_STATES.PLANNING, MISSION_STATES.FAILED, { error_message: errorMessage });
    return { ok: false, state: MISSION_STATES.FAILED, error: errorMessage };
  }

  db.updateMetaGptMission(missionId, { model_used: result.model, metadata: { ...mission.metadata, planning: result } });
  let state = transition(logger, missionId, MISSION_STATES.PLANNING, MISSION_STATES.PRD_READY);
  state = transition(logger, missionId, state, MISSION_STATES.DESIGN_READY);
  state = transition(logger, missionId, state, MISSION_STATES.TASKS_READY);

  return { ok: true, state, planning: result };
}

export async function runCodegen(missionId, { files, logger } = {}) {
  const mission = db.getMetaGptMissionById(missionId);
  if (!mission) throw policyError('mission_not_found');
  if (mission.current_state !== MISSION_STATES.TASKS_READY) throw policyError(`invalid_state_for_codegen:${mission.current_state}`);
  if (mission.mode !== 'PLAN_AND_CODE_TEXT_ONLY') throw policyError('mode_does_not_allow_codegen');
  if (!Array.isArray(files) || files.length === 0 || files.length > 10) throw policyError('files_invalid');

  const workspaceDir = resolveJobWorkspace(WORKSPACES_ROOT, missionId);
  const specPath = checkedWorkspacePath(workspaceDir, 'generation_spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ files }), 'utf8');

  transition(logger, missionId, mission.current_state, MISSION_STATES.GENERATING);

  const { ok, result, stderr, timedOut } = await runPythonScript(RUNNER_CODEGEN, [workspaceDir], { timeout: TIMEOUTS_MS.codegen, missionId });

  if (db.getMetaGptMissionById(missionId)?.cancelled) {
    return { ok: false, state: MISSION_STATES.CANCELLED };
  }

  if (!ok) {
    const errorMessage = timedOut ? 'codegen_timeout' : (result?.error || stderr?.slice(0, 2000) || 'codegen_failed');
    const toState = result?.error_code === 'GIT_GUARD_VIOLATION' ? MISSION_STATES.BLOCKED_BY_POLICY : MISSION_STATES.FAILED;
    transition(logger, missionId, MISSION_STATES.GENERATING, toState, { error_message: errorMessage, detail: { guard_counters: result?.guard_counters } });
    return { ok: false, state: toState, error: errorMessage };
  }

  db.updateMetaGptMission(missionId, { metadata: { ...mission.metadata, codegen: result } });
  const state = transition(logger, missionId, MISSION_STATES.GENERATING, MISSION_STATES.CODE_READY, { detail: { guard_counters: result.guard_counters } });

  return { ok: true, state, codegen: result };
}

export async function runPrepareApply(missionId, { logger } = {}) {
  const mission = db.getMetaGptMissionById(missionId);
  if (!mission) throw policyError('mission_not_found');
  if (mission.current_state !== MISSION_STATES.CODE_READY) throw policyError(`invalid_state_for_prepare_apply:${mission.current_state}`);

  const workspaceDir = resolveJobWorkspace(WORKSPACES_ROOT, missionId);
  transition(logger, missionId, mission.current_state, MISSION_STATES.PREPARING_DIFF);

  const { ok, result, stderr, timedOut } = await runPythonScript(RUNNER_PREPARE_APPLY, [workspaceDir, missionId], { timeout: TIMEOUTS_MS.prepareApply, missionId });

  if (db.getMetaGptMissionById(missionId)?.cancelled) return { ok: false, state: MISSION_STATES.CANCELLED };

  if (!ok) {
    const errorMessage = timedOut ? 'prepare_apply_timeout' : (result?.error || stderr?.slice(0, 2000) || 'prepare_apply_failed');
    if (result) db.updateMetaGptMission(missionId, { metadata: { ...mission.metadata, prepare_apply: result } });
    const toState = result?.error_code === 'BLOCKED_BY_POLICY' ? MISSION_STATES.BLOCKED_BY_POLICY : MISSION_STATES.FAILED;
    transition(logger, missionId, MISSION_STATES.PREPARING_DIFF, toState, { error_message: errorMessage });
    return { ok: false, state: toState, error: errorMessage };
  }

  db.updateMetaGptMission(missionId, { diff_sha256: result.diff_sha256, metadata: { ...mission.metadata, prepare_apply: result } });
  const state = transition(logger, missionId, MISSION_STATES.PREPARING_DIFF, MISSION_STATES.AWAITING_APPROVAL);

  return { ok: true, state, prepareApply: result };
}

// ---------------------------------------------------------------------
// MG-6I — human approval binding. Approval is bound to the EXACT triplet
// (mission id + diff_sha256 + file list) that PREPARE_APPLY produced —
// never a bare `approved: true` flag.
// ---------------------------------------------------------------------

export function approveMission(missionId, { diff_sha256, files, logger } = {}) {
  const mission = db.getMetaGptMissionById(missionId);
  if (!mission) throw policyError('mission_not_found');
  if (mission.current_state !== MISSION_STATES.AWAITING_APPROVAL) throw policyError(`invalid_state_for_approval:${mission.current_state}`);
  if (typeof diff_sha256 !== 'string' || diff_sha256 !== mission.diff_sha256) {
    db.updateMetaGptMission(missionId, { approved: false });
    throw policyError('diff_sha256_mismatch');
  }

  const approvalPackage = mission.metadata?.prepare_apply;
  if (!approvalPackage?.ok || !approvalPackage.package_sha256 || !approvalPackage.files?.length || approvalPackage.blocked_findings || approvalPackage.security_findings?.some(f => f.classification === 'BLOCKED')) throw policyError('approval_package_denied');
  const expectedFiles = (approvalPackage?.files || []).map(f => f.destination).sort();
  const providedFiles = Array.isArray(files) ? [...files].sort() : [];
  if (JSON.stringify(expectedFiles) !== JSON.stringify(providedFiles)) {
    db.updateMetaGptMission(missionId, { approved: false });
    throw policyError('file_list_mismatch');
  }

  db.updateMetaGptMission(missionId, {
    approved: true,
    metadata: { ...mission.metadata, approval: { diff_sha256, files: providedFiles, approved_at: nowIso() } },
  });
  logEvent(logger, missionId, mission.current_state, mission.current_state, { detail: { event: 'approved', diff_sha256 } });

  return { ok: true, approved: true };
}

export async function runApply(missionId, { logger } = {}) {
  const mission = db.getMetaGptMissionById(missionId);
  if (!mission) throw policyError('mission_not_found');
  if (mission.current_state !== MISSION_STATES.AWAITING_APPROVAL) throw policyError(`invalid_state_for_apply:${mission.current_state}`);
  if (!mission.approved || !mission.diff_sha256) {
    transition(logger, missionId, mission.current_state, MISSION_STATES.APPROVAL_INVALIDATED, { error_message: 'not_approved' });
    return { ok: false, state: MISSION_STATES.APPROVAL_INVALIDATED };
  }

  const workspaceDir = resolveJobWorkspace(WORKSPACES_ROOT, missionId);
  transition(logger, missionId, mission.current_state, MISSION_STATES.APPLYING);

  const { ok, result, stderr, timedOut } = await runPythonScript(RUNNER_APPLY, [workspaceDir, missionId, mission.diff_sha256, mission.metadata.prepare_apply.package_sha256], { timeout: TIMEOUTS_MS.apply, missionId });

  if (!ok) {
    const errorMessage = timedOut ? 'apply_timeout' : (result?.error || stderr?.slice(0, 2000) || 'apply_failed');
    const toState = result?.error_code === 'APPROVAL_INVALIDATED' ? MISSION_STATES.APPROVAL_INVALIDATED : MISSION_STATES.FAILED;
    transition(logger, missionId, MISSION_STATES.APPLYING, toState, { error_message: errorMessage, detail: { rollback: result?.rollback_triggered ?? false } });
    return { ok: false, state: toState, error: errorMessage };
  }

  db.updateMetaGptMission(missionId, { finished_at: nowIso(), metadata: { ...mission.metadata, apply: result } });
  const state = transition(logger, missionId, MISSION_STATES.APPLYING, MISSION_STATES.APPLIED);

  return { ok: true, state, apply: result };
}

// ---------------------------------------------------------------------
// MG-6M — cancellation
// ---------------------------------------------------------------------

export function cancelMission(missionId, { logger } = {}) {
  const mission = db.getMetaGptMissionById(missionId);
  if (!mission) throw policyError('mission_not_found');

  const TERMINAL = new Set([MISSION_STATES.APPLIED, MISSION_STATES.FAILED, MISSION_STATES.CANCELLED, MISSION_STATES.BLOCKED_BY_POLICY, MISSION_STATES.APPROVAL_INVALIDATED]);
  if (TERMINAL.has(mission.current_state)) return { ok: true, alreadyFinished: true };
  // The short atomic publication phase must finish; killing it could race
  // the filesystem commit. Cancellation remains available before apply.
  if (mission.current_state === MISSION_STATES.APPLYING) throw policyError('invalid_state_for_cancel:APPLYING');

  const entry = runtime.get(missionId);
  if (entry?.child) {
    entry.cancelled = true;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      } else entry.child.kill('SIGTERM');
    } catch {}
  }

  transition(logger, missionId, mission.current_state, MISSION_STATES.CANCELLED, { cancelled: true });
  return { ok: true };
}
