# Filament — Chapitre 4 « Lisière du Crépuscule » — conception et intégration

Date : 2026-10-24 · Dépôt : `C:\dev\Docteur` · HEAD : `b9eeeb4` (inchangé) · Point de départ : `DOCTEUR_FILAMENT_CH3_E_FAN_REDESIGN_V2_CHECKPOINT`

**Verdict : `FILAMENT_CHAPTER_4_IMPLEMENTED_AWAITING_PHYSICS_VALIDATION`**

| Mesure | Valeur |
|---|---|
| Niveaux jouables, au départ | 19 |
| Niveaux jouables, à la fin | **19** (sur les 24 prévus) |
| Niveaux 20 à 24 | 5 **spécifications** « En préparation », **aucune validée** |
| Simulations physiques, scripts de calibration exécutés, tests GPU, navigateurs | 0 |
| Moteur `physics.ts` | inchangé (`733fd835`) |

> **Aucune coordonnée, cible ou étoile de ce chapitre n'a été simulée.** Ce sont des hypothèses de conception, calculées à la main. Les niveaux 9 à 19 n'ont pas non plus été essayés dans le navigateur.

---

## 1. État initial

- **19 niveaux intégrés** :
  - chapitre 1 « Jardins de l'Aube », niveaux 1 à 8 ;
  - chapitre 2 « Courants d'Altitude », niveaux 9 à 14 ;
  - chapitre 3 « Vergers Stellaires », niveaux 15 à 19.
- **Niveau 19** : il venait d'être validé physiquement, avec un seul lancement supervisé de 3 trajectoires et 664 pas.
- **Fin du chapitre 3** : l'écran annonçait le chapitre 4 par du texte seulement. Il n'y avait ni onglet ni tuile.
- **Empreintes au départ** :
  - `chapter3.ts` `b730adf6`, `levels.ts` `95a5ca5e`, `main.ts` `bdae8563`, `renderer.ts` `4ee9790f` ;
  - test préparé `3cc14bec` ;
  - lanceur `c79bae3b`.
- **Dépôt** : 33 fichiers suivis modifiés (préexistants), 0 indexé.

## 2. Capacités réelles du moteur (audit de `physics.ts`, non modifié)

| Mécanique | Disponible | Remarque |
|---|---|---|
| Fils | oui | Contrainte inextensible, détendable ; seule action : `CUT` |
| Murs et cristaux (`segments`) | oui | La restitution n'utilise que les contacts de la dernière passe de projection : **aucun rebond ne doit être nécessaire** |
| Picots (`pegs`) | oui | Disque solide, restitution 0,45 |
| Failles (`rifts`) | oui | Défaite à moins de 21 unités |
| Courants constants | oui | Boîte, accélération (ax, ay), centre de la bille dans la boîte |
| Courants cycliques (`timing`) | oui | Actifs si `(tick + phase) % period < on` ; anneau de rythme dessiné |
| Ventilateurs (`fan`) | oui | `TOGGLE` allumé ↔ éteint, **dans les deux sens**, quel que soit l'état de départ |
| Puits (`wells`) | oui | Attraction `S·(1 − d/R)` vers le centre, entre 2 et R |
| Vitesse initiale (`orbVelocity`) | oui | Non utilisée |
| Ressorts, plateformes mobiles, inversion de gravité, action sur un puits ou un courant cyclique, collisions spéciales | **non** | Rien de tout cela n'est utilisé ni simulé dans les niveaux |

Si un courant a à la fois `timing` et `fan`, il se comporte comme un ventilateur seulement (`currentActive`).

**Défaites** : faille, sortie (y > 560, x < −80, x > 880, y < −400), immobilisation 1,5 s, vol libre de plus de 12 s.

## 3. Direction artistique — thème `crepuscule`

Il est implémenté dans `renderer.ts`, en Canvas 2D seulement : pas de WebGL, pas d'image distante, pas de bibliothèque. Le décor est peint sur le calque de fond, et seulement de temps en temps.

