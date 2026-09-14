# Diagnostic et validation des six problèmes

Les corrections sont dans le code. La perte de contenu a été reproduite avec le hook précédent, puis le parcours corrigé a été validé dans Chromium avec une véritable API Hono/SQLite isolée en mémoire. Les neurones de la base personnelle n'ont pas été modifiés par les tests de persistance.

## 1. Disponibilité au démarrage

Chronologie de la session existante, le 9 septembre 2026, heure de Paris :

| Événement | Heure | Source |
|---|---|---|
| Création du processus Vite, PID 36444 | 15:09:30.711 | `Get-Process.StartTime` |
| Création du processus backend, PID 51172 | 15:09:32.383 | `Get-Process.StartTime` |
| Backend en écoute | 15:10:20.375 | événement `cortex server started` de `cortex-server/data/cortex.log` |

Le frontend précède donc l'écoute backend de **49,664 s**. Le processus backend met **47,992 s** entre sa création et l'annonce de son écoute. Les délais fixes du lanceur étaient de trois secondes en mode PC et cinq secondes en réseau/mobile. Ils ne garantissaient pas la disponibilité de l'API.

Le serveur fonctionne ensuite : port 3001 occupé par le backend attendu et réponses HTTP normales. Les éléments consultés n'indiquent pas un cycle crash/redémarrage ou un processus résiduel comme cause de cette fenêtre d'indisponibilité. Les horodatages établissent le retard d'écoute ; ils ne ventilent pas les 47,992 s entre chargement des modules et initialisation SQLite. Je ne présente pas cette ventilation comme mesurée. Les labels PC/réseau du lanceur sont présents : la première lecture les avait mal identifiés.

Corrections :

- Les trois modes du lanceur attendent une réponse à `/api/ping`, avec délai maximum de 120 secondes et erreur explicite.
- Le frontend affiche « Connexion au serveur en cours… » et réessaie avec délai progressif plafonné à cinq secondes.
- `App` ne monte qu'après disponibilité : ses appels santé, neurones, raccourcis, jobs, etc. ne partent plus tous vers un serveur encore absent.
- Une ouverture explicite de la copie hors ligne reste proposée après quinze secondes.

Validation navigateur : refus de connexion simulés, cinq sondes avec StrictMode, affichage d'attente, **zéro appel API applicatif avant disponibilité**, puis montage automatique. Des erreurs réseau peuvent encore concerner la seule sonde pendant l'absence réelle du serveur ; la rafale de tous les composants est supprimée.

## 2. Les 6 638 entrées et la limite de 500

La limite de 500 existait déjà **à l'intérieur** de `OrbitalBrain.setPages`, avant la création des objets Three.js. Le nombre entre parenthèses dans l'ancien log était la taille de l'entrée, pas le nombre d'objets 3D créés. Il ne prouvait donc pas que 6 638 objets étaient construits.

Mesures de la base actuelle, qui contient maintenant **6 649** neurones :

| Étape | Démarrage normal | Liste complète |
|---|---:|---:|
| Total SQL/API counts | 6 649 | 6 649 |
| Réponse API | 50 métadonnées (`recent?limit=50`) | 6 649 métadonnées (`all-meta`) |
| Transformation en pages sans blocs | 50 | 6 649 |
| État React après fusion, hors créations concurrentes | 50 | 6 649 |
| Filtre d'affichage cortex, base observée sans corpus | 50 | 6 649 |
| Entrée `setPages`, avant correction | 50 | 6 649 |
| Entrée `setPages`, après correction | 50 | 500 |
| Objets neurones construits, avant et après | 50 | 500 |

Temps des lectures HTTP mesurées : counts **83 ms**, recent **34 ms**, all-meta **348 ms**. Ces temps incluent la requête et le décodage JSON côté client de mesure.

Le chargement complet est volontaire pour les filtres et la navigation de la sidebar. `loadAllMeta` l'introduit dans l'état partagé avec le cortex. Autre chemin possible lorsque le backend est absent : le fallback IndexedDB charge également toute la collection. La synchronisation complète vers IndexedDB, elle, n'injecte pas directement son résultat dans l'état React. Une session mesurée chargeait 50 entrées et synchronisait en arrière-plan 6 649 pages en **1 190 ms** pour la récupération et la lecture locale.

Corrections : sélection des 500 candidats avant l'appel de rendu, maintien du neurone sélectionné dans cette sélection, comparaison structurelle sur les candidats affichés. L'état « scène construite » n'est enregistré qu'après construction effective : une annulation du timer ne peut plus faire croire que la scène est déjà à jour. Le changement de limite ne déclenche plus un second chemin de reconstruction impérative.

Le chronomètre précédent démarrait **avant `setTimeout`** : il incluait le temps passé à attendre le thread principal. Le nouveau journal sépare `queuedMs` du temps de construction.

