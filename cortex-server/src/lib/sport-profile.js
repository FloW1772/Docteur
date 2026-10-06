// Professeur V2 (PROF-5) — Sport Coach athlete profile: closed vocabularies, strict validation, deterministic safety
// screen. PURE (no I/O). Sport Coach is a training tool: it is not a doctor, a physiotherapist, a diagnostic tool or a
// prescriber. Situations that need a health professional are separated here, in code — never left to the model.

export const SPORT_GOALS = Object.freeze(['remise_en_forme', 'perte_de_poids', 'force', 'hypertrophie', 'endurance', 'mobilite', 'performance_generale', 'libre']);
export const SPORT_LEVELS = Object.freeze(['debutant', 'intermediaire', 'experimente']);
export const SPORT_LOCATIONS = Object.freeze(['maison', 'salle', 'exterieur']);
export const SPORT_EQUIPMENT = Object.freeze(['aucun', 'tapis', 'bandes', 'halteres', 'kettlebell', 'banc', 'barre', 'rack', 'velo', 'tapis_de_course']);
export const BODY_AREAS = Object.freeze(['nuque', 'epaule', 'coude', 'poignet', 'dos', 'hanche', 'genou', 'cheville']);
export const WEEK_DAYS = Object.freeze(['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']);
export const PROGRESSION_PACES = Object.freeze(['douce', 'standard', 'soutenue']);

export const SPORT_LABELS = Object.freeze({
  goals: { remise_en_forme: 'Remise en forme', perte_de_poids: 'Perte de poids', force: 'Force', hypertrophie: 'Hypertrophie', endurance: 'Endurance', mobilite: 'Mobilité', performance_generale: 'Performance générale', libre: 'Objectif libre' },
  levels: { debutant: 'Débutant', intermediaire: 'Habitué / intermédiaire', experimente: 'Expérimenté' },
  locations: { maison: 'Maison', salle: 'Salle', exterieur: 'Extérieur' },
  equipment: { aucun: 'Aucun matériel', tapis: 'Tapis', bandes: 'Bandes élastiques', halteres: 'Haltères', kettlebell: 'Kettlebell', banc: 'Banc', barre: 'Barre', rack: 'Rack', velo: 'Vélo', tapis_de_course: 'Tapis de course' },
  areas: { nuque: 'Nuque', epaule: 'Épaule', coude: 'Coude', poignet: 'Poignet', dos: 'Dos', hanche: 'Hanche', genou: 'Genou', cheville: 'Cheville' },
  progression: { douce: 'Douce', standard: 'Standard', soutenue: 'Soutenue' },
});

export const LIMITS = Object.freeze({
  sessionsPerWeek: [1, 6], sessionMinutes: [15, 120], weeks: [2, 8], maxSessions: 24, age: [8, 99], painIntensity: [0, 10],
  painStop: 7, // declared pain at/above this → no program, ask a professional (training guard, not a medical rule)
});

// Goals Sport Coach does not take: care, rehabilitation, treatment — those belong to a health professional.
const OUT_OF_SCOPE_GOAL = /r[ée]?[ée]ducation|r[ée]adaptation|gu[ée]rir|soigner|traiter|traitement|th[ée]rapie|kin[ée]|diagnosti|m[ée]dica|ordonnance/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN));
const inRange = (n, [lo, hi]) => Number.isInteger(n) && n >= lo && n <= hi;

function subsetOf(value, allowed, { min = 0 } = {}) {
  if (!Array.isArray(value)) return min === 0 && value === undefined ? [] : null;
  const out = [];
  for (const v of value) {
    if (!allowed.includes(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out.length >= min ? out : null;
}

function shortList(value, { max, len }) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim()) return null;
    out.push(v.trim().slice(0, len));
  }
  return out;
}

/**
 * @returns {{ ok: true, profile } | { ok: false, errors: { field: string, code: string }[] }}
 * Unknown fields are dropped; every kept field is bounded. Nothing is silently clamped: out-of-range → error.
 */
