# MG-6 — reprise et checkpoint du 17 septembre 2026

Statut : **PARTIEL — implémentation et validations MG-6 passées ; certification globale frontend incomplète**.

## Conservation du worktree

Audit initial effectué avant écriture : git status --short, git diff --stat et git diff. L'exception safe.directory a été passée uniquement aux commandes Git, sans modifier la configuration globale. Tous les modules annoncés étaient présents. sqlite.js et server.js étaient modifiés ; modules MetaGPT non suivis. Aucun reset, checkout, stash, restauration ou suppression des contributions antérieures.

prepare-apply figurait déjà dans NO_BODY_SUFFIXES. Six fichiers JS ont passé node --check. Le modal frontend était absent.

Le PID 22288 sur 127.0.0.1:3099 a été identifié via son parent 32924 : sa ligne de commande contenait SQLITE_PATH=./data-test-metagpt-studio/cortex.sqlite et PORT=3099. Seul ce serveur confirmé a été arrêté. Les serveurs de reprise utilisent cette DB isolée, ainsi que LanceDB et les logs sous data-test-metagpt-studio. Les sauvegardes dérivent du chemin LanceDB et sont également isolées. Aucun test MG-6 n'a ciblé la vraie DB ; aucune comparaison de hash avant/après de cette DB n'a été effectuée.

## Corrections et ajouts

- prepare-apply conserve et renvoie maintenant le texte du diff, les findings, les dépendances et le package complet. Initialement GET diff ne renvoyait qu'un résumé.
- Le hash du package complet est transmis au runner apply ; toute modification après préparation invalide l'approbation.
- Validation des sources, destinations du sample, manifest, hash du diff, findings et absence de la destination avant publication.
- Publication du répertoire sample en une opération de renommage, après staging. Les erreurs avant publication nettoient le staging. Une interruption forcée du processus pendant le staging peut encore laisser un dossier temporaire caché : nettoyage après crash à compléter avant de certifier zéro résidu dans tous les scénarios.
- Annulation : le résultat tardif de planning/codegen/prepare ne remplace plus CANCELLED. Nettoyage du registre à la fermeture du child. Timeout attend la fermeture réelle. Annulation refusée pendant la courte phase APPLYING.
- API artefacts : PRD, Design, Tasks et contenu des fichiers texte servis depuis les chemins validés du workspace.
- Studio chargé par lazy/Suspense, entrée Centre d'aide et FeatureKey. Polling existant réutilisé. Mission sélectionnée conservée localement et données persistées côté SQLite.
- Boutons d'approbation/application conditionnels au hash, aux fichiers, au package, aux findings et à l'état. Aucune commande brute exposée.

## Preuves réelles

1. Mission 8c337e32-13e9-4f0d-a8b4-739a6edb3db3 : planning Ollama qwen2.5:7b, codegen, prepare-apply sans body : HTTP 200, AWAITING_APPROVAL. GET diff a révélé le résumé incomplet.
2. Mission 13f5b212-e697-4b40-9a32-1dfa1dc13626 : nouveau planning/codegen réels ; diff complet consultable et hash vérifié. Mauvais hash et mauvaise liste : HTTP 409 ; approbation correcte : HTTP 200 ; apply : APPLIED. Octets appliqués vérifiés. Seul greeting.js de ce sample a été supprimé après vérification de son hash, puis son répertoire vide.
3. Mission 05c36151-1f54-4b47-95dc-c76990b2b27e : smoke navigateur → API 3099 → Ollama → code texte → revue du diff, **13/13 contrôles**, arrêté avant approbation et apply. Capture : metagpt-evidence/real-review.png.

Les six compteurs GitGuard renvoyés par le codegen réel étaient tous à zéro : ProjectRepo.__init__, GitRepository.__init__, Repo.init, shell_execute, push, clone_from. Aucun code généré n'a été exécuté.

## Tests

| Groupe | Résultat |
|---|---|
| Backend MG-6 : node --test test-metagpt-studio.mjs | 13/13 |
| MG-2G Node | 25/25 |
| MG-2G Python + MG-2H | 32/32 + 4/4 |
| Codegen policy Python | 17/17 |
| Studio navigateur simulé | 18/18 |
| Smoke Studio réel, sans apply | 13/13 |
| Suite backend Docteur node:test | 593/593, zéro skip |
| Typecheck | PASS |
| Build | PASS, avertissement de taille des chunks |

Commandes de certification backend : fichiers test-*.mjs contenant node:test, exécutés avec --experimental-test-module-mocks --test --test-concurrency=1. Le flag historique vidéo est inclus. Voir metagpt-evidence/backend-tests.log.

La première commande englobant tous les test-*.mjs incluait deux auxiliaires : test-find-eval.mjs (diagnostic navigateur manuel) et test-regression-api.mjs (serveur permanent). Elle a été arrêtée, puis remplacée par la sélection des véritables suites node:test, toutes passées. Ne pas confondre cette tentative avec un PASS global de tous les scripts auxiliaires.

Trois scripts frontend existants restent non certifiés : test-startup-gate.mjs, test-six-regressions.mjs et test-gesture-chain.mjs. Le premier échoue car le serveur Vite 5173 manque ; les deux autres expirent au chargement de leurs harness. Ils exigent une relance avec leurs prérequis (Vite 5173 ; API SQLite en mémoire 3002 pour six-regressions). Le démarrage de Vite a été refusé par la revue automatique en raison d'une limite d'usage. Aucun contournement. Le test-frontend-browser.mjs général reste également à lancer avec un serveur approprié.

Le lancement sous compte sandbox ne permettait pas de terminer rapidement les enfants Python ni de vérifier le SHA Git MetaGPT. Les relances autorisées hors sandbox ont validé fermeture des enfants et SHA attendu. Le test timeout impose désormais une durée inférieure à cinq secondes pour éviter un faux PASS sur une sortie naturelle après 60 secondes.

## MG-6 FINAL provisoire

| Critère | Verdict |
|---|---|
| Backend API | PASS sur les scénarios exécutés |
| Studio MetaGPT UI | PASS, 18 contrôles |
| State machine | PASS sur transitions testées |
| Planning réel / codegen réel | PASS |
| Prepare Apply | PASS |
| Human approval binding | PASS, inclut package drift |
| Exact Apply | PASS, samples uniquement |
| Cancel / timeout | PASS pour les enfants de test ; certification complète après crash à compléter |
| Terminal / Bash / Browser / Git | BLOQUÉS par les policies testées |
| Internet externe / cloud | Configuration Ollama locale observée ; pas de certification réseau indépendante exhaustive |
| Credentials transmis | Environnement filtré ; zéro clé fournisseur volontairement transmise |
| Code généré exécuté / auto-apply / auto-approve | 0 |
| Approval bypass testé | 0 |
| Écritures dans des fichiers existants du projet par apply | 0 |
| Unexpected writes après interruption forcée du staging | Non certifié |
| Patches amont MetaGPT supplémentaires | 0 |
| Suite Docteur frontend complète | INCOMPLÈTE |
| MG-6 | PARTIEL |

Travail conservé non commité. La mission Sherlock reçue ensuite ne doit pas écraser ce travail. Les serveurs lancés pendant la reprise doivent être arrêtés via leurs sessions exactes lorsque leurs tests sont terminés.
