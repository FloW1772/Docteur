import fs from 'node:fs';
import path from 'node:path';

export function policyError(code) { return Object.assign(new Error(code), { code }); }

// Strict containment check: candidate must resolve inside root, no traversal,
// no absolute escape, no UNC. Mirrors external-agent-policy.js::within.
export function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

const UNC_PATTERN = /^\\\\|^\/\/[^/]/;

// Absolute paths that must never be reachable through this adapter, checked
// against the resolved real path so a symlink cannot alias around them.
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
];

function assertNotForbidden(resolved) {
  const lower = resolved.toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(needle.toLowerCase())) throw policyError('path_denied');
  }
}

// Validates a job workspace path strictly under the OpenMontage workspaces
// root. Rejects traversal, absolute escapes, UNC paths, and known-sensitive
// substrings (DB, .env, secret-store, certs, credential dirs).
export function resolveJobWorkspace(workspacesRoot, jobId) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) throw policyError('job_id_invalid');
  if (UNC_PATTERN.test(jobId)) throw policyError('path_denied');
  const root = path.resolve(workspacesRoot);
  const target = path.resolve(root, jobId);
  if (!within(root, target)) throw policyError('path_denied');
  assertNotForbidden(target);
  return target;
}

// Validates an arbitrary path argument (e.g. output path passed to a render
// command) stays strictly inside the job's own workspace directory.
export function checkedWorkspacePath(jobWorkspace, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) throw policyError('path_denied');
  if (UNC_PATTERN.test(candidate)) throw policyError('path_denied');
  const target = path.resolve(jobWorkspace, candidate);
  if (!within(jobWorkspace, target)) throw policyError('path_denied');
  assertNotForbidden(target);
  // Reject symlink escapes for any path segment that already exists.
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

// Minimal environment for spawned OpenMontage/Remotion/Node processes.
// Deliberately excludes every Docteur provider/API key and secret-store
// material — OpenMontage must never receive Groq/OpenRouter/OpenAI/
// Anthropic/Google/ElevenLabs/etc. credentials. Only the bare OS plumbing
// needed for Node/Python/FFmpeg subprocesses to run at all.
const ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

export function filteredEnv(source = process.env, extra = {}) {
  const base = Object.fromEntries(Object.entries(source).filter(([key]) => ENV_ALLOWLIST.has(key.toUpperCase())));
  // `extra` lets the caller add narrowly-scoped, non-secret overrides (e.g.
  // OPENMONTAGE_PROJECTS_DIR pointed at the job workspace). Never merge
  // arbitrary caller-supplied keys that look like credentials.
  for (const [key, value] of Object.entries(extra)) {
    if (/token|secret|key|password|credential/i.test(key)) throw policyError('env_key_denied');
    base[key] = value;
  }
  return base;
}