1. **Ciel et horizon** : un dégradé orange doux, rose poudré, violet, bleu nuit et indigo, qui **s'assombrit de niveau en niveau** (paramètre `dawn` = avancement dans le chapitre). Le niveau 20 est un coucher de soleil, le niveau 24 la première nuit. Un **soleil très bas** se tient derrière les montagnes et descend un peu à chaque niveau, avec un halo et sept rayons doux, fixes.
2. **Silhouettes** : des montagnes lointaines qui masquent la moitié du soleil, et trois îles suspendues dont le bord est doré côté soleil.
3. **Brumes** : des bandes roses et violettes entre les plans.
4. **Constellations naissantes** : les étoiles restent dans le haut du ciel et sont de plus en plus visibles (0,25 + 0,75 × avancement). Trois fragments de constellations se précisent au fil du chapitre.
5. **Végétation et cristaux** : deux arbres en silhouette avec un liseré doré, des touffes dont les pointes sont dorées ou turquoise, et deux grappes de cristaux opalescents (rose, lilas, turquoise). Tout reste sous la ligne du sol de l'aire de jeu.
6. **Premier plan de jeu** (palette `CREPUSCULE`) :
   - fils blancs chauds avec un halo doré ;
   - ancres, halo d'arrivée, vents et anneaux des ventilateurs en **turquoise** ;
   - étoiles dorées, cristaux opalescents, murs de pierre aux arêtes dorées, pierres sombres cerclées d'or ;
   - un **liseré sombre** autour des éléments de jeu, pour la lisibilité sur l'horizon clair, comme pour le thème d'altitude.

**Animation** : seulement hors mouvement réduit, et bornée. On anime les 14 étoiles scintillantes partagées, limitées au haut du ciel, et au plus **8 lucioles** par image, sans allocation. **En mouvement réduit**, la scène est complète et statique : toutes les étoiles sont peintes dans le calque et aucune animation ne tourne.

**Thèmes existants** : le scintillement est désormais calculé par `twinkleFade()`, avec des valeurs identiques pour `aube` et `verger`, et toujours aucun scintillement pour `altitude`. Les palettes sont regroupées dans `PALETTES` et gardent les mêmes objets.

## 4–7. Les cinq niveaux : mécaniques, géométries provisoires et risques

Méthode retenue d'après les chapitres 1 à 3 :

- partir de tronçons de **vol libre déjà mesurés** par un lancement supervisé, jamais de positions relevées après un contact (erreur de CH3-E v1) ;
- un niveau **en miroir** (x → 800 − x) garde la trajectoire mesurée exacte, puisque la gravité est verticale ;
- aucune solution ne dépend d'un rebond ;
- les astres ne sont placés qu'**au-dessus** du vol ou en direction du vol ;
- les colonnes ascendantes sont assez larges et placées assez tôt sur le trajet (leçons de CH3-D et CH3-E).

### Niveau 20 — `ch4-a` « Le dernier rayon » (accessible)

- **Mécaniques** : balancier et coupe ; courant ascendant constant (le « rayon ») ; pilier à contourner par le haut ; faille.
- **Base** : le balancier validé de CH3-B, **en miroir**. Son vol libre a été mesuré : (297, 264) au tick 114 et (363, 337) au tick 138.
- **Géométrie** :
  - bille : `pend(620, 60, 150, 60)` ≈ (749,9, 135) ;
  - rayon : `{ 370, 200, 150 × 230, ax 0, ay −1700 }` ;
  - pilier : `seg(330, 340, 330, 500)` ;
  - faille : (340→600, 485).
- **Action supposée** : `cut(82, 0)` · **règle de placement** : x = 160.
- **Estimation** : entrée dans le rayon vers (520, 250), sortie vers (370, ≈ 281) en remontant, passage du pilier vers y ≈ 274 (sommet du pilier à 340). **Cible envisagée ≈ (160, 390).**
- **Risques** : la vitesse vient d'une seule mesure ; une sortie plus basse que prévu ferait toucher le haut du pilier.
- **Décor** : soleil bas à droite, d'où part la bille ; rayon doré ; pilier aux arêtes dorées.
- **Différence avec « Premier souffle »** : un balancier plutôt qu'une bille au repos, un courant vertical plutôt qu'horizontal, et un obstacle à contourner.

### Niveau 21 — `ch4-b` « Les ombres mouvantes » (modérée)

- **Mécaniques** : deux fils en V, avec un ordre de coupe ; vent cyclique horizontal qui fait planer la bille ; deux pierres fixes à éviter ; faille.
- **Base** : départ inédit, **sans aucun tronçon mesuré**.
- **Géométrie** :
  - bille : (200, 170) ;
  - fils : (120, 60) et (280, 60), chacun de longueur √(80² + 110²) ≈ 136 ;
  - vent : `{ 300, 150, 340 × 180, ax 700, ay −900, timing 240 / 140 / phase 160 }`, actif des ticks 80 à 219 ;
  - pierres : (470, 170) et (560, 320), rayon 14 ;
  - faille : (300→640, 485).
