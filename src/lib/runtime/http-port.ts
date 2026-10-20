// Runtime Supervisor V1 — HTTP implementation of RuntimePort. Fixed endpoints; the only request bodies are the two
// restart booleans and the ceremony below. The server only ever sends a fixed message per error code (never raw process/provider output);
// it is length-capped here, and the UI renders its own fixed labels for states, health and reasons.
// [RS-KIWIX-RESTART] two more fixed calls for the local restart ceremony: an empty challenge request, then the opaque
// challenge id + the trusted gesture that confirmed it. Nothing else is ever sent (no policy flag, token or process field).
import { RuntimeUiError, type RestartChallengeDto, type RestartGesture, type RestartOptions, type RuntimeEventDto, type RuntimePort, type RuntimeServiceDto, type RuntimeState } from './contracts';

export function createHttpRuntimePort({ baseUrl, fetchImpl = fetch }: { baseUrl: string; fetchImpl?: typeof fetch }): RuntimePort {
  const api = `${baseUrl.replace(/\/+$/, '')}/api/runtime/services`;
  const id = (value: string) => encodeURIComponent(value);
  async function call<T>(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new RuntimeUiError('NETWORK', 'Docteur est injoignable.'); }
    let payload: { ok?: boolean; value?: T; error?: { code?: string; message?: string; reason?: string | null; retryAt?: string } } = {};
    try { payload = await response.json(); } catch { /* fail closed below */ }
    if (!response.ok || payload.ok !== true) {
      const e = payload.error ?? {};
      throw new RuntimeUiError(e.code ?? `HTTP_${response.status}`, typeof e.message === 'string' ? e.message.slice(0, 200) : 'Requête refusée.', e.reason ?? null, typeof e.retryAt === 'string' ? e.retryAt : null);
    }
    return payload.value as T;
  }
  return Object.freeze({
    list: async () => (await call<{ services: RuntimeServiceDto[] }>('GET', api)).services,
    get: (serviceId: string) => call<{ service: RuntimeServiceDto; events: RuntimeEventDto[] }>('GET', `${api}/${id(serviceId)}`),
    restart: (serviceId: string, options: RestartOptions = {}) => call<{ accepted: boolean; serviceId: string; state: RuntimeState }>('POST', `${api}/${id(serviceId)}/restart`, { confirmInterrupt: options.confirmInterrupt === true, resetBlocked: options.resetBlocked === true }),
    createRestartChallenge: (serviceId: string) => call<RestartChallengeDto>('POST', `${api}/${id(serviceId)}/restart-challenge`, {}),
    confirmRestart: (serviceId: string, challengeId: string, gesture: RestartGesture) => call<{ accepted: boolean; serviceId: string; state: RuntimeState }>('POST', `${api}/${id(serviceId)}/restart-confirm`,
      { challengeId, gesture: { kind: gesture.kind, trusted: gesture.trusted === true } }),
  });
}
