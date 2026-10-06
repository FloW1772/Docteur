// Professeur V2 (PROF-5) — Sport Coach UI: athlete profile form, program preview, structured workout view.
// Sport Coach builds training programs; it is not a doctor or a physiotherapist. The server validates the profile,
// screens declared pain and bounds every program; this UI only collects, explains and displays.
import { useEffect, useState } from 'react';
import { Dumbbell, RefreshCw, Check, Play } from 'lucide-react';
import { cortexClient } from '../../lib/cortex/client';
import type { SportOptions, TeacherRegister, DualTrackLearningPath, DualTrackLearningStep, SportPathProfile, SportSession, SportCreateError, SportProgramWithState } from '../../lib/cortex/client';
import {
  defaultSportForm, buildSportProfile, toggleEquipment, toggleIn, sportErrorText, sessionsByWeek, doseText, secondsText,
  type SportForm, type CheckinForm, AREA_LABELS, EQUIPMENT_LABELS, ADAPTATION_LABELS, programProgress,
} from '../../lib/teacher/sport';

const REGISTER_OPTIONS: { value: TeacherRegister; label: string }[] = [
  { value: 'enfant', label: 'Enfant' }, { value: 'debutant', label: 'Débutant' }, { value: 'standard', label: 'Standard' },
  { value: 'expert', label: 'Expert' }, { value: 'socratique', label: 'Socratique' },
];
const DAY_SHORT: Record<string, string> = { lundi: 'Lun', mardi: 'Mar', mercredi: 'Mer', jeudi: 'Jeu', vendredi: 'Ven', samedi: 'Sam', dimanche: 'Dim' };

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#e2e8f0',
  padding: '7px 9px', fontSize: 13, width: '100%', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
};
const btnStyle: React.CSSProperties = {
  background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 6, color: '#a78bfa',
  padding: '7px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
};
const cardStyle: React.CSSProperties = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: 12 };
const fieldsetStyle: React.CSSProperties = { border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '8px 10px', margin: 0, minWidth: 0 };
const legendStyle: React.CSSProperties = { ...labelStyle, padding: '0 4px', marginBottom: 0 };
const chip = (on: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
  border: `1px solid ${on ? 'rgba(167,139,250,0.6)' : 'rgba(255,255,255,0.12)'}`, color: on ? '#c4b5fd' : '#94a3b8', background: on ? 'rgba(167,139,250,0.08)' : 'none',
});

function Chips({ name, values, labels, selected, onToggle }: { name: string; values: string[]; labels: Record<string, string>; selected: string[]; onToggle: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {values.map(v => (
        <label key={v} style={chip(selected.includes(v))}>
          <input type="checkbox" data-testid={`sport-${name}-${v}`} checked={selected.includes(v)} onChange={() => onToggle(v)} style={{ margin: 0 }} />
          {labels[v] ?? v}
        </label>
      ))}
    </div>
  );
}

