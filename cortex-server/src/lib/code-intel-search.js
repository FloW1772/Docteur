/**
 * Code Intelligence — repository search. Wraps the bundled ripgrep binary
 * (@vscode/ripgrep, MIT, Windows binary shipped in the npm tarball, no
 * network access, no postinstall fetch) via execFile/shell:false, exactly
 * following maitre-windows-exec.js's runReadOnlyPowerShell() discipline:
 * fixed executable, args built server-side only, hard timeout, bounded
 * output. There is no code path that accepts a caller-supplied shell
 * string — ripgrep is invoked with an explicit argv array.
 *
 * Symbol search is a deliberately honest heuristic (regex over common
 * declaration shapes for JS/TS/Python), not a real AST index — no fake
 * "exact references" claim is made anywhere in this module or its API
 * responses, per CI-9's explicit instruction.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { WORKSPACE_ROOT, DEFAULT_EXCLUDED_DIRS, resolveWorkspacePath, WorkspacePathError } from './code-intel-workspace.js';
import { isGitignoredOrExcluded } from './code-intel-gitignore.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = 8_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RESULTS = 200;
export const MAX_QUERY_LENGTH = 512;
export const MAX_SNIPPET_LENGTH = 300;

const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.json': 'json', '.md': 'markdown', '.css': 'css', '.html': 'html',
};

function languageForPath(relPath) {
  return LANGUAGE_BY_EXT[path.extname(relPath).toLowerCase()] ?? 'plaintext';
}

// Tells ripgrep itself to skip these directories rather than relying only
// on the post-filter below — avoids ripgrep spending time walking large
// nested repos (external/MetaGPT, external/OpenMontage) it will never
// return results for anyway, which is what caused the first real timeout
// observed during manual smoke testing of this module.
const EXCLUDE_GLOB_ARGS = DEFAULT_EXCLUDED_DIRS.flatMap(dir => ['--glob', `!/${dir}/**`]);

// Streaming variant, used whenever the caller wants to stop reading (and
// kill ripgrep) once a bounded number of lines have arrived — a plain
// execFile()+maxBuffer call can't do this: ripgrep may emit far more
// --json match events than MAX_OUTPUT_BYTES for a common query (e.g.
// "function" across the whole repo) well before ripgrep itself finishes,
// which previously surfaced as a hard "stdout maxBuffer length exceeded"
// failure instead of a clean, bounded result. Reading line-by-line and
// closing the pipe once the caller's own onLine callback signals "enough"
// bounds memory correctly regardless of total match count.
function runRipgrepStreaming(args, onLine, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(rgPath, args, { cwd: WORKSPACE_ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false, stderr = '';
    const timer = setTimeout(() => { finish({ ok: false, reason: 'timeout' }); }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      try { child.kill(); } catch { /* already exited */ }
      resolve(result);
    }

    rl.on('line', (line) => {
      if (settled) return;
      const stop = onLine(line);
      if (stop) finish({ ok: true });
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 2000); });
    child.on('error', () => finish({ ok: false, reason: 'search_failed', detail: 'spawn_error' }));
    child.on('close', (code) => {
      if (settled) return;
      // ripgrep exits 1 (not an error) when there are simply no matches.
      if (code === 0 || code === 1) finish({ ok: true });
      else finish({ ok: false, reason: 'search_failed', detail: stderr.slice(0, 2000) });
    });
  });
}

async function runRipgrep(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync(rgPath, args, {
      cwd: WORKSPACE_ROOT,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch (err) {
    // ripgrep exits 1 (not an error) when there are simply no matches.
    if (err.code === 1 && !err.killed) return { ok: true, stdout: err.stdout ?? '' };
    if (err.killed || err.signal === 'SIGTERM') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'search_failed', detail: (err.stderr || err.message || '').slice(0, 2000) };
  }
}

function boundedQuery(query) {
  if (typeof query !== 'string' || query.length === 0) throw new Error('query_required');
  if (query.length > MAX_QUERY_LENGTH) throw new Error('query_too_long');
  return query;
}

/**
 * Full-text search across workspace files. Returns bounded results with
 * file/line/column/snippet — never full file contents (CI-12/KX result
 * shape). Respects .gitignore and the fixed default exclusions via
 * ripgrep's own --ignore-file support plus a post-filter belt-and-braces
 * check (ripgrep already respects .gitignore natively when run inside a
 * git repo with default settings, but the post-filter guards the case
 * where ripgrep's own gitignore discovery differs from ours, e.g. nested
 * .gitignore edge cases).
 */
export async function searchText({ query, limit = 50, caseSensitive = false }) {
  boundedQuery(query);
  const boundedLimit = Math.min(Math.max(1, Number(limit) || 50), MAX_RESULTS);

  const args = [
    ...EXCLUDE_GLOB_ARGS,
    '--json',
    '--max-count', '5',
    '--max-filesize', '5M',
    caseSensitive ? '--case-sensitive' : '--ignore-case',
    '--fixed-strings',
    '--',
    query,
    '.',
  ];

  const matches = [];
  const result = await runRipgrepStreaming(args, (line) => {
    if (!line) return false;
    let event;
    try { event = JSON.parse(line); } catch { return false; }
    if (event.type !== 'match') return false;
    const relPath = event.data.path.text.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isGitignoredOrExcluded(relPath)) return false;
    const lineText = event.data.lines.text ?? '';
    matches.push({
      relativePath: relPath,
      line: event.data.line_number,
      column: event.data.submatches?.[0]?.start ?? null,
      snippet: lineText.slice(0, MAX_SNIPPET_LENGTH).replace(/\n$/, ''),
      language: languageForPath(relPath),
      matchType: 'text',
    });
    return matches.length >= boundedLimit;
  });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

  return { ok: true, results: matches, truncated: matches.length >= boundedLimit };
}

