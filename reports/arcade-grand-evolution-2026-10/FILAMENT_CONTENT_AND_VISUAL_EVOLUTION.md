# Filament — évolution du contenu et de la direction artistique (FILAMENT-2)

**Date :** 2026-10-23
**Verdict :** `FILAMENT_CONTENT_AND_VISUAL_EVOLUTION_IMPLEMENTED_AWAITING_MANUAL_CHECK`

Point de départ : la première version jouable (CH1-A et CH1-B) a été validée manuellement par l'utilisateur. Le jeu
s'ouvre et se joue correctement, mais il compte trop peu de niveaux et le décor ne correspond pas encore à l'ambiance
attendue.

Pendant cette mission : aucun commit, aucun push, aucun navigateur, aucun build, aucun benchmark. Trois exécutions
physiques courtes ont eu lieu sous le lanceur supervisé (§ 3). Aucun rapport historique n'a été modifié.

---

## 1. Ce qui est validé, et comment

| Élément | Lecture | Simulation supervisée | Essai réel dans le navigateur |
|---|---|---|---|
| CH1-A et CH1-B jouables, ouverture dans l'Arcade, commandes principales | oui | oui (rejeux précédents) | **oui, par l'utilisateur (mission précédente)** |
| Les 8 niveaux du chapitre 1 : solvables, 3 étoiles, ticks exacts, coupes nécessaires | oui | **oui, 8 sur 8 (§ 3.3)** | non |
| Géométrie de départ cohérente (aucun fil trop court) | oui | oui (contrôle pur, 8 sur 8) | non |
| Indulgence du timing des nouveaux niveaux | — | oui, mesurée (§ 2) | non |
| Nouveau décor, nouveau rendu, grille des niveaux, nouveaux textes | oui (`tsc` : 0 erreur) | non concerné | **non** |
| Bundle Vite de la nouvelle version | non exécuté | — | non |

## 2. Niveaux : le chapitre 1, « Jardins de l'Aube », en 8 niveaux

Les niveaux sont rangés par difficulté mesurée.

