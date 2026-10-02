// ROOT POLICY V1 — isolated REAL-server boot proof (three states).
//   node root-policy-boot-proof.mjs
//
// Boots the real cortex-server three times on throw-away SQLite / LanceDB / log (never the real data), loopback only:
//   VALID      real signed policy         ⇒ status VERIFIED; certified routes reach their modules (no ROOT_POLICY_DENIED); media egress up
//   CORRUPTED  real policy with 1 byte changed ⇒ app still starts and answers, status INVALID + tamperDetected; protected device route 503;
//              STOP route NOT refused by the gate; unrelated /api/health still answers
//   MISSING    empty policy directory   ⇒ same fail-closed behaviour, error POLICY_MISSING (not tamper)
// plus: the policy API is read-only (no mutating verb is routed), the audit chain of every boot verifies, nothing is written next to the policy.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAuditChain } from './src/lib/root-policy/audit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(here, 'policy');
const summary = { scenarios: {}, status: 'PASS' };

async function boot(name, policyDir, port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `docteur-rp-boot-${name}-`));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: here,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOCAL_NETWORK: 'false', SQLITE_PATH: path.join(tmp, 'cortex.sqlite'), LANCEDB_PATH: path.join(tmp, 'cortex.lance'), LOG_FILE: path.join(tmp, 'server.log'), DOCTEUR_ROOT_POLICY_DIR: policyDir },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const deadline = Date.now() + 60_000;
  while (!output.includes('cortex server started')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${name}: server did not start\n${output.slice(-1200)}`);
    await new Promise(r => setTimeout(r, 200));
  }
  return { child, tmp, base: `http://127.0.0.1:${port}`, output: () => output };
}
const json = async (res) => res.json().catch(() => ({}));

async function scenario(name, policyDir, port, expect) {
  const s = await boot(name, policyDir, port);
  const out = { started: true };
  try {
    const status = await json(await fetch(`${s.base}/api/root-policy/status`)); out.status = status;
    const view = await json(await fetch(`${s.base}/api/root-policy/policy`)); out.viewHasPolicy = view.policy !== null; out.readOnly = view.readOnly === true;
    out.health = (await fetch(`${s.base}/api/health`)).status;
    const admin = await fetch(`${s.base}/api/omega/admin/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const adminBody = await json(admin); out.deviceAdmin = { http: admin.status, rootPolicyDenied: adminBody.error === 'ROOT_POLICY_DENIED', code: adminBody.code ?? null };
    const stop = await fetch(`${s.base}/api/omega/outbound/stop-all`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    out.stopAll = { http: stop.status, rootPolicyDenied: (await json(stop)).error === 'ROOT_POLICY_DENIED' };
    const jobs = await fetch(`${s.base}/api/rassilon/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    out.rassilonJob = { http: jobs.status, rootPolicyDenied: (await json(jobs)).error === 'ROOT_POLICY_DENIED' };
    const verbs = {};
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) verbs[method] = (await fetch(`${s.base}/api/root-policy/policy`, { method, headers: { 'content-type': 'application/json' }, body: '{}' })).status;
    out.mutatingVerbs = verbs;
    if (!expect(out)) throw new Error(`${name}: unexpected behaviour ${JSON.stringify(out)}`);
  } finally {
    // On Windows, SIGINT may propagate through the console process group and
    // terminate this proof before it can print its terminal summary.
    s.child.kill();
    await new Promise(r => { s.child.once('exit', r); setTimeout(() => { s.child.kill(); r(); }, 12_000); });
    const audit = path.join(s.tmp, 'root-policy', 'audit.jsonl');
    out.auditChain = fs.existsSync(audit) ? verifyAuditChain(audit) : { ok: false, reason: 'NO_AUDIT_FILE' };
    out.auditEvents = fs.existsSync(audit) ? [...new Set(fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).event))] : [];
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
  summary.scenarios[name] = out;
  return out;
}

const realBefore = fs.readdirSync(REAL).map(f => [f, fs.statSync(path.join(REAL, f)).mtimeMs]);
const corrupted = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-rp-corrupt-'));
fs.cpSync(REAL, corrupted, { recursive: true });
fs.writeFileSync(path.join(corrupted, 'root-policy.json'), fs.readFileSync(path.join(corrupted, 'root-policy.json'), 'utf8').replace('"LOW"', '"HIGH"'));
const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-rp-missing-'));

try {
  await scenario('VALID', REAL, 33131, o => o.status.state === 'VALID' && o.status.integrity === 'VERIFIED' && o.status.aiModification === 'FORBIDDEN' && o.viewHasPolicy
    && !o.deviceAdmin.rootPolicyDenied && !o.stopAll.rootPolicyDenied && !o.rassilonJob.rootPolicyDenied && o.health > 0);
  await scenario('CORRUPTED', corrupted, 33132, o => o.status.state === 'INVALID' && o.status.tamperDetected === true && o.status.protectedOperations === 'FAIL_CLOSED' && !o.viewHasPolicy
    && o.deviceAdmin.http === 503 && o.deviceAdmin.code === 'DENY_POLICY_INVALID' && o.rassilonJob.http === 503 && !o.stopAll.rootPolicyDenied && o.health > 0);
  await scenario('MISSING', missing, 33133, o => o.status.state === 'INVALID' && o.status.errorCode === 'POLICY_MISSING' && o.status.tamperDetected === false
    && o.deviceAdmin.http === 503 && !o.stopAll.rootPolicyDenied && o.health > 0);
  for (const [name, o] of Object.entries(summary.scenarios)) {
    if (!o.auditChain.ok) throw new Error(`${name}: audit chain invalid ${JSON.stringify(o.auditChain)}`);
    if (Object.values(o.mutatingVerbs).some(code => code < 400)) throw new Error(`${name}: a mutating verb was accepted on the policy API ${JSON.stringify(o.mutatingVerbs)}`);
  }
  const realAfter = fs.readdirSync(REAL).map(f => [f, fs.statSync(path.join(REAL, f)).mtimeMs]);
  if (JSON.stringify(realBefore) !== JSON.stringify(realAfter)) throw new Error('the real policy directory was modified during the proof');
  summary.realPolicyUntouched = true;
} catch (error) {
  summary.status = 'FAIL'; summary.error = String(error.message ?? error).slice(0, 1500);
} finally {
  fs.rmSync(corrupted, { recursive: true, force: true }); fs.rmSync(missing, { recursive: true, force: true });
}
console.log(JSON.stringify(summary, null, 1));
process.exitCode = summary.status === 'PASS' ? 0 : 1;
