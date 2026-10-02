// ROOT POLICY V1 — storage, integrity, tamper detection, fail-closed, recovery, audit chain, offline tool.
// Run: node --test test-root-policy-integrity.mjs
//
// Everything runs on throw-away directories with a THROW-AWAY key pair: the real policy/ directory and the real signing key are never touched.
import './test-setup.mjs';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDefaultPolicy } from './src/lib/root-policy/default-policy.js';
import { canonicalize, validatePolicy } from './src/lib/root-policy/schema.js';
import { POLICY_FILE, SIGNATURE_FILE, loadAndVerify, sha256Hex } from './src/lib/root-policy/loader.js';
import { createAudit, verifyAuditChain } from './src/lib/root-policy/audit.js';
import { DECISION } from './src/lib/root-policy/engine.js';
import { __testing, decide, enforce, getRootPolicyStatus, initRootPolicy } from './src/lib/root-policy/index.js';
import { TRUST_ANCHORS } from './src/lib/root-policy/trust-anchors.js';
import { decryptPrivateKey, encryptPrivateKey, keyIdOf, signPolicy } from './root-policy-tool.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docteur-rootpolicy-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const keyPair = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
const KEY = keyPair();
const OTHER = keyPair();
const ANCHORS = [{ keyId: keyIdOf(KEY.publicPem), alg: 'ed25519', publicKeyPem: KEY.publicPem }];
let n = 0;
const freshDir = () => path.join(scratch, `p${++n}`);
function install({ version = 1, mutate, key = KEY } = {}) {
  const dir = freshDir();
  const policy = buildDefaultPolicy({ version, issuedAt: '2026-10-01T00:00:00.000Z' });
  mutate?.(policy);
  signPolicy({ policy, privateKeyPem: key.privatePem, publicKeyPem: key.publicPem, policyDir: dir });
  return dir;
}
const load = (dir, extra = {}) => loadAndVerify({ policyDir: dir, trustAnchors: ANCHORS, highestVersionSeen: 0, ...extra });
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const write = (dir, f, text) => fs.writeFileSync(path.join(dir, f), text, 'utf8');

describe('format, version, integrity, signature — VALID path', () => {
  test('a freshly signed policy loads: canonical file, sha256, Ed25519, version', () => {
    const dir = install({ version: 3 });
    const r = load(dir);
    assert.equal(r.ok, true); assert.equal(r.version, 3); assert.equal(r.sha256, sha256Hex(Buffer.from(read(dir, POLICY_FILE))));
    assert.equal(read(dir, POLICY_FILE), canonicalize(JSON.parse(read(dir, POLICY_FILE))), 'the file IS the canonical form');
  });

  test('canonical JSON is deterministic: key order and whitespace of the SOURCE never change the signed bytes', () => {
    const a = buildDefaultPolicy({ version: 1, issuedAt: '2026-10-01T00:00:00.000Z' });
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())));
    assert.equal(canonicalize(a), canonicalize(reordered));
    assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    assert.throws(() => canonicalize({ x: Infinity }));
  });

  test('the REAL shipped policy verifies against the real trust anchor (the one Docteur boots with)', () => {
    const r = loadAndVerify({ policyDir: path.join(HERE, 'policy'), trustAnchors: TRUST_ANCHORS, highestVersionSeen: 0 });
    assert.equal(r.ok, true, `${r.code ?? ''} ${r.detail ?? ''}`);
    assert.equal(r.version >= 1, true);
  });
});

