// NotebookProvider abstraction (Phase 5B, MASTER mission) — documents which
// Notebook backends are actually usable today vs. future-only. Any code
// that might one day need to pick a Notebook backend should consult this
// list rather than assuming NotebookLM is reachable just because a key is
// configured (see routes/notebooklm.js: a saved key makes ZERO calls).
//
// There is deliberately no Ollama-failure-to-NotebookLM fallback anywhere
// in this codebase, and none may ever be added silently — Notebook Q&A
// (routes/notebook.js) is local-only by construction (no cloud provider
// import), independent of whatever this list reports.
export const NOTEBOOK_PROVIDERS = Object.freeze({
  local: {
    id: 'local',
    label: 'Notebook local',
    available: true,
  },
  notebooklm_future: {
    id: 'notebooklm_future',
    label: 'NotebookLM / Google (préparation future)',
    available: false,
    reason: 'API_NOT_SUPPORTED',
  },
});

export class NotebookProviderUnavailableError extends Error {
  constructor(providerId) {
    super(`NOTEBOOKLM_API_NOT_AVAILABLE: le provider '${providerId}' n'est pas disponible actuellement (préparé pour une future intégration, jamais appelé).`);
    this.name = 'NotebookProviderUnavailableError';
    this.code = 'NOTEBOOKLM_API_NOT_AVAILABLE';
  }
}

// Any attempt to actually invoke the notebooklm_future provider must throw
// this — there is no code path today that calls this function from a real
// request handler (routes/notebook.js never imports it), but it exists so a
// future integration has an explicit, obvious gate to remove deliberately
// rather than one that could be bypassed accidentally.
export function assertNotebookProviderAvailable(providerId) {
  const provider = NOTEBOOK_PROVIDERS[providerId];
  if (!provider || !provider.available) throw new NotebookProviderUnavailableError(providerId);
  return provider;
}
