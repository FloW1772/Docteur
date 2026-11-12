# 03 — Architecture de l'évolution IA retenue

## Constat central
Le parcours « je conserve une information, je pose plus tard une question, le modèle local répond avec ses sources »
existait **sauf la première étape** : aucun chemin produit ne créait un souvenir utilisable par Companion
(`rememberExplicit()` sans appelant). Option retenue : **E — corriger une intégration existante**, la plus petite tranche
de bout en bout. Rejetées : intégration Notebook (module gelé), graphe (contenu réel déjà branché en
lecture), nouvelle recherche vectorielle (inutile, NB-5 sait déjà retrouver).

## Parcours
```
Companion ▸ « Retenir une information » (catégorie + texte, 8–400 car.)
  → POST /companion/proposals { actionId: COMPANION.MEMORY.REMEMBER, parameters }   (corps borné, JSON strict, champs fermés)
  → registre : action utilisateur seulement (modelProposable: false), LOCAL_MUTATION, POINT_OF_NO_RETURN
  → aperçu complet (rememberCheck : mémoire ON, texte valide, pas de forme de secret)   — aucune écriture
  → défi + geste humain (clavier / clic de confiance) → approbation à usage unique, digest exact
  → exécution : CompanionMemory.rememberExplicit (origine USER_EXPLICIT / USER_INPUT)
        → service NB-5 public (createManual, règles NB-5 dont confirmation des faits sensibles) → overlay Companion
  → résultat réel : « Information retenue » seulement si EXECUTED + MEMORY_REMEMBERED + effet FULL
Question au chat → contexte (NB-5 lexical + overlay + secrets exclus) → modèle local → réponse
  + contextSources = éléments réellement transmis (souvenirs, graphe), extraits bornés, TRANSMITTED / NOT_ASSESSED / authority NONE
```

## Composants
- Réutilisés : cadre d'actions et d'approbation humaine COMP-5/6A, service NB-5, moteur de contexte COMP-3, modèle local
  COMP-4, port de lecture du graphe COMP-7, panneau de revue existant.
- Nouveaux : action `COMPANION.MEMORY.REMEMBER`, type de champ `text` borné, `rememberCheck`, `createEphemeralBinder`,
  `answerContextSources`, `CompanionRememberForm.tsx`, `kg-availability.ts`.
- Aucune nouvelle table, aucune migration, aucune route, aucune dépendance, aucun port, aucun appel réseau.

## Limites
- Recherche NB-5 lexicale : il faut des mots en commun entre la question et le souvenir.
- Chaque question est indépendante (pas d'historique de conversation).
- Les sources sont le contexte transmis, pas des citations vérifiées : le modèle peut ne pas les utiliser.
