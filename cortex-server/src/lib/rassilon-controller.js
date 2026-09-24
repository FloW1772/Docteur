import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { canonicalJobBytes, validateJobSchema } from './rassilon-job-schema.js';
import { createSignedRequestHeaders, isPrivateIpv4 } from './rassilon-lan-auth.js';
import { certificateFingerprint } from './rassilon-lan-auth.js';
import { computeFingerprint, signWithDeviceKey } from './rassilon-identity.js';
import {
  canonicalPairingComplete, canonicalPairingRequest, ensureLocalRassilonDevice, verifyWorkerPairingProof,
} from './rassilon-pairing.js';
import {
  getRassilonOutboundSession, getRassilonSettings, listRassilonDevices, upsertRassilonDevice,
  upsertRassilonOutboundSession, upsertRassilonRemoteJob, updateRassilonDevicePresence,
} from './sqlite.js';
import { selectRassilonWorker } from './rassilon-scheduler.js';
import { verifyRemoteResult } from './rassilon-remote-result.js';

const MAX_RESPONSE_BYTES = 600 * 1024;

export class RassilonControllerError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'RassilonControllerError'; this.code = code; this.detail = detail; }
}

function httpsJsonPinned({ device, method, path, body = null, headers = {}, timeoutMs = 15_000 }) {
  if (!isPrivateIpv4(device.endpointHost)) return Promise.reject(new RassilonControllerError('worker_endpoint_not_private_lan'));
  if (!device.tlsCertificatePem || !device.tlsCertificateFingerprint) return Promise.reject(new RassilonControllerError('worker_tls_pin_missing'));
  const bodyText = body === null ? '' : JSON.stringify(body);
  if (body !== null) headers['content-type'] = 'application/json';
  headers['content-length'] = String(Buffer.byteLength(bodyText));
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: device.endpointHost, port: device.endpointPort, method, path,
      ca: device.tlsCertificatePem, rejectUnauthorized: true, servername: device.endpointHost,
      headers, timeout: timeoutMs,
      checkServerIdentity(host, cert) {
        const normal = tls.checkServerIdentity(host, cert);
        if (normal) return normal;
        const actual = new crypto.X509Certificate(cert.raw).fingerprint256;
        if (actual !== device.tlsCertificateFingerprint) return new Error('rassilon_tls_pin_mismatch');
        return undefined;
      },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new RassilonControllerError('response_too_large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300) reject(new RassilonControllerError(parsed.error ?? 'remote_rejected', { status: response.statusCode }));
          else resolve(parsed);
        } catch (error) { reject(error instanceof RassilonControllerError ? error : new RassilonControllerError('response_invalid')); }
      });
    });
    request.on('timeout', () => request.destroy(new RassilonControllerError('request_timeout')));
    request.on('error', error => reject(error instanceof RassilonControllerError ? error : new RassilonControllerError('connection_failed', error.code ?? error.message)));
    request.end(bodyText);
  });
}

export function requestJsonPinnedTls({ device, sessionId, localDeviceId, method, path, body = null, timeoutMs = 15_000 }) {
  const bodyText = body === null ? '' : JSON.stringify(body);
  const headers = createSignedRequestHeaders({ deviceId: localDeviceId, sessionId, method, path, body: bodyText });
  return httpsJsonPinned({ device, method, path, body, headers, timeoutMs });
}

export function requestPairingJsonPinnedTls({ device, method = 'POST', path, body, timeoutMs = 15_000 }) {
  return httpsJsonPinned({ device, method, path, body, headers: {}, timeoutMs });
}

const outboundPairings = new Map();

