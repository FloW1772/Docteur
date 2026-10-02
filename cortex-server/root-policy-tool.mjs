#!/usr/bin/env node
/**
 * ROOT POLICY V1 — OFFLINE human tool (not importable by the server, not reachable from any HTTP route, LLM, plugin, MCP or remote command).
 *
 *   node root-policy-tool.mjs status                       show state of policy/ + trust anchors
 *   node root-policy-tool.mjs verify                       full verification exactly as the server does at boot
 *   node root-policy-tool.mjs keygen [--out <dir>]         create an Ed25519 signing key, PASSPHRASE-ENCRYPTED (scrypt + AES-256-GCM)
 *   node root-policy-tool.mjs sign [--key <file>] [--policy <json>] [--version <n>] [--yes]
 *                                                          build/validate a policy, bump the version, canonicalise, sign, keep a recovery copy
 *   node root-policy-tool.mjs recover [--yes]              restore the last known-good pair from policy/recovery/ (after verifying it)
 *   node root-policy-tool.mjs acl-status | acl-lock | acl-unlock   Windows ACL hardening of policy/ (icacls; reversible)
 *
 * Passphrase: typed at the prompt (never on the command line). `ROOT_POLICY_PASSPHRASE` is accepted for unattended provisioning only.
 * The public trust anchor lives in src/lib/root-policy/trust-anchors.js (CODE): installing a new key = a reviewed source change by a human.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalize, validatePolicy } from './src/lib/root-policy/schema.js';
import { buildDefaultPolicy } from './src/lib/root-policy/default-policy.js';
import { POLICY_FILE, SIGNATURE_FILE, SIGNATURE_SCHEMA, loadAndVerify, readRollbackState, sha256Hex } from './src/lib/root-policy/loader.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = process.env.ROOT_POLICY_DIR ? path.resolve(process.env.ROOT_POLICY_DIR) : path.join(HERE, 'policy');
const DEFAULT_KEY_DIR = path.join(os.homedir(), '.docteur', 'root-policy');

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);
const say = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(`ERROR: ${msg}`); process.exit(code); };

export const keyIdOf = (publicKeyPem) => crypto.createHash('sha256').update(crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');

async function askHidden(question) {
  if (process.env.ROOT_POLICY_PASSPHRASE) return process.env.ROOT_POLICY_PASSPHRASE;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const originalWrite = rl._writeToOutput;
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl._writeToOutput = originalWrite; rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl._writeToOutput = (s) => { if (s.includes(question)) originalWrite.call(rl, s); };
  });
}

async function confirm(message) {
  if (has('yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${message} Type YES to continue: `, (a) => { rl.close(); resolve(a.trim() === 'YES'); }));
}

// ── key file: scrypt + AES-256-GCM ───────────────────────────────────────────────────────────────────────────────────
export function encryptPrivateKey(pem, passphrase) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  return { schema: 'docteur.root-policy-key/1', kdf: 'scrypt', N: 1 << 15, r: 8, p: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function decryptPrivateKey(blob, passphrase) {
  const key = crypto.scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), 32, { N: blob.N, r: blob.r, p: blob.p, maxmem: 128 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Build, validate, canonicalise and sign. Exported for tests (they call it with a throw-away key and directory). */
export function signPolicy({ policy, privateKeyPem, publicKeyPem, policyDir }) {
  const check = validatePolicy(policy);
  if (!check.ok) throw new Error(`policy refused by the schema: ${check.errors.slice(0, 5).join('; ')}`);
  const canonical = canonicalize(policy);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  const sig = { schema: SIGNATURE_SCHEMA, alg: 'ed25519', keyId: keyIdOf(publicKeyPem), sha256: sha256Hex(Buffer.from(canonical, 'utf8')), version: policy.version, signature };
  fs.mkdirSync(policyDir, { recursive: true });
  // keep the previous good pair for recovery BEFORE replacing it
  const recovery = path.join(policyDir, 'recovery');
  if (fs.existsSync(path.join(policyDir, POLICY_FILE)) && fs.existsSync(path.join(policyDir, SIGNATURE_FILE))) {
    fs.mkdirSync(recovery, { recursive: true });
    fs.copyFileSync(path.join(policyDir, POLICY_FILE), path.join(recovery, POLICY_FILE));
    fs.copyFileSync(path.join(policyDir, SIGNATURE_FILE), path.join(recovery, SIGNATURE_FILE));
  }
  fs.writeFileSync(path.join(policyDir, POLICY_FILE), canonical, 'utf8');
  fs.writeFileSync(path.join(policyDir, SIGNATURE_FILE), JSON.stringify(sig), 'utf8');
  fs.appendFileSync(path.join(policyDir, 'signing-log.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), version: policy.version, sha256: sig.sha256, keyId: sig.keyId })}\n`, 'utf8');
  return { sig, canonical };
}

function currentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(POLICY_DIR, POLICY_FILE), 'utf8')).version ?? 0; } catch { return 0; }
}

const aclTarget = () => POLICY_DIR;
const whoami = () => {
  if (process.platform === 'win32') {
    try {
      return execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), [], { encoding: 'utf8', windowsHide: true }).trim();
    } catch { /* fall through to the portable identity lookup */ }
  }
  try { return os.userInfo().username; } catch {
    return `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME ?? ''}`;
  }
};
const icacls = (...a) => execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), a, { encoding: 'utf8', windowsHide: true });

