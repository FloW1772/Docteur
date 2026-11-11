# Synapse Run — Évolution visuelle — Phase 4 (univers 4 « Horizon fracturé »)

**Date** : 2026-10-24 · **Référence** : `DOCTEUR_SYNAPSE_RUN_VISUAL_EVOLUTION_PHASE_3_CHECKPOINT` · **Dépôt** :
`C:\dev\Docteur` (HEAD `b9eeeb4`, inchangé)

**Verdict** : `SYNAPSE_RUN_WORLD_4_READY_FOR_MANUAL_REVIEW`. Le code est en place et les contrôles statiques passent.
**Le rendu de l'univers 4 n'a été vu par personne.**

## 1. Validation des univers précédents

Univers 1 « Aube numérique », univers 2 « Cité des impulsions » et univers 3 « Forêt synaptique » : **validés par
l'utilisateur**. Pour l'univers 3 : « Je confirme avoir testé et validé l'univers 3 « Forêt synaptique » dans Docteur.
Il me convient. »

## 2. Architecture réutilisée

Aucun nouveau système, moteur ni dépendance :

- **`world-kit.ts`, inchangé** : la boîte unité ombrée et les deux matériaux partagés, la cuisson du brouillard, les
  bandes de ciel et de sol.
- **`worlds.ts`** : même directeur, même cycle de vie (au plus un univers vivant, passation au milieu du fondu de
  90 m, libération). **Une seule ligne ajoutée** dans la table section → univers.
- **Conventions de la forêt** reprises dans `world-horizon.ts` :
  - placement local avec rotation (le kit reste inchangé) ;
  - révélation à au moins 92 m ;
  - ciel couleur brume au-dessus de tout sommet ;
  - envoi partiel des impulsions ;
  - mouvement réduit.
- `world-dawn.ts`, `world-city.ts`, `world-forest.ts`, `renderer.ts` et `main.ts` sont **identiques** aux versions
  validées.

## 3. Fichiers

| Fichier | Statut | Changement |
|---|---|---|
| `src/arcade/synapse-run/world-horizon.ts` | **créé** (239 lignes) | univers 4 |
| `src/arcade/synapse-run/worlds.ts` | modifié | +1 import, +1 ligne dans la table (section 4 → horizon), 2 lignes de commentaire |
| `public/arcade/synapse-run/foundation.css` | modifié | +5 lignes : HUD, pied de page, libellé et menus de la section 4 |
| `world-kit.ts`, `world-dawn.ts`, `world-city.ts`, `world-forest.ts`, `renderer.ts`, `main.ts` | **inchangés** | — |

**Copies** : `.tmp/synapse-run-visual-phase4-backup-2026-10-24/`. Les copies des phases 1 à 3 sont conservées.

- `pre/` : toutes les sources de Synapse Run et `foundation.css` avant la phase 4 ;
- `equiv/` : le système de mondes de la phase 3 validée et ses dépendances ;
- `post/` : les 3 fichiers touchés ;
- `pre-hashes.txt`, `pre-filament-hashes.txt`, `worlds-check-phase4.mjs`.

## 4. Bornes exactes, vérifiées dans le code

`sections.ts`, lu seulement :
- **section 4 « Core Transit »** : de **2200 m** à **3500 m** ;
- **section 5 « Overdrive »** : à partir de **3500 m**, sans fin ;
- fondu de couleur de **90 m** au début de chaque section.

Aucune frontière ni règle de progression n'a été modifiée.

## 5. Direction artistique — Horizon fracturé

Un monde numérique qui se fragmente au coucher du soleil. L'histoire est en miroir de l'aube : le soleil se levait à
droite au début de la course, il se couche à gauche ici.

**Fond** (un mesh fusionné de 680 sommets, qui suit la caméra, brouillard précalculé) :
- **brume légèrement rosée** `#2a1226` jusqu'à 21 m ; au-dessus, du **bordeaux** à un **dégradé orange** (`#e88a48`
  au plus fort), puis rose, prune et **ciel indigo** jusqu'à `#0e0726` ;
- un **soleil couchant fracturé** : un disque découpé en 9 tranches horizontales décalées latéralement, d'orange en bas
  à or pâle en haut, placé à gauche, loin du point de fuite de la piste ;
- **8 îlots suspendus** lointains au-dessus de l'horizon : des triangles inversés à bord doré, chacun avec un éclat
  détaché ;
- de **grandes silhouettes géométriques** sur l'horizon : monolithes inclinés et pics triangulaires, à plus de 26 m de
  l'axe ;