describe('TAMPER DETECTION — each alteration is detected and named', () => {
  const cases = {
    'one byte flipped': (dir) => { const t = read(dir, POLICY_FILE); const i = t.indexOf('"version":1') + 11; write(dir, POLICY_FILE, `${t.slice(0, i - 1)}2${t.slice(i)}`); },
    'one character changed in a value': (dir) => write(dir, POLICY_FILE, read(dir, POLICY_FILE).replace('"impact":"LOW"', '"impact":"MEDIUM"')),
    'file truncated': (dir) => write(dir, POLICY_FILE, read(dir, POLICY_FILE).slice(0, 400)),
    'file emptied': (dir) => write(dir, POLICY_FILE, ''),
    'invalid JSON': (dir) => write(dir, POLICY_FILE, '{not json'),
    'whitespace added (re-formatted)': (dir) => write(dir, POLICY_FILE, `${JSON.stringify(JSON.parse(read(dir, POLICY_FILE)), null, 2)}\n`),
    'trailing newline': (dir) => write(dir, POLICY_FILE, `${read(dir, POLICY_FILE)}\n`),
    'UTF-8 BOM': (dir) => write(dir, POLICY_FILE, `﻿${read(dir, POLICY_FILE)}`),
    'keys re-ordered': (dir) => write(dir, POLICY_FILE, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(read(dir, POLICY_FILE))).reverse()))),
    'duplicate key injected': (dir) => write(dir, POLICY_FILE, read(dir, POLICY_FILE).replace('{"actions":', '{"version":999,"actions":')),
    'signature byte flipped': (dir) => { const s = JSON.parse(read(dir, SIGNATURE_FILE)); s.signature = `${s.signature.slice(0, 10)}${s.signature[10] === 'A' ? 'B' : 'A'}${s.signature.slice(11)}`; write(dir, SIGNATURE_FILE, JSON.stringify(s)); },
    'hash replaced': (dir) => { const s = JSON.parse(read(dir, SIGNATURE_FILE)); s.sha256 = '0'.repeat(64); write(dir, SIGNATURE_FILE, JSON.stringify(s)); },
    'signature file garbage': (dir) => write(dir, SIGNATURE_FILE, 'garbage'),
    'signature file with extra field': (dir) => { const s = JSON.parse(read(dir, SIGNATURE_FILE)); s.extra = 1; write(dir, SIGNATURE_FILE, JSON.stringify(s)); },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    test(name, () => {
      const dir = install();
      assert.equal(load(dir).ok, true);
      tamper(dir);
      const r = load(dir);
      assert.equal(r.ok, false, name);
      assert.equal(r.tamper, true, `${name}: ${r.code} must be flagged as tampering`);
    });
  }

  test('policy re-signed by a key that is NOT a trust anchor ⇒ TRUST_ANCHOR_UNKNOWN (an attacker cannot self-sign a permissive policy)', () => {
    const dir = install({ key: OTHER });
    const r = load(dir);
    assert.deepEqual([r.ok, r.code, r.tamper], [false, 'TRUST_ANCHOR_UNKNOWN', true]);
  });

  test('signature made with the right key id but another private key ⇒ SIGNATURE_INVALID', () => {
    const dir = install();
    const s = JSON.parse(read(dir, SIGNATURE_FILE));
    s.signature = crypto.sign(null, Buffer.from(read(dir, POLICY_FILE)), crypto.createPrivateKey(OTHER.privatePem)).toString('base64');
    write(dir, SIGNATURE_FILE, JSON.stringify(s));
    assert.equal(load(dir).code, 'SIGNATURE_INVALID');
  });

  test('a VALIDLY SIGNED but over-permissive policy is still refused (ceilings are code, not data)', () => {
    const permissive = {
      'grants PLUGIN.INSTALL to a module': (p) => { p.capabilities['PLUGIN.INSTALL'].grantable = true; p.modules.media.capabilities.push('PLUGIN.INSTALL'); },
      'lets an AI actor update the policy': (p) => { p.actions.POLICY_UPDATE.enabled = true; p.actions.POLICY_UPDATE.actors = ['AI_CLOUD']; },
      'enables arbitrary shell': (p) => { p.actions.SHELL_ARBITRARY.enabled = true; p.actions.SHELL_ARBITRARY.actors = ['USER']; },
      'adds an AI actor to a high-impact action': (p) => { p.actions.DEVICE_ADMIN.actors.push('AI_CLOUD'); },
      'lowers the impact of DEVICE_ADMIN': (p) => { p.actions.DEVICE_ADMIN.impact = 'LOW'; },
      'un-protects a protected action': (p) => { p.actions.AI_CLOUD_REQUEST.protected = false; },
      'turns an invariant off': (p) => { p.invariants.noSecretLeak = false; },
      'drops an invariant': (p) => { delete p.invariants.stopAndRevocationWin; },
      'adds an unknown action': (p) => { p.actions.DO_ANYTHING = { impact: 'LOW', protected: false, actors: ['USER'], enabled: true }; },
      'grants an unknown capability': (p) => { p.modules.media.capabilities.push('EVERYTHING.ALL'); },
      'gives a module a domain it does not need and a boundary that covers POLICY_UPDATE': (p) => { p.approvalBoundaries['omega-certified'].covers.push('POLICY_UPDATE'); },
      'declares an unknown field': (p) => { p.backdoor = true; },
      'unknown schema id': (p) => { p.schema = 'docteur.root-policy/99'; },
    };
    for (const [name, mutate] of Object.entries(permissive)) {
      const policy = buildDefaultPolicy({ version: 1, issuedAt: '2026-10-01T00:00:00.000Z' }); mutate(policy);
      assert.equal(validatePolicy(policy).ok, false, `schema must refuse: ${name}`);
      // Forge the file WITHOUT the tool's validation (an attacker who somehow got the signing key): the loader still refuses it.
      const dir = freshDir(); fs.mkdirSync(dir, { recursive: true });
      const canonical = canonicalize(policy);
      write(dir, POLICY_FILE, canonical);
      write(dir, SIGNATURE_FILE, JSON.stringify({ schema: 'docteur.root-policy-signature/1', alg: 'ed25519', keyId: ANCHORS[0].keyId, sha256: sha256Hex(Buffer.from(canonical)), version: policy.version, signature: crypto.sign(null, Buffer.from(canonical), crypto.createPrivateKey(KEY.privatePem)).toString('base64') }));
      const r = load(dir);
      assert.deepEqual([r.ok, r.code], [false, 'POLICY_SCHEMA_INVALID'], name);
    }
    assert.throws(() => signPolicy({ policy: (() => { const p = buildDefaultPolicy(); p.actions.POLICY_UPDATE.enabled = true; return p; })(), privateKeyPem: KEY.privatePem, publicKeyPem: KEY.publicPem, policyDir: freshDir() }), /refused by the schema/, 'the tool refuses to sign it too');
  });

  test('versions: old version refused (anti-rollback), signature / document version mismatch refused, floor enforced', () => {
    const dir = install({ version: 2 });
    assert.equal(load(dir, { highestVersionSeen: 5 }).code, 'ROLLBACK_DETECTED');
    assert.equal(load(dir, { highestVersionSeen: 2 }).ok, true);
    const s = JSON.parse(read(dir, SIGNATURE_FILE)); s.version = 9; write(dir, SIGNATURE_FILE, JSON.stringify(s));
    assert.equal(load(dir).code, 'VERSION_MISMATCH');
    for (const bad of [0, -1, 1.5, '2', null]) {
      const p = buildDefaultPolicy(); p.version = bad;
      assert.equal(validatePolicy(p).ok, false, String(bad));
    }
  });

  test('replacing the policy with an OLDER but genuinely signed copy is a rollback (policy downgrade attack)', () => {
    const v1 = install({ version: 1 }); const v2 = install({ version: 2 });
    const dir = freshDir(); fs.cpSync(v2, dir, { recursive: true });
    assert.equal(load(dir, { highestVersionSeen: 2 }).ok, true);
    fs.copyFileSync(path.join(v1, POLICY_FILE), path.join(dir, POLICY_FILE)); fs.copyFileSync(path.join(v1, SIGNATURE_FILE), path.join(dir, SIGNATURE_FILE));
    assert.equal(load(dir, { highestVersionSeen: 2 }).code, 'ROLLBACK_DETECTED');
  });

  test('missing policy / missing signature / unreadable ⇒ named errors (not "tamper" when merely absent)', () => {
    const dir = install(); fs.rmSync(path.join(dir, SIGNATURE_FILE));
    assert.deepEqual([load(dir).code, load(dir).tamper], ['SIGNATURE_MISSING', false]);
    fs.rmSync(path.join(dir, POLICY_FILE));
    assert.deepEqual([load(dir).code, load(dir).tamper], ['POLICY_MISSING', false]);
    assert.equal(load(path.join(scratch, 'does-not-exist')).code, 'POLICY_MISSING');
    const asDir = freshDir(); fs.mkdirSync(path.join(asDir, POLICY_FILE), { recursive: true }); write(asDir, SIGNATURE_FILE, '{}');
    assert.equal(load(asDir).code, 'POLICY_UNREADABLE');
    const big = freshDir(); fs.mkdirSync(big, { recursive: true }); write(big, POLICY_FILE, 'x'.repeat(300 * 1024)); write(big, SIGNATURE_FILE, '{}');
    assert.equal(load(big).code, 'POLICY_TOO_LARGE');
  });
});

