# Filament — Chapitre 4 « Lisière du Crépuscule » — validation séquentielle des niveaux 20 à 24

Date : 2026-10-24 · Dépôt : `C:\dev\Docteur` · HEAD : `b9eeeb4` (inchangé) · Point de départ : `DOCTEUR_FILAMENT_CHAPTER_4_IMPLEMENTATION_CHECKPOINT`

**Verdict : `FILAMENT_24_LEVELS_PHYSICS_COMPLETE_AWAITING_MANUAL_CHECK`**

| Mesure | Valeur |
|---|---|
| Niveaux intégrés | 19 au départ → **24** à la fin, sur 24 |
| Niveaux encore en préparation | aucun |
| Lancements supervisés | **5**, un par niveau, chacun lancé à part, sans retry |
| Trajectoires | **11** (2 + 2 + 2 + 2 + 3) |
| Pas physiques | **2 581** (498 + 437 + 461 + 484 + 701) |
| Codes de sortie | 0 · 0 · 0 · 0 · 0 |
| Moteur `physics.ts` | inchangé (`733fd835`) |

> **Ce sont des victoires simulées.** Aucun niveau du chapitre 4 n'a été joué ni regardé dans un navigateur. Les niveaux 9 à 24 attendent tous une vérification manuelle, visuelle et ergonomique.

---

## Méthode commune

Chaque niveau a suivi les mêmes étapes, dans l'ordre 20 → 21 → 22 → 23 → 24 :

1. lecture de la spécification et audit statique, avec calcul à la main ;
2. une seule configuration, celle de la spécification **sans aucune modification**, et une seule séquence d'actions fixe ;
3. un script dédié et autonome, `scripts/filament-calibrate-ch4-<lettre>.mjs` :
   - audit : filtre `FORBIDDEN_TEXT` du lanceur ; imports limités à node:crypto/fs/path/url, `filament-lab-lib.mjs` et `chapter4.ts` ; aucune écriture de fichier, aucun argument, aucun réseau, aucune boucle de paramètres ; `node --check` PASS ;
   - **ajouté seul** à la liste blanche, juste avant son lancement ;
4. contrôle avant lancement : empreintes, verrou, `tasklist`, mémoire, CPU, Git ;
5. **un seul lancement** au premier plan : `node scripts/filament-safe-run.mjs scripts/filament-calibrate-ch4-<lettre>.mjs` ;
6. contrôle après lancement : PID de l'enfant absent, verrou libéré ;
7. intégration exacte des valeurs testées, puis vérification des types et contrôle statique des données avant le niveau suivant.

**Trajectoires** :

- T1 mesure la trajectoire avec la cible hors d'atteinte. La cible est placée au premier franchissement de la règle de placement, et les étoiles à 25, 50 et 78 % du vol.
- T2 rejoue le niveau avec la cible et les étoiles. Elle exige WON, 3 étoiles et les ticks prédits à ±1.
- T3, pour la finale seulement, rejoue le niveau avec le ventilateur jamais allumé.

**Budgets** : 600 pas par trajectoire ; 1 200 au total pour les niveaux 20 à 23, 1 800 pour le niveau 24 ; 2 s de calcul interne. Le registre est partagé entre les trajectoires d'un même lancement. **Aucune limite du lanceur n'a été relevée** : timeout enfant 10 s, échéance 15 s, RSS 350 Mio, tas 128 Mio, verrou, handshake.

**Mémoire, pour chaque lancement** :

- lanceur au contrôle préalable : 50 à 52 Mio ;
- enfant au démarrage : ≈ 50 Mio (50 760 à 50 840 Kio) ;
- **pendant le calcul : NON OBSERVÉE**. Chaque exécution (254 à 291 ms) est plus courte que l'intervalle de mesure de 700 ms.

Cette surveillance périodique ne détecte pas forcément les pics très brefs et ne garantit pas l'absence de BSOD.

---

## Niveau 20 — `ch4-a` « Le dernier rayon » — **PASS**

1. **Spécification initiale** :
   - bille : `pend(620, 60, 150, 60)` ≈ (749,9, 135) ;
   - rayon constant : `{ 370, 200, 150 × 230, ax 0, ay −1700 }` ;
   - pilier : `seg(330, 340, 330, 500)` ;
   - faille : (340→600, 485) ;
   - action : `cut(82, 0)` ; règle de placement : x = 160.