Comparaison reproductible sur 6 638 fiches synthétiques, Chromium headless, bloom désactivé :

| Mesure | Avant | Après |
|---|---:|---:|
| Entrées `setPages` | 6 638 | 500 |
| Ancien temps global publié | 470 ms | — |
| Attente du timer | non séparée | 335 ms |
| Construction mesurée dans le callback | non séparée | 124 ms |
| Attente + construction | 470 ms | environ 459 ms |

Le gain global de ce banc est faible. **Les 3 326 ms historiques ne sont pas comparables directement aux 124 ms de construction** : données, environnement et chronomètre diffèrent. Le chargement/rendu de la liste complète reste un coût réel ; cette correction ne prétend pas l'avoir supprimé. Un démarrage réel à 50 neurones a été mesuré à **22 ms** de construction.

## 3. Dimensions de la fiche

Le problème n'était pas `position: fixed` seul : les styles inline forçaient `top: 0`, `height: 100vh`, `maxHeight: 100vh`, une largeur de 420 px et un bas à 36 px. Ils écrasaient les marges CSS et combinaient des contraintes de hauteur incompatibles.

Les dimensions viennent maintenant du CSS responsive : haut 56 px, bas 36 px, droite 20 px, largeur 420 px avec plafond à la largeur disponible. Sur mobile, la fiche utilise toute la fenêtre. Le titre est éditable sur plusieurs lignes. Les enfants flex et le contenu préformaté sont contraints pour éviter les débordements horizontaux.

| Fenêtre | Position de la fiche | Dimensions | Débordement horizontal fiche/titre |
|---|---|---|---|
| 1 280 × 800 | x=840, y=56 | 420 × 708 | aucun |
| 900 × 600 | x=460, y=56 | 420 × 508 | aucun |
| 390 × 844 | x=0, y=0 | 390 × 844 | aucun |

Ces trois mesures ont été prises en redimensionnant la même page Chromium avec un titre long.

## 4. X d'un neurone créé par agent

Le bouton et son handler existaient. Le flux manuel `AgentsModal.handleRun → onAgentOutput → handleAgentOutput → setSelectedId` ouvrait le neurone mais laissait **AgentsModal au-dessus, à z-index 1000**, alors que l'éditeur est à 50 sur desktop. La modale conservait aussi son inscription au registre : Échap était donc bloqué par le garde-fou normal de l'application.

La modale Agents se ferme maintenant après la sauvegarde réussie et la sélection du neurone. Son démontage libère le registre. Le voile de chargement de contenu ne capture plus les clics. Les requêtes d'hydratation simultanées sont dédupliquées et une fiche complète légitimement vide n'est plus considérée comme perpétuellement à recharger.

Validation : clic sur **Exécuter maintenant dans la vraie modale Agents**, réponse d'agent déterministe, écriture complète dans SQLite, démontage de la modale, registre revenu à faux, puis clic réel sur le X et disparition de l'éditeur. Le clic peut être journalisé par `[editor] CLOSE_CLICK` avec l'identifiant seulement.

## 5. Perte du contenu agent — cause reproduite

Ancien flux :

1. `createPage` sauvegarde le neurone initial vide.
2. `handleUpdatePage` fournit le titre et les blocs de l'agent.
3. `updatePage` affecte une variable `updated` à l'intérieur d'un updater React.
4. Il vérifie cette variable immédiatement après `setPages`.
5. Dans le cas différé reproduit, React n'a pas encore exécuté l'updater : aucune sauvegarde n'est programmée. L'UI reçoit ensuite le contenu, mais SQLite conserve la première fiche vide.

Reproduction sur le hook précédent : **12 caractères dans le bloc UI, 0 caractère dans le bloc SQLite**, même après `flushAllSaves` et 1,2 seconde d'attente. Dans ce cas, ce n'est pas une seconde requête UPDATE qui efface le texte : **la sauvegarde du texte n'est jamais envoyée**.

Corrections :

- Création agent en une seule sauvegarde complète via `agentPageData` et `createPageFromData`, avant consommation de la sortie planifiée.
- Mutations calculées immédiatement sur la dernière collection, hors des updaters React rejouables.
- Écritures d'un même neurone sérialisées ; la création agent et les écritures distantes exigent la confirmation serveur. La copie locale PC est écrite d'abord ; les notes ordinaires conservent le comportement d'édition hors ligne existant si le serveur devient indisponible.
- Hydratation avant modification d'une fiche partielle et refus de sauvegarder un stub non hydraté.
- Fusion des métadonnées conservant les fiches complètes et les créations concurrentes.
- Création/suppression de liens utilisant la même file de sauvegarde, pour ne pas laisser un ancien timer écraser les nouveaux liens.
- L'indexation reçoit la page effectivement mise à jour.

