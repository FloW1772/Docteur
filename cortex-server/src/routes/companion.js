// Companion V1 — COMP-6B typed local UI route.
//
// This is deliberately not a generic RPC endpoint: every CompanionUiPort operation has a fixed method/path and
// a bounded request shape. The route is mounted below the existing central local-request guard in server.js.
// When the certification boot gate is closed, only status/list remain readable and no Companion store is opened.
import { Hono } from 'hono';
import { COMPANION_ACTIVATION } from '../lib/companion-boot.js';
import { COMPANION_SCHEMA_VERSION } from '../lib/companion-schema.js';
import { CompanionError, parseStrictJson } from '../lib/companion-contracts.js';

const HTTP = Object.freeze({
  COMPANION_DISABLED: 503,
  COMP_NOT_FOUND: 404,
  APPROVAL_REQUIRED: 409,
  APPROVAL_EXPIRED: 409,
  APPROVAL_ALREADY_USED: 409,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_INTENT_EXPIRED: 409,
  APPROVAL_INTENT_REPLAYED: 409,
  APPROVAL_INTENT_MISMATCH: 409,
  APPROVAL_DIGEST_MISMATCH: 409,
  PREVIEW_STALE: 409,
  ACTION_TIMEOUT: 504,
  LOCAL_MODEL_UNAVAILABLE: 503,
});

/** [COMP-REMED-2] PROVISIONAL: the service's 16 KiB envelope, JSON-escaped inside { rawOutput }, with headroom. */
const MODEL_BODY_BYTES = 64 * 1024;

const disabledStatus = Object.freeze({
  activation: COMPANION_ACTIVATION,
  schemaVersion: COMPANION_SCHEMA_VERSION,
  preferences: Object.freeze({ memoryEnabled: false, sessionMemoryEnabled: false, proposalEnabled: false, cloudContextEnabled: false }),
  model: Object.freeze({ status: 'NOT_RUN', code: null, at: null, source: 'COMPANION_MODEL_AUDIT' }),
});

export function createCompanionUiRoute({ service = null, disabledReason = 'COMPANION_UNCERTIFIED_DISABLED', logger = null } = {}) {
  const app = new Hono();
  const body = async (c) => {
    const value = await c.req.json().catch(() => null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanionError('INVALID_ACTION_PAYLOAD', 'JSON object required');
    return value;
  };
  // [COMP-REMED-2] CR-1: the model-proposal body carries model output (rawOutput may be an object). c.req.json() is a
  // plain JSON.parse (duplicate keys last-wins), so this body is read as bounded text and parsed strictly.
  const modelBody = async (c) => {
    const text = await c.req.text().catch(() => null);
    if (typeof text !== 'string') throw new CompanionError('INVALID_ACTION_PAYLOAD', 'JSON object required');
    if (Buffer.byteLength(text) > MODEL_BODY_BYTES) throw new CompanionError('INVALID_ACTION_PAYLOAD', 'model output too large', { reason: 'MODEL_OUTPUT_TOO_LARGE' });
    let value;
    try { value = parseStrictJson(text); } catch (e) {
      const reason = e?.details?.reason ?? 'NOT_JSON';
      if (reason === 'NOT_JSON') throw new CompanionError('INVALID_ACTION_PAYLOAD', 'JSON object required');
      throw new CompanionError('INVALID_ACTION_PAYLOAD', 'ambiguous model output refused', { reason: `MODEL_OUTPUT_${reason}` });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanionError('INVALID_ACTION_PAYLOAD', 'JSON object required');
    return value;
  };
  const requireService = () => {
    if (!service) throw new CompanionError('COMPANION_DISABLED', 'Companion non activé.', { reason: disabledReason });
    return service;
  };
  const fail = (c, error) => {
    const known = error instanceof CompanionError;
    const code = known ? error.code : 'ACTION_FAILED';
    if (!known) logger?.error?.({ code, error: error?.message ?? String(error) }, 'COMPANION_UI_ROUTE_ERROR');
    return c.json({ ok: false, error: { code, message: known ? error.message : 'Erreur interne.', reason: known ? error.details?.reason ?? null : 'INTERNAL' } }, HTTP[code] ?? (known ? 400 : 500));
  };
  const wrap = (fn) => async (c) => { try { return await fn(c); } catch (error) { return fail(c, error); } };
  const ok = (c, value) => c.json({ ok: true, value });

  app.get('/companion/status', wrap(async (c) => ok(c, service ? await service.getStatus() : { ...disabledStatus, disabledReason })));
  app.get('/companion/memories', wrap(async (c) => ok(c, service ? await service.listMemories() : [])));
  app.post('/companion/sessions', wrap(async (c) => ok(c, await requireService().openUiSession())));
  app.delete('/companion/sessions/:uiSessionId', wrap(async (c) => ok(c, await requireService().closeUiSession(c.req.param('uiSessionId')))));
  app.get('/companion/memories/:memoryId/explanation', wrap(async (c) => ok(c, await requireService().explainMemory(c.req.param('memoryId')))));
  app.get('/companion/contexts/:requestId/explanation', wrap(async (c) => ok(c, await requireService().explainContext(c.req.param('requestId')))));
  app.post('/companion/proposals', wrap(async (c) => { const b = await body(c); return ok(c, await requireService().propose(b.actionId, b.parameters)); }));
  app.post('/companion/model-proposals', wrap(async (c) => { const b = await modelBody(c); return ok(c, await requireService().proposeFromModel(b)); }));
  // [COMP-REMED-1] open proposals (PENDING / APPROVED) so the product panel shows model proposals; disabled → none
  app.get('/companion/proposals', wrap(async (c) => ok(c, service ? await service.listProposals() : [])));
  app.get('/companion/proposals/:proposalId', wrap(async (c) => ok(c, await requireService().getProposal(c.req.param('proposalId')))));
  app.post('/companion/sessions/:uiSessionId/proposals/:proposalId/challenge', wrap(async (c) => ok(c, await requireService().issueChallenge(c.req.param('uiSessionId'), c.req.param('proposalId')))));
  app.post('/companion/approvals', wrap(async (c) => ok(c, await requireService().submitIntent(await body(c)))));
  app.post('/companion/executions', wrap(async (c) => ok(c, await requireService().execute(await body(c)))));
  app.post('/companion/executions/:executionId/abort', wrap(async (c) => ok(c, await requireService().abortExecution(c.req.param('executionId')))));
  app.post('/companion/proposals/:proposalId/reject', wrap(async (c) => ok(c, await requireService().reject(c.req.param('proposalId')))));
  app.post('/companion/proposals/:proposalId/cancel', wrap(async (c) => ok(c, await requireService().cancel(c.req.param('proposalId')))));

  return app;
}
