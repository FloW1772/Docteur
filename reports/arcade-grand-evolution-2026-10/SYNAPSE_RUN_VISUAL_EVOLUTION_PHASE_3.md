# Synapse Run — Évolution visuelle — Phase 3 (univers 3 « Forêt synaptique »)

**Date** : 2026-10-24 · **Référence** : `DOCTEUR_SYNAPSE_RUN_VISUAL_EVOLUTION_PHASE_2_CHECKPOINT` · **Dépôt** :
`C:\dev\Docteur` (HEAD `b9eeeb4`, inchangé)

**Verdict** : `SYNAPSE_RUN_WORLD_3_READY_FOR_MANUAL_REVIEW`. Le code est en place et les contrôles statiques passent.
**Le rendu de la forêt n'a été vu par personne.**

## 1. Confirmation utilisateur

- Univers 1 « Aube numérique » : validé (« L'univers 1 me plaît et je le valide »).
- Univers 2 « Cité des impulsions » : validé (« Je confirme avoir testé et validé l'univers 2 »).

## 2. Architecture réutilisée

Aucun nouveau système. Les fondations des phases 1 et 2 sont reprises telles quelles :

- **`world-kit.ts`, inchangé** : la boîte unité ombrée et les deux matériaux partagés, la cuisson du brouillard, les
  bandes de ciel et de sol, `paint`, `gradient`, `hash`.
- **`worlds.ts`** : le directeur garde au plus un univers vivant ; l'univers sortant fond sur la première moitié du
  fondu de 90 m et est libéré au milieu, l'entrant émerge sur la seconde moitié. **Son cycle de vie n'a pas changé** :
  seule une ligne a été ajoutée dans la table section → univers.
- **`world-dawn.ts`, `world-city.ts`, `renderer.ts` et `main.ts` sont identiques** aux versions validées en phase 2.
- Mêmes conventions dans `world-forest.ts` : pièces ancrées dans le monde, révélation à au moins 92 m, ciel couleur
  brume au-dessus de tout sommet, couleurs fixes, mouvement réduit.
- **Seule extension locale** : les branches, les racines et les cristaux sont des instances **tournées** de la boîte
  du kit. Le placement du kit ne gère que position et échelle, et le modifier aurait touché un fichier validé. La forêt
  a donc son propre petit placement, avec rotation.

## 3. Fichiers

| Fichier | Statut | Changement |
|---|---|---|
| `src/arcade/synapse-run/world-forest.ts` | **créé** (231 lignes) | univers 3 |
| `src/arcade/synapse-run/worlds.ts` | modifié | +1 import, +1 ligne dans la table (section 3 → forêt), 2 lignes de commentaire |
| `public/arcade/synapse-run/foundation.css` | modifié | +5 lignes : HUD, pied de page, libellé et menus de la section 3 |
| `world-kit.ts`, `world-dawn.ts`, `world-city.ts`, `renderer.ts`, `main.ts` | **inchangés** depuis la validation de la phase 2 | — |

**Copies** : `.tmp/synapse-run-visual-phase3-backup-2026-10-24/`. Les copies des phases 1 et 2 sont conservées.

- `pre/` : toutes les sources de Synapse Run et `foundation.css` avant la phase 3 ;
- `post/` : les 3 fichiers touchés ;
- `equiv/` : le directeur de la phase 2 validé et ses dépendances, pour la comparaison ;
- `pre-hashes.txt`, `pre-filament-hashes.txt`, `worlds-check-phase3.mjs`.

## 4. Bornes de section, vérifiées dans le code

`sections.ts`, lu seulement :
- section 3 « Synaptic Garden » de **1200 m** à **2200 m**, début de « Core Transit » ;
- fondu de couleur de **90 m** au début de chaque section (`renderer.ts`, `(z − start) / 90`).

Aucune distance ni règle de progression n'a été modifiée.

## 5. Direction artistique — Forêt synaptique

**Fond** (un mesh fusionné de 1040 sommets, qui suit la caméra, brouillard précalculé) :
- **brume turquoise** `#07232a` jusqu'à 18,5 m, puis l'**horizon vert émeraude** (`#1f7a5c` au plus fort), puis un
  **bleu nuit teinté de vert** jusqu'à `#040c1c` au zénith ;
- un **réseau neuronal discret** dans le ciel : 18 nœuds reliés par des traits fins, uniquement au-dessus de la
  brume ;
- des **canopées lointaines** (dômes dans la brume) et, de temps en temps, un **arbre géant** dont la couronne dépasse
  dans la lueur, avec quelques points lumineux verts ;
- un **sol sombre** `#041416`, le lit de piste, et des **lignes d'énergie** vertes (±7 m) et turquoise (±11,5 m).

**Forêt** (un InstancedMesh de 308 instances de la boîte du kit) :
- **24 arbres neuronaux**, entre 22 et 32 m de l'axe, tous les ~14 m. Chacun a :
  - un **tronc sombre** de 9 à 14 m ;
  - une **arête turquoise** tournée vers la piste ;
  - **trois branches géométriques** inclinées : deux vers l'extérieur, une courte vers la piste, toujours à plus de
    4 m de haut et à plus de 20 m de l'axe ;
  - **trois petites lumières** au bout des branches, turquoise ou vertes selon l'arbre, comme des synapses ;
  - **deux racines lumineuses** à plat sur le sol (une vers la piste et le joueur, une vers l'extérieur), qui restent
    à plus de 15 m de l'axe ;
- **16 cristaux** émeraude inclinés, au sol, entre 7,7 et 11,3 m de l'axe ;
- **24 motifs numériques** discrets : des carreaux ou losanges à plat sur le sol ;
- **16 traînées de vitesse** vert-turquoise, au-delà des rails ;
- **12 impulsions** turquoise, **lentes** (14 m/s par rapport au joueur, contre 16 pour l'aube et 22 pour la cité),
  le long des lignes d'énergie. C'est la forêt « vivante ».

**Couloirs** : `#091719` et `#0c1e21`, couloir actif `#133033`. **Interface** en section 3 : HUD, pied de page et
cadre des menus en sarcelle profonde, libellé de zone turquoise-vert `#8ff5d2` (contraste ≈ 14,3:1).

**Continuité** : le décor d'origine de la section 3, en particulier ses branches et ses vrilles vertes près de la
piste et ses arches, reste présent. La forêt s'y ajoute.

## 6. Transitions

| Distance | Ce qui se passe |
|---|---|
| 0–1200 m | **Identique à la version validée** : aube, transition 1 → 2 à 545 m, cité (voir § 9) |
| 1200–1245 m | La cité fond dans la couleur de zone. Ses tours, néons et reflets se sont arrêtés avant 1200 m ; ses impulsions rétrécissent. |
| 1245 m (milieu) | La cité, entièrement fondue, est retirée et libérée ; la forêt est créée, entièrement fondue, à l'image suivante. Les deux sont exactement la couleur de zone, qui est aussi le fond et le brouillard : **pas de noir, pas de trou, pas de saut de couleur**. |
| 1245–1290 m | La forêt émerge de la brume. Ses arbres n'apparaissent qu'à partir de ~1337 m (création + 92 m, brouillard total), puis ils approchent. **Aucun arbre ne surgit sur la route** : rien n'est jamais placé à moins de 4 m de l'axe. |
| 1200–1290 m | En continu : couleur de zone (violet de la cité → brume turquoise) et couleurs des couloirs (violets → sarcelles), fondues sur les 90 m complets. |
| 2200–2290 m | **Sortie vers la section 4** : il n'y a pas d'univers 4, donc la forêt fond seule, sur les 90 m complets, vers les couleurs d'origine de « Core Transit » (comme la cité le faisait en phase 2). Tous ses éléments ancrés s'arrêtent avant 2200 m (point le plus loin relevé : 2199,68 m). À 2290 m, elle est libérée. |
| ≥ 2290 m | Sections 4 et 5 : apparence d'origine, aucun univers, aucun appel de dessin ajouté. |

Écart maximal mesuré par le contrôle Node entre chaque fond et la couleur de zone, aux images de passation (sur 1, en
couleur linéaire) :

| Image | Écart |
|---|---|
| dernière image de l'aube (544,75 m) | 0,0055 |
| première image de la cité | 0,0054 |
| dernière image de la cité (1244,75 m) | 0,0054 |
| première image de la forêt | 0,0055 |
| dernière image de la forêt (2289,75 m) | 0,0028 |

C'est imperceptible à l'œil.

**Seul effet de la phase 3 sur la cité validée** : sur 1200–1290 m, elle s'efface en 45 m (au lieu de 90) pour céder
la place à la forêt, et la couleur de zone et celle des couloirs vont désormais vers la forêt plutôt que vers
l'apparence d'origine de la section 3. Son code n'a pas changé : c'est le directeur qui applique la règle de passation
déjà validée entre l'aube et la cité.

## 7. Gestion des ressources

Ce sont des **estimations statiques, non des mesures GPU**. Le seul chiffre mesuré est la base GAME-7 : 22
géométries, 2 programmes, 47–52 appels de dessin.

| | Plafond | Aube | Cité | Forêt | Passations (545, 1245 m) | Sections 4–5 |
|---|---|---|---|---|---|---|
| Géométries | ≤ 24 | 24 | 24 | 24 | 23 sur une image, puis 24 | 23 |
| Programmes | ≤ 4 | 4 | 4 | 4 | 4 | 4 |
| Appels de dessin ajoutés | — | +2 | +2 | +2 | +2 (jamais +4) | +0 |

- **Géométries** : la base (22), la boîte du kit (1) et le fond de l'univers vivant (1). La forêt n'ajoute **aucune
  géométrie** : ses arbres, branches, racines et cristaux sont tous des instances de la boîte partagée.
- **Programmes** : la forêt utilise les deux mêmes instances de matériaux, donc **0 programme nouveau**.
- **Un seul univers à la fois** : contrôlé à chaque pas de 0,25 m sur 0–2400 m. Il n'y a jamais eu plus d'un fond, ni
  plus d'une géométrie propre vivante.
- **Libération** : chaque univers retiré libère son fond et ses tampons d'instances, jamais la boîte ni les matériaux
  du kit. Après la libération du renderer, toutes les géométries sont libérées, boîte comprise.
- **Envois GPU par image** : quand seules les impulsions bougent, la forêt n'envoie que leur tranche de la matrice
  d'instances (12 × 64 octets, via `addUpdateRange`). Le contrôle l'a vérifié : début 4736, longueur 192 flottants.
  Les 308 instances ne sont renvoyées qu'aux changements de rangée (tous les 7 à 18 m). Coût : un petit objet
  `{start, count}` par image.
- Arbres jamais reconstruits par image : placements seulement aux changements de rangée, couleurs de sommets
  seulement pendant les fondus.

## 8. Lisibilité et gameplay

- **Rien dans la zone de jeu** : boîtes englobantes **exactes**, calculées sur les 8 coins de chaque instance tournée.
  Plus petite distance à l'axe d'une pièce au-dessus du sol : 4,035 m pour la forêt (traînées), 4,045 m pour la cité,
  4,039 m pour l'aube. Les rails s'arrêtent à 3,54 m. Branches, racines et arbres sont tous à plus de 15 m.
- **Aucune fausse collision visuelle** : rien au-dessus des couloirs ; les branches tournées vers la piste restent à
  plus de 20 m de l'axe et à plus de 4 m de haut.
- **Pas de confusion avec les objets de jeu** :
  - pas de rose (bloc) ni d'ambre (portique) ;
  - les lumières des branches sont turquoise et vertes, à plus de 4 m de haut et à plus de 20 m de l'axe, loin des
    éclats (cyan clair, octaèdres, dans les couloirs à moins de 1,2 m) ;
  - les cristaux sont émeraude, au sol, à plus de 7,7 m ;
  - les impulsions sont à plat sur le sol.
- **Pas d'apparition brutale** : sommet de la forêt mesuré à 14,14 m, sous la ligne de brume de 18,5 m ; tous les
  éléments brillants du ciel sont au-dessus de cette ligne.
- **Aucun clignotement ni stroboscope**, pas de pluie de particules : couleurs fixes, une seule animation (les
  impulsions), en déplacement continu.
- **Contraste** (luminance WCAG sur les couleurs de base, hors éclairage, donc approximatif). Valeurs sur couloir
  latéral / central / actif :

  | Élément | Original | Aube | Cité | Forêt |
  |---|---|---|---|---|
  | Bloc rose | 5,79 / 5,35 / 4,45 | 5,12 / 4,54 / 3,68 | 6,00 / 5,61 / 4,62 | **6,01 / 5,64 / 4,60** |
  | Portique ambre | 10,0 / 9,3 / 7,7 | 8,9 / 7,9 / 6,4 | 10,4 / 9,7 / 8,0 | **10,4 / 9,8 / 8,0** |
  | Éclat | 14,4 / 13,3 / 11,0 | 12,7 / 11,3 / 9,1 | 14,9 / 13,9 / 11,4 | **14,9 / 14,0 / 11,4** |
  | Construct | 12,0 / 11,1 / 9,3 | 10,6 / 9,5 / 7,7 | 12,5 / 11,7 / 9,6 | **12,5 / 11,7 / 9,6** |
  | Couloir actif / central | 1,20 | 1,24 | 1,22 | **1,22** |

  Une première palette de couloirs sarcelle, plus claire (bloc sur couloir actif 4,25), a été écartée au profit de
  sarcelles plus sombres.
- **Mouvement réduit** : plus de traînées ni d'impulsions ; arbres, racines, cristaux, motifs, ciel et couleurs
  restent. **Rendu logiciel** : pas d'impulsions.
- **Gameplay** : hitboxes, physique, vitesses, commandes, génération, missions, scores et sauvegardes sont dans des
  fichiers identiques octet par octet (§ 10).

## 9. Univers validés préservés : contrôle déterministe

Le contrôle Node fait tourner **côte à côte** le directeur exact de la phase 2 validée (copie `equiv/`) et le
directeur actuel. Il compare, à chaque pas de 0,5 m sur 0–1200 m (2400 pas, trois variantes : normal, mouvement réduit,
rendu logiciel) :
- la couleur de zone et les palettes de couloirs ;
- le nombre de meshes et leur visibilité ;
- positions et couleurs des fonds ;
- matrices et couleurs d'instances.

**Tout est identique, valeur par valeur** : formes, couleurs, animations, transition 1 → 2 et ressources des univers 1
et 2 sont préservées. De plus, `world-dawn.ts`, `world-city.ts` et `world-kit.ts` sont identiques octet par octet
aux copies validées.

## 10. Contrôles réellement exécutés

| Contrôle | Résultat |
|---|---|
| TypeScript ciblé (options de `tsconfig.json`, sur `main.ts`, `worlds.ts`, `world-kit.ts`, `world-dawn.ts`, `world-city.ts`, `world-forest.ts`) | **PASS** (deux exécutions, la dernière après la dernière modification) |
| Imports et syntaxe (couverts par TypeScript ; analyse effective du module par Node) | **PASS** |
| `git diff --check` ; espaces en fin de ligne et tabulations dans les nouveaux fichiers | **PASS** |
| `worlds-check-phase3.mjs`, script Node déterministe (un processus, quelques secondes, sans WebGL, navigateur ni GPU) | **PASS** : préservation 0–1200 m ; cycle de vie 0 → 2400 m ; au plus 1 fond et 1 géométrie propre ; continuité aux 3 passations et à la sortie ; volume de jeu (boîtes exactes) ; hauteurs sous la brume ; forêt avant 2200 m ; révélation ; envoi partiel des impulsions ; retour à l'aube ; libération complète |
| SHA-256 des 13 fichiers protégés de Synapse Run, par rapport à l'avant-phase 1 | **13/13 identiques** |
| SHA-256 des 15 fichiers Filament (par rapport à l'avant-phase 1 et à l'avant-phase 3) | **15/15 identiques** |
| Différences par rapport à la phase 2 validée | uniquement `worlds.ts` (import + 1 ligne de table) et `foundation.css` (+5 lignes) |
| Recherche d'API interdites dans `world-forest.ts` et `worlds.ts` | aucune |
| Contrastes des couleurs de base | calculés (§ 8) |
| Fichiers indexés | 0 |

En cours de route, le premier passage du contrôle a échoué à cause d'un défaut **du script** : il comptait les
instances masquées, placées à y = −0,3 avec une échelle nulle. Ce défaut a été corrigé (détection par échelle nulle),
puis le contrôle a été relancé. Le même script a aussi révélé qu'une traînée de la forêt pouvait déborder de 1,5 m
au-delà de 2200 m : son placement teste maintenant ses deux extrémités.

**Non exécutés** : les suites navigateur (interdites), les suites unitaires de Synapse Run (leurs fichiers sont
inchangés) et `vite build`. **Aucune mesure de fluidité ni de FPS.** Compteurs : navigateur automatisé **0** ·
tests GPU **0** · simulation Filament **0** · test visuel **non réalisé**.

## 11. Intégrité

- **Sauvegardes, missions et scores** : `progression.ts` et `foundation.js` sont identiques. Aucune donnée utilisateur
  n'a été lue ou écrite, et il n'y a ni migration ni nouveau champ.
- **Gameplay** : `simulation.ts`, `sections.ts`, `loop.ts`, `input.ts`, `gestures.ts`, `pause.ts`, `camera.ts`,
  `autopilot.ts`, `feedback.ts` et `audio.ts` sont identiques.
- **Filament** : 15/15 identiques.
- **Autres modules** non touchés : Companion, MAÎTRE, Root Policy, Knowledge Graph, Notebook, Docteur Memory, launcher,
  PDF privé, hooks, rapports et copies existants. Il n'y a pas de dossier DevLab dans le dépôt. Docteur n'a pas été
  lancé et aucun processus n'a été arrêté.
- **Git** : 0 indexé, 0 commit, 0 push. Aucune commande `add`, `commit`, `push`, `reset`, `restore`, `clean`, `merge`
  ou `rebase`.

## 12. Risques restant à vérifier

1. **Équilibre des couleurs** : brume turquoise, lueur émeraude, intensité des branches et des lumières. Ce sont des
   constantes de `FOREST` dans `world-forest.ts`.
2. **Début de la section 3 dépouillé** : les arbres arrivent à partir de ~1337 m, pour la même raison qu'en
   section 2.
3. **Superposition avec le décor d'origine** : les branches et vrilles vertes d'origine, près de la piste, coexistent
   avec la forêt. C'est voulu (continuité), mais l'ensemble peut paraître chargé.
4. **Création à 1245 m** : le fond de 1040 sommets est construit en une fois en pleine course. C'est bref, mais non
   mesuré.
5. **Sortie vers la section 4** : le passage du turquoise au bordeaux d'origine de « Core Transit » est un vrai
   contraste de couleurs, fondu sur 90 m.
6. **Rendu logiciel et écrans extrêmes** : non vus.

## 13. À tester manuellement

1. **0–1200 m** : aube, transition à 545 m et cité, comme validés.
2. **1200–1290 m** : la ville violette s'efface, puis la forêt turquoise émerge ; vérifier qu'il n'y a ni noir, ni trou,
   ni saut de couleur, et que les couloirs passent progressivement du violet à la sarcelle.
3. **Section 3** : arbres neuronaux (troncs, arêtes, branches, lumières), racines, cristaux, motifs au sol, réseau dans
   le ciel, canopées, arbres géants, impulsions lentes, HUD turquoise.
4. **Lisibilité** : blocs roses, portiques, éclats et construct bien reconnaissables ; aucune branche ni racine prise
   pour un obstacle ou un éclat.
5. **Au loin** : aucun arbre ne surgit d'un coup.
6. **Fluidité**, notamment autour de 1245 m.
7. **2200–2290 m** : la forêt fond vers l'apparence d'origine de la section 4, sans élément forestier persistant.
8. **Missions, scores et « Rejouer »** : normaux ; retour de l'aube.
9. **Mouvement réduit** : plus de traînées ni d'impulsions, le reste demeure.