export function validateSportProfile(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ field: 'profile', code: 'not_an_object' }] };
  const errors = [];
  const err = (field, code) => errors.push({ field, code });

  const goal = raw.goal;
  if (!SPORT_GOALS.includes(goal)) err('goal', 'invalid');
  const goalCustom = str(raw.goal_custom, 200);
  if (goal === 'libre' && goalCustom.length < 3) err('goal_custom', 'required');
  if (goalCustom && OUT_OF_SCOPE_GOAL.test(goalCustom)) err('goal_custom', 'out_of_scope');

  const level = raw.level;
  if (!SPORT_LEVELS.includes(level)) err('level', 'invalid');

  const locations = subsetOf(raw.locations, SPORT_LOCATIONS, { min: 1 });
  if (!locations) err('locations', 'invalid');

  let equipment = subsetOf(raw.equipment ?? [], SPORT_EQUIPMENT);
  if (!equipment) err('equipment', 'invalid');
  else if (equipment.includes('aucun') && equipment.length > 1) err('equipment', 'conflict');
  else if (equipment.length === 0) equipment = ['aucun'];
  const customEquipment = shortList(raw.custom_equipment, { max: 5, len: 60 });
  if (!customEquipment) err('custom_equipment', 'invalid');

  const sessionsPerWeek = int(raw.sessions_per_week);
  if (!inRange(sessionsPerWeek, LIMITS.sessionsPerWeek)) err('sessions_per_week', 'out_of_range');
  const sessionMinutes = int(raw.session_minutes);
  if (!inRange(sessionMinutes, LIMITS.sessionMinutes)) err('session_minutes', 'out_of_range');
  const weeks = raw.weeks === undefined ? 4 : int(raw.weeks);
  if (!inRange(weeks, LIMITS.weeks)) err('weeks', 'out_of_range');
  if (inRange(sessionsPerWeek, LIMITS.sessionsPerWeek) && inRange(weeks, LIMITS.weeks) && sessionsPerWeek * weeks > LIMITS.maxSessions) err('weeks', 'program_too_long');

  const days = subsetOf(raw.days, WEEK_DAYS, { min: 1 });
  if (!days) err('days', 'invalid');
  else if (inRange(sessionsPerWeek, LIMITS.sessionsPerWeek) && days.length < sessionsPerWeek) err('days', 'not_enough_days');

  const liked = shortList(raw.liked, { max: 10, len: 60 });
  if (!liked) err('liked', 'invalid');
  const disliked = shortList(raw.disliked, { max: 10, len: 60 });
  if (!disliked) err('disliked', 'invalid');

  const limitationsRaw = raw.limitations === undefined ? {} : raw.limitations;
  const limitationAreas = isPlainObject(limitationsRaw) ? subsetOf(limitationsRaw.areas ?? [], BODY_AREAS) : null;
  if (!limitationAreas) err('limitations', 'invalid');

  const painRaw = raw.pain === undefined ? { present: false } : raw.pain;
  let pain = null;
  if (!isPlainObject(painRaw) || typeof painRaw.present !== 'boolean') err('pain', 'invalid');
  else if (!painRaw.present) pain = { present: false, areas: [], intensity: 0 };
  else {
    const areas = subsetOf(painRaw.areas ?? [], BODY_AREAS);
    const intensity = int(painRaw.intensity);
    if (!areas) err('pain.areas', 'invalid');
    if (!inRange(intensity, [1, LIMITS.painIntensity[1]])) err('pain.intensity', 'out_of_range');
    if (areas && inRange(intensity, [1, 10])) pain = { present: true, areas, intensity, worsening: painRaw.worsening === true };
  }

  let age = null;
  if (raw.age !== undefined && raw.age !== null && raw.age !== '') {
    age = int(raw.age);
    if (!inRange(age, LIMITS.age)) err('age', 'out_of_range');
  }

  const progression = raw.progression === undefined ? 'standard' : raw.progression;
  if (!PROGRESSION_PACES.includes(progression)) err('progression', 'invalid');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      goal, ...(goal === 'libre' ? { goal_custom: goalCustom } : {}),
      level, sport_history: str(raw.sport_history, 500), locations, equipment, custom_equipment: customEquipment,
      sessions_per_week: sessionsPerWeek, session_minutes: sessionMinutes, weeks, days,
      preferences: str(raw.preferences, 300), liked, disliked,
      limitations: { declared: isPlainObject(limitationsRaw) ? str(limitationsRaw.declared, 500) : '', areas: limitationAreas },
      pain, age, progression,
    },
  };
}

/** Youth context: declared minor, or the "enfant" register (audience information respected conservatively). */
export function isYouthContext(profile, register) {
  return register === 'enfant' || (Number.isInteger(profile?.age) && profile.age < 18);
}

/**
 * Deterministic safety screen, before any program is built.
 *  - high declared pain (≥ painStop) or pain declared as worsening → no program: rest + see a professional
 *  - otherwise the painful / limited areas are excluded from every exercise, with ONE calm notice (not per exercise)
 */
export function screenSportProfile(profile) {
  const pain = profile.pain ?? { present: false, areas: [], intensity: 0 };
  if (pain.present && (pain.intensity >= LIMITS.painStop || pain.worsening)) {
    return {
      allowed: false,
      code: 'SPORT_PAIN_STOP',
      message: 'Tu signales une douleur importante ou qui s’aggrave : Sport Coach ne te propose pas de programme pour l’instant. Mets la zone au repos et demande l’avis d’un professionnel de santé (médecin, kinésithérapeute) avant de reprendre.',
    };
  }
  const excludedAreas = [...new Set([...(pain.present ? pain.areas : []), ...(profile.limitations?.areas ?? [])])];
  const declared = profile.limitations?.declared;
  const notice = (excludedAreas.length || declared)
    ? `${excludedAreas.length ? `Zones épargnées : ${excludedAreas.map(a => SPORT_LABELS.areas[a]).join(', ')}. ` : ''}Si une douleur apparaît, persiste ou s’aggrave, arrête l’exercice concerné et demande l’avis d’un professionnel de santé.`
    : null;
  return { allowed: true, excludedAreas, notice };
}
