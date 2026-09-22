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

  // MAÎTRE (MA-11)
  incident_not_found: 'Incident introuvable. Actualisez la liste.',
  action_not_found: 'Action introuvable. Actualisez la vue.',
  approval_not_found: 'Demande d’approbation introuvable.',
  action_type_invalid: 'Type d’action inconnu.',
  approval_required: 'Cette action nécessite une approbation explicite avant exécution.',
  approval_invalid: 'Approbation invalide, expirée ou déjà utilisée — proposez à nouveau l’action.',
  approval_expired: 'Cette approbation a expiré — proposez à nouveau l’action.',
  approval_already_consumed: 'Cette approbation a déjà été utilisée — proposez à nouveau l’action.',
  approval_not_pending: 'Cette demande d’approbation n’est plus en attente.',
  level3_requires_strengthened_confirmation: 'Cette action nécessite une confirmation renforcée explicite.',
  action_already_running: 'Cette action est déjà en cours d’exécution.',
  action_already_executed: 'Cette action a déjà été exécutée.',
  action_not_ready: 'Cette action n’est pas prête à être exécutée.',
  isolation_already_active: 'Une isolation réseau MAÎTRE est déjà active — restaurez-la avant d’en démarrer une nouvelle.',
  isolation_rollback_state_persist_failed: 'Impossible d’enregistrer l’état de restauration — isolation refusée par sécurité.',
  isolation_denied_loopback_baseline_unavailable: 'Impossible de confirmer l’accès local avant isolation — action refusée par sécurité.',
  restore_target_not_found: 'Aucune isolation correspondante à restaurer.',
  pid_invalid: 'Identifiant de processus invalide.',
  evidence_not_found: 'Preuve introuvable.',
  run_not_found: 'Exécution introuvable.',

  // Business/Sales Agent V1 (RESEARCH → ANALYZE → SCORE → DRAFT → HUMAN REVIEW)
  lead_not_found: 'Prospect introuvable. Actualisez la liste.',
  lead_name_invalid: 'Nom de prospect invalide.',
  company_invalid: 'Nom d’entreprise invalide.',
  notes_invalid: 'Notes invalides.',
  criteria_invalid: 'Critères de score invalides (1 à 10 requis).',
  criteria_keyword_required: 'Chaque critère doit avoir un mot-clé.',
  criteria_weight_invalid: 'Poids de critère invalide (doit être entre 0 et 10).',
  forbidden_action_denied: 'Action refusée — hors du périmètre V1 (envoi, écriture CRM, connexion, formulaire, achat non disponibles).',
  action_denied: 'Action inconnue refusée.',
  search_unavailable: 'Recherche web indisponible pour le moment. Réessayez plus tard.',

  // Hono's own app.notFound() fallback — reachable if the frontend ever
  // talks to a Cortex instance whose build predates a given route (e.g. an
  // old backend still listening on the expected port after a partial
  // restart). Distinguish this from a generic failure so it points at the
  // actual cause instead of suggesting a parameter/config problem.
  'Route introuvable': 'Backend MAÎTRE indisponible ou version serveur incompatible. Vérifiez qu’une seule instance de cortex-server est active, puis redémarrez-la.',
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
