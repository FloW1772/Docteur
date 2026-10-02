/**
 * ROOT POLICY V1 — load + verify (format, canonical form, hash, Ed25519 signature, version / anti-rollback).
 *
 *   LOAD → VERIFY FORMAT → VERIFY VERSION → VERIFY INTEGRITY → VERIFY SIGNATURE/HASH → READY
 *
 * Read-only toward the policy files: this module (and the whole running server) never writes the policy or its signature. The only thing
 * the server writes is a tiny monotonic "highest version seen" state file (anti-rollback detection, not a trust anchor).
 *
 * Every failure returns a stable code; failures that mean "the files were altered" are flagged `tamper:true`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MIN_POLICY_VERSION, canonicalize, validatePolicy } from './schema.js';

export const POLICY_FILE = 'root-policy.json';
export const SIGNATURE_FILE = 'root-policy.sig.json';
export const SIGNATURE_SCHEMA = 'docteur.root-policy-signature/1';
const MAX_POLICY_BYTES = 256 * 1024;

export const LOAD_ERRORS = Object.freeze({
  POLICY_MISSING: { tamper: false },
  POLICY_UNREADABLE: { tamper: false },
  POLICY_TOO_LARGE: { tamper: true },
  POLICY_JSON_INVALID: { tamper: true },       // includes truncated files
  POLICY_NOT_CANONICAL: { tamper: true },      // reordered / duplicated keys / reformatted / BOM
  POLICY_SCHEMA_INVALID: { tamper: true },     // incl. a validly-signed but over-permissive document
  SIGNATURE_MISSING: { tamper: false },
  SIGNATURE_UNREADABLE: { tamper: true },
  SIGNATURE_INVALID: { tamper: true },
  SIGNATURE_FORMAT_INVALID: { tamper: true },
  HASH_MISMATCH: { tamper: true },
  VERSION_MISMATCH: { tamper: true },
  TRUST_ANCHOR_UNKNOWN: { tamper: true },
  ROLLBACK_DETECTED: { tamper: true },
  VERSION_TOO_OLD: { tamper: true },
});

const fail = (code, detail) => ({ ok: false, code, tamper: LOAD_ERRORS[code]?.tamper === true, detail });

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readBounded(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { error: 'POLICY_UNREADABLE' };
    if (stat.size > MAX_POLICY_BYTES) return { error: 'POLICY_TOO_LARGE' };
    return { buf: fs.readFileSync(file), stat };
  } catch (error) {
    return { error: error?.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE' };
  }
}

export function readRollbackState(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    return Number.isInteger(state?.highestVersionSeen) ? state : { highestVersionSeen: 0 };
  } catch { return { highestVersionSeen: 0 }; }
}

export function writeRollbackState(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = path.join(dataDir, `state.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, path.join(dataDir, 'state.json'));
    return true;
  } catch { return false; }
}

/**
 * @param {{ policyDir:string, trustAnchors:Array<{keyId:string, publicKeyPem:string}>, highestVersionSeen?:number }} options
 * @returns {{ ok:true, policy:object, canonical:string, sha256:string, version:number, keyId:string, files:object }
 *         | { ok:false, code:string, tamper:boolean, detail?:string }}
 */
export function loadAndVerify({ policyDir, trustAnchors, highestVersionSeen = 0 }) {
  const policyPath = path.join(policyDir, POLICY_FILE);
  const sigPath = path.join(policyDir, SIGNATURE_FILE);

  const policyFile = readBounded(policyPath);
  if (policyFile.error === 'MISSING') return fail('POLICY_MISSING');
  if (policyFile.error) return fail(policyFile.error === 'UNREADABLE' ? 'POLICY_UNREADABLE' : policyFile.error);
  const sigFile = readBounded(sigPath);
  if (sigFile.error === 'MISSING') return fail('SIGNATURE_MISSING');
  if (sigFile.error) return fail('SIGNATURE_UNREADABLE');

  // 1. FORMAT — strict JSON, and the file must be byte-identical to the canonical form of what it parses to.
  const text = policyFile.buf.toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return fail('POLICY_JSON_INVALID'); }
  let canonical;
  try { canonical = canonicalize(parsed); } catch { return fail('POLICY_JSON_INVALID'); }
  if (canonical !== text) return fail('POLICY_NOT_CANONICAL');

  // 2. SIGNATURE FILE FORMAT
  let sig;
  try { sig = JSON.parse(sigFile.buf.toString('utf8')); } catch { return fail('SIGNATURE_FORMAT_INVALID'); }
  const sigKeys = ['schema', 'alg', 'keyId', 'sha256', 'version', 'signature'];
  if (!sig || typeof sig !== 'object' || Array.isArray(sig) || Object.keys(sig).some(k => !sigKeys.includes(k)) || sigKeys.some(k => !(k in sig))
    || sig.schema !== SIGNATURE_SCHEMA || sig.alg !== 'ed25519' || typeof sig.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(String(sig.sha256))
    || !Number.isInteger(sig.version) || typeof sig.signature !== 'string') return fail('SIGNATURE_FORMAT_INVALID');

  // 3. INTEGRITY — hash of the canonical bytes
  const canonicalBuf = Buffer.from(canonical, 'utf8');
  if (sha256Hex(canonicalBuf) !== sig.sha256) return fail('HASH_MISMATCH');

  // 4. SIGNATURE — Ed25519 over the canonical bytes with an embedded trust anchor
  const anchor = trustAnchors.find(a => a.keyId === sig.keyId);
  if (!anchor) return fail('TRUST_ANCHOR_UNKNOWN');
  let verified = false;
  try { verified = crypto.verify(null, canonicalBuf, crypto.createPublicKey(anchor.publicKeyPem), Buffer.from(sig.signature, 'base64')); } catch { verified = false; }
  if (!verified) return fail('SIGNATURE_INVALID');

  // 5. SCHEMA + CEILINGS (a correctly signed but over-permissive document is refused)
  const schema = validatePolicy(parsed);
  if (!schema.ok) return fail('POLICY_SCHEMA_INVALID', schema.errors.slice(0, 5).join('; '));

  // 6. VERSION — signature and document agree; not below the release floor; not older than what this machine already accepted
  if (parsed.version !== sig.version) return fail('VERSION_MISMATCH');
  if (parsed.version < MIN_POLICY_VERSION) return fail('VERSION_TOO_OLD');
  if (parsed.version < highestVersionSeen) return fail('ROLLBACK_DETECTED', `highest seen ${highestVersionSeen}`);

  return {
    ok: true, policy: parsed, canonical, sha256: sig.sha256, version: parsed.version, keyId: sig.keyId,
    files: { policyMtimeMs: policyFile.stat.mtimeMs, policySize: policyFile.stat.size, sigMtimeMs: sigFile.stat.mtimeMs, sigSize: sigFile.stat.size },
  };
}

/** Cheap change detector used on the hot path (two stat calls, rate-limited by the caller). */
export function filesChanged(policyDir, files) {
  try {
    const p = fs.statSync(path.join(policyDir, POLICY_FILE));
    const s = fs.statSync(path.join(policyDir, SIGNATURE_FILE));
    return p.mtimeMs !== files.policyMtimeMs || p.size !== files.policySize || s.mtimeMs !== files.sigMtimeMs || s.size !== files.sigSize;
  } catch { return true; }
}
