# MASTER PHASE 3 — Mémoire adaptative locale

Date: 2026-09-15
Branche: `main` (diff isolé, non commité)

## 1. Objectif

Faire apprendre progressivement Docteur des recherches, neurones et corrections de
l'utilisateur, sans jamais entraîner les poids du LLM, avec un budget de contexte borné et
une propagation stricte de `local_only`.

## 2. Fondations existantes réutilisées (pas de doublon créé)

- **Mémoire de session** : tables `conversations`/`conversation_messages` déjà existantes
  (chat.js), utilisées telles quelles (derniers 20 messages injectés).
- **Profil long-terme** : table `preference_facts` déjà existante (entrée manuelle via
  `/chat/preferences`) — **étendue de façon additive** avec les colonnes metadata
  (`source`, `source_ref`, `privacy`, `egress_policy`, `importance`, `confidence`,
  `usage_count`, `last_used_at`). Les faits déjà enregistrés avant cette phase conservent un
  comportement inchangé (`source='manual'`, `egress_policy='cloud_allowed'`).
- **Suggestion de mémoire existante** (`[[MEMOIRE: ...]]` dans les réponses du modèle de
  chat, confirmation utilisateur explicite avant écriture) — inchangée, toujours via
  `POST /chat/preferences`.

## 3. Nouveau : mémoire épisodique (niveau intermédiaire)

Nouvelle table `episodic_memories` (additive), avec les mêmes métadonnées que le profil
long-terme, plus une politique d'éviction (mémoire la moins importante/utilisée supprimée si
la limite de 2000 entrées est atteinte — dédup empêche normalement d'approcher ce plafond).

## 4. Extraction — 100% locale, jamais cloud

`cortex-server/src/lib/memory.js` :
- `isWorthRemembering(text, { kind })` — règles déterministes (regex FR : préférences,
  corrections, "appelle-moi", "réponds en langue X"). Aucun appel réseau.
- `extractWithOllama(localComplete, text)` — extraction assistée par un LLM **local**
  uniquement ; la fonction ne connaît aucun provider, elle reçoit une fonction de complétion
  fournie par l'appelant (découplage total du cloud, testé explicitement : `null` sur tout
  échec, jamais de throw qui casserait le flux appelant).
- Aucun code de ce fichier n'importe `fetch` ni aucun SDK cloud — vérifié par lecture
  complète du fichier.

### Points d'apprentissage câblés
| Source | Fichier | Garde | Portée |
|---|---|---|---|
| Recherches | `routes/search.js` | `learn_from_searches` + `enabled` | Uniquement requêtes jugées "worth remembering" (règles) |
| Corrections en chat | `routes/chat.js` | `learn_from_corrections` + `enabled` | Message utilisateur suivant une réponse, pattern de correction |
| Neurones créés manuellement | `server.js` `indexNeuron()` | `learn_from_neurons` + `enabled` | Titre du neurone uniquement ; **exclut** les imports en masse (`kind` corpus/connector) pour ne pas noyer la mémoire lors d'un sync Phase 2 ou d'un import corpus |

Chaque hook est enveloppé en `try/catch` best-effort : un échec d'extraction ne casse jamais
la réponse de recherche/chat/indexation.

## 5. Déduplication

`jaccardSimilarity()` (intersection de mots normalisés, sans appel embedding) +
`findDuplicate()` + `addEpisodicMemoryDeduped()` : un texte à ≥72% de similarité avec une
mémoire existante bascule en `touchEpisodicMemory()` (bump usage) au lieu de créer une
nouvelle ligne. Testé à l'échelle (100 écritures quasi-identiques → 1 seule mémoire,
`usage_count = 99`).

Les contradictions (ex. "j'aime le café" puis "je déteste le café") ne sont **pas**
fusionnées — fusionner des significations opposées détruirait silencieusement de
l'information. La résolution se fait au moment de la sélection : le score intègre la
récence, donc l'énoncé le plus récent l'emporte naturellement sans supprimer l'ancien.

## 6. Budget de contexte — jamais toute la mémoire injectée

`selectMemoriesForBudget({ query, budget })` fusionne profil long-terme + épisodique, note
chaque candidat (pertinence mot-clé 40% + importance 30% + récence 20% + fréquence 10%), et
tronque au budget configuré :
- Faible : 3 mémoires / 3 extraits
- Normal (défaut) : 5 mémoires / 5 extraits
- Étendu : 8 mémoires / 8 extraits

`routes/chat.js` utilise désormais cette sélection bornée au lieu d'injecter
`listPreferenceFacts()` en entier dans le prompt système (comportement précédent), sauf si
la mémoire adaptative est désactivée (`enabled: false`), auquel cas le comportement
pré-Phase-3 (tous les faits) est conservé à l'identique pour ne rien casser.

## 7. Propagation privacy / egress

`privacyFromSource({ kind, isPrivatePage, connectorSource })` reproduit exactement la règle
déjà utilisée par `server.js` pour les neurones (kinds `cv`/`candidature` toujours privés,
page `private: true`, source connecteur `*_private` du Phase 2) — une mémoire extraite d'une
de ces sources est marquée `privacy: true`, `egress_policy: 'local_only'`, et le reste tout
au long de sa vie (aucune fonction de ce module ne peut abaisser ce niveau). Le mécanisme de
blocage réel au moment de l'appel cloud est celui déjà certifié en Phase 1
(`markPrivate()`/`guardCloudCall()`) — cette phase garantit uniquement que la métadonnée
`privacy`/`egress_policy` survit intacte jusqu'à la sélection, précondition dont ce
mécanisme dépend.

