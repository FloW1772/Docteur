// Centralized strict-local-mode gate for routes that call a cloud provider
// directly instead of going through router.js's runAiTask/routedCompletion
// (which already enforce this internally). research.js, teacher.js and
// voice.js each re-derived `getRouterSettings()?.strict_local_mode === true`
// at every call site — correct everywhere it was checked, but duplicated
// enough that a future route could add a new cloud call path and forget the
// guard. Centralizing here doesn't change behavior (same check, same error
// shape) — it just gives every future direct-cloud-call site one thing to
// import instead of re-deriving the condition.
import { getRouterSettings } from './sqlite.js';

export function isStrictLocalMode() {
  return getRouterSettings()?.strict_local_mode === true;
}

export function strictLocalErrorBody(message) {
  return {
    error: message ?? 'Mode strictement local activé — cette fonctionnalité cloud est désactivée. Désactive-le dans Paramètres pour l’utiliser.',
    strict_local: true,
  };
}

// Returns the Hono JSON response to send (503) if strict local mode blocks
// the call, or null if the caller may proceed. Usage:
//   const blocked = assertCloudAllowed(c, 'La veille cloud est désactivée...');
//   if (blocked) return blocked;
export function assertCloudAllowed(c, message) {
  if (!isStrictLocalMode()) return null;
  return c.json(strictLocalErrorBody(message), 503);
}