- **Actions supposées** : `cut(20, 0)`, puis `cut(95, 1)` au plus bas · **règle** : x = 720.
- **Estimation** : le bas du balancement est en (280, 196) vers le tick 95, à ≈ 216 u/s. La bille vole à plat (poussée verticale nette nulle) et sort vers (640, ≈ 261). **Cible envisagée ≈ (720, 276)**, avec ≈ 26 ticks de marge de chaque côté de la fenêtre du vent.
- **Risques** :
  - la période du balancier et l'instant de la coupe sont à mesurer ;
  - une bille tenue qui dépasse le bas du balancement entre dans la zone de vent ;
  - une pierre touchée rebondit au hasard, mais elle n'est jamais nécessaire à la solution.
- **Le nom** désigne un effet **visuel** : les traînées du vent cyclique. Aucun obstacle ne bouge.

### Niveau 22 — `ch4-c` « Entre deux horizons » (modérée)

- **Mécaniques** : balancier et coupe ; astre **au-dessus** du vol, qui porte la bille et la lance ; colonne ascendante constante ; trois étoiles sur un arc ; faille.
- **Base** : la première moitié validée de CH3-C, c'est-à-dire le balancier de CH3-B et l'astre A `{ 360, 190, R 160, S 2600 }`. Points mesurés : (304, 254) au tick 113 et (397, 290) au tick 135. Le second astre de CH3-C est remplacé par une colonne.
- **Géométrie** :
  - colonne : `{ 440, 250, 180 × 220, ax 0, ay −1900 }` ;
  - faille : (300→620, 485).
- **Action supposée** : `cut(82, 0)` · **règle** : x = 700.
- **Estimation** : entrée dans la colonne vers (440, ≈ 309), sortie vers (620, ≈ 327) en remontant. **Cible envisagée ≈ (700, 315).**
- **Risques** :
  - entre x 410 et 440, la trajectoire n'est plus celle qui a été mesurée ;
  - l'astre tire encore vers le haut et l'arrière à l'entrée de la colonne ;
  - le balancier tenu entre dans le rayon de l'astre s'il dépasse le bas, comme dans CH3-C ;
  - si la sortie est trop haute, la bille passe au-dessus du halo et quitte l'écran.

### Niveau 23 — `ch4-d` « Les fils du crépuscule » (avancée)

- **Mécaniques** : relais entre deux fils, avec un ordre et un instant de coupe ; **deux ventilateurs aux rôles opposés** ; mur à franchir ; faille.
- **Base** : le relais validé de CH1-J / CH3-E, **en miroir**. Son vol libre ventilateur éteint a été mesuré jusqu'au tick 196.
- **Géométrie** :
  - bille : (650, 160) ;
  - fils : (650, 60) longueur 100 et (470, 60) longueur 206 ;
  - **vent contraire allumé au départ** : `{ 360, 230, 80 × 170, ax +1600, ay 0, boîtier (430, 478) }` ;
  - **ventilateur ascendant éteint** : `{ 150, 260, 180 × 220, ax −120, ay −2000, boîtier (240, 478) }` ;
  - mur : `seg(110, 400, 110, 500)` ;
  - faille : (110→400, 485).
- **Actions supposées** : `toggle(10, 0)` (vent contraire éteint), `toggle(14, 1)` (ventilateur ascendant allumé), `cut(20, 0)`, `cut(117, 1)` · **règle** : x = 55.
- **Estimation** : entrée dans la colonne vers (330, ≈ 317) au tick ≈ 157, sortie vers (150, ≈ 349) en remontant, passage du mur vers y ≈ 341. **Cible envisagée ≈ (55, 345).**
- **Risques** :
  - quatre actions ;
  - la cible est près du bord gauche (x − r ≈ 21) ;
  - la marge au-dessus du mur n'est que de ≈ 37 ;
  - l'effet du vent contraire laissé allumé n'a été évalué qu'à la main.

### Niveau 24 — `ch4-e` « Au-delà de la lisière » (grande finale)

