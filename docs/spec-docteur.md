PLAN DOCTEUR — VERSION LEGERE LOCALE

PREAMBULE

Cette version de Docteur est conçue pour un usage pragmatique : on allume le PC quand on veut travailler ou consulter ses données, Docteur démarre automatiquement avec Windows, on l'utilise, on éteint le PC en partant. Pas de serveur 24/7, pas de cloud, pas de complications.

Configuration cible :
- Windows avec RTX 5060 et 32 GB RAM
- Petits modèles locaux : llama3.2:3b + nomic-embed-text
- Ollama démarre automatiquement avec Windows
- Serveur cognitif démarre automatiquement avec Windows
- Docteur accessible via raccourci sur le bureau

Objectif principal : rechercher facilement dans ses données personnelles avec une recherche sémantique intelligente.

Legende des roles :
- TOI : actions manuelles
- CLAUDE CODE : prompt à donner à Claude Code
- VALIDATION : tests avant de passer à la suite


==========================================
PHASE 0 — CREATION DU FRONTEND DOCTEUR
==========================================

Objectif : créer le projet de base Docteur (frontend React) qui servira de fondation pour toutes les phases suivantes.

Stack technique :
- React 18 + TypeScript
- Vite comme bundler
- Tailwind CSS pour le styling
- Three.js pour le cortex 3D
- Lucide React pour les icônes
- Stockage local via IndexedDB (avec idb-keyval pour simplifier)

Architecture du projet :

/docteur
  package.json
  vite.config.ts
  tsconfig.json
  tailwind.config.js
  index.html
  /docs
    spec-docteur.md
  /src
    main.tsx
    App.tsx
    /components
      /neural
        NeuralBrain.tsx
      /blocks
        Block.tsx
      /layout
        Sidebar.tsx
        TopBar.tsx
        RightPanel.tsx
    /lib
      storage.ts
      types.ts
    /hooks
    /styles
      globals.css

Fonctionnalités minimum de la Phase 0 :

1. Affichage du cortex 3D vivant (cerveau de neurones avec rotations, halos, synapses, pulsations)
2. Sidebar avec liste des pages (neurones)
3. Création, édition, suppression de pages
4. Système de blocs basique (h1, h2, paragraphe, todo, liste)
5. Stockage local persistant (IndexedDB)
6. Panneau droit avec le cortex 3D et actions
7. Topbar avec indicateurs de session

Identite visuelle :
- Palette neuro-organique : fond noir-violet #0a0814, accents émeraude #3dffaa et magenta #ff4dcb, cyan #5ee7ff pour les neurones utilisateur
- Typographie : Space Grotesk pour les titres, IBM Plex Mono pour le corps
- Coins arrondis, effet verre dépoli sur les panneaux
- Animations omniprésentes mais douces

Validation Phase 0 :
- Le projet démarre avec npm run dev sur localhost:5173
- Le cortex 3D tourne correctement
- On peut créer/éditer/supprimer des pages
- Les données sont persistées entre rechargements
- L'interface est cohérente avec la charte visuelle


==========================================
PHASE 1 — SERVEUR COGNITIF MINIMAL
==========================================

Objectif : créer un petit serveur Node qui s'occupe d'indexer les neurones et de faire la recherche sémantique.

Stack technique :
- Node 20+ avec ESM modules
- Hono pour les routes HTTP
- @lancedb/lancedb pour le stockage vectoriel
- ollama (client npm officiel)
- dotenv pour la config
- pino pour les logs structurés
- better-sqlite3 pour les logs persistants

Architecture du dossier :

/cortex-server
  package.json
  .env.example
  /src
    server.js
    /lib
      ollama.js
      lancedb.js
      sqlite.js
      logger.js
    /routes
      health.js
      index.js
      search.js
      answer.js
      neuron.js
  /data
  README.md
  start.bat

Modeles utilises :
- nomic-embed-text pour les embeddings (270 MB)
- llama3.2:3b pour les synthèses de réponses (2 GB)

Endpoints a implementer :

GET /api/health
Vérifie Ollama, les modèles installés, l'état de LanceDB. Retourne le statut global.

