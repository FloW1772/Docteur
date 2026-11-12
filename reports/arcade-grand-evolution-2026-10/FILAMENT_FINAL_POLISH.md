# Filament — Finitions finales (24 niveaux sur 24)

Date : 2026-10-24 · Dépôt : `C:\dev\Docteur` · HEAD : `b9eeeb4` (inchangé) · Point de départ : `FILAMENT_24_LEVELS_READY_FOR_USER_MANUAL_QA`

**Contexte.** L'utilisateur a joué les 24 niveaux et les trouve satisfaisants. **Décision : les niveaux, leur difficulté et leurs trajectoires sont figés.** Cette mission ne traite que les deux finitions repérées lors de l'audit statique. Elle n'a lancé aucune simulation.

## 1. Textes corrigés

| Fichier | Avant | Après |
|---|---|---|
| `src/lib/arcade/registry.ts`, description de la carte Filament dans l'Arcade | « Préversion : premier chapitre de huit niveaux (Jardins de l'Aube), souris, tactile et clavier, … » | « 24 niveaux répartis en 4 chapitres (Jardins de l'Aube, Courants d'Altitude, Vergers Stellaires, Lisière du Crépuscule), souris, tactile et clavier, … » |
| `src/lib/arcade/registry.ts`, `controlsHint` de Filament | « … Espace (ou 1 à 8) pour couper, P ou Échap pour la pause … » | « … Espace (ou 1 à 8) pour couper, **F pour le ventilateur (G pour le second quand il y en a deux)**, P ou Échap pour la pause … » |
| `src/content/capabilities.ts`, fiche « Arcade » | « … un premier chapitre de huit niveaux, … » | « … **24 niveaux répartis en 4 chapitres**, … » |

- **Étendue** : seules ces chaînes ont été remplacées, plus une ligne de commentaire dans le registre.
- **Modifications préexistantes** : ces deux fichiers en avaient d'autres, non commitées. Elles sont **intégralement conservées** : la comparaison avec la copie « pre » ne montre que les lignes ci-dessus. Par rapport à HEAD, `registry.ts` passe de +26 à +27 lignes (ce commentaire), et `capabilities.ts` reste à 5 lignes modifiées.
- **Recherche** : il n'y avait aucune autre mention « huit niveaux » ou « premier chapitre » dans `src`, `public`, `scripts` et `cortex-server/src`.
- **Tests** : aucun test ne vérifie ces textes. `test-arcade-unit.mjs` contrôle l'identifiant, le titre, la route, le statut, les capacités et la sauvegarde, qui sont inchangés.
- **Non modifiés, faute de demande** : les champs `availability: 'PLAYABLE_PREVIEW'` et `nextMilestone: 'VALIDATION VISUELLE'` de la carte. Ils pourront être mis à jour dans une mission dédiée si tu le souhaites.

## 2. Commandes clavier du niveau 23

**Problème** : la touche F et le bouton « Ventilateur » commandaient seulement le premier ventilateur du niveau. Au niveau 23, qui en a deux, le ventilateur ascendant n'était accessible qu'à la souris ou au tactile, alors que l'introduction disait « appuyez sur F ».

**Solution minimale appliquée** :

- **`input.ts`** :
  - la commande clavier `FAN` porte maintenant un numéro de ventilateur (`slot`) ;
  - **F** (ou f) vaut `slot 0`, le premier ventilateur, comme avant ;
  - **G** (ou g), une touche jusque-là libre et voisine de F, vaut `slot 1`, le second ventilateur.
  - Aucune collision : Espace, Entrée, X, 1 à 8, Échap, P, R, N et F gardent leur rôle.
- **`main.ts`, touche** : elle bascule le ventilateur `fanSlots[slot]`. Sur tous les niveaux, `fanSlots[0]` est exactement `attempt.firstFan()` : **F se comporte comme avant**. G ne fait rien dans un niveau à un seul ventilateur ou sans ventilateur.
- **`main.ts`, texte d'introduction** (`fanControlsText`) :
  - 0 ventilateur : rien, comme avant ;
  - 1 ventilateur : « Ventilateur : touchez-le, cliquez dessus ou appuyez sur F. », **phrase identique** à l'ancienne (niveaux 13, 14, 19 et 24) ;
  - 2 ventilateurs (niveau 23) : chaque boîtier est désigné par sa position, calculée à partir des données du niveau.
- **Inchangés** :
  - la souris et le tactile (sélection du boîtier par `pickFan`) ;
  - le bouton « Ventilateur » et son libellé, qui commandent toujours le premier ventilateur ;
  - l'ordre des actions, la file des bascules (`requestToggle`) et l'application au tick suivant.

**Comportement final au niveau 23** :

- Texte d'introduction : « … Ventilateurs : touchez ou cliquez sur leur boîtier ; au clavier, F pour le boîtier de droite (comme le bouton Ventilateur), G pour le boîtier de gauche. »
- **F**, ou le bouton : bascule le **vent contraire** (boîtier de droite, au centre de la scène, allumé au départ).
- **G** : bascule le **ventilateur ascendant** (boîtier de gauche, éteint au départ).
- La solution au clavier seul devient possible : F, G, puis Espace et Espace.