| # | Code | Titre | Éléments | Intention | Solution de référence | Victoire / étoiles (ticks) | Indulgence |
|---|---|---|---|---|---|---|---|
| 1 | CH1-A | Premier fil | 1 fil | apprendre à couper | coupe du fil 0 au tick 4 | 87 / 33, 54, 70 | aucune contrainte de timing (bille immobile) |
| 2 | **CH1-G** | Le rebond | 1 fil, 1 tremplin de cristal | découvrir le déflecteur sans contrainte de timing | coupe du fil 0 au tick 20 | 178 / 69, 107, 142 | ≥ ±8 ticks mesurés (bille immobile : en pratique libre) |
| 3 | CH1-D | Premier élan | balancier, entonnoir | premier timing, généreux, étoiles sur le balancement | coupe au tick 126 | 209 / 53, 92, 141 | −11 / +19 (relevé à la conception) |
| 4 | CH1-B | Le balancier | balancier, entonnoir | timing plus serré | coupe au tick 92 | 221 / 113, 130, 146 | −4 / +6 (relevé) |
| 5 | CH1-C | Deux fils | 2 fils en V | deux coupes, ordre et rythme | coupes au tick 12, puis au tick 138 | 206 / 71, 111, 162 | 1ʳᵉ coupe −120 / +25, 2ᵉ coupe −26 / +35 (relevé) |
| 6 | **CH1-H** | Le grand arc | long balancier, muret | passer par-dessus un obstacle | coupe au tick 100 | 178 / 123, 141, 159 | −4 / +5 (mesuré) |
| 7 | **CH1-I** | La faille | balancier, faille au sol | premier danger : survoler la faille | coupe au tick 84 | 157 / 106, 123, 139 | −4 / +4 (mesuré) |
| 8 | **CH1-J** | Le pont des étoiles | 2 fils, tremplin de cristal | finale : relais entre deux fils, puis rebond | coupes au tick 20, puis au tick 117 | 210 / 86, 128, 167 | 1ʳᵉ coupe libre ; 2ᵉ coupe au point bas ou un peu après (−1 / +8 mesuré sur l'écart entre les deux coupes) |

Notes sur la lecture du tableau :

- **Unité de temps :** 1 tick dure 1/120 s, donc 10 ticks font environ 83 ms.
- **Indulgence :** c'est le décalage possible, en ticks, de chaque coupe, les autres étant fixes, pour gagner encore.
  « Mesuré » signifie mesuré dans cette mission avec `tolerance()`, plafonné à ±8 ticks. « Relevé » signifie relevé
  dans le journal de conception du 22/10.
- **Progression :**
  - niveaux 1 et 2 : découverte, sans contrainte de timing ;
  - niveaux 3 et 4 : premier timing, d'abord généreux puis plus serré ;
  - niveau 5 : deux coupes, avec des fenêtres larges ;
  - niveaux 6 à 8 : obstacle, danger, puis combinaison des deux.

  Aucun niveau aléatoire : toutes les trajectoires sont déterministes.
- **Niveaux 6, 7 et 8 :** ils demandent le même timing que CH1-B, que l'utilisateur a joué sans signaler de
  difficulté excessive. Ce point reste à confirmer en jeu réel.

### Provenance

- **CH1-A et CH1-B :** inchangés, avec les mêmes données que les fixtures rejouées.
- **CH1-C et CH1-D :** brouillons du 22/10 (`.tmp/filament-design-preserved-2026-10-22/ch1.mjs`, `ee21a65e…`).
  Leurs solutions et étoiles viennent du journal de conception :
  - CH1-C : ligne 5036 ;
  - CH1-D : ligne 5056, deuxième disposition d'étoiles, choisie pour sa fenêtre plus large.
- **CH1-G, H, I et J :** nouveaux. Leur conception est **constructive**, sans aucune recherche :
  1. la solution nominale est choisie d'après la période du pendule (par exemple, coupe au point bas) ;
  2. on trace la trajectoire réelle ;
  3. on place la cible là où la trajectoire franchit une ligne choisie ;
  4. on place les trois étoiles sur cette même trajectoire ;
  5. on rejoue le niveau une fois, puis on mesure l'indulgence.

### Brouillons écartés

| Brouillon | Raison |
|---|---|
| CH1-E | géométrie impossible : les zones atteignables par les fils 0 et 2 ne se recoupent pas (centres distants de 450, alors que 130 + 300 = 430). La bille commencerait par un saut, puis resterait coincée entre deux contraintes contradictoires |
| CH1-F | fil 1 trop court de 146 au départ : la bille sauterait dès la première image |
| Chapitre 2 (g à q) | seules des statistiques de balayage sans étoiles existent, sans solution enregistrée ; certaines variantes ne gagnent jamais |

## 3. Exécutions supervisées (lanceur `filament-safe-run.mjs`, une à la fois, au premier plan, sans relance)

Les trois exécutions ont eu les mêmes conditions et la même fin :

- démarrage après le handshake mémoire, avec un enfant mesuré à 41 Mo ;
- verrou libéré à la fin ;
- aucun processus restant ;
- `memoryStatus` : `STARTUP_ONLY_MEASURED`.

### 3.1 Conception, première exécution (`scripts/filament-design-ch1-extension.mjs`, première version)

- **Contenu :** conception de G, H, I et J, puis un rejeu chacun de C et D.
- **Code de sortie :** 30, car J n'a pas convergé (voir ci-dessous).
- **Ressources :** 89 candidats, 16 072 pas, 37 ms de simulation, 897 ms au total.
- **Résultats :**
  - G, H et I : `WON`, 3 étoiles ;
  - C et D : `WON`, 3 étoiles ;
  - J : aucune traversée de la ligne de cible. La trajectoire finit hors écran en (447, 564), parce que le tremplin
    montait vers la droite : sa normale renvoyait la bille vers la gauche.

### 3.2 Conception, deuxième exécution (même fichier, réduit à J, pente du tremplin inversée, trace grossière affichée)

- **Code de sortie :** 0.
- **Ressources :** 44 candidats, 9 771 pas, 20 ms, 554 ms au total.
- **Résultat :** J donne `WON` avec 3 étoiles. La trace confirme le trajet : balancement, point bas vers le tick 120,
  vol, tremplin, puis cible.

Le fichier actuel contient seulement la version de la deuxième exécution. Celle de la première exécution n'existe que
dans l'historique de la session.

### 3.3 Vérification du chapitre livré (`scripts/filament-verify-chapter1.mjs`)

Le script lit **exactement** les objets que lit le jeu (`src/arcade/filament/chapter1.ts`).

- **Code de sortie :** 0.
- **Ressources :** 16 candidats, 6 246 pas, 26 ms, 562 ms au total.
- **Résultat : 8 niveaux sur 8 PASS.** Pour chaque niveau :
  - la géométrie est cohérente ;
  - le niveau est gagné avec 3 étoiles ;
  - le tick de victoire et les ticks des étoiles sont exactement ceux du tableau ;
  - sans aucune coupe, le niveau n'est pas gagné (`UNRESOLVED`).

**Budgets :**

- le plafond par session reste à 2 000 candidats, 200 000 pas et 8 s, et n'a pas été relevé ;
- le plafond par candidat était de 720 pas pour la conception et de 600 pour la vérification.

Aucune grille complète n'a été utilisée. Il n'y a eu ni `scan`, ni `scanSummary`, ni exploration de variantes. La
mesure de tolérance a demandé au plus 33 ou 65 essais par niveau.

## 4. Direction artistique (`renderer.ts` réécrit, CSS revue)

**Ciel et décor :**

- **ciel qui évolue d'un niveau à l'autre :** du bleu nuit profond (niveau 1) vers l'aube (niveau 8), par interpolation
  de quatre teintes jusqu'à un horizon pêche et rose ;
- **nébuleuses :** violette et turquoise, avec une lueur rose qui grandit avec l'aube ;
- **étoiles :** 110 étoiles décoratives de tailles variées, les 6 plus brillantes avec un fin éclat en croix, et une
  constellation discrète. Les étoiles faibles pâlissent avec l'aube ;
- **lune :** un croissant entouré d'un halo, qui s'efface avec l'aube.

**Paysage et profondeur :**

- **plans de relief :** trois plans, plus sombres et plus nets vers l'avant, avec une brume entre le plan lointain et
  le plan intermédiaire et une lueur d'aube sur l'horizon ;
- **jardin :** deux arbres ronds et 34 touffes d'herbe dont certaines portent des bourgeons lumineux. Les arbres sont
  placés hors de portée de toutes les cibles ;
- **vignette :** un léger assombrissement des bords.

**Éléments de jeu**, par ordre de mise en avant : bille, puis cible, étoiles, fils, obstacles et décor.

- **bille :** halo qui respire doucement, cœur dégradé, reflet ;
- **cible :** « fleur de lumière » à six pétales qui tournent lentement, avec anneaux et cœur, et une floraison
  bornée à la victoire (18 éclats, 1,1 s) ;
- **étoiles :** halo doux, cœur clair, légère oscillation ;
- **fils :** cœur lumineux et halo ; ancres en forme de petite lanterne ;
- **obstacles :**
  - murs en pierre lavande, avec une ombre et un liseré clair ;
  - tremplins en cristal turquoise ;
  - faille rouge lumineuse et pointillée, avec un léger scintillement.

**Interface :**

- **panneaux :** opaques, avec un dégradé nuit et un liseré doré, sans flou ;
- **boutons :** en pilule ; bouton « Couper le fil » doré ;
- **grille des 8 niveaux :** chaque case donne le numéro, le nom et les étoiles obtenues pendant la partie. Le bouton
  principal propose de continuer au premier niveau non réussi ;
- **fin du chapitre :** un écran récapitule les étoiles de la partie.

**Confort :**

- en mouvement réduit, aucune animation : ni scintillement, ni rotation, ni pulsation, ni traînée, ni effet de coupe
  ou de floraison. Le décor reste complet ;
- aucun effet agressif, aucun flash.

**Ressources :**

- **contextes :** 2 contextes, créés une seule fois ;
- **fond :** repeint seulement au redimensionnement, au changement de niveau (aube) ou au changement du mode mouvement
  réduit ;
- **dessin :** dégradés et formes construits une fois ; tampons fixes (traînée de 24 points, 18 éclats) ;
- **interdits respectés :** ni `shadowBlur`, ni filtre, ni WebGL, ni dépendance nouvelle.

## 5. Fichiers

### Créés pendant cette mission

| Fichier | SHA-256 (16 premiers caractères) |
|---|---|
| `src/arcade/filament/chapter1.ts` (données des 8 niveaux, aucun import) | `fe2b5c6ea3b71cb1` |
| `scripts/filament-design-ch1-extension.mjs` (conception constructive) | `54df5a1a5f962682` |
| `scripts/filament-verify-chapter1.mjs` (vérification du chapitre livré) | `9b3330ecb2c2db4a` |

### Modifiés, non suivis par Git

| Fichier | SHA-256 (16 premiers caractères) |
|---|---|
| `src/arcade/filament/levels.ts` (lit `chapter1.ts`) | `b081f0263ac07f5a` |
| `src/arcade/filament/renderer.ts` (direction artistique) | `b5f30ff42840e27b` |
| `src/arcade/filament/main.ts` (grille, aube, floraison, textes) | `7a0ea912ed3dd523` |
| `public/arcade/filament/index.html` (conteneur de la grille, pied de page) | `ac37955fdf5764ef` |
| `public/arcade/filament/filament.css` | `c4ee5a9e8169195f` |
| `scripts/filament-safe-run.mjs` (+2 chemins exacts dans `APPROVED_SCRIPTS` ; rien d'autre) | `b8548c3eced0adeb` |
| `scripts/test-filament-game-unit.mjs` (8 niveaux ; préparé, non exécuté) | `98d226fe0d29bf17` |

### Modifiés, suivis par Git (déjà modifiés auparavant)

| Fichier | Modification |
|---|---|
| `src/lib/arcade/registry.ts` | description : « premier chapitre de huit niveaux » |
| `src/content/capabilities.ts` | même phrase dans l'aide |

### Inchangés

- `physics.ts` : `733fd835…` ;
- `filament-lab-lib.mjs` : `d2eeb599…` ;
- le bootstrap : `633be06b…`, égal à `BOOTSTRAP_SHA256` ;
- `session.ts`, `loop.ts`, `input.ts`, `host.js` et le plugin de bundle ;
- les fixtures de CH1-A et CH1-B.

Copie de sécurité : `.tmp/filament-content-visual-backup-2026-10-23/` (18 fichiers, `SHA256SUMS.txt` 18 sur 18 OK).

## 6. Sécurité et intégrité

| Élément | État |
|---|---|
| Synapse Run | 0 modification |
| Companion | `16f12cbe`, `0c957f4a` |
| MAÎTRE | `511c8a3d`, `7de23e22` |
| Root Policy | `a8e4f7b5` |
| `Docteur-Launcher.bat` | `cd1871b6` |
| Notebook et Knowledge Graph | non touchés |
| Guide privé | 121 fichiers ; hooks `pre-commit` et `pre-push` présents |
| Copies `.tmp` précédentes | toutes intactes (23 sur 23, 2 sur 2, 3 sur 3, 19 sur 19 ; 7 brouillons) |
| Bac à sable et CSP | inchangés |
| Nouvelles API dans le jeu | aucune : ni réseau, ni stockage, ni `innerHTML` ; la grille est créée avec `createElement` et `textContent` |
| Boucle de jeu | inchangée : au plus 4 pas par image, tentatives de 60 s au plus |
| Git | HEAD `b9eeeb4` ; 0 fichier indexé ; 33 fichiers suivis modifiés (ensemble inchangé par cette mission) ; 0 commit ; 0 push |

## 7. Contrôles statiques

- `tsc` ciblé : 0 erreur (83 fichiers, 0,41 s).
- `node --check` : 5 fichiers sur 5 OK.
- `git diff --check` : propre.
- Aucun espace en fin de ligne.
- Recherche d'API interdites dans le jeu : aucune.

## 8. Reste à valider

1. **Un essai manuel court par l'utilisateur, dans le navigateur habituel.** Il doit couvrir :
   - le nouveau décor : lisibilité et agrément ;
   - la grille des niveaux ;
   - au moins les niveaux 2 (rebond), 6 (muret), 7 (faille) et 8 (finale) ;
   - la fin du chapitre.
2. **Le ressenti de difficulté des niveaux 6 à 8**, dont la fenêtre d'environ 9 à 10 ticks est comparable à CH1-B.
   Au besoin, examiner séparément une aide au timing (repère au point bas, par exemple) plutôt que de modifier la
   physique.
3. **Le coût de rendu du nouveau décor** sur cette machine : seulement observé par l'utilisateur, sans benchmark. Le
   fond est mis en cache, mais l'image par image dessine un peu plus d'éléments qu'avant.
4. **Les tests préparés et jamais exécutés** : `test-filament-game-unit.mjs`, `test-arcade-unit.mjs` et
   `test-arcade-browser.mjs`.
5. **La sauvegarde de progression**, toujours absente : les étoiles ne sont gardées que pendant la partie.