export async function requestOutboundRassilonPairing({
  offer, endpointHost, endpointPort, tlsCertificatePem, tlsCertificateFingerprint,
  requestedPermissions, controllerDisplayName = 'Docteur controller', transport = requestPairingJsonPinnedTls,
}) {
  if (!offer?.pairingId || !offer?.code || !offer?.worker?.deviceId || !offer?.workerNonce) throw new RassilonControllerError('pairing_offer_invalid');
  let offeredFingerprint;
  try { offeredFingerprint = computeFingerprint(offer.worker.publicKeyPem); } catch { throw new RassilonControllerError('worker_public_key_invalid'); }
  let actualCertificateFingerprint;
  try { actualCertificateFingerprint = certificateFingerprint(tlsCertificatePem); }
  catch { throw new RassilonControllerError('pairing_pin_mismatch'); }
  if (offeredFingerprint !== offer.worker.fingerprint || actualCertificateFingerprint !== tlsCertificateFingerprint) {
    throw new RassilonControllerError('pairing_pin_mismatch');
  }
  const local = ensureLocalRassilonDevice({ displayName: controllerDisplayName });
  const controllerNonce = crypto.randomBytes(24).toString('base64url');
  const unsigned = {
    pairingId: offer.pairingId, code: offer.code, workerNonce: offer.workerNonce,
    expectedWorkerFingerprint: offer.worker.fingerprint,
    controllerDeviceId: local.deviceId, controllerPublicKeyPem: local.publicKeyPem,
    controllerFingerprint: local.fingerprint, controllerNonce, controllerDisplayName, requestedPermissions,
  };
  const body = { ...unsigned, signature: signWithDeviceKey(local.deviceId, canonicalPairingRequest(unsigned)).toString('base64') };
  const worker = {
    deviceId: offer.worker.deviceId, displayName: offer.worker.displayName, publicKeyPem: offer.worker.publicKeyPem,
    fingerprint: offer.worker.fingerprint, endpointHost, endpointPort, tlsCertificatePem, tlsCertificateFingerprint,
  };
  const response = await transport({ device: worker, path: '/rassilon-lan/pair/request', body });
  const proof = response.pairing;
  const { workerSignature, ...proofMaterial } = proof ?? {};
  if (!proof || proof.workerDeviceId !== worker.deviceId || proof.workerFingerprint !== worker.fingerprint ||
      !verifyWorkerPairingProof(worker.publicKeyPem, 'RASSILON_PAIR_RESPONSE_V1', proofMaterial, workerSignature)) {
    throw new RassilonControllerError('worker_pairing_proof_invalid');
  }
  outboundPairings.set(offer.pairingId, { worker, controllerNonce, localDeviceId: local.deviceId, expiresAt: offer.expiresAt });
  return { pairingId: offer.pairingId, state: proof.state, worker: { deviceId: worker.deviceId, displayName: worker.displayName, fingerprint: worker.fingerprint } };
}

export async function completeOutboundRassilonPairing({ pairingId, transport = requestPairingJsonPinnedTls }) {
  const pending = outboundPairings.get(pairingId);
  if (!pending || Date.parse(pending.expiresAt) <= Date.now()) throw new RassilonControllerError('outbound_pairing_missing_or_expired');
  const unsigned = { pairingId, controllerNonce: pending.controllerNonce };
  const body = { ...unsigned, signature: signWithDeviceKey(pending.localDeviceId, canonicalPairingComplete(unsigned)).toString('base64') };
  const response = await transport({ device: pending.worker, path: '/rassilon-lan/pair/complete', body });
  const session = response.session;
  const { workerSignature, ...sessionMaterial } = session ?? {};
  if (!session || session.workerDeviceId !== pending.worker.deviceId ||
      !verifyWorkerPairingProof(pending.worker.publicKeyPem, 'RASSILON_PAIR_COMPLETE_RESPONSE_V1', sessionMaterial, workerSignature)) {
    throw new RassilonControllerError('worker_completion_proof_invalid');
  }
  upsertRassilonDevice({ ...pending.worker, role: 'WORKER', permissionSet: session.approvedPermissions ?? [], capabilities: {}, status: 'OFFLINE' });
  upsertRassilonOutboundSession({ workerDeviceId: pending.worker.deviceId, sessionId: session.sessionId, expiresAt: session.expiresAt });
  outboundPairings.delete(pairingId);
  return { workerDeviceId: pending.worker.deviceId, sessionId: session.sessionId, expiresAt: session.expiresAt };
}

