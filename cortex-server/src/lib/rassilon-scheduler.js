import { requiredPermissionForJob } from './rassilon-lan-auth.js';

export const ONLINE_AFTER_MS = 30_000;
export const STALE_AFTER_MS = 90_000;

export function deriveDevicePresence(device, now = Date.now()) {
  if (device.revokedAt || device.status === 'REVOKED') return 'REVOKED';
  if (device.status === 'OFFLINE') return 'OFFLINE';
  const seen = Date.parse(device.lastSeenAt);
  if (!Number.isFinite(seen) || now - seen > STALE_AFTER_MS) return 'OFFLINE';
  if (now - seen > ONLINE_AFTER_MS) return 'STALE';
  return 'ONLINE';
}

export function selectRassilonWorker({ devices, jobType, model = null, resourceBudget, now = Date.now() }) {
  const permission = requiredPermissionForJob(jobType);
  if (!permission) return null;
  const candidates = (devices ?? []).filter(device => {
    if (device.role !== 'WORKER' || deriveDevicePresence(device, now) !== 'ONLINE') return false;
    if (!device.permissionSet?.includes(permission)) return false;
    const cap = device.capabilities ?? {};
    if (!cap.safeExecutorTypes?.includes(jobType)) return false;
    if (jobType === 'EMBEDDING_BATCH' && (!model || !cap.availableLocalModelIds?.includes(model))) return false;
    if ((cap.availableCpuBudgetPercent ?? 0) < resourceBudget.cpuPercent) return false;
    if ((cap.availableRamBudgetMb ?? 0) < resourceBudget.ramMb) return false;
    return Number.isFinite(cap.queueDepth);
  });
  candidates.sort((a, b) => {
    const queueDelta = a.capabilities.queueDepth - b.capabilities.queueDepth;
    if (queueDelta !== 0) return queueDelta;
    const ramDelta = b.capabilities.availableRamBudgetMb - a.capabilities.availableRamBudgetMb;
    if (ramDelta !== 0) return ramDelta;
    return a.deviceId.localeCompare(b.deviceId);
  });
  return candidates[0] ?? null;
}
