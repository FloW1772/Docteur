/**
 * Code Intelligence — workspace boundary. Every other code-intel module
 * (search, git wrapper) must resolve paths through this file before ever
 * touching the filesystem or building a command argument. There is no
 * frontend-supplied path that is ever trusted directly: the workspace root
 * is fixed server-side (the Docteur repo root itself), and every relative
 * path a caller supplies is resolved against it and re-verified to still
 * be inside it afterward (defeats traversal, symlink escape, and absolute
 * paths supplied where a relative one was expected).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// cortex-server/src/lib/ -> repo root is three levels up.
export const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');

// Directories never indexed/searched/diffed by default, regardless of
// .gitignore content — matches CI-6/CI-7/CI-9 exactly. Paths are relative
// to WORKSPACE_ROOT, matched as a leading path segment.
export const DEFAULT_EXCLUDED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.cache',
  'playwright-report',
  'test-results',
  'cortex-server/data',
  'cortex-server/node_modules',
  'docteur-voice/node_modules',
  // External nested repos — never indexed by default (CI-7). Excluded as
  // the whole external/ directory, not per-name (MetaGPT/OpenMontage/
  // Sherlock-runtime/Sherlock-source today), so a future addition under
  // external/ is never silently indexed by omission.
  'external',
];

// data-test-*/ is a glob, handled separately since it's not a fixed name.
const DATA_TEST_DIR_RE = /(^|[\\/])data-test-[^\\/]*([\\/]|$)/;

// Secret-shaped paths excluded even if not gitignored (CI-8) — matched
// against the path's basename or a trailing segment, not full-path regex,
// to avoid accidentally excluding an unrelated directory that merely
// contains one of these substrings deeper in its own tree.
const SECRET_BASENAME_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^.*\.pfx$/i,
  /^.*\.p12$/i,
  /^.*\.sqlite3?$/i, // runtime DBs (cortex.sqlite, secret-store ciphertext lives here)
];

function isExcludedPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  if (DATA_TEST_DIR_RE.test(normalized)) return true;
  for (const dir of DEFAULT_EXCLUDED_DIRS) {
    const norm = dir.replace(/\\/g, '/');
    if (normalized === norm || normalized.startsWith(norm + '/')) return true;
  }
  const basename = path.posix.basename(normalized);
  if (SECRET_BASENAME_PATTERNS.some(re => re.test(basename))) return true;
  return false;
}

export class WorkspacePathError extends Error {
  constructor(reason) {
    super(`code_intel_path_${reason}`);
    this.code = `code_intel_path_${reason}`;
  }
}

/**
 * Resolves a caller-supplied relative path against WORKSPACE_ROOT and
 * verifies the result is still inside it (defeats "../../..", absolute
 * paths, UNC paths, and symlink escapes via realpath). Throws
 * WorkspacePathError on any violation — callers must not catch this to
 * "fall back" to an unvalidated path.
 */
export function resolveWorkspacePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) throw new WorkspacePathError('invalid');
  if (relPath.length > 4096) throw new WorkspacePathError('too_long');
  // Reject absolute paths (POSIX or Windows drive-letter) and UNC paths —
  // only a path relative to the workspace root is ever accepted.
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\') || relPath.startsWith('//')) {
    throw new WorkspacePathError('absolute_denied');
  }
  if (relPath.includes('\0')) throw new WorkspacePathError('invalid');

  const joined = path.resolve(WORKSPACE_ROOT, relPath);
  if (joined !== WORKSPACE_ROOT && !joined.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new WorkspacePathError('traversal_denied');
  }

  let stat;
  try {
    stat = fs.lstatSync(joined);
  } catch {
    throw new WorkspacePathError('not_found');
  }

  if (stat.isSymbolicLink()) {
    // Resolve the symlink and re-verify the REAL target is still inside
    // the workspace — a symlink pointing outside (e.g. to a secret-store
    // location or another drive) must never be followed.
    let real;
    try {
      real = fs.realpathSync(joined);
    } catch {
      throw new WorkspacePathError('not_found');
    }
    if (real !== WORKSPACE_ROOT && !real.startsWith(WORKSPACE_ROOT + path.sep)) {
      throw new WorkspacePathError('symlink_escape_denied');
    }
    stat = fs.statSync(real);
  }

  const relNormalized = path.relative(WORKSPACE_ROOT, joined);
  if (isExcludedPath(relNormalized)) throw new WorkspacePathError('excluded');

  return { absolutePath: joined, relativePath: relNormalized.replace(/\\/g, '/'), stat };
}

export function isPathExcludedByDefault(relPath) {
  return isExcludedPath(relPath.replace(/\\/g, '/'));
}
