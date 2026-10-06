// Professeur V2 (PROF-6) — Sport Coach adaptation loop. PURE and DETERMINISTIC: no model ever changes a program.
//
// After each session the athlete files a check-in (done?, RPE, unusual pain, technique confidence, energy, missing
// gear). Rules look at the TREND since the last adjustment — one bad session only produces an observation — and adjust
// the FUTURE sessions within hard bounds (level / youth caps, time budget, max step per adjustment). Every adjustment
// carries a readable reason. Pain is handled first: the area is spared and intensity reduced; repeated or worsening
// pain pauses the program and recommends a health professional. Sport Coach never diagnoses, treats or "rehabilitates".
import { EXERCISE_BY_ID, EXERCISES } from './sport-catalog.js';
import { BODY_AREAS, SPORT_EQUIPMENT, SPORT_LABELS } from './sport-profile.js';
import { sportContext, estimateMinutes, doseLabel } from './sport-program.js';

export const CHECKIN_LIMITS = Object.freeze({ rpe: [1, 10], technique: [1, 5], energy: [1, 5], comment: 500 });
const STEP = Object.freeze({ sets: 1, reps: 2, rpe: 1, rest: 15, cardioSec: 120, durationSec: 10 });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inRange = (n, [lo, hi]) => Number.isInteger(n) && n >= lo && n <= hi;
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const areaLabels = (areas) => areas.map(a => SPORT_LABELS.areas[a] ?? a).join(', ');

// ── check-in ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** @returns {{ ok: true, checkin } | { ok: false, errors: { field, code }[] }} */
export function validateCheckin(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ field: 'checkin', code: 'required' }] };
  const errors = [];
  if (typeof raw.completed !== 'boolean') errors.push({ field: 'completed', code: 'required' });
  if (raw.completed === true && !inRange(raw.rpe, CHECKIN_LIMITS.rpe)) errors.push({ field: 'rpe', code: 'out_of_range' });
  if (raw.completed === false && raw.rpe !== undefined && raw.rpe !== null && !inRange(raw.rpe, CHECKIN_LIMITS.rpe)) errors.push({ field: 'rpe', code: 'out_of_range' });
  if (typeof raw.unusual_pain !== 'boolean') errors.push({ field: 'unusual_pain', code: 'required' });
  const painAreas = raw.pain_areas ?? [];
  if (!Array.isArray(painAreas) || !painAreas.every(a => BODY_AREAS.includes(a))) errors.push({ field: 'pain_areas', code: 'invalid' });
  if (raw.unusual_pain === true && Array.isArray(painAreas) && painAreas.length === 0) errors.push({ field: 'pain_areas', code: 'required' });
  if (raw.pain_worsening !== undefined && typeof raw.pain_worsening !== 'boolean') errors.push({ field: 'pain_worsening', code: 'invalid' });
  if (!inRange(raw.technique_confidence, CHECKIN_LIMITS.technique)) errors.push({ field: 'technique_confidence', code: 'out_of_range' });
  if (!inRange(raw.energy, CHECKIN_LIMITS.energy)) errors.push({ field: 'energy', code: 'out_of_range' });
  const gear = raw.unavailable_equipment ?? [];
  if (!Array.isArray(gear) || !gear.every(g => typeof g === 'string' && g.length <= 60)) errors.push({ field: 'unavailable_equipment', code: 'invalid' });
  if (raw.comment !== undefined && (typeof raw.comment !== 'string' || raw.comment.length > CHECKIN_LIMITS.comment)) errors.push({ field: 'comment', code: 'invalid' });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    checkin: {
      completed: raw.completed,
      rpe: inRange(raw.rpe, CHECKIN_LIMITS.rpe) ? raw.rpe : null,
      unusual_pain: raw.unusual_pain,
      pain_areas: raw.unusual_pain ? [...new Set(painAreas)] : [],
      pain_worsening: raw.unusual_pain ? raw.pain_worsening === true : false,
      technique_confidence: raw.technique_confidence,
      energy: raw.energy,
      unavailable_equipment: [...new Set(gear)],
      comment: typeof raw.comment === 'string' ? raw.comment.trim() : '',
    },
  };
}

