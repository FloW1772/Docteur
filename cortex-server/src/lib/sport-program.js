// Professeur V2 (PROF-5) — Sport Coach program engine. PURE (no I/O, no model call).
//
//   profile ──► session TEMPLATES ──► fitted to the time budget ──► expanded over the weeks with a level-based
//               (model proposal,       (warm-up + work + rest +       progression ──► one module per session
//                strictly validated,    cool-down ≤ session length)                     (theory = understand it,
//                else catalog)                                                           practice = do it, SELF_REPORTED)
//
// Every number is bounded by the athlete's LEVEL (and a youth context); every exercise must be feasible with the
// declared equipment and location, and must not load an excluded (painful / limited) area. A model proposal that
// breaks any rule — or contains unsafe text — is rejected as a whole and replaced by the catalog program: nothing out
// of bounds is ever accepted silently.
import { EXERCISES, EXERCISE_BY_ID, WARMUP, COOLDOWN } from './sport-catalog.js';
import { SPORT_EQUIPMENT, BODY_AREAS, SPORT_LABELS } from './sport-profile.js';

export const PATTERNS = Object.freeze(['lower', 'hinge', 'push', 'pull', 'core', 'cardio', 'mobility']);
export const PATTERN_LABELS = Object.freeze({ lower: 'bas du corps', hinge: 'chaîne postérieure', push: 'poussée', pull: 'tirage', core: 'gainage', cardio: 'cardio', mobility: 'mobilité' });

export const LEVEL_PARAMS = Object.freeze({
  debutant: { sets: [1, 3], reps: [6, 20], durationSec: [15, 60], cardioSec: [60, 1200], restSec: [30, 120], rpe: [3, 6], exercises: [3, 6], complexity: ['basic'] },
  intermediaire: { sets: [2, 4], reps: [5, 20], durationSec: [20, 90], cardioSec: [60, 2400], restSec: [30, 150], rpe: [3, 8], exercises: [3, 8], complexity: ['basic', 'intermediate'] },
  experimente: { sets: [2, 5], reps: [3, 20], durationSec: [20, 120], cardioSec: [60, 3600], restSec: [30, 240], rpe: [3, 9], exercises: [3, 10], complexity: ['basic', 'intermediate', 'advanced'] },
});
const YOUTH = { rpeMax: 7, repsMin: 8, complexity: ['basic', 'intermediate'] };
const COMPLEXITY_RANK = { basic: 0, intermediate: 1, advanced: 2 };

// Goal → session slots and dose per level (reps or seconds, rest, RPE). Catalog program only.
const GOALS = {
  force: { slots: ['lower', 'hinge', 'push', 'pull', 'core'], reps: [8, 6, 5], rest: [90, 120, 150], rpe: [6, 7, 8] },
  hypertrophie: { slots: ['lower', 'push', 'pull', 'hinge', 'push', 'core'], reps: [12, 10, 10], rest: [60, 75, 90], rpe: [6, 7, 8] },
  endurance: { slots: ['cardio', 'lower', 'push', 'core'], reps: [15, 15, 15], rest: [30, 30, 45], rpe: [5, 6, 7], cardioShare: 0.4 },
  mobilite: { slots: ['mobility', 'mobility', 'mobility', 'core', 'mobility'], reps: [10, 10, 12], rest: [30, 30, 30], rpe: [3, 3, 4] },
  perte_de_poids: { slots: ['cardio', 'lower', 'push', 'pull', 'core'], reps: [12, 12, 12], rest: [45, 45, 60], rpe: [5, 6, 7], cardioShare: 0.3 },
  default: { slots: ['lower', 'push', 'pull', 'core', 'cardio'], reps: [12, 12, 10], rest: [45, 60, 60], rpe: [5, 6, 7], cardioShare: 0.15 },
};
const LEVEL_INDEX = { debutant: 0, intermediaire: 1, experimente: 2 };
const PACE_STEP = { douce: 0.5, standard: 1, soutenue: 1.5 };
const DAY_LABELS = { lundi: 'Lundi', mardi: 'Mardi', mercredi: 'Mercredi', jeudi: 'Jeudi', vendredi: 'Vendredi', samedi: 'Samedi', dimanche: 'Dimanche' };

