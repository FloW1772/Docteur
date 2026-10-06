# Docteur — Professeur V2 — Certification finale (2026-10-06)

Verdict : **PROF7_PASS — PROFESSOR_V2_FINAL_CERTIFICATION_PASS**. Rien n'est commité : tout est dans l'arbre de travail.

## 1. Ce que Professeur V2 apporte

| Capacité | Résumé |
|---|---|
| Deux voies par module | THÉORIE et PRATIQUE, chacune avec son propre état (Verrouillé, En cours, À retravailler, Validé) et sa propre évaluation. |
| Verrou | Le module suivant ne s'ouvre que si les deux voies sont validées. L'interface le reflète, et le serveur refuse `/advance` (409 `TRACKS_NOT_PASSED`). |
| Remédiation ciblée | Un échec indique la notion à retravailler, pourquoi, et propose une nouvelle tentative. Il ne touche que sa voie ; l'autre garde son état et sa date de validation. |
| Historique | Les tentatives sont conservées en ajout seul (`learning_track_attempts`). La lecture filtre les champs et marque les lignes illisibles au lieu d'échouer. |
| Reprise | Tout est restauré après un rechargement, une fermeture et réouverture, ou un vrai redémarrage de processus (testé). |
| Consultation | Les modules terminés et les parcours terminés se relisent en lecture seule, sans jamais modifier une validation. |
| Sport Coach | Mode `sport` dans le même moteur : profil, programme structuré, séances à faire (pratique auto-déclarée), check-in après séance, adaptation déterministe et règles de sécurité appliquées dans le code. |
| Cours V1 | Fonctionnement historique inchangé, jamais converti. Un bug d'affichage préexistant a été corrigé : la vue V1 revenait à l'étape précédente après une validation. |

## 2. Architecture

- **Backend (`cortex-server/src/lib`)**
  - `teacher-progress.js` : machine d'états des voies et verrou, modes de pratique autorisés selon le type d'exercice.
  - `teacher-evaluation.js` : verdicts structurés et bornés, remédiation, validation des exercices générés.
  - `teacher-legacy.js` : couche de compatibilité V1, et suppression de la réponse attendue dans toutes les réponses.
  - `teacher-history.js` : présentation de l'historique.
  - `sport-profile.js` : vocabulaires fermés, validation du profil, contrôle douleur.
  - `sport-catalog.js` : catalogue de 37 exercices étiquetés (matériel, lieux, zones sollicitées, complexité, variantes, substitutions).
  - `sport-program.js` : bornes par niveau, plafonds jeunes, validation stricte des propositions du modèle, solution de repli sur le catalogue, budget temps, progression monotone, filtre de sécurité.
  - `sport-adaptation.js` : boucle d'adaptation déterministe.
- **Routes (`routes/teacher.js`)**
  - Professeur V2 : `…/theory/answer`, `…/practice/submit`, `…/practice/spec`, `…/attempts` ;
  - Sport Coach : `/teacher/sport/options`, `/teacher/sport/paths`, `…/sport/resume`.
- **Frontend**
  - `TeacherModal.tsx` : intégration, case « Théorie + Pratique » cochée par défaut pour les nouveaux cours.
  - `TeacherDualTrack.tsx` : vue THÉORIE | PRATIQUE, en colonnes à partir de 900 px et en onglets en dessous.
  - `TeacherSportCoach.tsx` : formulaire, aperçu du programme, séance, check-in, tableau de bord.
  - `lib/teacher/*.ts` : fonctions pures du modèle de vue, avec contrôle de parité contre les règles serveur.
- **Données** : migration additive livrée en PROF-2. Il n'y a eu **aucune migration** entre PROF-3 et PROF-7 : `mode`, `profile` et `tracks` stockent tout.

## 3. Évaluation et provenance

- Un verdict invalide, incohérent ou dangereux est refusé et n'entraîne aucun changement d'état. Il est enregistré comme « inexploitable », jamais comme un échec ni comme une réussite.
- **SELF_REPORTED** est affiché « non observé par Docteur ».
- **VERIFIED** n'existe que si le serveur contrôle lui-même le résultat. Un modèle ne peut jamais créer un exercice vérifiable.
- Une réponse attendue côté serveur n'apparaît jamais dans l'API, le DOM, un prompt ni les journaux.
- Une séance de sport ne se valide que par auto-déclaration ; aucune vérification physique n'est simulée.

## 4. Registres pédagogiques (matrice PROF-7)

| Registre | V1 | V2 | Théorie | Pratique | Évaluation | Remédiation | Rechargement | Sport |
|---|---|---|---|---|---|---|---|---|
| enfant | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS (plafonds jeunes : RPE ≤ 7, pas de mouvement avancé) |
| debutant | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| standard | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| expert | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| socratique | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

Le registre change les prompts, jamais la progression. Aucune logique n'est codée en dur sur un registre. Pour Sport, `enfant` est traité comme une information d'audience et applique des plafonds prudents.

## 5. Sport Coach : sécurité et confidentialité

