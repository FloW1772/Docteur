# FINAL REAL STARTUP CERTIFICATION — 2026-10-22

> **Version publique (2026-11-13)** — copie anonymisée du rapport interne du 2026-10-22 : chemins et nom d'utilisateur, identifiants de processus, noms, tailles et empreintes des sauvegardes, emplacement et droits d'accès des copies de sécurité retirés. Le contenu technique, les mesures et les verdicts sont inchangés ; les statuts sont ceux du 2026-10-22 (état au moment de la publication : addendum de FINAL_REVIEW.md).

Aucun commit, push, staging ni suppression de données utilisateur par cette mission. Aucun contenu de sauvegarde, de base
ou de variable d'environnement n'est reproduit ici.

## 1. Baseline Git
- Branche `main` ; HEAD = origin/main = main distant (`git ls-remote`) = `b9eeeb4266450a34ab5625e32378c01d5be57b56`.
- Staged : 0. Modifiés suivis (préexistants, préservés) : `Docteur-Launcher.bat`, `scripts/test-wait-for-frontend.mjs`
  (STARTUP-2) ; `cortex-server/src/lib/maitre-executor.js`, `maitre-windows-exec.js`, `test-maitre-executor-level2.mjs`
  (MAÎTRE). Non suivis préservés : helpers et tests du lanceur, rapports et fichiers de travail locaux.

## 2. État des sauvegardes (avant)
- Dossier : `cortex-server/data/backups` ; 30 fichiers `backup-*.json` (la limite de rotation) ; aucune sauvegarde du jour.
- Les autres fichiers du même dossier ne correspondent pas au filtre de rotation : non concernés.
- Espace disque libre : suffisant.

## 3. Politique de rotation (code : `cortex-server/src/lib/backup.js`)
- `MAX_BACKUPS = 30`. La rotation n'existe que dans `runBackup()`, **juste après l'écriture d'une sauvegarde** : elle
  supprime les plus anciens `backup-*.json` (tri par nom) au-delà de 30.
- `runBackup()` est appelée : 10 s après le démarrage du serveur **si `backup-<date UTC>.json` n'existe pas** ; toutes les
  24 h de fonctionnement continu ; via `POST /api/backup/trigger`. Aucun autre code ne supprime dans ce dossier.
- Prévision avant boot (pas de sauvegarde du jour) : création de la sauvegarde du jour puis suppression d'exactement
  **un** fichier, la plus ancienne sauvegarde. → Observé à l'identique (§8).

## 4. Copies de sécurité vérifiées
- Emplacement : dossier local privé, hors dépôt, hors dossier synchronisé, hors dossiers nettoyés par Docteur ; droits
  d'accès restreints à l'utilisateur, SYSTEM et Administrateurs.
- 30/30 fichiers copiés ; pour chacun : SHA-256 original = SHA-256 copie, taille identique, original inchangé (hash +
  date). Deuxième passe indépendante (relecture du manifest) : 0 écart. Après les deux lancements : re-hash 30/30, 0 écart.
- `MANIFEST.json` (privé, à côté des copies) : noms, tailles, hashes, date, statut, politique de rétention — aucun contenu.
- Gate sauvegardes : **PASS**.

## 5. Diagnostic Root Policy 12/13
- Runtime (lecture seule `root-policy-tool.mjs status`, avant / après / fin) : version 2, `ok: true`,
  `highestVersionSeen` 2, sha256 `a8e4f7b5f30b6000daa872d5e087bc180a59d92e082a6626c115f51d5ceb9bf9`, ancre `d856e91e…`.
  Mutation 0, signature NON. → **ROOT_POLICY_RUNTIME_VALID**.
