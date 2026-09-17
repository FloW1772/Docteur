// MG-2G — Certification de la tool policy MetaGPT côté Node (allowlist par
// clé d'exécution exacte, jamais par nom de classe/tool). Ne teste que la
// couche Node (metagpt-policy.js) — la couche Python miroir est testée
// séparément (test-metagpt-policy-python.mjs) et vérifiée indépendante.
//
// Run: node --test test-metagpt-policy.mjs
import './test-setup.mjs'; // must be first
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeToolExecution,
  authorizeToolArguments,
  allowedExecutionKeysForRole,
  declaredToolsForRole,
  canonicalExecutionKey,
  isKnownRole,
} from './src/lib/metagpt-policy.js';

describe('MetaGPT policy — method allowlist (authorizeToolExecution)', () => {
  test('PASS: Editor.write/read/similarity_search for each V1 role', () => {
    for (const role of ['ProductManager', 'Architect', 'ProjectManager', 'RoleZero']) {
      for (const key of ['Editor.write', 'Editor.read', 'Editor.similarity_search']) {
        assert.equal(authorizeToolExecution(role, key), key);
      }
    }
  });

  test('PASS: WriteTasks and WriteTasks.run for ProjectManager only', () => {
    assert.equal(authorizeToolExecution('ProjectManager', 'WriteTasks'), 'WriteTasks');
    assert.equal(authorizeToolExecution('ProjectManager', 'WriteTasks.run'), 'WriteTasks.run');
  });

  test('DENY: WriteTasks on a role that does not own it', () => {
    for (const role of ['ProductManager', 'Architect', 'RoleZero']) {
      assert.throws(() => authorizeToolExecution(role, 'WriteTasks'), /tool_execution_denied/);
      assert.throws(() => authorizeToolExecution(role, 'WriteTasks.run'), /tool_execution_denied/);
    }
  });

  test('DENY: other Editor methods not on the allowlist', () => {
    const denied = ['Editor.append_file', 'Editor.create_file', 'Editor.edit_file_by_replace',
      'Editor.find_file', 'Editor.goto_line', 'Editor.insert_content_at_line', 'Editor.open_file',
      'Editor.scroll_down', 'Editor.scroll_up', 'Editor.search_dir', 'Editor.search_file',
      'Editor.delete', 'Editor.execute', 'Editor.foo'];
    for (const key of denied) {
      assert.throws(() => authorizeToolExecution('ProductManager', key), /tool_execution_denied/, key);
    }
  });

  test('DENY: Browser, Terminal, Bash, Git, Plan, RunCode, ExecuteNbCode', () => {
    const denied = ['Browser.goto', 'Browser.click', 'Terminal.run_command', 'Bash', 'Bash.run',
      'Git.push', 'Git.commit', 'Plan.append_task', 'Plan.replace_task', 'Plan.reset_task',
      'RunCode.run', 'ExecuteNbCode.run', 'RoleZero.ask_human', 'RoleZero.reply_to_human'];
    for (const key of denied) {
      for (const role of ['ProductManager', 'Architect', 'ProjectManager', 'RoleZero']) {
        assert.throws(() => authorizeToolExecution(role, key), /tool_execution_denied/, `${role}:${key}`);
      }
    }
  });

  test('DENY: unknown tool / unknown method', () => {
    assert.throws(() => authorizeToolExecution('ProductManager', 'TotallyUnknownTool'), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 'Editor.totallyUnknownMethod'), /tool_execution_denied/);
  });

  test('DENY: bypass values <all>, *, ALL, all, and case variants', () => {
    for (const bypass of ['<all>', '*', 'ALL', 'all', 'All']) {
      assert.throws(() => authorizeToolExecution('ProductManager', bypass), /tool_(bypass_value_denied|execution_denied)/, bypass);
    }
  });

  test('DENY: casing variants of a valid tool name are never silently accepted', () => {
    assert.throws(() => authorizeToolExecution('ProductManager', 'editor.write'), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 'EDITOR.WRITE'), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 'terminal.run_command'), /tool_execution_denied/);
  });

  test('PASS: leading/trailing whitespace is trimmed (peripheral trim only, not a fuzzy match)', () => {
    assert.equal(authorizeToolExecution('ProductManager', ' Editor.write'), 'Editor.write');
    assert.equal(authorizeToolExecution('ProductManager', '  Editor.write  '), 'Editor.write');
  });

  test('DENY: internal whitespace or malformed separators never match a valid key', () => {
    assert.throws(() => authorizeToolExecution('ProductManager', 'Editor . write'), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 'Editor:write'), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 'Editor .write'), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 'Editor. write'), /tool_execution_denied/);
  });

  test('DENY: invisible/control characters never match a valid key', () => {
    assert.throws(() => authorizeToolExecution('ProductManager', 'Editor.write\u200b'), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 'Editor.write\u0000'), /tool_execution_denied/);
  });

  test('DENY: a filesystem path used as a tool identity (register_tools_from_path vector)', () => {
    const pathsAsTools = [
      '../../../etc/passwd',
      'C:\\Windows\\System32',
      '\\\\attacker\\share\\evil.py',
      './evil.py',
      'C:\\dev\\Docteur\\external\\MetaGPT\\metagpt',
    ];
    for (const p of pathsAsTools) {
      assert.throws(() => authorizeToolExecution('ProductManager', p), /tool_execution_denied/, p);
    }
  });

  test('DENY: unknown role', () => {
    assert.throws(() => authorizeToolExecution('Engineer', 'Editor.write'), /role_not_recognized/);
    assert.throws(() => authorizeToolExecution('QaEngineer', 'Editor.write'), /role_not_recognized/);
  });

  test('DENY: non-string execution key', () => {
    assert.throws(() => authorizeToolExecution('ProductManager', null), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', 42), /tool_execution_denied/);
    assert.throws(() => authorizeToolExecution('ProductManager', ['Editor.write']), /tool_execution_denied/);
  });
});

