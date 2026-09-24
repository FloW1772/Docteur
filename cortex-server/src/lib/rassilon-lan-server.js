import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { serve } from '@hono/node-server';
import { createRassilonLanRoute } from '../routes/rassilon-lan.js';
import { certificateFingerprint, isLoopbackAddress, isPrivateIpv4 } from './rassilon-lan-auth.js';
import { getRassilonLanSettings, getRassilonSettings, setRassilonLanSettings } from './sqlite.js';
import { recordAuditEvent } from './rassilon-audit.js';
import { registerRassilonLanStopHook } from './rassilon-lan-runtime.js';

let lanServer = null;
let stopPromise = null;
let runtime = { state: 'DISABLED', error: null, bindAddress: null, port: null, certificateFingerprint: null };
let defaults = { providers: {}, tlsKeyPath: null, tlsCertPath: null, logger: null, allowLoopbackForTests: false };

export class RassilonLanServerError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'RassilonLanServerError'; this.code = code; this.detail = detail; }
}

function validateTls(keyPath, certPath) {
  if (!keyPath || !certPath || !fs.existsSync(keyPath) || !fs.existsSync(certPath)) throw new RassilonLanServerError('tls_material_missing');
  let key;
  let cert;
  let x509;
  try {
    key = fs.readFileSync(keyPath);
    cert = fs.readFileSync(certPath);
    crypto.createPrivateKey(key);
    x509 = new crypto.X509Certificate(cert);
    const now = Date.now();
    if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) <= now) throw new Error('certificate outside validity window');
    const fromPrivate = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
    const fromCertificate = x509.publicKey.export({ type: 'spki', format: 'der' });
    if (!fromPrivate.equals(fromCertificate)) throw new Error('certificate/private key mismatch');
  } catch (error) { throw new RassilonLanServerError('tls_material_invalid', error.message); }
  return { key, cert, fingerprint: certificateFingerprint(cert) };
}

export function configureRassilonLanServer(options = {}) {
  defaults = { ...defaults, ...options };
  registerRassilonLanStopHook(() => { void stopRassilonLanServer({ persist: true, audit: true }); return true; });
}

export function getRassilonLanRuntimeStatus() { return { ...runtime }; }

export async function startRassilonLanServer({
  bindAddress, port = 3443, networkProfile = 'Unknown', allowUnknownNetworkProfile = false,
  tlsKeyPath = defaults.tlsKeyPath, tlsCertPath = defaults.tlsCertPath,
} = {}) {
  if (lanServer) throw new RassilonLanServerError('lan_already_started');
  if (!isPrivateIpv4(bindAddress) && !(defaults.allowLoopbackForTests && isLoopbackAddress(bindAddress))) {
    throw new RassilonLanServerError('private_ipv4_bind_required');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RassilonLanServerError('lan_port_invalid');
  if (networkProfile !== 'Private' && !allowUnknownNetworkProfile) throw new RassilonLanServerError('private_network_profile_required');
  const tls = validateTls(tlsKeyPath, tlsCertPath);
  const app = createRassilonLanRoute({ providers: defaults.providers, allowLoopbackForTests: defaults.allowLoopbackForTests });
  runtime = { state: 'STARTING', error: null, bindAddress, port, certificateFingerprint: tls.fingerprint };

  await new Promise((resolve, reject) => {
    let settled = false;
    const server = serve({
      fetch: app.fetch, hostname: bindAddress, port,
      createServer: (_, handler) => https.createServer({
        key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', handshakeTimeout: 10_000,
      }, handler),
    }, () => {
      settled = true;
      lanServer = server;
      server.requestTimeout = 30_000;
      server.headersTimeout = 15_000;
      server.keepAliveTimeout = 5_000;
      resolve();
    });
    server.once('error', error => {
      runtime = { state: 'ERROR', error: error.code ?? error.message, bindAddress, port, certificateFingerprint: tls.fingerprint };
      if (!settled) reject(new RassilonLanServerError('lan_bind_failed', error.code ?? error.message));
    });
  });

  setRassilonLanSettings({ enabled: true, bindAddress, port });
  runtime = { state: 'LISTENING', error: null, bindAddress, port, certificateFingerprint: tls.fingerprint };
  recordAuditEvent({ eventType: 'LAN_ENABLED', resultSummary: { bindAddress, port, tls: true } });
  defaults.logger?.info?.({ bindAddress, port }, 'RASSILON LAN TLS listener started');
  return getRassilonLanRuntimeStatus();
}

export async function stopRassilonLanServer({ persist = true, audit = true } = {}) {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    const server = lanServer;
    lanServer = null;
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (persist) setRassilonLanSettings({ enabled: false, bindAddress: runtime.bindAddress, port: runtime.port ?? 3443 });
    runtime = { state: 'DISABLED', error: null, bindAddress: null, port: null, certificateFingerprint: null };
    if (audit) recordAuditEvent({ eventType: 'LAN_DISABLED' });
    return getRassilonLanRuntimeStatus();
  })();
  try { return await stopPromise; }
  finally { stopPromise = null; }
}

export async function restoreRassilonLanServer() {
  const stored = getRassilonLanSettings();
  if (!stored.enabled) return getRassilonLanRuntimeStatus();
  if (!getRassilonSettings().enabled) {
    setRassilonLanSettings({ enabled: false, bindAddress: stored.bindAddress, port: stored.port });
    runtime = {
      state: 'DISABLED', error: 'worker_disabled', bindAddress: null, port: null, certificateFingerprint: null,
    };
    defaults.logger?.warn?.('RASSILON LAN restore skipped because the local worker is disabled');
    return getRassilonLanRuntimeStatus();
  }
  try {
    return await startRassilonLanServer({
      bindAddress: stored.bindAddress, port: stored.port, networkProfile: 'Unknown', allowUnknownNetworkProfile: true,
    });
  } catch (error) {
    runtime = { state: 'ERROR', error: error.code ?? 'lan_restore_failed', bindAddress: stored.bindAddress, port: stored.port, certificateFingerprint: null };
    defaults.logger?.error?.({ error: runtime.error }, 'RASSILON LAN startup refused; no HTTP fallback');
    return getRassilonLanRuntimeStatus();
  }
}
