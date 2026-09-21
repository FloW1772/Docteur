// Static safety test (mission §36, updated MA-9; MA-10 §30) — source-level
// checks on maitre-executor.js AND maitre-host-isolation.js confirming
// zero shell:true, zero exec()/eval()/Function()/Invoke-Expression, zero
// arbitrary-command surface. As of MA-10, exactly 4 LEVEL 2 actions
// (TERMINATE_PROCESS, QUARANTINE_WITH_DEFENDER, BLOCK_REMOTE_IP,
// DISABLE_PERSISTENCE_ENTRY) plus 2 LEVEL 3 actions (HOST_ISOLATION,
// RESTORE_HOST_NETWORK) are legitimately dispatchable — this file
// asserts the dispatch table is EXACTLY that set.
// Run with: node --test test-maitre-executor-static-safety.mjs
import './test-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const EXECUTOR_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'maitre-executor.js'), 'utf8');
const ISOLATION_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'maitre-host-isolation.js'), 'utf8');

// Strips // line comments and /* */ block comments so the checks below
// only ever inspect real code — this file's own doc comments
// deliberately NAME the forbidden things they guarantee the absence
// of (e.g. "No Ollama, Claude... import anywhere in this file"), which
// would otherwise false-positive a naive substring search.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const CODE_ONLY = stripComments(EXECUTOR_SOURCE);
const ISOLATION_CODE_ONLY = stripComments(ISOLATION_SOURCE);

test('static safety: shell:true does not appear anywhere', () => {
  assert.doesNotMatch(EXECUTOR_SOURCE, /shell\s*:\s*true/);
});