// ── Formulaire de profil ────────────────────────────────────────────────────────────────────────────────────────
export function SportProfileForm({ defaultRegister, onCreated }: {
  defaultRegister: TeacherRegister;
  onCreated: (path: DualTrackLearningPath) => void;
}) {
  const [options, setOptions] = useState<SportOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [form, setForm] = useState<SportForm>(defaultSportForm);
  const [register, setRegister] = useState<TeacherRegister>(defaultRegister);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string; fields?: string[] } | null>(null);
  useEffect(() => { setRegister(defaultRegister); }, [defaultRegister]);
  useEffect(() => {
    cortexClient.getSportOptions().then(setOptions).catch(err => setOptionsError((err as Error).message));
  }, []);
  const set = <K extends keyof SportForm>(key: K, value: SportForm[K]) => setForm(f => ({ ...f, [key]: value }));

  async function submit() {
    setCreating(true);
    setError(null);
    try {
      const { path } = await cortexClient.createSportPath(register, buildSportProfile(form));
      onCreated(path);
    } catch (err) {
      const e = err as SportCreateError;
      setError({ message: e.message, code: e.code, fields: e.errors?.map(sportErrorText) });
    } finally {
      setCreating(false);
    }
  }

  if (optionsError) return <div style={{ fontSize: 12, color: '#ff4d58' }}>Sport Coach indisponible : {optionsError}</div>;
  if (!options) return <div style={{ fontSize: 12, color: '#64748b' }}>Chargement…</div>;
  const L = options.labels;

  return (
    <form data-testid="sport-form" noValidate onSubmit={e => { e.preventDefault(); void submit(); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        Sport Coach construit un programme d’entraînement adapté à ton profil. Ce n’est ni un médecin ni un kinésithérapeute.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <label>
          <span style={labelStyle}>OBJECTIF</span>
          <select data-testid="sport-goal" style={inputStyle} value={form.goal} onChange={e => set('goal', e.target.value)}>
            {options.goals.map(g => <option key={g} value={g}>{L.goals[g]}</option>)}
          </select>
        </label>
        <label>
          <span style={labelStyle}>NIVEAU</span>
          <select data-testid="sport-level" style={inputStyle} value={form.level} onChange={e => set('level', e.target.value)}>
            {options.levels.map(l => <option key={l} value={l}>{L.levels[l]}</option>)}
          </select>
        </label>
        <label>
          <span style={labelStyle}>STYLE D’EXPLICATION</span>
          <select data-testid="sport-register" style={inputStyle} value={register} onChange={e => setRegister(e.target.value as TeacherRegister)}>
            {REGISTER_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </div>
      {form.goal === 'libre' && (
        <label>
          <span style={labelStyle}>TON OBJECTIF</span>
          <input data-testid="sport-goal-custom" style={inputStyle} value={form.goal_custom} maxLength={200} onChange={e => set('goal_custom', e.target.value)} placeholder="ex : préparer une randonnée de 3 jours" />
        </label>
      )}

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>LIEU</legend>
        <Chips name="location" values={options.locations} labels={L.locations} selected={form.locations} onToggle={v => set('locations', toggleIn(form.locations, v))} />
      </fieldset>
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>MATÉRIEL DISPONIBLE</legend>
        <Chips name="equipment" values={options.equipment} labels={L.equipment} selected={form.equipment} onToggle={v => set('equipment', toggleEquipment(form.equipment, v))} />
        <input data-testid="sport-custom-equipment" style={{ ...inputStyle, marginTop: 6, fontSize: 12 }} value={form.customEquipment} onChange={e => set('customEquipment', e.target.value)} placeholder="Autre matériel (séparé par des virgules), ex : TRX, step" />
      </fieldset>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <label><span style={labelStyle}>SÉANCES / SEMAINE</span>
          <input data-testid="sport-sessions" type="number" inputMode="numeric" min={options.limits.sessionsPerWeek[0]} max={options.limits.sessionsPerWeek[1]} style={inputStyle} value={form.sessions_per_week} onChange={e => set('sessions_per_week', e.target.value)} /></label>
        <label><span style={labelStyle}>MINUTES / SÉANCE</span>
          <input data-testid="sport-minutes" type="number" inputMode="numeric" min={options.limits.sessionMinutes[0]} max={options.limits.sessionMinutes[1]} style={inputStyle} value={form.session_minutes} onChange={e => set('session_minutes', e.target.value)} /></label>
        <label><span style={labelStyle}>SEMAINES</span>
          <input data-testid="sport-weeks" type="number" inputMode="numeric" min={options.limits.weeks[0]} max={options.limits.weeks[1]} style={inputStyle} value={form.weeks} onChange={e => set('weeks', e.target.value)} /></label>
        <label><span style={labelStyle}>PROGRESSION</span>
          <select data-testid="sport-progression" style={inputStyle} value={form.progression} onChange={e => set('progression', e.target.value)}>
            {options.progression.map(p => <option key={p} value={p}>{L.progression[p]}</option>)}
          </select></label>
        <label><span style={labelStyle}>ÂGE (FACULTATIF)</span>
          <input data-testid="sport-age" type="number" inputMode="numeric" style={inputStyle} value={form.age} onChange={e => set('age', e.target.value)} /></label>
      </div>
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>JOURS DISPONIBLES</legend>
        <Chips name="day" values={options.days} labels={DAY_SHORT} selected={form.days} onToggle={v => set('days', toggleIn(form.days, v))} />
      </fieldset>

      <details style={{ fontSize: 12, color: '#cbd5e1' }}>
        <summary style={{ cursor: 'pointer', color: '#94a3b8' }}>Préférences et historique (facultatif)</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 8 }}>
          <input data-testid="sport-history" style={inputStyle} value={form.sport_history} maxLength={500} onChange={e => set('sport_history', e.target.value)} placeholder="Historique sportif" />
          <input data-testid="sport-preferences" style={inputStyle} value={form.preferences} maxLength={300} onChange={e => set('preferences', e.target.value)} placeholder="Préférences" />
          <input data-testid="sport-liked" style={inputStyle} value={form.liked} onChange={e => set('liked', e.target.value)} placeholder="Exercices aimés (virgules)" />
          <input data-testid="sport-disliked" style={inputStyle} value={form.disliked} onChange={e => set('disliked', e.target.value)} placeholder="Exercices à éviter (virgules)" />
        </div>
      </details>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>CONTRAINTES ET DOULEUR</legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input data-testid="sport-limitations" style={inputStyle} value={form.limitationsDeclared} maxLength={500} onChange={e => set('limitationsDeclared', e.target.value)} placeholder="Limitation ou restriction déclarée (facultatif)" />
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Zones à épargner :</span>
          <Chips name="limit-area" values={options.areas} labels={L.areas} selected={form.limitationAreas} onToggle={v => set('limitationAreas', toggleIn(form.limitationAreas, v))} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#e2e8f0' }}>
            <input type="checkbox" data-testid="sport-pain-present" checked={form.painPresent} onChange={e => set('painPresent', e.target.checked)} /> J’ai une douleur actuellement
          </label>
          {form.painPresent && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8 }}>
              <Chips name="pain-area" values={options.areas} labels={L.areas} selected={form.painAreas} onToggle={v => set('painAreas', toggleIn(form.painAreas, v))} />
              <label style={{ fontSize: 12, color: '#e2e8f0', display: 'flex', gap: 8, alignItems: 'center' }}>
                Intensité {form.painIntensity}/10
                <input type="range" data-testid="sport-pain-intensity" min={1} max={10} value={form.painIntensity} onChange={e => set('painIntensity', Number(e.target.value))} aria-label="Intensité de la douleur" />
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#e2e8f0' }}>
                <input type="checkbox" data-testid="sport-pain-worsening" checked={form.painWorsening} onChange={e => set('painWorsening', e.target.checked)} /> Elle s’aggrave
              </label>
            </div>
          )}
        </div>
      </fieldset>

      {error && (
        <div data-testid={error.code === 'SPORT_PAIN_STOP' ? 'sport-pain-stop' : 'sport-error'} role="alert"
          style={{ ...cardStyle, borderColor: error.code === 'SPORT_PAIN_STOP' ? 'rgba(255,181,71,0.4)' : 'rgba(255,77,88,0.4)', fontSize: 12, color: error.code === 'SPORT_PAIN_STOP' ? '#ffb547' : '#ff4d58' }}>
          {error.message}
          {error.fields && error.fields.length > 0 && (
            <ul data-testid="sport-field-errors" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{error.fields.map(f => <li key={f}>{f}</li>)}</ul>
          )}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" data-testid="sport-create" style={btnStyle} disabled={creating}>
          {creating ? <RefreshCw size={13} className="spin" /> : <Dumbbell size={13} />} {creating ? 'Construction du programme…' : 'Créer mon programme'}
        </button>
      </div>
    </form>
  );
}

