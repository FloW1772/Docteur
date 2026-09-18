export interface CapabilityItem {
  text: string;
  shortcut?: string;
}

export interface CapabilitySection {
  emoji: string;
  title: string;
  items: CapabilityItem[];
}

// ── Centre d'aide — répertoire des fonctionnalités ──────────────────────────
// Chaque entrée correspond à une fonctionnalité réellement présente dans le
// code (vérifié — pas une aspiration). `feature` est la clé passée à
// onOpenFeature() dans App.tsx, qui sait ouvrir le bon modal/onglet.
export type FeatureKey =
  | 'capture' | 'console' | 'notebook' | 'teacher' | 'agents' | 'skills'
  | 'images' | 'kiwix' | 'todo' | 'backup' | 'corpus' | 'prompt-generator'
  | 'video-summary' | 'metagpt' | 'investment' | 'sherlock'
  | 'settings' | 'settings-models' | 'settings-memory' | 'settings-images'
  | 'settings-privacy' | 'settings-audio' | 'settings-files' | 'settings-vocal'
  | 'settings-external' | 'settings-connections';

export type FeatureState = 'disponible' | 'local' | 'a_configurer' | 'partiel';

export interface HelpFeature {
  name: string;
  description: string;
  feature: FeatureKey;
  state: FeatureState;
  keywords?: string[]; // pour la recherche — synonymes non présents dans name/description
}

export interface HelpCategory {
  title: string;
  emoji: string;
  items: HelpFeature[];
}

