# POST-CERTIFICATION STABILIZATION — 2026-10-22 (STARTUP-3)

> **Version publique (2026-11-13)** — copie anonymisée du rapport interne du 2026-10-22 : identifiants de processus et détails des emplacements de test retirés. Le contenu technique, les mesures et les verdicts sont inchangés ; les statuts sont ceux du 2026-10-22 (état au moment de la publication : addendum de FINAL_REVIEW.md).

Aucun staging, commit ou push. Root Policy, MAÎTRE, sauvegardes et manuel PDF non modifiés. Rapports précédents conservés.

## 1. Baseline Git
`main` ; HEAD = origin/main = main distant = `b9eeeb4266450a34ab5625e32378c01d5be57b56` ; staged 0. Modifiés suivis : lanceur
(`Docteur-Launcher.bat`, `scripts/test-wait-for-frontend.mjs`) et MAÎTRE (`maitre-executor.js`, `maitre-windows-exec.js`,
`test-maitre-executor-level2.mjs`, intacts). Docteur était en marche au début (backend en mode `--watch`).

## 2. MAITRE_FROZEN_POLICY_REVIEW
- **Règle exacte** : `cortex-server/test-root-policy-static-audit.mjs` test 11 « FROZEN modules: none imports Root Policy;
  none of their files differs from HEAD ». (A) aucun fichier `lib/{device-fabric,omega,rassilon,maitre,monitor,cyber,
  notebook,chat-memory,local-request-guard,local-api-policy}*` ni route associée n'importe `root-policy`/`media-egress` —
  **PASS** ; (B) `git status --porcelain` sur `src/lib/{device-fabric,omega,rassilon,maitre,monitor,cyber}*` + routes doit
  être vide — **FAIL** : ` M src/lib/maitre-executor.js`, ` M src/lib/maitre-windows-exec.js`.
- **Pourquoi gelés** : `reports/ROOT_POLICY_V1_2026-10.md` §17 — OMEGA, RASSILON, Device Fabric, **MAÎTRE**, Monitor, Cyber,
  Notebook sont des frontières certifiées (`COVERED_BY_FROZEN_CERTIFIED_BOUNDARY`, §19) : Root Policy se place au-dessus de
  leurs routes sans les modifier ; la règle (B) garantit qu'aucune divergence non revue n'existe dans l'arbre de travail.
- **Corrections autorisées ? / procédure** : aucun document de gouvernance ne définit de procédure générale. Précédent
  établi : `DOCTEUR_FINAL_SECURITY_AUDIT_2026-10.md` (Notebook ×2) — exception **étroite, documentée, justifiée par
  `DEMONSTRATED_SECURITY_DEFECT`**, attachée à la mission qui l'applique. **Aucun enregistrement d'exception n'existe pour
  MAITRE-REG-1 / MAITRE-STARTUP-1** (aucun rapport à cette date).
- **Conformité technique (vérifiée)** : diff production +55/−6 ; gardes actives uniquement si `DOCTEUR_TEST_MODE=1`
  (positionné uniquement par `cortex-server/test-setup.mjs` ; absent de `src/`, du `.env`, du lanceur ; convention déjà
  utilisée par `media-egress`, `claude-oauth`, `codex`) ; option `disabledPersistenceDir` jamais transmise par HTTP (la
  route ne passe que `execOpts = { exec, checkPlatform }`) et valeur par défaut identique à HEAD
  (`os.tmpdir()/DISABLED_PERSISTENCE_DIR_NAME`) ; aucun nouvel import, aucune signature/politique touchée.
- **Nature du défaut corrigé** : démontré (valeurs de test écrites dans la vraie clé de démarrage automatique et fichiers de test
  dans le dossier de rétention réel) mais **situé dans les tests** ; les gardes de production sont une défense en profondeur et l'option de
  dossier est nécessaire à l'isolation des tests.
- **Décision recommandée : OPTION B — DÉROGATION FORMELLE NÉCESSAIRE.** Techniquement valable et inerte en production, mais
  ni la règle ni le précédent ne couvrent automatiquement une défense en profondeur d'un défaut de test ; une option C
  (tout faire hors module) n'est pas réaliste pour `disabledPersistenceDir`. Il faut une décision écrite de l'utilisateur
  (exception documentée, justification, périmètre) dans la revue MAÎTRE.
