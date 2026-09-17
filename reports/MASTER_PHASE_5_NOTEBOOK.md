# MASTER PHASE 5 — Notebook local documentaire/RAG

Date: 2026-09-15
Branche: `main` (diff isolé, non commité)

## 1. Objectif

Créer un module Notebook local : regrouper des sources existantes (neurones, recherches,
documents, contenu synchronisé YouTube/OneDrive) et poser des questions dessus via RAG
local, avec citations réelles, résumé, et retrait/suppression sans jamais affecter les
sources sous-jacentes.

## 2. Audit préalable (recherche, aucune modification avant conception)

Un agent d'exploration a cartographié l'infrastructure existante :
- **LanceDB** : une seule table `neurons`, `searchNeurons()` ne filtre que par `kind`
  (post-filtrage JS), aucun scoping par sous-ensemble d'ids au niveau requête.
- **Embeddings** : `embedText()` générique, `MAX_EMBED_CHARS=7500`, aucun chunking partagé.
- **RAG actuel** (`answerQuestion`) : citations **prose uniquement** (le modèle est instruit
  de citer des titres dans le texte), aucun objet de citation structuré liant une affirmation
  à un chunk précis.
- **Chunking** : `corpus.js` avait sa propre fonction `chunkText()` non partagée.
- **Agrégation de confidentialité** : aucun précédent pour "niveau le plus restrictif d'un
  ensemble de sources" — à construire.
- **Vérification directe** (requête en lecture seule sur la vraie base) : le SDK LanceDB
  installé (`@lancedb/lancedb@0.30`) expose bien `.where(predicate: string)` sur le
  query builder — confirmé fonctionnel par un test de lecture seule contre la vraie base de
  l'utilisateur (`id IN (...)`, résultat correct, aucune écriture).

## 3. Décisions d'architecture

- **Réutilisation de l'index existant** (conforme mission) : un Notebook ne référence que
  des neurones déjà indexés dans LanceDB — jamais de duplication d'embedding. Chunking fait
  à la lecture (pas stocké séparément), le neurone reste l'unique source de vérité.
- **Retrieval scopé** : nouvelles fonctions `searchNeuronsByIds()` / `getNeuronsByIds()`
  (`lib/lancedb.js`) utilisant `.where("id IN (...)")` — retrieval réellement limité aux
  sources du notebook, jamais un scan complet puis filtrage JS (ce qui n'aurait pas tenu à
  l'échelle mentionnée par la mission : "pas de milliers de sources chargées").
- **Chunking partagé** : `chunkText()` extrait de `corpus.js` vers `lib/chunking.js`
  (nouveau module, réutilisé par les deux). `corpus.js` importe désormais depuis ce module
  au lieu de dupliquer — petit refactor de réduction de duplication en marge de la phase.
- **Citations structurées** : le modèle cite `[N]` dans sa réponse ; `extractCitations()`
  n'accepte que les indices `[N]` réellement présents dans le texte ET dans la plage des
  chunks effectivement récupérés — un `[99]` halluciné est silencieusement ignoré, jamais
  fabriqué.
- **Confidentialité dérivée** : `computeNotebookPrivacy(sources)` — OU logique sur
  `privacy`/`egress_policy` de toutes les sources (même schéma que
  `hasPrivateSources = sources.some(...)` déjà utilisé dans server.js), recalculée à chaque
  ajout/retrait de source (`recomputeAndPersistNotebookPrivacy`), jamais réglable
  directement par un client.
- **Q&A strictement local par construction** : `routes/notebook.js` n'importe **aucun**
  module provider cloud — uniquement `lib/ollama.js` (Ollama). Il n'existe donc aucun chemin
  de code vers un appel cloud dans ce fichier, plus strict qu'un simple mode strict_local
  configurable.

## 4. Schéma (additif)

`cortex-server/src/lib/sqlite.js` — 3 nouvelles tables :
- `notebooks` (id, title, description, privacy, egress_policy dérivés, settings, timestamps).
- `notebook_sources` (référence vers un `source_id` neurone — jamais de copie de contenu).
- `notebook_summaries` (cache de résumé hiérarchique, invalidé sur changement de sources).

Aucune table existante modifiée. Index sur `notebook_sources(notebook_id)` et `(source_id)`.

## 5. Backend

- `lib/notebook.js` — cœur logique : agrégation de confidentialité, chunking, retrieval
  scopé, construction de prompt + citations, résumé niveau 1 avec cache.
- `routes/notebook.js` — CRUD Notebook, CRUD sources (ajout par référence, retrait ne
  supprime jamais le neurone), `POST /ask` (Q&A avec citations), `GET /summary`.
- `lib/lancedb.js` — `searchNeuronsByIds()`, `getNeuronsByIds()` (nouvelles, additives).
- `lib/chunking.js` — `chunkText()` extrait de corpus.js.

## 6. Frontend

`src/components/modals/NotebookModal.tsx` (nouveau) — vue 3 colonnes conforme au spec :
- **Gauche** : liste des sources, ajout par recherche de neurones existants, suppression
  (jamais du neurone lui-même).
- **Centre** : chat Q&A, réponse + citations structurées (source, passage cité).
- **Droite** : onglet RÉSUMÉ (résumé global niveau 1) + onglet OUTILS — **déclare
  explicitement et honnêtement** que points clés / FAQ / fiche d'étude / flashcards /
  chronologie / glossaire / comparaison de sources ne sont pas implémentés dans cette phase,
  plutôt que de simuler une fonctionnalité qui ne fonctionnerait pas réellement.

Accessible via un nouveau bouton dans la barre d'outils (`TopBar.tsx`), même emplacement de
pattern que le bouton Professeur.

## 7. Vérification visuelle (Playwright, base isolée)

Notebook créé via l'API sur une base de test isolée (`neurons_count: 0` confirmé avant tout
test — leçon du Phase 4 appliquée). Captures :
1. Liste des Notebooks — carte affichée correctement (titre, nombre de sources, date).
2. Vue détail — layout 3 colonnes conforme, message d'accueil expliquant le principe des
   citations.
