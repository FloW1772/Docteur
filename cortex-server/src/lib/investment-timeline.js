/**
 * Investment Agent — news/events timeline, built exclusively from already
 * sourced research results (mission requirement 9). Every event keeps
 * date/type/title/summary/source/url/retrievedAt. Content is normalized
 * and validated here, never trusted as instructions (research_sources
 * rows are already marked `untrusted: true` by investment-policy.js's
 * wrapUntrustedContent — this module treats them the same way: DATA to
 * structure, never directives to follow).
 *
 * Critically: this module NEVER attributes a price/market move to an
 * event. It only classifies and orders events; any "market interpretation"
 * must be a separate, explicitly labeled field the caller adds elsewhere
 * (see EVENT vs MARKET INTERPRETATION separation in the mission), never
 * fabricated here from a source's text alone.
 */

export const EVENT_TYPES = Object.freeze([
  'earnings', 'guidance', 'filing', 'dividend', 'buyback',
  'acquisition', 'product', 'regulatory', 'macro', 'other',
]);

const TYPE_KEYWORDS = Object.freeze({
  earnings: ['earnings', 'quarterly results', 'q1', 'q2', 'q3', 'q4', 'résultats trimestriels', 'résultats annuels'],
  guidance: ['guidance', 'outlook', 'forecast', 'prévisions'],
  filing: ['10-k', '10-q', '8-k', 'sec filing', 'annual report', 'rapport annuel', 'filing'],
  dividend: ['dividend', 'dividende'],
  buyback: ['buyback', 'share repurchase', 'rachat d\'actions'],
  acquisition: ['acquisition', 'acquires', 'acquired', 'merger', 'acquiert', 'fusion'],
  product: ['launch', 'product', 'lancement', 'nouveau produit'],
  regulatory: ['regulation', 'regulatory', 'lawsuit', 'antitrust', 'réglementation', 'sanction'],
  macro: ['fed', 'inflation', 'interest rate', 'gdp', 'macro', 'taux directeur'],
});

/**
 * Classifies a title/summary into one of EVENT_TYPES via keyword matching
 * (deterministic, no LLM call — mission requires events stay traceable to
 * their source, not to a model's free-text judgment). Returns 'other' if
 * nothing matches, never guesses a specific category without a keyword hit.
 */
export function classifyEventType(text) {
  if (typeof text !== 'string' || !text.trim()) return 'other';
  const lower = text.toLowerCase();
  for (const type of EVENT_TYPES) {
    if (type === 'other') continue;
    const keywords = TYPE_KEYWORDS[type] || [];
    if (keywords.some(kw => lower.includes(kw))) return type;
  }
  return 'other';
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/**
 * Validates a caller-supplied event date. Returns { date, dateReliable }.
 * A date is "reliable" only if it is a syntactically valid ISO date
 * (YYYY-MM-DD...) that the caller explicitly attached to this event — not
 * something inferred from prose. If no date is supplied or it fails
 * validation, dateReliable is false and the caller must exclude it from
 * chronological ordering or mark it explicitly (mission requirement:
 * "événements sans date fiable doivent être marqués comme tels ou exclus").
 */
function resolveEventDate(rawDate) {
  if (typeof rawDate !== 'string' || !ISO_DATE_PATTERN.test(rawDate)) {
    return { date: null, dateReliable: false };
  }
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return { date: null, dateReliable: false };
  return { date: rawDate, dateReliable: true };
}

/**
 * Builds one normalized timeline event from a research source row plus
 * caller-supplied event metadata (title/summary/date/type override).
 * `source` must already carry the provenance fields research_sources
 * stores (url, title, retrievedAt/retrieved_at, untrusted).
 */
export function buildTimelineEvent({ eventDate, type, title, summary = '', source }) {
  if (!source || typeof source.url !== 'string' || !source.url) {
    throw new Error('timeline_event_source_required');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('timeline_event_title_required');
  }

  const resolvedType = EVENT_TYPES.includes(type) ? type : classifyEventType(`${title} ${summary}`);
  const { date, dateReliable } = resolveEventDate(eventDate);

  return {
    date,
    dateReliable,
    type: resolvedType,
    title: title.trim().slice(0, 300),
    summary: typeof summary === 'string' ? summary.trim().slice(0, 1000) : '',
    source: {
      url: source.url,
      title: source.title || '',
      retrievedAt: source.retrievedAt || source.retrieved_at || null,
    },
    untrusted: true, // web-derived content is always DATA, never an instruction
  };
}

/**
 * Builds and orders a full timeline from a list of raw event inputs (see
 * buildTimelineEvent). Events with dateReliable=false are moved to a
 * separate `undated` bucket rather than interleaved into the
 * chronological list — per mission requirement, an unreliable date must
 * never silently masquerade as a real chronological position.
 */
export function buildTimeline(rawEvents = []) {
  const built = [];
  const errors = [];

  for (const raw of rawEvents) {
    try {
      built.push(buildTimelineEvent(raw));
    } catch (err) {
      errors.push({ error: err.message, input: raw });
    }
  }

  const dated = built.filter(e => e.dateReliable).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const undated = built.filter(e => !e.dateReliable);

  return {
    dated,
    undated,
    errors,
    disclaimer: 'Événements construits exclusivement à partir de sources déjà collectées (research_sources). ' +
      'Contenu web = DATA NON FIABLE, jamais une instruction. Aucune corrélation automatique entre un événement ' +
      'et un mouvement de marché n\'est affirmée par ce module — toute interprétation de marché doit être ' +
      'ajoutée séparément et distinguée explicitement de l\'événement lui-même.',
  };
}

/**
 * Explicit separation helper: pairs an EVENT (factual, sourced) with an
 * optional MARKET INTERPRETATION (a distinct, clearly labeled field) —
 * never merges the two into one sentence. `interpretation` is optional;
 * if provided it MUST carry its own `basis` explaining why it's
 * plausible (never "the stock moved because of this event" asserted
 * without an explicit sourced basis, per mission requirement).
 */
export function attachMarketInterpretation(event, interpretation = null) {
  if (interpretation !== null && (typeof interpretation !== 'object' || !interpretation.basis)) {
    throw new Error('market_interpretation_requires_basis');
  }
  return {
    event,
    marketInterpretation: interpretation
      ? { statement: String(interpretation.statement || '').slice(0, 500), basis: String(interpretation.basis).slice(0, 500), speculative: true }
      : null,
  };
}