- **Validations avant publication** : suites MAÎTRE (569 historiques) + level2 + `test-maitre-live-registry-guard` +
  `test-maitre-live-startup-guard` ; vérification que la clé Run et le dossier Startup restent identiques ; audit statique
  Root Policy après commit.
- **Comportement après publication (raisonnement, non exécuté)** : la règle B compare l'arbre de travail à HEAD ; une fois les
  deux fichiers commités, `git status` est vide → le test 11 passerait (13/13) ; s'ils étaient rejetés (retour à HEAD
  décidé par l'utilisateur), idem. Tant qu'ils restent non commités : 12/13.
- **Statut constaté (cette mission, deux exécutions)** : 12/13, seul le test 11 échoue. Runtime : v2, VALID, hsv 2,
  `a8e4f7b5…bf9`. Mutation 0, signature NON.

## 3. Diagnostic `node --watch`
- Commande du raccourci (STARTUP-2) : `npm run dev` = `node --watch-path=src --watch-preserve-output src/server.js`.
- Cause : `DisableLastAccess = 2` (mises à jour d'accès NTFS actives) + la surveillance Windows de Node signale les
  changements d'heure d'accès ; une **lecture** d'un fichier de `src/` non lu depuis > 1 h redémarre le serveur. Reproduit
  (STARTUP-2 et ici, isolé). Vite n'est pas concerné : son chokidar n'émet que si `mtime` change
  (`node_modules/vite/dist/node/chunks/node.js:9013`).
- **Incident de cette mission** : mon `grep DOCTEUR_TEST_MODE` sur `cortex-server/src` à 16:36 a redémarré le backend de
  l'utilisateur (nouveau PID à 16:36:31 ; aucune erreur, pas de rotation : la sauvegarde du jour existait).

## 4. Solution de stabilisation
- **Mode quotidien** (option [1], défaut) : backend `npm start` (`node src/server.js`, script existant, sans `prestart`) —
  aucun processus de surveillance ⇒ aucune lecture ni modification de fichier ne peut le relancer. Pour appliquer une
  modification de code : fermer « Cortex Server » puis relancer.
- **Mode développement** (nouvelle option [5], `--dev`) : `npm run dev` inchangé (rechargement automatique, y compris le
  défaut de lecture documenté).
- Identité : l'ancre console backend accepte `cd /d "<dépôt>\cortex-server" && npm start` **ou** `npm run dev`, rien
  d'autre (`npm run start`, `&& evil`, autre dossier, console frontend `npm start` refusés). Chaîne quotidienne : serveur ←
  `cmd /d /s /c` ← npm ← console ⇒ cible d'arrêt éventuelle = le serveur seul.
- Réutilisation : le mode du moteur en marche est affiché ; s'il diffère du mode demandé, explication, **rien n'est arrêté**.

## 5. Chrome avant / après
- Avant : chaque lancement réussi exécutait `start chrome --app=…` ⇒ une fenêtre de plus par relance.
- Après (`scripts/launcher-browser.mjs`) : une fois les services vérifiés prêts, recherche des fenêtres visibles de
  `chrome.exe` dont le titre est **exactement** « Docteur — Cortex Personnel » (fenêtre app) ou « … - Google Chrome »
  (onglet actif) — aucun autre titre ne sort de PowerShell. Si trouvée : revérification (fenêtre, PID, titre), restauration,
  mise au premier plan (attache temporaire à l'entrée du premier plan, aucune frappe simulée) ou, à défaut, clignotement ;
  code 10 ⇒ le `.bat` n'ouvre rien. Sinon / échec : ouverture comme avant. Jamais de fermeture, de profil, de débogage.
- Limite : un onglet Docteur non actif dans une fenêtre Chrome normale n'est pas reconnu (une nouvelle fenêtre s'ouvre).

## 6. sec3
- Analyse : l'assertion finale compare le hash de `data/cortex.sqlite{,-wal,-shm}` avant/après 4 boots refusés ; les boots
  utilisent une base temporaire et sont refusés avant `initSqlite` (assertions vertes). Avec Docteur en marche, le vrai
  backend écrit sa base ⇒ **ÉCHEC DE PRÉCONDITION** (le test suppose Docteur arrêté), pas un échec fonctionnel.
- Exécution de référence : session fermée **avec l'autorisation de l'utilisateur** (Ctrl+C puis `O`/`exit` dans les deux
  consoles identifiées ; Ollama et Chrome intacts ; ports libérés vérifiés) ⇒ **4/4, deux fois** ⇒ **SEC3_PASS**. Test non
  modifié.

## 7. Tests (cette mission)
| Suite | Résultat |
|---|---|
| lanceur : identity + orchestrateur + browser + wait-for-frontend + startup-screen | 81/81, ×10 |
| verrou | 6/6 |
| processus réels (lanceur) | 4/4 ×3 après correction du dépôt factice (1 run : 2 échecs dus au script `start` absent du faux `package.json`, + 1 console de test restée ouverte ; corrigé, nettoyage renforcé) |
| modes de lancement réels (`test-backend-run-modes`) | 2/2 ×3 ; diagnostic : lecture en mode dev ⇒ redémarrage |
| sec3 (Docteur arrêté) | 4/4 ×2 |
| Web Egress 54/54 · static 7/7 · phase1 7/7 · Strict Local 6/6 · nb7 13/13 · LAN final-review 3/3 · offline 1/1 · port-preflight 8/8, 24/24 | PASS |
| Root Policy : static 12/13 (test 11) · integrity 38/38 · engine 30/30 | voir §2 |
| typecheck / `git diff --check` | exit 0 / propre |

Réel (raccourci / console du lanceur) :
- relance pendant la session dev : réutilisation, mode expliqué, fenêtre existante clignotante puis (après ajout de
  l'attache d'entrée) **remise au premier plan**, 0 nouvelle fenêtre ;
- relance en mode quotidien après fermeture : moteur prêt 6 s (sans watcher), interface 5 s, fenêtre Docteur
  existante remise au premier plan, `/api/ping` 200, page 200, 0 fenêtre d'erreur ;
- lecture complète de `cortex-server/src` (audits statiques) ensuite : PID inchangé, 0 watcher (preuve structurelle ;
  les heures d'accès avaient été rafraîchies à 16:36, la preuve « accès > 1 h » vient du test isolé).
- Incident : une saisie automatique a reçu « j'1 » (frappe clavier probable pendant que la fenêtre avait le focus) ⇒ choix
  invalide, menu réaffiché ; relance faite ensuite après accord explicite de l'utilisateur.

## 8. Limites
- Root Policy statique 12/13 jusqu'à la décision MAÎTRE (option B).
- Mode quotidien : une modification du code backend demande une relance manuelle (voulu).
- Onglet Docteur non actif dans une fenêtre Chrome ordinaire : non détecté.
- Mise au premier plan : dépend des règles Windows ; repli par clignotement.
- La fuite d'une console de test (run 1 du test réel) ne s'est pas reproduite après le renforcement du nettoyage.

## 9. Fichiers modifiés par cette mission
- `Docteur-Launcher.bat` — option [5], `LAUNCH_ARGS`, chemin `BROWSER_ALREADY_OPEN` (code 10).
- `scripts/docteur-launch.mjs` — modes quotidien/dev, mode affiché à la réutilisation, réutilisation de fenêtre.
- `scripts/launcher-identity.mjs` — ancre console backend `npm start`.
- `scripts/launcher-browser.mjs` (nouveau) — détection / remise au premier plan de la fenêtre Docteur.
- `scripts/launcher-test-world.mjs`, `scripts/test-docteur-launch.mjs`, `scripts/test-launcher-identity.mjs`,
  `scripts/test-wait-for-frontend.mjs`, `scripts/test-launcher-real-processes.mjs` — tests adaptés / étendus.
- `scripts/test-launcher-browser.mjs`, `scripts/test-backend-run-modes.mjs` (nouveaux).
- Rapports : ce fichier (le point de reprise interne de la mission n'est pas publié).

## 10. Décision recommandée
`POST_CERTIFICATION_STABILIZATION_PARTIAL` : les points B, C, D sont résolus et validés en réel ; le point A est analysé
mais requiert une dérogation formelle (décision humaine) — l'audit statique Root Policy reste à 12/13.
