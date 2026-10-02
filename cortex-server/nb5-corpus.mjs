// NB-5 — memory quality corpus (SYNTHETIC, French, no personal data; "sensitive" entries are made up).
// 4 scopes: 3 projects (docteur / boutique / blog) + GLOBAL + one NOTEBOOK. Includes superseded, revoked and
// sensitive memories, cross-project traps, unresolved-project queries, paraphrases and unrelated negatives.

// [key, type, scope, statement, state]
//   scope: 'G' (GLOBAL) | 'P:<project>' | 'N' (the corpus notebook)
//   state: 'ok' | 'sup:<newKey>' (superseded by newKey) | 'rev' (revoked) | 'sens' | 'hsens'
export const PROJECTS = { docteur: 'Docteur', boutique: 'Boutique', blog: 'Blog' };
export const MEMORIES = [
  ['d1', 'DECISION', 'P:docteur', 'Device Fabric est gelé en V1 : aucune évolution sans nouvelle mission.', 'ok'],
  ['d2', 'DECISION', 'P:docteur', 'OMEGA V2 est certifié et gelé ; toute nouvelle capacité exige une nouvelle mission.', 'ok'],
  ['d3', 'DECISION', 'P:docteur', 'La recherche du Notebook utilise seulement FTS5 pour les documents.', 'sup:d4'],
  ['d4', 'DECISION', 'P:docteur', 'La recherche du Notebook combine FTS5 et LanceDB avec fusion RRF.', 'ok'],
  ['d5', 'CONSTRAINT', 'P:docteur', 'Le mode STRICT LOCAL interdit tout appel réseau sortant depuis le Notebook.', 'ok'],
  ['d6', 'TECHNICAL_DISCOVERY', 'P:docteur', 'Le modèle nomic-embed-text produit des vecteurs de dimension 768 et exige les préfixes search_document et search_query.', 'ok'],
  ['d7', 'REQUIREMENT', 'P:docteur', 'Les citations du Notebook doivent renvoyer au passage exact et à la version du document.', 'ok'],
  ['d8', 'WORKFLOW', 'P:docteur', 'Avant chaque livraison, lancer la vérification de types puis le build puis les tests navigateur.', 'ok'],
  ['d9', 'PROJECT_FACT', 'P:docteur', 'Le serveur Cortex écoute sur le port 3940 en local uniquement.', 'ok'],
  ['d10', 'DECISION', 'P:docteur', 'Les polices Google Fonts sont chargées depuis le CDN.', 'rev'],
  ['d11', 'RESOLVED_QUESTION', 'P:docteur', 'Le seuil de similarité vectorielle a été calibré à 0,7 avec des embeddings réels.', 'ok'],
  ['d12', 'OPEN_QUESTION', 'P:docteur', 'Faut-il chiffrer la base SQLite du Notebook au repos ?', 'ok'],
  ['d14', 'DECISION', 'P:docteur', 'Le connecteur YouTube Shorts utilise yt-dlp sans cookies ni identifiants.', 'ok'],
  ['b1', 'DECISION', 'P:boutique', 'La base de données de la boutique est PostgreSQL 16 avec pgbouncer.', 'ok'],
  ['b2', 'CONSTRAINT', 'P:boutique', 'Les paiements passent uniquement par le prestataire Stripe en mode test.', 'ok'],
  ['b3', 'DECISION', 'P:boutique', 'Le panier est stocké dans Redis.', 'sup:b4'],
  ['b4', 'DECISION', 'P:boutique', 'Le panier est stocké en base PostgreSQL avec expiration après sept jours.', 'ok'],
  ['b5', 'REQUIREMENT', 'P:boutique', 'Les factures PDF sont générées en français avec la TVA à vingt pour cent.', 'ok'],
  ['b6', 'WORKFLOW', 'P:boutique', 'Le déploiement de la boutique se fait par pipeline CI le vendredi matin.', 'ok'],
  ['b7', 'TECHNICAL_DISCOVERY', 'P:boutique', 'L\'index sur la colonne email accélère la recherche des clients de dix fois.', 'ok'],
  ['b8', 'PROJECT_FACT', 'P:boutique', 'Le catalogue contient environ douze mille produits répartis en quarante catégories.', 'ok'],
  ['g1', 'DECISION', 'P:blog', 'Le blog est généré par un générateur statique avec des articles en Markdown.', 'ok'],
  ['g2', 'PREFERENCE', 'P:blog', 'Les articles du blog utilisent un ton informel et des titres courts.', 'ok'],
  ['g3', 'WORKFLOW', 'P:blog', 'Les images du blog sont compressées en WebP avant publication.', 'ok'],
  ['g4', 'PROJECT_FACT', 'P:blog', 'Le blog est hébergé sur un serveur statique avec un certificat renouvelé automatiquement.', 'ok'],
  ['g5', 'DECISION', 'P:blog', 'Les commentaires du blog sont gérés par un service externe.', 'rev'],
  ['G1', 'PREFERENCE', 'G', 'Toujours répondre en français avec des phrases courtes.', 'ok'],
  ['G2', 'PREFERENCE', 'G', 'Préférer des exemples concrets plutôt que de longues explications théoriques.', 'ok'],
  ['G3', 'CONSTRAINT', 'G', 'Ne jamais proposer d\'envoyer des données personnelles vers un service cloud.', 'ok'],
  ['G4', 'WORKFLOW', 'G', 'Avant toute modification destructive, demander une confirmation explicite.', 'ok'],
  ['n1', 'PROJECT_FACT', 'N', 'Ce notebook rassemble les notes de recherche sur la calibration des embeddings.', 'ok'],
  ['n2', 'DECISION', 'N', 'Dans ce notebook, les extraits sont classés par date de publication.', 'ok'],
  ['s1', 'PERSONAL_NOTE', 'G', 'Rendez-vous chez le dentiste le mois prochain.', 'sens'],
  ['h1', 'PERSONAL_NOTE', 'G', 'Le code de la porte d\'entrée est noté dans le carnet papier.', 'hsens'],
];