// ── Aperçu du programme (avant démarrage) ───────────────────────────────────────────────────────────────────────
export function SportProgramPreview({ path, onStarted }: {
  path: DualTrackLearningPath;
  onStarted: (p: DualTrackLearningPath, s: DualTrackLearningStep[]) => void;
}) {
  const program = (path.profile as SportPathProfile | null)?.program;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setStarting(true);
    setError(null);
    try {
      const { path: p, steps } = await cortexClient.startLearningPath(path.id);
      onStarted(p as DualTrackLearningPath, steps as DualTrackLearningStep[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }
  if (!program?.sessions) return <div style={{ fontSize: 12, color: '#64748b' }}>Programme indisponible.</div>;
  return (
    <div data-testid="sport-preview" data-source={program.source} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, color: '#e2e8f0' }}>
        Ton programme : <strong>{program.sessions.length} séances</strong> sur {sessionsByWeek(program.sessions).length} semaines.
      </div>
      <div data-testid="sport-source" style={{ fontSize: 11, color: '#64748b' }}>
        {program.source === 'model' ? 'Programme proposé par le coach et vérifié par Docteur.' : 'Programme construit à partir du catalogue d’exercices de Docteur.'}
        {program.youth ? ' Intensité adaptée à un jeune pratiquant.' : ''}
      </div>
      {program.notice && <div data-testid="sport-notice" style={{ fontSize: 12, color: '#ffb547' }}>{program.notice}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
        {sessionsByWeek(program.sessions).map(w => (
          <div key={w.week} style={cardStyle}>
            <span style={labelStyle}>SEMAINE {w.week}</span>
            <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {w.sessions.map(s => (
                <li key={s.index} data-testid="sport-preview-session" style={{ fontSize: 12, color: '#cbd5e1' }}>
                  {DAY_SHORT[s.day] ?? s.day} — {s.title.split(' — ').pop()} · ~{s.estimated_minutes} min
                  <span style={{ color: '#64748b' }}> ({s.exercises.map(e => e.name).join(', ')})</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {error && <div style={{ fontSize: 12, color: '#ff4d58' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" data-testid="sport-start" style={btnStyle} onClick={() => void start()} disabled={starting}>
          {starting ? <RefreshCw size={13} className="spin" /> : <Play size={13} />} Commencer le programme
        </button>
      </div>
    </div>
  );
}

// ── Séance structurée (voie Pratique) ───────────────────────────────────────────────────────────────────────────
export function WorkoutView({ workout }: { workout: SportSession }) {
  return (
    <div data-testid="workout-view" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: '#94a3b8' }}>Semaine {workout.week} · ~{workout.estimated_minutes} min</div>
      <WorkoutBlock title="ÉCHAUFFEMENT" items={workout.warmup.map(w => `${w.name} — ${secondsText(w.duration_sec)}`)} testId="workout-warmup" />
      <ol data-testid="workout-exercises" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {workout.exercises.map((e, i) => (
          <li key={`${e.name}-${i}`} data-testid="workout-exercise" style={{ ...cardStyle, padding: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13, color: '#e2e8f0' }}>{e.name}</strong>
              <span data-testid="workout-dose" style={{ fontSize: 12, color: '#c4b5fd' }}>{doseText(e)}</span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              Repos {secondsText(e.rest_sec)}{e.tempo ? ` · tempo ${e.tempo}` : ''} · <span data-testid="workout-rpe">RPE {e.rpe}/10</span>
              {e.equipment.length ? ` · ${e.equipment.join(', ')}` : ' · sans matériel'}
            </div>
            <div style={{ fontSize: 12, color: '#cbd5e1' }}>{e.cues.join(' · ')}</div>
            {e.mistakes.length > 0 && <div style={{ fontSize: 11, color: '#94a3b8' }}>À éviter : {e.mistakes.join(' · ')}</div>}
            {(e.easier || e.harder || e.substitution) && (
              <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {e.easier && <span data-testid="workout-easier">Plus facile : {e.easier}</span>}
                {e.harder && <span data-testid="workout-harder">Plus difficile : {e.harder}</span>}
                {e.substitution && <span data-testid="workout-substitution">Alternative : {e.substitution.name}{e.substitution.equipment.length ? ` (${e.substitution.equipment.join(', ')})` : ' (sans matériel)'}</span>}
              </div>
            )}
            {e.note && <div style={{ fontSize: 11, color: '#ffb547' }}>{e.note}</div>}
          </li>
        ))}
      </ol>
      <WorkoutBlock title="RETOUR AU CALME" items={workout.cooldown.map(w => `${w.name} — ${secondsText(w.duration_sec)}`)} testId="workout-cooldown" />
    </div>
  );
}

function WorkoutBlock({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  return (
    <div data-testid={testId}>
      <span style={labelStyle}>{title}</span>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12, color: '#cbd5e1' }}>{items.map(i => <li key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}><Check size={10} style={{ flexShrink: 0, opacity: 0.5, display: 'inline-block' }} /><span>{i}</span></li>)}</ul>
    </div>
  );
}

// ── PROF-6 — check-in après la séance ──────────────────────────────────────────────────────────────────────────
function Scale({ name, label, value, min, max, onChange, hint }: { name: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <fieldset style={{ ...fieldsetStyle, padding: '6px 8px' }}>
      <legend style={legendStyle}>{label}</legend>
      <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map(v => (
          <label key={v} style={{ ...chip(value === v), padding: '2px 7px' }}>
            <input type="radio" name={name} data-testid={`${name}-${v}`} checked={value === v} onChange={() => onChange(v)} style={{ margin: 0 }} />{v}
          </label>
        ))}
      </div>
      {hint && <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>{hint}</div>}
    </fieldset>
  );
}

export function CheckinFields({ form, onChange, equipment }: { form: CheckinForm; onChange: (f: CheckinForm) => void; equipment: string[] }) {
  const set = <K extends keyof CheckinForm>(k: K, v: CheckinForm[K]) => onChange({ ...form, [k]: v });
  return (
    <div data-testid="checkin-fields" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <fieldset style={{ ...fieldsetStyle, padding: '6px 8px' }}>
        <legend style={legendStyle}>SÉANCE TERMINÉE ?</legend>
        <div role="radiogroup" aria-label="Séance terminée" style={{ display: 'flex', gap: 6 }}>
          <label style={chip(form.completed)}><input type="radio" name="checkin-completed" data-testid="checkin-completed-yes" checked={form.completed} onChange={() => set('completed', true)} style={{ margin: 0 }} />Oui</label>
          <label style={chip(!form.completed)}><input type="radio" name="checkin-completed" data-testid="checkin-completed-no" checked={!form.completed} onChange={() => set('completed', false)} style={{ margin: 0 }} />Non, pas en entier</label>
        </div>
      </fieldset>
      {form.completed && <Scale name="checkin-rpe" label="EFFORT RESSENTI (RPE)" value={form.rpe} min={1} max={10} onChange={v => set('rpe', v)} hint="1 = très facile · 10 = effort maximal" />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        <Scale name="checkin-energy" label="ÉNERGIE" value={form.energy} min={1} max={5} onChange={v => set('energy', v)} />
        <Scale name="checkin-technique" label="CONFIANCE TECHNIQUE" value={form.technique} min={1} max={5} onChange={v => set('technique', v)} />
      </div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#e2e8f0' }}>
        <input type="checkbox" data-testid="checkin-pain" checked={form.pain} onChange={e => set('pain', e.target.checked)} /> Douleur inhabituelle pendant ou après la séance
      </label>
      {form.pain && (
        <div style={{ paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Chips name="checkin-pain-area" values={Object.keys(AREA_LABELS)} labels={AREA_LABELS} selected={form.painAreas} onToggle={v => set('painAreas', toggleIn(form.painAreas, v))} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#e2e8f0' }}>
            <input type="checkbox" data-testid="checkin-pain-worsening" checked={form.painWorsening} onChange={e => set('painWorsening', e.target.checked)} /> Elle s’aggrave
          </label>
        </div>
      )}
      {equipment.length > 0 && (
        <fieldset style={{ ...fieldsetStyle, padding: '6px 8px' }}>
          <legend style={legendStyle}>MATÉRIEL INDISPONIBLE (FACULTATIF)</legend>
          <Chips name="checkin-gear" values={equipment} labels={EQUIPMENT_LABELS} selected={form.unavailable} onToggle={v => set('unavailable', toggleIn(form.unavailable, v))} />
        </fieldset>
      )}
      <input data-testid="checkin-comment" style={{ ...inputStyle, fontSize: 12 }} value={form.comment} maxLength={500} onChange={e => set('comment', e.target.value)} placeholder="Commentaire (facultatif)" aria-label="Commentaire" />
    </div>
  );
}

// ── PROF-6 — tableau de bord du programme ──────────────────────────────────────────────────────────────────────
export function SportProgramDashboard({ path, steps, onRefresh, readOnly = false }: {
  path: DualTrackLearningPath;
  steps: DualTrackLearningStep[];
  onRefresh: (p: DualTrackLearningPath, s: DualTrackLearningStep[]) => void;
  readOnly?: boolean;
}) {
  const program = (path.profile as (SportPathProfile & { program: SportProgramWithState }) | null)?.program;
  const [confirm, setConfirm] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!program) return null;
  const progress = programProgress(steps as never, path.current_step_index);
  const adaptations = [...(program.adaptations ?? [])].reverse();
  const current = program.sessions?.[path.current_step_index];

  async function resume() {
    setResuming(true);
    setError(null);
    try {
      const res = await cortexClient.resumeSport(path.id);
      setConfirm(false);
      onRefresh(res.path, res.steps);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResuming(false);
    }
  }

  return (
    <section data-testid="sport-dashboard" aria-label="Programme Sport Coach" style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#e2e8f0' }}>
          <Dumbbell size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          <span data-testid="sport-progress">{progress.done}/{progress.total} séances faites</span>
          {current ? ` · semaine ${current.week}` : ''}
        </span>
        <div role="progressbar" aria-label="Progression du programme" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}
          style={{ flex: '1 1 140px', maxWidth: 260, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
          <div style={{ width: `${progress.percent}%`, height: '100%', background: '#3dffaa' }} />
        </div>
      </div>
      {((program.excluded_areas?.length ?? 0) > 0 || (program.unavailable_equipment?.length ?? 0) > 0) && (
        <div data-testid="sport-constraints" style={{ fontSize: 11, color: '#94a3b8' }}>
          {program.excluded_areas?.length ? `Zones épargnées : ${program.excluded_areas.map(a => AREA_LABELS[a] ?? a).join(', ')}. ` : ''}
          {program.unavailable_equipment?.length ? `Matériel retiré : ${program.unavailable_equipment.map(e => EQUIPMENT_LABELS[e] ?? e).join(', ')}.` : ''}
        </div>
      )}
      {program.pause && (
        <div data-testid="sport-pause" role="alert" style={{ border: '1px solid rgba(255,181,71,0.4)', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#ffb547' }}>{program.pause.reason}</span>
          {!readOnly && (
            <>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#e2e8f0' }}>
                <input type="checkbox" data-testid="sport-resume-confirm" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> Je n’ai plus de douleur
              </label>
              <button type="button" data-testid="sport-resume" style={{ ...btnStyle, alignSelf: 'flex-start' }} disabled={!confirm || resuming} onClick={() => void resume()}>
                {resuming ? <RefreshCw size={13} className="spin" /> : <Play size={13} />} Reprendre en douceur
              </button>
            </>
          )}
          {error && <span style={{ fontSize: 12, color: '#ff4d58' }}>{error}</span>}
        </div>
      )}
      {adaptations.length > 0 && (
        <details data-testid="sport-adaptations" open={adaptations[0]?.kind !== 'observe'}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
            ADAPTATIONS ({adaptations.filter(a => a.kind !== 'observe').length})
          </summary>
          <ol style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {adaptations.slice(0, 12).map(a => (
              <li key={a.id} data-testid="sport-adaptation" data-rule={a.rule} data-kind={a.kind}
                style={{ borderLeft: `2px solid ${a.kind === 'pause' ? '#ffb547' : a.kind === 'observe' ? '#64748b' : '#a78bfa'}`, paddingLeft: 8, fontSize: 12, color: '#cbd5e1' }}>
                <strong style={{ color: '#e2e8f0' }}>{ADAPTATION_LABELS[a.rule] ?? a.rule}</strong>
                <span style={{ color: '#64748b' }}> · après la séance {a.after_session_index + 1}</span>
                <div>{a.reason}</div>
                {a.summary && a.summary.length > 0 && (() => { const unique = [...new Set(a.summary)]; return <div data-testid="sport-adaptation-summary" style={{ fontSize: 11, color: '#94a3b8' }}>{unique.slice(0, 6).join(' · ')}{unique.length > 6 ? ' …' : ''}</div>; })()}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