POST /api/index
Reçoit { id, kind, title, content, metadata? }. Calcule l'embedding via nomic-embed-text. Stocke dans LanceDB en upsert. Retourne { ok: true, dimensions: 768, latency_ms }.

POST /api/search
Reçoit { query, limit?: 5, threshold?: 0.5, filter_by_kind?: string[] }. Calcule l'embedding de la query. Recherche cosinus dans LanceDB. Filtre par seuil et par kind si spécifié. Retourne { results, count, latency_ms }.

POST /api/answer
Reçoit { question, max_context?: 5 }. Workflow complet :
1. Embedding de la question
2. Recherche top-5 neurones dans LanceDB
3. Construit le prompt système : "Tu es Docteur, un assistant qui aide à retrouver des informations personnelles. Réponds en t'appuyant uniquement sur les neurones fournis. Cite les sources par leur titre. Si tu ne trouves pas, dis-le. Sois direct et concis."
4. Appelle llama3.2:3b avec le contexte
5. Retourne { answer, sources, latency_ms, model_used }

DELETE /api/neuron/:id
Supprime un neurone de LanceDB par son id.

Configuration (.env.example) :

PORT=3001
HOST=127.0.0.1
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
ANSWER_MODEL=llama3.2:3b
LANCEDB_PATH=./data/cortex.lance
SQLITE_PATH=./data/cortex.sqlite
LOG_LEVEL=info
LOG_FILE=./data/cortex.log

Contraintes :
- CORS ouvert pour http://localhost:5173 (frontend Vite Docteur)
- Si Ollama est down : tous les endpoints renvoient 503 avec message clair, pas de crash
- Tous les endpoints en JSON
- Logs structurés via pino, écrits dans data/cortex.log ET console
- Chaque requête loggée avec : endpoint, latence, modèle utilisé

Scripts npm :
- "start": "node src/server.js"
- "dev": "nodemon src/server.js"
- "check": vérifie Ollama + modèles sans démarrer

start.bat :
Script Windows pour lancer le serveur d'un double-clic.

Validation Phase 1 :
- Serveur démarre sans erreur
- Health endpoint répond OK avec les 2 modèles listés
- Indexation de neurones tests fonctionne
- Recherche retourne les bons résultats avec scores
- RAG génère des réponses en 2-5 secondes
- Si Ollama est coupé, pas de crash


==========================================
PHASE 2 — INTEGRATION CORTEX AVEC INDEXATION AUTO
==========================================

Objectif : chaque neurone créé ou modifié dans Docteur est automatiquement indexé dans le serveur cognitif.

Module client :
Créer /src/lib/cortex/client.ts qui expose :
- cortexClient.health()
- cortexClient.indexNeuron(neuron)
- cortexClient.deleteNeuron(id)
- cortexClient.search(query, opts)
- cortexClient.answer(question, opts)
- cortexClient.isAvailable() avec cache 10s

URL de base : http://localhost:3001

Hook useCortex :
Le hook doit :
- Pinger /api/health toutes les 10 secondes
- Indexer automatiquement chaque page modifiée (debounce 1500ms)
- Garder une queue locale si serveur down
- Re-tenter quand le serveur revient
- Exposer { available, indexing, queueSize, lastCheck }

Fonction pageToIndexableContent :
Concatène titre + contenu textuel de tous les blocs de la page pour créer le contenu à indexer.

Indicateur visuel topbar :
Nouvel indicateur "CORTEX" à côté de "NEURAL ACTIVE" :
- Vert = serveur OK
- Jaune = indexation en cours
- Rouge = serveur déconnecté

Tooltip au survol : "X neurones indexés, Y en attente"

Indicateur sur neurones 3D :
Mini-ring jaune clignotant pendant indexation sur les neurones utilisateur. Disparaît une fois indexé.

Suppression de neurones :
Appeler aussi cortexClient.deleteNeuron(id) pour nettoyer l'index. Queue de suppression différée si serveur down.

Bouton "Re-indexer tout" :
Dans le panneau cerveau, section actions. Lance la réindexation complète avec barre de progression.

Contrainte importante :
Docteur doit marcher à 100% même si le serveur cognitif est down. L'indexation est un bonus.