export const HELP_DIRECTORY: HelpCategory[] = [
  {
    emoji: '🤖',
    title: 'IA',
    items: [
      { name: 'Studio MetaGPT', description: 'Ollama local : PRD, Design, Tasks, génération de code texte, diff et application dans un sample isolé après approbation du hash et des fichiers exacts. V1 : aucun Terminal, Bash, Browser, Git, Internet externe, cloud, exécution de code, installation de packages ou auto-apply.', feature: 'metagpt', state: 'local', keywords: ['studio', 'code', 'diff', 'approbation', 'plan'] },
      { name: 'Studio Investissement', description: 'Recherche, analyse fondamentale, valorisation (multiples/DCF) et portefeuille simulé (paper trading) avec provenance systématique des données. V1 : aucun broker réel, aucun ordre réel, aucune clé broker, aucune transaction réelle — analyse et simulation uniquement.', feature: 'investment', state: 'local', keywords: ['bourse', 'action', 'etf', 'portefeuille', 'paper trading', 'dcf', 'valorisation', 'finance'] },
      { name: 'Modèles et providers', description: 'Choisir le modèle local (Ollama) ou les clés cloud (Gemini, Groq, OpenRouter, Anthropic, OpenAI) — priorité Local rapide / Équilibré / Qualité max.', feature: 'settings-models', state: 'disponible', keywords: ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'ollama', 'router'] },
      { name: 'Professeur', description: 'Parcours d\'apprentissage guidés avec plan, explications et révisions espacées — bascule locale automatique si le cloud échoue.', feature: 'teacher', state: 'disponible' },
      { name: 'Agents', description: 'Agents de veille automatisés : création, exécution manuelle, historique.', feature: 'agents', state: 'disponible' },
      { name: 'Compétences (Skills)', description: 'Bibliothèque de compétences/outils réutilisables par les agents et le chat.', feature: 'skills', state: 'disponible' },
      { name: 'Générateur de prompts', description: 'Bibliothèque de modèles de prompts prêts à copier-coller.', feature: 'prompt-generator', state: 'disponible' },
      { name: 'Free AI Finder', description: 'Découvre des providers IA gratuits disponibles en ligne, exclut ceux déjà configurés dans Docteur.', feature: 'settings-models', state: 'disponible', keywords: ['gratuit', 'catalogue', 'découverte'] },
    ],
  },
  {
    emoji: '🔍',
    title: 'Recherche et connaissances',
    items: [
      { name: 'Console — Recherche et Question', description: 'Recherche sémantique dans les neurones ou question en français avec réponse sourcée (RAG).', feature: 'console', state: 'disponible' },
      { name: 'Veille IA', description: 'Synthèse de fond ou actualité web sourcée sur un sujet donné.', feature: 'console', state: 'disponible', keywords: ['veille', 'actualité', 'recherche web'] },
      { name: 'Notebook', description: 'Analyse plusieurs neurones/documents ensemble avec RAG local scopé et citations vérifiées.', feature: 'notebook', state: 'local' },
      { name: 'Kiwix hors ligne', description: 'Bibliothèque de contenus .zim consultables sans connexion (Wikipédia, etc.).', feature: 'kiwix', state: 'local' },
    ],
  },
  {
    emoji: '🧠',
    title: 'Mémoire',
    items: [
      { name: 'Mémoire adaptative', description: 'Docteur retient des préférences et des faits pertinents entre les sessions, avec budget de contexte et déduplication.', feature: 'settings-memory', state: 'disponible' },
    ],
  },
  {
    emoji: '📥',
    title: 'Fichiers et capture',
    items: [
      { name: 'Capture', description: 'Coller un lien, un texte ou un fichier (.pdf/.xlsx/.csv/.md/.txt) → analyse et neurone créé automatiquement.', feature: 'capture', state: 'disponible' },
      { name: 'Corpus 3D', description: 'Vue d\'ensemble du cortex — masquer sphères/particules, mode performance, isoler une sélection.', feature: 'corpus', state: 'disponible' },
      { name: 'Sauvegarde et restauration', description: 'Export JSON complet (neurones + synapses) et import pour restaurer.', feature: 'backup', state: 'disponible' },
      { name: 'À capturer (Todo)', description: 'Liste personnelle de liens/URLs en attente de capture.', feature: 'todo', state: 'disponible' },
    ],
  },
  {
    emoji: '🎙️',
    title: 'Audio',
    items: [
      { name: 'Lecteur audio et radio', description: 'Lecture audio intégrée, streams radio configurables.', feature: 'settings-audio', state: 'disponible' },
      { name: 'Voix et commandes vocales', description: 'Mot-clé d\'activation (Porcupine), transcription Whisper local/Groq, commandes vocales.', feature: 'settings-vocal', state: 'local', keywords: ['whisper', 'porcupine', 'transcription'] },
      { name: 'Résumé vidéo', description: 'Transcrit et résume une vidéo (YouTube ou fichier local).', feature: 'video-summary', state: 'disponible' },
    ],
  },
  {
    emoji: '🖼️',
    title: 'Images',
    items: [
      { name: 'Génération d\'images', description: 'Génération locale via ComfyUI (installation intégrée) ou providers cloud gratuits.', feature: 'images', state: 'a_configurer', keywords: ['comfyui', 'stable diffusion'] },
    ],
  },
  {
    emoji: '🔒',
    title: 'Confidentialité',
    items: [
      { name: 'Mode Strict Local', description: 'Bloque tout appel cloud — force le local même si un modèle cloud est explicitement demandé.', feature: 'settings-privacy', state: 'disponible' },
      { name: 'Journal de confidentialité', description: 'Historique des tentatives d\'appel cloud bloquées sur du contenu privé/local_only.', feature: 'settings-privacy', state: 'disponible' },
    ],
  },
  {
    emoji: '🧰',
    title: 'Outils',
    items: [
      { name: 'Agents externes', description: 'Intégration Claude Code / Codex — choix abonnement CLI ou clé API.', feature: 'settings-external', state: 'a_configurer' },
      { name: 'Connexions (YouTube, Google Drive, OneDrive)', description: 'Configurer les identifiants d\'application (Client ID/Secret) avant de lancer une vraie connexion — import toujours marqué privé/local.', feature: 'settings-connections', state: 'a_configurer', keywords: ['youtube', 'google drive', 'onedrive', 'oauth', 'connecteur'] },
      { name: 'Fichiers et dossiers surveillés', description: 'Import automatique depuis un dossier surveillé, gestion des fichiers.', feature: 'settings-files', state: 'disponible' },
      { name: 'Navigateur', description: 'Choix du navigateur que le serveur ouvre pour les liens externes (onglet Modèles).', feature: 'settings-models', state: 'disponible', keywords: ['browser', 'chrome', 'firefox', 'edge'] },
      { name: 'NotebookLM (préparation)', description: 'Clé optionnelle pour une intégration future — aucun appel réel n\'est fait aujourd\'hui (onglet Modèles).', feature: 'settings-models', state: 'a_configurer' },
    ],
  },
  {
    emoji: '🕵️',
    title: 'OSINT',
    items: [
      { name: 'Studio Sherlock', description: 'Recherche de pseudonyme sur des sites publics (GitHub, Reddit, GitLab par défaut). États, durée, profils trouvés ou absents, annulation. Une correspondance ne prouve pas une identité — résultats externes non vérifiés. Une recherche à la fois, 3 départs par minute.', feature: 'sherlock', state: 'local', keywords: ['pseudonyme', 'osint', 'profil', 'username', 'recherche'] },
    ],
  },
];

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
      { text: '"puissant [question]" → utiliser le modèle puissant configuré (par défaut un 14B quantisé, plus lent que le modèle par défaut)' },
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
  'HTTPS hors-ligne complet (mkcert) partiellement en place — les PWA Android peuvent nécessiter un certificat installé',
  'Ne va pas chercher sur internet tout seul : analyse uniquement ce que tu lui donnes ou ce que la veille IA rapporte',
  'Connecteurs Google Drive / OneDrive / YouTube : interface de configuration disponible (Paramètres → Connexions), mais aucune connexion réelle n\'a encore été établie — nécessite de créer des identifiants OAuth (Google Cloud / Azure) hors de Docteur, puis de lancer la connexion',
  'Sherlock : environnement dédié requis, base de sites figée, une recherche à la fois et 3 départs par minute. Une correspondance ne prouve pas une identité ; les résultats ne deviennent pas des instructions pour les agents.',
  'Notebook : résumé et questions/réponses disponibles ; FAQ, flashcards et chronologie pas encore implémentés',
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
  { keys: 'Alt+C',           desc: 'Activer / désactiver le contrôle gestuel par caméra' },
  { keys: 'Alt+M',           desc: 'Déclencher une commande vocale' },
  { keys: 'Alt+S',           desc: 'Activer / désactiver le partage d\'écran (capture + OCR local)' },
];