- **Mécaniques** :
  - une bille au repos, qu'on coupe quand on veut ;
  - un **ventilateur** à allumer, qui relance la bille ;
  - un **astre** qui porte l'arc ;
  - une **dernière rafale cyclique** ;
  - un **mur final** ;
  - une faille sur tout le sol.
- **Base** : le départ et l'arc mesurés de CH2-E / CH3-D. Ils sont identiques pendant le passage dans la colonne : ventilateur allumé dès le tick 10, ou colonne cyclique qui souffle des ticks 40 à 159. Points mesurés : (259, 237) au tick 106, (372, 168) au tick 157, (511, 192) au tick 206. L'astre est celui de CH3-D, `{ 640, 140, R 200, S 2400 }`.
- **Un seul élément nouveau** : la rafale `{ 580, 140, 180 × 190, ax 0, ay −1500, timing 300 / 120 / phase 90 }`, active des ticks 210 à 329, puis 510 à 629, et ainsi de suite.
- **Autres éléments** : mur `seg(700, 280, 700, 500)` ; faille (120→700, 485).
- **Actions supposées** : `toggle(10, 0)`, `cut(30, 0)` · **règle** : x = 745.
- **Estimation** : entrée dans la rafale vers (580, ≈ 220) au tick ≈ 228, passage du mur vers y ≈ 225 (sommet du mur à 280). **Cible envisagée ≈ (750, 220).** Sans rafale, la bille arrive vers y ≈ 290 et heurte le mur.
- **Pourquoi la victoire est juste** : chaque élément a un rôle visible.
  - Le ventilateur relance la bille : sans lui, elle tombe dans la faille.
  - L'astre tient l'arc.
  - La rafale, réglée par l'**instant de la coupe**, fait passer le mur.
- **Risques** :
  - la rafale chevauche le rayon de l'astre, et les deux forces se combinent : c'est le calcul à la main le moins sûr de tout le chapitre ;
  - la cible est près du bord droit (x + r ≈ 784) ;
  - la largeur de la fenêtre de coupe est à mesurer.
- **Contrôles futurs exigés** : ventilateur jamais allumé, puis coupe hors du souffle de la rafale. Les deux doivent finir en défaite.

**Contrôles statiques des données (sans simulation)** : départ de chaque bille à la longueur de son fil, hors de tout courant, de tout rayon d'astre et de tout picot ; ni cible ni étoile ; au plus 8 courants, 8 actions et 4 astres ; l'aperçu n'affiche ni étoile ni cible. Tous **OK**.

## 8. Fichiers créés ou modifiés

| Fichier | Avant → après | Changement |
|---|---|---|
| `src/arcade/filament/chapter4.ts` | nouveau, `ccddd6a9` | Les 5 spécifications et le type `Chapter4Spec` (avec un champ `decor`) ; aucun import |
| `src/arcade/filament/levels.ts` | `95a5ca5e` → `9d4756af` | `ChapterId` + `ch4`, `ChapterTheme` + `crepuscule`, chapitre 4 dans `FILAMENT_CHAPTERS`, `PLANNED_LEVELS = 24`, spécifications ajoutées à `PENDING_LEVELS`. **`FILAMENT_LEVELS` est inchangé** |
| `src/arcade/filament/renderer.ts` | `4ee9790f` → `39a684c4` | Thème `crepuscule`, palette `CREPUSCULE`, `PALETTES`, `twinkleFade()`, lucioles, liseré doré des pierres (ce thème seulement) |
| `src/arcade/filament/main.ts` | `bdae8563` → `a8b5d96a` | Fin du chapitre 3 recâblée sur le vrai chapitre 4 ; écran final préparé ; `ANNOUNCED_CHAPTER` supprimé ; `PLANNED_LEVELS` importé |
| `scripts/test-filament-game-unit.mjs` | `3cc14bec` → `8aba4525` | 4 chapitres, 5 spécifications en attente, 24 identifiants uniques, aucun dans les niveaux jouables, garde statique étendue à `chapter3.ts` et `chapter4.ts`. **Non exécuté** |
| Rapport | nouveau | Ce document |

**Fichiers inchangés** : `physics.ts`, `chapter1.ts` à `chapter3.ts`, `progress.ts`, `session.ts`, `input.ts`, `loop.ts`, `host.js`, `index.html`, `filament.css`, le lanceur et sa liste blanche, le bootstrap et la lib.

## 9. Navigation