Validation Phase 2 :
- Indicateur "CORTEX" vert quand serveur tourne
- Création de neurone fait apparaître brièvement l'anneau jaune
- Couper le serveur passe l'indicateur en rouge mais Docteur continue
- Relancer le serveur vide la queue
- Suppression de neurone le retire de LanceDB
- Bouton "Ré-indexer tout" fonctionne avec progression


==========================================
PHASE 3 — CONSOLE DE RECHERCHE INTELLIGENTE
==========================================

Objectif : une interface simple et puissante pour retrouver ses données.

Activation :
- Raccourci clavier Ctrl+L
- Bouton dans la topbar : icône loupe avec label "Chercher"

Deux modes :
Mode Recherche rapide (par défaut) et Mode Question. Toggle entre les deux via un bouton "RECHERCHER / DEMANDER".

Interface :
- Modal plein écran avec backdrop blur
- Zone centrale max-width 720px
- Header : titre "Console" + toggle mode + bouton fermer
- Input large en haut
- Zone résultats / réponse en dessous
- Bordure émeraude lumineuse animée

Mode Recherche rapide :
Au fur et à mesure que l'utilisateur tape (debounce 300ms) :
- Appel à cortexClient.search(query, { limit: 8 })
- Affichage des résultats en liste :
  * Icône du kind avec couleur
  * Titre en gras
  * Extrait du contenu (100 premiers chars)
  * Score de pertinence en % avec barre colorée
- Au clic sur un résultat : ferme la modal et navigue vers le neurone
- Tri par score décroissant

Mode Question :
L'utilisateur tape sa question, appuie sur Entrée :
- Appel à cortexClient.answer(question)
- Pendant la requête :
  * Animation de réflexion (3 points qui pulsent)
  * Neurones sources s'illuminent en blanc dans le cortex 3D en arrière-plan
- A l'arrivée de la réponse :
  * Affichage avec effet streaming caractère par caractère (30ms par char)
  * Pills cliquables des sources en dessous
  * Footer : "Synthétisé à partir de X neurones · Latence: Y ms"

Cas pas de resultats :
Message "Je n'ai rien trouvé dans ton cortex sur ce sujet" + bouton "Créer un neurone à ce sujet" qui crée directement une page.

Historique de session :
Tant que la modal n'est pas fermée, l'historique des recherches/questions est conservé. Bouton "Nouvelle session" pour vider.

Raccourcis clavier :
- Ctrl+K dans la modal : toggle entre les deux modes
- Escape : ferme la modal
- Enter : lance la recherche
- Shift+Enter : passe à la ligne (mode question)
- Flèche haut : navigue dans l'historique

Filtrage par kind :
Boutons de filtre par kind en haut de la zone résultats.

Indicateur de disponibilite serveur :
Si serveur down, message en haut de la modal : "Le serveur cognitif n'est pas disponible. Démarre-le pour utiliser la recherche intelligente." + bouton "Réessayer".

Validation Phase 3 :
- Ctrl+L ouvre la Console
- Recherche sémantique fonctionne (taper "wifi" trouve le mot de passe wifi)
- Recherche par concept fonctionne (taper "manger" trouve les recettes)
- Scores affichés sont cohérents
- Cliquer un résultat navigue vers le bon neurone
- Mode Question donne de vraies réponses contextualisées
- Pendant traitement, neurones sources s'illuminent dans le cortex
- Effet streaming caractère par caractère fluide
- Filtrage par kind fonctionne


==========================================
PHASE 4 — DEMARRAGE AUTOMATIQUE AVEC WINDOWS
==========================================

Objectif : quand on allume le PC, tout est prêt automatiquement.

Configuration Ollama :
Ollama est déjà configuré pour démarrer automatiquement comme service Windows depuis l'installation. A vérifier dans services.msc.

Script de demarrage :
Créer un fichier start-docteur.bat dans le dossier du projet avec :
- Vérification d'Ollama
- Démarrage du serveur cognitif en arrière-plan
- Démarrage du frontend Docteur en arrière-plan
- Ouverture optionnelle du navigateur sur http://localhost:5173