// ── context ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Everything the engine needs, derived once from a VALIDATED profile + the safety screen. */
export function sportContext(profile, { excludedAreas = [], youth = false } = {}) {
  const base = LEVEL_PARAMS[profile.level];
  const bounds = {
    ...base,
    rpe: [base.rpe[0], youth ? Math.min(base.rpe[1], YOUTH.rpeMax) : base.rpe[1]],
    reps: [youth ? Math.max(base.reps[0], YOUTH.repsMin) : base.reps[0], base.reps[1]],
    complexity: youth ? base.complexity.filter(c => YOUTH.complexity.includes(c)) : base.complexity,
  };
  const equipment = profile.equipment.filter(e => e !== 'aucun');
  return {
    profile, bounds, youth, excludedAreas,
    equipment, customEquipment: profile.custom_equipment ?? [],
    locations: profile.locations,
    minutes: profile.session_minutes,
    level: profile.level, levelIndex: LEVEL_INDEX[profile.level],
    disliked: (profile.disliked ?? []).map(s => s.toLowerCase()), liked: (profile.liked ?? []).map(s => s.toLowerCase()),
  };
}

const hasEquipment = (needed, ctx) => (needed ?? []).every(e => ctx.equipment.includes(e) || ctx.customEquipment.includes(e));
const isFeasible = (ex, ctx) => hasEquipment(ex.equipment, ctx)
  && ex.locations.some(l => ctx.locations.includes(l))
  && !ex.areas.some(a => ctx.excludedAreas.includes(a))
  && ctx.bounds.complexity.includes(ex.complexity)
  && !ctx.disliked.some(d => ex.name.toLowerCase().includes(d));
const feasibleName = (id, ctx) => (id && EXERCISE_BY_ID[id] && isFeasible(EXERCISE_BY_ID[id], ctx) ? EXERCISE_BY_ID[id].name : null);

