let stopHook = null;

export function registerRassilonLanStopHook(hook) {
  stopHook = typeof hook === 'function' ? hook : null;
}

export function requestRassilonLanStop() {
  try { return stopHook?.() ?? false; } catch { return false; }
}
