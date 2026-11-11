# Synapse Run — Grande évolution visuelle — Phase 1

**Date** : 2026-10-24 · **Référence** : `DOCTEUR_FILAMENT_FINAL_POLISH_CHECKPOINT` · **Dépôt** : `C:\dev\Docteur` (HEAD `b9eeeb4`, inchangé)

**Périmètre** : audit de Synapse Run, direction artistique de cinq univers, implémentation visuelle de l'univers 1
(« Aube numérique ») uniquement. Aucune modification de gameplay, de sauvegarde, de Filament ou d'un autre module.

**Verdict** : `SYNAPSE_RUN_WORLD_1_READY_FOR_MANUAL_REVIEW`. Le code est en place et les contrôles statiques passent.
**Le rendu n'a été vu par personne** : rien ici ne vaut validation visuelle.

---

## 1. Architecture réelle de Synapse Run

Synapse Run n'est **pas** un jeu Canvas 2D : c'est une scène **Three.js (WebGL)** de géométries primitives et de
couleurs plates. Il n'y a ni texture, ni modèle, ni asset distant.

| Rôle | Fichier | Notes |
|---|---|---|
| Page (iframe `sandbox="allow-scripts"`, CSP stricte) | `public/arcade/synapse-run/index.html` | `default-src 'none'`, `script-src 'self'`, `style-src 'self'` (pas de style inline), `connect-src 'none'` |
| Protocole hôte + pont de sauvegarde | `public/arcade/synapse-run/foundation.js` | postMessage v1 ; seul chemin vers le stockage (GAME-3, côté hôte) |
| Styles HUD / menus / commandes | `public/arcade/synapse-run/foundation.css` | dispositions « effets réduits » (`data-effects="low"`) et mouvement réduit |
| Point d'entrée, menus, HUD, entrées, pause, toasts | `src/arcade/synapse-run/main.ts` | bundle IIFE `game.js` produit par `scripts/vite-arcade-game-bundle.mjs` (en dev : servi en mémoire, reconstruit quand un fichier du dossier change) |
| Simulation autoritaire (course, sauts, glissades, collisions, score) | `src/arcade/synapse-run/simulation.ts` | pure, déterministe, pas de DOM ni de Three.js ni d'horloge |
| Sections et difficulté (5 tronçons par distance) | `src/arcade/synapse-run/sections.ts` | vitesse, réaction, doubles, couleurs de fond / d'accent |
| Boucle à pas fixe 1/60 s | `src/arcade/synapse-run/loop.ts` | rattrapage borné (5 pas / image max) |
| Rendu (lecture seule de l'état) | `src/arcade/synapse-run/renderer.ts` | instancing, pools, détection rendu logiciel, perte de contexte |
| Caméra | `src/arcade/synapse-run/camera.ts` | scène miroir en z ; caméra à 3,4 m, 6,8 m derrière le joueur |
| Clavier / boutons / gestes | `input.ts`, `gestures.ts` | |
| Raisons de pause (joueur / hôte / page cachée) | `pause.ts` | |
| Missions, profil, sauvegarde | `progression.ts` | `SYNAPSE_RUN_SAVE_VERSION = 1`, validation stricte |
| Retours sonores / visuels | `audio.ts`, `feedback.ts` | |
| Pilote automatique (bundles de test uniquement) | `autopilot.ts` | |

**Personnage et animations** : construct articulé (renderer.ts), avec foulée calculée depuis la distance, inclinaison
pendant le changement de couloir, écrasement à la glissade et à l'atterrissage, et teinte rouge fixe en `GAME_OVER`.
**Obstacles** : `BLOCK` (mur bas, arête claire, à sauter) et `HIGH_GATE` (portique ouvert, barre suspendue, à
franchir en glissade), avec pools de meshes. **Éclats** : octaèdres et halos instanciés, avec un petit « pop » au
ramassage.

**Contraintes du sandbox Arcade** : origine opaque, aucun stockage ni réseau dans la page, sauvegarde uniquement via
`foundation.js` → hôte. Les commandes hôte sont `INIT {reducedMotion}`, `PAUSE`, `RESUME` et `STOP`.

**Fichiers déjà modifiés dans le dépôt** : au départ, aucun fichier de `src/arcade/synapse-run/` ni de
`public/arcade/synapse-run/` n'avait de modification par rapport à HEAD. Les modifications préexistantes ailleurs
(`ArcadeGameHost.tsx`, `protocol.ts`, `registry.ts`, Companion, MAÎTRE, launcher…) n'ont pas été touchées.

## 2. Périmètre protégé

Ces valeurs déterminent le jeu. Elles sont **inchangées** : les fichiers qui les portent sont identiques octet par
octet à leur état d'avant mission (SHA-256 avant / après).

| Élément | Valeur | Fichier |
|---|---|---|
| Pas de simulation | `TICK_RATE = 60`, `DT = 1/60` | simulation.ts |
| Vitesse de base | `SPEED = 12` m/s (12 m/s maintenus sur les 120 premiers mètres) | simulation.ts, sections.ts |
| Vitesse maximale | `MAX_SPEED = 24` | sections.ts |
| Sections | Signal Deck 0 m (12 m/s) · Data Tunnels 500 m (15) · Synaptic Garden 1200 m (18) · Core Transit 2200 m (21) · Overdrive 3500 m (24) | sections.ts |
| Réaction / doubles | 1,65→0,95 s (`REACTION_FLOOR`) ; 0,2→0,8 | sections.ts |
| Espacement des rangées | `rowGap()` = ⌈24 × (réaction + variation × 0,3) + 1,8⌉ | sections.ts |
| Couloirs | `LANE_COUNT = 3`, `LANE_WIDTH = 2.2`, `LANE_CHANGE_TICKS = 8` | simulation.ts |
| Saut | `JUMP_VELOCITY = 9.2`, `GRAVITY = 28` | simulation.ts |
| Glissade | `SLIDE_TICKS = 36`, `PLAYER_SLIDE_HEIGHT = 0.7` | simulation.ts |
| Joueur (boîte) | demi-largeur 0,4, demi-profondeur 0,4, hauteur 1,6 | simulation.ts |
| Obstacles (boîtes) | `OBSTACLE_HALF_WIDTH = 0.9` ; `BLOCK` y 0→1,0, demi-prof. 0,5 ; `HIGH_GATE` y 1,05→2,6, demi-prof. 0,3 | simulation.ts |
| Éclats | `SHARD` y 0,45→1,15 ; `SHARD_POINTS = 10`, `SHARD_SPACING = 2.5`, `SHARD_MARGIN = 4` | simulation.ts |
| Génération | `START_SAFE_Z = 36`, `HORIZON = 110`, `PRUNE_BEHIND = 6`, mulberry32 sur la graine | simulation.ts |
| Score | `floor(distance) + 10 × éclats` | simulation.ts |
| Défaite | toute collision avec un obstacle → `GAME_OVER` (simulation gelée) | simulation.ts |
| Missions | `run-500`, `shards-10`, `score-750` (une seule course, sans récompense ni déblocage) | progression.ts |
| Sauvegarde | `SYNAPSE_RUN_SAVE_VERSION = 1` ; clés `bestDistanceM, bestScore, totalRuns, totalDistanceM, totalShards, missions{progress, completed}` ; validation stricte, rien n'écrase une sauvegarde invalide | progression.ts |
| Boucle | `MAX_STEPS_PER_FRAME = 5`, `MAX_FRAME_DELTA_MS = 100` | loop.ts |
| Commandes | flèches / WASD / Espace / Échap / P / Entrée, gestes, boutons tactiles | input.ts, gestures.ts, main.ts |

Il n'y a **pas de déblocage** dans Synapse Run.

## 3. Système graphique existant

- `WebGLRenderer` (antialias), DPR plafonné à 2 (à 1 en rendu logiciel), `Fog(30 → 95 m)`, plan lointain caméra à
  140 m.
- Matériaux `MeshLambertMaterial` à ombrage plat. Le décor est instancié : bandes, piliers et nœuds, arches,
  branches, vrilles, silhouettes. Les obstacles et les éclats viennent de pools bornés.
- **Les 5 sections existent déjà visuellement** : couleur de fond et de brouillard, couleur d'accent des arches
  (interpolées sur 90 m après chaque début de section), et quelques variantes de décor par section (arches en tunnel,
  végétation de la section 3). Il n'y a **pas de système d'univers** à proprement parler : ni géométrie, ni ciel, ni
  palette de couloirs propres à une section.
- Budgets relevés lors de GAME-7 (rapport `DOCTEUR_GAME_7_SYNAPSE_EVOLUTION_CHECKPOINT.md`) : 47–52 appels de dessin,
  22 géométries, 2 programmes de shaders. Budgets de revue : ≤ 100 appels (≤ 60 sur le parcours d'ouverture dans
  `test-synapse-run-polish-browser.mjs`), ≤ 24 géométries, ≤ 4 programmes.

## 4. Les cinq univers — direction artistique

Constat clé : les cinq propositions de travail **correspondent presque exactement** aux cinq sections existantes et à
leurs accents. Chaque univers habille donc une section, **sans nouveau système de progression** : on change d'univers
en courant, comme on change déjà de section.

Règles communes à tous les univers :

1. **La piste reste la piste** : obstacles (rose `#ff4fa3`, ambre `#ffb547`), éclats (cyan clair, octaèdres et
   halos), construct, rails et séparateurs gardent formes et matériaux. Un univers ne colore que le fond, le
   brouillard, le sol et les couloirs.
2. **Rien dans le volume de jeu** : le décor reste au-delà des rails (|x| ≥ 3,9 m), sous la surface (y < 0) ou sur
   l'arrière-plan. Rien au-dessus des couloirs.
3. **Ni couleur d'obstacle ni forme d'éclat** près de la piste.
4. **Ciel en « brume » jusqu'à 16 m** (voir § 6), pour que le décor recyclé au loin n'apparaisse jamais d'un coup.
5. **Budget par univers** : 2 appels de dessin, 2 géométries, au plus 2 programmes, aucune allocation par image,
   animations bornées et coupées en mouvement réduit.
6. **Passage de relais** : fondu vers l'univers suivant sur les 90 m d'interpolation de couleur existants.

| # | Univers | Section existante | Palette | Éléments | Ambiance |
|---|---|---|---|---|---|
| 1 | **Aube numérique** | Signal Deck (0–500 m), accent cyan `#5ee7ff` | bleu nuit `#050b24` → bleu électrique `#2f8fcf` → turquoise `#8fcfd2` → or d'aube `#c99a74` ; brume `#0b1b36` | ciel en dégradé, soleil levant décentré avec deux halos, ligne d'horizon urbaine, flèches de verre aux arêtes lumineuses et sommets dorés, sol nocturne, grille et lignes lumineuses vers l'horizon, traînées de vitesse, impulsions | découverte, vitesse, énergie |
| 2 | **Cité des impulsions** | Data Tunnels (500–1200 m), accent violet `#a58bff` | violet profond `#12102c`, magenta `#ff4fd8` (tenu loin de la piste, le rose étant la couleur du BLOC), lavande | tours verticales hautes et serrées, bandeaux d'enseignes horizontaux (des aplats, jamais de texte), reflets simulés par un sol sombre à bandes, arches existantes en tunnel | rythme, mouvement, intensité |
| 3 | **Forêt synaptique** | Synaptic Garden (1200–2200 m), accent vert `#48efb7` | vert profond `#071c23`, émeraude, bleu-vert | troncs et branches lumineux (les branches et vrilles existantes servent de base), canopée de réseaux neuronaux en arcs **latéraux**, quelques lucioles fixes (≤ 12, pas de système de particules) | nature et intelligence |
| 4 | **Horizon fracturé** | Core Transit (2200–3500 m), accent orange `#ffbf70` | indigo `#231221`, rose crépuscule, orange (l'ambre des PORTIQUES reste exclusif à la piste : orange désaturé côté décor) | îlots flottants, cristaux, prismes, horizon cassé en plans décalés | vertige, exploration |
| 5 | **Cœur du Cortex** | Overdrive (3500 m +), accent magenta `#ff79dc` | violet `#210c2c` et or `#d9b45a` | circuits dorés au sol, grandes structures neuronales en anneaux **au-dessus de l'horizon** (jamais au-dessus des couloirs), impulsions lentes | conclusion monumentale |

Aucun nouveau mécanisme physique n'est nécessaire pour aucun des cinq univers.

### Architecture future proposée (non implémentée)

- Un module par univers (`world-<nom>.ts`), tous de même forme que `world-dawn.ts` :
  `create(scene, options) → { update(distance, timeMs, fade, haze), setReducedMotion, dispose }`.
- Un petit registre `worlds.ts` : index de section → fabrique d'univers et couleur de brume. Le renderer remplacerait
  alors `DAWN` / `firstHaze` par une recherche dans ce registre. C'est le seul endroit à généraliser : l'actuel
  `zone <= 1 ? firstHaze : …` deviendrait « brume de l'univers précédent → brume de l'univers courant ».
- Instanciation paresseuse : l'univers courant plus le suivant pendant le fondu, au plus deux à la fois. Le budget
  reste ainsi à ~4 appels supplémentaires, quel que soit le nombre d'univers.
- Les noms de section affichés (« Signal Deck »…) restent ceux de `sections.ts`. Afficher le nom d'univers serait une
  décision produit à part : le nom est annoncé aux lecteurs d'écran et lu par des tests.

## 5. Implémentation de l'univers 1 — « Aube numérique »

### Fichiers

| Fichier | Statut | Changement |
|---|---|---|
| `src/arcade/synapse-run/world-dawn.ts` | **créé** (266 lignes) | l'univers complet |
| `src/arcade/synapse-run/renderer.ts` | modifié (+34 / −2) | création protégée (try/catch), brume de la section 1, teinte des couloirs, appel `update`, mouvement réduit, libération |
| `src/arcade/synapse-run/main.ts` | modifié (+2 / −1) | `html[data-zone]` posé au changement de section (une ligne et un commentaire) |
| `public/arcade/synapse-run/foundation.css` | modifié (+8) | teintes d'aube du HUD, du pied de page, du libellé de zone et des menus en section 1 |

### Éléments visuels créés

**Maillage « backdrop »** : un seul mesh fusionné, non éclairé, qui suit la caméra, 876 sommets.

- **Ciel** : dégradé vertical sur l'arrière-plan à 120 m : brume jusqu'à 16 m, puis bleu profond, or d'aube,
  turquoise pâle, bleu électrique et bleu nuit au zénith.
- **Soleil levant** : disque or pâle (plus chaud en bas), décentré à droite pour garder dégagé le point de fuite de la
  piste, avec deux fins anneaux turquoise.
- **Ligne d'horizon** : 47 silhouettes de ville, à plus de 26 m de l'axe de chaque côté, légèrement plus
  claires que la brume. Quelques tours dépassent la brume et passent devant le soleil.
- **Sol nocturne** sous et autour de la piste ; **lit de piste** sombre visible entre les couloirs ; **10 lignes
  lumineuses** au sol (à ±8, 12,5, 18, 25 et 34 m) qui convergent vers l'horizon. Le brouillard de ces éléments est
  précalculé dans les couleurs de sommets : leur profondeur par rapport à la caméra ne change jamais, et la courbe
  utilisée est celle de la scène (smoothstep 30 → 95 m).

**Maillage « city »** : un seul `InstancedMesh` de boîtes unité, 158 instances, avec un dégradé d'ombrage de sommets
multiplié par la couleur de chaque instance.

- **24 flèches de verre** bleues, 8 à 15,5 m de haut, à 19–27 m de l'axe, tous les ~14 m.
- **48 arêtes lumineuses** cyan (deux par flèche, côté caméra), plus claires vers le haut.
- **24 sommets dorés** : « la première lumière du jour » sur les toits.
- **Grille au sol** : 36 traverses (tous les 8 m, de 6,5 à 36,5 m de l'axe).
- **16 traînées de vitesse** bleu électrique (fines, au-delà des rails à 4,05–4,6 m).
- **10 impulsions** qui filent le long des lignes au sol vers l'horizon. Elles entrent par derrière la caméra et
  s'allongent progressivement, donc sans apparition brusque.

**Couloirs** : bleus d'aube (`#15214a`, `#1b2a58`) et couloir actif `#1f3874` en section 1 ; les violets d'origine
reviennent pendant le fondu vers la section 2. Les rails et les séparateurs ne changent pas.

**Interface** : en section 1, le dégradé du HUD et du pied de page, le libellé de zone (turquoise `#9fe3ee`) et le cadre
des menus prennent les bleus d'aube. Les couleurs de texte et les commandes ne changent pas.

**Fin de l'univers** : les pièces ancrées dans le monde (flèches, grille, traînées) s'arrêtent à 500 m. Ensuite, le ciel
et le sol fondent vers la couleur de la section 2 pendant les 90 m existants, puis la couche est masquée. **Les
sections 2 à 5 se dessinent exactement comme avant**, avec les mêmes appels de dessin. Une nouvelle course recommence
en aube.

### Lisibilité

- Par construction, aucun élément ajouté ne peut masquer un obstacle, un éclat ou le joueur. Un objet situé
  latéralement au-delà des rails, ou sous la surface, est toujours **plus loin** sur le rayon de vue que tout élément
  de piste qu'il recouvre à l'écran. Le contrôle Node l'a vérifié pour toutes les instances visibles (plus petite
  distance à l'axe d'une pièce au-dessus du sol : 4,04 m ; rails jusqu'à 3,54 m).
- Rien ne clignote. La seule animation (les impulsions) est un déplacement continu, coupé en mouvement réduit.
- **Contraste** (luminance WCAG sur les couleurs de base, hors éclairage de scène, donc approximatif) :

  | Élément sur couloir (latéral / central / actif) | Avant | Aube |
  |---|---|---|
  | Bloc rose | 5,79 / 5,35 / 4,45 | 5,12 / 4,54 / 3,68 |
  | Arête claire du bloc | 13,0 / 12,0 / 10,0 | 11,5 / 10,2 / 8,3 |
  | Portique ambre | 10,0 / 9,3 / 7,7 | 8,9 / 7,9 / 6,4 |
  | Éclat | 14,4 / 13,3 / 11,0 | 12,7 / 11,3 / 9,1 |
  | Construct (cyan) | 12,0 / 11,1 / 9,3 | 10,6 / 9,5 / 7,7 |

  Tous les contrastes restent au-dessus de 3:1. Le pire cas (bloc sur couloir actif) passe de 4,45 à 3,68 ; le couloir
  actif garde un écart avec les autres au moins égal à l'original (1,24 contre 1,20). **C'est le point à regarder en
  priorité lors de l'essai.**

## 6. Choix de performance

| Mesure | Avant (GAME-7, mesuré) | Après (estimé, non mesuré) | Budget de revue |
|---|---|---|---|
| Appels de dessin, section 1 | 47–52 | +2 → ~49–54 | ≤ 60 (ouverture), ≤ 100 |
| Appels de dessin, sections 2–5 | inchangés | +0 (couche masquée) | |
| Géométries | 22 | 24 | ≤ 24 |
| Programmes de shaders | 2 | 4 | ≤ 4 |

- Géométries et matériaux sont créés une seule fois et libérés avec le renderer. Aucune allocation par image : objets
  réutilisés, comparaison de couleur sans allocation.
- Les placements sont recalculés **seulement quand une rangée change** (tous les 8, 9 ou 14 m). Par image, il ne reste
  que les 10 impulsions et un envoi de la matrice d'instances (158 × 64 octets).
- Les couleurs de sommets ne sont recalculées que pendant le fondu (≈ 6 s par course). En section 1, une seule fois.
- **Brouillard précalculé** : il évite un troisième programme de shaders.
- **Brume jusqu'à 16 m** : le décor lointain est recyclé là où le brouillard est total, donc dessiné couleur brume.
  Devant un ciel uniforme il était invisible ; devant un ciel en dégradé il apparaîtrait comme une forme sombre
  surgissant d'un coup. Le ciel reste donc couleur brume jusqu'au-dessus de tout sommet de décor (décor existant
  ≤ 13 m, flèches ≤ 15,5 m), et le soleil et ses anneaux sont placés hors de la bande latérale des flèches.
- **Rendu logiciel** (SwiftShader, llvmpipe…) : pas d'impulsions, donc aucun envoi d'instances par image en régime
  établi. Les dispositions « effets réduits » du CSS restent prioritaires.
- Aucun nouveau moteur, bibliothèque ou téléchargement : seul `mergeGeometries` des addons de three 0.170, déjà
  installé (le renderer utilisait déjà `RoundedBoxGeometry` des mêmes addons). Aucun GPU forcé, aucun drapeau WebGL.
- **Robustesse** : si l'univers ne peut pas être construit, le renderer garde l'apparence d'origine (try/catch) ; le jeu
  ne passe jamais en « Affichage 3D indisponible » à cause du décor.
- L'horloge de gameplay n'est pas touchée : les impulsions utilisent l'horodatage `requestAnimationFrame` déjà passé à
  `render()`, et le reste du décor dépend de la seule distance affichée.

## 7. Mouvement réduit

L'information arrive de l'hôte (`ARCADE_INIT {reducedMotion}`) et passe par `setReducedMotion`, comme pour le reste du
renderer. Activé, il coupe les traînées de vitesse et les impulsions. Le ciel, le soleil, l'horizon, les flèches, la
grille et les couloirs restent : le décor reste lisible, et ni les commandes ni la difficulté ne changent. Il n'y a
aucune animation CSS nouvelle. La caméra reste centrée et la foulée figée, comme avant.

## 8. Contrôles réalisés

| Contrôle | Résultat |
|---|---|
| TypeScript ciblé (`tsc --noEmit`, options de `tsconfig.json`, sur `main.ts` et `world-dawn.ts` et leurs imports) | **PASS** (exécuté deux fois, code 0) |
| `git diff --check` sur les fichiers Synapse Run | **PASS** |
| SHA-256 avant / après des 16 fichiers Synapse Run | 13 identiques ; seuls `renderer.ts`, `main.ts` et `foundation.css` diffèrent (attendu) |
| SHA-256 des 15 fichiers Filament (`src/arcade/filament/*.ts`, `public/arcade/filament/*`) | **15/15 identiques** |
| Diff de `main.ts` | une ligne modifiée et un commentaire (attribut `data-zone`) |
| Recherche d'API interdites dans `world-dawn.ts` (`Math.random`, réseau, stockage, minuteries, postMessage, import dynamique) | aucune (seule occurrence : le commentaire « no Math.random ») |
| Contrôle de construction en Node (`dawn-smoke.mjs`) | **PASS** : 158 instances, matrices finies, aucune pièce dans le volume de jeu, sommet max 15,09 m, rien après 500 m, couche masquée après le fondu, traînées et impulsions coupées en mouvement réduit, libération complète |
| Contraste des couleurs de base | calculé (§ 5) |
| Rien d'indexé (`git diff --cached`) | 0 fichier |

Le contrôle Node mérite une précision. Il exécute uniquement la construction des géométries et les placements, dans
un seul processus `node`, sans WebGL, navigateur ni GPU, en environ une seconde. Je l'ai jugé conforme à l'esprit des
« contrôles légers ciblés » : c'était le seul moyen de savoir, sans navigateur, que la fusion des géométries ne lève
pas d'exception. Le script est conservé dans la copie de sauvegarde.

**Non exécutés** : les suites de test existantes de Synapse Run. Les suites navigateur sont exclues par
`ARCADE_TEST_RULES.md` (SwiftShader ou GPU forcé). Les suites unitaires (`test-synapse-run-*-unit.mjs`) ne lisent
aucun fichier modifié : elles portent sur la simulation, les sections, les entrées, la progression et l'audio, dont les
fichiers sont identiques octet par octet. Les relancer ne prouverait rien de plus. `vite build` non exécuté.

Compteurs : simulation physique **0**, navigateur automatisé **0**, test GPU **0**, test visuel **non réalisé**.

## 9. Sauvegardes préservées

Aucune donnée utilisateur n'a été lue ou écrite. `progression.ts` et `foundation.js` sont identiques : même version
(1), mêmes clés, même validation, même sérialisation, mêmes messages vers l'hôte. Pas de migration, pas de
réinitialisation, pas de nouveau champ. L'univers n'a aucun état persistant.

## 10. Modules Docteur préservés

Aucun fichier en dehors des quatre fichiers ci-dessus. Restent intacts : Filament (24 niveaux, 4 décors, physique,
sauvegardes, textes, touches F/G, écrans de fin, scripts de calibration, lanceur sécurisé), Companion COMP-5 v1.1,
MAÎTRE, Root Policy V2, Notebook, Knowledge Graph, Docteur Memory, `Docteur-Launcher.bat`, guide PDF privé, hooks Git,
rapports et copies existants. Les modifications non commitées présentes au départ sont conservées telles quelles.
Docteur n'a pas été lancé et aucun processus n'a été arrêté.

**Copies** : `.tmp/synapse-run-visual-phase1-backup-2026-10-24/`

- `pre/` : `renderer.ts`, `main.ts`, `foundation.css` avant modification ;
- `post/` : les mêmes, plus `world-dawn.ts` ;
- `pre-hashes.txt`, `pre-filament-hashes.txt`, `dawn-smoke.mjs`.

Aucune copie antérieure supprimée.

## 11. Limites et éléments non testés

- **Aucun rendu vu.** Les couleurs (notamment la bande dorée, le soleil et l'intensité des lignes) sont choisies sur
  le papier. Elles peuvent paraître trop sombres, trop vives ou mal équilibrées : ce sont des constantes de `DAWN` dans
  `world-dawn.ts`, faciles à ajuster.
- Les budgets d'appels, de géométries et de programmes sont **estimés** à partir de la structure, pas mesurés. Si un
  test mesure plus tard 24 géométries et 4 programmes, c'est le plafond de revue exact.
- Le contraste du bloc sur le couloir actif baisse (4,45 → 3,68, approximatif, hors éclairage).
- Les silhouettes hexagonales existantes (gris-violet) et les branches vert-bleu des sections précédentes restent
  présentes en section 1 : elles n'ont pas été recolorées, pour ne toucher à aucun décor partagé.
- Le libellé de section reste « 1/5 · Signal Deck » : le renommer touche `sections.ts`, les annonces et des tests.
- L'apparition du décor au loin est conçue pour se faire dans la brume (§ 6), mais ce n'est pas vérifié à l'œil.
- Rendu logiciel, très grands rapports d'aspect (> 3,4:1) et portrait très étroit : non vus. En portrait étroit, le
  soleil décentré peut sortir du cadre ; c'est voulu, il est décoratif.
- Aucune suite de test existante relancée (voir § 8).

## 12. Procédure de validation manuelle

Si Docteur tourne déjà, il suffit de relancer Synapse Run depuis l'Arcade : le serveur de dev reconstruit `game.js` à
la demande quand un fichier du dossier change. Sinon, lancer Docteur comme d'habitude.

1. **Au menu « Prêt »** : ciel d'aube, soleil à droite, flèches aux arêtes cyan, grille et lignes au sol, couloirs bleus,
   HUD et cadre du menu en bleu d'aube.
2. **Fluidité** : courir 30 s environ ; aucune saccade nouvelle.
3. **Lisibilité** : blocs roses et portiques ambre immédiatement reconnaissables, **y compris sur le couloir actif** ;
   éclats bien distincts des traînées et des impulsions ; rails et limites nets.
4. **Sauts et glissades** : sauter un bloc, glisser sous un portique, changer de couloir : comportement identique.
5. **Passage des 500 m** : toast « Section 2 : Data Tunnels » ; le décor d'aube s'arrête, le ciel et le sol fondent vers
   le violet en ~90 m ; ensuite, aspect identique à avant.
6. **Fin de course** : distance, éclats, score, records et missions comme d'habitude ; « Rejouer » ramène l'aube.
7. **Mouvement réduit** (réglage système ou Docteur) : plus de traînées ni d'impulsions, le reste du décor demeure.
8. **Au loin** : surveiller toute forme sombre qui « surgit » à l'horizon. Si c'est le cas, noter où (au centre, sur les
   côtés, devant le soleil) : la cause et le réglage sont décrits au § 6.
9. Donner un avis sur l'équilibre des couleurs avant de commencer l'univers 2.

## 13. Git

Indexé : 0 · Commits : 0 · Pushes : 0. HEAD inchangé (`b9eeeb4`).
