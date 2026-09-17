# DOCTEUR FINAL CERTIFICATION

Mode : READ-ONLY / TESTS UNIQUEMENT. Aucun fix appliqué pendant cette mission. Aucun code source, `package.json`, `package-lock.json`, base SQLite/LanceDB réelle, ni credential n'a été modifié.

## Résumé exécutif

Docteur, après MASTER mission + investigation OpenRouter + Batch A + Batch B + Batch C, est **stable et fonctionnellement sain sur tout ce qui est automatisable**. La suite complète tourne à **510/511**, avec un unique échec préexistant (`test-maintenance.mjs`) dont la cause réelle a été identifiée précisément pendant cette certification (voir FINAL-F1 — la cause documentée dans les rapports précédents était imprécise). Zéro régression introduite par cette mission de certification elle-même (elle n'a modifié aucun fichier). OpenRouter, privacy/egress, Strict Local, connecteurs, mémoire adaptative, Notebook local, NotebookLM future, Free AI Finder, navigateur, Sherlock (code), audio/radio, OneDrive 20MB, request_logs, exceljs et le code-splitting frontend sont tous certifiés PASS au niveau code/tests automatisés. Les limites restantes sont exclusivement des validations E2E réelles jamais exécutées (OAuth YouTube/OneDrive réel, génération ComfyUI réelle, Sherlock réellement installé) — non un défaut de code.

**CERTIFICATION FINALE : PASS AVEC LIMITATIONS**

---

## Tests

Suite : **510/511**

Méthodologie : chaque fichier de test exécuté dans son propre process (`node --test <fichier>`) — contrainte préexistante et déjà documentée en Batch B/C : `sqlite.js` expose un singleton DB au niveau module, donc `node --test test-*.mjs` combiné en un seul process se bloque silencieusement dès que deux fichiers appellent `initSqlite()` avec des chemins différents dans le même process. 35 fichiers de suite automatisée réelle couverts (hors `test-find-eval.mjs`, `test-regression-api.mjs` — scripts manuels interactifs, pas des suites `node:test` — et `test-video-manual.mjs`, script de reproduction réseau réel contre YouTube, tous trois exclus par construction).

Échecs préexistants : **1** — `test-maintenance.mjs` (voir FINAL-F1).
Nouveaux échecs : **0 attendu — confirmé 0.**
Tests skipped : **0** (chaque fichier rapporte `# skipped 0`).

---

## OpenRouter
**PASS**

`test-openrouter-regression.mjs` + `test-teacher-fallback.mjs` : 27/27 PASS.
- Modèle gratuit fixe (`nvidia/nemotron-3-super-120b-a12b:free`) toujours respecté, jamais de bascule silencieuse (`assertFreeModel` + test dédié).
- Réponse vide → erreur classée et gérée, jamais silencieuse.
- Erreurs provider sanitisées côté client (Batch A, F17).
- `AUTH_FAILED`/`QUOTA_EXCEEDED` : confirmés exclus de `RETRY_LOCAL_CATEGORIES` (`src/routes/teacher.js:28`), testés explicitement (401 → AUTH_FAILED, jamais de repli local silencieux).
- `local_only` n'atteint jamais OpenRouter : confirmé.
- Aucun rebond vers un autre cloud : confirmé par le test de chaîne de fallback (voir Privacy ci-dessous, mêmes 8 providers).

Appels OpenRouter réels : **0**. Credential réel modifié : **NON**.

---

## Privacy / Egress
**PASS**

`test-privacy-guard.mjs` (33), `test-phase1-egress-certification.mjs` (7), `test-strict-local-centralized.mjs` (6), `test-ai-provider-fallback.mjs` (54) : **100/100 PASS**.

Test de chaîne de fallback simulée (`test-privacy-guard.mjs:134`) couvre exactement les 8 providers demandés — `gemini, groq, openrouter, anthropic, openai, freellmapi, claude-oauth, codex` — avec un payload privé synthétique (équivalent fonctionnel de `__FINAL_CERT_PRIVATE_TEST__`) : **0 appel atteint, à aucun des 8 providers, en chaîne complète**. Cloud A bloqué → cloud B jamais tenté (le test lève `PrivacyViolationError` à chaque provider et vérifie qu'aucun `callCount` n'est jamais incrémenté). Ollama local reste toujours autorisé (non concerné par `guardCloudCall`, confirmé par lecture du code).

**local_only → provider cloud/externe : 0 attendu — confirmé 0.**

---

## Strict Local
**PASS**

Inclus dans le bloc ci-dessus (`test-strict-local-centralized.mjs`, 6/6). Force le repli local même quand un modèle cloud est explicitement demandé, y compris pour `/voice/transcribe` avec `groq` demandé explicitement.

---

## YouTube
**CODE : PASS**
**E2E réel : NON**

`test-phase2-connectors.mjs` couvre OAuth mock (auth-url, callback, CSRF/state), stockage token (jamais échoué en clair), refresh, dedup (second sync du même item), tagging `source=youtube_private, privacy=true, egress_policy=local_only` avec confirmation qu'aucun provider cloud non marqué n'est jamais atteint. Timeout confirmé (Batch A, `AbortSignal.timeout` sur chaque site d'appel `fetch()`). Aucun credential OAuth YouTube configuré dans la base réelle (vérifié via `hasSecret`, booléen uniquement) — aucun test automatisé n'a jamais appelé la vraie API Google, et aucun compte réel n'a jamais été connecté.

---

## OneDrive
**CODE : PASS**
**E2E réel : NON**

Même couverture que YouTube côté OAuth mock. `downloadFileContent()` n'est pas encore câblée dans `routes/connectors.js` (documenté PARTIEL depuis la Phase 2 — en attente d'un enregistrement d'app Microsoft réel). Protection de taille certifiée séparément ci-dessous. Aucun credential OAuth OneDrive configuré dans la base réelle.

---

## Mémoire adaptative
**PASS**

`test-phase3-adaptive-memory.mjs` : 26/26 PASS. Création, retrieval, scoring (Jaccard + récence), déduplication, budget de contexte respecté même avec beaucoup plus de candidats disponibles que le budget, suppression ciblée testée sur DB de test uniquement (`DELETE /api/memory/items/:tier/:id`), mémoire privée marquée `local_only` et préservée comme telle par `selectMemoriesForBudget`.

Mesure synthétique (200 mémoires candidates, DB isolée) : retrieval **0,51 ms**, budget "medium" a sélectionné exactement le nombre pertinent (pas de croissance incontrôlée — un texte répétitif ne gonfle pas artificiellement la sélection).

---

## Notebook
**PARTIEL**

`test-phase5-notebook.mjs` + `test-batch-b-notebook-performance.mjs` : 22/22 PASS. Création, ajout/retrait de source, retrieval scopé (jamais toute la base), citations toujours liées à un vrai chunk retrouvé (hallucination de référence `[N]` hors plage explicitement testée et rejetée), résumé global (caché, invalidé sur changement de source), pagination bornée (Batch B — bouton « Charger plus », `limit`/`offset` paramétrés et indexés), suppression de Notebook testée sur DB isolée, `local_only` bloque tout cloud par construction (le module n'importe littéralement aucun provider cloud).

**Non implémenté** (déjà documenté dans le README comme "🚧 non implémenté", pas une régression de cette mission) : FAQ, flashcards, chronologie — fonctionnalités mentionnées dans le périmètre de certification mais absentes du code actuel (Phase 5 limitée au résumé niveau 1 + questions/réponses). D'où le statut PARTIEL plutôt que PASS pour cette section précise.

---

## NotebookLM future
**PASS**

`test-phase5b-notebooklm.mjs` : 8/8 PASS, dont un test statique dédié confirmant que `routes/notebook.js` n'importe jamais le module NotebookLM. Lecture directe de `lib/notebook-provider.js` et `routes/notebooklm.js` : **zéro `fetch()`** dans tout le fichier — la clé API est stockée/effacée via le secret-store DPAPI, le frontend ne reçoit qu'un booléen `key_configured`. Aucun fallback Ollama → NotebookLM possible (aucun chemin de code ne relie les deux).

Appels réels : **0 — confirmé structurellement**, même avec une clé configurée (le code qui appellerait l'API NotebookLM n'existe simplement pas).

---

## Free AI
**PASS**

`test-free-ai-catalog.mjs` + `test-free-ai-routes.mjs` + `test-freellmapi.mjs` : 41/41 PASS. Providers déjà configurés dans Docteur exclus de la liste "à découvrir" (signal serveur `docteurState==='configured'`, testé et confirmé aussi côté image generation, section rendue séparément côté frontend — `configuredProviders`/`discoverableProviders`, `FreeAiFinder.tsx:213-214`). Aucune clé jamais exposée dans une réponse JSON (`configured` est un booléen strict, testé explicitement). Strict Local respecté (zéro appel réseau en mode Strict Local, cache servi à la place).

Section Image API : confirmée positionnée juste après l'onglet Modèles (`SettingsModal.tsx:765`, ordre `['models', 'images', 'stats', ...]`).

---

## Image / ComfyUI
**PARTIEL — E2E réel utilisateur requis**

Lecture seule : routes, `spawn(..., { shell: false })` confirmé pour le lancement, `MODEL_CATALOG` allowlist explicite pour les téléchargements de modèles, Strict Local et provider routing couverts par 63/63 tests PASS (`test-image-generation.mjs`, `test-comfyui-install-manager.mjs`, `test-phase4-free-ai-images.mjs`).

Constat déterminant : la table réelle `image_generations` contient **0 ligne** dans `cortex.sqlite`, alors que `data/images/` contient ~95 Mo de fichiers image réels (probablement importés/générés par un autre chemin avant l'existence de cette table de tracking, ou via un provider non tracké). **Aucune preuve qu'une image ait jamais été générée via le pipeline ComfyUI local de Docteur.** Statut PARTIEL conformément à la règle explicite de cette mission.

---

## Browser
**PASS**

`test-phase6-browser.mjs` : 16/16 PASS. `http:`/`https:` autorisés ; `file:`, `javascript:`, `data:`, `cmd:`, `powershell:` bloqués (`BLOCKED_SCHEMES`, plus `vbscript:`/`about:` en supplément). `spawn(command, args, { shell: false })` confirmé, URL toujours passée comme élément de tableau séparé — jamais une chaîne shell. Test dédié : "argument-injection attempt via URL string is neutralized by URL parsing, not string matching".

---

## Sherlock
**PARTIEL**

`test-phase7-sherlock.mjs` : 18/18 PASS, dont un test statique confirmant que chaque site d'appel `spawn()`/`execFile()` dans `lib/sherlock.js` fixe `shell:false` explicitement. Validation username, commande prévue, timeout, annulation, traitement des résultats en mock, `local_only` : tous couverts.

**Sherlock n'est pas installé sur cet environnement** (`pipx` absent, commande `sherlock` introuvable) — non installé pendant cette mission, conformément à la règle. Statut PARTIEL : aucun vrai E2E Sherlock n'a encore été exécuté.

---

## Audio / Radio
**PASS**

Pas de suite `node:test` dédiée (fonctionnalité principalement frontend). Vérification par lecture directe du code :
- Catalogue radio (`lib/radio-catalog.js`) : SomaFM (groovesalad, gsclassic, lush, deepspaceone) toujours volontairement retiré, raison documentée en tête de fichier (blocage 403 côté edge SomaFM, confirmé reproductible par curl ET Chromium réel le 2026-09-15) — catalogue non modifié pendant cette mission.
- Anti-spam PUT : `AudioPlayer.tsx:75-84`, `saveSettings()` compare explicitement contre `lastSavedSettings.current` et n'émet un `PUT` que si une valeur a réellement changé — empêche structurellement une boucle d'erreur radio de spammer le backend.
- Aucun `setInterval`/polling automatique trouvé qui redéclencherait une lecture ou un PUT en boucle.

Limite de cette vérification : pas de capture réseau live sur 30 secondes d'inactivité (aucune instance de l'app n'était en cours d'exécution pendant cette certification) — la preuve ci-dessus est structurelle/statique, pas une observation réseau directe.

---

## Batch A
**PASS** — 12/12 (re-vérifié).

## Batch B
**PASS** — 17/17 (`test-batch-b-request-logs.mjs` + `test-batch-b-notebook-performance.mjs`, re-vérifié).

## Batch C
**PASS** — 24/24 (`test-batch-c-onedrive-size-limit.mjs` + F4, re-vérifié).

---

## OneDrive 20MB protection
**PASS**

Limite : 20 971 520 octets (20 Mo), réutilise `MAX_FILE_SIZE_BYTES` de `lib/files.js`.
- `Content-Length` > limite → rejet avant toute lecture, corps annulé.
- `Content-Length` absent → toujours borné par le comptage en flux (streaming), jamais de dépendance au seul header.
- Header mensonger (annonce petit, envoie gros) → interruption pendant la lecture, dès dépassement du seuil réel.
- Erreur : `ONEDRIVE_FILE_TOO_LARGE` (`OneDriveFileTooLargeError`).
- Aucun token, URL sensible, header `Authorization`, ni stack brute dans l'erreur client — vérifié par test dédié.

---

## request_logs
**PASS**

Batch B : rétention configurable (défaut 30 jours), purge par petits batchs bornés (500 lignes/batch, max 20 batchs/appel — jamais de `DELETE` global), index `idx_request_logs_timestamp` ajouté. Testé exclusivement sur DB synthétique (`test-batch-b-request-logs.mjs`, 12/12) : anciens logs éligibles supprimés, logs récents conservés, taille de batch respectée, table vide, dates invalides gérées sans crash, gros volume synthétique (2000+500 lignes) purgé correctement en plusieurs batchs. **Aucune purge n'a été lancée sur la vraie DB pendant cette mission ni les précédentes** (67 337 lignes avant/après, identique).

---

## ExcelJS
Version : **4.4.0** (installée = dernière version stable publiée sur npm ; `4.4.1-prerelease.0` existe mais est une pré-version explicitement hors périmètre).

`package.json`/`package-lock.json` inchangés depuis le Batch C (`git diff --stat` vide sur ces deux fichiers). Aucun downgrade forcé. Support `.xlsx` intact (7/7 tests `test-files-xlsx.mjs`). `.xls` reste explicitement non supporté (vulnérabilité SheetJS/xlsx documentée, sans rapport avec exceljs) — politique inchangée, non réintroduit.

---

## Typecheck
**OK** — `npx tsc --noEmit` propre sur `cortex-server/` et sur le frontend, aucune erreur.

## Build
**OK** — `npm run build` réussi. Bundle éager : `index-z8uHuvui.js` = 1 393,38 kB (identique aux mesures Batch B/C — 1 596,81 kB → 1 393,38 kB, réduction 203,4 kB / 12,7 % toujours stable). Chunks lazy confirmés présents et séparés : `SettingsModal-Dcs0f-BA.js` (180,10 kB), `NotebookModal-BtrX90VP.js` (15,47 kB), `ImageGeneratorModal-C_d1r66I.js` (8,78 kB). `dist/` total : 57 Mo.

---

## DB réelle modifiée
**NON — confirmé.**

État initial (avant certification) : `cortex.sqlite` = 19 542 016 octets, mtime 16/09/2026 00:27, `pages`=6731, `request_logs`=67337, `activity_log`=324.
État final (après tous les tests de certification) : **valeurs identiques au bit/octet près** — même taille, même mtime, mêmes row counts.

Observation notée (sans impact) : des fichiers `cortex.sqlite-wal`/`cortex.sqlite-shm` sont apparus transitoirement pendant la session (artefacts standards d'ouvertures en lecture seule d'une base en mode WAL) puis ont disparu d'eux-mêmes — aucune ligne modifiée, confirmé par comparaison directe des row counts avant/après. Pas une cause d'inquiétude, documentée par transparence.

## Credentials modifiés
**NON — confirmé.** Groq/Gemini/OpenRouter : configurés (statut `valid`, jamais la valeur). Anthropic/OpenAI/FreeLLMAPI : non configurés. Aucun credential OAuth connecteur (YouTube/OneDrive) ni clé NotebookLM configuré. Aucune valeur de secret n'a été affichée dans ce rapport, dans les logs consultés, ni trouvée dans `git diff`.

## Appels cloud live
**0 — confirmé.** Tous les tests utilisent des mocks `fetch`/`Ollama` ou des DB isolées/`:memory:`.

## shell:true
**4 occurrences trouvées dans `cortex-server/src/`** — toutes pré-existantes, déjà documentées dans l'audit maître (finding F10, "Informationnel/Vérifié sain") :
- `src/lib/providers/claude-oauth.js:187` — `execFile(cliPath, ['--version'], { ..., shell: true })`
- `src/lib/providers/claude-oauth.js:247` — `execFile(this._cliPath, ['auth', 'status'], { ..., shell: true })`
- `src/lib/providers/codex.js:184` — `execFile(cliPath, ['--version'], { ..., shell: true })`
- `src/lib/providers/codex.js:224` — `execFile(this._cliPath, ['login', 'status'], { ..., shell: true })`

Type de risque : faible — dans les 4 cas, `execFile` (jamais `exec`/`spawn` avec chaîne shell) avec un tableau d'arguments **littéraux et fixes** (`['--version']`, `['auth', 'status']`, `['login', 'status']`), jamais d'entrée utilisateur interpolée dans la commande ou les arguments. Toutes les autres zones sécurisées (`lib/browser.js`, `lib/sherlock.js`, `lib/comfyui-install-manager.js`, connecteurs OAuth) utilisent `shell:false` de façon systématique et vérifiée par test statique dédié. Aucun nouveau `shell:true` introduit par cette mission de certification (elle n'a modifié aucun fichier).

Autres patterns recherchés : `exec(`/`execSync(` — aucune occurrence réelle (les seuls matchs de `exec(` sont `RegExp.prototype.exec`, sans rapport). Logging de secrets (`Authorization`, `access_token`, `refresh_token`, `client_secret`) dans un `console.log`/`logger.*` : **zéro résultat**, mécanisme de rédaction structurelle (`REDACT_PATHS`/`SECRET_PATTERNS`, `lib/logger.js`) confirmé intact.

## Données utilisateur supprimées
**0 — confirmé.** Aucun fichier utilisateur, aucune ligne de DB réelle supprimée pendant cette mission.

---

## E2E encore nécessaires

- **YouTube** : connexion OAuth réelle avec un compte Google et un enregistrement d'app Google Cloud réel (aucun credential configuré actuellement).
- **OneDrive** : connexion OAuth réelle avec un compte Microsoft et un enregistrement d'app Azure réel (aucun credential configuré actuellement) ; câblage de `downloadFileContent()` dans la route de sync (actuellement dormant, documenté PARTIEL depuis la Phase 2).
- **ComfyUI** : au moins une génération d'image réelle via le pipeline local (aucune ligne dans `image_generations` à ce jour malgré ~95 Mo d'images déjà présentes sur disque, dont l'origine réelle n'a pas été retracée par cette certification en lecture seule).
- **Sherlock** : installation réelle (`pipx install sherlock-project`) puis une recherche de nom d'utilisateur réelle — non exécuté, outil non installé sur cet environnement.
- **Navigateur** : sélection/ouverture réelle d'un navigateur tiers (Chrome/Firefox/Edge) depuis les Paramètres — seule la détection et le blocage de schémas ont été vérifiés par test automatisé.
- **Notebook avec données utilisateur non sensibles** : un usage réel prolongé (au-delà des DB de test synthétiques) — création, ajout de sources réelles, questions/réponses, pour valider l'expérience de bout en bout au-delà des scénarios de test.
- **Audio/Radio** : capture réseau live de 30 secondes d'inactivité pour confirmer "0 PUT parasite" en conditions réelles (actuellement certifié par preuve structurelle du code uniquement, aucune instance de l'app n'étant lancée pendant cette certification).

Aucune de ces opérations n'a été lancée sans confirmation, conformément à la règle de cette mission.

---

## Findings restants

**P0 :** aucun.

**P1 :** aucun.

**P2 :**
- **FINAL-F1** — `test-maintenance.mjs` échoue de façon reproductible et déterministe (pas un problème d'environnement comme documenté par erreur dans les rapports Batch A/B/C précédents). Voir section dédiée ci-dessous. Sévérité : faible (n'affecte aucun chemin de code de production — seule l'assertion du test elle-même est incorrecte).

**P3 :**
- Notebook : FAQ/flashcards/chronologie non implémentés (déjà documenté comme tel dans le README — pas une découverte de cette certification, juste confirmé cohérent).
- `shell:true` × 4 dans `claude-oauth.js`/`codex.js` — risque faible déjà audité (F10), args toujours littéraux, non modifié par cette mission.
- Image/ComfyUI et Sherlock : aucune preuve d'E2E réel exécuté à ce jour (voir sections dédiées).

---

## Analyse test-maintenance.mjs (FINAL-F1) — analyse uniquement, aucun code modifié

**Pourquoi il semblait dépendre de la vraie DB** : le test lit réellement les clés cloud (Groq/Gemini/OpenRouter) de `cortex.sqlite` via un process enfant en lecture seule (`test-maintenance.mjs:18-23`), ce qui a historiquement laissé penser que TOUT l'échec venait d'un couplage à l'état réel de la base.

**Cause réelle, identifiée précisément pendant cette certification** : l'assertion qui échoue (`test-maintenance.mjs:52`, `assert.equal(calledLocalModel, 'dedicated:latest')`) est en réalité **indépendante de la vraie base** — elle échoue de façon identique et déterministe même sur une base `:memory:` fraîche, sans aucune donnée réelle copiée. La cause véritable : le test configure le modèle Professeur via `POST /teacher/settings` (`model: 'dedicated:latest'`), mais le chemin de code réellement emprunté pour un appel local (`callLocalTeacherModel`, `routes/teacher.js:166-171`) lit `getRouterSettings()?.chat_model` — un réglage **différent et indépendant** du modèle Professeur configuré. Sur une base fraîche, `chat_model` vaut par défaut `'mistral-nemo:12b-instruct-2407-q4_K_M'` (`sqlite.js:983`) — exactement la valeur observée dans `actual`. Le test suppose à tort que régler le modèle Professeur change aussi le modèle utilisé pour l'appel Ollama local — ce n'est pas le comportement réel du code (qui, lui, est correct et cohérent : le modèle de chat local est un réglage du routeur, pas du Professeur).

**Comment le rendre déterministe** (recommandation uniquement, non appliquée) : soit (a) asserter directement la valeur par défaut connue `'mistral-nemo:12b-instruct-2407-q4_K_M'`, soit (b) appeler `setRouterSettings({ chat_model: 'dedicated:latest' })` avant l'assertion pour que le test exerce réellement le scénario qu'il prétend vérifier ("le modèle local effectif reflète ce qui est configuré").

**Sévérité : faible.** Aucun impact sur le comportement de production — `resolveEffectiveTeacherModel`/`callLocalTeacherModel` se comportent correctement et de façon prévisible ; seule l'assertion du test elle-même repose sur une hypothèse incorrecte sur la relation entre deux réglages distincts.

---

## Verdict

**CERTIFICATION FINALE : PASS AVEC LIMITATIONS**

Justification : tout le code et les tests automatisés sont sains (510/511, aucun nouvel échec, OpenRouter/privacy/Strict Local/Batch A/B/C tous PASS, typecheck et build OK, aucune donnée réelle touchée, aucun credential modifié, zéro appel cloud live). Les seules limites restantes sont des validations E2E manuelles non exécutées (YouTube/OneDrive OAuth réel, génération ComfyUI réelle, Sherlock réellement installé, navigation réelle prolongée) — jamais un échec de code ou de test. L'échec préexistant `test-maintenance.mjs` reste exactement inchangé, et sa cause est maintenant précisément documentée (bug d'assertion de test, pas un problème d'environnement).

---

## CERTIFICATION TERMINÉE.

**Statut final** : PASS AVEC LIMITATIONS
**Tests** : 510/511 (1 échec préexistant analysé, cause précisée — `test-maintenance.mjs`)
**Limitations** : Notebook (FAQ/flashcards/chronologie non implémentés — déjà documenté), Image/ComfyUI (aucune génération réelle tracée), Sherlock (non installé)
**E2E manuels restant à faire** : YouTube OAuth réel, OneDrive OAuth réel + câblage `downloadFileContent()`, génération ComfyUI réelle, installation + recherche Sherlock réelle, sélection navigateur tiers réelle, usage Notebook prolongé avec données réelles, capture réseau audio 30s idle.

Aucun finding n'a été corrigé. Aucun nouveau batch n'a été lancé.

En attente de votre autorisation.