3. Panneau d'ajout de source — champ de recherche fonctionnel.
4. Onglet OUTILS — message honnête sur les fonctionnalités non implémentées, visible et lisible.

Le Q&A et le résumé n'ont pas pu être testés visuellement de bout en bout (nécessitent
Ollama, non installé dans cet environnement) — couverts intégralement par les tests
automatisés (section 8) avec un faux client Ollama déterministe.

## 8. Tests

`test-phase5-notebook.mjs` — **17/17 PASS**, utilisant une vraie table LanceDB temporaire
(`data-test-notebook/`) avec des vecteurs factices déterministes (aucune dépendance Ollama,
aucun appel réseau) :
- CRUD Notebook, suppression sans toucher aux neurones sous-jacents.
- Retrait d'une source sans supprimer le neurone.
- Agrégation de confidentialité : neutre, mixte (une source privée bascule tout), retrait de
  la source privée restaure `cloud_allowed`.
- Une source `kind: 'cv'` devient automatiquement privée même sans indication du client.
- Chunking : contenu court = 1 chunk, contenu long = plusieurs chunks à ids stables.
- **Retrieval scopé prouvé réellement isolé** : un neurone hors du notebook, même très
  pertinent sémantiquement, n'apparaît jamais dans les résultats — vérifié avec deux textes
  quasi-identiques, un seul dans le notebook.
- Un notebook vide ne retombe jamais sur l'ensemble complet des neurones.
- Citations : uniquement les `[N]` réellement présents dans la réponse ET dans la plage
  valide ; une référence hors plage est silencieusement ignorée (jamais fabriquée).
- Intégration route complète (`POST /ask`) avec un vrai client Ollama factice.
- Résumé : généré une fois, servi depuis le cache tant que les sources ne changent pas,
  invalidé et régénéré dès qu'une source est ajoutée.
- **Test d'échelle** : 100 sources ajoutées à un notebook, retrieval reste borné par `topK`
  et rapide (< 5s, mesuré ~1.7s réel).

Suite complète cumulée (Phases 0-5) : **170/170 PASS**, 0 régression.

## 9. Typecheck / Build

- `npx tsc --noEmit` → OK.
- `npm run build` → OK.

## 10. Limitations documentées

1. **Scoring au niveau chunk = score du neurone parent**, pas un score par chunk individuel
   (nécessiterait un embedding par chunk, hors budget de cette phase — voir section 13 du
   rapport Phase 3 sur le même arbitrage coût/complexité pour la mémoire adaptative).
2. **Résumé hiérarchique : niveau 1 (global) seulement** — les niveaux 2 (par thème) et 3
   (détail à la demande) mentionnés dans la mission ne sont pas implémentés ; le cache et le
   modèle de données (`notebook_summaries`, colonne `level`) sont prêts à les recevoir.
3. **Outils avancés non implémentés** (points clés, FAQ, fiche d'étude, flashcards,
   chronologie, glossaire, comparaison) — annoncés honnêtement dans l'UI plutôt que simulés.
4. **Ajout de source limité aux neurones existants** via la recherche — pas encore
   d'intégration directe "ajouter depuis YouTube/OneDrive synchronisé" dans l'UI (les
   connecteurs Phase 2 créent déjà des neurones `kind: 'connector'` qui sont trouvables via
   la recherche existante et donc ajoutables au Notebook dès maintenant, juste sans filtre
   dédié "sources connecteur" dans le picker).
5. **Vérification UI du Q&A/résumé non faite en conditions réelles** (Ollama absent de cet
   environnement) — couverte par les tests automatisés avec un faux client déterministe.

## GATE PHASE 5

| Critère | Résultat |
|---|---|
| Retrieval scopé au Notebook uniquement | Conforme, prouvé par test (source hors-scope jamais retournée) |
| Citations jamais inventées | Conforme, testé (indices hors plage ignorés) |
| Suppression source/Notebook ne supprime jamais les données sous-jacentes | Conforme, testé |
| Confidentialité = niveau le plus restrictif des sources | Conforme, testé (bascule + restauration) |
| Réutilisation de l'index existant, pas de duplication d'embedding | Conforme |
| Pas de SELECT * massif / pagination | Conforme (`limit`/`offset` sur les endpoints sources) |
| Q&A jamais cloud | Conforme par construction (aucun import provider cloud dans routes/notebook.js) |
| Tests scale (10/100 sources) | 100 sources testées, < 5s |
| typecheck / build | OK / OK |
| Régression | 0 (170/170 tests) |

**PASS AVEC LIMITATION DOCUMENTÉE** — cœur fonctionnel complet et testé (CRUD, RAG scopé,
citations structurées, confidentialité dérivée, résumé niveau 1, UI 3 colonnes), plusieurs
outils avancés (FAQ, flashcards, etc.) et les niveaux 2/3 de résumé explicitement non
implémentés et annoncés comme tels — aucune fonctionnalité simulée ou trompeuse.

**→ CONTINUE vers PHASE 5B (préparation NotebookLM future, désactivée).**