Test obligatoire exécuté : création depuis la modale Agents, lecture API directe, dix changements de filtre, retour à la fiche, nouvelle lecture API, rechargement complet, réouverture et comparaison profonde de la fiche React avec la fiche SQL/API. **Toutes les comparaisons passent** : titre, blocs, type, métadonnées, liens et dates. Le contrat `AgentRunOutput` n'a pas de champ résumé séparé : son texte est contenu dans les blocs ; les métadonnées de résumé des fixtures hydratées sont également préservées.

Test complémentaire : modification de titre, deux liens bidirectionnels successifs, flush ; le titre, les deux liens et le contenu initial restent présents dans SQLite.

Test hors ligne : une note ordinaire reste enregistrée dans IndexedDB après refus de connexion ; une création agent sans confirmation serveur échoue explicitement et n'est pas annoncée comme sauvegardée.

## 6. Détection vers actions

La reconnaissance des doigts n'a pas été modifiée. Les problèmes se trouvaient après celle-ci :

- `onNext/onPrev` parcouraient `pages`, sans le filtre ni l'ordre de la sidebar.
- `onScroll` ciblait le contenu de l'éditeur ou `window`, pas la liste.
- La rotation rejetait les déplacements inférieurs à 0,01 **par frame** tout en déplaçant son origine à chaque frame : un mouvement lent pouvait être annulé indéfiniment.
- La limite de 600 ms rejetait les balayages lents ; trois doigts n'avaient pas le verrou d'une action par maintien.
- La boucle de caméra pouvait garder l'ancienne valeur du réglage debug après son activation.

La sidebar traite désormais les commandes avec sa liste filtrée/recherchée et son ordre courant. Sans sélection, elle prend le premier élément. Si ses métadonnées sont encore incomplètes, elle charge la liste complète et rejoue la commande en attente. Le contenu du neurone sélectionné est hydraté par le chemin normal. La ligne sélectionnée est remise en vue. Trois doigts défilent dans `.sidebar-list`.

Les petits déplacements de rotation s'accumulent jusqu'au seuil. Le timeout ne jette plus un balayage en cours ; le verrou empêche les répétitions de navigation et de défilement jusqu'au changement de geste. Le debug est lu par référence à chaque frame. Aucun garde-fou `anyModalOpen` ne bloquait les callbacks gestuels d'origine ; le maintien de la modale Agents concernait notamment le clic et Échap.

Tests exécutés dans le vrai hook, avec landmarks synthétiques injectés à la frontière MediaPipe :

- 0 → 1 doigt + déplacement : une action.
- Maintien et nouveaux déplacements à un doigt : aucune action supplémentaire.
- 1 → 0 → 1 : nouvelle action possible.
- Main absente : état confirmé nul.
- Trois doigts + mouvement vertical : une action de défilement par maintien.
- Cinq doigts, déplacements successifs de 0,004 : rotation transmise à `OrbitalBrain.applyGestureInput`.
- Navigation réelle dans la sidebar filtrée Articles, sélection initiale, hydratation depuis l'API et défilement DOM.

Journaux debug : `DETECTION_OK`, `GESTURE_ACCEPTED`, `GESTURE_BLOCKED`, `NAVIGATION_CALLED`, `NAVIGATION_SUCCESS`, `NAVIGATION_FAILED`. La réussite de sélection est journalisée après le changement d'état React ; les blocages indiquent notamment chargement, seuil, geste déjà consommé ou bord de liste. La commande provenant de l'application inclut la présence de `gestureInputRef` et les journaux donnent les identifiants avant/après sans contenu.

## Vérification et reproduction

- `npx tsc --noEmit` : code de sortie 0.
- `npm run test:video` : 10 tests réussis.
- `node scripts/run-six-regressions.mjs` : tests Chromium de persistance, modale, dimensions, navigation, gestes et attente serveur réussis. Nécessite Vite sur `127.0.0.1:5173`. Le runner démarre puis arrête sa propre API SQLite en mémoire sur 3002.
- `node scripts/test-brain-benchmark.mjs` : comparaison avec le fichier du commit HEAD ; le fichier temporaire de référence est supprimé après le test.
- `node scripts/test-agent-before.mjs` : reproduction du défaut du hook HEAD ; nécessite l'API de test `node cortex-server/test-regression-api.mjs` sur 3002. La référence devra être adaptée après commit des corrections.

Pour les traces : `localStorage.setItem('docteur-pipeline-debug', 'true')` et `localStorage.setItem('docteur-gesture-debug', 'true')`, puis rechargement. Les mesures/journaux n'affichent pas les textes des neurones.

Limites de validation : caméra physique et qualité du modèle MediaPipe non testées ; tests gestuels avec positions déterministes. Le résultat de génération IA est simulé dans le test de modale, mais le composant, les hooks, HTTP de persistance et SQLite sont réels. La session historique à 3 326 ms n'a pas été reproduite à l'identique. Les tests ciblés et vidéo passent ; cela ne constitue pas une vérification exhaustive de toutes les fonctionnalités de l'application.