2. **Risques statiques** : la trajectoire en miroir n'avait pas été vérifiée, et la sortie du rayon risquait d'être trop basse face au pilier. Calcul à la main : entrée vers (520, 251) en descendant à ≈ +230 u/s, sortie vers (370, ≈ 273), pilier passé à ≈ 55 au-delà de la distance de contact. Le balancier tenu reste au-dessus du rayon.
3. **Géométrie** : la spécification, inchangée.
4. **Séquence** : `cut(82, 0)`.
5. **Audit du script** : PASS (`5ad0b860`). Liste blanche : ajout de ce seul chemin.
6. **Lancement** : 1 · PID 21540.
7. **Trajectoires** : 2.
8. **Pas** : 498 (T1 268 + T2 230).
9. **Résultat** : T1 se termine en sortie d'écran (cible hors d'atteinte). T2 est **WON, 3 étoiles**, victoire au tick 230 (prédiction 230). Étoiles prises aux ticks 118, 152 et 195 (prédiction 118, 153 et 195).
10. **Étoiles** : (488, 272), (381, 296), (258, 319).
11. **Cible** : (160, 414).
12. **Rôle des forces** : le rayon agit **50 ticks**. La bille sort en (372, 295) en remontant et passe le pilier à **45,9** du segment (contact à 22). Le pilier est franchi, sans aucun contact.
13. **Contrôle supplémentaire** : aucun (niveau ordinaire, 2 trajectoires).
14. **Durée** : calcul interne 9 ms ; lancement complet 290 ms.
15–16. **Mémoire** : lanceur 52 Mio ; enfant au démarrage 50 Mio ; pendant le calcul : non observée.
17. **Code de sortie** : 0.
18–19. **Fin du lancement** : enfant terminé, verrou libéré.
20. **Intégration** : oui, dans `CHAPTER4_LEVELS`.
21. **Sauvegardes** : préservées (voir plus bas).
22. **À vérifier à la main** : lisibilité du rayon et du pilier ; réussite en jouant réellement.

**Écart avec le calcul à la main** : la sortie réelle est à y ≈ 295, contre ≈ 273 prévu, et le pilier est passé à 45,9 au lieu de ≈ 77. La marge reste suffisante.

## Niveau 21 — `ch4-b` « Les ombres mouvantes » — **PASS**

1. **Spécification initiale** :
   - bille : (200, 170) ;
   - fils en V : (120, 60) et (280, 60), chacun de longueur √(80² + 110²) ;
   - vent cyclique : `{ 300, 150, 340 × 180, ax 700, ay −900, timing 240 / 140 / phase 160 }`, actif des ticks 80 à 219 ;
   - pierres : (470, 170) et (560, 320), rayon 14 ;
   - faille : (300→640, 485) ;
   - actions : `cut(20, 0)`, `cut(95, 1)` ; règle : x = 720.
2. **Audit renforcé** (conception nouvelle, sans tronçon mesuré) :
   - avant toute coupe, la bille est au repos à l'intersection des deux fils, symétriques à ±36° ;
   - la première coupe la fait balancer vers la droite sur le fil droit (période ≈ 2,5 s, bas vers le tick 95) ;
   - la seconde coupe la libère au plus bas ;
   - le vent vertical net est nul, la bille plane donc à travers le vent ;
   - les pierres sont à ≈ 67 et ≈ 70 du chemin (contact à 32), il n'y a donc pas de risque de perte de vitesse ;
   - les « ombres » ne sont qu'un effet visuel, sans aucune collision.
3. **Géométrie** : la spécification, inchangée.
4. **Séquence** : `cut(20, 0)`, puis `cut(95, 1)`.
5. **Audit du script** : PASS (`ac4bb68c`). Il contrôle en plus : le repos avant la première coupe, l'absence de vent sur la bille tenue, le vent pendant son souffle, et l'absence de contact avec les pierres.
6. **Lancement** : 1 · PID 26812.
7. **Trajectoires** : 2.
8. **Pas** : 437 (T1 234 + T2 203).
9. **Résultat** : T2 est **WON, 3 étoiles**, victoire au tick 203 (prédiction 203). Étoiles prises aux ticks 134, 160 et 183.
10. **Étoiles** : (397, 229), (496, 247), (605, 263).
11. **Cible** : (725, 285).
12. **Rôle des forces** :
   - dérive au repos : **0** ;
   - bas du balancement : **(280, 196) au tick 95**, exactement comme prévu ;
   - vent tenu : 0 tick ;
   - **vent actif sur 87 ticks**, et jamais calme pendant le passage ; entrée en (301, 201) au tick 107, sortie en (635, 267) au tick 193 ;
   - pierres : marges de 39,6 et 30,2 au-delà du contact.
   - Les **deux fils sont utilisés**, dans l'ordre prévu.