// ── context of an existing program ───────────────────────────────────────────────────────────────────────────────
export function programContext(athlete, program) {
  const unavailable = program.unavailable_equipment ?? [];
  const profile = {
    ...athlete,
    equipment: athlete.equipment.filter(e => !unavailable.includes(e)),
    custom_equipment: (athlete.custom_equipment ?? []).filter(e => !unavailable.includes(e)),
  };
  if (!profile.equipment.length) profile.equipment = ['aucun'];
  return sportContext(profile, { excludedAreas: program.excluded_areas ?? [], youth: program.youth === true });
}

const isMainWork = (e) => e.pattern !== 'mobility';
export function sessionTargetRpe(session) {
  const main = session.exercises.filter(isMainWork);
  const list = (main.length ? main : session.exercises).map(e => e.rpe);
  return Math.round(list.reduce((a, b) => a + b, 0) / Math.max(1, list.length));
}

/** Defensive check used before ANY adapted session is accepted. */
export function sessionViolations(session, ctx) {
  const b = ctx.bounds;
  const v = [];
  if (session.exercises.length < b.exercises[0] || session.exercises.length > b.exercises[1]) v.push('exercise_count');
  for (const e of session.exercises) {
    const cardio = e.pattern === 'cardio';
    if (!inRange(e.sets, cardio ? [1, 10] : b.sets)) v.push(`sets:${e.name}`);
    if (e.type === 'reps' && !inRange(e.reps, b.reps)) v.push(`reps:${e.name}`);
    if (e.type === 'duration' && !inRange(e.duration_sec, cardio ? [30, b.cardioSec[1]] : b.durationSec)) v.push(`duration:${e.name}`);
    if (!inRange(e.rest_sec, b.restSec)) v.push(`rest:${e.name}`);
    if (!inRange(e.rpe, b.rpe)) v.push(`rpe:${e.name}`);
    if (e.areas.some(a => ctx.excludedAreas.includes(a))) v.push(`area:${e.name}`);
    if (!e.equipment.every(q => ctx.equipment.includes(q) || ctx.customEquipment.includes(q))) v.push(`equipment:${e.name}`);
  }
  return v;
}

// ── exercise replacement (area to spare / missing gear / easier / harder) ────────────────────────────────────────
const catalogFeasible = (ex, ctx) => ex.equipment.every(q => ctx.equipment.includes(q))
  && ex.locations.some(l => ctx.locations.includes(l))
  && !ex.areas.some(a => ctx.excludedAreas.includes(a))
  && ctx.bounds.complexity.includes(ex.complexity);

function fromCatalog(cat, like, ctx) {
  const b = ctx.bounds;
  return {
    ...like,
    id: cat.id, name: cat.name, pattern: cat.pattern, type: cat.type, equipment: [...cat.equipment], areas: [...cat.areas],
    reps: cat.type === 'reps' ? clamp(like.reps ?? 10, b.reps) : null,
    duration_sec: cat.type === 'duration' ? clamp(like.duration_sec ?? 30, cat.pattern === 'cardio' ? [30, b.cardioSec[1]] : b.durationSec) : null,
    tempo: cat.type === 'reps' ? (like.tempo ?? '2-0-2') : null,
    cues: [...cat.cues], mistakes: [...cat.mistakes],
    easier: cat.easier && EXERCISE_BY_ID[cat.easier] && catalogFeasible(EXERCISE_BY_ID[cat.easier], ctx) ? EXERCISE_BY_ID[cat.easier].name : null,
    harder: cat.harder && EXERCISE_BY_ID[cat.harder] && catalogFeasible(EXERCISE_BY_ID[cat.harder], ctx) ? EXERCISE_BY_ID[cat.harder].name : null,
    substitution: null, note: undefined,
  };
}

/** A feasible stand-in for `ex` in `session` (same movement pattern), or null. Prefers its own listed variants. */
function replacementFor(ex, session, ctx, { prefer = [] } = {}) {
  const used = new Set(session.exercises.map(e => e.id).filter(Boolean));
  const cat = ex.id ? EXERCISE_BY_ID[ex.id] : null;
  const ordered = [...prefer, ...(cat?.substitutes ?? []), ...(cat ? [cat.easier] : [])].filter(Boolean);
  for (const id of ordered) {
    const c = EXERCISE_BY_ID[id];
    if (c && !used.has(c.id) && catalogFeasible(c, ctx)) return fromCatalog(c, ex, ctx);
  }
  const any = EXERCISES.find(c => c.pattern === ex.pattern && !used.has(c.id) && catalogFeasible(c, ctx));
  return any ? fromCatalog(any, ex, ctx) : null;
}

