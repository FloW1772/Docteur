/**
 * MAÎTRE — file inspector. READ-ONLY metadata + streaming hash only:
 * never deletes, moves, renames, or writes a file; never reads/stores
 * full file content. Local filesystem only — UNC/network paths and
 * device paths are refused by policy (see isLocalPathAllowed below).
 *
 * hashFile() streams the file through Node's crypto.createHash without
 * ever buffering the whole file in memory — safe for arbitrarily large
 * files (bounded by disk I/O time, not RAM).
 *
 * getFileSignature() uses PowerShell's Get-AuthenticodeSignature via
 * maitre-windows-exec.js's hardened runner. The numeric Status field is
 * used for the verdict (0 = Valid) — never the localized StatusMessage
 * text. A missing/unsigned/invalid signature is reported as an
 * OBSERVATION, never promoted to "malware"/"unsafe".
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isWindows, runReadOnlyPowerShell, toPsSingleQuotedLiteral } from './maitre-windows-exec.js';

const MAX_HASH_FILE_BYTES = 500 * 1024 * 1024; // 500 MB — refuse to stream-hash beyond this in MA-4 (bounded work, not a hard system limit)
const HASH_TIMEOUT_MS = 30_000;

/**
 * Local-filesystem-only path policy: rejects UNC paths (\\server\share),
 * device paths (\\.\ or \\?\), and any path Node resolves outside the
 * expected local-drive shape. Does NOT resolve symlinks itself (that's
 * hashFile's/fs.stat's job) — this is a syntactic pre-check only.
 */
export function isLocalPathAllowed(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) return false;
  if (inputPath.startsWith('\\\\')) return false; // UNC (\\server\share) or device (\\.\, \\?\) path
  if (/^[a-zA-Z]:\\/.test(inputPath) || /^[a-zA-Z]:\//.test(inputPath)) return true; // C:\... or C:/...
  if (path.isAbsolute(inputPath) && !inputPath.includes('\\\\')) return true; // posix-style absolute, for non-Windows dev/test
  return false;
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseMsDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\/Date\((\d+)\)\/$/);
  if (!match) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Streaming SHA-256 — bounded memory regardless of file size. Handles
 * missing file / permission denied / oversized file as controlled
 * results, never an unhandled rejection.
 */
export async function hashFile(filePath, { maxBytes = MAX_HASH_FILE_BYTES } = {}) {
  if (!isLocalPathAllowed(filePath)) {
    return { available: false, reason: 'path_not_allowed' };
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { available: false, reason: 'file_not_found' };
    if (err.code === 'EACCES' || err.code === 'EPERM') return { available: false, reason: 'permission_denied' };
    return { available: false, reason: 'stat_failed', detail: err.code };
  }

  if (!stat.isFile()) {
    return { available: false, reason: 'not_a_regular_file' };
  }
  if (stat.size > maxBytes) {
    return { available: false, reason: 'file_too_large', sizeBytes: stat.size };
  }

  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const timer = setTimeout(() => {
      stream.destroy(new Error('hash_timeout'));
    }, HASH_TIMEOUT_MS);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => finish({ available: true, sha256: hash.digest('hex'), sizeBytes: stat.size }));
    stream.on('error', (err) => {
      if (err.message === 'hash_timeout') return finish({ available: false, reason: 'timeout' });
      // A file changing/disappearing mid-read (rename, delete, truncate
      // by another process) surfaces here as a controlled result, not
      // a crash — expected on a live system, not exceptional.
      if (err.code === 'ENOENT') return finish({ available: false, reason: 'file_changed_during_hash' });
      finish({ available: false, reason: 'read_error', detail: err.code || err.message });
    });
  });
}

/**
 * Basic filesystem metadata — never reads file content. exists/size/
 * timestamps/extension only.
 */
export async function getFileMetadata(filePath) {
  if (!isLocalPathAllowed(filePath)) {
    return { available: false, reason: 'path_not_allowed', path: filePath };
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { available: false, reason: 'file_not_found', path: filePath, exists: false };
    if (err.code === 'EACCES' || err.code === 'EPERM') return { available: false, reason: 'permission_denied', path: filePath };
    return { available: false, reason: 'stat_failed', path: filePath, detail: err.code };
  }

  const ext = path.extname(filePath).toLowerCase();
  const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.scr', '.com', '.msi', '.bat', '.cmd', '.ps1']);

  return {
    available: true,
    path: filePath,
    exists: true,
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    sizeBytes: stat.size,
    createdAt: stat.birthtime ? stat.birthtime.toISOString() : null,
    modifiedAt: stat.mtime ? stat.mtime.toISOString() : null,
    extension: ext,
    isExecutable: EXECUTABLE_EXTENSIONS.has(ext),
  };
}

