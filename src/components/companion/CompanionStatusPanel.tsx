// Companion V1 — COMP-6A status panel: activation, memory switch contract, model status (metadata only), preferences.
// A preference button never changes anything by itself: it asks for a proposal, which the person reviews and confirms.
import { memoryOffContract, modelStatusLabel, type CompanionPreferences, type CompanionStatusDto } from '../../lib/companion/ui-contracts';
import { ToneBadge } from './CompanionCommon';
import './companion.css';

const PREF_LABELS: Record<keyof CompanionPreferences, string> = {
  memoryEnabled: 'Mémoire du Companion', sessionMemoryEnabled: 'Mémoire de session', proposalEnabled: 'Propositions de souvenirs', cloudContextEnabled: 'Contexte cloud',
};

export function CompanionStatusPanel({ status, onRequestPreferences }: { status: CompanionStatusDto | null; onRequestPreferences: (patch: Partial<CompanionPreferences>) => void }) {
  if (!status) return <section className="cmp-card" aria-label="État du Companion"><p className="cmp-muted" role="status">Chargement de l’état…</p></section>;
  const off = memoryOffContract(status.preferences);
  const model = modelStatusLabel(status.model?.status);
  const p = status.preferences;
  const active = status.activation === 'ACTIVE'; // [MASTER WS4] gates the explanatory note and the preference buttons
  return (
    <section className="cmp-card" aria-labelledby="cmp-status-title" data-testid="cmp-status">
      <h2 id="cmp-status-title">État du Companion</h2>
      <div className="cmp-row">
        <ToneBadge tone={active ? 'ok' : 'warn'} label={`Activation : ${status.activation}`}>{status.activation}</ToneBadge>
        <ToneBadge tone={off.off ? 'warn' : 'ok'} label={`Mémoire ${off.off ? 'désactivée' : 'activée'}`}>{off.off ? 'Mémoire OFF' : 'Mémoire ON'}</ToneBadge>
        <span data-testid="cmp-model-status" data-model-status={model.status}><ToneBadge tone={model.tone} label={model.label}>{model.label}</ToneBadge></span>
        {status.model?.code && <span className="cmp-muted">({status.model.code})</span>}
      </div>
      {!active && (
        <div className="cmp-alert warn" role="note" data-testid="cmp-not-active">
          Le Companion n’est pas encore activé ({status.activation}) : il ne lit, ne mémorise et n’agit pas de lui-même
          tant qu’il reste désactivé, en attente de validation. Vous pouvez tout de même réduire ses réglages de mémoire
          ci-dessous (chaque changement passe par une proposition que vous confirmez).
        </div>
      )}
      {off.off && (
        <div className="cmp-alert warn" role="note" data-testid="cmp-memory-off">
          Mémoire désactivée : la récupération des souvenirs durables, la mémoire de session, les propositions de souvenirs et l’usage des souvenirs dans le contexte sont arrêtés. L’oubli reste disponible.
        </div>
      )}
      <dl className="cmp-dl" aria-label="Contrat de la mémoire">
        <dt>Souvenirs durables</dt><dd data-contract="durableRetrieval">{off.durableRetrieval}</dd>
        <dt>Mémoire de session</dt><dd data-contract="sessionMemory">{off.sessionMemory}</dd>
        <dt>Propositions</dt><dd data-contract="proposals">{off.proposals}</dd>
        <dt>Souvenirs dans le contexte</dt><dd data-contract="contextMemory">{off.contextMemory}</dd>
        <dt>Oubli</dt><dd data-contract="forget">{off.forgetAvailable ? 'Disponible' : 'Indisponible'}</dd>
      </dl>
      <h3>Préférences</h3>
      <ul className="cmp-list">
        {(Object.keys(PREF_LABELS) as (keyof CompanionPreferences)[]).map(k => (
          <li key={k} className="cmp-row">
            <span>{PREF_LABELS[k]} : <strong>{p[k] ? 'activé' : 'désactivé'}</strong></span>
            <button type="button" className="cmp-btn ghost" data-pref={k} onClick={() => onRequestPreferences({ [k]: !p[k] })}>
              {p[k] ? 'Proposer de désactiver' : 'Proposer d’activer'}<span className="cmp-sr"> : {PREF_LABELS[k]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