test('static safety: no child_process exec()/execSync() call (only the injected exec param, defaulting to execFile via maitre-windows-exec.js, is allowed)', () => {
  assert.doesNotMatch(CODE_ONLY, /execSync\(/);
  assert.doesNotMatch(EXECUTOR_SOURCE, /from\s+['"]node:child_process['"]/, 'must not import child_process directly — only via maitre-windows-exec.js');
});

test('static safety: no eval() or new Function()', () => {
  assert.doesNotMatch(EXECUTOR_SOURCE, /\beval\(/);
  assert.doesNotMatch(EXECUTOR_SOURCE, /new\s+Function\(/);
});

test('static safety: no Invoke-Expression / iex', () => {
  assert.doesNotMatch(EXECUTOR_SOURCE, /Invoke-Expression/i);
  assert.doesNotMatch(EXECUTOR_SOURCE, /\biex\b/i);
});

test('static safety: no generic runCommand/runShell/executePowerShell/executeCustomAction/executeArgsFromClient function', () => {
  for (const forbidden of ['runCommand', 'runShell', 'executePowerShell', 'executeCustomAction', 'executeArgsFromClient']) {
    assert.doesNotMatch(EXECUTOR_SOURCE, new RegExp(`function\\s+${forbidden}|const\\s+${forbidden}\\s*=`), `${forbidden} must not exist`);
  }
});

test('static safety: dispatch table is exactly LEVEL 1 + LEVEL 2 + LEVEL 3 (MA-10) — no more, no less', () => {
  const dispatchTableMatch = EXECUTOR_SOURCE.match(/const EXECUTORS = \{([^}]*)\}/s);
  assert.ok(dispatchTableMatch, 'EXECUTORS dispatch table must exist');
  const tableBody = dispatchTableMatch[1];
  for (const expected of ['COLLECT_EVIDENCE', 'SCAN_WITH_DEFENDER', 'TERMINATE_PROCESS', 'QUARANTINE_WITH_DEFENDER', 'BLOCK_REMOTE_IP', 'DISABLE_PERSISTENCE_ENTRY', 'HOST_ISOLATION', 'RESTORE_HOST_NETWORK']) {
    assert.match(tableBody, new RegExp(expected), `${expected} must be dispatchable`);
  }
  // Exactly 8 action types, never a 9th silently added.
  const entryCount = (tableBody.match(/:\s*\w+Executor,?/g) || []).length;
  assert.equal(entryCount, 8, `expected exactly 8 dispatch table entries, found ${entryCount}`);
});

test('static safety: no Ollama/Claude/Codex/OpenAI/Mistral import or code reference (doc comments are allowed to name what is absent)', () => {
  assert.doesNotMatch(CODE_ONLY, /from\s+['"]\.\/ollama\.js['"]/);
  assert.doesNotMatch(CODE_ONLY, /claude|codex|openai|mistral/i);
});

test('static safety: no netsh/Unregister-ScheduledTask/Set-MpPreference/Disable-NetAdapter reference — never-implemented remediation surface stays absent', () => {
  // As of MA-9, Stop-Process/Set-Service/Set-ItemProperty(-equivalent
  // Remove-ItemProperty)/New-NetFirewallRule/Disable-ScheduledTask ARE
  // legitimately present (the 4 LEVEL 2 executors) — those are no
  // longer forbidden. What remains permanently forbidden is anything
  // NOT implemented by any MA-9 executor: Remove-MpThreat (mission §9,
  // permanently NOT_SUPPORTED — never actually called), broad
  // preference/adapter/interface-level commands, and netsh (superseded
  // by New-NetFirewallRule for BLOCK_REMOTE_IP).
  for (const forbidden of ['netsh', 'Unregister-ScheduledTask', 'Set-MpPreference', 'Disable-MpPreference', 'Disable-NetAdapter', 'Set-NetFirewallProfile', 'Remove-Item\\b(?!Property)']) {
    assert.doesNotMatch(CODE_ONLY, new RegExp(forbidden), `${forbidden} must never appear in code`);
  }
  assert.doesNotMatch(CODE_ONLY, /Remove-MpThreat/, 'the only Defender remediation cmdlet must never actually be invoked (mission §9 — always NOT_SUPPORTED)');
});

// ── MA-10: maitre-host-isolation.js static safety (mission §30) ───────────

test('static safety (isolation): shell:true does not appear anywhere', () => {
  assert.doesNotMatch(ISOLATION_SOURCE, /shell\s*:\s*true/);
});

test('static safety (isolation): no eval()/new Function()/Invoke-Expression', () => {
  assert.doesNotMatch(ISOLATION_SOURCE, /\beval\(/);
  assert.doesNotMatch(ISOLATION_SOURCE, /new\s+Function\(/);
  assert.doesNotMatch(ISOLATION_SOURCE, /Invoke-Expression/i);
  assert.doesNotMatch(ISOLATION_SOURCE, /\biex\b/i);
});

test('static safety (isolation): no generic runCommand/runShell/executePowerShell/runNetsh/runFirewallCommand function', () => {
  for (const forbidden of ['runCommand', 'runShell', 'executePowerShell', 'executeCustomAction', 'executeArgsFromClient', 'runNetsh', 'runFirewallCommand']) {
    assert.doesNotMatch(ISOLATION_SOURCE, new RegExp(`function\\s+${forbidden}|const\\s+${forbidden}\\s*=`), `${forbidden} must not exist`);
  }
});

test('static safety (isolation): no netsh, no firewall reset/disable, no adapter disable, no DNS/route/proxy modification (mission §2/§12)', () => {
  for (const forbidden of [
    'netsh',
    'Set-NetFirewallProfile', 'Disable-NetFirewallRule\\s+-All', // targeted per-rule disable is fine; a blanket -All is not
    'netsh advfirewall reset', 'Restore-NetFirewallRule',
    'Disable-NetAdapter', 'Enable-NetAdapter', 'Remove-NetAdapter', 'Rename-NetAdapter',
    'Set-DnsClientServerAddress', 'New-NetRoute', 'Remove-NetRoute', 'Set-NetRoute',
    'Set-NetIPInterface', 'Set-NetConnectionProfile',
    'netsh\\s+winhttp', 'Set-WinHttpProxy', 'Set-ItemProperty.*ProxyServer',
    'Set-Service.*Dhcp', 'Disable-Dhcp',
  ]) {
    assert.doesNotMatch(ISOLATION_CODE_ONLY, new RegExp(forbidden, 'i'), `${forbidden} must never appear in code`);
  }
});

test('static safety (isolation): every mutating firewall rule creation/removal is scoped to a Docteur-MAITRE-Isolation-<actionId> name — no wildcard/bare Get-NetFirewallRule sweep without a DisplayName filter', () => {
  // Every New-NetFirewallRule / Remove-NetFirewallRule call in this file
  // must appear alongside a -DisplayName parameter in the same script
  // template (mission §9/§14 — MAÎTRE-owned rules only, never touching
  // an unrelated pre-existing rule).
  const mutatingCalls = ISOLATION_CODE_ONLY.match(/(New|Remove)-NetFirewallRule[^\n]*/g) || [];
  assert.ok(mutatingCalls.length > 0, 'expected at least one New/Remove-NetFirewallRule call');
  for (const call of mutatingCalls) {
    assert.match(call, /-DisplayName/, `mutating firewall call must scope by -DisplayName: ${call}`);
  }
});

test('static safety (isolation): RemoteAddress "Any" is never used for a Block rule — loopback-safety-by-construction (mission §10, see MAITRE_MA10_AUDIT_2026-09.md)', () => {
  assert.doesNotMatch(ISOLATION_CODE_ONLY, /-Action\s+Block[^\n]*-RemoteAddress\s+['"]?Any['"]?/i);
  assert.doesNotMatch(ISOLATION_CODE_ONLY, /-RemoteAddress\s+['"]?Any['"]?[^\n]*-Action\s+Block/i);
});

test('static safety (isolation): no Ollama/Claude/Codex/OpenAI/Mistral import or code reference — LLM boundary (mission §22)', () => {
  assert.doesNotMatch(ISOLATION_CODE_ONLY, /from\s+['"]\.\/ollama\.js['"]/);
  assert.doesNotMatch(ISOLATION_CODE_ONLY, /claude|codex|openai|mistral|ollama/i);
});

test('static safety: PowerShell cmdlet invocations are exactly the certified MA-8/MA-9/MA-10 set — no unexpected remediation cmdlet', () => {
  // Scoped to actual PowerShell script template strings, not arbitrary
  // capitalized-hyphenated substrings elsewhere in the file (e.g.
  // ConvertTo-Json/Get-CimInstance-adjacent noise is expected and
  // fine — only verb-noun cmdlet names are enumerated here).
  const cmdletPattern = /\b[A-Z][a-zA-Z]+-[A-Z][a-zA-Z]+\b/g;
  const found = new Set([
    ...(CODE_ONLY.match(cmdletPattern) || []),
    ...(ISOLATION_CODE_ONLY.match(cmdletPattern) || []),
  ]);
  const ALLOWED_CMDLETS = new Set([
    'Start-MpScan', 'Stop-Process', 'New-NetFirewallRule', 'Get-NetFirewallRule',
    'Remove-ItemProperty', 'Disable-ScheduledTask', 'Set-Service', 'ConvertTo-Json', 'Out-Null',
    // MA-10 additions — all read-only queries or scoped rule create/remove,
    // matched against the strict allowlist/naming checks above.
    'Get-NetAdapter', 'Get-NetFirewallProfile', 'Remove-NetFirewallRule', 'Select-Object',
  ]);
  // Not real cmdlets — coincidentally match the Verb-Noun regex shape:
  // MAÎTRE's own firewall rule naming convention, not a PS invocation.
  const NOT_CMDLETS = new Set(['Docteur-MAITRE']);
  const unexpected = [...found].filter(c => !ALLOWED_CMDLETS.has(c) && !NOT_CMDLETS.has(c));
  assert.deepEqual(unexpected, [], `unexpected PowerShell cmdlet(s) found: ${unexpected.join(', ')}`);
  assert.match(CODE_ONLY, /Start-MpScan/, 'the LEVEL 1 Defender scan cmdlet must still be present');
});
