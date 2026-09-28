import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeFingerprint } from './omega-outbound-protocol.js';

const execFileAsync = promisify(execFile);
const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_VIEW_RESPONSE_BYTES = 8 * 1024 * 1024;

export function isPrivateIpv4(host) {
  if (net.isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isLoopbackIpv4(host) { return host === '127.0.0.1'; }

export async function getWindowsNetworkCategory(host) {
  if (process.platform !== 'win32') return 'Unknown';
  if (net.isIP(host) !== 4) return 'Unknown';
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const safeIp = host.split('.').map(Number).join('.');
  const script = `$r=Find-NetRoute -RemoteIPAddress '${safeIp}' | Select-Object -First 1; if(-not $r){'Unknown'; exit}; $p=Get-NetConnectionProfile -InterfaceIndex $r.InterfaceIndex | Select-Object -First 1 -ExpandProperty NetworkCategory; if($p){$p}else{'Unknown'}`;
  try {
    const { stdout } = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 4_000, maxBuffer: 8 * 1024,
    });
    const category = String(stdout).trim().split(/\r?\n/).at(-1);
    return ['Private', 'Public', 'DomainAuthenticated'].includes(category) ? category : 'Unknown';
  } catch { return 'Unknown'; }
}

export async function assertOmegaPrivateDestination(host, { allowLoopback = false, profileProbe = getWindowsNetworkCategory } = {}) {
  if (allowLoopback && isLoopbackIpv4(host)) return;
  if (!isPrivateIpv4(host)) throw Object.assign(new Error('NETWORK_UNAVAILABLE'), { code: 'NETWORK_UNAVAILABLE' });
  const category = await profileProbe(host);
  if (category !== 'Private') throw Object.assign(new Error('NETWORK_PROFILE_NOT_PRIVATE'), { code: 'NETWORK_UNAVAILABLE' });
}

function normalizeAddress(value) { return String(value ?? '').replace(/^::ffff:/, ''); }

export function tlsJsonRequest({ host, port, certificatePem, expectedFingerprint, method = 'POST', requestPath, body,
  timeoutMs = 10_000, maxResponseBytes = MAX_RESPONSE_BYTES, onRequest, onTls } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    let settled = false;
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request({
      host, port, method, path: requestPath, agent: false,
      rejectUnauthorized: true, ca: certificatePem,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length, accept: 'application/json' },
      checkServerIdentity: (name, cert) => {
        const standardError = tls.checkServerIdentity(host, cert);
        if (standardError) return standardError;
        if (normalizeFingerprint(cert.fingerprint256) !== normalizeFingerprint(expectedFingerprint)) {
          return Object.assign(new Error('TLS_IDENTITY_MISMATCH'), { code: 'TLS_IDENTITY_MISMATCH' });
        }
        return undefined;
      },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          request.destroy(Object.assign(new Error('response_too_large'), { code: 'RESPONSE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          settled = true;
          resolve({ status: response.statusCode ?? 0, body: payload });
        } catch {
          const error = Object.assign(new Error('invalid_json_response'), { code: 'INVALID_RESPONSE', statusCode: response.statusCode ?? 0 });
          finishReject(error);
        }
      });
    });
    onRequest?.(request);
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('request_timeout'), { code: 'NETWORK_UNAVAILABLE' })));
    request.on('socket', socket => {
      socket.once('secureConnect', () => {
        if (normalizeAddress(socket.remoteAddress) !== host) {
          request.destroy(Object.assign(new Error('wrong_peer_address'), { code: 'TLS_IDENTITY_MISMATCH' }));
          return;
        }
        onTls?.();
      });
    });
    request.on('error', error => finishReject(error));
    request.end(bytes);
  });
}

/** Same strict TLS/pin/address policy as tlsJsonRequest, with one bounded binary response. */
export function tlsBinaryRequest({ host, port, certificatePem, expectedFingerprint, method = 'POST', requestPath, body,
  timeoutMs = 10_000, maxResponseBytes = MAX_VIEW_RESPONSE_BYTES, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    let settled = false;
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request({
      host, port, method, path: requestPath, agent: false,
      rejectUnauthorized: true, ca: certificatePem,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length, accept: 'image/png, application/json' },
      checkServerIdentity: (_name, cert) => {
        const standardError = tls.checkServerIdentity(host, cert);
        if (standardError) return standardError;
        if (normalizeFingerprint(cert.fingerprint256) !== normalizeFingerprint(expectedFingerprint)) {
          return Object.assign(new Error('TLS_IDENTITY_MISMATCH'), { code: 'TLS_IDENTITY_MISMATCH' });
        }
        return undefined;
      },
    }, response => {
      const declared = Number(response.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        request.destroy(Object.assign(new Error('response_too_large'), { code: 'FRAME_TOO_LARGE' }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          request.destroy(Object.assign(new Error('response_too_large'), { code: 'FRAME_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    onRequest?.(request);
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('request_timeout'), { code: 'NETWORK_UNAVAILABLE' })));
    request.on('socket', socket => {
      socket.once('secureConnect', () => {
        if (normalizeAddress(socket.remoteAddress) !== host) {
          request.destroy(Object.assign(new Error('wrong_peer_address'), { code: 'TLS_IDENTITY_MISMATCH' }));
        }
      });
    });
    request.on('error', finishReject);
    request.end(bytes);
  });
}