function ensureMinimum(session, ctx) {
  while (session.exercises.length < ctx.bounds.exercises[0]) {
    const used = new Set(session.exercises.map(e => e.id).filter(Boolean));
    const filler = EXERCISES.find(c => (c.pattern === 'mobility' || c.pattern === 'core') && !used.has(c.id) && catalogFeasible(c, ctx));
    if (!filler) break;
    session.exercises.push(fromCatalog(filler, { sets: ctx.bounds.sets[0], rest_sec: ctx.bounds.restSec[0], rpe: ctx.bounds.rpe[0], reps: 10, duration_sec: 30 }, ctx));
  }
}

// ── transforms (each returns a new session; bounds re-applied) ──────────────────────────────────────────────────
const clone = (s) => ({ ...s, exercises: s.exercises.map(e => ({ ...e, cues: [...e.cues], mistakes: [...e.mistakes] })) });

function lighter(session, ctx, { sets = 0, reps = 0, rpe = 0, rest = 0, cardio = 0 }) {
  const s = clone(session);
  const b = ctx.bounds;
  for (const e of s.exercises) {
    const isCardio = e.pattern === 'cardio';
    if (sets) e.sets = clamp(e.sets + sets, isCardio ? [1, 10] : b.sets);
    if (reps && e.type === 'reps') e.reps = clamp(e.reps + reps, b.reps);
    if (reps && e.type === 'duration' && !isCardio) e.duration_sec = clamp(e.duration_sec + Math.sign(reps) * STEP.durationSec, b.durationSec);
    if (cardio && isCardio) e.duration_sec = clamp(e.duration_sec + cardio, [30, b.cardioSec[1]]);
    if (rpe) e.rpe = clamp(e.rpe + rpe, b.rpe);
    if (rest && !isCardio) e.rest_sec = clamp(e.rest_sec + rest, b.restSec);
  }
  return s;
}

function swapAll(session, ctx, pick) {
  const s = clone(session);
  const changes = [];
  s.exercises = s.exercises.flatMap((e) => {
    const target = pick(e);
    if (target === undefined) return [e];
    if (target === null) { changes.push({ exercise: e.name, field: 'removed', from: e.name, to: null }); return []; }
    changes.push({ exercise: e.name, field: 'exercise', from: e.name, to: target.name });
    return [target];
  });
  ensureMinimum(s, ctx);
  return { session: s, changes };
}

function diffSession(before, after) {
  const changes = [];
  after.exercises.forEach((e, i) => {
    const p = before.exercises[i];
    if (!p || p.name !== e.name) return;
    for (const field of ['sets', 'reps', 'duration_sec', 'rest_sec', 'rpe']) {
      if (p[field] !== e[field] && e[field] !== null && e[field] !== undefined) changes.push({ exercise: e.name, field, from: p[field], to: e[field] });
    }
  });
  return changes;
}

function withinBudget(session, ctx, previous) {
  const cap = Math.max(ctx.minutes, estimateMinutes(previous));
  return estimateMinutes(session) <= cap;
}

function finalize(session) {
  return { ...session, estimated_minutes: estimateMinutes(session), summary: session.summary.replace(/~\d+ min$/, `~${estimateMinutes(session)} min`) };
}

// ── signals & rules ──────────────────────────────────────────────────────────────────────────────────────────────
export function checkinSignals(checkin, targetRpe) {
  return {
    pain: checkin.unusual_pain,
    worsening: checkin.unusual_pain && checkin.pain_worsening,
    missed: !checkin.completed,
    hard: checkin.completed && checkin.rpe !== null && checkin.rpe >= targetRpe + 2,
    easy: checkin.completed && checkin.rpe !== null && checkin.rpe <= targetRpe - 2,
    lowTechnique: checkin.technique_confidence <= 2,
    highTechnique: checkin.technique_confidence >= 4,
    lowEnergy: checkin.energy <= 2,
  };
}

const PRO_ADVICE = 'Si la douleur persiste ou s’aggrave, demande l’avis d’un professionnel de santé.';