describe('MetaGPT policy — central table immutability (no mutation leakage)', () => {
  test('mutating a returned Set never affects the central policy table', () => {
    const before = [...allowedExecutionKeysForRole('ProductManager')].sort();
    const copy = allowedExecutionKeysForRole('ProductManager');
    copy.add('Terminal.run_command');
    copy.clear();
    const after = [...allowedExecutionKeysForRole('ProductManager')].sort();
    assert.deepEqual(after, before);
    assert.ok(after.includes('Editor.write'));
  });

  test('declaredToolsForRole returns a fresh array copy each call', () => {
    const a = declaredToolsForRole('ProjectManager');
    a.push('Terminal:run_command');
    const b = declaredToolsForRole('ProjectManager');
    assert.equal(b.includes('Terminal:run_command'), false);
  });

  test('authorizeToolExecution still denies Terminal after a caller tried to mutate a prior copy', () => {
    const copy = allowedExecutionKeysForRole('Architect');
    copy.add('Terminal.run_command'); // attempted poisoning of a local copy
    assert.throws(() => authorizeToolExecution('Architect', 'Terminal.run_command'), /tool_execution_denied/);
  });
});

describe('MetaGPT policy — argument/path allowlist (authorizeToolArguments)', () => {
  const WORKSPACE = 'C:\\dev\\Docteur\\cortex-server\\data\\metagpt-workspaces\\mg2g-test';

  test('PASS: a file explicitly inside the job workspace', () => {
    assert.equal(authorizeToolArguments('ProductManager', 'Editor.write', ['spec.md'], WORKSPACE), true);
    assert.equal(authorizeToolArguments('ProductManager', 'Editor.write', ['subdir/spec.md'], WORKSPACE), true);
  });

  test('DENY: relative traversal out of the workspace', () => {
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['../../etc/passwd'], WORKSPACE), /tool_arguments_denied/);
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.read', ['..\\..\\secrets.txt'], WORKSPACE), /tool_arguments_denied/);
  });

  test('DENY: absolute path outside the workspace', () => {
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['C:\\dev\\Docteur\\package.json'], WORKSPACE), /tool_arguments_denied/);
  });

  test('DENY: UNC path', () => {
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['\\\\attacker\\share\\file.txt'], WORKSPACE), /tool_arguments_denied/);
  });

  test('DENY: forbidden substrings even if nominally inside workspace resolution', () => {
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['..\\..\\..\\cortex-server\\data\\cortex.sqlite'], WORKSPACE), /tool_arguments_denied/);
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['..\\..\\..\\.env'], WORKSPACE), /tool_arguments_denied/);
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['..\\..\\..\\src\\lib\\secret-store.js'], WORKSPACE), /tool_arguments_denied/);
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['..\\..\\..\\..\\external\\MetaGPT\\metagpt\\config2.py'], WORKSPACE), /tool_arguments_denied/);
  });

  test('DENY: real HOME / AppData paths', () => {
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', ['C:\\Users\\flow1\\AppData\\Local\\evil.txt'], WORKSPACE), /tool_arguments_denied/);
  });

  test('Editor.similarity_search and WriteTasks/WriteTasks.run take no path argument — always pass through argument policy', () => {
    assert.equal(authorizeToolArguments('ProductManager', 'Editor.similarity_search', ['some query text'], WORKSPACE), true);
    assert.equal(authorizeToolArguments('ProjectManager', 'WriteTasks', [], WORKSPACE), true);
    assert.equal(authorizeToolArguments('ProjectManager', 'WriteTasks.run', [], WORKSPACE), true);
  });

  test('DENY: missing path argument for a path-bearing method', () => {
    assert.throws(() => authorizeToolArguments('ProductManager', 'Editor.write', [], WORKSPACE), /tool_arguments_denied/);
  });
});
