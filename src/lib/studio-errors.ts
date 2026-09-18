// Backend diagnostics may contain paths or subprocess output. Display known
// actionable codes, and leave unexpected diagnostics in the server logs.
const messages: Record<string, string> = {
  no_financial_data: 'Aucune donnée financière disponible. Saisissez une période dans Fundamentals.',
  dcf_inputs_invalid: 'Hypothèses DCF invalides. Vérifiez les montants, les années et les taux.',
  reverse_dcf_inputs_invalid: 'Hypothèses Reverse DCF invalides. Vérifiez la valeur cible et les taux.',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY — mission bloquée par les règles de sécurité.',
  APPROVAL_INVALIDATED: 'APPROVAL_INVALIDATED — le diff doit être revérifié avant approbation.',
  DEPENDENCY_MISSING: 'Un composant requis est indisponible. Vérifiez l’état du service.',
  job_not_found: 'job_not_found — tâche introuvable. Actualisez la liste.',
  insufficient_cash: 'Solde PAPER insuffisant pour cette simulation.',
  authorization_not_confirmed: 'Autorisation non confirmée. Cochez la case de confirmation avant de continuer.',
  authorization_reference_required: 'Référence d’autorisation requise.',
  mission_title_invalid: 'Titre de mission invalide.',
  mission_client_name_invalid: 'Nom de client invalide.',
  scope_hosts_invalid: 'Périmètre invalide : au moins un hôte autorisé est requis.',
  scope_wildcard_denied: 'Les jokers (*) ne sont pas autorisés dans le périmètre.',
  scope_ports_invalid: 'Ports autorisés invalides.',
  scope_protocols_invalid: 'Protocoles autorisés invalides.',
  scope_depth_invalid: 'Profondeur de crawl invalide ou au-delà de la limite serveur.',
  scope_max_requests_invalid: 'Nombre maximal de requêtes invalide ou au-delà de la limite serveur.',
  scope_rate_invalid: 'Débit de requêtes invalide ou au-delà de la limite serveur.',
  scope_timeout_invalid: 'Délai d’expiration invalide ou au-delà de la limite serveur.',
  mission_not_found: 'mission_not_found — mission introuvable. Actualisez la liste.',
  mission_scope_missing: 'Périmètre de mission manquant — recréez la mission.',
  target_out_of_scope: 'Cible hors périmètre autorisé — requête refusée par la politique de sécurité.',
};

/** Backend codes matching this prefix start with "invalid_state_for_" —
 * a mission-state gating denial (e.g. double start, restart after
 * completion). Mapped generically since the state name itself is safe to
 * show. */
export function studioStateTransitionError(code: string): string | null {
  const match = /^invalid_state_for_(start|cancel):(.+)$/.exec(code);
  if (!match) return null;
  const [, action, state] = match;
  return `Action impossible (${action}) : la mission est actuellement dans l’état ${state}.`;
}
export function studioRequestError(value: unknown): string {
  const code = value instanceof Error ? value.message : String(value ?? '');
  return messages[code] ?? studioStateTransitionError(code) ?? 'Opération impossible. Vérifiez les paramètres et la disponibilité du service, puis réessayez.';
}
