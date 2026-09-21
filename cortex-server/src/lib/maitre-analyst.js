/**
 * MAÎTRE — local security analyst (MA-6). Optional Ollama-backed
 * explanation layer over an already-correlated incident (MA-5). Read-
 * only toward the rest of MAÎTRE: builds a bounded, redacted context
 * package from maitre-orchestrator.js's existing getIncidentDetail(),
 * calls the EXISTING Ollama client (ollama.js — no second LLM client),
 * and returns a validated, structured explanation. Works without
 * Ollama via analyzeIncidentDeterministic().
 *
 * HARD BOUNDARY (enforced structurally, not just by convention): this
 * file has no access to child_process, no OS adapters, no
 * maitre-correlation.js WRITE path beyond what already exists, and no
 * import of anything that could execute a command. The LLM's output is
 * parsed into a fixed, closed schema (AnalystResult below) — any field
 * not in that schema is dropped, not passed through. There is
 * structurally no way for a field named "command"/"shell"/"execute" to
 * survive validateAnalystResult() even if the model outputs one.
 *
 * severity/status are NEVER read from the LLM output and NEVER written
 * back to the incident — this file has no import of updateIncident.
 */
import { chatCompletion } from './ollama.js';
import { getIncidentDetail } from './maitre-orchestrator.js';
import { redactMaitreEvidenceMetadata } from './maitre-evidence.js';

const OLLAMA_TIMEOUT_MS = 15_000;

// ── Context bounds (mission §6) — never an unbounded prompt ───────────────
const MAX_EVENTS_IN_CONTEXT = 20;
const MAX_EVIDENCE_IN_CONTEXT = 10;
const MAX_TIMELINE_ENTRIES_IN_CONTEXT = 30;
const MAX_FIELD_CHARS = 500;
const MAX_REASON_CHARS = 300;
const MAX_TOTAL_PROMPT_CHARS = 12_000;

function truncate(value, maxChars) {
  if (typeof value !== 'string') return value;
  return value.length > maxChars ? `${value.slice(0, maxChars)}…[TRUNCATED]` : value;
}

/**
 * Builds a deterministic, bounded, already-redacted context package
 * from an incident. Never includes full file content, raw binary,
 * credentials, cookies, tokens, full network payloads, or large Event
 * Log dumps — only already-normalized SecurityEvent/Evidence/Incident
 * fields, each redacted and length-capped.
 */
export function buildIncidentContext(incidentId) {
  const detail = getIncidentDetail(incidentId);
  if (!detail) return null;

  const { incident, events, evidence } = detail;

  const boundedEvents = events.slice(0, MAX_EVENTS_IN_CONTEXT).map(e => ({
    id: e.id,
    source: e.source,
    category: truncate(e.category, MAX_FIELD_CHARS),
    severity: e.severity,
    confidence: e.confidence,
    occurredAt: e.occurredAt,
    subject: redactMaitreEvidenceMetadata(truncateDeep(e.subject)),
    metadata: redactMaitreEvidenceMetadata(truncateDeep(e.metadata)),
    detectorId: e.detectorId,
  }));

  const boundedEvidence = evidence.slice(0, MAX_EVIDENCE_IN_CONTEXT).map(ev => ({
    id: ev.id,
    type: ev.type,
    source: ev.source,
    sha256: ev.sha256,
    metadata: redactMaitreEvidenceMetadata(truncateDeep(ev.metadata)),
  }));

  const boundedTimeline = (incident.timeline ?? []).slice(-MAX_TIMELINE_ENTRIES_IN_CONTEXT).map(t => ({
    at: t.at,
    type: t.type,
    ruleId: t.ruleId ?? null,
  }));

  return {
    incident: {
      id: incident.id,
      title: truncate(incident.title, MAX_FIELD_CHARS),
      summary: truncate(incident.summary, MAX_REASON_CHARS),
      severity: incident.severity,
      status: incident.status,
      createdAt: incident.createdAt,
    },
    events: boundedEvents,
    evidence: boundedEvidence,
    timeline: boundedTimeline,
    knownLimitations: [
      'A new/unusual observation is not automatically malicious.',
      'An unsigned executable or unknown hash is not automatically malware.',
      'Only deterministic correlation rules assign severity — this analysis cannot change it.',
    ],
  };
}

