# FINAL REVIEW — STARTUP-2 (port 3001, démarrage, cycle de vie, réseau)

> **Version publique (2026-11-13)** — copie anonymisée du rapport interne du 2026-10-22. Le contenu technique, les mesures et les verdicts sont inchangés ; les statuts sont ceux du 2026-10-22 (état au moment de la publication : addendum de FINAL_REVIEW.md).

Date : 2026-10-22 · Base : `b9eeeb4266450a34ab5625e32378c01d5be57b56` (HEAD = origin/main = remote) · aucun staging, commit
ni push. Détails : AUDIT.md, ARCHITECTURE.md, TESTS.md, NETWORK.md.

## Synthèse par phase

| Phase | Avant | Après | Verdict |
|---|---|---|---|
| A — 3001 | `taskkill /F` de tout écouteur | identité prouvée (entrée + ancrage dépôt + chaîne de création + loopback) ; seul arrêt = backend Docteur confirmé, muet ≥ 45 s, accord explicite, épinglé + revérifié, watcher+serveur seulement | PORT_3001_READY |
| B — démarrage | erreurs effacées par `cls`, attente aveugle, aucun crash détecté, sonde frontend 2 s trop courte | états explicites, progression réelle, crash/sortie/absence détectés tôt, budgets 120/60 s inchangés, diagnostic codé conservé + journal | STARTUP_READY |
| C — cycle de vie | consoles abandonnées, doublons, aucun verrou | réutilisation des services sains, attente d'un démarrage en cours, verrou atomique, consoles signalées jamais fermées, Chrome jamais touché | LIFECYCLE_READY |
| D — réseau | `ollama serve` → ollama.com ; npm update check | Ollama lancé par Docteur : `OLLAMA_NO_CLOUD=1` + loopback ; npm notifier coupé ; mesure réelle 0 EXTERNAL | NETWORK_READY (tiers documentés) |

## Revue du diff (§16)

1. Périmètre : `Docteur-Launcher.bat`, `scripts/` (3 modules, 1 fixture, 4 suites), `scripts/test-wait-for-frontend.mjs`
   (contrat adapté), rapports. Aucun fichier MAÎTRE, Notebook, KG, Companion, Recorder, Kiwix, Arcade, Root Policy, PDF.
2. Chemins Windows : normalisation `path.win32`, comparaison insensible à la casse, frontière stricte des préfixes,
   chemins avec espaces gérés (guillemets), caractères dangereux pour cmd refusés.
3. Terminaisons : `grep taskkill` sur le lanceur = 0 ; l'unique `Kill()` est sur des handles épinglés après revérification.
   (`taskkill` restant uniquement dans le nettoyage des tests, sur leurs propres enfants.)
4. Erreurs : chaque échec = code stable + phrase + action ; jamais de throw non géré pour un échec opérationnel.
5. Timeouts : tous bornés (120 s, 60 s, 45 s, 15 s, 20 s, 60 s confirmation, 15 s instantané, 20 s session épinglée).
6. Diagnostics : le chemin d'échec du .bat n'a plus de `cls` ; journal local sans lignes de commande.
7. Réseau : aucune nouvelle destination ; le lanceur ne contacte que le loopback (test statique).
8. Données privées : les lignes de commande ne sont lues que pour node/cmd, jamais affichées ni journalisées.
9. Régressions : suites Web Egress, Strict Local, LAN, port-preflight, STARTUP-1, écran de démarrage, typecheck : vertes.

## Changements de comportement visibles

- Un backend/une interface Docteur sains sont **réutilisés** au lieu d'être tués puis relancés (relance plus rapide, plus
  de consoles orphelines).
- Un moteur Docteur lancé à la main hors du lanceur (terminal VS Code…) n'est plus tué : le lanceur refuse et explique
  (identité non prouvable).
- Le lanceur ajoute ~2 s par instantané système (2-3 au démarrage).
- Les modèles `…-cloud` d'Ollama ne fonctionnent pas avec un Ollama démarré par le lanceur.

## Limites restantes

Voir FINAL_REAL_STARTUP_CERTIFICATION.md §14-15, POST_CERTIFICATION_STABILIZATION.md §8 et l'addendum ci-dessous.

## Addendum — publication (2026-11-13)

- Base : `origin/main` `d1ae6ac` (corrections de confidentialité C1a à C3d incluses). Le lot MAÎTRE a été publié depuis
  (`5d0ec47`) : l'audit statique Root Policy passe à **13/13** ; le seul échec (12/13) du 2026-10-22 est résolu.
- Ajout pour la publication : `Docteur-Launcher.bat` démarre dans son propre dossier (`cd /d "%~dp0"`, variable
  `DOCTEUR_ROOT`) au lieu d'un chemin d'installation fixe. Le raccourci existant reste valable ; une autre copie du dépôt
  se lance elle-même. Contrôles : test statique ajouté à `scripts/test-wait-for-frontend.mjs` (échoue sur l'ancienne
  version, passe sur la nouvelle) et sonde `.bat` jetable (dossier contenant des espaces, lancement depuis un autre
  répertoire).
- Tests exécutés pour la publication (intercepteur réseau : 0 tentative ; aucun démarrage de Docteur ; aucun processus
  réel arrêté) : identité 12/12, orchestrateur 44/44, verrou 6/6, fenêtre existante 5/5, wait-for-frontend 9/9, écran de
  démarrage 12/12 ; sec3 3/3 (test de démarrage réel exclu), Root Policy statique 13/13 et intégrité 38/38,
  port-preflight 8/8 et 24/24, Web Egress statique 7/7, LAN final-review 3/3, garde hors ligne 1/1, Strict Local 6/6.
- Non ré-exécutés pour la publication : `test-launcher-real-processes.mjs` et `test-backend-run-modes.mjs` (vrais
  processus Windows et `npm`) ; derniers résultats 4/4 ×3 et 2/2 ×3 le 2026-10-22. Le démarrage depuis le dossier du
  lanceur n'a pas encore été validé par un lancement réel.