// Gestes basés sur un COMPTAGE DE DOIGTS LEVÉS (0 à 5) — invariant au mouvement
// de la main, contrairement aux anciennes formes (pincement, index seul en
// mouvement) qui se perdaient dès que la main bougeait.
export const GESTURES: Array<{ gesture: string; how: string; action: string }> = [
  {
    gesture: '🖐️ 5 doigts levés, main qui se déplace',
    how:     'Main grande ouverte (pouce inclus), tous les doigts bien écartés du poignet, déplacement lent dans le cadre',
    action:  'Fait tourner le cortex 3D (haut/bas/gauche/droite)',
  },
  {
    gesture: '✌️ 2 doigts levés (index + majeur), déplacement vertical',
    how:     'Seuls l\'index et le majeur tendus, les autres repliés — comme un signe de victoire — puis main qui monte ou descend',
    action:  'Zoom avant (main qui monte) / zoom arrière (main qui descend)',
  },
  {
    gesture: '☝️ 1 seul doigt levé (index), déplacement horizontal',
    how:     'Seul l\'index est tendu, mouvement net vers la gauche ou la droite',
    action:  'Neurone précédent / suivant — s\'ouvre réellement, comme un clic',
  },
  {
    gesture: '🤟 3 doigts levés, déplacement vertical',
    how:     'Trois doigts tendus (index, majeur, annulaire), mouvement net vers le haut ou le bas',
    action:  'Fait défiler le contenu du neurone ouvert',
  },
  {
    gesture: '✊ Poing fermé (0 doigt)',
    how:     'Tous les doigts repliés, aucun tendu',
    action:  'Relâche le contrôle — le cortex arrête de bouger',
  },
];
