# PHASE 2 — Réconciliation du comptage de tests (497 vs 511)

Mode : lecture seule. Aucun test supprimé, renommé ou modifié pour faire correspondre un chiffre.

## Résumé

**497 est le chiffre réel, reproductible et actuellement vérifié trois fois indépendamment.**
**511 n'est reproductible dans aucun artefact brut (log/JSON) — c'est une erreur d'arithmétique introduite dans `BATCH_C_MINOR_HARDENING_2026-09.md`, puis recopiée telle quelle dans deux rapports suivants sans être recalculée.**

Aucun test historique supprimé : confirmé (0).

---

## 1. Inventaire

36 fichiers de suite `node:test` réelle existent actuellement sous `cortex-server/` :

| # | Fichier | Tests | Statut |
|---|---|---:|---|
| 1 | test-agent-neuron-lifecycle.mjs | 1 | historique |
| 2 | test-ai-provider-fallback.mjs | 54 | historique |
| 3 | test-ai-providers.mjs | 37 | historique |
| 4 | test-batch-a-robustness.mjs | 12 | historique |
| 5 | test-batch-b-notebook-performance.mjs | 5 | historique |
| 6 | test-batch-b-request-logs.mjs | 12 | historique |
| 7 | test-batch-c-onedrive-size-limit.mjs | 12 | historique |
| 8 | **test-batch-d-connectors.mjs** | **33** | **nouveau (36e fichier)** |
| 9 | test-checkytdlp-handling.mjs | 3 | historique |
| 10 | test-cli-shell-resolution.mjs | 15 | historique |
| 11 | test-comfyui-install-manager.mjs | 35 | historique |
| 12 | test-external-agents.mjs | 29 | historique |
| 13 | test-files-xlsx.mjs | 7 | historique |
| 14 | test-free-ai-catalog.mjs | 22 | historique |
| 15 | test-free-ai-routes.mjs | 12 | historique |
| 16 | test-freellmapi.mjs | 7 | historique |
| 17 | test-image-generation.mjs | 22 | historique |
| 18 | test-jobs-route.mjs | 5 | historique |
| 19 | test-maintenance.mjs | 1 | historique |
| 20 | test-neurons-all-meta.mjs | 2 | historique |
| 21 | test-openrouter-regression.mjs | 16 | historique |
| 22 | test-phase1-egress-certification.mjs | 7 | historique |
| 23 | test-phase2-connectors.mjs | 12 | historique |
| 24 | test-phase3-adaptive-memory.mjs | 26 | historique |
| 25 | test-phase4-free-ai-images.mjs | 6 | historique |
| 26 | test-phase5-notebook.mjs | 17 | historique |
| 27 | test-phase5b-notebooklm.mjs | 8 | historique |
| 28 | test-phase6-browser.mjs | 16 | historique |
| 29 | test-phase7-sherlock.mjs | 18 | historique |
| 30 | test-privacy-guard.mjs | 33 | historique |
| 31 | test-prompt-templates.mjs | 11 | historique |
| 32 | test-router-providers-perf.mjs | 1 | historique |
| 33 | test-strict-local-centralized.mjs | 6 | historique |
| 34 | test-teacher-fallback.mjs | 11 | historique |
| 35 | test-video-audio.mjs | 14 | historique |
| 36 | test-video-pipeline.mjs | 2 | historique |

**35 fichiers historiques → 497 tests. + `test-batch-d-connectors.mjs` (33) → 530 tests, 36 fichiers.**

Exclus par construction (scripts manuels/interactifs, jamais comptés dans aucune version du chiffre officiel) : `test-find-eval.mjs`, `test-regression-api.mjs`, `test-video-manual.mjs`. `test-setup.mjs` est un module de préparation partagé, pas une suite.

Cette table a été vérifiée trois fois, de façon indépendante, avec un résultat identique au test près :
1. `reports/certification-test-*.mjs.log` (36 fichiers de log individuels, session antérieure).
2. `reports/connectors-certification-results.json` (même session, sortie structurée).
3. Réexécution complète effectuée en Phase 0 de cette mission (`reports/phase0-baseline-2026-09-16/run.log`).

Aucun écart entre les trois. Aucun test n'a donc été perdu entre la génération de ces rapports et aujourd'hui.

---

## 2. Origine du chiffre 497

`497` = somme des compteurs TAP `# tests` des 35 fichiers historiques (hors batch-d), tel qu'exécuté par `node --test <fichier>` (Node v22.22.3), un processus par fichier — méthode déjà documentée dans tous les rapports depuis Batch B (contrainte : `sqlite.js` expose un singleton DB par process, donc deux fichiers dans le même process avec des chemins DB différents se bloquent silencieusement).