13. **Contrôle supplémentaire** : aucun.
14. **Durée** : 7 ms en interne ; 254 ms au total.
15–16. **Mémoire** : lanceur 52 Mio ; enfant 50 Mio ; pendant le calcul : non observée.
17. **Code de sortie** : 0.
18–19. **Fin du lancement** : enfant terminé, verrou libéré.
20. **Intégration** : oui.
21. **Sauvegardes** : préservées.
22. **À vérifier à la main** : lisibilité de l'anneau de rythme du vent ; marge réelle du joueur sur la fenêtre de vent (≈ 26 ticks de chaque côté à la conception, non mesurée en jeu).

## Niveau 22 — `ch4-c` « Entre deux horizons » — **PASS**

1. **Spécification initiale** :
   - bille : `pend(180, 60, 150, −60)` ;
   - astre : `{ 360, 190, R 160, S 2600 }` ;
   - colonne constante : `{ 440, 250, 180 × 220, ax 0, ay −1900 }` ;
   - faille : (300→620, 485) ;
   - action : `cut(82, 0)` ; règle : x = 700.
2. **Risques et audit** :
   - le vol de CH3-C n'est mesuré que jusqu'au tick ≈ 140 ;
   - calcul pas à pas de l'astre et de la colonne ensemble : à l'entrée de la colonne, l'astre tire vers le haut et l'arrière, sans contrarier la colonne ;
   - sortie estimée vers (620, ≈ 322) en remontant ;
   - aucune zone de collision.
3. **Géométrie** : inchangée.
4. **Séquence** : `cut(82, 0)`.
5. **Audit du script** : PASS (`f27b102c`). Il exige que l'astre et la colonne agissent chacun pendant au moins 3 ticks.
6. **Lancement** : 1 · PID 10364.
7. **Trajectoires** : 2.
8. **Pas** : 461 (T1 256 + T2 205).
9. **Résultat** : T2 est **WON, 3 étoiles**, victoire au tick 205 (prédiction 206, dans la tolérance de ±1). Étoiles prises aux ticks 118, 143 et 174.
10. **Étoiles** : (325, 263), (436, 304), (567, 326).
11. **Cible** : (702, 304).
12. **Rôle des forces** :
   - **astre actif 66 ticks**, au plus près à 80,8 ;
   - **colonne active 43 ticks** ; entrée en (441, 306), sortie en (618, 317) en remontant, contre (444, 311) et (620, 322) prévus à la main.
   - L'astre et le vent sont **tous les deux utilisés**.
13. **Contrôle supplémentaire** : aucun.
14. **Durée** : 7 ms en interne ; 269 ms au total.
15–16. **Mémoire** : lanceur 50 Mio ; enfant 50 Mio ; pendant le calcul : non observée.
17. **Code de sortie** : 0.
18–19. **Fin du lancement** : enfant terminé, verrou libéré.
20. **Intégration** : oui.
21. **Sauvegardes** : préservées.
22. **À vérifier à la main** : niveau proche de 17, à cause du même balancier et du même astre ; à juger en jeu.

## Niveau 23 — `ch4-d` « Les fils du crépuscule » — **PASS**

1. **Spécification initiale** :
   - bille : (650, 160) ;
   - fils : (650, 60) longueur 100 et (470, 60) longueur 206 ;
   - vent contraire, **allumé au départ** : `{ 360, 230, 80 × 170, ax +1600 }` ;
   - ventilateur ascendant, **éteint au départ** : `{ 150, 260, 180 × 220, ax −120, ay −2000 }` ;
   - mur : `seg(110, 400, 110, 500)` ;
   - faille : (110→400, 485) ;
   - règle : x = 55.