- Audit statique : `node --test test-root-policy-static-audit.mjs` → **12/13** (reproduit 2×).
- Test échoué : n° 11 « FROZEN modules: none imports Root Policy; none of their files differs from HEAD ».
  - Assertion A (aucun module gelé n'importe `root-policy` / `media-egress`) : **passe** (l'échec provient de B).
  - Assertion B : `git status --porcelain` sur les chemins gelés (`src/lib/{device-fabric,omega,rassilon,maitre,monitor,cyber}*`
    + routes) doit être vide. Valeur réelle : ` M cortex-server/src/lib/maitre-executor.js`, ` M …/maitre-windows-exec.js`.
- Nature des changements (diff +55/−6, production) : MAITRE-REG-1 / MAITRE-STARTUP-1 (lot non commité,
  READY_FOR_COMMIT_REVIEW) — gardes actives **uniquement si `DOCTEUR_TEST_MODE=1`** (`isLiveAutorunMutationInTest`,
  `startupFileMoveViolationInTest`) + option `disabledPersistenceDir` dont la valeur par défaut est identique à HEAD.
  Cette option n'est pas atteignable par HTTP : la route ne transmet que `execOpts = { exec, checkPlatform }` câblés côté
  serveur. Aucun nouvel import, aucun couplage Root Policy.
