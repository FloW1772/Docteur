import './test-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isWindows, runReadOnlyPowerShell, buildPowerShellChildEnv, POWERSHELL_DATA_ENV,
} from './src/lib/maitre-windows-exec.js';
import { initSqlite } from './src/lib/sqlite.js';
import { createIncident } from './src/lib/maitre-store.js';
import { createActionProposal, createApprovalRequest, approveProposal } from './src/lib/maitre-approval.js';
import { executeApprovedAction } from './src/lib/maitre-executor.js';
import { queryWindowsEventLog } from './src/lib/maitre-eventlog-adapter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(os.tmpdir(), `docteur-sec12-${process.pid}`);
const MARKER = 'INJECTED_STATEMENT_RAN';
const FIXED_PROBE_SCRIPT = 'Write-Output ([string]$env:DOCTEUR_PS_DATA_FILE_PATH)';

function stripOneTrailingEol(value) {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}

before(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  initSqlite(path.join(TEMP_DIR, 'sec12.db'));
});

after(() => {
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('SEC-12 static inventory: the retired quote helper has no product call site', () => {
  const roots = [path.join(HERE, 'src'), path.join(HERE, '..', 'src'), path.join(HERE, '..', 'scripts')];
  const files = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  roots.forEach(walk);
  const offenders = files.filter(file => {
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
    return code.includes('toPsSingleQuotedLiteral');
  });
  assert.deepEqual(offenders, [], `retired unsafe helper remains in product code: ${offenders.join(', ')}`);
});

test('SEC-12 child environment: reserved names are closed, scrubbed, exact, and parent-only state is unchanged', () => {
  const parent = { Path: 'fixture', DOCTEUR_PS_DATA_FILE_PATH: 'stale', docteur_ps_data_scan_path: 'stale-case' };
  const hostile = "C:\\space Unicode é\\a'‘’‚‛;&|`$(),.exe\r\nsecond line";
  const child = buildPowerShellChildEnv({ FILE_PATH: hostile }, parent);
  assert.deepEqual(parent, { Path: 'fixture', DOCTEUR_PS_DATA_FILE_PATH: 'stale', docteur_ps_data_scan_path: 'stale-case' });
  assert.equal(child[POWERSHELL_DATA_ENV.FILE_PATH], hostile);
  assert.equal(child.docteur_ps_data_scan_path, undefined);
  assert.throws(() => buildPowerShellChildEnv({ ATTACKER_CHOSEN_NAME: hostile }), /unsupported data slot/);
});

test('SEC-12 real PowerShell: ASCII/smart quotes and metacharacters round-trip exactly as data with zero second instruction',
  { skip: !isWindows(), timeout: 30_000 }, async () => {
    const payloads = [
      ...["'", '‘', '’', '‚', '‛'].map(quote => `prefix${quote}; Write-Output '${MARKER}'; ${quote}suffix`),
      "C:\\space Unicode é\\a'‘’‚‛;&|`$(),.exe",
      'line one\r\nline two; & | ` $ ( ) ,',
    ];
    for (const payload of payloads) {
      assert.equal(FIXED_PROBE_SCRIPT.includes(payload), false);
      const result = await runReadOnlyPowerShell(FIXED_PROBE_SCRIPT, { data: { FILE_PATH: payload } });
      assert.equal(result.ok, true);
      assert.equal(stripOneTrailingEol(result.stdout), payload);
      assert.equal((result.stdout.match(new RegExp(MARKER, 'g')) ?? []).length, payload.includes(MARKER) ? 1 : 0);
    }
  });

test('SEC-12 harmless legacy proof: U+2018/U+2019/U+201A/U+201B can terminate the old literal construction',
  { skip: !isWindows(), timeout: 30_000 }, () => {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const legacyLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
    for (const quote of ['‘', '’', '‚', '‛']) {
      const payload = `prefix${quote}; Write-Output '${MARKER}'; ${quote}suffix`;
      const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `Write-Output ${legacyLiteral(payload)}`], {
        encoding: 'utf8', windowsHide: true, timeout: 5_000, shell: false,
      });
      assert.ok(output.split(/\r?\n/).includes(MARKER), `legacy bypass was not reproduced for U+${quote.codePointAt(0).toString(16).toUpperCase()}`);
    }
  });

test('SEC-12 runner errors redact child data values', { skip: !isWindows(), timeout: 10_000 }, async () => {
  const value = "sensitive '‘’‚‛;&|`$() data";
  const result = await runReadOnlyPowerShell(
    "$ErrorActionPreference = 'Continue'; Write-Error ([string]$env:DOCTEUR_PS_DATA_FILE_PATH); exit 7",
    { data: { FILE_PATH: value } },
  );
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(value), false);
});