2. **Audit** :
   - les quatre actions sont des commandes existantes (`TOGGLE` inverse l'état, `CUT`), à des ticks distincts ;
   - le relais de CH3-E est mis en miroir, distances comprises ;
   - le vent contraire est traversé alors qu'il est éteint ;
   - la cible estimée (x − r ≈ 21) reste dans le monde.
3. **Géométrie** : inchangée.
4. **Séquence** : `toggle(10, 0)`, `toggle(14, 1)`, `cut(20, 0)`, `cut(117, 1)`.
5. **Audit du script** : PASS (`40899be4`). Il contrôle aussi : aucun ventilateur sur la bille tenue ; le ventilateur ascendant agit au moins 3 ticks ; aucun contact avec le mur ; et, dans T2, que **les 4 actions ont été appliquées** avec des ventilateurs finaux `[éteint, allumé]`.
6. **Lancement** : 1 · PID 12404.
7. **Trajectoires** : 2.
8. **Pas** : 484 (T1 263 + T2 221).
9. **Résultat** : T2 est **WON, 3 étoiles**, victoire au tick 221 (prédiction 221). Étoiles prises aux ticks 144, 166 et 193. `actionsApplied` = 4 ; `fanOn` = [false, true].
10. **Étoiles** : (346, 307), (267, 351), (164, 355).
11. **Cible** : (53, 343), avec x − r = 19 : entièrement dans le monde.
12. **Rôle des forces** :
   - le relais en miroir reproduit **exactement** la mesure de CH3-E jusqu'au tick 156 ;
   - le vent contraire est traversé pendant 23 ticks alors qu'il est éteint ;
   - **le ventilateur ascendant agit 48 ticks** ; entrée en (328, 319), sortie en (152, 352) en remontant ;
   - mur passé à **55,8** (contact à 22).
   - Les **quatre actions sont fonctionnelles**.
13. **Contrôle supplémentaire** : aucun, au maximum 2 trajectoires. L'effet du vent contraire laissé allumé, ou du ventilateur ascendant laissé éteint, n'a **pas** été simulé.
14. **Durée** : 8 ms en interne ; 291 ms au total.
15–16. **Mémoire** : lanceur 50 Mio ; enfant 50 Mio ; pendant le calcul : non observée.
17. **Code de sortie** : 0.
18–19. **Fin du lancement** : enfant terminé, verrou libéré.
20. **Intégration** : oui.
21. **Sauvegardes** : préservées.
22. **À vérifier à la main** : halo collé au bord gauche ; lisibilité des deux boîtiers aux rôles opposés.

## Niveau 24 — `ch4-e` « Au-delà de la lisière » (grande finale) — **PASS**

1. **Spécification initiale** :
   - bille : (200, 160) sous (200, 60), longueur 100 ;
   - ventilateur, **éteint au départ** : `{ 140, 200, 190 × 270, ax 500, ay −1700 }` ;
   - rafale cyclique : `{ 580, 140, 180 × 190, ay −1500, timing 300 / 120 / phase 90 }` ;
   - astre : `{ 640, 140, R 200, S 2400 }` ;
   - mur : `seg(700, 280, 700, 500)` ;
   - faille : (120→700, 485) ;
   - règle : x = 745.
2. **Audit approfondi** :
   - la rafale est active aux ticks 0–29, 210–329, 510–629, et ainsi de suite ;
   - le ventilateur, allumé au tick 10, est actif pendant tout le passage dans la colonne, comme la colonne cyclique de CH3-D (ticks 40 à 159) : le départ et l'arc mesurés de CH3-D s'appliquent donc ;
   - calcul pas à pas de l'astre et de la rafale ensemble : les deux soulèvent la bille ;
   - la séquence est jouable avec les commandes existantes (touche F ou clic pour le ventilateur, coupe) ;
   - T1 peut atteindre le plafond de 600 pas (lib : `UNRESOLVED`, sans erreur), ce qui reste dans le budget.
3. **Géométrie** : inchangée.
4. **Séquence** : `toggle(10, 0)`, `cut(30, 0)`. Contrôle T3 : `cut(30, 0)` seul.
5. **Audit du script** : PASS (`ca19d075`). Il exige : ventilateur, astre et rafale actifs au moins 3 ticks chacun ; aucun contact avec le mur ; une cible entièrement au-delà de l'extrémité de la faille, puisque la bille démarre au-dessus de la faille comme dans CH3-D ; et une défaite normale en T3.
6. **Lancement** : 1 · PID 21892.
7. **Trajectoires** : 3.
8. **Pas** : 701 (T1 308 + T2 264 + T3 129), pour un plafond de 1 800.
9. **Résultat** :
   - T1 se termine en sortie d'écran au tick 308 (pas d'orbite) ;
   - T2 est **WON, 3 étoiles**, victoire au tick 264 (prédiction 264), étoiles prises aux ticks 121, 174 et 226 (prédiction 121, 174 et 227) ;
   - **T3 (ventilateur jamais allumé) est LOST dans la faille au tick 129**, en (200, 469,4), avec 0 étoile : une défaite physique normale.