/**
 * Decides what to do after the latest check-in.
 * @param {object} args
 *  - entries: [{ checkin, session_index, target_rpe }] in order, ONLY those since the last real adjustment (the window)
 *  - previousPain: whether the check-in right before the latest one (any window) reported unusual pain
 * @returns {{ rule, reason, kind: 'pause'|'adjust'|'observe'|'none', params? }}
 */
export function decideAdaptation({ entries, previousPain = false }) {
  const last = entries.at(-1);
  if (!last) return { kind: 'none', rule: 'none', reason: '' };
  const s = checkinSignals(last.checkin, last.target_rpe);
  const prev = entries.length >= 2 ? checkinSignals(entries.at(-2).checkin, entries.at(-2).target_rpe) : null;
  const twice = (k) => !!(prev && prev[k] && s[k]);

  if (s.pain && (s.worsening || previousPain)) {
    return { kind: 'pause', rule: 'pain_pause', reason: `Douleur inhabituelle ${s.worsening ? 'qui s’aggrave' : 'signalée à nouveau'} (${areaLabels(last.checkin.pain_areas)}) : programme en pause. Mets la zone au repos et demande l’avis d’un professionnel de santé avant de reprendre.` };
  }
  if (s.pain) {
    return { kind: 'adjust', rule: 'pain_reduce', params: { areas: last.checkin.pain_areas }, reason: `Douleur inhabituelle signalée (${areaLabels(last.checkin.pain_areas)}) : les exercices qui sollicitent cette zone sont retirés et l’intensité est réduite. ${PRO_ADVICE}` };
  }
  if (last.checkin.unavailable_equipment.length) {
    return { kind: 'adjust', rule: 'equipment_unavailable', params: { equipment: last.checkin.unavailable_equipment }, reason: `Matériel indisponible (${last.checkin.unavailable_equipment.map(e => SPORT_LABELS.equipment[e] ?? e).join(', ')}) : les exercices concernés sont remplacés par des alternatives faisables.` };
  }
  if (twice('missed')) return { kind: 'adjust', rule: 'missed_reduce', reason: 'Deux séances non terminées d’affilée : reprise avec un volume allégé pour retrouver le rythme.' };
  if (twice('hard') || (s.hard && s.lowEnergy && prev?.hard)) return { kind: 'adjust', rule: 'hard_reduce', reason: 'Deux séances ressenties nettement plus dures que prévu : volume et intensité réduits, repos allongé.' };
  if (twice('lowEnergy')) return { kind: 'adjust', rule: 'energy_reduce', reason: 'Énergie basse deux fois de suite : séances raccourcies (moins de séries, cardio plus court).' };
  if (twice('lowTechnique')) return { kind: 'adjust', rule: 'technique_regress', reason: 'Technique jugée difficile deux fois de suite : passage aux variantes plus faciles pour bien maîtriser le geste.' };
  if (twice('easy') && s.highTechnique && prev.highTechnique) {
    const harder = last.checkin.technique_confidence === 5 && entries.at(-2).checkin.technique_confidence === 5;
    return { kind: 'adjust', rule: harder ? 'easy_progress_harder' : 'easy_progress', reason: harder ? 'Séances faciles et technique maîtrisée : un exercice passe à sa variante plus difficile et l’intensité augmente légèrement.' : 'Deux séances faciles avec une bonne technique : légère augmentation (répétitions et intensité).' };
  }
  if (s.missed || s.hard || s.easy || s.lowEnergy || s.lowTechnique) {
    return { kind: 'observe', rule: 'observe', reason: 'Séance notée. Une seule séance ne suffit pas pour changer le programme : on regarde la suivante avant d’ajuster.' };
  }
  return { kind: 'none', rule: 'none', reason: '' };
}