function effectiveBudget(requested, controllerSettings, workerCapabilities) {
  return {
    cpuPercent: Math.min(requested.cpuPercent, controllerSettings.maxCpuPercent, workerCapabilities.availableCpuBudgetPercent),
    ramMb: Math.min(requested.ramMb, controllerSettings.maxRamMb, workerCapabilities.availableRamBudgetMb),
    maxDurationSec: Math.min(requested.maxDurationSec, controllerSettings.maxJobDurationSec),
  };
}

export async function dispatchRassilonRemoteJob({
  jobType, payload, resourceBudget, policyVersion = 'rassilon-lan-v1', preferredDeviceId = null,
  sessionId, transport = requestJsonPinnedTls, now = Date.now(), devices = listRassilonDevices({ includeRevoked: false }),
} = {}) {
  const local = ensureLocalRassilonDevice();
  const model = jobType === 'EMBEDDING_BATCH' ? payload?.model : null;
  let worker = preferredDeviceId ? devices.find(device => device.deviceId === preferredDeviceId) : null;
  if (worker) worker = selectRassilonWorker({ devices: [worker], jobType, model, resourceBudget, now });
  else worker = selectRassilonWorker({ devices, jobType, model, resourceBudget, now });
  if (!worker) throw new RassilonControllerError('no_eligible_worker');
  sessionId = sessionId ?? getRassilonOutboundSession(worker.deviceId)?.sessionId;
  if (!sessionId) throw new RassilonControllerError('session_required');
  const budget = effectiveBudget(resourceBudget, getRassilonSettings(), worker.capabilities);
  const unsigned = {
    jobId: crypto.randomUUID(), jobType, issuerId: local.deviceId, targetDeviceId: worker.deviceId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString(),
    resourceBudget: budget, payload, policyVersion,
  };
  const job = { ...unsigned, signature: signWithDeviceKey(local.deviceId, canonicalJobBytes(unsigned)).toString('base64') };
  validateJobSchema(job);
  upsertRassilonRemoteJob({ jobId: job.jobId, workerDeviceId: worker.deviceId, controllerDeviceId: local.deviceId, status: 'DISPATCHING' });
  try {
    await transport({ device: worker, sessionId, localDeviceId: local.deviceId, method: 'POST', path: '/rassilon-lan/jobs', body: job });
    upsertRassilonRemoteJob({ jobId: job.jobId, workerDeviceId: worker.deviceId, controllerDeviceId: local.deviceId, status: 'QUEUED' });
    return { job, worker: { deviceId: worker.deviceId, displayName: worker.displayName } };
  } catch (error) {
    upsertRassilonRemoteJob({ jobId: job.jobId, workerDeviceId: worker.deviceId, controllerDeviceId: local.deviceId, status: 'LOST', errorReason: error.code ?? 'dispatch_failed' });
    throw error;
  }
}

export async function pollRassilonRemoteResult({ worker, jobId, sessionId, transport = requestJsonPinnedTls }) {
  const local = ensureLocalRassilonDevice();
  const response = await transport({ device: worker, sessionId, localDeviceId: local.deviceId, method: 'GET', path: `/rassilon-lan/jobs/${encodeURIComponent(jobId)}` });
  if (!verifyRemoteResult(response.result, {
    expectedWorkerId: worker.deviceId, expectedJobId: jobId, publicKeyPem: worker.publicKeyPem,
  })) {
    throw new RassilonControllerError('result_authenticity_invalid');
  }
  upsertRassilonRemoteJob({ jobId, workerDeviceId: worker.deviceId, controllerDeviceId: local.deviceId, status: response.result.status, resultEnvelope: response.result });
  return response.result;
}

export async function refreshRassilonWorkerStatus({ worker, sessionId, transport = requestJsonPinnedTls }) {
  const local = ensureLocalRassilonDevice();
  try {
    const response = await transport({ device: worker, sessionId, localDeviceId: local.deviceId, method: 'GET', path: '/rassilon-lan/status' });
    return updateRassilonDevicePresence(worker.deviceId, { status: 'ONLINE', capabilities: response.capabilities });
  } catch (error) {
    updateRassilonDevicePresence(worker.deviceId, { status: 'OFFLINE', capabilities: worker.capabilities, lastSeenAt: worker.lastSeenAt });
    throw error;
  }
}

export { certificateFingerprint };
