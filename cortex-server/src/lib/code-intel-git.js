/**
 * Code Intelligence — read-only Git wrapper. Exposes EXACTLY four
 * operations: status, diff, log, show. There is no runGit(command)
 * function and never will be — each operation below is its own function
 * with its own fixed, hardcoded argv array; caller-supplied values are
 * only ever validated data (a ref string, a path, a count), never command
 * text. This mirrors maitre-executor.js's own documented discipline
 * ("no runCommand()/runShell()... only named, semantic executors").
 *
 * git.exe is resolved once via a PATH walk + fs.statSync().isFile()
 * verification, adapting external-agent-process.js's resolveCli()
 * discipline (which also never trusts a bare command name or a .cmd/.bat
 * shim). shell:false always, via execFile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORKSPACE_ROOT, resolveWorkspacePath, WorkspacePathError } from './code-intel-workspace.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = 8_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_LOG_COMMITS = 200;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

let resolvedGit; // cached { command } | null, resolved lazily on first use

/**
 * Resolves git.exe (or git on POSIX) via PATH only — never a hardcoded
 * install location (unlike powershell.exe, git has no single well-known
 * path), never a .cmd/.bat shim, verified to be a real file before use.
 */
function resolveGit() {
  if (resolvedGit !== undefined) return resolvedGit;
  const envPath = process.env.PATH || process.env.Path || '';
  const dirs = envPath.split(path.delimiter);
  const win32 = process.platform === 'win32';
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, win32 ? 'git.exe' : 'git');
    try {
      if (fs.statSync(candidate).isFile()) {
        resolvedGit = { command: fs.realpathSync(candidate) };
        return resolvedGit;
      }
    } catch { /* try next dir */ }
  }
  resolvedGit = null;
  return resolvedGit;
}

export class GitUnavailableError extends Error {
  constructor() { super('git_not_found'); this.code = 'git_not_found'; }
}

export class InvalidRefError extends Error {
  constructor(ref) { super('invalid_ref'); this.code = 'invalid_ref'; this.ref = ref; }
}

// A git ref/commit-ish is restricted to a conservative, well-known
// character set (hex hashes, branch/tag names, HEAD~N, HEAD^, etc.) —
// never passed through to a shell, but still validated defensively so a
// malformed value can never be mistaken for a git option (e.g. a ref
// starting with "-" could otherwise be interpreted as a flag by git
// itself, regardless of shell involvement).
const REF_PATTERN = /^[A-Za-z0-9._/\-^~@]{1,200}$/;

function assertValidRef(ref) {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref) || ref.startsWith('-')) {
    throw new InvalidRefError(ref);
  }
}

async function runGitCommand(args, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_OUTPUT_BYTES } = {}) {
  const git = resolveGit();
  if (!git) throw new GitUnavailableError();
  try {
    const { stdout } = await execFileAsync(git.command, args, {
      cwd: WORKSPACE_ROOT,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer,
      shell: false,
      encoding: 'utf8',
      // No inherited env beyond PATH/HOME-equivalents needed for a plain
      // read command; explicitly strip anything that could alter git's
      // behavior toward mutation (e.g. GIT_EDITOR, hooks path overrides).
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
    });
    return { ok: true, stdout };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'git_command_failed', detail: (err.stderr || err.message || '').slice(0, 2000) };
  }
}

/** git status --porcelain=v1 — machine-readable, read-only. */
export async function gitStatus() {
  const result = await runGitCommand(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (!result.ok) return result;
  const entries = result.stdout.split('\n').filter(Boolean).map(line => {
    const statusCode = line.slice(0, 2);
    const filePath = line.slice(3).replace(/\\/g, '/');
    return { statusCode, path: filePath };
  });
  return { ok: true, entries };
}

/**
 * git diff — working-tree diff by default, staged diff if requested, or
 * scoped to a single validated, in-workspace path. Bounded output.
 */
export async function gitDiff({ staged = false, relPath = null } = {}) {
  const args = ['diff'];
  if (staged) args.push('--staged');
  args.push('--no-color', '--unified=3');
  if (relPath) {
    const resolved = resolveWorkspacePath(relPath); // throws WorkspacePathError on violation
    args.push('--', resolved.relativePath);
  }
  const result = await runGitCommand(args, { maxBuffer: MAX_DIFF_BYTES });
  if (!result.ok) return result;
  const truncated = result.stdout.length >= MAX_DIFF_BYTES;
  return { ok: true, diff: result.stdout.slice(0, MAX_DIFF_BYTES), truncated };
}

/** git log — bounded commit count, fixed machine-readable field format. */
export async function gitLog({ limit = 20 } = {}) {
  const boundedLimit = Math.min(Math.max(1, Number(limit) || 20), MAX_LOG_COMMITS);
  const SEP = '\x1f'; // unit separator — safe, never appears in commit metadata
  const args = ['log', `-n${boundedLimit}`, `--pretty=format:%H${SEP}%an${SEP}%ad${SEP}%s`, '--date=iso-strict'];
  const result = await runGitCommand(args);
  if (!result.ok) return result;
  const commits = result.stdout.split('\n').filter(Boolean).map(line => {
    const [hash, author, date, subject] = line.split(SEP);
    return { hash, author, date, subject };
  });
  return { ok: true, commits };
}

/**
 * git show — a single validated ref, optionally scoped to one validated,
 * in-workspace path. No arbitrary ref text is ever concatenated as an
 * option; assertValidRef rejects anything that could be interpreted as a
 * flag or contain shell-meaningful characters (moot under shell:false,
 * but defended anyway as a second layer).
 */
export async function gitShow({ ref, relPath = null } = {}) {
  assertValidRef(ref);
  const args = ['show', '--no-color', '--unified=3', ref];
  if (relPath) {
    const resolved = resolveWorkspacePath(relPath);
    args.push('--', resolved.relativePath);
  }
  const result = await runGitCommand(args, { maxBuffer: MAX_DIFF_BYTES });
  if (!result.ok) return result;
  const truncated = result.stdout.length >= MAX_DIFF_BYTES;
  return { ok: true, content: result.stdout.slice(0, MAX_DIFF_BYTES), truncated };
}

export function isGitAvailable() {
  return resolveGit() !== null;
}

export { WorkspacePathError };
