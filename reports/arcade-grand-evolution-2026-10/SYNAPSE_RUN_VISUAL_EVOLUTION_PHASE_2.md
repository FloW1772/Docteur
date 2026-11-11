# Synapse Run — Évolution visuelle — Phase 2 (univers 2 « Cité des impulsions »)

**Date** : 2026-10-24 · **Référence** : `DOCTEUR_SYNAPSE_RUN_VISUAL_EVOLUTION_PHASE_1_CHECKPOINT` · **Dépôt** :
`C:\dev\Docteur` (HEAD `b9eeeb4`, inchangé)

**Verdict** : `SYNAPSE_RUN_WORLD_2_READY_FOR_MANUAL_REVIEW`. Le code est en place et les contrôles statiques passent.
**Le rendu de l'univers 2 n'a été vu par personne.**

## 0. Historique

- Première demande de phase 2 : **bloquée**. La confirmation de l'univers 1 manquait ; rien n'avait été implémenté.
- Autorisation reçue ensuite : « L'univers 1 me plaît et je le valide. » La phase 2 a donc repris, en partant de
  l'analyse des ressources préparée lors du blocage (option 1 : fondu enchaîné).

## 1. Audit de l'univers 1 (point de départ)

- Au départ, les fichiers de la phase 1 étaient identiques à leur copie « post » de la phase 1 : `renderer.ts`,
  `main.ts`, `world-dawn.ts`, `foundation.css`.
- Le rendu est Three.js 0.170 (WebGL). Section 1 de 0 à 500 m, section 2 de 500 à 1200 m, fondu de couleur de 90 m
  au début de chaque section (`renderer.ts`), mouvement réduit transmis par l'hôte.
- Ressources de l'univers 1, estimées : un fond fusionné (1 géométrie) et une boîte unité instanciée (1 géométrie) ;
  2 matériaux, soit 2 programmes ; +2 appels de dessin. Avec la base GAME-7 **mesurée** (22 géométries,
  2 programmes), on atteint exactement les plafonds de revue : **24 géométries et 4 programmes**.

## 2. Gestion des ressources

### Ce qui est partagé : `world-kit.ts`, nouveau

Le **kit** est créé une fois par renderer et libéré avec lui. Il possède :
- **la boîte unité ombrée**, la seule géométrie instanciée, commune à tous les univers ;
- **le matériau de fond** (non éclairé, couleurs de sommets, sans brouillard, double face) ;
- **le matériau de ville** (couleurs de sommets et d'instance, avec brouillard).

Les deux univers dessinent avec **ces mêmes instances de matériaux**, donc avec les mêmes deux programmes de shaders.
Les fonctions utilitaires de l'univers 1 (`paint`, `gradient`, `hash`, cuisson du brouillard, bande de ciel, bandes
de sol) ont été déplacées dans le kit **sans modification**.

### Ce que possède chaque univers

Uniquement **sa géométrie de fond** (≈ 870 sommets) et **son InstancedMesh**, dont les tampons d'instances ne sont
pas des géométries. Un univers ne libère jamais une ressource du kit : `InstancedMesh.dispose()` ne libère que les
tampons d'instances.

### Le directeur d'univers : `worlds.ts`, nouveau

- Une table section → univers : 1 = Aube numérique, 2 = Cité des impulsions, 3 à 5 = apparence d'origine.
- **Au plus un univers existe à un instant donné.** Tous les autres sont retirés, c'est-à-dire libérés
  (`dispose`) et non simplement masqués : une couche masquée garde sa géométrie en mémoire GPU, seule la libération
  fait baisser le compteur `renderer.info.memory.geometries`.
- Le directeur retire **avant** de créer, dans la même image : deux fonds ne coexistent jamais.
- Un univers qui échoue à se construire n'est jamais réessayé : sa section garde l'apparence d'origine, et le jeu
  continue.

### Bilan

Ce sont des **estimations statiques, non des mesures GPU**. Le seul chiffre mesuré est la base de GAME-7.

| Ressource | Plafond de revue | Section 1 | 500–545 m | 545–590 m | Section 2 | 1200–1290 m | Après 1290 m |
|---|---|---|---|---|---|---|---|
| Géométries | ≤ 24 | 24 | 24 | 24 | 24 | 24 | 23 |
| Programmes | ≤ 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| Appels de dessin ajoutés | — | +2 | +2 | +2 | +2 | +2 | +0 |

