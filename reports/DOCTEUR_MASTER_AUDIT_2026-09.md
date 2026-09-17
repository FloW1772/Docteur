# DOCTEUR — MASTER AUDIT

Date : 2026-09-15
Mode : **LECTURE SEULE**. Aucune correction n'a été appliquée pendant cette phase.
Méthode : mesures directes contre l'installation réelle de l'utilisateur (lecture seule
uniquement, jamais de mutation) + un agent d'audit en arrière-plan (worktree isolé, aucun
accès à la vraie base) couvrant frontend/backend/sécurité/dépendances/performance.

## Résumé exécutif

Aucune faille P0 (critique) ni P1 (élevée) trouvée. Le code produit par cette mission
(Phases 1-8) respecte de façon cohérente les disciplines déjà en place dans le projet
(`shell:false` systématique, DPAPI pour les secrets, rédaction des logs, propagation
privacy/egress). Les points trouvés sont majoritairement P2/P3 — robustesse, performance à
l'échelle, et une dette de bundle frontend préexistante à cette mission.

## Scores

| Catégorie | Score /10 | Justification |
|---|---|---|
| Sécurité | 8/10 | 0 `shell:true` exploitable, secrets jamais loggés, validation d'entrée cohérente ; -2 pour l'absence de timeout sur les appels OAuth sortants (F1) et les messages d'erreur provider bruts renvoyés au client (F15) |
| Confidentialité | 9/10 | Propagation local_only vérifiée par tests sur 3 phases (1, 2, 5), aucun fallback cloud caché trouvé, Notebook local strictement découplé de NotebookLM |
| Stabilité | 7/10 | Aucun crash serveur trouvé en usage normal ; -3 pour le crash 500 reproductible sur paramètre `limit`/`offset` non numérique (F16, 5 fichiers) |
| Performance | 7/10 | Tous les endpoints mesurés < 100ms sur la vraie base (6726 neurones) ; -3 pour la table `request_logs` non bornée (67k lignes, jamais lue) et l'absence d'index vectoriel LanceDB à l'échelle |
| Architecture | 8/10 | Réutilisation cohérente des patterns existants (jobs, secret-store, chunking partagé) ; -2 pour le bundle frontend non code-splitté (F9, préexistant) |
| Maintenabilité | 8/10 | Tests systématiques par phase (232 tests backend), rapports de checkpoint complets ; -2 pour la duplication du pattern `Number(query) ` sans garde NaN répétée dans 5 fichiers |
| UX | 7/10 | Fonctionnalités honnêtement annoncées (Notebook "outils non implémentés" plutôt que simulés) ; -3 pour la pagination Notebook UI limitée à 200 sources sans "charger plus" (F5) |
| Tests | 9/10 | 232 tests backend, tous les nouveaux modules couverts, aucun test frontend automatisé n'existe dans le projet (limite structurelle du projet, pas de cette mission) |

## Findings

### P0 — Critique
Aucun.

### P1 — Élevé
Aucun.

### P2 — Moyen-élevé

**F1 — Absence de timeout sur les appels fetch() des connecteurs OAuth**
- Fichiers : `cortex-server/src/lib/connectors/youtube-connector.js` (lignes 58, 75, 133),
  `cortex-server/src/lib/connectors/onedrive-connector.js` (lignes 57, 75, 145, 176)
- Preuve : aucun de ces `fetch()` ne passe `signal: AbortSignal.timeout(...)`, contrairement
  au pattern déjà établi dans `lib/providers/anthropic.js:45` et `lib/providers/comfyui.js:22`.
- Impact : si Google/Microsoft ne répond jamais, `POST /connectors/:provider/sync` et
  `/callback` peuvent rester bloqués indéfiniment (aucun timeout de requête HTTP côté route
  non plus).
- Reproduction : mock `fetch` pour ne jamais résoudre, appeler `connect()`/`fetchItems()`,
  observer l'absence de rejet après un délai raisonnable.
- Correction proposée : ajouter `signal: AbortSignal.timeout(15_000)` (ou proche) à chaque
  `fetch()` des deux modules connecteurs, aligné sur le pattern `comfyui.js`.
- Risque : moyen (pas de sécurité, disponibilité). Effort : faible (ajout d'une option par
  appel). Tests nécessaires : mock d'un `fetch` qui ne résout jamais, vérifier un rejet sous
  15s.

