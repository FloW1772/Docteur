# BATCH C — Durcissement mineur / surveillance (2026-09-16)

Autorisation : Batch C uniquement (limite téléchargement OneDrive, mise à jour ciblée exceljs si justifiée, améliorations mineures explicitement listées dans l'audit — F2, F4, F14 ; F3/F6/F7/F19 laissés en surveillance, voir plus bas). Aucun élargissement de périmètre.

## BATCH C : PASS

---

## === BASELINE ===

Avant toute modification, `test-maintenance.mjs` a été relancé isolément pour confirmer l'unique échec déjà documenté dans les rapports Batch A/B :

```
actual:   'mistral-nemo:12b-instruct-2407-q4_K_M'
expected: 'dedicated:latest'
at test-maintenance.mjs:52:10
```

- **Nom exact du test en échec** : `test-maintenance.mjs` (fichier entier — un seul test top-level, pas un `node:test` avec sous-tests)
- **Cause déjà connue** : le test lit la vraie clé/config OneDrive via un process enfant en lecture seule sur `cortex.sqlite` réel, puis attend que le modèle "dédié" configuré soit `dedicated:latest` — or la base réelle a actuellement `mistral-nemo:12b-instruct-2407-q4_K_M` comme modèle réellement configuré par l'utilisateur. Couplage à un état de configuration réel, pas un bug de code.
- **Preuve d'antériorité au Batch C** : déjà documenté identique dans `reports/BATCH_B_PERFORMANCE_MAINTAINABILITY_2026-09.md`, lui-même vérifié par `git stash` (échec reproduit à l'identique sur l'état d'avant Batch B). Re-vérifié ici avant toute modification Batch C : mêmes valeurs `actual`/`expected` au caractère près.

**Baseline confirmée : 483/484 PASS, même test en échec.**

---

## === C1 — ONEDRIVE FILE-SIZE PROTECTION ===

**PASS**

Audit préalable : `downloadFileContent()` (`lib/connectors/onedrive-connector.js`) n'est pas encore câblée dans `routes/connectors.js` (extraction de contenu OneDrive documentée PARTIEL depuis la Phase 2, en attente d'un enregistrement d'app Microsoft réel pour tester en conditions réelles) — mais la fonction existe, est exportée, et l'audit (F2) la signalait comme un risque latent : `res.arrayBuffer()` sans aucune vérification de taille.