Ce chiffre est confirmé par `reports/CONNECTORS_BACKEND_PHASE1_2026-09.md` (ligne 7 et 9), qui l'a déjà établi et signalé le 511 comme non reproductible — sans toutefois en retrouver la cause exacte. Cette phase complète ce travail.

**497 EXPLIQUÉ : OUI.**

---

## 3. Origine du chiffre 511 — chaîne reconstituée

Chronologie logique reconstituée à partir du contenu narratif des rapports (les dates de modification disque de ces fichiers non commités ne sont pas fiables comme horodatage d'écriture — elles reflètent l'extraction/checkout, pas la rédaction) :

| Rapport | Fichiers | Total déclaré | Cohérent avec les logs bruts ? |
|---|---:|---:|---|
| `DOCTEUR_MASTER_AUDIT_2026-09.md` | — | 232 tests | Époque antérieure, hors périmètre direct |
| `BATCH_B_PERFORMANCE_MAINTAINABILITY_2026-09.md` | 35 | **483/484** | Cohérent (baseline avant Batch C) |
| `BATCH_C_MINOR_HARDENING_2026-09.md` | 35 | **510/511** | **Incohérent avec son propre texte** (voir ci-dessous) |
| `FINAL_F1_TEST_MAINTENANCE_FIX_2026-09.md` | 35 | **511/511** | Hérite du 511 de Batch C sans le recalculer |
| `DOCTEUR_FINAL_CERTIFICATION_2026-09.md` | 35 | **510/511** | Hérite du 511 (FINAL-F1 non conservé à ce stade → repasse à 510) |
| `CONNECTORS_BACKEND_PHASE1_2026-09.md` | 36 (35+batch-d) | **530/530** (497+33) | Recalculé depuis zéro, cohérent avec les logs bruts, signale le 511 comme non reproductible |

### La preuve : l'arithmétique interne de Batch C ne totalise pas 511

Le rapport Batch C énonce lui-même, noir sur blanc :
- **Baseline avant Batch C : 483/484 PASS** (ligne 23 et 128), sur les mêmes 35 fichiers.
- **Nouveaux tests ajoutés par Batch C : 13** — 12 dans `test-batch-c-onedrive-size-limit.mjs` (nouveau fichier) + 1 dans `test-phase3-adaptive-memory.mjs` (25→26, ligne 90 : *"Test dédié ajouté... 25 → 26 tests"*) — explicitement confirmé ligne 126 : *"les 13 nouveaux tests de ce Batch (12 OneDrive + 1 F4)"*.
- Total attendu par la propre arithmétique du rapport : **484 + 13 = 497**, PASS attendu **483 + 13 = 496** (le même échec préexistant `test-maintenance.mjs` restant, donc 496/497).
- Total réellement déclaré par le rapport : **511/510**.
- **Écart non expliqué dans le rapport lui-même : 511 − 497 = 14.**

Le rapport contient même une phrase auto-contradictoire à la ligne 128 : *« croissance = 2 nouveaux fichiers/tests de ce Batch »* — alors que Batch C n'a ajouté qu'**un seul** nouveau fichier (`test-batch-c-onedrive-size-limit.mjs`) et 13 tests au total, jamais 2 fichiers. Cette formulation imprécise («2 nouveaux fichiers/tests») est le symptôme visible d'une confusion de comptage au moment de la rédaction — la cause la plus probable : une addition manuelle du delta (510−483=27, puis divisée/arrondie en «2 fichiers» de façon non rigoureuse) plutôt qu'une re-sommation réelle des 35 fichiers après l'ajout.

**Conclusion : le nombre 511 n'a jamais été recalculé par sommation réelle des `# tests` de chaque fichier. Il a été énoncé une fois dans Batch C avec une erreur arithmétique de +14 par rapport à ce que le propre texte du rapport décrit, puis copié tel quel dans FINAL_F1 et DOCTEUR_FINAL_CERTIFICATION sans être revérifié — ces deux rapports ne contiennent aucune table par fichier permettant de le recalculer, contrairement à Batch B, Batch C et CONNECTORS_BACKEND_PHASE1 qui, eux, sont cohérents avec les logs bruts encore présents.**

**511 EXPLIQUÉ : OUI** (identifié comme une erreur de frappe/calcul dans le rapport Batch C, propagée par copie dans 2 rapports suivants — pas une perte de test, pas un changement de méthode de comptage).

---

## 4. Tests historiques supprimés

**0 — confirmé.**

Vérification : chaque nom de fichier apparaissant dans `reports/certification-test-*.mjs.log` (session de certification précédente, 35 fichiers) existe toujours aujourd'hui sous `cortex-server/`, avec un nombre de tests identique au test près (voir table section 1). Aucune suppression, aucun renommage, aucune fusion silencieuse détectée.

