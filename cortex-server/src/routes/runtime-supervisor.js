// Runtime Supervisor V1 — typed local routes. Mounted under /api behind the central local-request guard.
//
// Fixed endpoints. A request can name a registered serviceId and, for a restart, two booleans — nothing else:
// no command, executable, argument, working directory, shell or PID is accepted anywhere (unknown body fields → 400).
//
// [RS-KIWIX-RESTART] the local restart ceremony of a DELEGATED service (Kiwix):
//   POST …/restart-challenge   body: none or {}                                     → { challengeId, expiresAt, state, … }
//   POST …/restart-confirm     body: { challengeId, gesture: { kind, trusted } }     → 202 accepted
// Both only for the local BROWSER UI: an expected frontend (or same-origin) Origin, Sec-Fetch-Site same-origin / same-site,
// a loopback peer and no non-USER actor context. They never accept a policy flag, an approval token or a process field:
// the challenge id is an opaque echo, everything it binds to is read server-side. These checks are a channel binding,
// not a proof of a human (LOCAL_PROCESS_UI_IMPERSONATION_RESIDUAL_RISK).
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { RuntimeSupervisorError, SERVICE_ID_RE } from '../lib/runtime-supervisor.js';
import { isExpectedFrontendOrigin, parseHostHeader, parseOrigin } from '../lib/local-request-guard.js';
import { ceremonyActorKind } from '../lib/runtime-restart-authority.js';

const RESTART_FIELDS = Object.freeze(['confirmInterrupt', 'resetBlocked']);
const CONFIRM_FIELDS = Object.freeze(['challengeId', 'gesture']);
const GESTURE_FIELDS = 'kind,trusted';
const MAX_BODY_BYTES = 1024;
const LOOPBACK_PEERS = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const UI_FETCH_SITES = Object.freeze(['same-origin', 'same-site']);
const HTTP = Object.freeze({
  RS_UNKNOWN_SERVICE: 404, RS_REQUEST_INVALID: 400, RS_RESTART_NOT_ALLOWED: 403, RS_POLICY_APPROVAL_REQUIRED: 403, RS_POLICY_DENIED: 403,
  RS_OPERATION_IN_PROGRESS: 409, RS_BLOCKED: 409, RS_CONFIRMATION_REQUIRED: 409, RS_BACKOFF: 429, RS_UNAVAILABLE: 503,
  RS_CHALLENGE_REQUIRED: 409, RS_ACTOR_NOT_PERMITTED: 403, RS_NOT_RUNNING: 409, RS_CHALLENGE_INVALID: 400, RS_CHALLENGE_EXPIRED: 410,
  RS_CHALLENGE_REPLAYED: 409, RS_CHALLENGE_MISMATCH: 403, RS_CHALLENGE_STALE: 409,
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
  RS_CHALLENGE_REQUIRED: 'Cette relance passe par la confirmation locale dans Paramètres → Runtime / Services.',
  RS_ACTOR_NOT_PERMITTED: 'Cette confirmation n’est acceptée que depuis l’interface locale de Docteur.',
  RS_NOT_RUNNING: 'Le service n’est pas en cours d’exécution : il n’y a rien à relancer.',
  RS_CHALLENGE_INVALID: 'Confirmation inconnue ou invalide : recommencez.',
  RS_CHALLENGE_EXPIRED: 'Confirmation expirée : recommencez.',
  RS_CHALLENGE_REPLAYED: 'Cette confirmation a déjà été utilisée.',
  RS_CHALLENGE_MISMATCH: 'Cette confirmation ne correspond pas à cette demande.',
  RS_CHALLENGE_STALE: 'Le service a changé depuis la demande : recommencez.',
});

export function createRuntimeSupervisorRoute({
  supervisor = null, logger = null, isAllowedOrigin = isExpectedFrontendOrigin,
  isLoopbackPeer = (c) => { try { return LOOPBACK_PEERS.includes(getConnInfo(c).remote.address); } catch { return false; } },
} = {}) {
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
  const invalid = (reason) => new RuntimeSupervisorError('RS_REQUEST_INVALID', 'invalid', { reason });
  const serviceId = (c) => {
    const id = c.req.param('serviceId');
    if (typeof id !== 'string' || !SERVICE_ID_RE.test(id)) throw new RuntimeSupervisorError('RS_UNKNOWN_SERVICE', 'unknown', { reason: 'UNKNOWN_SERVICE' });
    return id;
  };
  /** A closed JSON object body (≤ 1 KiB); an empty body is {}. */
  const jsonBody = async (c, allowed) => {
    const text = await c.req.text().catch(() => null);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BODY_BYTES) throw invalid('BODY_INVALID');
    if (!text.trim()) return {};
    let body;
    try { body = JSON.parse(text); } catch { throw invalid('NOT_JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('NOT_AN_OBJECT');
    for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid('UNKNOWN_FIELD');
    return body;
  };
  const restartBody = async (c) => {
    const body = await jsonBody(c, RESTART_FIELDS);
    for (const k of RESTART_FIELDS) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw invalid('FIELD_TYPE');
    return { confirmInterrupt: body.confirmInterrupt === true, resetBlocked: body.resetBlocked === true };
  };
  const confirmBody = async (c) => {
    const body = await jsonBody(c, CONFIRM_FIELDS);
    if (typeof body.challengeId !== 'string' || body.challengeId.length > 64) throw invalid('CHALLENGE_ID');
    const g = body.gesture;
    if (!g || typeof g !== 'object' || Array.isArray(g) || Object.keys(g).sort().join(',') !== GESTURE_FIELDS || typeof g.kind !== 'string' || typeof g.trusted !== 'boolean') throw invalid('GESTURE');
    return { challengeId: body.challengeId, gesture: { kind: g.kind, trusted: g.trusted } };
  };
  /** The ceremony is for the local browser UI only. Returns the request's origin (the challenge binds to it). */
  const uiCeremony = (c) => {
    const deny = (reason) => new RuntimeSupervisorError('RS_ACTOR_NOT_PERMITTED', 'not the local UI', { reason });
    const actor = ceremonyActorKind();
    if (actor !== null && actor !== 'USER') throw deny('ACTOR_NOT_PERMITTED');
    if (!isLoopbackPeer(c)) throw deny('REMOTE_PEER');
    const origin = parseOrigin(c.req.header('origin'));
    const host = parseHostHeader(c.req.header('host') ?? new URL(c.req.url).host);
    if (!origin || !(isAllowedOrigin(origin.origin) || (host && origin.host.toLowerCase() === host.host.toLowerCase()))) throw deny('UI_ORIGIN_REQUIRED');
    if (!UI_FETCH_SITES.includes(String(c.req.header('sec-fetch-site') ?? '').toLowerCase())) throw deny('BROWSER_UI_REQUIRED');
    return origin.origin;
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
  app.post('/runtime/services/:serviceId/restart-challenge', wrap(async (c) => {
    const id = serviceId(c); const s = need();
    await jsonBody(c, []);
    const origin = uiCeremony(c);
    return c.json({ ok: true, value: s.createRestartChallenge(id, { origin, actor: 'USER' }) }, 201);
  }));
  app.post('/runtime/services/:serviceId/restart-confirm', wrap(async (c) => {
    const id = serviceId(c); const s = need();
    const body = await confirmBody(c);
    const origin = uiCeremony(c);
    return c.json({ ok: true, value: s.confirmRestart(id, { ...body, origin, actor: 'USER' }) }, 202);
  }));
  return app;
}