/**
 * Authenticode signature via a fixed PowerShell script. Never declares
 * SIGNED = SAFE or UNSIGNED = MALWARE — returns only the observation.
 * Windows-only: NOT_SUPPORTED elsewhere.
 */
export async function getFileSignature(filePath, { exec = runReadOnlyPowerShell, checkPlatform = isWindows } = {}) {
  if (!isLocalPathAllowed(filePath)) {
    return { available: false, reason: 'path_not_allowed' };
  }
  if (!checkPlatform()) {
    return { available: false, reason: 'NOT_SUPPORTED' };
  }

  const pathLiteral = toPsSingleQuotedLiteral(filePath);
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $sig = Get-AuthenticodeSignature -FilePath ${pathLiteral}
  $out = @{
    ok = $true
    status = [int]$sig.Status
    subject = $sig.SignerCertificate.Subject
    thumbprint = $sig.SignerCertificate.Thumbprint
    timestamp = $sig.TimeStamperCertificate.NotBefore
  }
  $out | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

  const result = await exec(script);
  if (!result.ok) {
    return { available: false, reason: result.reason };
  }

  const envelope = parseJsonEnvelope(result.stdout);
  if (!envelope) return { available: false, reason: 'malformed_output' };
  if (!envelope.ok) return { available: false, reason: envelope.errorId || 'signature_check_failed' };

  // Get-AuthenticodeSignature's Status enum: 0=Valid, 1=UnknownError,
  // 2=NotSigned, 3=HashMismatch, 4=NotTrusted, 5=NotSupportedFileFormat,
  // 6=Incompatible. Only the numeric value is used — never the
  // localized StatusMessage string.
  const STATUS_MAP = { 0: 'Valid', 1: 'UnknownError', 2: 'NotSigned', 3: 'HashMismatch', 4: 'NotTrusted', 5: 'NotSupportedFileFormat', 6: 'Incompatible' };

  return {
    available: true,
    signed: envelope.status === 0,
    status: STATUS_MAP[envelope.status] ?? 'Unknown',
    subject: envelope.subject ?? null,
    thumbprint: envelope.thumbprint ?? null,
    timestamp: parseMsDate(envelope.timestamp),
  };
}

/**
 * Combines metadata + hash + signature into one inspection result —
 * the shape maitre-evidence.js's createEvidence() FILE_METADATA/
 * FILE_HASH types expect. Never reads/stores file content.
 */
export async function inspectFile(filePath, opts = {}) {
  const metadata = await getFileMetadata(filePath);
  if (!metadata.available) {
    return { available: false, reason: metadata.reason, path: filePath };
  }

  const [hashResult, signatureResult] = await Promise.all([
    metadata.type === 'file' ? hashFile(filePath, opts) : Promise.resolve({ available: false, reason: 'not_a_file' }),
    metadata.isExecutable ? getFileSignature(filePath, opts) : Promise.resolve({ available: false, reason: 'not_executable' }),
  ]);

  return {
    available: true,
    ...metadata,
    sha256: hashResult.available ? hashResult.sha256 : null,
    hashUnavailableReason: hashResult.available ? null : hashResult.reason,
    signature: signatureResult.available ? signatureResult : null,
  };
}

/**
 * Pure conversion: an inspected file becomes a SecurityEvent INPUT (not
 * persisted/incident-created here). Severity is always OBSERVATION —
 * an unsigned file or an unknown hash is never itself evidence of
 * anything (mission §11/§22: "hash inconnu ≠ malware", "signature
 * absente ≠ compromise"); only MA-5's correlation engine may eventually
 * raise a stronger severity from corroborating signals.
 */
export function fileObservationToSecurityEvent(inspected) {
  return {
    source: 'integrity-monitor',
    category: 'file-inspection',
    severity: 'OBSERVATION',
    confidence: 'low',
    occurredAt: new Date().toISOString(),
    subject: { path: inspected.path, extension: inspected.extension, isExecutable: inspected.isExecutable },
    metadata: {
      sha256: inspected.sha256,
      sizeBytes: inspected.sizeBytes,
      signed: inspected.signature?.signed ?? null,
      signatureStatus: inspected.signature?.status ?? null,
    },
    detectorId: 'maitre-file-inspector',
  };
}
