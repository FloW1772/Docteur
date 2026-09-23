/**
 * OMEGA ADMIN lifecycle callbacks.
 *
 * This tiny dependency-free registry avoids importing the ADMIN manager into
 * the session/device modules (and therefore avoids an authorization-cycle).
 * It is process-local by design: pending ADMIN requests are never persisted
 * as executable authority and disappear on Cortex restart.
 */
const sessionListeners = new Set();
const deviceListeners = new Set();

export function registerOmegaAdminLifecycle({ onSessionEnded, onDeviceRevoked } = {}) {
  if (typeof onSessionEnded === 'function') sessionListeners.add(onSessionEnded);
  if (typeof onDeviceRevoked === 'function') deviceListeners.add(onDeviceRevoked);
  return () => {
    if (typeof onSessionEnded === 'function') sessionListeners.delete(onSessionEnded);
    if (typeof onDeviceRevoked === 'function') deviceListeners.delete(onDeviceRevoked);
  };
}

export function notifyOmegaAdminSessionEnded(sessionId, reason = 'session_ended') {
  for (const listener of sessionListeners) {
    try { listener(sessionId, reason); } catch { /* lifecycle cleanup is best effort */ }
  }
}

export function notifyOmegaAdminDeviceRevoked(deviceId) {
  for (const listener of deviceListeners) {
    try { listener(deviceId, 'device_revoked'); } catch { /* lifecycle cleanup is best effort */ }
  }
}

export function _resetOmegaAdminLifecycleForTests() {
  sessionListeners.clear();
  deviceListeners.clear();
}