**F2 — `onedrive.downloadFileContent` sans limite de taille**
- Fichier : `cortex-server/src/lib/connectors/onedrive-connector.js:175-179`
- Preuve : `res.arrayBuffer()` sans vérification de `content-length` ni timeout.
- Impact : latent (le code de sync actuel n'appelle pas encore cette fonction — seul un
  placeholder métadonnées est utilisé, selon un commentaire explicite du code lui-même) —
  risque réel seulement une fois le téléchargement binaire réellement câblé.
- Correction proposée : vérifier `content-length` avant de lire le corps, imposer une taille
  maximale raisonnable (ex. 50 Mo), timeout sur le fetch.
- Risque : faible actuellement (code non atteint), moyen une fois activé. Effort : faible.

**F9 — Bundle frontend non code-splitté (préexistant, aggravé marginalement par cette mission)**
- Preuve (`npm run build`) :
  ```
  dist/assets/index-DhfbxtNi.js   1,554.81 kB │ gzip: 388.90 kB
  dist/assets/esm-dOBh4Pjv.js     3,349.46 kB │ gzip: 893.41 kB
  ```
- Cause : `three.js` (import statique dans `main.tsx` et `NeuralBrain.tsx`) et
  `tesseract.js` (OCR) chargés au premier rendu, jamais en `import()` dynamique.
- Impact : ~4,9 Mo non compressés (~1,28 Mo gzip) chargés même si l'utilisateur n'ouvre
  jamais la vue 3D ni l'OCR.
- Correction proposée : `React.lazy()` + `import()` dynamique pour `NeuralBrain.tsx` et les
  hooks OCR (`useScreenOcr.ts`), déplacer l'import `three` hors de `main.tsx`.