test('SEC-12 MAÎTRE action chain: READY COLLECT_EVIDENCE keeps the path out of script source and in FILE_PATH data', async () => {
  // Windows forbids | in an actual filename; the real PowerShell round-trip
  // above covers it as synthetic path data. This on-disk fixture uses every
  // requested character that NTFS permits in a filename.
  const filePath = path.join(TEMP_DIR, "proof '‘’‚‛;&`$(), Unicode é.exe");
  fs.writeFileSync(filePath, 'synthetic SEC-12 fixture', 'utf8');
  const incident = createIncident({ title: 'SEC-12 synthetic chain', severity: 'OBSERVATION' });
  const proposal = createActionProposal({
    incidentId: incident.id,
    actionType: 'COLLECT_EVIDENCE',
    target: { evidenceType: 'FILE_METADATA', path: filePath },
  });
  assert.equal(proposal.level, 1);
  assert.equal(proposal.status, 'READY');

  const calls = [];
  const exec = async (script, options = {}) => {
    calls.push({ script, options });
    return { ok: true, stdout: JSON.stringify({ ok: true, status: 2, subject: null, thumbprint: null, timestamp: null }) };
  };
  const run = await executeApprovedAction(proposal.id, { exec, checkPlatform: () => true });
  assert.equal(run.status, 'SUCCEEDED');
  const signatureCall = calls.find(call => call.script.includes('Get-AuthenticodeSignature'));
  assert.ok(signatureCall);
  assert.equal(signatureCall.script.includes(filePath), false);
  assert.deepEqual(signatureCall.options.data, { FILE_PATH: filePath });
  assert.match(signatureCall.script, /-LiteralPath \$filePath/);
});

test('SEC-12 Defender seam: scan path is separate data and never PowerShell source', async () => {
  const filePath = path.join(TEMP_DIR, "scan '‘’‚‛;&`$(), Unicode é.txt");
  fs.writeFileSync(filePath, 'synthetic Defender fixture', 'utf8');
  const incident = createIncident({ title: 'SEC-12 Defender seam', severity: 'SUSPICIOUS' });
  const proposal = createActionProposal({
    incidentId: incident.id, actionType: 'SCAN_WITH_DEFENDER', target: { path: filePath },
  });
  const approval = createApprovalRequest(proposal.id);
  approveProposal(approval.id);
  const calls = [];
  const exec = async (script, options = {}) => {
    calls.push({ script, options });
    return { ok: true, stdout: JSON.stringify({ ok: true, status: 'COMPLETED' }) };
  };
  const run = await executeApprovedAction(proposal.id, { approvalId: approval.id, exec, checkPlatform: () => true });
  assert.equal(run.status, 'SUCCEEDED');
  const scanCall = calls.find(call => call.script.includes('Start-MpScan'));
  assert.ok(scanCall);
  assert.equal(scanCall.script.includes(filePath), false);
  assert.deepEqual(scanCall.options.data, { SCAN_PATH: filePath });
});

test('SEC-12 persistence seam: OS task name/path remain data through disable and verification', async () => {
  const taskName = "Task '‘’‚‛;&|`$(), Unicode é";
  const taskPath = "\\Vendor '‘’‚‛;&|`$(), Unicode é\\";
  const itemId = crypto.createHash('sha256').update(`SCHEDULED_TASK:${taskPath}:${taskName}`).digest('hex').slice(0, 32);
  const incident = createIncident({ title: 'SEC-12 persistence seam', severity: 'SUSPICIOUS' });
  const proposal = createActionProposal({
    incidentId: incident.id, actionType: 'DISABLE_PERSISTENCE_ENTRY',
    target: { persistenceItemId: itemId, persistenceType: 'SCHEDULED_TASK' },
  });
  const approval = createApprovalRequest(proposal.id);
  approveProposal(approval.id);
  let disabled = false;
  let disableCall = null;
  const exec = async (script, options = {}) => {
    if (script.includes('Disable-ScheduledTask')) {
      disableCall = { script, options };
      disabled = true;
      return { ok: true, stdout: JSON.stringify({ ok: true }) };
    }
    if (script.includes('$tasks = Get-ScheduledTask')) {
      const items = disabled ? [] : [{ taskName, taskPath, state: 3, author: 'synthetic', actionExecutable: 'C:\\fixture.exe' }];
      return { ok: true, stdout: JSON.stringify({ ok: true, items }) };
    }
    if (script.includes('Get-ItemProperty')) return { ok: true, stdout: JSON.stringify({ ok: true, entries: [] }) };
    if (script.includes('GetFolderPath')) return { ok: true, stdout: JSON.stringify({ ok: true, items: [] }) };
    if (script.includes('Win32_Service')) return { ok: true, stdout: JSON.stringify({ ok: true, items: [] }) };
    return { ok: false, reason: 'unexpected_script' };
  };
  const run = await executeApprovedAction(proposal.id, { approvalId: approval.id, exec, checkPlatform: () => true });
  assert.equal(run.status, 'SUCCEEDED');
  assert.ok(disableCall);
  assert.equal(disableCall.script.includes(taskName), false);
  assert.equal(disableCall.script.includes(taskPath), false);
  assert.deepEqual(disableCall.options.data, { TASK_PATH: taskPath, TASK_NAME: taskName });
});

test('SEC-12 Event Log seam: allowlisted channel is still transported as data', async () => {
  let captured;
  const exec = async (script, options) => {
    captured = { script, options };
    return { ok: true, stdout: JSON.stringify({ ok: true, events: [] }) };
  };
  const channel = 'Microsoft-Windows-Windows Defender/Operational';
  const result = await queryWindowsEventLog({ channel, exec, checkPlatform: () => true });
  assert.equal(result.available, true);
  assert.equal(captured.script.includes(channel), false);
  assert.deepEqual(captured.options.data, { EVENT_LOG_CHANNEL: channel });
});