10. **Étoiles** : (281, 224), (422, 160), (580, 231).
11. **Cible** : (748, 236), dans le monde (x + r = 782).
12. **Rôle des forces** :
   - **ventilateur** : 81 ticks (sortie de la colonne en (313, 202)). Il est **indispensable pour cette séquence** (T3).
   - **astre** : 73 ticks, au plus près à 107. Son influence est observée ; son caractère indispensable n'est **pas démontré**.
   - **rafale** : active pendant les 32 ticks où la bille la traverse, jamais calme pendant le passage (entrée en (580, 231) au tick 233, sortie en (719, 246) au tick 264). À x ≈ 640, la bille passe ≈ 13 unités plus haut que sur l'arc mesuré de CH3-D, qui avait la même physique sans rafale : (643, 262). Son influence est observée ; son caractère indispensable n'est **pas démontré**, faute d'une quatrième trajectoire.
   - **mur** : passé à **29,8** du segment, soit **seulement 7,8 au-delà de la distance de contact** (22). Le seuil du script était contact + 2.
13. **Contrôle du ventilateur** : la nécessité du ventilateur est confirmée **pour cette séquence seulement**. Toutes les autres solutions ne sont pas exclues.
14. **Durée** : 9 ms en interne ; 264 ms au total.
15–16. **Mémoire** : lanceur 52 Mio ; enfant 50 Mio ; pendant le calcul : non observée.
17. **Code de sortie** : 0.
18–19. **Fin du lancement** : enfant terminé, verrou libéré.
20. **Intégration** : oui. **L'écran final s'active** (voir plus bas).
21. **Sauvegardes** : préservées.
22. **À vérifier à la main** : voir la limite ci-dessous ; halo dans l'anneau de l'astre ; fenêtre de coupe par rapport à la rafale.

**Écart avec le calcul à la main, et sa conséquence.** J'avais estimé une forte remontée dans la rafale, avec le mur passé vers y ≈ 200. En réalité, l'astre et la rafale ont surtout **maintenu la bille à niveau** (y ≈ 244 → 253 → 246) : le mur est passé de justesse et la cible est plus basse que prévu. Ce n'est pas une anomalie du moteur (les prédictions de T2 tombent juste au tick près), mais mon estimation était trop optimiste. **Conséquence** : une petite variation de la coupe ou de l'allumage, faite par un vrai joueur, pourrait suffire à toucher le mur. Si le niveau se révèle trop serré en jeu, une refonte ciblée devra être traitée dans une mission distincte (par exemple abaisser le sommet du mur), avec une nouvelle validation.

---

## Intégration et interface

**`src/arcade/filament/chapter4.ts`** (`ccddd6a9` → `8ef63699`) :

- `CHAPTER4_LEVELS` contient les 5 niveaux, avec leur géométrie inchangée, leurs `hint`/`scene`, la cible, les étoiles et la référence mesurée ;
- `CHAPTER4_SPECS` est vide, avec son type conservé.

**`src/arcade/filament/levels.ts`** (`9d4756af` → `d23668ba`) : `FILAMENT_LEVELS` reçoit les niveaux du chapitre 4 après les 19 premiers. Les numéros 20 à 24 suivent, et les ordres et identifiants existants ne changent pas.

**`src/arcade/filament/main.ts`** (`a8b5d96a` → `741f28fe`) :

- à la fin du chapitre 3, le kicker reste **« Fin du chapitre 3 — Le cœur du verger »** (règle : chapitres 3 et 4) ; le bouton devient « Chapitre 4 · Le dernier rayon » ;
- l'écran de fin du chapitre 2 est inchangé (« Fin du chapitre 2 », bouton « Chapitre 3 · La première orbite »), de même que celui du chapitre 1 ;
- niveaux 20 à 23 : l'écran affiche « Niveau suivant ».

