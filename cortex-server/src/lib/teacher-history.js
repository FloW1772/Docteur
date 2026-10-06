// Professeur V2 (PROF-4) — read-only presentation of the append-only attempt history (learning_track_attempts).
// Only what the learner needs is returned: their own submission, the bounded verdict (score, criteria, feedback,
// remediation) and the provenance. Internal fields (path/step ids, model failure reason codes) are not exposed, and a
// corrupted row is surfaced as `corrupted: true` instead of breaking the whole history. Rows are never modified here.
import { EVIDENCE, TRACK_NAMES } from './teacher-progress.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const EVIDENCE_VALUES = Object.values(EVIDENCE);

function presentRemediation(raw) {
  if (!isPlainObject(raw)) return null;
  const focus = text(raw.focus, 160);
  const why = text(raw.why, 600);
  const retry = text(raw.retry, 600);
  if (!focus || !why || !retry) return null;
  return { focus, why, retry, source: ['model', 'criteria', 'checklist'].includes(raw.source) ? raw.source : 'criteria' };
}

function presentVerdict(raw) {
  if (!isPlainObject(raw) || typeof raw.passed !== 'boolean') return null;
  const criteria = Array.isArray(raw.criteria)
    ? raw.criteria
      .filter(c => isPlainObject(c) && typeof c.name === 'string' && typeof c.met === 'boolean')
      .slice(0, 10)
      .map(c => ({ name: c.name.slice(0, 160), met: c.met, ...(typeof c.comment === 'string' && c.comment ? { comment: c.comment.slice(0, 600) } : {}) }))
    : [];
  const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? Math.min(100, Math.max(0, Math.round(raw.score))) : 0;
  const remediation = presentRemediation(raw.remediation);
  return {
    passed: raw.passed === true && raw.invalid !== true,
    score,
    criteria,
    feedback: text(raw.feedback, 4000) ?? '',
    ...(raw.inconsistent === true ? { inconsistent: true } : {}),
    ...(raw.invalid === true ? { invalid: true } : {}),
    ...(raw.selfReported === true ? { selfReported: true } : {}),
    ...(remediation ? { remediation } : {}),
  };
}

function presentPayload(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  if (typeof raw.answer === 'string') out.answer = raw.answer.slice(0, 8000);
  if (raw.mode === 'self_report' || raw.mode === 'deliverable') out.mode = raw.mode;
  if (typeof raw.submission === 'string') out.submission = raw.submission.slice(0, 20000);
  if (Array.isArray(raw.confirmations) && raw.confirmations.every(v => typeof v === 'boolean')) out.confirmations = raw.confirmations.slice(0, 20);
  if (typeof raw.note === 'string' && raw.note) out.note = raw.note.slice(0, 2000);
  const checkin = presentCheckin(raw.checkin);
  if (checkin) out.checkin = checkin;
  return out;
}

// PROF-6 Sport Coach session check-in (whitelisted, bounded)
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
function presentCheckin(raw) {
  if (!isPlainObject(raw) || typeof raw.completed !== 'boolean') return null;
  const words = (list, len) => (Array.isArray(list) ? list.filter(s => typeof s === 'string').slice(0, 10).map(s => s.slice(0, len)) : []);
  return {
    completed: raw.completed,
    rpe: int(raw.rpe, 1, 10),
    unusual_pain: raw.unusual_pain === true,
    pain_areas: words(raw.pain_areas, 20),
    pain_worsening: raw.pain_worsening === true,
    technique_confidence: int(raw.technique_confidence, 1, 5),
    energy: int(raw.energy, 1, 5),
    unavailable_equipment: words(raw.unavailable_equipment, 60),
    comment: typeof raw.comment === 'string' ? raw.comment.slice(0, 500) : '',
  };
}

/** One stored attempt → its learner-facing view. `index` is the 1-based order of the attempt within its track. */
export function presentAttempt(row, index) {
  const verdict = presentVerdict(row?.verdict);
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    track: TRACK_NAMES.includes(row?.track) ? row.track : null,
    index,
    created_at: typeof row?.created_at === 'string' ? row.created_at : null,
    passed: row?.passed === true,
    evidence: EVIDENCE_VALUES.includes(row?.evidence) ? row.evidence : null,
    payload: presentPayload(row?.payload),
    verdict,
    ...(verdict ? {} : { corrupted: true }),
  };
}

/** Rows come ordered (created_at, rowid) from storage; numbering is per track, in that order. */
export function presentHistory(rows) {
  const counters = {};
  return (rows ?? []).map((row) => {
    const key = row?.track ?? '?';
    counters[key] = (counters[key] ?? 0) + 1;
    return presentAttempt(row, counters[key]);
  });
}
