// Secure secret storage for cloud API keys.
//
// Windows DPAPI (CryptProtectData / System.Security.Cryptography.ProtectedData)
// encrypts each secret so it can only be decrypted by the same Windows user
// account on the same machine — no key ever touches disk in plaintext.
//
// We shell out to PowerShell rather than adding a native npm dependency:
// ProtectedData ships with .NET/Windows, so this needs zero extra install
// and avoids native-module build fragility (unlike e.g. keytar).
//
// Ciphertext is stored (base64) in the existing SQLite metadata table —
// only the encrypted blob lives there, never the raw key.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setMeta, getMeta } from './sqlite.js';

const ENTROPY = 'Docteur.Cortex.CloudApiKeys.v1'; // additional entropy, not a secret

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runPowerShell(script) {
  const result = spawnSync(POWERSHELL_EXE, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });

  if (result.error) throw new Error(`DPAPI: échec de lancement PowerShell: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`DPAPI: PowerShell a échoué (code ${result.status}): ${(result.stderr || '').slice(0, 300)}`);
  }
  return result.stdout.trim();
}

// Passes the plaintext via stdin-less base64 arg to avoid it ever appearing
// in a process listing/command-line (visible to other users/tools via `tasklist`/`ps`).
function protect(plaintext) {
  const plainB64 = Buffer.from(plaintext, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${plainB64}')
$entropy = [System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
`;
  return runPowerShell(script);
}

function unprotect(cipherB64) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${cipherB64}')
$entropy = [System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
`;
  const plainB64 = runPowerShell(script);
  return Buffer.from(plainB64, 'base64').toString('utf8');
}

const SECRET_META_PREFIX = 'secret_dpapi:';

// In-process plaintext cache — avoids spawning PowerShell on every call
// (getCloudKeys() is read on the hot path for nearly every AI request).
// Cleared whenever a secret is written so stale values are never served.
const decryptedCache = new Map();

// Tracks providers whose stored blob exists but failed to decrypt (corrupted,
// or written by a different Windows user/machine) — distinct from "never
// configured". In-memory only, per process; cleared the moment a successful
// decrypt or a fresh setSecret()/deleteSecret() happens for that provider,
// so it never outlives the condition that caused it. Never holds anything
// beyond the provider id — no ciphertext, no plaintext, no error detail.
const decryptFailed = new Set();

// One-time migration: if legacy plaintext keys exist under `cloud_api_keys`,
// re-encrypt them here and blank the plaintext copy. Idempotent.
let migrated = false;
function migrateLegacyPlaintextKeys() {
  if (migrated) return;
  migrated = true;
  const legacy = getMeta('cloud_api_keys', null);
  if (!legacy) return;

  let changed = false;
  for (const [field, value] of Object.entries(legacy)) {
    if (!value) continue;
    const provider = field.replace(/_key$/, '');
    if (!getMeta(`${SECRET_META_PREFIX}${provider}`, null)) {
      setSecret(provider, value);
    }
    legacy[field] = null;
    changed = true;
  }
  if (changed) setMeta('cloud_api_keys', legacy);
}

export function setSecret(provider, plaintext) {
  decryptedCache.delete(provider);
  decryptFailed.delete(provider);
  if (!plaintext) {
    setMeta(`${SECRET_META_PREFIX}${provider}`, null);
    return;
  }
  const ciphertext = protect(plaintext);
  setMeta(`${SECRET_META_PREFIX}${provider}`, { ciphertext });
  decryptedCache.set(provider, plaintext);
}

export function getSecret(provider) {
  migrateLegacyPlaintextKeys();
  if (decryptedCache.has(provider)) return decryptedCache.get(provider);

  const entry = getMeta(`${SECRET_META_PREFIX}${provider}`, null);
  if (!entry?.ciphertext) {
    decryptedCache.set(provider, null);
    decryptFailed.delete(provider);
    return null;
  }
  try {
    const plaintext = unprotect(entry.ciphertext);
    decryptedCache.set(provider, plaintext);
    decryptFailed.delete(provider);
    return plaintext;
  } catch {
    // Ciphertext unreadable (different user/machine, corrupted) — the blob
    // is NOT deleted (the user may just need to restart under the right
    // Windows account, or this may be diagnosed later); getSecret() keeps
    // its existing null-on-failure contract for backward compatibility, but
    // records the distinction so getSecretStatus() can report it precisely.
    decryptFailed.add(provider);
    return null;
  }
}

// 'absent'  — no blob stored at all (never configured)
// 'valid'   — blob stored and decrypts successfully
// 'invalid' — blob stored but failed to decrypt (corrupted / wrong user-machine)
export function getSecretStatus(provider) {
  const entry = getMeta(`${SECRET_META_PREFIX}${provider}`, null);
  if (!entry?.ciphertext) return 'absent';
  // Force a decrypt attempt (cheap if cached) so a blob that has never been
  // read this process still gets classified correctly rather than
  // defaulting to 'valid' just because no failure was recorded yet.
  getSecret(provider);
  return decryptFailed.has(provider) ? 'invalid' : 'valid';
}

export function hasSecret(provider) {
  migrateLegacyPlaintextKeys();
  return !!getMeta(`${SECRET_META_PREFIX}${provider}`, null)?.ciphertext;
}

export function deleteSecret(provider) {
  decryptedCache.delete(provider);
  decryptFailed.delete(provider);
  setMeta(`${SECRET_META_PREFIX}${provider}`, null);
}