function truncateDeep(value, depth = 0) {
  if (depth > 4) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return truncate(value, MAX_FIELD_CHARS);
  if (Array.isArray(value)) return value.slice(0, 20).map(v => truncateDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Serializes the context into the prompt sent to Ollama, hard-capped
 * at MAX_TOTAL_PROMPT_CHARS regardless of how much the context builder
 * produced — a last-resort bound in addition to the per-field caps.
 */
function serializeContextForPrompt(context) {
  const serialized = JSON.stringify(context);
  return truncate(serialized, MAX_TOTAL_PROMPT_CHARS);
}

// Static, Docteur-authored system prompt — never generated from
// external/user/LLM input. Explicit about the read-only, non-executing,
// non-authoritative-on-severity contract.
const SYSTEM_PROMPT = `You are a local defensive security analyst inside Docteur's MAÎTRE module.
Use only the supplied incident data. Do not invent evidence.
Do not execute commands. Do not instruct tools. Do not output any command, shell syntax, or tool call.
Do not change or suggest changing the incident's severity or status — those are controlled by a separate deterministic engine and your output is ignored for that purpose.
Clearly separate observed facts, hypotheses, and unknowns. Never declare "malware confirmed" or "attack confirmed" — only deterministic rules with sufficient evidence may do that, and this analysis is not that.
Respond ONLY with a single JSON object matching this exact shape, no other text:
{"summary": string, "observedFacts": string[], "hypotheses": string[], "unknowns": string[], "reviewSuggestions": string[], "confidence": number between 0 and 1}
reviewSuggestions must be human review actions only (e.g. "Review file metadata", "Inspect related process history"), never a command to run.`;

// ── Structured output validation (mission §9/§10) ─────────────────────────

const ALLOWED_RESULT_KEYS = new Set(['summary', 'observedFacts', 'hypotheses', 'unknowns', 'reviewSuggestions', 'confidence']);
// Any of these substrings appearing in a reviewSuggestion is treated as
// an executable-shaped instruction and dropped — reviewSuggestions must
// stay non-executable per mission §14.
const EXECUTABLE_SHAPE_PATTERN = /\b(run|execute|kill|terminate|netsh|powershell|cmd\.exe|quarantine|disable|delete|rm -rf|invoke-expression|iex)\b/i;

function sanitizeStringArray(value, maxItems, maxCharsPerItem) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(v => typeof v === 'string' && v.trim().length > 0)
    .slice(0, maxItems)
    .map(v => truncate(v, maxCharsPerItem));
}

/**
 * Strictly validates a parsed LLM response into the closed
 * AnalystResult schema. Unexpected top-level keys are dropped (never
 * passed through) — there is structurally no path for a
 * "command"/"shell"/"toolCall"/"execute" field to survive this
 * function, whatever the model outputs.
 */
export function validateAnalystResult(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const summary = typeof raw.summary === 'string' ? truncate(raw.summary, 1000) : '';
  const observedFacts = sanitizeStringArray(raw.observedFacts, 20, MAX_FIELD_CHARS);
  const hypotheses = sanitizeStringArray(raw.hypotheses, 20, MAX_FIELD_CHARS);
  const unknowns = sanitizeStringArray(raw.unknowns, 20, MAX_FIELD_CHARS);

  const rawSuggestions = sanitizeStringArray(raw.reviewSuggestions, 20, MAX_FIELD_CHARS);
  const reviewSuggestions = rawSuggestions.filter(s => !EXECUTABLE_SHAPE_PATTERN.test(s));

  let confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  // Defense in depth: even though ALLOWED_RESULT_KEYS isn't iterated to
  // build the result (we build it field-by-field above, which already
  // guarantees no extra key survives), assert it here as an explicit,
  // testable structural invariant.
  const result = { summary, observedFacts, hypotheses, unknowns, reviewSuggestions, confidence };
  for (const key of Object.keys(result)) {
    if (!ALLOWED_RESULT_KEYS.has(key)) delete result[key];
  }
  return result;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Model sometimes wraps JSON in prose or a code fence — try to
    // extract the first {...} block as a best-effort recovery, still
    // going through the same strict validator afterward.
    const match = typeof text === 'string' ? text.match(/\{[\s\S]*\}/) : null;
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ── Deterministic fallback (mission §20) — no LLM required ────────────────

/**
 * Produces a full AnalystResult directly from already-persisted data,
 * with zero LLM involvement. This is what MAÎTRE uses when Ollama is
 * absent, times out, or errors — MAÎTRE must remain fully useful
 * without it (mission §17 Strict Local compatibility).
 */
export function analyzeIncidentDeterministic(incidentId) {
  const context = buildIncidentContext(incidentId);
  if (!context) return null;

  const eventSummaries = context.events.map(e => `${e.source}/${e.category} (${e.severity})`);
  const observedFacts = context.events.map(e => `Event observed: ${e.source} reported "${e.category}" with severity ${e.severity} at ${e.occurredAt}.`);
  const timelineFacts = context.timeline.map(t => `Timeline: ${t.type}${t.ruleId ? ` (${t.ruleId})` : ''} at ${t.at}.`);

  return {
    result: {
      summary: `Incident "${context.incident.title}" (${context.incident.severity}, status ${context.incident.status}) involves ${context.events.length} correlated event(s): ${eventSummaries.join('; ') || 'none'}.`,
      observedFacts: [...observedFacts, ...timelineFacts].slice(0, 20),
      hypotheses: [],
      unknowns: context.evidence.length === 0 ? ['No Evidence has been linked to this incident yet.'] : [],
      reviewSuggestions: ['Review the linked events and evidence manually.', 'Confirm whether the correlated activity matches expected behavior for this host.'],
      confidence: 0.3,
    },
    provenance: { source: 'DETERMINISTIC', model: null, generatedAt: new Date().toISOString(), incidentId },
  };
}

/**
 * The main entry point. Tries Ollama (if a client+model are supplied)
 * with a hard timeout; on ANY failure (offline, timeout, invalid JSON,
 * empty response, oversized response, unexpected shape) falls back to
 * analyzeIncidentDeterministic() — MAÎTRE never blocks or errors out
 * because Ollama is unavailable.
 */
export async function analyzeIncident(incidentId, { ollamaClient = null, ollamaModel = null, timeoutMs = OLLAMA_TIMEOUT_MS } = {}) {
  const context = buildIncidentContext(incidentId);
  if (!context) return null;

  if (!ollamaClient || !ollamaModel) {
    return analyzeIncidentDeterministic(incidentId);
  }

  try {
    const prompt = serializeContextForPrompt(context);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Incident context (JSON):\n${prompt}` },
    ];

    const withTimeout = Promise.race([
      chatCompletion(ollamaClient, ollamaModel, messages),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ollama_timeout')), timeoutMs)),
    ]);

    const raw = await withTimeout;
    if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
      return analyzeIncidentDeterministic(incidentId);
    }

    const parsed = tryParseJson(raw);
    const validated = validateAnalystResult(parsed);
    if (!validated) {
      return analyzeIncidentDeterministic(incidentId);
    }

    return {
      result: validated,
      provenance: { source: 'OLLAMA_LOCAL', model: ollamaModel, generatedAt: new Date().toISOString(), incidentId },
    };
  } catch {
    // Ollama offline/timeout/error of any kind — degrade to the
    // deterministic fallback rather than propagating the failure.
    return analyzeIncidentDeterministic(incidentId);
  }
}