describe('RUNTIME — boot, live tamper, fail-closed, recovery, status', () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const protectedCall = () => decide({ action: 'AI_CLOUD_REQUEST', module: 'ai', trustDomain: 'AI', actor: { kind: 'MODULE' }, context: { cloudEnabled: true } });
  const harmless = () => decide({ action: 'AI_LOCAL_REQUEST', module: 'ai', trustDomain: 'AI', actor: { kind: 'USER' } });
  const stop = () => decide({ action: 'DEVICE_STOP', module: 'omega', trustDomain: 'OMEGA', actor: { kind: 'USER' } });

  test('VALID boot ⇒ status VERIFIED / LOCAL / AI modification FORBIDDEN, protected operations enabled', () => {
    const dir = install(); const data = freshDir();
    const status = initRootPolicy({ policyDir: dir, dataDir: data, trustAnchors: ANCHORS });
    assert.deepEqual([status.state, status.version, status.integrity, status.source, status.aiModification, status.protectedOperations], ['VALID', 1, 'VERIFIED', 'LOCAL', 'FORBIDDEN', 'ENABLED']);
    assert.equal(protectedCall().decision, DECISION.ALLOW);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).highestVersionSeen, 1);
    assert.ok(fs.existsSync(path.join(data, 'audit.jsonl')), 'POLICY_LOADED audited');
  });

  test('CORRUPTED policy at boot ⇒ INVALID + tamper flag; protected DENY, harmless allowed, STOP allowed, app still answers status', () => {
    const dir = install(); write(dir, POLICY_FILE, read(dir, POLICY_FILE).replace('"LOW"', '"HIGH"'));
    const status = initRootPolicy({ policyDir: dir, dataDir: freshDir(), trustAnchors: ANCHORS });
    assert.deepEqual([status.state, status.integrity, status.tamperDetected, status.protectedOperations], ['INVALID', 'FAILED', true, 'FAIL_CLOSED']);
    assert.equal(status.errorCode.length > 0, true);
    assert.deepEqual([protectedCall().decision, protectedCall().code], [DECISION.DENY, 'DENY_POLICY_INVALID']);
    assert.equal(harmless().decision, DECISION.NOT_APPLICABLE);
    assert.equal(stop().code, 'ALLOW_STOP_ALWAYS');
    assert.equal(getRootPolicyStatus().state, 'INVALID');
  });

  test('MISSING policy at boot ⇒ INVALID (POLICY_MISSING, not tampering) and protected operations fail closed', () => {
    const status = initRootPolicy({ policyDir: path.join(scratch, 'nothing-here'), dataDir: freshDir(), trustAnchors: ANCHORS });
    assert.deepEqual([status.state, status.errorCode, status.tamperDetected], ['INVALID', 'POLICY_MISSING', false]);
    assert.equal(protectedCall().code, 'DENY_POLICY_INVALID');
  });

  test('policy replaced by a permissive one signed with a foreign key ⇒ INVALID, never accepted', () => {
    const dir = install({ key: OTHER });
    const status = initRootPolicy({ policyDir: dir, dataDir: freshDir(), trustAnchors: ANCHORS });
    assert.deepEqual([status.state, status.errorCode, status.tamperDetected], ['INVALID', 'TRUST_ANCHOR_UNKNOWN', true]);
  });

  test('LIVE tamper while Docteur runs: the next protected decision (≤ ~1 s) detects it and fails closed; restoring the signed pair recovers', async () => {
    const dir = install(); const data = freshDir();
    initRootPolicy({ policyDir: dir, dataDir: data, trustAnchors: ANCHORS });
    assert.equal(protectedCall().decision, DECISION.ALLOW);
    const good = { p: read(dir, POLICY_FILE), s: read(dir, SIGNATURE_FILE) };
    write(dir, POLICY_FILE, good.p.replace('"HIGH"', '"LOW "'));          // an "AI tool" or a rogue process edits the file
    await sleep(1150);
    assert.deepEqual([protectedCall().decision, protectedCall().code], [DECISION.DENY, 'DENY_POLICY_INVALID']);
    assert.throws(() => enforce({ action: 'AI_CLOUD_REQUEST', module: 'ai', trustDomain: 'AI', actor: { kind: 'MODULE' }, context: { cloudEnabled: true } }), (e) => e.rootPolicyDenied === true && e.decisionCode === 'DENY_POLICY_INVALID');
    assert.equal(getRootPolicyStatus().tamperDetected, true);
    write(dir, POLICY_FILE, good.p); write(dir, SIGNATURE_FILE, good.s);   // owner restores the signed pair
    await sleep(2150);
    assert.equal(protectedCall().decision, DECISION.ALLOW, 'recovers by itself once the signed pair is back');
    assert.equal(getRootPolicyStatus().state, 'VALID');
    const events = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).event);
    assert.ok(events.includes('POLICY_TAMPER_DETECTED') && events.includes('POLICY_LOADED') && events.includes('ACTION_DENIED'), events.join());
    assert.deepEqual(verifyAuditChain(path.join(data, 'audit.jsonl')).ok, true);
  });

  test('a NEW genuinely signed, higher-version policy is picked up live; an OLDER signed one is refused as a rollback', async () => {
    const dir = install({ version: 2 }); const data = freshDir();
    initRootPolicy({ policyDir: dir, dataDir: data, trustAnchors: ANCHORS });
    const older = install({ version: 1 });
    fs.copyFileSync(path.join(older, POLICY_FILE), path.join(dir, POLICY_FILE)); fs.copyFileSync(path.join(older, SIGNATURE_FILE), path.join(dir, SIGNATURE_FILE));
    await sleep(1150);
    assert.equal(protectedCall().code, 'DENY_POLICY_INVALID'); assert.equal(getRootPolicyStatus().errorCode, 'ROLLBACK_DETECTED');
    const newer = install({ version: 3 });
    fs.copyFileSync(path.join(newer, POLICY_FILE), path.join(dir, POLICY_FILE)); fs.copyFileSync(path.join(newer, SIGNATURE_FILE), path.join(dir, SIGNATURE_FILE));
    await sleep(2150);
    assert.equal(protectedCall().decision, DECISION.ALLOW); assert.equal(getRootPolicyStatus().version, 3);
  });

  test('no read-write path to the policy exists at runtime: initRootPolicy never writes the policy directory', () => {
    const dir = install(); const before = fs.readdirSync(dir).sort().map(f => [f, fs.statSync(path.join(dir, f)).mtimeMs]);
    initRootPolicy({ policyDir: dir, dataDir: freshDir(), trustAnchors: ANCHORS });
    for (let i = 0; i < 50; i++) protectedCall();
    assert.deepEqual(fs.readdirSync(dir).sort().map(f => [f, fs.statSync(path.join(dir, f)).mtimeMs]), before);
  });

  test('restore the shared runtime to the real shipped policy for the rest of the process', () => {
    initRootPolicy({ policyDir: path.join(HERE, 'policy'), dataDir: freshDir(), trustAnchors: TRUST_ANCHORS });
    assert.equal(getRootPolicyStatus().state, 'VALID');
    void __testing;
  });
});