- Risque : faible (perf uniquement). Effort : moyen (refactor des points d'import).

**F13 — npm audit frontend : 4 vulnérabilités (2 high, 1 moderate, 1 low)**
- `browserslist` — high ×2 (croissance mémoire non bornée, crash par fichier de stats
  non fiable) ; `baseline-browser-mapping` — moderate (DoS) ; `postcss-selector-parser` —
  low (récursion AST non contrôlée).
- Toutes des dépendances **transitives d'outillage de build** (chaîne browserslist/postcss),
  jamais expédiées dans le bundle de production ni atteignables par une entrée utilisateur.
  Risque réel limité à la machine de build.
- **Aucune correction appliquée** (conforme à la règle : pas de `npm audit fix`).

**F16 — Crash 500 sur paramètre `limit`/`offset` non numérique (nouveau constat, cette session)**
- Fichiers : `cortex-server/src/routes/memory.js:46-47`, `routes/notebook.js:92-93`
  (introduits par cette mission), et le même motif préexistant dans `routes/privacy.js:10`,
  `routes/skills.js:254`, `routes/teacher.js:905`.
- Preuve : `Math.min(Number(c.req.query('limit') ?? 100), 500)` — si `limit` est une chaîne
  non numérique (`?limit=abc`), `Number('abc')` vaut `NaN`, propagé jusqu'à la requête SQL
  préparée qui lève alors `datatype mismatch` (vérifié directement : `listNotebookSources('test-nb', { limit: NaN, offset: 0 })` lève bien cette erreur) → **HTTP 500 au lieu d'un
  comportement gracieux**.
- Reproduction : `GET /api/notebooks/:id/sources?limit=abc` ou `GET /api/memory/items?limit=abc`.
- Correction proposée : remplacer `Number(x)` par une fonction utilitaire
  `Number.isFinite(n) ? n : default` avant le `Math.min`/`Math.max`, dans les 5 fichiers
  concernés (2 nouveaux + 3 préexistants).
- Risque : faible (pas de sécurité — SQLite rejette proprement, pas d'injection possible via
  requête préparée — mais expérience utilisateur dégradée : un lien/bookmark malformé casse
  la page). Effort : faible.

**F17 — Messages d'erreur provider OAuth renvoyés bruts au client (nouveau constat)**
- Fichier : `cortex-server/src/routes/connectors.js:179, 263`
- Preuve : `return c.json({ error: error.message }, 502)` où `error.message` vient
  directement de `youtube-connector.js`/`onedrive-connector.js`, qui interpolent
  `body?.error_description ?? body?.error` (la chaîne d'erreur renvoyée par Google/Microsoft
  elle-même) dans le message d'exception.
- Analyse : aucun secret n'est concerné (les réponses d'erreur OAuth ne contiennent jamais
  le `client_secret`/token — vérifié par lecture du code d'échange), mais la lettre de la
  règle mission ("Ne pas retourner err.message brut si erreur provider, OAuth ou secret")
  n'est pas respectée : le détail technique du provider distant est renvoyé tel quel au lieu
  d'un message générique avec détail en log uniquement.
- Correction proposée : au niveau de la route, remplacer par un message générique
  ("Échec de connexion au provider — voir les logs serveur pour le détail") et logger
  `error.message` via `logger.warn` (déjà fait) sans l'exposer dans la réponse HTTP.
- Risque : faible (pas de fuite de secret confirmée, mais dérogation à la règle mission).
  Effort : faible.

### P3 — Amélioration

**F3** — Scan de similarité Jaccard O(n) sur chaque écriture/lecture de mémoire
(`lib/memory.js`, `addEpisodicMemoryDeduped`/`selectMemoriesForBudget`, plafonné à 500
candidats par `listEpisodicMemories({ limit: 500 })`, borné par `MAX_EPISODIC_MEMORIES=2000`
— non urgent aujourd'hui, candidat à optimisation si la latence devient perceptible à
grande échelle réelle).

**F4** — `listPreferenceFacts()` sans `LIMIT` SQL explicite (`sqlite.js:2083-2086`) —
actuellement sans risque car la table est plafonnée applicativement à 50 lignes
(`MAX_PREFERENCE_FACTS`), mais incohérent avec le pattern paginé utilisé ailleurs.

**F5** — `NotebookModal.tsx:168` charge une page fixe de 200 sources sans "charger plus",
alors que le backend supporte la pagination jusqu'à 5000 sources par Notebook — un Notebook
dépassant 200 sources verra sa liste visible silencieusement tronquée dans la barre latérale
gauche (le total affiché reste exact, mais pas la liste manipulable).

**F6** — Deux `useEffect` dans `App.tsx` (lignes ~3802, ~3820) se redéclenchent à chaque
transition `false→true` de `cortex.available` (recalculé toutes les 10s par le health
check) — en cas de serveur instable, ré-exécution redondante de `getInboxPending()`/
`getPendingAgentOutputs()`. Impact limité (les éléments consommés sont marqués côté serveur)
mais mériterait un flag "déjà exécuté une fois" plutôt qu'une dépendance sur un booléen brut.

**F7** — Aucune virtualisation de liste dans le frontend (`react-window` absent des
dépendances) — mitigé aujourd'hui par le chargement paresseux (50 neurones au démarrage) et
un `memo` avec égalité personnalisée sur `Sidebar`, mais pourrait dégrader le défilement une
fois "Tous les neurones" chargé sur un corpus de plusieurs milliers d'éléments.

**F14** — npm audit backend : 2 vulnérabilités modérées, `exceljs`→`uuid` (bug de bornes
tampon sur un mode d'utilisation `uuid` v3/v5/v6 qu'`exceljs` n'utilise vraisemblablement
pas). Correction disponible mais implique un bump majeur d'`exceljs` (changement cassant) —
non appliqué dans cette phase.

**F18** — `request_logs` (SQLite) croît sans limite et n'est **jamais lu** par aucune route
(constat direct, cette session : 67 327 lignes dans la base réelle, écrites à chaque requête
HTTP via un middleware global `server.js:1611`, `logRequest()`, sans purge ni index). Le coût
d'écriture par ligne mesuré est négligeable (~0,03 ms), donc ce n'est pas un problème de
performance immédiat, mais un problème d'accumulation disque/maintenabilité à long terme —
soit la table devrait être exploitée (dashboard de stats), soit purgée périodiquement
(pattern déjà utilisé ailleurs : `routes/jobs.js` purge les jobs terminés après 10 min).

**F19** — Aucun index vectoriel LanceDB (`numIndices: 0`, mesuré directement) — recherche
actuelle en scan complet, mesurée à 43 ms pour 6726 neurones. Suffisant aujourd'hui, mais
dégradation linéaire attendue à mesure que la base grossit (connecteurs Phase 2, Notebooks
Phase 5 jusqu'à 5000 sources). À surveiller, pas urgent au volume actuel.

### Informationnel / Vérifié sain (aucune action nécessaire)

**F8** — Polling `useCortex`/`useConnectivity` : un seul intervalle chacun, dépendances
`useCallback` stables, pas de double-polling trouvé (vérifié par lecture complète des deux
hooks et de leurs points d'appel uniques).

**F10** — Audit `shell:true` sur tout `cortex-server/src` : seules occurrences réelles dans
`claude-oauth.js`/`codex.js`, toutes en `execFile` avec arguments littéraux fixes (jamais
d'entrée utilisateur interpolée). Le nouveau code Phase 6/7 (`lib/browser.js`,
`lib/sherlock.js`) utilise `shell:false` de façon systématique et vérifiée par test.

**F11** — Vérification ponctuelle de la propagation privacy/egress sur `routes/notebook.js`
(aucun import de provider cloud), `routes/connectors.js`/`routes/sherlock.js` (tagging
`local_only` par défaut), `routes/memory.js` (middleware `loopbackOnly`) — aucune brèche
trouvée.

**F12** — Recherche de fuite de secret dans les logs (`console.*` + mots-clés
token/secret/key/password) sur tout `cortex-server/src` : **zéro résultat**. Rédaction
structurelle Pino (`REDACT_PATHS`) + regex de secours (`SECRET_PATTERNS`) déjà en place et
appliquée aux nouvelles routes.

## Table de performance (mesures réelles, lecture seule)

| Endpoint | Base | Latence mesurée |
|---|---|---|
| `GET /api/health` | réelle (6726 neurones) | 14-109 ms (à froid puis chaud) |
| `GET /api/neurons/recent?limit=50` | réelle | 42-89 ms |
| `GET /api/neurons/counts` | réelle | 42-51 ms |
| `GET /api/memory/items` | isolée (vide) | 5-9 ms |
| `GET /api/notebooks` | isolée (vide) | 6-21 ms |
| `GET /api/sherlock/status` | isolée (vide) | 4-7 ms |
| `GET /api/browser/installed` | isolée (vide) | 6-8 ms |
| Recherche vectorielle LanceDB (6726 lignes, sans index) | réelle | 43 ms |
| Insertion `request_logs` (mesure directe, 100 insertions) | réelle | 0,027 ms/insertion en moyenne |

## Dépendances

- Frontend : 4 vulnérabilités (0 critique, 2 high, 1 moderate, 1 low) — voir F13.
- Backend : 2 vulnérabilités (0 critique, 0 high, 2 moderate, 0 low) — voir F14.
- **Aucun `npm audit fix` exécuté**, conforme à la règle mission.

## Hygiène Git / .gitignore

- `git status` propre après chaque phase (vérifié tout au long de la mission).
- `notebook-exports/`, `data-test-*`, base SQLite/LanceDB réelles : tous correctement
  couverts par les règles `.gitignore` existantes (`cortex-server/data/`,
  `cortex-server/data-test-*/`) — vérifié par `git check-ignore -v` sur les nouveaux
  chemins introduits par cette mission (aucune modification de `.gitignore` nécessaire).
- Aucun fichier ressemblant à un secret trouvé tracké par git (`git ls-files` filtré sur
  motifs secret/key/password/credentials → uniquement du code source légitime).

## AUDIT TERMINÉ — AUCUN FIX D'AUDIT APPLIQUÉ

Les fonctionnalités planifiées (Phases 0 à 8) ont été traitées séquentiellement, chacune
avec son propre rapport de checkpoint, tests et gate. Voici les batches de corrections
recommandés issus de cet audit :

**Batch A — Robustesse rapide (faible risque, faible effort)**
F16 (garde NaN sur `limit`/`offset`, 5 fichiers), F17 (messages d'erreur OAuth génériques
côté client), F1 (timeouts fetch connecteurs OAuth).

**Batch B — Performance/maintenabilité (effort moyen)**
F9 (code-splitting three.js/tesseract.js), F18 (purge ou exploitation de `request_logs`),
F5 (pagination réelle dans NotebookModal.tsx).

**Batch C — Améliorations mineures / surveillance (faible priorité)**
F2 (limite de taille téléchargement OneDrive, latent), F3/F4/F6/F7/F19 (optimisations à
réévaluer si la volumétrie réelle le justifie), F14 (bump `exceljs` majeur — changement
cassant à planifier séparément).

J'attends l'autorisation utilisateur avant de lancer un batch.
