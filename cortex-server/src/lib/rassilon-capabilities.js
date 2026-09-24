import { AVAILABLE_EXECUTORS } from './rassilon-executors.js';
import { EMBEDDING_MODEL_ALLOWLIST } from './rassilon-job-schema.js';
import { getSystemRamStatus } from './rassilon-resource-guard.js';
import { detectPowerStatus } from './rassilon-power.js';
import { getRassilonStatus } from './rassilon-worker.js';

export async function getRassilonCapabilities({ deviceId, providers = {}, powerProvider = detectPowerStatus } = {}) {
  const worker = getRassilonStatus();
  const ram = getSystemRamStatus();
  let availableLocalModelIds = [];
  try {
    if (providers.ollamaClient?.list) {
      const response = await providers.ollamaClient.list();
      const names = (response?.models ?? []).map(model => model?.name).filter(Boolean);
      availableLocalModelIds = EMBEDDING_MODEL_ALLOWLIST.filter(allowed => names.some(name => name === allowed || name.startsWith(`${allowed}:`)));
    }
  } catch { availableLocalModelIds = []; }
  let batteryState = 'UNKNOWN';
  try {
    const power = await powerProvider();
    batteryState = ['AC_ONLY', 'ON_BATTERY', 'NOT_PRESENT'].includes(power?.status) ? power.status : 'UNKNOWN';
  } catch { /* fail closed to UNKNOWN */ }
  const safeExecutorTypes = AVAILABLE_EXECUTORS.filter(type => worker.settings.acceptedJobTypes.includes(type));
  if (!safeExecutorTypes.includes('EMBEDDING_BATCH')) availableLocalModelIds = [];
  return {
    deviceId,
    status: worker.state,
    safeExecutorTypes,
    availableLocalModelIds,
    availableCpuBudgetPercent: worker.enabled ? worker.settings.maxCpuPercent : 0,
    availableRamBudgetMb: worker.enabled && ram.available !== false
      ? Math.max(0, Math.min(worker.settings.maxRamMb, Math.floor(ram.freeBytes / (1024 * 1024)))) : 0,
    gpuPresent: null,
    vramBudgetMb: null,
    batteryState,
    queueDepth: worker.queueDepth,
  };
}