- un **sol bordeaux sombre** `#1a0712`, le lit de piste, et des **lignes de perspective** orange (±8 m), rose (±13 m)
  et or discret (±20 m).

**Décor ancré** (un InstancedMesh de 200 instances de la boîte du kit) :
- **20 îlots flottants** entre 32 et 48 m de l'axe et de 7 à 16 m de haut. Chacun est une dalle violette inclinée, avec
  un **liseré doré** sur sa face supérieure, **deux cristaux orchidée suspendus** pointés vers le bas (jamais sous
  3,97 m) et un **reflet orange ou rose** sur le sol ;
- **16 monolithes brisés** entre 20 et 30 m de l'axe. Chacun a deux blocs inclinés **vers l'extérieur de la piste**,
  séparés par une **fracture lumineuse orange** ;
- **24 losanges** géométriques à plat sur le sol ;
- **16 traînées de vitesse** lilas, au-delà des rails ;
- **12 impulsions** saumon le long des lignes de perspective (18 m/s).

**Couloirs** : `#1c0b18` et `#240f20`, couloir actif `#3a1b42`. **Interface** en section 4 : HUD, pied de page et
menus bordeaux, libellé de zone orange crépusculaire `#ffb08a` (contraste ≈ 10,7:1), cadre de menu or discret.

## 6. Transition Forêt synaptique → Horizon fracturé (2200 → 2290 m)

C'est la règle de passation déjà validée pour 1 → 2 et 2 → 3, appliquée par le directeur. **Le code de la forêt n'a pas
changé.**

