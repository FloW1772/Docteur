// Runtime Supervisor V1 — typed local routes. Mounted under /api behind the central local-request guard.
//
// Three fixed endpoints. A request can name a registered serviceId and, for a restart, two booleans — nothing else:
// no command, executable, argument, working directory, shell or PID is accepted anywhere (unknown body fields → 400).
import { Hono } from 'hono';
import { RuntimeSupervisorError, SERVICE_ID_RE } from '../lib/runtime-supervisor.js';

const RESTART_FIELDS = Object.freeze(['confirmInterrupt', 'resetBlocked']);
const MAX_BODY_BYTES = 1024;
const HTTP = Object.freeze({
  RS_UNKNOWN_SERVICE: 404, RS_REQUEST_INVALID: 400, RS_RESTART_NOT_ALLOWED: 403, RS_POLICY_APPROVAL_REQUIRED: 403, RS_POLICY_DENIED: 403,
  RS_OPERATION_IN_PROGRESS: 409, RS_BLOCKED: 409, RS_CONFIRMATION_REQUIRED: 409, RS_BACKOFF: 429, RS_UNAVAILABLE: 503,
});
const MESSAGES = Object.freeze({
  RS_UNKNOWN_SERVICE: 'Service inconnu.',
  RS_REQUEST_INVALID: 'Requête invalide.',
  RS_RESTART_NOT_ALLOWED: 'Ce service ne peut pas être relancé par Docteur.',
  RS_POLICY_APPROVAL_REQUIRED: 'La Root Policy exige une approbation locale que Docteur ne peut pas encore délivrer.',
  RS_POLICY_DENIED: 'La Root Policy a refusé la relance.',
  RS_OPERATION_IN_PROGRESS: 'Une opération est déjà en cours sur ce service.',
  RS_BLOCKED: 'Service bloqué après des échecs répétés : une réinitialisation explicite est requise.',
  RS_CONFIRMATION_REQUIRED: 'La relance peut interrompre un travail en cours : confirmation requise.',
  RS_BACKOFF: 'Relance temporairement suspendue après un plantage.',
  RS_UNAVAILABLE: 'Superviseur indisponible.',
});

export function createRuntimeSupervisorRoute({ supervisor = null, logger = null } = {}) {
  const app = new Hono();
  const fail = (c, error) => {
    const known = error instanceof RuntimeSupervisorError && Object.hasOwn(HTTP, error.code);
    if (!known) logger?.error?.({ code: 'RS_INTERNAL', error: String(error?.code ?? 'UNKNOWN').slice(0, 60) }, 'RUNTIME_SUPERVISOR_ROUTE_ERROR');
    const code = known ? error.code : 'RS_INTERNAL';
    const retryAt = known && typeof error.details?.retryAt === 'string' ? error.details.retryAt : undefined;
    return c.json({ ok: false, error: { code, message: MESSAGES[code] ?? 'Erreur interne.', reason: known ? error.details?.reason ?? null : 'INTERNAL', ...(retryAt ? { retryAt } : {}) } }, HTTP[code] ?? 500);
  };
  const wrap = (fn) => async (c) => { try { return await fn(c); } catch (error) { return fail(c, error); } };
  const need = () => { if (!supervisor) throw new RuntimeSupervisorError('RS_UNAVAILABLE', 'unavailable', { reason: 'SUPERVISOR_UNAVAILABLE' }); return supervisor; };
  const serviceId = (c) => {
    const id = c.req.param('serviceId');
    if (typeof id !== 'string' || !SERVICE_ID_RE.test(id)) throw new RuntimeSupervisorError('RS_UNKNOWN_SERVICE', 'unknown', { reason: 'UNKNOWN_SERVICE' });
    return id;
  };
  const restartBody = async (c) => {
    const text = await c.req.text().catch(() => null);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BODY_BYTES) throw new RuntimeSupervisorError('RS_REQUEST_INVALID', 'invalid', { reason: 'BODY_INVALID' });
    if (!text.trim()) return {};
    let body;
    try { body = JSON.parse(text); } catch { throw new RuntimeSupervisorError('RS_REQUEST_INVALID', 'invalid', { reason: 'NOT_JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RuntimeSupervisorError('RS_REQUEST_INVALID', 'invalid', { reason: 'NOT_AN_OBJECT' });
    for (const k of Object.keys(body)) if (!RESTART_FIELDS.includes(k)) throw new RuntimeSupervisorError('RS_REQUEST_INVALID', 'invalid', { reason: 'UNKNOWN_FIELD' });
    for (const k of RESTART_FIELDS) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new RuntimeSupervisorError('RS_REQUEST_INVALID', 'invalid', { reason: 'FIELD_TYPE' });
    return { confirmInterrupt: body.confirmInterrupt === true, resetBlocked: body.resetBlocked === true };
  };

  app.get('/runtime/services', wrap(async (c) => c.json({ ok: true, value: { services: await need().list() } })));
  app.get('/runtime/services/:serviceId', wrap(async (c) => {
    const id = serviceId(c); const s = need();
    return c.json({ ok: true, value: { service: await s.get(id), events: s.events(id) } });
  }));
  app.post('/runtime/services/:serviceId/restart', wrap(async (c) => {
    const id = serviceId(c); const s = need();
    const body = await restartBody(c);
    return c.json({ ok: true, value: await s.restart(id, { ...body, actor: 'USER' }) }, 202);
  }));
  return app;
}