/**
 * Filename search — matches the query as a substring/glob against
 * relative file paths, using ripgrep's own file-listing mode (--files
 * + a name filter) rather than a second, separate directory walker.
 */
export async function searchFilenames({ query, limit = 50 }) {
  boundedQuery(query);
  const boundedLimit = Math.min(Math.max(1, Number(limit) || 50), MAX_RESULTS);

  const result = await runRipgrep([...EXCLUDE_GLOB_ARGS, '--files']);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

  const needle = query.toLowerCase();
  const matches = [];
  for (const rawLine of result.stdout.split('\n')) {
    if (!rawLine) continue;
    const relPath = rawLine.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isGitignoredOrExcluded(relPath)) continue;
    if (!relPath.toLowerCase().includes(needle)) continue;
    matches.push({
      relativePath: relPath,
      line: null,
      column: null,
      snippet: null,
      language: languageForPath(relPath),
      matchType: 'filename',
    });
    if (matches.length >= boundedLimit) break;
  }

  return { ok: true, results: matches, truncated: matches.length >= boundedLimit };
}

// Heuristic declaration patterns — intentionally simple, regex-based, not
// an AST. Each entry: [language-agnostic label, RegExp with a capture
// group for the symbol name]. Applied per-line via ripgrep's own regex
// mode so the scan itself stays fast and bounded, rather than reading
// every file into Node to run these patterns manually.
const SYMBOL_PATTERNS = [
  { symbol: 'function', pattern: String.raw`\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)` },
  { symbol: 'class', pattern: String.raw`\b(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)` },
  { symbol: 'const', pattern: String.raw`\b(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=` },
  { symbol: 'method', pattern: String.raw`^\s*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{` },
  { symbol: 'python_def', pattern: String.raw`^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(` },
  { symbol: 'python_class', pattern: String.raw`^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]` },
];

/**
 * Heuristic symbol search: finds declaration-shaped lines whose captured
 * name matches the query. This is NOT a real AST/LSP symbol index — no
 * "references" or cross-file resolution is attempted, and the API never
 * claims exactness (per CI-9). Useful for "where is X declared" as a
 * starting point, not a guarantee of completeness or correctness.
 */
export async function searchSymbols({ query, limit = 50 }) {
  boundedQuery(query);
  const boundedLimit = Math.min(Math.max(1, Number(limit) || 50), MAX_RESULTS);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const results = [];
  for (const { symbol, pattern } of SYMBOL_PATTERNS) {
    if (results.length >= boundedLimit) break;
    const combined = pattern.replace('([A-Za-z_$][A-Za-z0-9_$]*)', `(${escaped}[A-Za-z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*${escaped}[A-Za-z0-9_$]*)`)
      .replace('([A-Za-z_][A-Za-z0-9_]*)', `(${escaped}[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*${escaped}[A-Za-z0-9_]*)`);
    const args = [
      ...EXCLUDE_GLOB_ARGS,
      '--json', '--max-count', '5', '--max-filesize', '5M', '--ignore-case',
      '--type-add', 'code:*.{js,jsx,ts,tsx,mjs,cjs,py}', '--type', 'code',
      '--', combined, '.',
    ];
    await runRipgrepStreaming(args, (line) => {
      if (!line) return false;
      let event;
      try { event = JSON.parse(line); } catch { return false; }
      if (event.type !== 'match') return false;
      const relPath = event.data.path.text.replace(/\\/g, '/').replace(/^\.\//, '');
      if (isGitignoredOrExcluded(relPath)) return false;
      const lineText = (event.data.lines.text ?? '').trim();
      results.push({
        relativePath: relPath,
        line: event.data.line_number,
        column: event.data.submatches?.[0]?.start ?? null,
        symbol,
        snippet: lineText.slice(0, MAX_SNIPPET_LENGTH),
        language: languageForPath(relPath),
        matchType: 'symbol_heuristic',
      });
      return results.length >= boundedLimit;
    });
  }

  return { ok: true, results: results.slice(0, boundedLimit), truncated: results.length >= boundedLimit };
}

export { WorkspacePathError, resolveWorkspacePath };
