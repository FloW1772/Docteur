// Companion V1 — [COMP-7 PRODUCT WIRING] one bounded local answer.
//
// request → COMP-3 context assembly (which calls the COMP-7 read port when one is wired) → COMP-4 local model → text.
// Pure orchestration over injected ports: this module imports no model, graph, NB-5 or runtime code (the server
// wiring injects them). Graph data stays untrusted DATA inside the context assembly (kind KG_RESULT, authority NONE,
// NEVER_CLOUD); here it is only counted (kgContextUsed) and its source identifiers are returned as bounded provenance.
// The answer path registers no action: a model action proposal is never turned into a Companion proposal here.
// Diagnostics and logs carry ids, codes and counts only — never the request, the answer or any context text.

import crypto from 'node:crypto';
import { CompanionError, freezeDeep } from './companion-contracts.js';

export const CONVERSATION_LIMITS = freezeDeep({
  maxRequestChars: { value: 16_000, status: 'ACTIVE', basis: 'same bound as the COMP-3 current user intent' },
  maxKgProvenanceItems: { value: 4, status: 'ACTIVE', basis: 'COMP-7 maxResults' },
  maxKgEvidenceRefs: { value: 8, status: 'ACTIVE', basis: 'COMP-7 maxProvenanceItems' },
  timeoutMs: { value: 60_000, status: 'PROVISIONAL', basis: 'COMP-4 default local answer timeout' },
});
/** Operator switch for the graph context: unset / on → wired when the graph is open; off → never wired. */
export const COMPANION_KG_CONTEXT_ENV = 'DOCTEUR_COMPANION_KG_CONTEXT';
const ON = new Set(['on', '1', 'true', 'enabled']);
const OFF = new Set(['off', '0', 'false', 'disabled']);
const ANSWER_FIELDS = Object.freeze(['text']);

const fail = (code, message, details) => { throw new CompanionError(code, message, details); };
const safeArray = (v) => (Array.isArray(v) ? v : []);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Product gate for COMP-7. The graph is never a prerequisite: any value other than an explicit "on" form, or a closed
 * graph, leaves the Companion running without graph context. An unknown value fails closed (no graph context).
 */
export function resolveCompanionKgGate({ kgOpen = false, env = {} } = {}) {
  const raw = env?.[COMPANION_KG_CONTEXT_ENV];
  const value = raw === undefined || raw === null || String(raw).trim() === '' ? 'on' : String(raw).trim().toLowerCase();
  if (OFF.has(value)) return freezeDeep({ enabled: false, reason: 'COMP_7_DISABLED_BY_OPERATOR' });
  if (!ON.has(value)) return freezeDeep({ enabled: false, reason: 'COMP_7_GATE_INVALID' });
  if (!kgOpen) return freezeDeep({ enabled: false, reason: 'KG_NOT_OPEN' });
  return freezeDeep({ enabled: true, reason: 'KG_OPEN' });
}

function kgItems(assembly) {
  const blocks = safeArray(assembly?.localContext?.blocks ?? assembly?.blocks);
  return safeArray(blocks.find(b => b?.type === 'RETRIEVED_DATA')?.items).filter(i => i?.kind === 'KG_RESULT');
}

/** Content-free proof of what the graph contributed to this assembly. kgContextUsed ⇔ ≥ 1 KG item reached the model context. */
export function kgContextDiagnostics(assembly, gate = null) {
  const used = kgItems(assembly);
  const kg = assembly?.kgRetrieval ?? {};
  const dropped = safeArray(assembly?.truncation?.events).filter(e => typeof e?.itemId === 'string' && e.itemId.startsWith('kg:')).length;
  return freezeDeep({
    kgContextUsed: used.length > 0,
    kg: {
      gate: typeof gate?.reason === 'string' ? gate.reason : 'KG_NOT_WIRED',
      state: typeof kg.state === 'string' ? kg.state : 'INACTIVE',
      status: typeof kg.status === 'string' ? kg.status : 'COMP_7_INACTIVE',
      authority: 'NONE',
      retrieved: Number.isSafeInteger(kg.resultCount) ? kg.resultCount : 0,
      used: used.length,
      dropped,
      chars: used.reduce((n, i) => n + (typeof i.text === 'string' ? i.text.length : 0), 0),
      excluded: safeArray(assembly?.exclusions).filter(e => e?.source === 'KNOWLEDGE_GRAPH').map(e => String(e.reason ?? 'UNKNOWN').slice(0, 60)),
    },
  });
}