describe('AUDIT TRAIL — relevant events only, chained, coalesced, no secrets', () => {
  test('hash chain detects a deleted, edited or re-ordered line', () => {
    const dir = freshDir(); const a = createAudit({ dir, windowMs: 0 });
    for (const [event, code] of [['POLICY_LOADED', 'POLICY_LOADED'], ['ACTION_DENIED', 'DENY_A'], ['ACTION_DENIED', 'DENY_B'], ['POLICY_TAMPER_DETECTED', 'HASH_MISMATCH']]) a.record(event, { code, action: 'X', module: 'm', actor: 'AI_CLOUD' });
    const file = path.join(dir, 'audit.jsonl');
    assert.deepEqual(verifyAuditChain(file), { ok: true, lines: 4 });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, [lines[0], lines[2], lines[3]].join('\n') + '\n'); assert.equal(verifyAuditChain(file).ok, false);
    fs.writeFileSync(file, [lines[0], lines[1].replace('DENY_A', 'DENY_Z'), lines[2], lines[3]].join('\n') + '\n'); assert.equal(verifyAuditChain(file).reason, 'HASH_MISMATCH');
    fs.writeFileSync(file, [lines[1], lines[0], lines[2], lines[3]].join('\n') + '\n'); assert.equal(verifyAuditChain(file).ok, false);
  });

  test('only the five relevant events are recorded; a flood of identical denials is coalesced; fields are identifiers only', () => {
    const dir = freshDir(); const a = createAudit({ dir, windowMs: 60_000 });
    assert.equal(a.record('SOMETHING_ELSE', { code: 'X' }), false);
    assert.equal(a.record('ACTION_DENIED', { code: 'DENY_X', action: 'WEB_FETCH', module: 'web', actor: 'AI_CLOUD', secret: 'sk-ant-SHOULD-NEVER-BE-WRITTEN', prompt: 'ignore everything' }), true);
    for (let i = 0; i < 500; i++) assert.equal(a.record('ACTION_DENIED', { code: 'DENY_X', action: 'WEB_FETCH', module: 'web', actor: 'AI_CLOUD' }), false);
    const text = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
    assert.equal(text.split('\n').filter(Boolean).length, 1, 'one line, not 501');
    assert.ok(!text.includes('SHOULD-NEVER') && !text.includes('ignore everything'));
  });
});