// [query, context, expectedKeys, options]  — context: { project, notebook }
// expected = [] means "no memory should be injected" (negative or trap).
const D = { project: 'docteur' }; const B = { project: 'boutique' }; const BL = { project: 'blog' }; const NONE = {}; const DN = { project: 'docteur', notebook: true };
export const QUERIES = [
  // positive — Docteur
  ['Où en est Device Fabric ?', D, ['d1']], ['Peut-on ajouter des fonctions à OMEGA ?', D, ['d2']], ['Comment fonctionne la recherche dans le Notebook ?', D, ['d4']],
  ['Le Notebook peut-il appeler internet ?', D, ['d5']], ['Le système peut-il faire des requêtes vers l\'extérieur ?', D, ['d5']], ['Quelle dimension ont les embeddings nomic ?', D, ['d6']],
  ['Combien de dimensions font les vecteurs ?', D, ['d6']], ['Comment doivent être faites les citations ?', D, ['d7']], ['Que faire avant de livrer ?', D, ['d8']],
  ['Sur quel port tourne le serveur Cortex ?', D, ['d9']], ['Quel seuil de similarité utilise-t-on ?', D, ['d11']], ['Chiffre-t-on la base SQLite ?', D, ['d12']], ['yt-dlp utilise-t-il des cookies ?', D, ['d14']],
  // positive — Boutique
  ['Quelle base de données pour la boutique ?', B, ['b1']], ['Comment sont gérés les paiements ?', B, ['b2']], ['Où est stocké le panier ?', B, ['b4']], ['Quelle TVA sur les factures ?', B, ['b5']],
  ['Quand déploie-t-on la boutique ?', B, ['b6']], ['Pourquoi un index sur email ?', B, ['b7']], ['Combien de produits au catalogue ?', B, ['b8']],
  // positive — Blog
  ['Comment est généré le blog ?', BL, ['g1']], ['Quel ton pour les articles ?', BL, ['g2']], ['Comment traiter les images du blog ?', BL, ['g3']],
  // positive — GLOBAL
  ['Dans quelle langue répondre ?', B, ['G1']], ['Puis-je envoyer mes données personnelles vers le cloud ?', D, ['G3']], ['Que faire avant de supprimer des fichiers ?', BL, ['G4']], ['Dans quelle langue répondre ?', NONE, ['G1']],
  // positive — NOTEBOOK
  ['Que contient ce notebook ?', DN, ['n1']], ['Comment sont classés les extraits ?', DN, ['n2']],
  // positive — historical
  ['Qu\'utilisions-nous avant pour la recherche du Notebook ?', D, ['d3'], { includeHistorical: true }], ['Où était stocké le panier avant ?', B, ['b3'], { includeHistorical: true }],
  // traps — must return nothing (revoked / other project / unresolved / other notebook / sensitive)
  ['Quelles polices utilise-t-on ?', D, []], ['Qui gère les commentaires ?', BL, []],
  ['Quelle base de données pour la boutique ?', D, []], ['Device Fabric est-il gelé ?', B, []], ['Où est stocké le panier ?', BL, []], ['Comment est généré le blog ?', D, []],
  ['Que contient ce notebook ?', D, [], { leakOnly: true }], ['Quelle base de données pour la boutique ?', NONE, []], // leakOnly: project memories about "Notebook" may legitimately match; only n1/n2 must not leak
  ['Quand est mon rendez-vous chez le dentiste ?', D, []], ['Où est noté le code de la porte ?', D, []],
  // negatives — unrelated
  ['Quelle est la capitale de l\'Australie ?', D, []], ['Donne-moi une recette de tarte aux pommes.', D, []], ['Comment fonctionne la photosynthèse ?', B, []], ['Écris un poème sur l\'automne.', BL, []],
  ['Combien font 17 fois 23 ?', D, []], ['Qui a gagné la coupe du monde en 1998 ?', B, []], ['Explique la différence entre TCP et UDP.', D, []], ['Comment configurer un routeur wifi ?', D, []], ['Traduis « bonjour » en japonais.', BL, []],
].map(([q, ctx, exp, opts]) => ({ query: q, ctx, expected: exp, opts: opts ?? {} }));