**Limite** : 20 971 520 octets (20 MB) — réutilise `MAX_FILE_SIZE_BYTES` de `lib/files.js` (même plafond que pour un fichier uploadé directement ; les formats supportés par ce connecteur — .md/.txt/.pdf/.xlsx — n'ont pas de raison légitime de dépasser cette taille dans un usage de notes personnelles).

**Protection sans Content-Length : PASS**

Double vérification implémentée :
1. Pré-vérification rapide sur l'en-tête `Content-Length` quand il est présent et honnête → rejet immédiat, corps annulé (`res.body.cancel()`), avant toute lecture.
2. Comptage d'octets en cours de flux (`res.body.getReader()`), interrompu dès dépassement de la limite — **jamais dépendant du seul header**. Une réponse sans `Content-Length` (ou avec un header mensonger, ex. annonce 100 octets et en envoie 5000) est quand même bornée par ce comptage en flux.

Erreur contrôlée : `OneDriveFileTooLargeError` avec `code: 'ONEDRIVE_FILE_TOO_LARGE'`, `declaredSize`, `receivedBytes`. Aucun token OAuth, URL sensible, header `Authorization`, ou stack brute exposé (vérifié par test dédié) — le message ne contient que des compteurs d'octets, et le catch-all existant de `routes/connectors.js` (`sanitizeProviderError`, Batch A finding F17) reste en place pour toute intégration future de cette fonction dans une route.

**Tests ciblés** (`test-batch-c-onedrive-size-limit.mjs`, mocks uniquement) :
- fichier sous la limite → succès
- fichier exactement à la limite → succès (limite inclusive)
- fichier au-dessus, Content-Length honnête → rejet avant lecture, corps annulé
- Content-Length absent, fichier sous la limite → succès
- Content-Length absent, fichier au-dessus → rejet via le comptage en flux
- Content-Length mensonger (annonce 100, envoie 5000) → rejet via le comptage en flux, header jamais fait confiance seul
- flux dépassant la limite en cours de lecture → interruption précoce (quelques chunks après dépassement, pas après bufferisation complète)
- timeout (fetch qui lève) → erreur propre, aucune fuite d'URL/stack
- annulation (signal déjà aborté) → erreur propre
- aucune fuite de token/Authorization/Bearer dans un message d'erreur
- statut HTTP non-ok → erreur propre
- constante de limite : valeur saine et positive (20 MB)

**Résultat : 12/12 PASS**

---

## === C2 — EXCELJS ===

**ExcelJS avant** : 4.4.0 (installé)
**ExcelJS après** : 4.4.0 (inchangé)

**Audit effectué** :
- Version proposée la plus récente disponible sur le registre npm : **4.4.0 — déjà installée** (la seule version plus récente publiée est `4.4.1-prerelease.0`, une pré-version explicitement exclue par la règle mission "aucune version sûre/compatible" ne s'applique — il n'existe simplement aucune version stable plus récente vers laquelle migrer).
- `npm audit` : 1 vulnérabilité modérée liée à `exceljs`, transmise par sa dépendance `uuid@8.3.2` (GHSA-w5hq-g745-h8pq — dépassement de tampon dans `uuid` v3/v5/v6 **uniquement quand un buffer est fourni explicitement par l'appelant**, CVSS 7.5).
- Vérification directe du code source d'exceljs (`node_modules/exceljs/lib/`) : **exceljs n'importe que `uuid` v4** (`const {v4: uuidv4} = require('uuid')`), jamais v3/v5/v6 — la fonction vulnérable n'est jamais appelée, à aucune version d'exceljs. Docteur lui-même n'importe jamais `uuid` directement (confirmé par recherche dans `src/`) et ne le déclare pas en dépendance directe.
- Seul correctif proposé par `npm audit` : **rétrogradation majeure d'exceljs vers 3.4.0** (`fixAvailable.isSemVerMajor: true`) — un changement cassant, explicitement interdit par la règle mission ("Ne pas utiliser npm audit fix", "aucun --force").

**Upgrade forcé : NON attendu** — confirmé, aucun `npm install`/`npm audit fix` exécuté, `package.json`/`package-lock.json` inchangés (vérifié par `git status`).

**EXCELJS UPDATE : NON APPLIQUÉE — incompatibilité documentée**

Justification : déjà à la dernière version stable publiée ; la vulnérabilité transitive n'est pas atteignable par l'usage réel d'exceljs (fonction jamais appelée) ; le seul « correctif » disponible est une régression majeure interdite par les règles de la mission. Aucune action supplémentaire n'était disponible sans violer les règles absolues.

**Tests minimum requis, relancés sur l'installation actuelle** (`test-files-xlsx.mjs`, 7/7 PASS) :
- import `.xlsx` (fixture valide, plusieurs feuilles, cellules texte/nombre/date)
- lecture de workbook (`readWorkbookSummary`)
- pipeline `.csv` lié (lecteur `exceljs` csv, chemin distinct de `xlsx.load`)
- fichier `.xlsx` invalide/corrompu → erreur propre, jamais de crash process
- extension non supportée / nom de fichier trompeur → rejet
- `.xls` reste explicitement non supporté (vulnérabilité SheetJS/xlsx documentée, sans rapport avec exceljs) — **non réintroduit**

---

## === F4 (améliorations mineures explicitement listées) ===

`listPreferenceFacts()` (`lib/sqlite.js`) n'avait pas de `LIMIT` SQL explicite — sans risque aujourd'hui (déjà plafonné à l'écriture par `MAX_PREFERENCE_FACTS = 50`), mais incohérent avec le pattern paginé utilisé ailleurs. Ajout d'un `LIMIT ?` explicite réutilisant la même constante — aucun changement de comportement, défense en profondeur. Test dédié ajouté à `test-phase3-adaptive-memory.mjs` (25 → 26 tests, tous PASS).

**F3, F6, F7, F19 : laissés en surveillance, non modifiés**, conformément au langage même de l'audit ("non urgent aujourd'hui", "impact limité", "mitigé aujourd'hui", "suffisant aujourd'hui... pas urgent au volume actuel") et à la règle mission de ne pas élargir le périmètre :
- F3 (scan Jaccard O(n) mémoire épisodique) : déjà borné (500 candidats, plafond 2000) — candidat à réévaluer seulement si la latence devient perceptible en usage réel.
- F6 (deux `useEffect` App.tsx redéclenchés sur `cortex.available`) : impact limité, éléments déjà idempotents côté serveur.
- F7 (absence de virtualisation de liste) : déjà mitigé par le chargement paresseux (50 neurones au démarrage) + `memo` sur `Sidebar`.
- F19 (absence d'index vectoriel LanceDB) : 43 ms mesurés à 6726 neurones, suffisant au volume actuel — à surveiller si la base grossit significativement (connecteurs, Notebooks).

---

## === NON-RÉGRESSION ===

Relancés intégralement après les modifications C1/C2/F4 :

| Suite | Résultat |
|---|---|
| OpenRouter regression + Teacher fallback | 27/27 PASS |
| Privacy / egress | 33/33 PASS (`test-privacy-guard.mjs`) |
| Egress certification (Phase 1) | 7/7 PASS |
| Strict Local | 6/6 PASS |
| Connecteurs (Phase 2, OAuth) | 12/12 PASS |
| Notebook local_only (Phase 5) | 17/17 PASS |
| Batch A | 12/12 PASS |
| Batch B (request_logs + Notebook perf) | 17/17 PASS |

**`openrouter.js` : non modifié** (diff = 0 ligne). **Fallback OpenRouter dans `teacher.js` : non modifié** par ce Batch. **`local_only` envoyé à OpenRouter : 0.** **Appels cloud live : 0** (tous les tests utilisent des mocks `fetch` ou des DB en mémoire/isolées).

---

## === TEST FINAL ===

Suite complète relancée fichier par fichier (contrainte préexistante : `node --test test-*.mjs` combiné en un seul process se bloque à cause d'un singleton DB partagé entre fichiers de test — déjà documenté en Batch B, sans rapport avec Batch C).

**Résultat : 510/511 PASS sur les 35 fichiers de suite automatisée réels** (hors `test-find-eval.mjs`, `test-regression-api.mjs` — scripts manuels interactifs, pas des suites `node:test` — et `test-video-manual.mjs`, script de reproduction réseau réel, tous trois exclus par construction comme en Batch B).

- **Échec préexistant identique : OUI** — `test-maintenance.mjs`, mêmes valeurs `actual`/`expected` qu'à la baseline, aucune modification de ce fichier ni de son comportement.
- **Nouveaux échecs : 0** — confirmé, les 13 nouveaux tests de ce Batch (12 OneDrive + 1 F4) sont tous verts, et aucune suite préexistante n'a régressé.

Baseline avant Batch C : 483/484 PASS. Après Batch C : 510/511 (croissance = 2 nouveaux fichiers/tests de ce Batch, même unique échec préexistant conservé à l'identique) — conforme au critère minimum acceptable ("483/484 PASS avec exactement le même test préexistant en échec").

**Typecheck** : `npx tsc --noEmit` (frontend + cortex-server) — **OK**, aucune erreur.
**Build** : `npm run build` — **OK**, 14,0 s, chunks identiques à ceux du Batch B (aucune modification frontend dans ce Batch).

---

## === GIT / DONNÉES ===

- `git status`/`git diff --stat` exécutés avant et après : aucune commande destructive utilisée (`git reset`/`git clean`/`git rm`/`git rm --cached`/commit automatique — aucune de ces commandes n'a été exécutée).
- `package.json`/`package-lock.json` : **inchangés** (aucune installation/mise à jour de dépendance).
- `cortex.sqlite` réel : vérifié en lecture seule avant et après — `request_logs` = 67 337 lignes, `pages` = 6731 lignes, taille/horodatage fichier identiques (19 542 016 octets, 16/09/2026 00:27) aux deux vérifications. **Aucune écriture pendant le Batch C.**
- Répertoires de test isolés (`data-test-*`) créés pendant les runs de tests supprimés après usage.

---

## === QUALITÉ (résumé demandé) ===

```
OneDrive file-size protection : PASS
Limite : 20 971 520 octets (20 MB, réutilise MAX_FILE_SIZE_BYTES de lib/files.js)
Protection sans Content-Length : PASS

ExcelJS avant : 4.4.0
ExcelJS après : 4.4.0
Upgrade forcé : NON (confirmé)

Tests ciblés : 13/13 (12 OneDrive + 1 F4)
Suite complète : 510/511
Échec préexistant identique : OUI
Nouveaux échecs : 0

OpenRouter : PASS
Privacy/local_only : PASS

Typecheck : OK
Build : OK

Cloud live : 0
Credential réel modifié : NON
DB réelle touchée : NON
Donnée utilisateur supprimée : 0
shell:true : 0

Fichiers modifiés :
- cortex-server/src/lib/connectors/onedrive-connector.js (C1 — limite de taille)
- cortex-server/src/lib/sqlite.js (F4 — LIMIT explicite listePreferenceFacts)
- cortex-server/test-batch-c-onedrive-size-limit.mjs (nouveau, 12 tests)
- cortex-server/test-phase3-adaptive-memory.mjs (+1 test F4)
```

---

**STOP. Aucune autre correction issue de l'audit ne sera lancée sans autorisation explicite.**
