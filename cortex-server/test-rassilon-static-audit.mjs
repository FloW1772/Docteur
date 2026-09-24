// Static security audit (mission §58): greps RASSILON's own source files
// for dangerous patterns. This is a regression guard — if a future
// change to rassilon-*.js/routes/rassilon.js introduces any of these
// shapes, this test fails immediately rather than relying on manual
// review to catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const RASSILON_SOURCE_FILES = [
  'src/lib/rassilon-identity.js',
  'src/lib/rassilon-job-schema.js',
  'src/lib/rassilon-executors.js',
  'src/lib/rassilon-embedding.js',
  'src/lib/rassilon-settings.js',
  'src/lib/rassilon-resource-guard.js',
  'src/lib/rassilon-power.js',
  'src/lib/rassilon-idle.js',
  'src/lib/rassilon-scratch.js',
  'src/lib/rassilon-audit.js',
  'src/lib/rassilon-worker.js',
  'src/lib/rassilon-lan-auth.js',
  'src/lib/rassilon-pairing.js',
  'src/lib/rassilon-remote-result.js',
  'src/lib/rassilon-capabilities.js',
  'src/lib/rassilon-lan-runtime.js',
  'src/lib/rassilon-lan-server.js',
  'src/lib/rassilon-scheduler.js',
  'src/lib/rassilon-controller.js',
  'src/routes/rassilon.js',
  'src/routes/rassilon-lan.js',
].map(p => path.resolve(import.meta.dirname, p));

// Patterns checked against CODE lines only (comments are stripped first)
// since several files' own header comments legitimately discuss these
// strings as things they DON'T do (e.g. "no shell:true anywhere") —
// searching raw text would false-positive on those explanatory comments.
const FORBIDDEN_PATTERNS = [
  [/shell\s*:\s*true/i, 'shell:true'],
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/Invoke-Expression/i, 'Invoke-Expression'],
  [/\biex\b/i, 'iex (PowerShell alias for Invoke-Expression)'],
  [/\bschtasks\b/i, 'schtasks'],
  [/sc\.exe\s+create/i, 'service install (sc.exe create)'],
  [/ollama\s+pull/i, 'ollama pull'],
  [/npm\s+install/i, 'npm install'],
  [/pip\s+install/i, 'pip install'],
  [/HKEY_|Registry::.*\\Run\b/i, 'registry Run key'],
];

function stripComments(source) {
  // Strip /* ... */ block comments and // line comments — good enough
  // for this audit's purpose (source files here don't contain strings
  // with // or /* that would be misparsed as comment starts in a way
  // that hides a real forbidden pattern; a false negative here would
  // still be caught by the plain grep in the mission's own manual audit
  // step, this is a regression guard, not the sole line of defense).
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

for (const filePath of RASSILON_SOURCE_FILES) {
  test(`static audit: ${path.basename(filePath)} contains no forbidden execution patterns in code (comments excluded)`, () => {
    const source = fs.readFileSync(filePath, 'utf8');
    const codeOnly = stripComments(source);
    for (const [pattern, label] of FORBIDDEN_PATTERNS) {
      const match = codeOnly.match(pattern);
      assert.equal(match, null, `${path.basename(filePath)} contains forbidden pattern: ${label} (matched: "${match?.[0]}")`);
    }
  });
}

test('static audit: no rassilon-*.js file imports node:child_process directly (all process control goes through maitre-windows-exec.js)', () => {
  for (const filePath of RASSILON_SOURCE_FILES) {
    const source = fs.readFileSync(filePath, 'utf8');
    const hasDirectImport = /from\s+['"]node:child_process['"]/.test(source) || /require\(['"]child_process['"]\)/.test(source);
    assert.equal(hasDirectImport, false, `${path.basename(filePath)} should not import node:child_process directly`);
  }
});

test('static audit: no rassilon-*.js file references omega_ or maitre_ SQLite tables', () => {
  const FORBIDDEN_TABLE_PREFIXES = [/\bomega_\w+/, /\bmaitre_\w+/, /\bmonitor_\w+/, /\bcyber_audit_\w+/];
  for (const filePath of RASSILON_SOURCE_FILES) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const pattern of FORBIDDEN_TABLE_PREFIXES) {
      assert.equal(pattern.test(source), false, `${path.basename(filePath)} should not reference ${pattern} tables`);
    }
  }
});

