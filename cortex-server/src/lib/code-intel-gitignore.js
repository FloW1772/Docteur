/**
 * Code Intelligence — .gitignore-aware exclusion, layered on top of
 * code-intel-workspace.js's DEFAULT_EXCLUDED_DIRS (which always applies
 * regardless of .gitignore content, per CI-6/CI-9). Reads the repo's own
 * root .gitignore (read-only) and any nested .gitignore files it finds
 * directly under the workspace root's known subdirectories, using the
 * `ignore` package (the same gitignore-spec matcher ESLint/Prettier use,
 * verified against real `git check-ignore` behavior in its own test
 * suite) rather than hand-rolling glob matching.
 */
import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory from 'ignore';
import { WORKSPACE_ROOT, isPathExcludedByDefault } from './code-intel-workspace.js';

const KNOWN_GITIGNORE_FILES = [
  '.gitignore',
  'cortex-server/.gitignore',
  'docteur-voice/.gitignore',
];

let cachedMatcher = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000; // re-read .gitignore at most once a minute

function loadMatcher() {
  const now = Date.now();
  if (cachedMatcher && now - cachedAt < CACHE_TTL_MS) return cachedMatcher;

  const ig = ignoreFactory();
  for (const rel of KNOWN_GITIGNORE_FILES) {
    const abs = path.join(WORKSPACE_ROOT, rel);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      // Patterns in a nested .gitignore apply relative to that file's own
      // directory; the `ignore` package matches relative to wherever
      // .add() patterns are declared as if rooted there, so prefix nested
      // patterns with their directory to keep them scoped correctly.
      const dir = path.dirname(rel);
      const lines = content.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || dir === '.') return line;
        const negate = trimmed.startsWith('!');
        const body = negate ? trimmed.slice(1) : trimmed;
        const prefixed = `${dir}/${body}`;
        return negate ? `!${prefixed}` : prefixed;
      });
      ig.add(lines);
    } catch {
      // Missing/unreadable .gitignore is not an error — just contributes
      // no patterns.
    }
  }
  cachedMatcher = ig;
  cachedAt = now;
  return ig;
}

/**
 * True if relPath (workspace-relative, forward-slash) should be excluded
 * from search/indexing — either by the fixed default list or by any
 * discovered .gitignore rule.
 */
export function isGitignoredOrExcluded(relPath) {
  if (isPathExcludedByDefault(relPath)) return true;
  const matcher = loadMatcher();
  try {
    return matcher.ignores(relPath.replace(/\\/g, '/'));
  } catch {
    return false;
  }
}

// Exposed for tests — forces the next call to re-read .gitignore rather
// than reusing the cache.
export function clearGitignoreCache() {
  cachedMatcher = null;
  cachedAt = 0;
}