// ── safety scan (code-level, not just a prompt) ─────────────────────────────────────────────────────────────────
const UNSAFE_RULES = [
  { code: 'continue_despite_pain', re: /(continu\w*|pousse\w*|poursui\w*|termine\w*|serre\w* les dents)[^.!?\n]{0,50}(malgr[ée]|m[êe]me avec|en d[ée]pit d[eu])[^.!?\n]{0,20}(la |une |ta |votre |de la )?(douleur|mal)/i },
  { code: 'continue_despite_pain', re: /(ignore\w*|n[ée]glige\w*|oublie\w*)[^.!?\n]{0,25}(la |ta |votre |cette )?douleur/i },
  { code: 'continue_despite_pain', re: /no pain,?\s*no gain|la douleur (est|c'est) (normale|un bon signe|bon signe)/i },
  { code: 'diagnosis', re: /(tu as|vous avez|tu souffres? d['e ]|vous souffrez d['e ]|il s'agit d['e ]|c'est)\s*(s[ûu]rement |probablement |s[ûu]rement pas )?(une?\s+|des\s+|d'une?\s+)?(tendinite|entorse|hernie|fracture|d[ée]chirure|lombalgie|sciatique|arthrose|inflammation|l[ée]sion|syndrome|pubalgie|bursite)/i },
  { code: 'diagnosis', re: /\bdiagnosti(c|que)\s*:/i },
  { code: 'treatment', re: /(prends|prenez|prendre)\s+(un |une |des |de l'|du )?(anti-?inflammatoires?|ibuprof[eè]ne|parac[ée]tamol|antalgiques?|m[ée]dicaments?|cortico\w*)/i },
  { code: 'treatment', re: /\b(posologie|ordonnance|infiltration)\b/i },
  { code: 'medical_authorization', re: /(tu es|vous [êe]tes|est)\s+(m[ée]dicalement\s+)?(apte|autoris[ée]e?s?)\s+(m[ée]dicalement|[àa] (reprendre|faire))/i },
  { code: 'medical_authorization', re: /(pas besoin|inutile)\s+(de|d')\s*(consulter|voir un m[ée]decin|demander un avis|avis m[ée]dical)/i },
  { code: 'rehabilitation', re: /(programme|protocole|s[ée]ance|exercices?) de (r[ée][ée]ducation|r[ée]adaptation)/i },
];

/** @returns {{ code: string } | null} the first unsafe pattern found in `text` */
export function sportSafetyScan(text) {
  const s = String(text ?? '');
  for (const rule of UNSAFE_RULES) if (rule.re.test(s)) return { code: rule.code };
  return null;
}

// ── dose & duration ─────────────────────────────────────────────────────────────────────────────────────────────
const REP_SECONDS = 4; // ~2-0-2 tempo
export function workSeconds(ex) { return ex.type === 'reps' ? (ex.reps ?? 0) * REP_SECONDS : (ex.duration_sec ?? 0); }
export function exerciseSeconds(ex) { return ex.sets * workSeconds(ex) + Math.max(0, ex.sets - 1) * ex.rest_sec + 30; } // +30s setup
function bookends(minutes) {
  const [w, c] = minutes <= 20 ? [180, 120] : minutes <= 45 ? [300, 240] : [480, 300];
  const scale = (items, total) => { const sum = items.reduce((a, i) => a + i.duration_sec, 0); return items.map(i => ({ name: i.name, duration_sec: Math.round((i.duration_sec / sum) * total) })); };
  return { warmup: scale(WARMUP, w), cooldown: scale(COOLDOWN, c) };
}
export function estimateMinutes({ warmup, cooldown, exercises }) {
  const total = [...warmup, ...cooldown].reduce((a, b) => a + b.duration_sec, 0) + exercises.reduce((a, e) => a + exerciseSeconds(e), 0);
  return Math.round(total / 60);
}
export const doseLabel = (ex) => `${ex.sets} × ${ex.type === 'reps' ? `${ex.reps} rép.` : (ex.duration_sec >= 120 ? `${Math.round(ex.duration_sec / 60)} min` : `${ex.duration_sec} s`)}`;

// ── catalog program ─────────────────────────────────────────────────────────────────────────────────────────────
function prescribe(ex, ctx, goal) {
  const li = ctx.levelIndex;
  const b = ctx.bounds;
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  const sets = ex.pattern === 'mobility' ? b.sets[0] + (li > 0 ? 1 : 0) : clamp(b.sets[0] + 1 + (li === 2 ? 1 : 0), b.sets);
  let reps = null; let duration = null;
  if (ex.type === 'reps') reps = clamp(goal.reps[li], b.reps);
  else if (ex.pattern === 'cardio') {
    const share = goal.cardioShare ?? 0.15;
    duration = clamp(Math.round((ctx.minutes * 60 * share) / 60) * 60, b.cardioSec);
  } else duration = clamp(ex.pattern === 'mobility' ? 40 : 30 + 10 * li, b.durationSec);
  const cardioSets = ex.pattern === 'cardio' ? 1 : sets;
  return {
    id: ex.id, name: ex.name, pattern: ex.pattern, type: ex.type, equipment: [...ex.equipment], areas: [...ex.areas],
    sets: cardioSets, reps, duration_sec: duration,
    rest_sec: ex.pattern === 'cardio' ? b.restSec[0] : clamp(goal.rest[li], b.restSec),
    tempo: ex.type === 'reps' ? '2-0-2' : null,
    rpe: clamp(ex.pattern === 'mobility' ? b.rpe[0] : goal.rpe[li], b.rpe),
    cues: [...ex.cues], mistakes: [...ex.mistakes],
    easier: feasibleName(ex.easier, ctx), harder: feasibleName(ex.harder, ctx),
    substitution: substitutionFor(ex, ctx),
  };
}

/** An alternative the athlete can do with their gear (with/without equipment), for when the station is busy, etc. */
function substitutionFor(ex, ctx) {
  for (const id of ex.substitutes ?? []) {
    const sub = EXERCISE_BY_ID[id];
    if (sub && sub.id !== ex.id && isFeasible(sub, ctx)) return { name: sub.name, equipment: [...sub.equipment] };
  }
  return null;
}

function pickExercise(pattern, ctx, used, variant) {
  const candidates = EXERCISES
    .filter(e => e.pattern === pattern && !used.has(e.id) && isFeasible(e, ctx))
    .map(e => ({ e, score: (ctx.liked.some(l => e.name.toLowerCase().includes(l)) ? 10 : 0) + COMPLEXITY_RANK[e.complexity] * 2 + e.equipment.length }))
    .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  if (!candidates.length) return null;
  return candidates[Math.min(variant, candidates.length - 1)].e;
}

function fitToBudget(template, ctx) {
  const t = { ...template, exercises: template.exercises.map(e => ({ ...e })) };
  const fits = () => estimateMinutes(t) <= ctx.minutes;
  for (let guard = 0; !fits() && guard < 60; guard++) {
    const reducible = [...t.exercises].reverse().find(e => e.sets > (e.pattern === 'cardio' ? 1 : ctx.bounds.sets[0]));
    if (reducible) { reducible.sets -= 1; continue; }
    const cardio = t.exercises.find(e => e.pattern === 'cardio' && e.duration_sec > ctx.bounds.cardioSec[0]);
    if (cardio) { cardio.duration_sec = Math.max(ctx.bounds.cardioSec[0], cardio.duration_sec - 60); continue; }
    if (t.exercises.length > ctx.bounds.exercises[0]) { t.exercises.pop(); continue; }
    break;
  }
  return t;
}

export function catalogTemplates(ctx) {
  const goal = GOALS[ctx.profile.goal] ?? GOALS.default;
  const count = Math.min(ctx.profile.sessions_per_week, 3);
  const goalLabel = ctx.profile.goal === 'libre' ? 'objectif personnel' : SPORT_LABELS.goals[ctx.profile.goal].toLowerCase();
  const { warmup, cooldown } = bookends(ctx.minutes);
  const templates = [];
  for (let v = 0; v < count; v++) {
    const used = new Set();
    const exercises = [];
    for (const slot of goal.slots.slice(0, ctx.bounds.exercises[1])) {
      const ex = pickExercise(slot, ctx, used, v) ?? pickExercise(slot, ctx, used, 0) ?? pickExercise('mobility', ctx, used, v);
      if (!ex) continue;
      used.add(ex.id);
      exercises.push(prescribe(ex, ctx, goal));
    }
    while (exercises.length < ctx.bounds.exercises[0]) { // always a complete session (mobility / core are equipment-free)
      const ex = pickExercise('mobility', ctx, used, 0) ?? pickExercise('core', ctx, used, 0);
      if (!ex) break;
      used.add(ex.id);
      exercises.push(prescribe(ex, ctx, goal));
    }
    const key = String.fromCharCode(65 + v);
    const focus = [...new Set(exercises.map(e => PATTERN_LABELS[e.pattern]))].join(', ');
    templates.push(fitToBudget({ key, name: `Séance ${key} — ${goalLabel}`, focus, warmup, cooldown, exercises }, ctx));
  }
  return templates;
}

// ── model proposal: strict validation ──────────────────────────────────────────────────────────────────────────
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inRange = (n, [lo, hi]) => Number.isInteger(n) && n >= lo && n <= hi;
const okText = (v, max) => typeof v === 'string' && v.trim().length >= 2 && v.length <= max;
const textList = (v, min, max, len) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(s => typeof s === 'string' && s.trim() && s.length <= len);

function validEquipmentList(list, ctx) {
  return Array.isArray(list) && list.every(e => typeof e === 'string' && ((SPORT_EQUIPMENT.includes(e) && e !== 'aucun') || ctx.customEquipment.includes(e)));
}

function validateModelExercise(raw, ctx) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'exercise_not_object' };
  const b = ctx.bounds;
  if (!okText(raw.name, 80)) return { ok: false, reason: 'exercise_name' };
  if (!PATTERNS.includes(raw.pattern)) return { ok: false, reason: 'exercise_pattern' };
  if (raw.type !== 'reps' && raw.type !== 'duration') return { ok: false, reason: 'exercise_type' };
  if (!validEquipmentList(raw.equipment, ctx)) return { ok: false, reason: 'equipment_unknown' };
  if (!Array.isArray(raw.areas) || !raw.areas.every(a => BODY_AREAS.includes(a))) return { ok: false, reason: 'areas_invalid' };
  if (raw.areas.some(a => ctx.excludedAreas.includes(a))) return { ok: false, reason: 'excluded_area' };
  const cardio = raw.pattern === 'cardio';
  if (!inRange(raw.sets, cardio ? [1, 10] : b.sets)) return { ok: false, reason: 'sets_out_of_bounds' };
  if (raw.type === 'reps' && !inRange(raw.reps, b.reps)) return { ok: false, reason: 'reps_out_of_bounds' };
  if (raw.type === 'duration') {
    if (!inRange(raw.duration_sec, cardio ? [30, b.cardioSec[1]] : b.durationSec)) return { ok: false, reason: 'duration_out_of_bounds' };
    if (cardio && raw.sets * raw.duration_sec > b.cardioSec[1]) return { ok: false, reason: 'cardio_volume_out_of_bounds' };
  }
  if (!inRange(raw.rest_sec, b.restSec)) return { ok: false, reason: 'rest_out_of_bounds' };
  if (!inRange(raw.rpe, b.rpe)) return { ok: false, reason: 'rpe_out_of_bounds' };
  if (raw.tempo !== undefined && raw.tempo !== null && !(typeof raw.tempo === 'string' && /^\d-\d-\d(-\d)?$/.test(raw.tempo))) return { ok: false, reason: 'tempo_invalid' };
  if (!textList(raw.cues, 1, 4, 120)) return { ok: false, reason: 'cues_invalid' };
  if (raw.mistakes !== undefined && !textList(raw.mistakes, 0, 4, 120)) return { ok: false, reason: 'mistakes_invalid' };
  for (const k of ['easier', 'harder']) if (raw[k] !== undefined && raw[k] !== null && !okText(raw[k], 80)) return { ok: false, reason: `${k}_invalid` };
  let substitution = null;
  if (raw.substitution !== undefined && raw.substitution !== null) {
    if (!isPlainObject(raw.substitution) || !okText(raw.substitution.name, 80) || !validEquipmentList(raw.substitution.equipment, ctx)) return { ok: false, reason: 'substitution_invalid' };
    substitution = { name: raw.substitution.name.trim(), equipment: [...raw.substitution.equipment] };
  }
  let name = raw.name.trim(); let equipment = [...raw.equipment];
  let note = null;
  if (!hasEquipment(equipment, ctx)) {
    // missing gear: the declared substitution must be feasible, else the proposal is unusable
    if (!substitution || !hasEquipment(substitution.equipment, ctx)) return { ok: false, reason: 'equipment_unavailable' };
    note = `Remplace « ${name} » (matériel absent).`;
    [name, equipment, substitution] = [substitution.name, substitution.equipment, null];
  }
  return {
    ok: true,
    exercise: {
      id: null, name, pattern: raw.pattern, type: raw.type, equipment, areas: [...raw.areas],
      sets: raw.sets, reps: raw.type === 'reps' ? raw.reps : null, duration_sec: raw.type === 'duration' ? raw.duration_sec : null,
      rest_sec: raw.rest_sec, tempo: raw.tempo ?? null, rpe: raw.rpe,
      cues: raw.cues.map(s => s.trim()), mistakes: (raw.mistakes ?? []).map(s => s.trim()),
      easier: raw.easier?.trim() || null, harder: raw.harder?.trim() || null, substitution, ...(note ? { note } : {}),
    },
  };
}

/** @returns {{ ok: true, templates } | { ok: false, reason }} — all-or-nothing */
export function validateModelTemplates(raw, ctx) {
  const list = isPlainObject(raw) ? raw.templates : null;
  if (!Array.isArray(list) || list.length < 1 || list.length > 3) return { ok: false, reason: 'templates_count' };
  const { warmup, cooldown } = bookends(ctx.minutes);
  const templates = [];
  for (const [i, t] of list.entries()) {
    if (!isPlainObject(t) || !okText(t.name, 80) || (t.focus !== undefined && typeof t.focus !== 'string')) return { ok: false, reason: 'template_invalid' };
    if (!Array.isArray(t.exercises) || !inRange(t.exercises.length, ctx.bounds.exercises)) return { ok: false, reason: 'exercise_count' };
    const exercises = [];
    for (const e of t.exercises) {
      const checked = validateModelExercise(e, ctx);
      if (!checked.ok) return checked;
      exercises.push(checked.exercise);
    }
    const template = { key: String.fromCharCode(65 + i), name: t.name.trim(), focus: String(t.focus ?? '').slice(0, 160), warmup, cooldown, exercises };
    const unsafe = sportSafetyScan(JSON.stringify(template));
    if (unsafe) return { ok: false, reason: `unsafe_text:${unsafe.code}` };
    const minutes = estimateMinutes(template);
    if (minutes > Math.ceil(ctx.minutes * 1.1)) return { ok: false, reason: 'too_long' };
    if (minutes < Math.floor(ctx.minutes * 0.4)) return { ok: false, reason: 'too_short' };
    templates.push(template);
  }
  return { ok: true, templates };
}

export function buildSportProgramPrompt({ profile, ctx, registerInstruction }) {
  const b = ctx.bounds;
  const gear = [...ctx.equipment, ...ctx.customEquipment];
  const goal = profile.goal === 'libre' ? `objectif libre : ${profile.goal_custom}` : SPORT_LABELS.goals[profile.goal];
  return [
    {
      role: 'system',
      content: `Tu es un coach sportif (pas un médecin, pas un kinésithérapeute : tu ne diagnostiques rien, ne prescris aucun traitement et ne fais pas de rééducation). ${registerInstruction}\n\nConçois 1 à 3 modèles de séance (A, B, C) qui seront répétés et progressés semaine après semaine. Réponds UNIQUEMENT avec un JSON : {"templates":[{"name":"...","focus":"...","exercises":[{"name":"...","pattern":"lower|hinge|push|pull|core|cardio|mobility","type":"reps|duration","equipment":[...],"areas":[...],"sets":n,"reps":n (si reps),"duration_sec":n (si duration),"rest_sec":n,"tempo":"2-0-2","rpe":n,"cues":["..."],"mistakes":["..."],"easier":"...","harder":"...","substitution":{"name":"...","equipment":[...]}}]}]}.\nRègles STRICTES (sinon la proposition est rejetée) : ${b.exercises[0]} à ${b.exercises[1]} exercices par séance ; séries ${b.sets[0]}-${b.sets[1]} ; répétitions ${b.reps[0]}-${b.reps[1]} ; durée ${b.durationSec[0]}-${b.durationSec[1]} s (cardio jusqu'à ${b.cardioSec[1]} s au total) ; repos ${b.restSec[0]}-${b.restSec[1]} s ; RPE ${b.rpe[0]}-${b.rpe[1]} ; séance complète (échauffement ~${Math.round(bookends(ctx.minutes).warmup.reduce((a, w) => a + w.duration_sec, 0) / 60)} min et retour au calme inclus) ≤ ${ctx.minutes} min. "equipment" uniquement parmi : ${gear.length ? gear.join(', ') : '(aucun matériel : poids du corps uniquement)'} ; un exercice qui demande un autre matériel DOIT avoir une "substitution" faisable. "areas" = zones sollicitées parmi ${BODY_AREAS.join(', ')}${ctx.excludedAreas.length ? ` ; n'utilise AUCUN exercice sollicitant : ${ctx.excludedAreas.join(', ')}` : ''}. Jamais de conseil de continuer malgré une douleur.`,
    },
    {
      role: 'user',
      content: `Profil : objectif ${goal} ; niveau ${SPORT_LABELS.levels[profile.level]} ; lieux ${profile.locations.join(', ')} ; ${profile.sessions_per_week} séance(s)/semaine de ${profile.session_minutes} min${profile.sport_history ? ` ; historique : ${profile.sport_history}` : ''}${profile.preferences ? ` ; préférences : ${profile.preferences}` : ''}${profile.liked?.length ? ` ; aime : ${profile.liked.join(', ')}` : ''}${profile.disliked?.length ? ` ; n'aime pas : ${profile.disliked.join(', ')}` : ''}${ctx.youth ? ' ; jeune pratiquant : technique d\'abord, charges légères' : ''}.`,
    },
  ];
}

// ── weeks, progression, sessions ────────────────────────────────────────────────────────────────────────────────
/** Week-by-week progression bounded by level / youth caps and the time budget (never beyond any bound). */
// Monotonic: a later week is never lighter than the previous one (field by field). Increments that would not fit the
// time budget are dropped (sets first, then extra time); if nothing fits, the previous week is repeated as is.
const notLighter = (candidate, previous) => candidate.exercises.every((e, i) => {
  const p = previous.exercises[i];
  return e.sets >= p.sets && (e.reps ?? 0) >= (p.reps ?? 0) && (e.duration_sec ?? 0) >= (p.duration_sec ?? 0) && e.rpe >= p.rpe;
});

export function progressTemplate(template, weekIndex, ctx, previous = template) {
  const step = PACE_STEP[ctx.profile.progression] ?? 1;
  const b = ctx.bounds;
  const units = Math.floor(weekIndex * step);
  const budget = Math.max(ctx.minutes, estimateMinutes(template));
  const build = ({ addSet, addTime }) => ({
    ...template,
    exercises: template.exercises.map(e => {
      if (e.pattern === 'mobility') return { ...e };
      const next = { ...e };
      if (e.type === 'reps') next.reps = Math.min(b.reps[1], e.reps + units);
      else if (addTime && e.pattern === 'cardio') next.duration_sec = Math.min(b.cardioSec[1], e.duration_sec + 60 * units);
      else if (addTime) next.duration_sec = Math.min(b.durationSec[1], e.duration_sec + 5 * units);
      if (addSet && ctx.levelIndex > 0 && units >= 2 && e.pattern !== 'cardio') next.sets = Math.min(b.sets[1], e.sets + 1);
      next.rpe = Math.min(b.rpe[1], e.rpe + Math.floor(units / 2));
      return next;
    }),
  });
  for (const variant of [{ addSet: true, addTime: true }, { addSet: false, addTime: true }, { addSet: false, addTime: false }]) {
    const p = build(variant);
    if (estimateMinutes(p) <= budget && notLighter(p, previous)) return p;
  }
  return { ...previous, exercises: previous.exercises.map(e => ({ ...e })) };
}

export function expandProgram(templates, ctx) {
  const days = ctx.profile.days.slice(0, ctx.profile.sessions_per_week);
  const sessions = [];
  const lastWeek = {}; // template key → last delivered version (progression never goes backwards)
  for (let w = 0; w < ctx.profile.weeks; w++) {
    days.forEach((day, i) => {
      const base = templates[i % templates.length];
      const template = progressTemplate(base, w, ctx, lastWeek[base.key] ?? base);
      lastWeek[base.key] = template;
      const index = sessions.length;
      sessions.push({
        index, week: w + 1, day, template: template.key,
        title: `S${index + 1} · Semaine ${w + 1} · ${DAY_LABELS[day]} — ${template.name}`,
        summary: `${template.focus} · ~${estimateMinutes(template)} min`,
        warmup: template.warmup, exercises: template.exercises, cooldown: template.cooldown,
        estimated_minutes: estimateMinutes(template),
      });
    });
  }
  return sessions;
}

/** Practice spec of one session module: the real workout, validated by self-report only (never VERIFIED). */
export function workoutPracticeSpec(session) {
  return {
    kind: 'workout',
    instructions: `${session.title}. Durée estimée : ~${session.estimated_minutes} min.`,
    checklist: ['Échauffement réalisé', ...session.exercises.map(e => `${e.name} — ${doseLabel(e)}`), 'Retour au calme réalisé'],
    rubric: [],
    generated: true,
    workout: session,
  };
}

// ── theory of a session ─────────────────────────────────────────────────────────────────────────────────────────
export function buildSportLessonPrompt({ session, registerInstruction, youth }) {
  const list = session.exercises.map(e => `- ${e.name} (${doseLabel(e)}, repos ${e.rest_sec} s, RPE ${e.rpe}) — consignes : ${e.cues.join(' ; ')}`).join('\n');
  return [
    { role: 'system', content: `Tu es un coach sportif pédagogue (pas un médecin : aucun diagnostic, aucun traitement). ${registerInstruction}${youth ? ' Le pratiquant est jeune : insiste sur la technique et le plaisir.' : ''}\n\nExplique la séance suivante : l'objectif du bloc, pourquoi chaque exercice, la technique essentielle, comment gérer l'effort avec l'échelle RPE (1 = très facile, 10 = effort maximal), et la règle de sécurité générale : une douleur inhabituelle = on arrête l'exercice. Termine par UNE question de compréhension.` },
    { role: 'user', content: `${session.title}\n${list}` },
  ];
}

/** Deterministic lesson used when the model lesson is unavailable or unsafe. */
export function deterministicSportLesson(session) {
  const lines = [
    `## ${session.title}`,
    `**Objectif du bloc :** ${session.summary}.`,
    '**Gérer l’effort :** l’échelle RPE va de 1 (très facile) à 10 (effort maximal). Vise le RPE indiqué pour chaque exercice : tu dois pouvoir garder une bonne technique jusqu’à la dernière répétition.',
    ...session.exercises.map(e => `- **${e.name}** (${doseLabel(e)}) — ${e.cues.join(' ; ')}${e.mistakes.length ? `. À éviter : ${e.mistakes.join(' ; ')}` : ''}.`),
    '**Sécurité :** une douleur inhabituelle signifie qu’on arrête l’exercice concerné ; si elle persiste, demande l’avis d’un professionnel de santé.',
    '',
    'Question : pourquoi faut-il viser le RPE indiqué plutôt que l’effort maximal ?',
  ];
  return lines.join('\n\n');
}
