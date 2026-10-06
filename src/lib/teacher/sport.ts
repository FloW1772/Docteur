// Professeur V2 (PROF-5) — Sport Coach view-model helpers (pure). The server validates everything again; these only
// turn the form into the API payload, explain field errors and lay the program out.
import type { SportProfileInput, SportSession, SportExercise } from '../cortex/client';

export interface SportForm {
  goal: string; goal_custom: string; level: string; sport_history: string;
  locations: string[]; equipment: string[]; customEquipment: string;
  sessions_per_week: string; session_minutes: string; weeks: string; days: string[];
  preferences: string; liked: string; disliked: string;
  limitationsDeclared: string; limitationAreas: string[];
  painPresent: boolean; painAreas: string[]; painIntensity: number; painWorsening: boolean;
  age: string; progression: string;
}

export function defaultSportForm(): SportForm {
  return {
    goal: 'remise_en_forme', goal_custom: '', level: 'debutant', sport_history: '',
    locations: ['maison'], equipment: ['aucun'], customEquipment: '',
    sessions_per_week: '2', session_minutes: '30', weeks: '4', days: ['lundi', 'jeudi'],
    preferences: '', liked: '', disliked: '',
    limitationsDeclared: '', limitationAreas: [],
    painPresent: false, painAreas: [], painIntensity: 2, painWorsening: false,
    age: '', progression: 'standard',
  };
}

const list = (text: string) => text.split(',').map(s => s.trim()).filter(Boolean);
const num = (text: string): number | string => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : text.trim());

/** "Aucun matériel" and real equipment are mutually exclusive; an empty selection means "aucun". */
export function toggleEquipment(current: string[], item: string): string[] {
  if (item === 'aucun') return ['aucun'];
  const without = current.filter(e => e !== 'aucun');
  const next = without.includes(item) ? without.filter(e => e !== item) : [...without, item];
  return next.length ? next : ['aucun'];
}

export function toggleIn(current: string[], item: string): string[] {
  return current.includes(item) ? current.filter(x => x !== item) : [...current, item];
}

export function buildSportProfile(form: SportForm): SportProfileInput {
  return {
    goal: form.goal,
    ...(form.goal === 'libre' ? { goal_custom: form.goal_custom.trim() } : {}),
    level: form.level,
    sport_history: form.sport_history.trim(),
    locations: form.locations,
    equipment: form.equipment,
    custom_equipment: list(form.customEquipment),
    sessions_per_week: num(form.sessions_per_week) as number,
    session_minutes: num(form.session_minutes) as number,
    weeks: num(form.weeks) as number,
    days: form.days,
    preferences: form.preferences.trim(),
    liked: list(form.liked),
    disliked: list(form.disliked),
    limitations: { declared: form.limitationsDeclared.trim(), areas: form.limitationAreas },
    pain: form.painPresent ? { present: true, areas: form.painAreas, intensity: form.painIntensity, worsening: form.painWorsening } : { present: false },
    ...(form.age.trim() ? { age: num(form.age) as number } : {}),
    progression: form.progression,
  };
}

export const SPORT_FIELD_LABELS: Record<string, string> = {
  profile: 'Profil', goal: 'Objectif', goal_custom: 'Objectif libre', level: 'Niveau', locations: 'Lieu', equipment: 'Matériel',
  custom_equipment: 'Matériel personnalisé', sessions_per_week: 'Séances par semaine', session_minutes: 'Durée par séance',
  weeks: 'Nombre de semaines', days: 'Jours disponibles', liked: 'Exercices aimés', disliked: 'Exercices non aimés',
  limitations: 'Limitations', pain: 'Douleur', 'pain.areas': 'Zones douloureuses', 'pain.intensity': 'Intensité de la douleur',
  age: 'Âge', progression: 'Progression',
};

const CODE_TEXT: Record<string, string> = {
  invalid: 'valeur invalide', required: 'à préciser', out_of_range: 'hors des limites', conflict: '« aucun » ne se combine pas avec un autre matériel',
  not_enough_days: 'pas assez de jours pour le nombre de séances', program_too_long: 'programme trop long (24 séances maximum)',
  out_of_scope: 'Sport Coach ne fait ni soin ni rééducation : demande l’avis d’un professionnel de santé', not_an_object: 'profil manquant',
};

export function sportErrorText(error: { field: string; code: string }): string {
  return `${SPORT_FIELD_LABELS[error.field] ?? error.field} : ${CODE_TEXT[error.code] ?? error.code}`;
}