async function main() {
  if (!command || command === 'help') return say(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?\n?|^ \* ?/gm, ''));

  if (command === 'status' || command === 'verify') {
    const state = readRollbackState(process.env.ROOT_POLICY_DATA_DIR ?? path.join(HERE, 'data', 'root-policy'));
    const result = loadAndVerify({ policyDir: POLICY_DIR, trustAnchors: TRUST_ANCHORS, highestVersionSeen: state.highestVersionSeen });
    say(JSON.stringify({ policyDir: POLICY_DIR, trustAnchors: TRUST_ANCHORS.map(a => a.keyId.slice(0, 16)), highestVersionSeenOnThisMachine: state.highestVersionSeen,
      result: result.ok ? { ok: true, version: result.version, sha256: result.sha256, keyId: result.keyId.slice(0, 16) } : { ok: false, code: result.code, tamper: result.tamper, detail: result.detail } }, null, 2));
    return process.exit(result.ok ? 0 : 2);
  }

  if (command === 'keygen') {
    const outDir = path.resolve(flag('out') ?? DEFAULT_KEY_DIR);
    const file = path.join(outDir, 'signing-key.enc.json');
    if (fs.existsSync(file)) die(`${file} already exists (refusing to overwrite a signing key)`);
    const pass = await askHidden('New passphrase for the signing key: ');
    if (pass.length < 12) die('passphrase must be at least 12 characters');
    if (!process.env.ROOT_POLICY_PASSPHRASE && (await askHidden('Repeat passphrase: ')) !== pass) die('passphrases differ');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const blob = { ...encryptPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }), pass), keyId: keyIdOf(publicPem), publicKeyPem: publicPem };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(blob, null, 1), { encoding: 'utf8', mode: 0o600 });
    say(`Key written: ${file}\nkeyId: ${blob.keyId}\n\nAdd this entry to TRUST_ANCHORS in src/lib/root-policy/trust-anchors.js (source change, reviewed by you):\n`);
    say(`  { keyId: '${blob.keyId}', alg: 'ed25519', publicKeyPem: \`${publicPem.trim()}\` },`);
    return undefined;
  }

  if (command === 'sign') {
    const keyFile = path.resolve(flag('key') ?? path.join(DEFAULT_KEY_DIR, 'signing-key.enc.json'));
    if (!fs.existsSync(keyFile)) die(`signing key not found: ${keyFile} (run keygen first)`);
    const blob = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (!TRUST_ANCHORS.some(a => a.keyId === blob.keyId)) die('this key is not a trust anchor in trust-anchors.js: install its public key first');
    const version = Number(flag('version') ?? currentVersion() + 1);
    const policy = flag('policy') ? JSON.parse(fs.readFileSync(path.resolve(flag('policy')), 'utf8')) : buildDefaultPolicy({ version, issuedAt: new Date().toISOString() });
    policy.version = version;
    say(`About to sign Root Policy version ${version} into ${POLICY_DIR}`);
    if (!(await confirm('This replaces the active policy.'))) die('aborted', 3);
    let privatePem;
    try { privatePem = decryptPrivateKey(blob, await askHidden('Signing key passphrase: ')); } catch { die('wrong passphrase or damaged key file', 4); }
    const { sig } = signPolicy({ policy, privateKeyPem: privatePem, publicKeyPem: blob.publicKeyPem, policyDir: POLICY_DIR });
    say(`Signed. version=${sig.version} sha256=${sig.sha256}`);
    const verify = loadAndVerify({ policyDir: POLICY_DIR, trustAnchors: TRUST_ANCHORS, highestVersionSeen: 0 });
    say(verify.ok ? 'Verification: OK (restart Docteur or wait for the next integrity check).' : `Verification FAILED: ${verify.code}`);
    return process.exit(verify.ok ? 0 : 2);
  }

  if (command === 'recover') {
    const recovery = path.join(POLICY_DIR, 'recovery');
    const check = loadAndVerify({ policyDir: recovery, trustAnchors: TRUST_ANCHORS, highestVersionSeen: 0 });
    if (!check.ok) die(`recovery copy is not valid (${check.code}); sign a fresh policy instead`);
    say(`Recovery copy is valid: version ${check.version}. Note: the machine refuses versions older than the highest it has accepted.`);
    if (!(await confirm('Restore it as the active policy.'))) die('aborted', 3);
    fs.copyFileSync(path.join(recovery, POLICY_FILE), path.join(POLICY_DIR, POLICY_FILE));
    fs.copyFileSync(path.join(recovery, SIGNATURE_FILE), path.join(POLICY_DIR, SIGNATURE_FILE));
    return say('Restored.');
  }

  if (command === 'acl-status') { try { return say(icacls(aclTarget())); } catch (e) { return die(`icacls failed: ${e.message}`); } }
  if (command === 'acl-lock') {
    say(`Removes WRITE for ${whoami()} on ${aclTarget()} (read + execute only). Administrators/SYSTEM keep full control; re-signing needs an elevated terminal.`);
    if (!(await confirm('Apply.'))) die('aborted', 3);
    icacls(aclTarget(), '/inheritance:r', '/grant:r', `${whoami()}:(OI)(CI)RX`, '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', '*S-1-5-32-544:(OI)(CI)F');
    return say('Locked. Undo with: acl-unlock (elevated).');
  }
  if (command === 'acl-unlock') {
    if (!(await confirm(`Restore modify rights for ${whoami()} on ${aclTarget()}.`))) die('aborted', 3);
    icacls(aclTarget(), '/grant:r', `${whoami()}:(OI)(CI)M`);
    return say('Unlocked.');
  }
  return die(`unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