- **Onglets** : un quatrième onglet, « Chapitre 4 · Lisière du Crépuscule », est créé automatiquement à partir de `FILAMENT_CHAPTERS`.
- **Tuiles** : cinq tuiles **« En préparation »** (20 à 24), marquées `aria-disabled` et `data-pending`. Un clic n'affiche qu'un message (« … est en préparation »), sans rien démarrer.
- **Aperçu** : l'onglet affiche le décor de `ch4-a` sans cible ni étoile, et ne lance jamais la simulation. Il indique : « Chapitre 4 · Lisière du Crépuscule · 5 niveaux (20 à 24) en préparation… ».
- **Bouton Continuer** et compteurs : ils ne voient que les 19 niveaux jouables.

## 10. Transition depuis le chapitre 3

- Le kicker reste **« Fin du chapitre 3 — Le cœur du verger »**. Il est désormais produit par la règle « aucun niveau jouable ne suit », et non plus par le chapitre annoncé en dur.
- Le titre reste « Les Vergers Stellaires sont traversés ».
- Texte : « La suite, le chapitre 4 « Lisière du Crépuscule » (niveaux 20 à 24), est en préparation : il s'ouvrira après la validation de ses niveaux. 19 niveaux sur 24 sont jouables. »
- Boutons : « Rejouer ce niveau », **« Aperçu du chapitre 4 »** (ouvre l'onglet du chapitre 4 sur l'écran titre) et « Menu ». Aucun bouton ne lance de niveau.
- La **touche N** reste sans effet après le niveau 19, car `getLevel(19)` vaut `null` (`main.ts`, `case 'NEXT'`).
- **Écrans de fin des chapitres 1 et 2 : inchangés.** Le chapitre 2 a un niveau jouable à suivre, donc il garde le kicker « Fin du chapitre 2 » et propose toujours « Chapitre 3 · La première orbite ».

## 11. Fin du jeu

L'écran **« Filament — Les 24 fils du voyage »** est préparé dans `finishAttempt` :

- kicker « Fin du chapitre 4 — *titre du niveau* » ;
- étoiles du niveau et du voyage entier ;
- boutons « Rejouer ce niveau » et « Menu ».

Il ne s'affiche que si **toutes** ces conditions sont réunies : aucun chapitre ne suit, `FILAMENT_LEVELS.length === 24` et `PENDING_LEVELS.length === 0`, au moment où l'on gagne le dernier niveau d'un chapitre complet. Il est **impossible aujourd'hui** : seuls 19 niveaux sont jouables et aucun niveau du chapitre 4 ne peut être gagné.

## 12. Sauvegardes

- `progress.ts` est inchangé (`ad6bdbf3`), ainsi que `host.js`, `filament-progress-v1` (saveVersion 1) et la clé IndexedDB.
- La session de progression est construite à partir de `FILAMENT_LEVELS` (`main.ts`). Cette liste est identique : 19 niveaux, mêmes identifiants, mêmes numéros, même ordre.
- Les sauvegardes existantes, leurs étoiles, les déverrouillages et « Continuer » se comportent donc exactement comme avant.
- Les identifiants `ch4-a` à `ch4-e` sont nouveaux et stables. Ils n'entreront dans la sauvegarde qu'après leur validation, et les anciennes sauvegardes resteront valides.
- Aucune donnée n'a été lue, migrée ou effacée.

## 13. Contrôles statiques réalisés

