# Synapse Run — Évolution visuelle — Phase 5 (univers 5 « Cœur du Cortex »)

**Date** : 2026-10-24 · **Référence** : `DOCTEUR_SYNAPSE_RUN_VISUAL_EVOLUTION_PHASE_4_CHECKPOINT` · **Dépôt** :
`C:\dev\Docteur` (HEAD `b9eeeb4`, inchangé)

**Verdict** : `SYNAPSE_RUN_5_WORLDS_READY_FOR_FINAL_MANUAL_REVIEW`. Les cinq univers sont intégrés et les contrôles
statiques passent. **Le rendu de l'univers 5 n'a été vu par personne.**

## 1. Validation utilisateur

| Univers | Statut |
|---|---|
| 1 « Aube numérique » | validé |
| 2 « Cité des impulsions » | validé |
| 3 « Forêt synaptique » | validé |
| 4 « Horizon fracturé » | approuvé pour continuer (« l'univers 4 lui convient ») |

Aucun nouveau test de l'univers 4 n'a été fait de mon côté.

## 2. Architecture réutilisée

Aucun nouveau système, moteur ni bibliothèque :

- **`world-kit.ts`, inchangé** : une boîte unité ombrée, deux matériaux partagés, cuisson du brouillard, bandes de ciel
  et de sol.
- **`worlds.ts`** : même directeur et même cycle de vie. Au plus un univers vivant ; passation au milieu du fondu de
  90 m ; libération du fond et des tampons d'instances, jamais des ressources du kit ; aucune nouvelle tentative si un
  univers échoue à se construire. **Une seule ligne ajoutée** dans la table section → univers.
- **Conventions des univers 3 et 4** reprises dans `world-cortex.ts` : révélation à au moins 92 m, ciel couleur brume
  au-dessus de tout sommet, envoi partiel des animations, mouvement réduit.
- `world-dawn.ts`, `world-city.ts`, `world-forest.ts`, `world-horizon.ts`, `renderer.ts` et `main.ts` sont
  **identiques** aux versions validées.

## 3. Fichiers

| Fichier | Statut | Changement |
|---|---|---|
| `src/arcade/synapse-run/world-cortex.ts` | **créé** (255 lignes) | univers 5 |
| `src/arcade/synapse-run/worlds.ts` | modifié | +1 import, la dernière case `null` de la table remplacée par le cortex, 2 lignes de commentaire |
| `public/arcade/synapse-run/foundation.css` | modifié | +5 lignes : HUD, pied de page, libellé et menus de la section 5 |
| tous les autres fichiers de Synapse Run | **inchangés** | — |

**Copies** : `.tmp/synapse-run-visual-phase5-backup-2026-10-24/`. Les copies des phases 1 à 4 sont conservées.

- `pre/` : toutes les sources et `foundation.css` avant la phase 5 ;
- `equiv/` : le système de mondes de la phase 4 validée ;
- `post/` : les 3 fichiers touchés ;
- `pre-hashes.txt`, `pre-filament-hashes.txt`, `worlds-check-phase5.mjs`.

## 4. Bornes de la cinquième section, vérifiées dans le code

- **Section 5 « Overdrive »** : commence à **3500 m** et **n'a pas de fin**. C'est la dernière ligne de `SECTIONS` :
  `sectionIndex` renvoie 4 pour toute distance ≥ 3500 m, et la difficulté y est constante (`difficultyAt` utilise la
  même section comme « suivante »).
- **Fin de course** : uniquement par collision (`GAME_OVER`). Il n'y a ni victoire, ni boss, ni distance finale, et
  rien n'a été ajouté.
- **Conséquence pour le décor** : le cortex reste en place jusqu'à la fin de la course. Tous ses éléments sont recyclés
  autour du joueur, avec un nombre fixe d'instances : **rien ne s'accumule**. Le contrôle l'a vérifié de 3600 à
  6000 m, avec 2 géométries vivantes et 252 instances en permanence.

## 5. Conception du Cœur du Cortex

**Fond** (un mesh fusionné de 978 sommets, qui suit la caméra, brouillard précalculé) :
- **nuit violette** : brume indigo `#150b33` jusqu'à 23,5 m, puis une lueur violette (`#4a1a6e`), puis violet nuit
  jusqu'à `#080420` ;
- un **halo doré** : un disque chaud au centre, qui reprend la couleur exacte du ciel sur son bord pour s'y fondre ;
- le **noyau neuronal**, droit devant au-dessus de l'horizon (centre à 36 m de haut) :
  - un hexagone doré (cœur blanc champagne `#fff0c0`, bord or `#e0a840`) ;
  - un anneau hexagonal doré, un anneau octogonal violet-magenta, un anneau dodécagonal champagne ;
  - **12 nervures** rayonnantes ;
  - un fin anneau **cyan** `#56d4f5`, qui rappelle l'aube ;
- des **connexions neuronales** qui partent de l'anneau extérieur vers 16 nœuds champagne répartis dans le ciel ;
- des **tours de circuits monumentales** sur l'horizon, à plus de 26 m de l'axe. Leurs lignes de circuit dorées ne
  commencent qu'au-dessus de la ligne de brume ;
- un **sol indigo très sombre** `#0a0618`, le lit de piste, des **lignes dorées** (±8 m), une **trace violette**
  (±12 m) et une ligne dorée atténuée (±17 m).

**Décor ancré** (un InstancedMesh de 252 instances de la boîte du kit) :
- **16 portiques décoratifs**, uniquement sur les côtés : deux colonnes, la première entre 21,5 et 23 m de l'axe et la
  seconde 6 à 8 m plus loin, reliées par un linteau. Chacun a :
  - un liseré doré sous le linteau ;
  - des **circuits verticaux** sur les faces avant, dorés sur la colonne intérieure et cyan sur l'extérieure ;
  - une **lumière de synapse** sous le linteau.

  Aucun linteau ne passe au-dessus de la piste : ils commencent tous à 21,5 m de l'axe ou plus.
- **16 colonnes numériques** lointaines (36–44 m), avec un circuit doré et un bandeau magenta discret ;
- **16 circuits** au sol : deux segments en L et une pastille, entre 8 et 12,5 m de l'axe ;
- **16 traînées de vitesse** lilas pâle, au-delà des rails ;
- **12 impulsions** champagne le long des lignes au sol ;
- **16 lumières lentes** (2,2 m/s) qui **montent le long des circuits dorés** des portiques.

**Couloirs** : `#140a28` et `#1a0e34`, couloir actif `#2c1a5c`. **Interface** en section 5 : HUD, pied de page et
menus violet profond, libellé de zone champagne doré `#f0d090` (contraste ≈ 13,1:1), cadre de menu or.

**Variations d'intensité** : elles n'ont pas été faites. Avec les matériaux existants, il aurait fallu repeindre
chaque image les couleurs de sommets du fond, ce que la mission déconseille. Les seules animations sont des
déplacements lents, continus et bornés.

## 6. Transition Horizon fracturé → Cœur du Cortex (3500 → 3590 m)

C'est la règle de passation déjà validée pour 1 → 2, 2 → 3 et 3 → 4. **Le code de l'horizon n'a pas changé.**

| Distance | Ce qui se passe |
|---|---|
| 3500–3545 m | L'horizon fond dans la couleur de zone. Ses îlots et monolithes s'arrêtent avant 3500 m ; ses impulsions rétrécissent. |
| 3545 m | L'horizon, entièrement fondu, est retiré et libéré ; le cortex est créé, entièrement fondu. Les deux sont exactement la couleur de zone, qui est aussi le fond et le brouillard : **pas de noir, pas de trou, pas de saut**. |
| 3545–3590 m | Le cortex émerge. Le noyau et le ciel apparaissent avec le fond. Portiques et colonnes ne sont placés qu'à partir de ~3637 m (création + 92 m, brouillard total) : **ils sortent du brouillard**. |
| 3500–3590 m | En continu : couleur de zone (brume rosée → brume indigo) et couleurs des couloirs (bordeaux → indigo-violet), fondues sur 90 m. |

**Différence volontaire, et seulement là** : avant, l'horizon s'effaçait seul sur 90 m vers les couleurs d'origine
d'« Overdrive ». Maintenant, il s'efface sur 45 m et laisse la seconde moitié au cortex. **Rien ne change avant
3500 m** (§ 10).

Écart maximal mesuré entre le fond et la couleur de zone aux images de passation : **0,0109** (sur 1, en couleur
linéaire), avec le pas de 0,5 m de ce contrôle (pas de 0,25 m aux phases précédentes, ≈ 0,0055). En jeu, à 24 m/s et
60 images par seconde, le pas réel est d'environ 0,4 m, donc l'écart est d'environ 0,009. C'est imperceptible.

## 7. Défaite, redémarrage, menu, arrêt

Le code de défaite et de redémarrage (`main.ts`, `simulation.ts`) **n'a pas été modifié**.

- **Défaite** : la course gelée continue d'être affichée, et le directeur ne crée ni ne détruit rien.
- **« Rejouer »** et nouvelle partie : la simulation repart de 0 m. À l'image suivante, le directeur retire le cortex
  (fond et instances libérés) et recrée l'aube.
- **Arcade STOP** : le renderer libère le directeur, qui libère l'univers vivant puis le kit.

Contrôle Node : **trois cycles** de défaite (30 images figées), redémarrage à 0 m, nouvelle course jusqu'à la
section 5, puis un STOP. À chaque redémarrage : 2 objets dans la scène, l'aube, 2 géométries vivantes (la boîte et
le fond de l'aube). Après le STOP : 0 géométrie vivante. **Aucune ressource orpheline ni dupliquée, et aucune
accumulation.**

## 8. Ressources

Ce sont des **estimations statiques, non des mesures GPU**. Le seul chiffre mesuré reste la base GAME-7 : 22
géométries, 2 programmes, 47–52 appels de dessin.

| | Plafond | Chaque univers (1 à 5) | Passations (545, 1245, 2245, 3545 m) | Section 5, sans fin |
|---|---|---|---|---|
| Géométries | ≤ 24 | 24 | 23 sur une image, puis 24 | 24, constant |
| Programmes | ≤ 4 | 4 | 4 | 4 |
| Appels de dessin ajoutés | — | +2 | +2 (jamais +4) | +2 |

- **Géométries et matériaux partagés** : la boîte du kit sert aux 252 instances (aucune géométrie par circuit), et les
  deux matériaux du kit au fond et au décor, donc **0 programme nouveau**. Le noyau est fait de primitives simples
  (disques, anneaux, bandes) fusionnées dans le fond : **0 appel de dessin en plus**.
- **Un seul univers à la fois** : contrôlé à chaque pas de 0,5 m de 0 à 6000 m. Au plus 1 fond et 2 géométries
  vivantes (la boîte et un fond).
- **Envois GPU** : quand seules les animations bougent, seule leur tranche est envoyée (impulsions et lumières
  montantes, contiguës : début 3584, 448 flottants). Les 252 instances ne sont renvoyées qu'aux changements de rangée.

## 9. Lisibilité et accessibilité

- **Le noyau ne peut cacher aucun élément de jeu** : tout ce qui est jouable reste sous le niveau des yeux (portiques
  2,6 m, saut maximal ≈ 3,1 m, caméra à 3,4 m), donc à l'écran sous la ligne d'horizon, alors que le noyau est
  au-dessus. Le sommet coloré le plus bas du fond près de l'axe est à 23,88 m.
- **Rien dans la zone de jeu** : boîtes englobantes exactes. Plus petite distance à l'axe d'une pièce au-dessus du sol :
  4,036 m (les rails s'arrêtent à 3,54 m). Aucune pièce ne traverse l'axe, et aucun linteau ne passe au-dessus des
  couloirs.
- **Or contre portiques ambre et éclats** : les ors décoratifs sont champagne (désaturés, plus clairs que l'ambre
  saturé `#ffb547`). Ils sont soit à plat au sol au-delà de 8 m, soit verticaux au-delà de 21 m, soit dans le ciel. Il
  n'y a aucune barre horizontale dorée à hauteur de couloir, et aucune forme d'octaèdre ni d'anneau près de la piste.
- **Pas d'apparition brutale** : sommet du décor ancré mesuré à 22,66 m, sous la ligne de brume de 23,5 m ; tous les
  éléments brillants du ciel sont au-dessus de cette ligne.
- **Aucun stroboscope**, pas de pluie de particules, pas d'animation d'intensité.
- **Contraste** (luminance WCAG sur les couleurs de base, hors éclairage, donc approximatif). Valeurs sur couloir
  latéral / central / actif :

  | Élément | Original | Cœur du Cortex |
  |---|---|---|
  | Bloc rose | 5,79 / 5,35 / 4,45 | **6,25 / 5,97 / 4,90** |
  | Portique ambre | 10,0 / 9,3 / 7,7 | **10,8 / 10,3 / 8,5** |
  | Éclat | 14,4 / 13,3 / 11,0 | **15,5 / 14,8 / 12,1** |
  | Construct | 12,0 / 11,1 / 9,3 | **13,0 / 12,4 / 10,2** |
  | Couloir actif / central | 1,20 | **1,22** |

- **Mouvement réduit** : traînées, impulsions et lumières montantes sont masquées (vérifié par le contrôle) ; le décor
  statique complet reste. **Rendu logiciel** : pas d'animations.

## 10. Intégrité des quatre premiers univers

- Le contrôle Node fait tourner **côte à côte** le directeur exact de la phase 4 validée (`equiv/`) et le directeur
  actuel, à chaque pas de 0,5 m sur **0–3500 m** (7000 pas, trois variantes : normal, mouvement réduit, rendu
  logiciel). Il compare :
  - la couleur de zone et les palettes de couloirs ;
  - les meshes et leur visibilité ;
  - positions et couleurs des fonds ;
  - matrices et couleurs d'instances ;
  - tranches d'envoi GPU.
- Résultat : **tout est identique, valeur par valeur**. Univers 1 à 4 et transitions 1 → 2, 2 → 3, 3 → 4 : préservés.
- De plus, les fichiers de ces univers sont identiques octet par octet aux copies validées.

## 11. Contrôles

**Réalisés** :

| Contrôle | Résultat |
|---|---|
| TypeScript ciblé (options de `tsconfig.json`, sur `main.ts`, `worlds.ts` et les 6 modules d'univers et de kit) | **PASS** (après la dernière modification) |
| Imports et syntaxe (TypeScript ; chargement effectif par Node) | **PASS** |
| `git diff --check` ; espaces en fin de ligne et tabulations | **PASS** |
| `worlds-check-phase5.mjs` : script Node déterministe et borné, sans navigateur, WebGL ni GPU, **0,95 s** | **PASS** : préservation 0–3500 m ; passation 4 → 5 ; section 5 sans fin et stable jusqu'à 6000 m ; zone de jeu ; hauteurs sous la brume ; révélation ; noyau au-dessus de l'horizon ; envoi partiel ; mouvement réduit ; 3 cycles défaite / redémarrage ; STOP ; libération complète |
| SHA-256 des 13 fichiers protégés de Synapse Run, par rapport à l'avant-phase 1 | **13/13 identiques** |
| SHA-256 des 15 fichiers Filament (par rapport à l'avant-phase 1 et à l'avant-phase 5) | **15/15 identiques** |
| Différences par rapport à la phase 4 validée | uniquement `worlds.ts` (import + 1 ligne) et `foundation.css` (+5 lignes) |
| Recherche d'API interdites dans `world-cortex.ts` et `worlds.ts` | aucune |
| Fichiers indexés | 0 |

**Non réalisés** :
- navigateur automatisé, Playwright, GPU, WebGL forcé, benchmark, test de charge : **0** ;
- suites unitaires de Synapse Run : leurs fichiers sont inchangés ;
- `vite build` ;
- simulation Filament : **0** ;
- **aucune mesure de fluidité ni de FPS** ;
- test visuel : **non réalisé**.

## 12. Gameplay et sauvegardes

- **Gameplay** : `simulation.ts`, `sections.ts`, `loop.ts`, `input.ts`, `gestures.ts`, `pause.ts`, `camera.ts`,
  `autopilot.ts`, `feedback.ts` et `audio.ts` sont identiques. Accélération, vitesses, couloirs, collisions, hitboxes,
  obstacles, génération, sauts, glissades, commandes, défaite et frontières ne changent donc pas.
- **Missions, scores, records, progression, sauvegardes** : `progression.ts` et `foundation.js` sont identiques. Aucune
  donnée utilisateur n'a été lue ou écrite, et il n'y a pas de migration.
- **Filament 24/24** : 15/15 empreintes identiques.
- **Autres modules** non touchés : Companion, MAÎTRE, Root Policy, Knowledge Graph, Notebook, Docteur Memory, launcher,
  PDF privé, hooks, rapports et copies. Il n'y a pas de dossier DevLab dans le dépôt. Docteur n'a pas été lancé et
  aucun processus n'a été arrêté.
- **Git** : 0 indexé, 0 commit, 0 push. Aucune commande `add`, `commit`, `push`, `reset`, `restore`, `clean`, `merge`
  ou `rebase`.

## 13. Anomalies et points d'attention

1. Le bas du halo doré descend à 22 m, sous la ligne de brume. Ses sommets à ce niveau ont exactement la couleur de la
   brume, donc aucun élément brillant n'est sous 23,88 m.
2. Le noyau est **centré sur l'axe**, droit devant. À l'écran, il est au-dessus de l'horizon ; en paysage, le haut de
   ses anneaux peut passer sous le dégradé du HUD.
3. Début de section dépouillé jusqu'à ~3637 m, comme pour les univers 2 à 4.
4. La création du cortex à 3545 m se fait en une fois (978 sommets), en pleine course, à la vitesse maximale du jeu.
   C'est bref mais **non mesuré**.
5. Les ors champagne sont les plus proches de l'ambre des portiques parmi les accents des cinq univers. Ils sont tenus
   à distance de la piste, mais c'est à vérifier à l'œil.
6. Un défaut de cohérence repéré pendant la conception, corrigé avant le contrôle : la colonne intérieure des
   portiques a été repoussée à 21,5 m ou plus, pour ne jamais traverser les silhouettes hexagonales d'origine du
   renderer (qui vont jusqu'à ~20,1 m).

## 14. Procédure de test manuel

1. **0–3500 m** : les quatre premiers univers et leurs transitions, comme validés.
2. **3500–3590 m** : l'horizon s'efface, puis le cortex émerge ; vérifier qu'il n'y a ni noir, ni trou, ni saut de
   couleur, et que les couloirs passent du bordeaux à l'indigo-violet.
3. **Noyau neuronal** droit devant : hexagone doré, anneaux, nervures, anneau cyan, halo, connexions.
4. **Portiques et colonnes** : circuits dorés et cyan, lumières de synapse, lumières qui montent ; ils sortent du
   brouillard.
5. **Lisibilité** : blocs roses, **portiques ambre** et éclats bien distincts des ors du décor, y compris sur le couloir
   actif.
6. **Fluidité**, notamment autour de 3545 m et sur une longue course en section 5.
7. **Défaite** en section 5, puis « Rejouer » : retour immédiat à l'aube, scores et records normaux, missions
   inchangées.
8. **Sauvegardes** : la progression enregistrée reste la même (records, totaux, missions).
9. **Mouvement réduit** : plus de traînées, d'impulsions ni de lumières montantes ; le reste demeure.

Après la validation, une mission distincte de **finition finale des cinq univers** (équilibre des couleurs, densité
des débuts de section, rien sur le gameplay) peut être proposée.