`git log` ne montre aucun de ces fichiers de test comme jamais committé puis supprimé — ils n'ont simplement jamais été committés du tout (travail en working tree non commité depuis plusieurs sessions), donc l'historique Git ne peut pas non plus révéler de suppression : il n'y a rien à comparer côté Git, uniquement les logs de certification eux-mêmes, qui concordent.

---

## 5. Méthodes de comptage comparées

- `node:test` ne compte jamais un bloc `describe`/`suite` comme un test dans son compteur `# tests` : un seul fichier (`test-ai-providers.mjs`) utilise `describe()` imbriqué (7 blocs), et son propre run TAP le confirme directement — `# tests 37` et `# suites 7` sont deux lignes strictement séparées. Le tally utilisé dans cette phase (et dans les sessions précédentes) ne lit que `# tests`, jamais `# suites` : aucun risque de double comptage structurel, vérifié empiriquement sur ce fichier précis.
- Exécution combinée (plusieurs fichiers dans un seul `node --test a.mjs b.mjs`) vs exécution séparée (un process par fichier) : **testé dans cette phase** — `test-video-audio.mjs` + `test-video-pipeline.mjs` en une seule invocation donnent 16 (14+2), identique à la somme des deux exécutions séparées. Aucune différence de comptage entre les deux méthodes.
- Aucun test renommé, déplacé ou fusionné détecté entre les logs de certification précédents et l'état actuel.
- Aucun ancien script historique lançant un ensemble différent n'a été trouvé : `package.json` (racine et `cortex-server/`) ne contient qu'un script agrégé (`test:video`, 2 fichiers) — pas de script "run all tests" historique dont la définition aurait changé.

---

## 6. Méthode officielle à conserver

Aucune correction du runner n'est nécessaire — le calcul lui-même (somme des `# tests` TAP par fichier, un process par fichier) est correct et déjà appliqué de façon cohérente dans Batch B, Batch C (dans ses propres tests unitaires, pas dans son total final erroné) et CONNECTORS_BACKEND_PHASE1. Le problème était une erreur humaine de transcription du total final dans un seul rapport (Batch C), propagée par copie.

**Recommandation (méthode officielle future)** :

1. Exécuter chaque fichier `test-*.mjs` réel (hors `test-find-eval.mjs`, `test-regression-api.mjs`, `test-video-manual.mjs`, `test-setup.mjs`) dans son propre process : `node --test <fichier>` (ajouter `--experimental-test-module-mocks` uniquement pour `test-video-pipeline.mjs`, seul fichier utilisant `mock.module`).
2. Sommer directement les valeurs `# tests` / `# pass` / `# fail` rapportées par Node — jamais une addition manuelle du delta entre deux totaux précédents.
3. Toujours joindre au rapport la table par fichier (comme ci-dessus) — c'est cette table, présente dans Batch B/C/CONNECTORS_BACKEND mais absente de FINAL_F1/DOCTEUR_FINAL_CERTIFICATION, qui a permis de détecter et corriger l'écart ici. Un total sans table par fichier n'est pas vérifiable et ne doit plus être certifié seul.
4. Script proposé pour usage futur (déjà existant, non modifié dans cette phase) : `scripts/test-connectors-certification.mjs`, qui produit `connectors-certification-results.json` — structurellement exactement ce qu'il faut pour ce contrôle. Recommandation : en faire LE script officiel unique de comptage, réutilisé à chaque certification future plutôt que recréé/retapé à la main.

**Aucune modification de test appliquée pour faire correspondre un chiffre — conformément à la règle de cette phase.**

---

## GATE PHASE 2

```
TEST COUNT RECONCILIATION : PASS

511 historique expliqué : OUI — erreur arithmétique dans BATCH_C_MINOR_HARDENING_2026-09.md
                            (483/484 baseline + 13 nouveaux tests déclarés = 497 attendu,
                            511 déclaré sans recalcul), propagée par copie dans
                            FINAL_F1_TEST_MAINTENANCE_FIX_2026-09.md et
                            DOCTEUR_FINAL_CERTIFICATION_2026-09.md.

497 historique expliqué : OUI — somme réelle et reproductible des 35 fichiers historiques,
                            confirmée 3 fois indépendamment (logs de certification antérieurs,
                            JSON structuré, réexécution complète Phase 0 de cette mission).

Tests réellement supprimés : 0 (confirmé)

Méthode officielle future : un process par fichier (node --test <fichier>,
                            --experimental-test-module-mocks pour test-video-pipeline.mjs),
                            somme directe des compteurs TAP, table par fichier obligatoire
                            dans tout rapport de certification, script de référence
                            scripts/test-connectors-certification.mjs.
```
