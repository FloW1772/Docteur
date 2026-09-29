// Deterministic full-backend test manifest.
//
// `node --test` on a bare `test-*.mjs` glob is not safe: some files in this
// directory are not terminating automated test suites. Running them inside
// a batch sweep either hangs the whole run forever or produces a spurious
// failure for a script that was never meant to run unattended. This file is
// the single source of truth for which `test-*.mjs` files are genuine,
// terminating, automated tests, and prints the exact command to run them.
//
// Run with: node test-manifest.mjs         (prints the safe file list)
//           node test-manifest.mjs --run   (runs them via node --test)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Files matching test-*.mjs that are NOT genuine automated test suites, and
// why. Each entry here must be justified — this list is read, not guessed.
export const EXCLUDED = {
  'test-regression-api.mjs':
    'Non-terminating debug server: calls serve({ ... port: 3002 }) directly '
    + 'at module scope and never exits. Confirmed by inspection (no node:test '
    + 'import, no process.exit, an active HTTP listener at top level) and by '
    + 'reproduction: including it in a node --test glob hangs the entire run '
    + 'indefinitely with zero further output. Meant to be started manually by '
    + 'a developer for local API poking, not executed in a batch.',
  'test-find-eval.mjs':
    'Manual repro script, not an automated test: launches a real, non-headless '
    + '(headless: false) Playwright browser to interactively reproduce a bug. '
    + 'No node:test import, no fixed pass/fail contract designed for batch '
    + 'execution. Exits non-zero / times out under CI-style headless batch '
    + 'conditions — a NON_TEST_SCRIPT result, not a logic regression.',
  'test-video-manual.mjs':
    'Manual repro script, not an automated test: requires explicit --application '
    + '/ --hls CLI flags to do anything, downloads real audio from a live '
    + 'YouTube URL over the real network, and has no node:test import or '
    + 'fixed assertions. A NON_TEST_SCRIPT result under batch execution, not '
    + 'a logic regression.',
  'test-cyber-audit-fixture.mjs':
    'Shared fixture module, not a test: exports createCyberAuditFixture() for '
    + 'test-cyber-audit-*.mjs to import. Contains no assertions and performs '
    + 'no work at module scope.',
  'test-setup.mjs':
    'Shared setup module, not a test: sets DOCTEUR_TEST_MODE=1 and is imported '
    + 'first by every real test-*.mjs file. Contains no assertions.',
};

export function listAllTestFiles() {
  return fs.readdirSync(here)
    .filter(name => /^test-.*\.mjs$/.test(name) && name !== 'test-manifest.mjs')
    .sort();
}

export function listSafeTestFiles() {
  return listAllTestFiles().filter(name => !(name in EXCLUDED));
}

function main() {
  const all = listAllTestFiles();
  const safe = listSafeTestFiles();
  const excludedPresent = Object.keys(EXCLUDED).filter(name => all.includes(name));
  const excludedMissing = Object.keys(EXCLUDED).filter(name => !all.includes(name));
  const unclassifiedNonNodeTest = safe.filter(name => {
    const source = fs.readFileSync(path.join(here, name), 'utf8');
    return !source.includes('node:test') && name !== 'test-maintenance.mjs';
  });

  console.log(`Total test-*.mjs files: ${all.length}`);
  console.log(`Excluded (non-test scripts): ${excludedPresent.length}`);
  for (const name of excludedPresent) console.log(`  - ${name}: ${EXCLUDED[name]}`);
  if (excludedMissing.length) {
    console.log(`WARNING: exclusion entries reference files that no longer exist: ${excludedMissing.join(', ')}`);
  }
  if (unclassifiedNonNodeTest.length) {
    console.log(`WARNING: files with no node:test import and no exclusion entry (review manually): ${unclassifiedNonNodeTest.join(', ')}`);
  }
  console.log(`Safe, deterministic, terminating test files: ${safe.length}`);

  if (process.argv.includes('--run')) {
    const extraArgs = process.argv.slice(3).filter(arg => arg !== '--run');
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--test', ...extraArgs, ...safe],
      { cwd: here, stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 1));
  } else {
    console.log('\nRun with --run to execute: node test-manifest.mjs --run');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