- Géométries : base 22, plus la boîte, plus un fond. À la seule image de 545,00 m, puis après 1290 m, il n'y a plus de
  fond : 23. La boîte reste allouée jusqu'à la fin du renderer.
- Programmes : la base en a 2 ; les deux matériaux partagés en ajoutent 2, et ils ne disparaissent jamais.
- Appels de dessin : les deux univers ne sont jamais dessinés en même temps. Avec la base GAME-7 mesurée (47–52),
  l'estimation donne ~49–54, sous le plafond de 60 du parcours d'ouverture.
- Instances : 158 pour l'aube (inchangé), 212 pour la cité. Quand les impulsions sont animées, la matrice d'instances
  est renvoyée à chaque image : 212 × 64 octets ≈ 13,6 Ko. Sinon, seulement aux changements de rangée (tous les 9 à
  21 m).
- Aucune allocation par image : les placements ne sont recalculés qu'aux changements de rangée, et les couleurs de
  sommets seulement pendant les fondus.

## 3. Méthode de transition 500 → 590 m

La transition se cale sur le fondu de 90 m déjà présent dans le renderer, sans aucune distance nouvelle. Les vitesses
et les distances de section ne sont que lues.

| Distance | Ce qui se passe |
|---|---|
| 0–500 m | Aube numérique, **identique à la version validée** (voir § 6) |
| 500–545 m | L'aube fond dans la couleur de zone. Ses flèches, sa grille et ses traînées se sont arrêtées à 500 m (elles sont derrière la caméra) ; ses impulsions rétrécissent avec le fondu. |
| 545 m (milieu) | L'aube est entièrement fondue, puis retirée et libérée. La cité est créée, entièrement fondue, dans la même image ou la suivante. Les deux sont alors exactement de la couleur de zone, qui est aussi le fond et le brouillard de la scène : **pas de trou, pas de noir, pas de saut de couleur**. |
| 545–590 m | La cité émerge de la couleur de zone. Ses tours n'apparaissent que là où le brouillard est déjà total (≥ 92 m devant le joueur à sa création), puis elles approchent dans la brume. |
| 500–590 m | En continu : couleur de zone (brume d'aube → brume violette) et couleurs des couloirs (bleus d'aube → violets de la cité) fondues sur les 90 m complets. Les rails, les séparateurs, les piliers et les arches restent présents : c'est la continuité de base. |
| 1200–1290 m | La cité fond vers l'apparence d'origine de la section 3 sur 90 m (il n'y a pas encore d'univers 3), puis elle est libérée. |
| Nouvelle course | La cité est libérée et l'aube recréée à 0 m. |

Le contrôle Node (§ 7) relève, aux deux images de la passation, un écart maximal de 0,0055 (sur 1, en couleur
linéaire) entre chaque fond et la couleur de zone. C'est imperceptible à l'œil, et c'est attendu : un pas de 0,25 m
correspond à 0,6 % du fondu.

**Conséquence assumée** : avant, l'aube s'effaçait sur 90 m ; elle s'efface maintenant sur 45 m, pour laisser la
seconde moitié à la cité. Sur 500–590 m, la couleur de zone et celle des couloirs vont désormais vers la cité, et non
plus vers les couleurs d'origine de la section 2.

## 4. Univers 2 — Cité des impulsions

### Éléments

**Fond** (un seul mesh fusionné de 872 sommets, qui suit la caméra, brouillard précalculé comme pour l'univers 1) :
- **ciel de nuit violet** : brume `#140c30` jusqu'à 22,5 m, puis le **halo magenta de la ville** (`#7a2896` au plus
  fort), puis violet profond et nuit `#08041a` ;
- **6 faisceaux de projecteurs** qui montent de derrière la ville et s'éteignent dans la nuit ;
- **ligne d'horizon dense** (plus haute que celle de l'aube, jusqu'à ~35 m), avec des **fenêtres éclairées** lilas et
  violettes, uniquement au-dessus de la ligne de brume ;
- **sol mouillé** violet très sombre, lit de piste, **lignes néon** au sol (violet à ±7,5 m, magenta à ±11 m) et
  **reflets des rails** au sol (±21 m) ;
- **lignes électriques** : deux rails lumineux surélevés de chaque côté (±21 m, à 13,5 et 17 m de haut), qui filent
  vers l'horizon.