- **Douleur au profil** : une douleur forte (≥ 7/10) ou qui s'aggrave bloque la création du programme et oriente vers un professionnel de santé. Une douleur légère retire la zone de tous les exercices et affiche un seul message calme.
- **Adaptation** : une seule mauvaise séance ne donne qu'une observation. Deux signaux consécutifs déclenchent un ajustement borné, toujours accompagné d'une raison lisible.
- **Douleur en séance** : la zone est épargnée et l'intensité baisse. Si elle se répète ou s'aggrave, le programme passe en pause, la séance suivante est bloquée côté serveur, et la reprise demande une confirmation explicite, puis se fait en douceur.
- **Filtre de sécurité dans le code** : il refuse « continuer malgré la douleur », les diagnostics, les traitements, les autorisations médicales et la « rééducation », dans les programmes, les leçons et les évaluations Sport.
- **Confidentialité** : le texte libre des limitations, l'intensité de la douleur, l'âge et les commentaires de check-in ne sont jamais envoyés à un modèle, même avec le cloud activé (testé). Seuls des noms de zones sont transmis.
- **Strict Local** : 0 appel réseau sur tous les chemins (testé), même avec un provider cloud configuré.
- **Cloud activé explicitement** : les appels passent uniquement par le provider sélectionné, via les contrôles existants.

## 6. Tests

| Suite | Résultat |
|---|---|
| Backend, orchestration officielle `cortex-server/test-manifest.mjs --run` (série) | **3399 tests : 3391 pass, 0 fail, 0 annulé, 8 ignorés** (ignorés volontairement par les tests : Ollama ou réseau réel absents, plateforme, droit de créer des liens symboliques) |
| Baseline Professeur (fallback 11, batch-a 12, maintenance 1, openrouter 16, strict-local 6) | 46/46 |
| PROF-2 dual-track, migration, registres | 13/13, 7/7, 5/5 |
| PROF-3 spec, PROF-3R revalidation, PROF-4 | 11/11, 8/8, 19/19 |
| Sport (PROF-5), adaptation (PROF-6), certification PROF-7 | 39/39, 25/25, 9/9 (×2) |
| Port-preflight, sondes, audit statique Root Policy | 8/8, 24/24, 13/13 |
| Unitaires frontend Professeur | 6/6, 4/4, 8/8 |
| Navigateur : PROF-3, registres (dont stale-state V1), PROF-4, Sport, adaptation Sport | 63, 162, 57, 37, 49 assertions, toutes PASS |
| Régressions : YouTube Multi-Channel, Media Reader, Dashboard (3 suites) | 69 ; 82 ; 15/15, 61 et 101 assertions, toutes PASS |
| Typecheck / build | PASS / PASS |

Les tests navigateur montent le vrai `TeacherModal` relié à la vraie route Hono, avec SQLite en mémoire et des modèles scriptés. Aucune vraie base, aucun réseau.

## 7. Intégrité

- **Vraie base**, contrôlée sur une copie : `integrity_check` ok ; le parcours V1 utilisateur est intact (schéma 1, `enfant`, étape 2) ; aucune tentative ajoutée ; empreintes identiques à l'instantané initial.
- **Root Policy** : V1 active, signature valide, `highestVersionSeen = 1`, V2 ni signée ni installée, aucun fichier de policy modifié.
- **Modules gelés** (MAÎTRE, Observateur, OMEGA, RASSILON, Device Fabric, Notebook) : 0 modification.
- **Démarrage complet** : `NOT_RUN_BY_DESIGN`. Il écrirait dans des chemins réels non isolables (`data/rassilon/scratch`, `data/inbox`, `data/external-agents`). Contrôle remplacé par la vérification de syntaxe de `server.js`, le chargement des routes par toutes les suites, et le contrôle de port non destructif.

## 8. Changements (non commités)

- **Antérieurs, conservés tels quels** : YouTube Multi-Channel, Media Reader, Dashboard (`App.tsx`, `Dashboard.tsx`, `capture.js`, `ytdlp.js`, `server.js`, `globals.css`, et les blocs YouTube de `client.ts`, entre autres).
- **Port-preflight** : `port-preflight.js` (sonde de repli netstat, résultat jamais « libre » par défaut), `test-port-preflight-probes.mjs`.
- **Registre d'audit** : une ligne dans `test-root-policy-static-audit.mjs` (`lib/port-preflight.js` classé `TYPED_INTERNAL`).
- **Professeur V2 et Sport Coach**
  - Fichiers modifiés : `sqlite.js` (PROF-2), `routes/teacher.js`, `TeacherModal.tsx`, et des blocs balisés `[Professeur V2 — PROF-n]` dans `client.ts`.
  - Nouveaux modules : les 8 modules `teacher-*` et `sport-*`, `TeacherDualTrack.tsx`, `TeacherSportCoach.tsx`, `lib/teacher/`.
  - Nouveaux tests : 9 suites backend, 3 suites unitaires frontend, 5 suites navigateur, et le harnais `teacher-v2-harness.jsx`.

## 9. Notes

- Les tests utilisent des modèles scriptés et déterministes. Avec un vrai modèle local, la qualité pédagogique dépend du modèle ; chaque sortie reste bornée et validée, avec un repli sûr (exercice générique, programme du catalogue, leçon déterministe).
- Le manifeste officiel exclut, avec justification, deux scripts manuels (`test-find-eval.mjs`, `test-video-manual.mjs`) et un serveur de débogage (`test-regression-api.mjs`).
- Le problème Kiwix connu (`verifyLoopbackBinding` traite `undetermined` comme lié en local seulement) reste au backlog Kiwix. Il n'a pas été traité ici.