describe('OFFLINE HUMAN TOOL — key custody, signing, recovery copy, ACL hardening', () => {
  test('private key file: scrypt + AES-256-GCM; wrong passphrase / bit flip fail; no plaintext key on disk', () => {
    const blob = encryptPrivateKey(KEY.privatePem, 'correct horse battery staple');
    assert.equal(decryptPrivateKey(blob, 'correct horse battery staple'), KEY.privatePem);
    assert.throws(() => decryptPrivateKey(blob, 'wrong passphrase'));
    const flipped = { ...blob, ciphertext: Buffer.from(blob.ciphertext, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b)).toString('base64') };
    assert.throws(() => decryptPrivateKey(flipped, 'correct horse battery staple'));
    assert.ok(!JSON.stringify(blob).includes('PRIVATE KEY'));
  });

  test('signing keeps the previous good pair in recovery/, and the recovery copy verifies', () => {
    const dir = install({ version: 1 });
    signPolicy({ policy: buildDefaultPolicy({ version: 2, issuedAt: '2026-10-02T00:00:00.000Z' }), privateKeyPem: KEY.privatePem, publicKeyPem: KEY.publicPem, policyDir: dir });
    assert.equal(load(dir).version, 2);
    assert.equal(load(path.join(dir, 'recovery')).version, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'signing-log.jsonl'), 'utf8').trim().split('\n').length, 2);
  });

  test('CLI: verify exits 0 on a valid directory and 2 with the error code on a tampered / missing one (no server involved)', () => {
    const tool = path.join(HERE, 'root-policy-tool.mjs');
    const run = (dir) => spawnSync(process.execPath, [tool, 'verify'], { env: { ...process.env, ROOT_POLICY_DIR: dir, ROOT_POLICY_DATA_DIR: freshDir() }, encoding: 'utf8', windowsHide: true });
    // The CLI uses the REAL trust anchors, so a directory signed with the throw-away key must be refused — proves anchors are code, not config.
    const foreign = run(install());
    assert.equal(foreign.status, 2); assert.match(foreign.stdout, /TRUST_ANCHOR_UNKNOWN/);
    const missing = run(path.join(scratch, 'none'));
    assert.equal(missing.status, 2); assert.match(missing.stdout, /POLICY_MISSING/);
    const real = run(path.join(HERE, 'policy'));
    assert.equal(real.status, 0, real.stdout + real.stderr);
  });

  test('CLI refuses to sign with a key that is not a trust anchor, and never accepts the passphrase on the command line', () => {
    const tool = path.join(HERE, 'root-policy-tool.mjs');
    const keyDir = freshDir(); fs.mkdirSync(keyDir, { recursive: true });
    const blob = { ...encryptPrivateKey(KEY.privatePem, 'a long enough passphrase'), keyId: keyIdOf(KEY.publicPem), publicKeyPem: KEY.publicPem };
    fs.writeFileSync(path.join(keyDir, 'k.json'), JSON.stringify(blob));
    const r = spawnSync(process.execPath, [tool, 'sign', '--key', path.join(keyDir, 'k.json'), '--yes'], { env: { ...process.env, ROOT_POLICY_DIR: freshDir(), ROOT_POLICY_PASSPHRASE: 'a long enough passphrase' }, encoding: 'utf8', windowsHide: true });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not a trust anchor/);
    assert.ok(!fs.readFileSync(tool, 'utf8').includes("flag('passphrase')"), 'there is no --passphrase option');
  });

  test('Windows ACL hardening is reversible: acl-lock removes WRITE for the current user on the policy directory, acl-unlock restores it', (t) => {
    if (process.platform !== 'win32') return t.skip('Windows only');
    const tool = path.join(HERE, 'root-policy-tool.mjs');
    const dir = install(); const env = { ...process.env, ROOT_POLICY_DIR: dir };
    const run = (cmd) => spawnSync(process.execPath, [tool, cmd, '--yes'], { env, encoding: 'utf8', windowsHide: true });
    try {
      const lock = run('acl-lock');
      if (lock.status !== 0) return t.skip(`icacls unavailable here: ${lock.stderr.slice(0, 120)}`);
      assert.throws(() => fs.writeFileSync(path.join(dir, POLICY_FILE), 'tamper'), /EPERM|EACCES/, 'the current user (and therefore Docteur and every tool it runs) can no longer write the policy');
      assert.throws(() => fs.writeFileSync(path.join(dir, 'new-file'), 'x'), /EPERM|EACCES/);
      assert.equal(load(dir).ok, true, 'but can still read and verify it');
    } finally {
      run('acl-unlock');
    }
    fs.writeFileSync(path.join(dir, 'probe'), 'ok');
    assert.equal(fs.readFileSync(path.join(dir, 'probe'), 'utf8'), 'ok');
  });
});