/** Source identifiers of the graph items the model saw — identifiers only, bounded, authority NONE. */
export function kgContextProvenance(assembly) {
  return freezeDeep(kgItems(assembly).slice(0, CONVERSATION_LIMITS.maxKgProvenanceItems.value).map(i => {
    const p = i.provenance?.primary ?? {};
    return {
      itemId: String(i.id).slice(0, 160),
      sourceRef: typeof p.sourceRef === 'string' ? p.sourceRef.slice(0, 200) : null,
      evidenceRefs: safeArray(p.evidenceRefs).slice(0, CONVERSATION_LIMITS.maxKgEvidenceRefs.value)
        .map(r => ({ kind: String(r?.kind ?? 'KG_SOURCE').slice(0, 40), ref: String(r?.ref ?? '').slice(0, 200) })).filter(r => r.ref),
      authority: 'NONE',
    };
  }));
}

/** Strict answer request: { text } only, a non-empty string within the COMP-3 user-intent bound. */
export function parseAnswerRequest(input) {
  if (!isPlain(input)) fail('COMP_CONVERSATION_INVALID', 'a JSON object is required', { reason: 'NOT_AN_OBJECT' });
  for (const k of Object.keys(input)) if (!ANSWER_FIELDS.includes(k)) fail('COMP_CONVERSATION_INVALID', 'unknown field', { reason: 'UNKNOWN_FIELD' });
  if (typeof input.text !== 'string' || !input.text.trim()) fail('COMP_CONVERSATION_INVALID', 'text is required', { reason: 'TEXT_REQUIRED' });
  if (input.text.length > CONVERSATION_LIMITS.maxRequestChars.value) fail('COMP_CONVERSATION_INVALID', 'text is too long', { reason: 'TEXT_TOO_LONG' });
  return { text: input.text };
}

/**
 * @param {object} deps
 *   contextEngine  createCompanionContextEngine(...) — the graph read port, when wired, is injected there
 *   model          createCompanionModel(...) — local only
 *   kgGate         resolveCompanionKgGate(...) result, reported in diagnostics
 *   logger         optional; receives ids / codes / counts only
 */
export function createCompanionConversation({ contextEngine, model, kgGate = null, logger = null, timeoutMs = CONVERSATION_LIMITS.timeoutMs.value, newRequestId = () => `cans_${crypto.randomBytes(12).toString('hex')}` } = {}) {
  if (typeof contextEngine?.assemble !== 'function') fail('COMP_CONVERSATION_PORT_REQUIRED', 'a Companion context engine is required');
  if (typeof model?.executeCompanionLocal !== 'function') fail('COMP_CONVERSATION_PORT_REQUIRED', 'a Companion local model is required');
  // same bounds as COMP-4 (MODEL_TIMEOUT_BOUNDS 1 s..120 s); the model module re-validates it
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) fail('COMP_CONVERSATION_PORT_REQUIRED', 'timeoutMs is 1000..120000');
  // Only Companion-coded errors leave this path; anything else becomes a fixed, content-free error (its message is
  // never relayed nor logged: it could quote the request or context).
  const sanitized = (error) => (error instanceof CompanionError ? error : new CompanionError('COMP_CONVERSATION_FAILED', 'the answer failed', { reason: 'INTERNAL' }));
  const gate = freezeDeep({ enabled: kgGate?.enabled === true, reason: typeof kgGate?.reason === 'string' ? kgGate.reason : 'KG_NOT_WIRED' });

  return Object.freeze({
    kgGate: gate,
    async answer(input, { signal = null } = {}) {
      const { text } = parseAnswerRequest(input);
      const requestId = newRequestId();
      let context;
      try { context = await contextEngine.assemble({ requestId, userRequest: text, cloudAllowed: false, signal }); } catch (error) {
        const out = sanitized(error);
        logger?.warn?.({ requestId, code: out.code, stage: 'CONTEXT' }, 'COMPANION_ANSWER_FAILED');
        throw out;
      }
      const diagnostics = kgContextDiagnostics(context, gate);
      logger?.info?.({ requestId, kgContextUsed: diagnostics.kgContextUsed, kgStatus: diagnostics.kg.status, kgItems: diagnostics.kg.used }, 'COMPANION_ANSWER_CONTEXT');
      let result;
      try {
        result = await model.executeCompanionLocal({ requestId, context, signal, timeoutMs });
      } catch (error) {
        const out = sanitized(error);
        logger?.warn?.({ requestId, code: String(out.code).slice(0, 60), stage: 'MODEL', kgContextUsed: diagnostics.kgContextUsed }, 'COMPANION_ANSWER_FAILED');
        throw out;
      }
      return freezeDeep({
        requestId,
        text: result.text,
        truncated: result.truncated === true,
        local: true,
        model: result.effectiveModel ?? result.requestedModel ?? null,
        durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
        contextItems: Number.isSafeInteger(result.contextItems) ? result.contextItems : null,
        actionProposalIgnored: Boolean(result.actionProposal || result.actionProposalRejected),
        diagnostics,
        kgProvenance: kgContextProvenance(context),
      });
    },
  });
}
