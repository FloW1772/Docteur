/**
 * Shared finding shape for every Cyber Audit detector (CA-4). All
 * detectors are PURE functions — they take already-fetched
 * response/certificate data (from cyber-gateway.js) and return findings;
 * they never perform network I/O themselves. This mirrors
 * investment-scoring.js's "pure, deterministic, auditable, never invents
 * missing data" discipline.
 *
 * Severity and confidence are deliberately separate axes (mission
 * requirement): severity is "how bad would this be if true", confidence
 * is "how sure are we this observation is correct/complete". A weak
 * signal (e.g. a single missing header on one response) must never be
 * escalated to CRITICAL, and nothing here is ever called "vulnerable" —
 * findings describe an OBSERVATION, with an INTERPRETATION and a
 * RECOMMENDATION, never a claim of confirmed exploitability.
 */

export const SEVERITY = Object.freeze(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const CONFIDENCE = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

const SEVERITY_RANK = Object.fromEntries(SEVERITY.map((s, i) => [s, i]));

function assertSeverity(value) {
  if (!SEVERITY.includes(value)) throw new Error(`invalid_severity:${value}`);
  return value;
}

function assertConfidence(value) {
  if (!CONFIDENCE.includes(value)) throw new Error(`invalid_confidence:${value}`);
  return value;
}

/**
 * Builds one finding. `evidence` must already be redacted by the caller
 * (see cyber-redact.js) — this function does not redact, it only shapes.
 *
 * category: a short machine-readable string, e.g. 'tls', 'headers',
 *   'cookies', 'cors', 'info_disclosure'.
 * observed: the literal fact seen (never an interpretation).
 * interpretation: what this fact plausibly means — hedged, not asserted.
 * recommendation: a concrete, actionable next step.
 */
export function finding({
  id, title, category, severity, confidence, asset, observed, interpretation, recommendation,
  evidence = [], references = [],
}) {
  if (typeof id !== 'string' || !id) throw new Error('finding_id_required');
  if (typeof title !== 'string' || !title) throw new Error('finding_title_required');
  if (typeof category !== 'string' || !category) throw new Error('finding_category_required');
  assertSeverity(severity);
  assertConfidence(confidence);
  if (typeof asset !== 'string' || !asset) throw new Error('finding_asset_required');
  if (typeof observed !== 'string' || !observed) throw new Error('finding_observed_required');
  // CRITICAL must never be reachable without HIGH confidence — a weak
  // signal can be severe-if-true, but must not be presented as
  // near-certain when confidence is LOW/MEDIUM.
  if (severity === 'CRITICAL' && confidence !== 'HIGH') {
    throw new Error('critical_requires_high_confidence');
  }
  return {
    id,
    title,
    category,
    severity,
    confidence,
    status: 'OPEN',
    asset,
    observed,
    interpretation: interpretation ?? '',
    recommendation: recommendation ?? '',
    evidenceIds: evidence.map(e => (typeof e === 'string' ? e : e.id)).filter(Boolean),
    references: [...references],
  };
}

export function compareSeverity(a, b) {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a]; // descending: CRITICAL first
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => compareSeverity(a.severity, b.severity) || a.title.localeCompare(b.title));
}