| Distance | Ce qui se passe |
|---|---|
| 2200–2245 m | La forêt fond dans la couleur de zone. Ses arbres, cristaux et motifs se sont arrêtés avant 2200 m, et ses impulsions rétrécissent. |
| 2245 m | La forêt, entièrement fondue, est retirée et libérée (fond et tampons d'instances) ; l'horizon est créé, entièrement fondu, à l'image suivante. Les deux ont exactement la couleur de zone, qui est aussi le fond et le brouillard : **pas de noir, pas de trou, pas de saut de couleur**. |
| 2245–2290 m | L'horizon émerge de la brume. Îlots et monolithes ne sont placés qu'à partir de ~2337 m (création + 92 m, brouillard total) : **ils sortent du brouillard, rien ne surgit devant le joueur**. |
| 2200–2290 m | En continu : couleur de zone (brume turquoise → brume rosée) et couleurs des couloirs (sarcelles → bordeaux), fondues sur 90 m. |

**Différence volontaire** dans la zone de transition, et seulement là : avant, la forêt s'effaçait seule sur 90 m
vers les couleurs d'origine de « Core Transit ». Maintenant, elle s'efface sur 45 m pour laisser la seconde moitié à
l'horizon, et la couleur de zone et celle des couloirs vont vers l'horizon. **Rien ne change avant 2200 m** (§ 10).

## 7. Sortie vers la section 5 (3500 → 3590 m)

- Il n'y a pas encore d'univers 5. L'horizon fond **seul, sur les 90 m complets**, vers les couleurs d'origine
  d'« Overdrive », comme la forêt le faisait en phase 3.
- Tous ses éléments ancrés s'arrêtent avant 3500 m (point le plus loin relevé : 3496,85 m).
- À 3590 m, l'horizon est retiré et ses ressources sont libérées. La section 5 retrouve son apparence d'origine, sans
  aucun appel de dessin ajouté.
- Missions et scores ne sont pas touchés : ils dépendent de fichiers inchangés.

## 8. Ressources

Ce sont des **estimations statiques, non des mesures GPU**. Le seul chiffre mesuré reste la base GAME-7 : 22
géométries, 2 programmes, 47–52 appels de dessin.

| | Plafond | Univers 1 à 4 (chacun) | Passations (545, 1245, 2245 m) | Section 5 |
|---|---|---|---|---|
| Géométries | ≤ 24 | 24 | 23 sur une image, puis 24 | 23 |
| Programmes | ≤ 4 | 4 | 4 | 4 |
| Appels de dessin ajoutés | — | +2 | +2 (jamais +4) | +0 |

**Géométries réutilisées** :
- la boîte unité du kit, pour les 200 instances : îlots, liserés, cristaux, reflets, monolithes, fractures, losanges,
  traînées, impulsions ;
- **aucune géométrie par fragment** ;
- la seule géométrie propre est le fond, et elle n'existe que pendant que l'univers est vivant.

**Matériaux réutilisés** : les deux instances de matériaux du kit (fond et ville), donc **0 programme de shaders
nouveau**.

**Autres points** :
- **Un seul univers à la fois** : contrôlé à chaque pas de 0,25 m de 0 à 3700 m. Jamais plus d'un fond ni plus d'une
  géométrie propre vivante.
- **Libération** : chaque univers retiré libère son fond et ses tampons d'instances, jamais la boîte ni les matériaux
  du kit. Après la libération du renderer, tout est libéré.
- **Envois GPU** : quand seules les impulsions bougent, seule leur tranche est envoyée (vérifié : début 3008, 192
  flottants). Les 200 instances ne sont renvoyées qu'aux changements de rangée (tous les 7 à 24 m).
- **Pas de reconstruction par image** : les placements se font aux changements de rangée, les couleurs de sommets
  pendant les fondus seulement.

## 9. Lisibilité et accessibilité

- **Rien dans la zone de jeu** : boîtes englobantes exactes, calculées sur les 8 coins de chaque instance tournée.
  Plus petite distance à l'axe d'une pièce au-dessus du sol : 4,034 m (les rails s'arrêtent à 3,54 m). Aucune pièce
  ne traverse l'axe. Rien au-dessus des couloirs.
- **Rien ne masque un obstacle** : tout ce qui est latéral au-delà des rails, sous la surface ou au fond est toujours
  plus loin sur le rayon de vue que l'élément de piste qu'il recouvre.
- **Pas de nouvelle plateforme, de nouvel obstacle ni de collision** : les îlots et monolithes sont des instances
  décoratives que la simulation ignore. Les cristaux suspendus restent au-dessus de 3,97 m, et les monolithes
  penchent **vers l'extérieur**.
- **Couleurs** : la palette du crépuscule (rose, orange) est proche des couleurs d'obstacles. C'est pourquoi :
  - aucune couleur rose bloc ni ambre portique n'est utilisée près de la piste ;
  - les éléments chauds du décor sont soit au fond, soit à plat sur le sol au-delà de 8 m, soit au-dessus de 4 m et
    au-delà de 20 m ;
  - les cristaux sont orchidée (teinte ≈ 295°, contre ≈ 330° pour le bloc) ;
  - les traînées proches de la piste sont lilas, ni roses ni orange.
- **Pas d'apparition brutale** : sommet de l'horizon mesuré à 19,46 m, sous la ligne de brume de 21 m ; tout élément
  brillant du ciel est au-dessus de cette ligne.
- **Aucun stroboscope ni clignotement** : couleurs fixes, une seule animation (les impulsions).
- **Contraste** (luminance WCAG sur les couleurs de base, hors éclairage, donc approximatif). Valeurs sur couloir
  latéral / central / actif :

  | Élément | Original | Horizon fracturé |
  |---|---|---|
  | Bloc rose | 5,79 / 5,35 / 4,45 | **6,21 / 5,93 / 4,87** |
  | Portique ambre | 10,0 / 9,3 / 7,7 | **10,8 / 10,3 / 8,4** |
  | Éclat | 14,4 / 13,3 / 11,0 | **15,4 / 14,7 / 12,1** |
  | Construct | 12,0 / 11,1 / 9,3 | **12,9 / 12,3 / 10,1** |
  | Couloir actif / central | 1,20 | **1,22** |

- **Mouvement réduit** : plus de traînées ni d'impulsions ; tout le décor statique (îlots, cristaux, monolithes, ciel,
  soleil, lignes) reste, et les repères de jeu et la difficulté ne changent pas. **Rendu logiciel** : pas
  d'impulsions.

## 10. Conservation des trois premiers univers

- Le contrôle Node fait tourner **côte à côte** le directeur exact de la phase 3 validée (`equiv/`) et le directeur
  actuel, à chaque pas de 0,5 m sur **0–2200 m** (4400 pas, trois variantes : normal, mouvement réduit, rendu
  logiciel). Il compare :
  - la couleur de zone et les palettes de couloirs ;
  - le nombre de meshes et leur visibilité ;
  - positions et couleurs des fonds ;
  - matrices et couleurs d'instances ;
  - tranches d'envoi GPU.
- Résultat : **tout est identique, valeur par valeur**. Univers 1, 2 et 3, transitions 1 → 2 et 2 → 3 : préservés.
- De plus, les fichiers de ces univers sont identiques octet par octet aux copies validées.

## 11. Contrôles réellement exécutés

| Contrôle | Résultat |
|---|---|
| TypeScript ciblé (options de `tsconfig.json`, sur `main.ts`, `worlds.ts` et les 5 modules d'univers et de kit) | **PASS** (après la dernière modification) |
| Imports et syntaxe (TypeScript ; chargement effectif des modules par Node) | **PASS** |
| `git diff --check` ; espaces en fin de ligne et tabulations dans les nouveaux fichiers | **PASS** |
| `worlds-check-phase4.mjs`, script Node déterministe (un processus, quelques secondes, sans WebGL, navigateur ni GPU) | **PASS** : préservation 0–2200 m ; cycle de vie 0 → 3700 m ; au plus 1 fond et 1 géométrie propre ; continuité aux 4 passations et sorties ; zone de jeu ; hauteurs sous la brume ; fin avant 3500 m ; révélation ; séparation îlots / monolithes ; cristaux au-dessus de 3,5 m ; envoi partiel ; retour à l'aube ; libération complète |
| SHA-256 des 13 fichiers protégés de Synapse Run, par rapport à l'avant-phase 1 | **13/13 identiques** |
| SHA-256 des 15 fichiers Filament (par rapport à l'avant-phase 1 et à l'avant-phase 4) | **15/15 identiques** |
| Différences par rapport à la phase 3 validée | uniquement `worlds.ts` (import + 1 ligne) et `foundation.css` (+5 lignes) |
| Recherche d'API interdites dans `world-horizon.ts` et `worlds.ts` | aucune |
| Fichiers indexés | 0 |

Correction faite avant le contrôle : les îlots ont été repoussés vers l'extérieur (36–44 m) et l'inclinaison des
monolithes réduite, pour qu'ils ne puissent jamais se traverser. Le contrôle confirme la séparation : monolithes
≤ 30,17 m, îlots ≥ 32,10 m.

## 12. Tests non effectués

- Navigateur automatisé, Playwright, GPU, WebGL forcé, benchmark : **0**.
- Suites unitaires de Synapse Run : non lancées, elles portent sur des fichiers inchangés.
- `vite build` : non lancé.
- Simulation Filament : **0**.
- **Aucune mesure de fluidité ni de FPS.**
- Test visuel : **non réalisé**.

## 13. Intégrité

- **Gameplay** : `simulation.ts`, `sections.ts`, `loop.ts`, `input.ts`, `gestures.ts`, `pause.ts`, `camera.ts`,
  `autopilot.ts`, `feedback.ts` et `audio.ts` sont identiques. Vitesses, couloirs, génération, collisions, hitboxes,
  sauts, glissades, commandes, frontières et règles de défaite ne changent donc pas.
- **Missions, scores, records, progression, sauvegardes** : `progression.ts` et `foundation.js` sont identiques. Aucune
  donnée utilisateur n'a été lue ou écrite, et il n'y a pas de migration.
- **Filament** : 15/15 identiques.
- **Autres modules** non touchés : Companion, MAÎTRE, Root Policy, Knowledge Graph, Notebook, Docteur Memory, launcher,
  PDF privé, rapports et copies. Il n'y a pas de dossier DevLab dans le dépôt. Docteur n'a pas été lancé et aucun
  processus n'a été arrêté.
- **Git** : 0 indexé, 0 commit, 0 push. Aucune commande `add`, `commit`, `push`, `reset`, `restore`, `clean`, `merge`
  ou `rebase`.

## 14. Points à vérifier manuellement

1. **0–2200 m** : aube, cité, forêt et leurs transitions, comme validés.
2. **2200–2290 m** : la forêt s'efface, puis l'horizon émerge ; vérifier qu'il n'y a ni noir, ni trou, ni saut de
   couleur, et que les couloirs passent progressivement de la sarcelle au bordeaux.
3. **Ciel crépusculaire** : dégradé bordeaux et orange, soleil fracturé à gauche, îlots lointains, silhouettes.
4. **Fragments flottants** : ils sortent du brouillard sans surgir. Vérifier aussi les cristaux suspendus, les liserés
   dorés et les fractures des monolithes.
5. **Lisibilité** : blocs roses et portiques ambre immédiatement reconnaissables malgré la palette chaude, y compris
   sur le couloir actif ; aucun cristal ni reflet pris pour un objet de jeu.
6. **Fluidité**, notamment autour de 2245 m (création de l'horizon, non mesurée).
7. **3500–3590 m** : l'horizon fond vers l'apparence d'origine de la section 5, sans fragment persistant.
8. **Missions, scores et « Rejouer »** : normaux ; retour de l'aube.
9. **Mouvement réduit** : plus de traînées ni d'impulsions, le reste demeure.

Risques connus :
- la palette chaude est la plus proche des couleurs d'obstacles de tous les univers ;
- début de section dépouillé jusqu'à ~2337 m ;
- le soleil, à gauche, peut sortir du cadre en portrait étroit.