**Ville** (un seul InstancedMesh de 212 instances de la boîte du kit) :
- **28 tours** de verre violet, de 10 à 22 m de haut, entre 22 et 37 m de l'axe, tous les ~12 m ;
- **28 arêtes néon** verticales, sur l'angle tourné vers la piste (magenta `#d34cff` ou violet `#8f6bff`) ;
- **56 bandeaux néon** horizontaux (deux par tour) ;
- **jusqu'à 28 enseignes** : des panneaux en aplat, sans texte, sur la face tournée vers la piste, toujours à plus de
  2,7 m du sol, dans la couleur néon opposée ;
- **28 reflets** des arêtes néon sur le sol mouillé, qui s'étirent vers le joueur ;
- **16 tours lointaines** (de 37 à 55 m de l'axe), pour la profondeur ;
- **16 traînées de vitesse** violettes, au-delà des rails ;
- **12 impulsions** magenta `#e46bff`, qui filent à +22 m/s par rapport au joueur (16 m/s pour l'aube) le long des
  rails surélevés et des lignes au sol. C'est l'élément qui donne son nom à l'univers.

**Couloirs** : violets profonds `#170f31` et `#1e1440`, couloir actif `#2d2062`. **Interface** en section 2 : le HUD,
le pied de page et le cadre des menus passent en violet profond, et le libellé de zone en lilas néon `#e3a8ff`.

### Identité par rapport à l'aube

| | Aube numérique | Cité des impulsions |
|---|---|---|
| Ciel | lever du jour : or, turquoise, bleu électrique | nuit : halo magenta, violet profond |
| Architecture | flèches fines et espacées, sommets dorés | tours larges et serrées, néons, enseignes, deux rangées |
| Sol | grille nocturne, lignes cyan | sol mouillé, néons, reflets |
| Lumière en mouvement | impulsions lentes au sol | impulsions rapides au sol **et** sur des rails surélevés |
| Interface | bleus d'aube | violets néon |

## 5. Lisibilité, vérifiée statiquement

- **Rien dans le volume de jeu** : le contrôle Node a examiné 447 714 positions d'instances sur 0–1300 m. Aucune pièce
  au-dessus du sol n'est à moins de 4,045 m de l'axe (les rails s'arrêtent à 3,54 m). Rien au-dessus des couloirs. Les
  rails lumineux sont à ±21 m.
- **Rien ne peut masquer un obstacle** : même raisonnement que l'univers 1. Tout ce qui est latéral au-delà des rails,
  sous la surface ou au fond est toujours plus loin sur le rayon de vue que l'élément de piste qu'il recouvre.
- **Pas de confusion avec les objets de jeu** : pas de rose `#ff4fa3` (bloc) ni d'ambre `#ffb547` (portique) dans le
  décor. Les néons sont magenta et violet (teinte ≈ 285°, contre ≈ 330° pour le bloc). Il n'y a ni octaèdre ni anneau,
  et les impulsions sont soit à 13–17 m de haut, soit au sol à 7,5 m de l'axe ou plus.
- **Pas d'apparition brutale** : le ciel reste couleur brume jusqu'à 22,5 m, au-dessus de toutes les tours (sommet max
  mesuré 21,65 m). Tout élément brillant du fond (faisceaux, fenêtres) est au-dessus de cette ligne. Une tour qui
  apparaît au loin apparaît donc toujours sur de la brume.
- **Aucun clignotement** : les couleurs néon sont fixes par tour, et aucune lumière n'est animée en intensité.
- **Contraste** (luminance WCAG sur les couleurs de base, hors éclairage, donc approximatif). Valeurs sur couloir
  latéral / central / actif :

  | Élément | Original | Aube (validée) | Cité |
  |---|---|---|---|
  | Bloc rose | 5,79 / 5,35 / 4,45 | 5,12 / 4,54 / 3,68 | **6,00 / 5,61 / 4,62** |
  | Portique ambre | 10,0 / 9,3 / 7,7 | 8,9 / 7,9 / 6,4 | **10,4 / 9,7 / 8,0** |
  | Éclat | 14,4 / 13,3 / 11,0 | 12,7 / 11,3 / 9,1 | 14,9 / 13,9 / 11,4 |
  | Construct | 12,0 / 11,1 / 9,3 | 10,6 / 9,5 / 7,7 | 12,5 / 11,7 / 9,6 |
  | Couloir actif / central | 1,20 | 1,24 | **1,22** |

  Pour la ville, les obstacles ressortent mieux qu'avec les couloirs d'origine, et le couloir actif reste plus
  distinct qu'à l'origine.
- **HUD** : libellé de zone `#e3a8ff` sur le dégradé violet, contraste ≈ 10,4:1. Textes, missions et commandes ne
  changent pas.
- **Mouvement réduit** : plus de traînées ni d'impulsions dans les deux univers, et le décor statique demeure.
  **Rendu logiciel** : pas d'impulsions. La disposition « effets réduits » du CSS reste prioritaire.

## 6. Préservation de l'univers 1

- `world-dawn.ts` a été réécrit sur le kit. Le contrôle Node construit **le fichier exact de la phase 1** (copie
  validée) et **le nouveau**, puis compare, à 136 distances de 0 à 500 m et dans trois variantes (normal, mouvement
  réduit, rendu logiciel) : positions et couleurs du fond, géométrie de la boîte, matrices et couleurs d'instances,
  visibilité, paramètres des matériaux. **Tout est identique, valeur par valeur.**
- Dans le renderer, la brume et les couloirs de la section 1 prennent les mêmes valeurs qu'avant. Le seul changement
  dans l'univers 1 concerne la transition décrite au § 3.

## 7. Contrôles réellement exécutés

| Contrôle | Résultat |
|---|---|
| TypeScript ciblé (`tsc --noEmit`, options de `tsconfig.json`, sur `main.ts`, `worlds.ts`, `world-kit.ts`, `world-dawn.ts`, `world-city.ts`) | **PASS** (deux exécutions, code 0) |
| `git diff --check` sur les fichiers suivis ; recherche d'espaces en fin de ligne et de tabulations dans les nouveaux fichiers | **PASS** |
| Contrôle Node `worlds-check.mjs`, sans WebGL, navigateur ni GPU (un processus, quelques secondes) : équivalence de l'univers 1 ; cycle de vie du directeur de 0 à 1300 m par pas de 0,25 m, puis retour à 0 ; au plus 1 fond et 1 géométrie propre vivante ; continuité à la passation ; volume de jeu ; hauteurs ; rien après 1200 m ; rien placé avant la limite de révélation ; libération complète | **PASS** (deux exécutions) |
| SHA-256 des 13 fichiers protégés de Synapse Run, par rapport à l'avant-phase 1 | **13/13 identiques** |
| `main.ts` par rapport à l'avant-phase 2 | identique (non modifié en phase 2) |
| SHA-256 des 15 fichiers Filament (par rapport à l'avant-phase 1 et à l'avant-phase 2) | **15/15 identiques** |
| Recherche d'API interdites dans les 4 modules d'univers (aléatoire, réseau, stockage, minuteries, postMessage, DOM, import dynamique) | aucune (seule occurrence : un commentaire « no Math.random ») |
| Contraste des couleurs de base | calculé (§ 5) |
| Fichiers indexés | 0 |

**Non exécutés** : les suites navigateur (exclues par `ARCADE_TEST_RULES.md`) ; les suites unitaires de Synapse Run,
qui ne lisent aucun fichier modifié (leurs fichiers sont identiques octet par octet) ; `vite build`. **Aucune mesure
de fluidité** : il n'y a ni FPS ni temps d'image dans ce rapport.

Compteurs : navigateur automatisé **0** · tests GPU **0** · simulation Filament **0** · test visuel **non réalisé**.

## 8. Fichiers

| Fichier | Statut | Rôle |
|---|---|---|
| `src/arcade/synapse-run/world-kit.ts` | **créé** (181 lignes) | ressources partagées et utilitaires |
| `src/arcade/synapse-run/world-city.ts` | **créé** (197 lignes) | univers 2 |
| `src/arcade/synapse-run/worlds.ts` | **créé** (98 lignes) | directeur d'univers |
| `src/arcade/synapse-run/world-dawn.ts` | modifié (non suivi, créé en phase 1) | réécrit sur le kit ; même rendu en section 1 ; impulsions qui rétrécissent pendant la transition |
| `src/arcade/synapse-run/renderer.ts` | modifié | le directeur remplace l'appel direct à l'aube ; brume et couloirs lus dans la table des univers (par rapport à HEAD : +44 / −2) |
| `public/arcade/synapse-run/foundation.css` | modifié | teintes de la section 2 (par rapport à HEAD : +13) |
| `src/arcade/synapse-run/main.ts` | inchangé en phase 2 | l'attribut `data-zone` de la phase 1 suffit |

**Copies** : `.tmp/synapse-run-visual-phase2-backup-2026-10-24/`. Les copies de la phase 1 sont conservées.

- `pre/` : `renderer.ts`, `main.ts`, `world-dawn.ts`, `foundation.css` avant la phase 2 ;
- `post/` : les 7 fichiers après ;
- `equiv/` : `world-dawn.ts` validé de la phase 1, et ses dépendances, pour la comparaison ;
- `pre-hashes.txt`, `pre-filament-hashes.txt`, `worlds-check.mjs`.

## 9. Gameplay, sauvegardes et modules préservés

- **Gameplay** : `simulation.ts`, `sections.ts`, `loop.ts`, `input.ts`, `gestures.ts`, `pause.ts`, `camera.ts`,
  `autopilot.ts`, `feedback.ts` et `audio.ts` sont identiques octet par octet. Les collisions, les tailles d'obstacles,
  les sauts, les glissades, les commandes, les vitesses, la génération, les distances de section et les règles de
  défaite ne changent donc pas.
- **Missions, scores, sauvegardes** : `progression.ts` et `foundation.js` sont identiques. Aucune donnée utilisateur
  n'a été lue ou écrite, et il n'y a ni migration ni nouveau champ.
- **Filament** : 15/15 empreintes identiques.
- **Autres modules** : Companion, MAÎTRE, Root Policy, Notebook, Knowledge Graph, Docteur Memory, launcher, PDF privé
  et hooks n'ont pas été touchés. Les modifications préexistantes du dépôt sont conservées. Docteur n'a pas été lancé
  et aucun processus n'a été arrêté.
- **Git** : 0 indexé, 0 commit, 0 push. Aucune commande `add`, `commit`, `push`, `reset`, `restore`, `clean`, `merge`
  ou `rebase`.

## 10. Risques graphiques

1. **Équilibre des couleurs** : le halo magenta, les faisceaux et la luminosité des néons sont choisis sur le papier.
   Ce sont des constantes de `CITY` dans `world-city.ts`.
2. **Début de la section 2 assez dépouillé** : les tours ne sont placées qu'à partir de ~637 m (création à 545 m,
   plus 92 m). Entre 500 et ~600 m, seuls le fond de la cité, les rails, les piliers et les arches sont visibles.
   C'est le prix de « aucune apparition brutale ».
3. **Halo et HUD** : le halo commence au-dessus de 22,5 m. En paysage, une partie peut passer sous le dégradé du HUD.
4. **Impulsions** : elles se déplacent plus vite que celles de l'aube. Si elles attirent trop l'œil, il suffit de
   baisser `PULSE_SPEED`.
5. **Création en cours de course** : à 545 m, la construction du fond (≈ 870 sommets, une fusion) est faite en une
   fois ; elle est brève, mais **non mesurée**.
6. **Nouvelle course** : l'aube est reconstruite à chaque retour à 0 m. C'est la même construction qu'au démarrage.

## 11. À tester manuellement

1. **0–500 m** : l'aube est exactement comme validée.
2. **500–590 m** : fondu de l'aube puis émergence de la cité ; vérifier qu'il n'y a ni noir, ni trou, ni flash, ni
   saut de couleur, et que les couloirs passent progressivement du bleu au violet.
3. **Section 2** :
   - tours, néons, enseignes et reflets ;
   - rails surélevés et impulsions ;
   - ciel, halo et faisceaux ;
   - HUD et libellé de zone en lilas.
4. **Lisibilité** : blocs roses, portiques ambre et éclats bien reconnaissables, sur le couloir actif comme sur les
   autres ; aucun élément néon pris pour un obstacle ou un éclat.
5. **Au loin** : aucune tour ne surgit d'un coup à l'horizon.
6. **Fluidité**, notamment au passage des 545 m (création de la cité).
7. **1200–1290 m** : la cité fond vers l'apparence d'origine de la section 3.
8. **Fin de course et « Rejouer »** : scores, records et missions normaux ; retour de l'aube.
9. **Mouvement réduit** : plus de traînées ni d'impulsions, le reste du décor demeure.
