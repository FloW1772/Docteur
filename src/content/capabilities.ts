export interface CapabilityItem {
  text: string;
  shortcut?: string;
}

export interface CapabilitySection {
  emoji: string;
  title: string;
  items: CapabilityItem[];
}

export const CAPABILITIES: CapabilitySection[] = [
  {
    emoji: '📥',
    title: 'CAPTURER',
    items: [
      { text: 'Coller un lien → capture profonde : lit, analyse et résume l\'article ou la vidéo', shortcut: 'Ctrl+N' },
      { text: '"info [lien]" → capture profonde explicite (même résultat que coller un lien)' },
      { text: '"info [source] [lien]" + texte collé → analyse un texte que tu colles toi-même (pour les sites bloqués : MSN, paywall…)' },
      { text: 'Batch : coller plusieurs liens d\'un coup → traitement par lots, un neurone par lien' },
      { text: 'Playlist YouTube : coller un lien de playlist → un neurone par vidéo avec synapse vers la playlist' },
      { text: '"seule [lien playlist]" → capturer la playlist comme référence sans ses vidéos' },
      { text: '"seule" + plusieurs playlists collées → plusieurs playlists en références sans vidéos' },
      { text: '"download" ou "dl" + lien → télécharger la vidéo dans le dossier configuré' },
    ],
  },
  {
    emoji: '🔍',
    title: 'RECHERCHE ET QUESTIONS (Console)',
    items: [
      { text: 'Mode Recherche — chercher dans tes neurones par sens (pas seulement les mots exacts)', shortcut: 'Ctrl+L' },
      { text: 'Mode Question — poser une question en français, Docteur répond avec tes neurones comme sources (RAG)' },
      { text: '"local [question]" ou "privé [question]" → forcer le modèle local, aucun appel cloud' },
      { text: '"puissant [question]" → utiliser qwen2.5:14b (plus puissant et plus lent que le modèle par défaut)' },
      { text: 'Bouton 🔒 Local puissant dans la console → activer le mode local pour toutes les questions de la session' },
      { text: 'Filtrer par type de neurone (Sources, Articles, Vidéos, Playlists, Notes, Questions, Recherches)' },
    ],
  },
  {
    emoji: '🌐',
    title: 'VEILLE IA',
    items: [
      { text: '"veille [sujet]" ou "recherche [sujet]" → agent de veille : choix entre synthèse de fond ou actualité web avec sources' },
      { text: 'Synthèse de fond — vue d\'ensemble structurée à partir des connaissances de l\'IA' },
      { text: 'Actualité récente — recherche web (Google) avec sources cliquables, créée en neurone "Recherche"' },
      { text: 'Bouton "Faire relire par l\'IA" sur un neurone de veille → relecture critique du contenu' },
    ],
  },
  {
    emoji: '▶',
    title: 'VIDÉO ET NAVIGATION',
    items: [
      { text: 'Bouton ▶ rouge après un lien YouTube dans un neurone → ouvrir le lecteur intégré (sans quitter Docteur)' },
      { text: '"lis [titre ou mots-clés]" dans la Console → trouver et lancer la vidéo correspondante directement' },
      { text: '"ouvre [url ou domaine]" dans la Console → ouvrir un site dans un nouvel onglet' },
      { text: '"ouvre [mots-clés]" → trouver un neurone avec une URL source et l\'ouvrir dans un onglet' },
    ],
  },
  {
    emoji: '🗂️',
    title: 'ORGANISER',
    items: [
      { text: 'Hiérarchie automatique : les articles se rattachent à leur source (canal YouTube, site…)' },
      { text: 'Synapses manuelles entre neurones', shortcut: 'Ctrl+Shift+L' },
      { text: 'Sauvegarder une réponse de la Console en neurone "Question" (bouton 🔖 dans la Console)' },
      { text: 'Fusion des doublons de sources (Paramètres → Maintenance)' },
      { text: 'Nouveau neurone (note manuelle)', shortcut: 'Ctrl+N' },
    ],
  },
  {
    emoji: '🎛️',
    title: 'PERSONNALISER',
    items: [
      { text: 'Préférence de modèle : Local rapide / Équilibré / Qualité max (Paramètres → Router)', shortcut: 'Ctrl+,' },
      { text: 'Clés cloud Gemini, Groq, OpenRouter dans Paramètres (optionnel — local fonctionne sans)' },
      { text: 'Panneau visuel du cortex 3D : masquer sphères/particules, mode performance, isoler une sélection (⚙ sur le cortex)' },
      { text: 'Backup automatique + restauration : export JSON neurones + synapses, import depuis un fichier' },
    ],
  },
  {
    emoji: '📱',
    title: 'MOBILE ET HORS-LIGNE',
    items: [
      { text: 'Accès mobile PWA via le réseau local — lancer start-mobile.bat sur le PC, ouvrir l\'adresse affichée sur le téléphone' },
      { text: 'Consultation hors-ligne complète — PC éteint : liste et contenu des neurones disponibles depuis le cache local (IndexedDB)' },
      { text: 'Écriture hors-ligne indisponible — le PC doit être allumé pour capturer ou modifier des neurones' },
    ],
  },
];

export const LIMITATIONS: string[] = [
  'Sites à paywall ou fortement protégés : capture simple du lien uniquement, sans analyse du contenu — contourne avec "info [source] [lien]" + texte collé',
  'Pas de transcription de vidéos sans sous-titres disponibles (Whisper prévu)',
  'Pas de mode vocal / "Hey Docteur" (prévu)',
  'HTTPS hors-ligne complet (mkcert) partiellement en place — les PWA Android peuvent nécessiter un certificat installé',
  'Ne va pas chercher sur internet tout seul : analyse uniquement ce que tu lui donnes ou ce que la veille IA rapporte',
];

export const SHORTCUTS: Array<{ keys: string; desc: string }> = [
  { keys: 'Ctrl+N',          desc: 'Ouvrir la capture' },
  { keys: 'Ctrl+L',          desc: 'Ouvrir la Console (recherche / question / commandes)' },
  { keys: 'Ctrl+K',          desc: 'Basculer Recherche ↔ Question dans la Console' },
  { keys: 'Ctrl+,',          desc: 'Ouvrir les paramètres' },
  { keys: 'Ctrl+Shift+L',    desc: 'Lier le neurone ouvert à un autre' },
  { keys: 'F1 / Ctrl+H',     desc: 'Cette aide' },
  { keys: 'Escape',          desc: 'Fermer le panneau de détail / les modales' },
  { keys: 'Del / Backspace',  desc: 'Supprimer le neurone sélectionné (hors zone de texte)' },
];