export function sessionsByWeek(sessions: SportSession[] | undefined): { week: number; sessions: SportSession[] }[] {
  const out: { week: number; sessions: SportSession[] }[] = [];
  for (const s of sessions ?? []) {
    const last = out[out.length - 1];
    if (last && last.week === s.week) last.sessions.push(s);
    else out.push({ week: s.week, sessions: [s] });
  }
  return out;
}

/** Same wording as the server's doseLabel (sport-program.js). */
export function doseText(e: Pick<SportExercise, 'sets' | 'type' | 'reps' | 'duration_sec'>): string {
  if (e.type === 'reps') return `${e.sets} × ${e.reps} rép.`;
  const d = e.duration_sec ?? 0;
  return `${e.sets} × ${d >= 120 ? `${Math.round(d / 60)} min` : `${d} s`}`;
}

export function secondsText(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`;
}

// ── PROF-6 — check-in & program dashboard ─────────────────────────────────────────────────────────────────────────
export interface CheckinForm {
  completed: boolean; rpe: number; energy: number; technique: number;
  pain: boolean; painAreas: string[]; painWorsening: boolean; unavailable: string[]; comment: string;
}

export function defaultCheckinForm(): CheckinForm {
  return { completed: true, rpe: 6, energy: 3, technique: 3, pain: false, painAreas: [], painWorsening: false, unavailable: [], comment: '' };
}

/** The server re-validates everything (validateCheckin); RPE is only sent for a completed session. */
export function buildCheckin(form: CheckinForm) {
  return {
    completed: form.completed,
    rpe: form.completed ? form.rpe : null,
    unusual_pain: form.pain,
    pain_areas: form.pain ? form.painAreas : [],
    pain_worsening: form.pain ? form.painWorsening : false,
    technique_confidence: form.technique,
    energy: form.energy,
    unavailable_equipment: form.unavailable,
    comment: form.comment.trim(),
  };
}

export function checkinSummary(c: { completed: boolean; rpe: number | null; energy: number | null; technique_confidence: number | null; unusual_pain: boolean; pain_areas: string[] } | undefined | null): string {
  if (!c) return '';
  const parts = [c.completed ? 'séance faite' : 'séance non terminée'];
  if (c.completed && c.rpe !== null) parts.push(`RPE ${c.rpe}/10`);
  if (c.energy !== null) parts.push(`énergie ${c.energy}/5`);
  if (c.technique_confidence !== null) parts.push(`technique ${c.technique_confidence}/5`);
  if (c.unusual_pain) parts.push(`douleur inhabituelle${c.pain_areas.length ? ` (${c.pain_areas.join(', ')})` : ''}`);
  return parts.join(' · ');
}

export const ADAPTATION_LABELS: Record<string, string> = {
  pain_pause: 'Pause (douleur)', pain_reduce: 'Zone épargnée', equipment_unavailable: 'Matériel indisponible',
  missed_reduce: 'Séances manquées', hard_reduce: 'Séances trop dures', energy_reduce: 'Énergie basse', technique_regress: 'Variantes plus faciles',
  easy_progress: 'Progression', easy_progress_harder: 'Variante plus difficile', observe: 'Observation', resume: 'Reprise en douceur',
};

/** Done = practice validated (the session was really trained); current = the server pointer. */
export function programProgress(steps: { step_index: number; tracks: { practice: { state: string } } | null }[], currentIndex: number) {
  const total = steps.length;
  const done = steps.filter(s => s.tracks?.practice.state === 'PASSED').length;
  return { total, done, current: Math.min(total, currentIndex + 1), percent: total ? Math.round((done / total) * 100) : 0 };
}

/** Static copies of the server vocabularies (parity checked by scripts/test-teacher-sport-unit.mjs). */
export const AREA_LABELS: Record<string, string> = { nuque: 'Nuque', epaule: 'Épaule', coude: 'Coude', poignet: 'Poignet', dos: 'Dos', hanche: 'Hanche', genou: 'Genou', cheville: 'Cheville' };
export const EQUIPMENT_LABELS: Record<string, string> = { aucun: 'Aucun matériel', tapis: 'Tapis', bandes: 'Bandes élastiques', halteres: 'Haltères', kettlebell: 'Kettlebell', banc: 'Banc', barre: 'Barre', rack: 'Rack', velo: 'Vélo', tapis_de_course: 'Tapis de course' };

/** Equipment actually used by a session (what could be "unavailable" today). */
export function sessionEquipment(session: { exercises: { equipment: string[] }[] } | null | undefined): string[] {
  return [...new Set((session?.exercises ?? []).flatMap(e => e.equipment))];
}