// Mission §51 Phase 3 — no external http(s):// URL literal anywhere in
// RASSILON's own code (mission §4: EMBEDDING_BATCH is local-only, no
// cloud fallback, no remote endpoint). This does NOT scan the reused
// ollama.js/embedText() code it calls into (that module's own base URL
// comes from env.OLLAMA_URL, resolved elsewhere, and was already local-
// only before RASSILON existed) — it scans RASSILON's OWN files only,
// confirming this module never hardcodes or accepts a remote endpoint
// itself.
test('static audit: no external http:// or https:// URL literal in any rassilon-*.js file', () => {
  const URL_PATTERN = /https?:\/\/[^\s'"`)]+/gi;
  for (const filePath of RASSILON_SOURCE_FILES) {
    const source = fs.readFileSync(filePath, 'utf8');
    const codeOnly = stripComments(source);
    const matches = codeOnly.match(URL_PATTERN) || [];
    assert.equal(matches.length, 0, `${path.basename(filePath)} contains URL literal(s): ${matches.join(', ')}`);
  }
});

// ── Privacy audit (mission §9/§52 Phase 3) ──────────────────────────────

test('privacy audit: rassilon-embedding.js never calls a logger (no input text or vector content can reach a log line from this module)', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, 'src/lib/rassilon-embedding.js'), 'utf8');
  const codeOnly = stripComments(source);
  assert.equal(/\blog\s*\(/.test(codeOnly), false, 'rassilon-embedding.js should not log anything — it has no logger dependency at all');
});

test('privacy audit: rassilon-worker.js log() calls for job events reference only jobId/jobType/error codes, never a payload/texts/vectors variable', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, 'src/lib/rassilon-worker.js'), 'utf8');
  const codeOnly = stripComments(source);
  // Line-based rather than a greedy multi-line regex span (avoids any
  // backtracking-cost concern) — every real log(...) call in this
  // codebase's style fits on one source line, so scanning line-by-line
  // for a 'log(' call plus a suspicious identifier on that SAME line is
  // sufficient and cheap.
  const suspiciousLines = codeOnly.split('\n').filter(line => /\blog\(/.test(line) && /\bpayload\b|\btexts\b|\bvectors\b/i.test(line));
  assert.equal(suspiciousLines.length, 0, `suspicious log call(s) possibly logging payload content: ${suspiciousLines.join(' | ')}`);
});

test('privacy audit: rassilon-audit.js bounds result_summary size and never accepts a raw payload/texts/vectors field name in its own code', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, 'src/lib/rassilon-audit.js'), 'utf8');
  assert.ok(/MAX_SUMMARY_BYTES/.test(source), 'expected a bounded summary size constant');
  assert.ok(!/\.texts\b|\.vectors\b|\.payload\b/.test(source), 'rassilon-audit.js should never destructure/reference .texts/.vectors/.payload directly');
});

test('EMBEDDING_MODEL_ALLOWLIST in rassilon-job-schema.js contains only bare model-name strings (no path/URL/UNC shape)', async () => {
  const { EMBEDDING_MODEL_ALLOWLIST } = await import('./src/lib/rassilon-job-schema.js');
  assert.ok(EMBEDDING_MODEL_ALLOWLIST.length > 0);
  for (const model of EMBEDDING_MODEL_ALLOWLIST) {
    assert.equal(typeof model, 'string');
    assert.ok(!model.includes('/') && !model.includes('\\'), `model "${model}" should not contain a path separator`);
    assert.ok(!/^https?:/i.test(model), `model "${model}" should not be a URL`);
  }
});
