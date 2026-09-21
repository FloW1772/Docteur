// Structural test (mission §39/§43, MA-7) — confirms the MA-7 proposal/
// policy/approval trio (maitre-actions.js, maitre-policy.js,
// maitre-approval.js) never imports child_process, any OS adapter,
// PowerShell, or Ollama, and never directly imports the executor
// (maitre-executor.js legitimately exists as of MA-8 — that module's
// OWN static-safety test, test-maitre-executor-static-safety.mjs,
// covers ITS boundaries; this file's job is narrower and still fully
// valid: the proposal/policy/approval layer below the executor must
// stay pure regardless of what MA-8+ built on top of it).
// Run with: node --test test-maitre-no-executor.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const LIB_DIR = path.join(process.cwd(), 'src', 'lib');
const MA7_FILES = ['maitre-actions.js', 'maitre-policy.js', 'maitre-approval.js'];

test('maitre-actions.js/maitre-policy.js/maitre-approval.js never import maitre-executor.js', () => {
  for (const file of MA7_FILES) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    const importLines = source.split('\n').filter(l => /^\s*import\b/.test(l));
    for (const line of importLines) {
      assert.doesNotMatch(line, /maitre-executor/, `${file} must not import the executor — the dependency direction is executor -> approval, never the reverse`);
    }
  }
});

test('MA-7 modules never import child_process', () => {
  for (const file of MA7_FILES) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    assert.doesNotMatch(source, /require\(['"]child_process['"]\)|from\s+['"]node:child_process['"]|from\s+['"]child_process['"]/, `${file} must not import child_process`);
  }
});

test('MA-7 modules never reference execFile/spawn/exec directly', () => {
  for (const file of MA7_FILES) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    assert.doesNotMatch(source, /\bexecFile\(|\bspawn\(|\bexecSync\(/, `${file} must not call a process-spawning function`);
  }
});

test('MA-7 modules never import a Windows exec/PowerShell helper', () => {
  for (const file of MA7_FILES) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    assert.doesNotMatch(source, /maitre-windows-exec/, `${file} must not depend on the OS execution helper`);
  }
});

test('MA-7 modules never import Ollama or any OS inspector adapter', () => {
  for (const file of MA7_FILES) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]\.\/ollama\.js['"]/, `${file} must not import the Ollama client`);
    assert.doesNotMatch(source, /maitre-defender-adapter|maitre-eventlog-adapter|maitre-file-inspector|maitre-persistence-inspector/, `${file} must not import an OS-touching adapter`);
  }
});

test('maitre-approval.js only imports maitre-process-inspector for its PURE classifyProcessCriticality function, never for live inspection', () => {
  const source = fs.readFileSync(path.join(LIB_DIR, 'maitre-approval.js'), 'utf8');
  assert.doesNotMatch(source, /maitre-process-inspector/, 'approval flow itself should not need process-inspector — only maitre-actions.js does, for classification');
});

test('maitre-actions.js imports ONLY classifyProcessCriticality from maitre-process-inspector, not listProcesses/inspectProcess (which would touch the OS)', () => {
  const source = fs.readFileSync(path.join(LIB_DIR, 'maitre-actions.js'), 'utf8');
  const importLine = source.split('\n').find(l => l.includes('maitre-process-inspector'));
  assert.ok(importLine);
  assert.match(importLine, /classifyProcessCriticality/);
  assert.doesNotMatch(importLine, /listProcesses|inspectProcess\b/);
});

test('no maitre_actions/maitre_action_approvals row ever gets status EXECUTED in MA-7 code', () => {
  for (const file of [...MA7_FILES, 'sqlite.js']) {
    const fullPath = file === 'sqlite.js' ? path.join(LIB_DIR, 'sqlite.js') : path.join(LIB_DIR, file);
    const source = fs.readFileSync(fullPath, 'utf8');
    assert.doesNotMatch(source, /'EXECUTED'|"EXECUTED"/, `${file} must never set/reference an EXECUTED status in MA-7`);
  }
});