| Contrôle | Résultat |
|---|---|
| TypeScript ciblé (tsc, racine `main.ts`, strict, qui couvre `levels.ts`, `chapter4.ts` et `renderer.ts`) | **PASS** (exit 0) |
| `node --check scripts/test-filament-game-unit.mjs` | PASS |
| Données (import des modules de niveaux seulement, sans le moteur et sans aucun pas) | 4 chapitres ; 19 jouables numérotés 1 à 19 ; 5 en attente (20 à 24, `ch4`) ; 24 identifiants uniques ; règles de départ OK pour les cinq |
| `git diff --check` (fichiers suivis) | propre |
| Espaces en fin de ligne dans les fichiers touchés | 0 ; fins de ligne CRLF comme les fichiers voisins |
| Format de progression | inchangé (voir § 12) |
| Liste blanche du lanceur | lue seulement : 17 scripts, dont `ch3-e-v2` ; **aucun script ch4** (il n'en existe aucun) ; ni `filament-design-ch2.mjs` ni le module commun |
| Statut Git | voir § 16 |

## 14. Non testé

- **Aucune simulation** des niveaux 20 à 24 : aucune cible ni étoile n'est prouvée atteignable.
- **Test unitaire préparé non exécuté** (il crée des tentatives).
- **Rien n'a été vu dans un navigateur** : le décor crépusculaire, la lisibilité des éléments de jeu sur l'horizon clair, le quatrième onglet sur écran étroit, le mouvement réduit, l'écran de fin du chapitre 3 et l'aperçu du chapitre 4.
- Niveaux 9 à 19 : toujours pas essayés à la main.

## 15. Plan de validation séquentielle (mission ultérieure, **non exécuté**)

1. **Ordre** : 20, puis 21, 22, 23 et 24, **un niveau par mission ou par étape**. La campagne s'arrête au premier échec.
2. **Par niveau** :
   - audit statique de la spécification ;
   - une seule géométrie candidate, figée et documentée avant le lancement ;
   - un script dédié `scripts/filament-calibrate-ch4-<lettre>.mjs`, autonome et audité (filtre du lanceur, imports, `node --check`), **ajouté seul** à la liste blanche juste avant son unique lancement et retiré en cas d'échec ;
   - **aucun retry** et aucun balayage.
3. **Trajectoires** :
   - niveaux 20 à 23 : au plus **deux** courtes, T1 de mesure (cible hors d'atteinte) puis T2 de vérification (victoire avec 3 étoiles, ticks prédits à ±1) ;
   - niveau 23 : un contrôle peut être ajouté (vent contraire laissé allumé, ou ventilateur ascendant éteint), avec une défaite exigée ;
   - niveau 24 : T1, T2, puis un contrôle ventilateur jamais allumé (défaite exigée). La coupe hors du souffle de la rafale (défaite exigée) pourra suivre **dans une mission séparée**.
4. **Budgets** : ceux des missions précédentes et les plafonds actuels du lanceur, **jamais relevés** (≤ 600 pas par trajectoire, ≤ 1 800 au total, ≤ 2 s internes, enfant 10 s, RSS 350 Mio, tas 128 Mio). Contrôles avant et après le lancement : empreintes, verrou, `tasklist`, mémoire, CPU, Git.
5. **Intégration** : un niveau ne passe de `CHAPTER4_SPECS` à `CHAPTER4_LEVELS` qu'après un PASS. Le tableau `CHAPTER4_LEVELS` est à créer à ce moment-là, avec un type explicite pour éviter le spread de `never`. Tout niveau qui échoue reste en préparation et sa refonte fait l'objet d'une mission séparée.
6. **Fin du jeu** : l'écran « Les 24 fils du voyage » ne s'active qu'avec le niveau 24 intégré, puis après une vérification dans le navigateur par l'utilisateur.

## 16. Sécurité, intégrité et copies

- **Ce qui n'a pas eu lieu** : aucune simulation, aucune recherche, aucune calibration, aucun benchmark, aucun test GPU, aucun WebGL ou SwiftShader forcé, aucun Chromium, aucun Playwright, aucun processus détaché. Docteur n'a pas été lancé et aucun navigateur n'a été ouvert.
- **Processus** : aucun processus Node n'a été touché. La seule commande Node a été un import des données en avant-plan, terminé en quelques millisecondes. Verrou du laboratoire absent.
- **Fichiers inchangés** : lanceur `c79bae3b`, bootstrap `633be06b`, lib `d2eeb599`, moteur `733fd835`.
- **Préservés** : niveaux 1 à 19 (`chapter1.ts` `fe2b5c6e`, `chapter2.ts` `3d3971ab`, `chapter3.ts` `b730adf6`), sauvegardes, décors existants, Synapse Run, Companion, MAÎTRE, Root Policy, Notebook, Knowledge Graph, Docteur Memory, launcher principal, PDF privé et hooks Git.
- **Copies locales** : `.tmp/filament-chapter4-backup-2026-10-24/{pre,post}/`. Les copies antérieures sont conservées et aucune n'a été supprimée.
- **Git** : HEAD `b9eeeb4` ; 33 fichiers suivis modifiés, préexistants et non touchés (le dossier `src/arcade/filament/` n'est pas suivi) ; 0 fichier indexé, 0 commit, 0 push.

**Checkpoint : `DOCTEUR_FILAMENT_CHAPTER_4_IMPLEMENTATION_CHECKPOINT`**