## 8. UI — Paramètres → Mémoire

Nouvel onglet **MÉMOIRE** dans `SettingsModal.tsx` (`MemorySettingsTab.tsx`) :
- Interrupteur général "Apprentissage contextuel local" + 3 sous-interrupteurs
  (recherches/neurones/corrections).
- Sélecteur de budget (Faible/Normal/Étendu) avec affichage en direct des limites
  effectives.
- "Voir la mémoire" — liste les deux niveaux (long-terme + épisodique) avec catégorie,
  source, compteur d'usage, indicateur 🔒 pour le contenu privé, et politique d'egress.
  Suppression individuelle par élément.
- "Réinitialiser mémoire adaptative" (confirmation à deux clics) — efface uniquement le
  niveau épisodique ; les faits manuels du profil long-terme (saisis explicitement par
  l'utilisateur) ne sont **jamais** touchés par ce reset, conformément à la distinction
  "appris automatiquement" vs "déclaré explicitement".

**Vérifié visuellement** (Playwright, captures d'écran) : l'onglet s'affiche correctement,
tous les interrupteurs et boutons répondent, le changement de budget se répercute
immédiatement dans le texte "Actuel : jusqu'à N mémoires" (bug de fraîcheur détecté et
corrigé pendant la vérification — `items.budget` n'était pas rafraîchi après un changement
de budget), et les réglages persistent après rechargement de page (vérifié contre le vrai
serveur backend).

## 9. Tests

`test-phase3-adaptive-memory.mjs` — **25/25 PASS** :
- Réglages (defaults, PUT avec validation de budget invalide → repli sur "normal").
- Extraction par règles (formes contractées "j'aime"/"je aime", patterns de correction
  distincts).
- `extractWithOllama` — ne lève jamais, découplage cloud vérifié.
- Dédup (Jaccard, fusion, non-fusion des contradictions).
- Propagation privacy (cv/candidature/connecteurs *_private/page privée → local_only).
- Budget (jamais dépassé, pertinence de requête priorisée, fusion des deux niveaux par
  score et non "N de chaque").
- Endpoints (`GET/PUT /api/memory/settings`, `GET /api/memory/items`,
  `GET /api/memory/preview`, `DELETE /api/memory/items/:tier/:id`, `POST /api/memory/reset`
  — confirmé : reset épisodique seul, faits manuels préservés).
- **Tests d'échelle** : 1000 mémoires distinctes (sélection < 2s), 100 écritures
  quasi-identiques → dédup à 1, contradictions dans le temps → la plus récente reste
  sélectionnable.
- **Tests d'intégration** : `POST /api/search` déclenche réellement l'apprentissage (ou pas,
  selon les toggles), pas seulement au niveau unitaire de `lib/memory.js`.

Suite complète cumulée (Phases 0-3) : **147/147 PASS**, 0 régression.

## 10. Typecheck / Build / Vérification visuelle

- `npx tsc --noEmit` → OK.
- `npm run build` → OK.
- Serveur réel démarré, `/api/memory/settings` et `/api/memory/items` testés contre la vraie
  base (6726 neurones existants, aucun touché) → réponses correctes, valeurs par défaut
  saines.
- UI testée en conditions réelles via Playwright (capture d'écran, clics réels sur
  interrupteurs/boutons/budget) — voir section 8.

## 11. Limitations documentées

1. **Pas de retrieval sémantique (embedding) pour les mémoires** — le scoring de pertinence
   utilise une correspondance mot-clé normalisée, pas un vecteur LanceDB. Choix délibéré
   (éviter un appel embedding coûteux à chaque écriture/lecture de mémoire, garder cette
   phase isolée) ; à réévaluer en Phase 9 (audit) si le scoring mot-clé se révèle
   insuffisant à plus grande échelle réelle.
2. **"Apprendre de mes neurones" scope réduit au titre seul**, et exclut les imports en
   masse (corpus, connecteurs Phase 2) — sinon une seule synchronisation OneDrive de 50
   fichiers géninerait 50 mémoires non pertinentes. Un import manuel unitaire (création
   normale d'un neurone) reste couvert.
3. **`extractWithOllama` n'est câblé nulle part encore** — la fonction existe, testée
   isolément, mais aucune route n'appelle encore l'extraction assistée par LLM local (seule
   l'extraction par règles est active). Les hooks actuels (recherches/corrections/neurones)
   utilisent uniquement `isWorthRemembering()`. Câblage de l'extraction Ollama laissé pour un
   futur incrément si les règles s'avèrent insuffisantes en usage réel.

## GATE PHASE 3

| Critère | Résultat |
|---|---|
| 3 niveaux (session/épisodique/long-terme) | Conforme |
| Extraction 100% locale, jamais cloud | Conforme (vérifié par lecture de code + tests) |
| Métadonnées complètes | Conforme (importance/confidence/recency/frequency/source/privacy/egress_policy/usage_count/last_used) |
| Budget de contexte jamais dépassé | Conforme, testé à l'échelle |
| Dédup | Conforme, testée (100→1) |
| UI complète (toggles, budget, voir/supprimer/réinitialiser) | Conforme, vérifiée visuellement |
| Propagation local_only | Conforme — réutilise le mécanisme certifié Phase 1 |
| Tests scale (100 recherches, 1000 mémoires, répétitif, contradictions) | PASS |
| local_only → cloud | 0 |
| typecheck / build | OK / OK |
| Régression | 0 (147/147 tests) |

**PASS**

**→ CONTINUE vers PHASE 4 (Free AI Finder / FreeLLMAPI / réorganisation APIs Image).**