**Écran final « Filament — Les 24 fils du voyage »** : il est **activé** par les données, sans autre changement de code. Le contrôle statique montre qu'il ne peut apparaître qu'**après la victoire au niveau 24** : aucun niveau ne le suit, aucun chapitre 5 n'existe, 24 niveaux sont intégrés et aucun n'est en attente. `getLevel(24)` vaut `null`, et la touche N ne peut donc rien ouvrir après le 24.

**Navigation** : onglet du chapitre 4 avec cinq tuiles jouables, et plus aucune tuile « En préparation ».

**Sauvegardes** :

- `progress.ts` `ad6bdbf3` et `host.js` `a5161b4d` sont inchangés ; le format `filament-progress-v1` (saveVersion 1) et IndexedDB n'ont pas été touchés.
- La session de progression se construit à partir de `FILAMENT_LEVELS`, dont les **19 premiers identifiants et leur ordre sont identiques**. Les niveaux 20 à 24 s'y ajoutent, et les anciennes sauvegardes restent valides, comme lors des ajouts précédents.
- Le bouton « Continuer » pointe sur le premier niveau non gagné ; pour une sauvegarde à 19 niveaux gagnés, c'est désormais le niveau 20.

**Test préparé** `scripts/test-filament-game-unit.mjs` (`8aba4525` → `c8be6003`) : 24 niveaux, données exactes des niveaux 20 à 24, 0 niveau en attente, indice invalide 24. `node --check` PASS ; **non exécuté**.

**Vérifications** : TypeScript ciblé PASS après chaque intégration et à la fin ; contrôle statique des données PASS (24 niveaux, numéros 1 à 24, départs hors des champs, cibles dans le monde, 3 étoiles par niveau) ; `git diff --check` propre ; aucun espace en fin de ligne.

## Sécurité et intégrité

- **Pendant la campagne** : aucun timeout, aucun dépassement de budget, aucun processus orphelin, aucun ralentissement constaté, aucun incident Windows signalé pendant cette session.
- **Liste blanche du lanceur** : ce fichier n'a changé qu'à cet endroit (comparaison avec la copie « pre »). Les scripts `ch4-a` à `ch4-e` y ont été ajoutés un par un, chacun juste avant son unique lancement, et y restent comme les autres calibrations validées.
- **Fichiers inchangés** : bootstrap `633be06b`, lib `d2eeb599`.
- **Fichiers non autorisés** : `filament-design-ch2.mjs`, le module commun et les outils de recherche.
- **Processus** : aucun processus Node global n'a été arrêté, et le Node préexistant (PID 25204) n'a pas été touché. Docteur n'a pas été lancé et aucun navigateur n'a été ouvert. Il n'y a eu ni Playwright, ni GPU, ni WebGL forcé, ni benchmark, ni recherche exhaustive, ni simulation parallèle, ni retry.
- **Préservés** :
  - niveaux 1 à 19 (`chapter1.ts` `fe2b5c6e`, `chapter2.ts` `3d3971ab`, `chapter3.ts` `b730adf6`) et `renderer.ts` `39a684c4` ;
  - Synapse Run, Companion, MAÎTRE, Root Policy, Notebook, Knowledge Graph, Docteur Memory, le launcher principal, le PDF privé et les hooks Git.
- **Copies locales** : `.tmp/filament-chapter4-validation-backup-2026-10-24/{pre,post}/`. Les copies antérieures sont conservées.
- **Git** : 33 fichiers suivis modifiés, préexistants ; 0 indexé ; 0 commit ; 0 push.

## Suite proposée (mission distincte)

Une vérification manuelle, visuelle et ergonomique dans le navigateur :

- niveaux 9 à 24 ;
- onglet du chapitre 4 et décor crépusculaire ;
- écrans de fin des chapitres 1 à 3 et écran final ;
- reprise d'une sauvegarde existante et bouton « Continuer » ;
- en priorité, la jouabilité réelle du niveau 24, à cause de sa marge de 7,8 au-dessus du mur.

**Checkpoint : `DOCTEUR_FILAMENT_CHAPTER_4_SEQUENTIAL_VALIDATION_CHECKPOINT`**