Raccourci dans le dossier Demarrage :
Coller un raccourci du script dans le dossier shell:startup de Windows pour démarrage automatique.

Raccourci bureau :
Créer un raccourci "Docteur" sur le bureau pointant vers http://localhost:5173 avec une icône personnalisée.

Script PowerShell robuste (optionnel) :
Version améliorée avec :
- Vérification d'Ollama avec retry
- Vérification de la présence des modèles
- Démarrage propre des services
- Logs d'erreurs
- Notification de réussite

Validation Phase 4 :
- Redémarrer le PC complètement
- Ollama tourne automatiquement
- Le serveur cognitif démarre automatiquement
- Docteur démarre automatiquement
- Le navigateur ouvre Docteur si configuré
- Le raccourci bureau fonctionne


==========================================
PHASE 5 — PAGE ADMIN MINIMALE
==========================================

Objectif : une page simple pour voir l'état de Docteur et faire de la maintenance.

Acces :
Icône Settings dans la sidebar, en dessous des dossiers.

Onglet 1 : Etat
- Statut serveur cognitif (vert/rouge)
- Statut Ollama (vert/rouge)
- Liste des modèles installés avec taille
- Nombre de neurones total dans Docteur
- Nombre de neurones indexés dans LanceDB
- Bouton "Synchroniser" si décalage
- Espace disque utilisé par LanceDB
- Bouton "Tester la recherche" qui ouvre la Console

Onglet 2 : Logs
- 50 dernières requêtes au serveur cognitif
- Filtres par type (indexation, recherche, réponse, erreurs)
- Affichage : timestamp, type, latence, status
- Bouton "Effacer les logs"
- Bouton "Exporter les logs"

Onglet 3 : Maintenance
- Bouton "Ré-indexer tout le cortex" (avec confirmation)
- Bouton "Backup du cortex" (export JSON)
- Bouton "Restaurer un backup" (import JSON)
- Bouton "Vider l'index LanceDB" (double confirmation, irréversible)
- Informations système : version Node, version Ollama, OS

Endpoints serveur cognitif :
- GET /api/logs : 100 dernières lignes du fichier log en JSON
- GET /api/stats : statistiques globales
- POST /api/reindex : déclenche la réindexation
- POST /api/clear : vide LanceDB avec confirmation

Design :
Style cohérent avec le reste de Docteur (émeraude, magenta, fond sombre, Space Grotesk et IBM Plex Mono).

Validation Phase 5 :
- Page admin accessible via sidebar
- Onglet Etat affiche les vraies infos
- Onglet Logs montre les requêtes récentes
- Onglet Maintenance permet réindexation et backup
- Backup JSON contient tous les neurones
- Restauration depuis backup fonctionne


==========================================
RECAPITULATIF
==========================================

Avec ces 6 phases (environ 12-16h de développement étalées sur plusieurs sessions), tu obtiens :
- Frontend Docteur complet avec cortex 3D vivant
- Recherche sémantique intelligente dans tes données personnelles
- Synthèses de réponses par RAG
- Indexation automatique de chaque neurone créé
- Démarrage automatique avec Windows
- Page admin pour monitoring et maintenance
- 100% local, 100% privé
- Léger : 2,3 GB de modèles seulement


==========================================
EVOLUTIONS FUTURES POSSIBLES
==========================================

A ajouter à la carte selon les besoins réels qui émergeront :
- Synapses émergentes automatiques entre neurones proches
- Agents complexes pour des missions multi-étapes
- Mode vocal (Whisper + Kokoro)
- Accès mobile via PWA et synchronisation
- Hub dédié toujours allumé (Raspberry Pi, ZimaBoard)
- Modèles plus puissants (qwen2.5:7b ou 14b)
- Cas d'usage avancés (surveillance vidéo, trading, gestion projets)


==========================================
REGLES A RESPECTER
==========================================

A chaque phase, commencer le prompt à Claude Code par :

"Reference : voir docs/spec-docteur.md, phase [N]. Implémente uniquement cette phase, sans toucher aux phases suivantes. Respecte l'architecture déjà en place."

Une phase à la fois. Validation complète avant la suivante.