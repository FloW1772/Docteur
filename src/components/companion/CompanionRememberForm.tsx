import { useRef, useState } from 'react';
import { categoryLabel } from '../../lib/companion/ui-contracts';

/** Only a user-submitted draft enters the existing proposal/review flow. No model text is prefilled here. */
export function CompanionRememberForm({ enabled, onPropose }: {
  enabled: boolean; onPropose: (parameters: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [category, setCategory] = useState('USER_PREFERENCE');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const valid = value.trim().replace(/\s+/g, ' ').length >= 8 && value.length <= 400 && !/[\u0000-\u001f\u007f]/.test(value);
  const close = () => { setOpen(false); setValue(''); trigger.current?.focus(); };
  async function submit() {
    if (busy.current || !enabled || !valid) return;
    busy.current = true; setPending(true);
    try {
      // Keep the trigger mounted: the action review restores focus to it when closed.
      trigger.current?.focus();
      if (await onPropose({ category, value: value.trim() })) { setOpen(false); setValue(''); }
    } finally { busy.current = false; setPending(false); }
  }
  return <section className="cmp-card" aria-labelledby="cmp-remember-title" data-testid="cmp-remember">
    <h2 id="cmp-remember-title">Retenir une information</h2>
    <p className="cmp-muted">Saisissez un fait ou une préférence. Vous pourrez vérifier le texte, confirmer puis exécuter l’enregistrement. La conversation ne mémorise rien automatiquement.</p>
    {!enabled && <p className="cmp-muted" role="status">Disponible lorsque le Companion et sa mémoire sont activés et qu’aucune action n’est en cours de revue.</p>}
    <button ref={trigger} type="button" className="cmp-btn" disabled={!enabled || pending} aria-expanded={open} aria-controls="cmp-remember-form" onClick={() => setOpen(true)}>Saisir une information</button>
    {open && <form id="cmp-remember-form" onSubmit={e => { e.preventDefault(); void submit(); }} aria-busy={pending}>
      <label className="cmp-check">Catégorie
        <select className="cmp-select" value={category} onChange={e => setCategory(e.target.value)} disabled={pending || !enabled}>
          {['USER_PREFERENCE', 'USER_FACT'].map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
        </select>
      </label>
      <label className="cmp-check" htmlFor="cmp-remember-value">Information à retenir</label>
      <textarea autoFocus id="cmp-remember-value" className="cmp-input cmp-chat-input" rows={3} value={value} onChange={e => setValue(e.target.value)}
        disabled={pending || !enabled} aria-describedby="cmp-remember-hint" aria-invalid={value.length > 400 || /[\u0000-\u001f\u007f]/.test(value)} />
      <p id="cmp-remember-hint" className="cmp-muted">{value.length} / 400 caractères, 8 minimum, un seul paragraphe. Les mots de passe, clés et autres secrets sont refusés. Enregistrement local uniquement. Après un redémarrage de Docteur, ressaisissez tout brouillon non enregistré.</p>
      <div className="cmp-row">
        <button type="submit" className="cmp-btn primary" disabled={!enabled || pending || !valid}>Vérifier avant de retenir</button>
        <button type="button" className="cmp-btn ghost" disabled={pending} onClick={close}>Annuler la saisie</button>
        {pending && <span role="status">Préparation de l’aperçu…</span>}
      </div>
    </form>}
  </section>;
}