**Physique** : aucune force, position, minutage ni comportement de ventilateur n'a changé. La touche ne fait qu'appeler la bascule existante sur un autre indice déjà valide.

## 3. Fichiers modifiés

| Fichier | Avant → après | Nature |
|---|---|---|
| `src/lib/arcade/registry.ts` | `12997cd5` → `6ace2a0a` | 2 chaînes et 1 commentaire |
| `src/content/capabilities.ts` | `19086b6e` → `eb40955c` | 1 chaîne |
| `src/arcade/filament/input.ts` | `2a98d528` → `c6d06981` | touche G, numéro de ventilateur |
| `src/arcade/filament/main.ts` | `741f28fe` → `afd75857` | touche de ventilateur, texte d'introduction, commentaire d'en-tête |
| `scripts/test-filament-game-unit.mjs` | `c8be6003` → `7b717b6e` | 1 assertion pour F et G (**test non exécuté**) |
| ce rapport | nouveau | — |

## 4. Vérifications

| Contrôle | Résultat |
|---|---|
| TypeScript ciblé Filament (strict, racine `main.ts`, qui couvre `input.ts`, les niveaux et le rendu) | **PASS** |
| TypeScript ciblé `registry.ts` et `capabilities.ts` (strict ; aucun des deux n'a d'import) | **PASS** |
| `node --check scripts/test-filament-game-unit.mjs` | PASS |
| `git diff --check` | propre |
| Espaces en fin de ligne dans les fichiers du jeu touchés | 0 |
| Comparaison avec les copies « pre » | uniquement les lignes décrites ci-dessus |

Aucune simulation, aucun navigateur, aucun GPU, aucun benchmark. Docteur n'a pas été lancé.

## 5. Intégrité des 24 niveaux, du moteur et des sauvegardes

Empreintes identiques à celles d'avant la mission :

- **Moteur** : `physics.ts` `733fd835`.
- **Niveaux** : `chapter1.ts` `fe2b5c6e`, `chapter2.ts` `3d3971ab`, `chapter3.ts` `b730adf6`, `chapter4.ts` `8ef63699`, `levels.ts` `d23668ba`.
- **Décors** : `renderer.ts` `39a684c4`.
- **Session** : `session.ts` `fbf9a479`.
- **Sauvegarde** : `progress.ts` `ad6bdbf3`, `host.js` `a5161b4d` ; format `filament-progress-v1` inchangé, IndexedDB non touchée.
- **Page du jeu** : `index.html` `fc0be1e0`.
- **Laboratoire** : lanceur `f0cd7d69` (liste blanche inchangée), bootstrap `633be06b`, lib `d2eeb599`.

Les écrans de fin ne changent pas.

**Autres modules** : Synapse Run (son entrée du registre n'a pas été touchée), Companion, MAÎTRE, Root Policy, Notebook, Knowledge Graph, Docteur Memory, le launcher principal et le PDF privé sont préservés.

**Copies et Git** :

- `.tmp/filament-final-polish-backup-2026-10-24/{pre,post}/`, les copies antérieures étant conservées ;
- 33 fichiers suivis modifiés, préexistants ; 0 indexé, 0 commit, 0 push.

## 6. À vérifier à la main (rapide)

1. **Niveau 23 au clavier** : F bascule le boîtier de droite, G celui de gauche, et le texte d'introduction les désigne correctement.
2. **Niveaux 13, 14, 19 et 24** : F agit comme avant, et G ne fait rien.
3. **Carte Filament dans l'Arcade** et page des fonctionnalités : le nouveau texte « 24 niveaux répartis en 4 chapitres » s'affiche.

`game.js` est construit à partir de `src/arcade/filament/` par le module Vite de l'Arcade. Si Docteur était ouvert pendant la modification, recharge Filament, ou relance Docteur normalement, pour charger les changements.

## 7. Prochaine grande mission proposée (non commencée)

**Synapse Run — évolution visuelle**, dans une mission distincte :

- **Objectif** : cinq univers graphiques ; de meilleurs décors ; des animations légères et bornées, avec le mouvement réduit respecté ; une progression visuelle cohérente d'un univers à l'autre.
- **Gameplay** : couloirs, sauts, glissades, missions et sauvegarde **strictement préservés**.
- **Méthode suggérée** :
  1. audit du rendu actuel ;
  2. direction artistique des cinq univers ;
  3. intégration progressive, un univers à la fois ;
  4. contrôles statiques, puis vérification manuelle par l'utilisateur ;
  5. sans GPU forcé ni navigateur automatisé, sauf autorisation explicite.

Rien n'a été modifié dans Synapse Run pendant cette mission.

**Checkpoint : `DOCTEUR_FILAMENT_FINAL_POLISH_CHECKPOINT`**
