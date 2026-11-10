// [PAI-1] Why the Knowledge Graph panel is unavailable, in plain words, from the REAL disabled reason the backend sends
// (cortex-server/src/lib/kg-boot.js → routes/kg.js 503 { error: 'KG_DISABLED', reason }). The graph is certified; it is
// opened only when it was activated explicitly on this installation (persisted activation state), never automatically.

export interface KgDisabledMessage { title: string; detail: string; reason: string | null }

const MESSAGES: Record<string, { title: string; detail: string }> = {
  KG_NOT_ACTIVATED: {
    title: 'Le graphe de connaissances n’est pas activé sur cette installation.',
    detail: 'Son activation est une décision manuelle ; tant qu’il est désactivé, aucune donnée de graphe n’est créée ni lue.',
  },
  KG_NOT_REQUESTED: {
    title: 'Le graphe de connaissances n’est pas activé sur cette installation.',
    detail: 'Son activation est une décision manuelle ; tant qu’il est désactivé, aucune donnée de graphe n’est créée ni lue.',
  },
  KG_SCHEMA_MISMATCH: {
    title: 'Le graphe de connaissances n’a pas été ouvert : sa version de schéma ne correspond pas.',
    detail: 'Aucune migration n’est faite automatiquement au démarrage. Consultez le diagnostic de démarrage.',
  },
  KG_PRODUCTION_STATE_INVALID: {
    title: 'Le graphe de connaissances n’a pas été ouvert : son état d’activation est illisible.',
    detail: 'Il reste fermé par sécurité. Consultez le diagnostic de démarrage.',
  },
  KG_OPEN_FAILED: {
    title: 'Le graphe de connaissances n’a pas pu être ouvert.',
    detail: 'Consultez le diagnostic de démarrage avant de réessayer.',
  },
};

/** Never claims a cause the backend did not send; an unknown or missing reason is shown as such. */
export function kgDisabledMessage(reason: unknown): KgDisabledMessage {
  const r = typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(reason) ? reason : null;
  const known = r ? MESSAGES[r] : undefined;
  if (known) return { ...known, reason: r };
  return { title: 'Le graphe de connaissances est indisponible.', detail: r ? 'Motif technique transmis par le serveur.' : 'Le serveur n’a pas précisé le motif.', reason: r };
}