- Conclusion : le test fonctionne comme prévu (garde « aucune divergence locale d'un module gelé ») et détecte un changement
  local préexistant d'un module gelé ; sa conformité relève de la revue de commit MAÎTRE, pas de cette mission.
  **Classification : PREEXISTING_UNCOMMITTED_CHANGE_DETECTED.** Statut statique conservé : **12/13** (non masqué, test non
  modifié). Proposition (non appliquée) : trancher dans la revue MAÎTRE (commit après revue → l'audit redevient 13/13 ; ou
  rejet → les fichiers reviennent à HEAD par la décision de l'utilisateur).
- Impact lancement : aucun (code inerte hors mode test, sans rapport avec le démarrage) → gate sécurité **PASS**.

## 6. Préconditions du lancement réel
- Raccourci du Bureau `Docteur-Launcher.lnk` → `<dépôt>\Docteur-Launcher.bat`, dossier `<dépôt>` : PASS (l'ancien
  lanceur, conservé en copie, n'est pas référencé).
- Classification (mécanismes STARTUP-2) : 3001 `FREE`, 5173 `FREE` ; aucun processus Docteur, pas d'Ollama ; Chrome de
  l'utilisateur ouvert. Rien à arrêter. Lancement autorisé : OUI. Type : démarrage à froid des services.

## 7. Premier lancement réel (raccourci → lanceur → option 1)
Méthode : `Start-Process` du `.lnk` (équivalent double-clic) ; saisie de « 1 » + Entrée **dans la seule console du
lanceur** (`WriteConsoleInput` après `AttachConsole`, pas de SendKeys) ; lecture de l'écran de cette console.
Étapes réellement affichées (secondes après la saisie) :
```
+0,4  [1/4] Vérification de l'environnement : Docteur contrôle les ports 3001 et 5173 et les programmes qui les utilisent.
+3,9  [2/4] Ollama démarré en mode local (fenêtre « Ollama », écoute 127.0.0.1 uniquement, modèles cloud Ollama désactivés pour cette instance).
+3,9  [3/4] Démarrage du moteur Docteur (fenêtre « Cortex Server »)…
+11,4    Moteur Docteur prêt et vérifié après 8 s.
+13,6 [4/4] Préparation de l'interface (fenêtre « Docteur Frontend »)…
+22,1    Interface prête et vérifiée après 8 s.
+22,1 Docteur est prêt. Ouverture du navigateur…   →   Ouverture de Chrome...
```
- Aucune invite [O/N] ; la fenêtre du lanceur s'est fermée seule à +25,5 s.
- Journal `launcher.log` : PREFLIGHT → PORT_CHECK → OLLAMA → BACKEND_STARTING → BACKEND_READY (+7,7 s) →
  FRONTEND_STARTING → FRONTEND_READY → BROWSER_OPENING → `result READY` ; aucune ligne de commande, aucun secret.
- Backend : `/api/ping` 200 `{"ok":true}` ; écouteur 127.0.0.1:3001 classé `DOCTEUR_BACKEND_CONFIRMED`. **READY**.
- Frontend : `GET http://localhost:5173/` 200, titre Docteur ; écouteur `[::]:5173` `DOCTEUR_FRONTEND_CONFIRMED`. **READY**.
- Chrome : 1 fenêtre visible « Docteur — Cortex Personnel » (titre de l'application chargée), 0 fenêtre d'erreur /
  `localhost` → pas d'ERR_CONNECTION_REFUSED. Interactions : non testées manuellement (aucune donnée privée ouverte) ;
  l'application a chargé et appelé l'API (journal backend : requêtes 200 dès le chargement, Ollama `/api/tags` 200).
- Durée : 22,1 s de la saisie à « prêt » (backend 8 s mesurés ; le cold boot historique de 91 s du 2026-10-21 n'a pas été
  reproduit, cause de l'écart non déterminée — l'état des caches disque n'a pas été mesuré).

## 8. Après le démarrage
- Sauvegardes : 30 → 30 ; ajout de la sauvegarde du jour, **suppression par rotation normale de la plus ancienne**
  (copie vérifiée conservée hors production, non restaurée).
- Autres écritures (bookkeeping normal du backend, pas des données saisies) : `cortex.log` (+), `cortex.sqlite` (+20 Ko :
  méta de boot, purges, journal des requêtes), WAL/SHM, `root-policy/audit.jsonl` (événement de boot). `state.json` Root
  Policy et fichiers de politique : identiques. Nombre de fichiers des 17 sous-dossiers de `data/` : inchangé.
- Processus : 1 serveur backend + 1 `node --watch`, 1 Vite, 1 Ollama, 3 consoles de service, 0 console inactive.
- Ollama lancé par Docteur : bloc d'environnement lu en mémoire (lecture seule, booléens uniquement) →
  `OLLAMA_NO_CLOUD=1` présent, `OLLAMA_HOST=127.0.0.1:11434` présent. Serveur, watcher et Vite :
  `npm_config_update_notifier=false` présent, aucune variable Ollama (portée correcte).

## 9. Second lancement (une seule relance)
```
+0,4  [1/4] Vérification de l'environnement…
+5,6  [2/4] Ollama répond déjà sur ce PC : utilisé tel quel (Docteur ne le gère pas et ne le ferme pas).
+5,6  [3/4] Moteur Docteur déjà actif et vérifié : réutilisé, aucun nouveau moteur lancé.
+8,8  [4/4] Interface Docteur déjà active et vérifiée : réutilisée.
+8,8  Docteur est prêt. Ouverture du navigateur…
```
- 0 nouvelle console de service, 0 backend / frontend en double, aucun état STOPPING, aucune invite.
- Chrome : une 2e fenêtre « Docteur — Cortex Personnel » (politique : une fenêtre par lancement) ; 0 fenêtre d'erreur ;
  deux processus Chrome de plus, rien de fermé.
- Nouveau PID backend : **redémarrage par `node --watch` à 16:09:09** (même watcher). Cause démontrée (§12).

## 10. Réseau
- Lancement 1, 240 s, échantillon toutes les 3 s de tous les processus créés par le lancement (consoles, npm, node, Vite,
  backend et ses enfants `yt-dlp --version` / PowerShell, Ollama) : **0 EXTERNAL, 0 LAN**, uniquement loopback (node 215
  échantillons, Ollama 30). Écouteurs : `127.0.0.1:3001`, `[::]:5173`, `127.0.0.1:11434`, 2 écouteurs node loopback
  (127.0.0.1:58634 / :64834). Entrées `BOUND 0.0.0.0:<éphémère>` = sockets clientes non connectées, pas des écouteurs.
- Lancement 2, 90 s : aucun nouveau processus de service (réutilisation) → rien à observer.
- Limites : échantillonnage à 3 s (connexion très brève manquable) ; DNS non capturé (service DNS Client) ; un Ollama /
  Chrome lancé par l'utilisateur n'est pas couvert.

## 11. Comparaison des données
| Élément | Avant | Après | Nature |
|---|---|---|---|
| sauvegardes | 30 | 30 (la plus ancienne remplacée par celle du jour) | rotation normale prévue, copie protégée |
| cortex.sqlite | — | +20 Ko | bookkeeping du boot |
| cortex.log | — | croissant | journaux |
| root-policy/state.json, policy/* | — | identiques | aucune mutation |
| root-policy/audit.jsonl | — | +lignes | audit de boot |
| sous-dossiers data/ | 17 | 17, mêmes nombres de fichiers | — |

Perte de données inattendue : NON.

## 12. Constat : redémarrages du backend par simple lecture de `src/`
- Machine : `DisableLastAccess = 2` (mises à jour de l'heure de dernier accès NTFS **activées**).
- `npm run dev` = `node --watch-path=src …` ; sous Windows, la surveillance libuv remonte les changements d'heure d'accès.
- Reproduction synthétique (dossier temporaire, 2×, déterministe) : la **lecture** d'un fichier de `src/` dont l'accès date
  de > 1 h redémarre le serveur ; une 2e lecture dans l'heure, non ; le chargement initial d'un `server.js` « froid »
  provoque même un redémarrage supplémentaire.
- Le redémarrage de 16:09:09 coïncide avec mes suites de régression `cortex-server` (audits statiques qui lisent tout
  `src/`) ; aucun fichier de `src/` n'a été écrit après 16:00 ; le journal ne montre aucune erreur avant l'arrêt.
- Préexistant (mode dev), hors lanceur ; le lanceur l'a géré correctement (nouveau PID identifié et réutilisé). Effet
  possible : interruption d'une requête en cours lors d'une lecture de `src/` (tests, indexation IDE, antivirus).
  Recommandation (non appliquée) : mission dédiée (p. ex. `npm start` pour l'usage quotidien, ou surveillance limitée aux
  écritures). Ne pas lancer les suites `cortex-server` pendant une session Docteur réelle.

## 13. Tests (exécutés pendant cette mission)
| Suite | Résultat |
|---|---|
| lanceur : identity + orchestrateur + wait-for-frontend + startup-screen | 69/69 |
| verrou (dont 6 processus réels × 10 tours) | 6/6 |
| processus réels (faux dépôt, ports éphémères, chemin console de production) | 4/4 |
| Web Egress guard / static / phase1 | 54/54 · 7/7 · 7/7 |
| Strict Local | 6/6 |
| LAN : nb7 13/13 · final-review-lan 3/3 · offline guard 1/1 · sec3 **3/4** | voir note |
| port-preflight | 8/8 · 24/24 |
| Root Policy : integrity 38/38 · engine 30/30 · static **12/13** | §5 |
| typecheck `tsc --noEmit` | exit 0 |
| `git diff --check` | propre |

Note sec3 : les 3 assertions de refus LAN passent ; l'assertion « base réelle identique octet pour octet » échoue parce que
le vrai backend, lancé par cette mission, écrit légitimement dans `cortex.sqlite` pendant le test (4/4 plus tôt dans la
journée, Docteur arrêté). Interférence d'environnement, pas une régression ; à relancer Docteur arrêté.

## 14. Limitations
Voir §15 et POST_CERTIFICATION_STABILIZATION.md §8 (BLOCKING : aucune pour le démarrage ; Root Policy statique 12/13 en attente de la revue MAÎTRE).

## 15. Verdict
`DOCTEUR_REAL_STARTUP_CERTIFICATION_PARTIAL` — le démarrage réel est entièrement réussi et sûr, mais l'audit statique Root
Policy reste à 12/13 (changement MAÎTRE préexistant non revu) : la certification ne peut pas être annoncée totalement verte.