/** Applies one decided adjustment to ONE future session. Returns { session, changes } (bounded) or null if rejected. */
export function adaptSession(session, decision, ctx) {
  let out; let changes = [];
  switch (decision.rule) {
    case 'pain_reduce':
    case 'resume': { // pain spared; after a pain pause the restart is gentler too
      const spared = swapAll(session, ctx, e => (e.areas.some(a => ctx.excludedAreas.includes(a)) ? replacementFor(e, session, ctx) : undefined));
      changes = spared.changes;
      out = lighter(spared.session, ctx, { sets: -STEP.sets, rpe: -STEP.rpe });
      break;
    }
    case 'equipment_unavailable': {
      const swapped = swapAll(session, ctx, e => {
        if (e.equipment.every(q => ctx.equipment.includes(q) || ctx.customEquipment.includes(q))) return undefined;
        if (e.substitution && e.substitution.equipment.every(q => ctx.equipment.includes(q) || ctx.customEquipment.includes(q)) && !e.areas.some(a => ctx.excludedAreas.includes(a))) {
          return { ...e, id: null, name: e.substitution.name, equipment: [...e.substitution.equipment], substitution: null, note: `Remplace « ${e.name} » (matériel indisponible).` };
        }
        return replacementFor(e, session, ctx);
      });
      changes = swapped.changes;
      out = swapped.session;
      break;
    }
    case 'missed_reduce': out = lighter(session, ctx, { sets: -STEP.sets }); break;
    case 'hard_reduce': out = lighter(session, ctx, { reps: -STEP.reps, rpe: -STEP.rpe, rest: STEP.rest, cardio: -STEP.cardioSec }); break;
    case 'energy_reduce': out = lighter(session, ctx, { sets: -STEP.sets, cardio: -STEP.cardioSec }); break;
    case 'technique_regress': {
      const easier = swapAll(session, ctx, e => {
        const cat = e.id ? EXERCISE_BY_ID[e.id] : null;
        const target = cat?.easier ? EXERCISE_BY_ID[cat.easier] : null;
        return target && catalogFeasible(target, ctx) && !session.exercises.some(x => x.id === target.id) ? fromCatalog(target, e, ctx) : undefined;
      });
      changes = easier.changes;
      out = lighter(easier.session, ctx, { rpe: -STEP.rpe });
      break;
    }
    case 'easy_progress': out = lighter(session, ctx, { reps: 1, rpe: STEP.rpe }); break;
    case 'easy_progress_harder': {
      let done = false;
      const harder = swapAll(session, ctx, e => {
        if (done) return undefined;
        const cat = e.id ? EXERCISE_BY_ID[e.id] : null;
        const target = cat?.harder ? EXERCISE_BY_ID[cat.harder] : null;
        if (!target || !catalogFeasible(target, ctx) || session.exercises.some(x => x.id === target.id)) return undefined;
        done = true;
        return fromCatalog(target, e, ctx);
      });
      changes = harder.changes;
      out = lighter(harder.session, ctx, { rpe: STEP.rpe });
      break;
    }
    default: return { session, changes: [] };
  }
  // increases must fit the time budget; otherwise the increase is dropped (never a heavier, longer session)
  if (!withinBudget(out, ctx, session)) {
    if (decision.rule.startsWith('easy_progress')) return { session, changes: [] };
    out = lighter(out, ctx, { sets: -STEP.sets });
  }
  const violations = sessionViolations(out, ctx);
  if (violations.length) return null; // fail closed: an adapted session out of bounds is never delivered
  const finalized = finalize(out);
  return { session: finalized, changes: [...changes, ...diffSession(session, finalized)] };
}

export const ADAPTATION_RULE_LABELS = Object.freeze({
  pain_pause: 'Pause (douleur)', pain_reduce: 'Douleur : zone épargnée', equipment_unavailable: 'Matériel indisponible',
  missed_reduce: 'Séances manquées', hard_reduce: 'Séances trop dures', energy_reduce: 'Énergie basse', technique_regress: 'Variantes plus faciles',
  easy_progress: 'Progression', easy_progress_harder: 'Variante plus difficile', observe: 'Observation', resume: 'Reprise en douceur',
});

/** Short human summary of a change list (for history / UI). */
export function describeChanges(changes) {
  return changes.slice(0, 12).map(c => {
    if (c.field === 'removed') return `${c.from} retiré`;
    if (c.field === 'exercise') return `${c.from} → ${c.to}`;
    const unit = { sets: 'séries', reps: 'rép.', duration_sec: 's', rest_sec: 's de repos', rpe: 'RPE' }[c.field] ?? c.field;
    return `${c.exercise} : ${c.field === 'rpe' ? `RPE ${c.from} → ${c.to}` : `${c.from} → ${c.to} ${unit}`}`;
  });
}

export { doseLabel, SPORT_EQUIPMENT };
