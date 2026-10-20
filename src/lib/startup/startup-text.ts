// [LOAD-1/LOAD-2] French texts of the boot screen (kept out of the component file so it stays a Fast Refresh boundary).
import type { ProbeOutcome } from './readiness.ts';

export const STARTUP_TEXT = Object.freeze({
  starting: 'Démarrage de Docteur…',
  waiting: 'Connexion au serveur en cours…',
  waitingDetail: 'Docteur attend que son serveur local soit prêt.',
  delayed: 'Docteur met plus de temps que prévu à démarrer.',
  delayedDetail: 'Le serveur local n’a pas encore répondu. La vérification continue automatiquement.',
  failed: 'Le serveur local de Docteur ne répond pas.',
  failedHint: 'Vérifiez que Docteur a bien été lancé depuis son lanceur habituel, puis réessayez.',
  retry: 'Réessayer',
  offline: 'Ouvrir la copie hors ligne',
});

/** Plain-French reason for the last check — no URL, path, stack or server text is ever shown. */
export function outcomeText(outcome: ProbeOutcome | null): string | null {
  switch (outcome?.kind) {
    case 'unreachable': return 'Aucune connexion au serveur local.';
    case 'timeout': return 'Le serveur local n’a pas répondu à temps.';
    case 'unexpected': return `Le serveur local a répondu de façon inattendue (HTTP ${outcome.status}).`;
    default: return null;
  }
}
