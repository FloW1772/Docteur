# BATCH B — Performance & Maintenabilité (2026-09-16)

Autorisation : Batch B uniquement (code-splitting frontend, rétention `request_logs`, pagination Notebook). Batch C non lancé.

## BATCH B : PASS

---

## === CODE SPLITTING ===

**Mesure AVANT** (build de référence, avant toute modification) :
- `index-DFELzlvP.js` (chunk d'entrée éager, référencé par `<script type="module">` dans `dist/index.html`) : **1 596,81 kB**
- `esm-dOBh4Pjv.js` : 3 349,46 kB — déjà lazy (confirmé par analyse forensique : c'est `@picovoice/porcupine-web`, chargé via un vrai `import()` dynamique existant, pas un problème)
- `dist/` total : 57 M

Analyse préalable (pas d'optimisation à l'aveugle) : les gros chunks identifiés par l'audit Phase 9 (Porcupine, MediaPipe, Tesseract) étaient **déjà** correctement code-splittés via des `import()` dynamiques existants (`useScreenOcr.ts`, `useGestureCamera.ts`). Le vrai bundle éager ne faisait donc que ~1,57 MB, pas ~4,9 MB comme le supposait l'audit. `NeuralBrain` (three.js) n'a volontairement PAS été lazy-loadé : c'est l'écran d'accueil desktop rendu sans condition, et `main.tsx` patch `THREE.WebGLRenderer.prototype` de façon synchrone avant tout rendu — composant critique du démarrage, exclu par la règle explicite.

**Cibles retenues** (correspondant à la liste de priorité de la mission — Notebook, Images, Settings lourds) : `SettingsModal.tsx` (3651 lignes), `NotebookModal.tsx`, `ImageGeneratorModal.tsx` — tous conditionnellement rendus, jamais nécessaires au démarrage.

**Implémentation** : `React.lazy()` + `Suspense` dans `src/App.tsx` pour les 3 composants, avec un fallback de chargement partagé (`LazyModalFallback`).

**Bundle initial avant** : 1 596,81 kB (chunk éager)
**Bundle initial après** : 1 393,38 kB (chunk éager, `index-z8uHuvui.js`)
**Réduction** : **203,4 kB (12,7 %)**

**Chunks principaux créés** :
- `SettingsModal-Dcs0f-BA.js` : 180,10 kB (gzip 39,68 kB)
- `NotebookModal-BtrX90VP.js` : 15,47 kB (gzip 4,26 kB)
- `ImageGeneratorModal-C_d1r66I.js` : 8,78 kB (gzip 2,97 kB)

**Build total** : `dist/` reste à 57 M (code réorganisé, pas de perte/gain réel — attendu).
**Temps de build** : 12,2 s (build propre après `rm -rf dist`).

**Vérification navigation réelle** : `vite preview` est bloqué par un certificat HTTPS auto-signé expiré (`certs/cert.pem`, valide du 15/07/2026 au 14/08/2026 — expiré depuis plus d'un mois, problème d'environnement préexistant, hors périmètre Batch B). Contournement : vérification via `npm run dev` (HTTP, sans ce blocage), avec Playwright piloté automatiquement :
- Chargement initial : 0 chunk de modale chargé (28 boutons rendus, app montée correctement)
- Clic sur Paramètres → chargement à la demande de `SettingsModal.tsx`, modale rendue correctement (capture d'écran vérifiée)
- Clic sur Notebook → chargement à la demande de `NotebookModal.tsx`, modale rendue correctement
- 0 erreur console, 0 exception de page

**Régressions : 0** (confirmé — Fast Refresh/dev server sain, routing/modales fonctionnels, aucune erreur JS)

---

## === REQUEST_LOGS ===

**Audit préalable** : table écrite à chaque requête HTTP (middleware global `server.js`), jamais lue par aucune route, aucun index, aucune purge. Volume réel au moment de l'audit Phase 9 : 67 327 lignes (confirmé stable à 67 337 lignes au moment du Batch B — les 10 lignes d'écart datent d'une session antérieure au Batch B, aucune écriture pendant ce Batch).

**Stratégie** : purge conservatrice au boot du serveur (même schéma que `purgeActivityLogOlderThan` existant pour `activity_log`), mais avec suppression **par petits batchs bornés** (contrairement à `activity_log` qui fait un DELETE global — `request_logs` grossit bien plus vite et mérite ce traitement plus prudent).

- **Rétention** : configurable, défaut **30 jours**, clamp `[1, 365]` (`getRequestLogRetentionDays`/`setRequestLogRetentionDays`, stockée via `setMeta`/`getMeta`)
- **Batch size** : 500 lignes par batch, maximum 20 batchs par appel (10 000 lignes/appel au plus) — `DELETE ... WHERE id IN (SELECT id FROM request_logs WHERE timestamp < ? LIMIT ?)`
- **Index ajouté** : `idx_request_logs_timestamp` (justifié : la purge fait un scan sur `timestamp`, table à 67k+ lignes)
- **Logging** : nombre de lignes purgées loggé au boot (`logger.info({ purged, retentionDays }, ...)`) si `purged > 0`
- **Pas de DELETE global** : confirmé — chaque appel est borné par `batchSize`/`maxBatches`, jamais un DELETE sans LIMIT

**Suppression réelle pendant les tests : 0** (tous les tests utilisent `initSqlite(':memory:')` + insertions synthétiques — jamais la base réelle)
**DB utilisateur touchée : NON** (vérifié explicitement — voir section RÉGRESSION plus bas)

**Tests dédiés** (`test-batch-b-request-logs.mjs`, 12/12 PASS) :
- anciens logs purgés / logs récents conservés
- table vide → 0 supprimé, pas de crash
- rien d'éligible → 0 supprimé
- dates/jours invalides (`NaN`, chaîne non numérique) → 0 supprimé, pas d'exception (`new Date(NaN)` géré explicitement)
- `batchSize` respecté (1 batch = au plus `batchSize` lignes)
- plusieurs batchs cumulés jusqu'à `maxBatches`, arrêt même s'il reste des lignes éligibles
- arrêt anticipé dès qu'un batch renvoie moins que `batchSize` lignes
- volume synthétique important (2000 anciennes + 500 récentes) → seules les anciennes sont purgées, en plusieurs batchs bornés
- `getRequestLogStats` cohérent (count, retentionDays, sizeBytes)
- `logRequest` toujours fonctionnel après l'ajout des fonctions de purge (pas de régression sur le chemin d'écriture)

**Mesure performance (synthétique)** : voir section NOTEBOOK — le nettoyage de 2000 lignes synthétiques (4 batchs de 500) s'exécute en quelques millisecondes en mémoire ; le vrai coût en production dépend du disque, mais reste borné par construction (jamais plus de 10 000 lignes/appel).

---

## === NOTEBOOK ===

**Audit préalable** : le backend (`routes/notebook.js`, `lib/notebook.js`, Phase 5) était déjà correctement borné — `GET /notebooks/:id/sources` utilise déjà `limit`/`offset` paramétrés (`Math.min(parseIntParam(...), 500)`, corrigé en Batch A pour le crash NaN), la requête SQL est déjà paramétrée (`LIMIT ? OFFSET ?`) et indexée (`idx_notebook_sources_notebook_id`, déjà présent depuis la Phase 5). Le vrai écart identifié (finding F5 de l'audit Phase 9) était **frontend uniquement** : `NotebookModal.tsx` chargeait une page fixe de 200 sources sans aucun moyen d'en voir davantage pour un Notebook plus grand.

**Pagination : OUI** (déjà présente côté backend depuis la Phase 5 ; ajoutée côté frontend dans ce Batch)
**Default** : 100 (`SOURCES_PAGE_SIZE`, aligné sur le défaut backend)
**Max** : 500 (borne stricte déjà en place côté backend, `MAX_SOURCES_PER_NOTEBOOK = 5000` au niveau notebook)

**Changement frontend** : ajout d'un bouton « Charger plus (`x`/`total`) » dans la liste des sources de `NotebookModal.tsx`, qui appelle `cortexClient.listNotebookSources(notebookId, SOURCES_PAGE_SIZE, sources.length)` (le paramètre `offset` existait déjà côté client, jamais utilisé jusqu'ici) et concatène les résultats. Aucune virtualisation nécessaire pour l'instant : la borne stricte à 5000 sources/notebook rend une liste scrollable + pagination incrémentale suffisante, sans complexité supplémentaire injustifiée.

**Compatibilité API** : **aucun changement de contrat**. `GET /notebooks/:id/sources` renvoyait déjà `{ sources: [...], total: n }` (jamais un tableau nu) — le frontend n'utilisait simplement pas encore `offset`. Aucune migration nécessaire.

**Performance avant/après** (mesure synthétique, DB en mémoire, `test-batch-b-notebook-performance.mjs`, 5/5 PASS) :
- Notebook 10 sources (page complète) : **0,17 ms**
- Notebook 100 sources (page complète) : **1,07 ms**
- Notebook 150 sources, page 2 (`offset=100`) : **0,30 ms**
- Chunking ~1000 chunks (document synthétique ~1,2M caractères, 960 chunks générés) : **1,15 ms**

Confirme que le design déjà en place depuis la Phase 5 (index + requêtes bornées) tient largement la charge à cette échelle — aucune optimisation backend supplémentaire n'était nécessaire.

---

## === RÉGRESSION ===

**OpenRouter : PASS** — `test-openrouter-regression.mjs` + `test-teacher-fallback.mjs` : **27/27 PASS**. `openrouter.js` : diff = 0 (fichier non modifié). `teacher.js` : seule modification est celle du Batch A (`parseIntParam` sur `/teacher/review/due`, sans rapport avec OpenRouter) — le fallback OpenRouter (lignes ~232-261) est intact. `local_only` envoyé à OpenRouter : **0** (confirmé par les tests dédiés, aucun appel cloud live).

**Privacy : PASS** — `test-privacy-guard.mjs` (33/33), `test-phase1-egress-certification.mjs` (7/7), `test-strict-local-centralized.mjs` (6/6), `test-ai-provider-fallback.mjs` (54/54) : tous verts. `private`/`local_only` → 0 appel provider cloud (vérifié par les assertions `guardCloudCall`/`PrivacyViolationError` existantes, non modifiées).

**Notebook local_only : PASS** — `test-phase5-notebook.mjs` : 17/17 PASS (le Notebook RAG n'importe aucun module cloud, par construction — voir commentaire en tête de `routes/notebook.js`). Connecteur source privée → 0 provider cloud, confirmé par `test-phase2-connectors.mjs` (12/12 PASS), incluant le test explicite « imported YouTube items are tagged ... egress_policy=local_only, and never reach a cloud provider unmarked ».

---

## === QUALITÉ ===

**Tests ciblés Batch B** : `test-batch-b-request-logs.mjs` (12/12) + `test-batch-b-notebook-performance.mjs` (5/5) + `test-batch-a-robustness.mjs` (12/12, re-vérifié après nettoyage) = **29/29 PASS**

**Suite complète** (chaque fichier lancé dans son propre process — `node --test test-*.mjs` combiné en un seul process se bloque à cause d'un singleton DB partagé entre fichiers, contrainte préexistante documentée dans le code, sans rapport avec Batch B) :
- **483/484 PASS** sur 35 fichiers de suite automatisée réels (hors `test-find-eval.mjs` et `test-regression-api.mjs`, qui sont des scripts manuels interactifs — Playwright headful et serveur de fixture à vie infinie respectivement — pas des suites `node:test`, et `test-video-manual.mjs`, script de reproduction réseau réel exclu par construction)
- 1 échec : `test-maintenance.mjs` — **confirmé préexistant et non lié au Batch B** (reproduit à l'identique avec `git stash` sur l'état d'avant Batch B ; dépend d'un réglage réel déjà présent dans `cortex.sqlite`, lecture seule, aucune donnée modifiée)
- `test-video-pipeline.mjs` nécessite le flag `--experimental-test-module-mocks` (documenté dans `package.json`, script `test:video`) — ré-exécuté avec le bon flag : 2/2 PASS (inclus dans le total 483/484)

**Typecheck** : `npx tsc --noEmit` — **OK** (frontend et cortex-server, aucune erreur)
**Build** : `npm run build` — **OK** (12,2 s, chunks vérifiés ci-dessus)
**Appels cloud live** : **0** (tous les tests utilisent des mocks `fetch`/`Ollama` ou des DB en mémoire ; aucune clé réelle utilisée dans un test)
**Credential réel modifié** : **NON** (aucune clé/secret réel lu autrement qu'en lecture seule dans un process enfant isolé pour `test-maintenance.mjs`, comportement préexistant non introduit par ce Batch)
**Donnée utilisateur supprimée** : **0** (`request_logs` réel : 67 337 lignes avant et après, vérifié par requête directe ; `cortex.sqlite` : aucune ligne ajoutée/modifiée/supprimée pendant le Batch B)
**shell:true introduits par Batch B** : **0** (2 usages préexistants trouvés dans `claude-oauth.js`/`codex.js`, hors périmètre et non touchés par ce Batch — diff Batch B sur ces fichiers = 0 ligne)
**Fichiers modifiés par Batch B** :
- `cortex-server/src/lib/sqlite.js` (index + fonctions de rétention `request_logs`)
- `cortex-server/src/server.js` (purge au boot)
- `src/App.tsx` (lazy-loading des 3 modales)
- `src/components/modals/NotebookModal.tsx` (pagination « Charger plus »)
- Nouveaux : `cortex-server/test-batch-b-request-logs.mjs`, `cortex-server/test-batch-b-notebook-performance.mjs`

---

## GIT / DATA (avant/après)

- `git status` : 54 entrées avant, 54 entrées après (aucun fichier ajouté/supprimé hors ceux listés ci-dessus, aucun fichier de scratch résiduel — nettoyés)
- Aucune commande destructive utilisée (`git reset`/`git clean`/`git rm`/`git rm --cached`/commit automatique) : confirmé, aucune n'a été exécutée
- `cortex.sqlite` (base réelle) : taille et contenu (`request_logs` = 67 337 lignes, `pages` = 6731) identiques avant/après le Batch B — vérifié par requête directe en lecture seule à deux reprises pendant la session
- Serveurs de test isolés arrêtés, répertoires `data-test-batch-a/` et `data-test-batchb-ui/` supprimés
- Scripts de vérification temporaires (`__scratch-batchb-*.mjs`) supprimés

---

**ATTENTE : autorisation explicite avant Batch C.**
