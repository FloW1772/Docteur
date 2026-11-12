# Filament — Chapitre 3 « Vergers Stellaires » — conception et implémentation

Date : 2026-10-23 · Dépôt : `C:\dev\Docteur` · HEAD : `b9eeeb4` (inchangé) · Référence : `DOCTEUR_FILAMENT_CH2_F_REDESIGN_V3_CHECKPOINT`

**Verdict : `FILAMENT_CHAPTER_3_IMPLEMENTED_AWAITING_PHYSICS_VALIDATION`**

Les cinq niveaux 15 à 19 existent sous forme de **spécifications** : géométrie, mécaniques, actions supposées et règle de placement de la cible. Ils sont présentés comme **« En préparation »**, ne sont pas jouables, ne sont pas comptés et ne sont pas sauvegardés.

Cette mission n'a lancé **aucune simulation physique**, aucun navigateur ni aucun test GPU. Rien n'a été observé à l'écran.

---

## 1. État initial

| Élément | État |
|---|---|
| Niveaux jouables | 14 : chapitre 1 « Jardins de l'Aube » (8, appréciés par l'utilisateur) et chapitre 2 « Courants d'Altitude » (6, validés physiquement, pas encore essayés dans le navigateur) |
| Moteur | `physics.ts` `733fd835`, inchangé. Faiblesse connue : la restitution des contacts n'est appliquée que partiellement (rapport CH2-C v3) |
| Sauvegarde | format `filament-progress-v1`, `saveVersion` 1, IndexedDB `docteur-arcade`, clé `arcade:v1:filament` |
| Copie préalable | `.tmp/filament-chapter3-backup-2026-10-23/pre/` (11 fichiers, `SHA256SUMS.txt`) |

## 2. Mécaniques existantes du moteur (lecture de `physics.ts`)

| Mécanique | Support | Détail |
|---|---|---|
| **Puits d'attraction** (`wells`, `WellDef { x, y, radius, strength }`) | **OUI** | l. 43 et 181-184 : accélération vers le centre d'intensité `strength · (1 − d / radius)`, nulle au-delà du rayon et sous d = 2. Une valeur `strength` négative repousse. Limite du labo : 4 puits |
| Picots (`pegs`) | OUI | disque solide, restitution 0,45 (l. 163). Contact peu prévisible |
| Tremplins | OUI, comme **segments `deflector`** | restitution 0,78 déclarée, mais rebond partiel en pratique. Utilisés seulement comme **rampes de glissade** (précédents CH1-J et CH2-C) |
| Murs (`wall`), failles (`rifts`) | OUI | |
| Courants constants, cycliques (`timing`), ventilateurs (`fan` + `TOGGLE`) | OUI | |
| Plusieurs fils, relais | OUI | |
| Vitesse initiale (`orbVelocity`) | OUI | ce n'est pas une action du joueur |
| Actions du joueur | `CUT` (fil), `TOGGLE` (ventilateur) | |

## 3. Mécaniques manquantes (non simulées, non simulées en faux, à traiter dans des missions techniques séparées)

- **Ressorts** : absents.
- **Obstacles mobiles** (rotation, va-et-vient) : absents.
- **Action du joueur sur un puits** (allumer ou inverser un astre) : absente, seuls les ventilateurs se commandent.
- **Rebond fiable** sur les cristaux et les picots : le moteur l'applique partiellement (voir FILAMENT_CH2_C_RAMP_CORRECTION_V3.md). C'est une limite connue, pas une fonction manquante.

**Rien n'est bloquant pour ce chapitre.** Les cinq niveaux n'utilisent que des mécaniques déjà présentes. Aucun puits n'est décoratif : chaque puits dessiné est un `WellDef` réel du moteur.

## 4. Direction artistique « Vergers Stellaires »

Thème `verger` dans `renderer.ts`, avec un fond peint rarement (au redimensionnement, au changement de thème, de niveau ou de mode mouvement), comme les deux autres thèmes.

**Profondeur** :
1. **Ciel cosmique** : dégradé indigo profond → violet → horizon rose. Il s'enrichit du premier au dernier niveau du chapitre (paramètre `dawn`, local au chapitre).
2. **Nébuleuses et constellations** :
   - quatre nébuleuses : rose, bleu électrique doux, or, vert luminescent ;
   - une bande diagonale de poussière d'étoiles ;
   - les étoiles de décor partagées, avec reflets ;
   - deux constellations reliées, à nœuds dorés.
3. **Planètes lointaines** : une planète rose et violette à anneau doré (en haut à droite), une petite planète verte (en haut à gauche).
4. **Îlots de vergers flottants** (trois, sans collision) : roche violette, mousse sombre, cristaux violets et dorés, fleurs phosphorescentes (vertes, bleues, roses), un **arbre aux feuilles argentées** par îlot, avec **trois fruits lumineux** chacun (9 fruits, roses ou verts).
5. **Éléments de jeu au premier plan** :
   - palette `VERGER` sans contour sombre (le ciel est foncé), ancres dorées, halo vert luminescent, étoiles dorées, cristaux violets, picots dessinés en fruits roses avec reflet et feuille (thème `verger` uniquement) ;
   - **puits** dessinés pour la première fois : disque d'influence très léger, anneau pointillé au rayon (force nulle au-delà), deux anneaux intérieurs, huit chevrons fixes orientés vers le centre (ou vers l'extérieur pour un puits répulsif), cœur doré brillant.

**Animation** (seulement sans `prefers-reduced-motion` ni mouvement réduit demandé par l'hôte) :
- le scintillement partagé des 14 étoiles ;
- la pulsation douce des 9 fruits ;
- au plus **10 poussières** qui dérivent lentement ;
- la rotation de l'anneau pointillé des puits (simple décalage de pointillés).

Il n'y a **aucune allocation par image** (aucun dégradé créé par image, positions calculées), aucun `shadowBlur`, aucun filtre, ni WebGL ni texture. Avec mouvement réduit, la scène est complète et immobile. Les chevrons des puits et les fruits peints dans le fond restent visibles.

**Choix assumés** : pas de mouvement de feuillage, pour éviter de redessiner les arbres à chaque image. Les fruits de décor sont ronds et plus petits que les étoiles à cueillir, pour éviter toute confusion. L'ensemble est original : aucun élément visuel n'est repris d'un jeu existant.

**Chapitres 1 et 2** : ils n'ont ni puits ni picots, donc leur chemin de dessin est identique, de même que leur fond et leur palette.

## 5. Les cinq niveaux (`src/arcade/filament/chapter3.ts`, spécifications non validées)

Les estimations sont **à la main, non simulées**. Il n'y a ni cible ni étoiles : elles seront placées sur la trajectoire réellement tracée.

| # | Id | Titre | Difficulté | Départ | Mécaniques | Actions supposées | Placement | Risques |
|---|---|---|---|---|---|---|---|---|
| 15 | `ch3-a` | La première orbite | facile | bille au repos (200, 150), fil ancré en (200, 50), longueur 100 | 1 puits (370, 300), rayon 220, force 2 600 | `cut(20, 0)` (instant libre) | y = 430 | courbure peut-être trop faible ; capture à éviter |
| 16 | `ch3-b` | Les fruits suspendus | facile à modérée | balancier `pend(180, 60, 150, −60)` (comme CH2-B) | 2 fruits-picots à **éviter**, rampe de cristal (350, 380)→(490, 420) qui descend vers la droite, faille | `cut(82, 0)` (point bas) | x = 560 | contact avec un picot imprévisible ; premier contact attendu sur la face de la rampe |
| 17 | `ch3-c` | L'appel des astres | modérée | bille au repos (140, 140) | 2 puits (230, 290) R 150 F 2 400 et (540, 330) R 170 F 1 800, faille | `cut(20, 0)` | x = 640 | **trajectoire la plus incertaine** : deux champs variables, capture ou demi-tour possibles |
| 18 | `ch3-d` | Le jardin renversé | modérée à avancée | balancier `pend(160, 60, 140, −60)` | colonne d'air ascendante (320, 200, 160 × 280, poussée nette −800, comme le ventilateur validé de CH2-E), puits haut (640, 140), faille | `cut(78, 0)` (point bas) | x = 640 | timing du balancier ; relance trop haute ; capture |
| 19 | `ch3-e` | Le cœur du verger | finale | relais de CH1-J (bille (150, 160), fils (150, 60) L 100 et (330, 60) L 206) | ventilateur (520, 260, 140 × 220), puits « cœur » (680, 160) R 140, faille | `toggle(10, 0)`, `cut(20, 0)`, `cut(117, 1)` | x = 660 | trois actions ; la bille approche x ≈ 510 pendant le balancier (colonne à 520) ; capture possible |

**Règles statiques vérifiées par calcul pour les cinq** (et ajoutées au test préparé) :
- chaque bille est à la longueur de son fil (ch3-e : 205,9 pour un fil de 206) ;
- aucune bille ne démarre dans un vent ni dans le rayon d'un puits (ch3-a : 226,7 > 220 ; ch3-c : 174,9 > 150) ;
- aucune bille ne démarre sur un picot ;
- au plus 4 puits et 8 actions par niveau.

**Leçons du chapitre 2 appliquées** : départ au repos quand c'est possible (trajectoire prévisible), aucun niveau qui dépend d'un rebond, rampes seulement en glissade, réutilisation de géométries déjà validées (balancier de CH2-B, relais de CH1-J, colonne de CH2-E).

## 6. Fichiers

| Fichier (non suivi par git) | Changement | sha256 |
|---|---|---|
| `src/arcade/filament/chapter3.ts` | **nouveau** : 5 spécifications, interface `Chapter3Spec`, sans import | `8691f66a…` |
| `src/arcade/filament/levels.ts` | `ChapterId` + `'ch3'`, `ChapterTheme` + `'verger'`, chapitre 3 dans `FILAMENT_CHAPTERS`, `PENDING_LEVELS` = spécifications du chapitre 2 (aucune) + chapitre 3. `FILAMENT_LEVELS` inchangé (14) | `5a45678b…` |
| `src/arcade/filament/main.ts` | texte du titre pour tout chapitre ≥ 2 (aperçu ou niveaux ouverts) ; écran de fin d'un chapitre complet qui annonce le chapitre suivant en préparation, avec le bouton « Aperçu du chapitre 3 » | `c150cce7…` |
| `src/arcade/filament/renderer.ts` | thème `verger`, palette `VERGER`, fond, puits, picots en fruits, animations bornées | `4ee9790f…` |
| `scripts/test-filament-game-unit.mjs` | 3 chapitres, 5 niveaux en attente (15 à 19), 19 identifiants uniques, règles des puits et des picots ; **non exécuté** | `e8cdcd32…` |

**Inchangés** (empreintes vérifiées) : `physics.ts` `733fd835`, `chapter1.ts` `fe2b5c6e`, `chapter2.ts` `3d3971ab`, `progress.ts` `ad6bdbf3`, `session.ts` `fbf9a479`, `input.ts` `2a98d528`, `loop.ts` `f84c5084`, `host.js` `a5161b4d`, `index.html` `fc0be1e0`, `filament.css` `9d15a774` (les onglets passent déjà à la ligne), lanceur `215492a0`, bootstrap `633be06b`, lib `d2eeb599`.

## 7. Navigation entre chapitres

- **Trois onglets** : « Chapitre 1 · Jardins de l'Aube », « Chapitre 2 · Courants d'Altitude », « Chapitre 3 · Vergers Stellaires ».
- **Onglet 3** : cinq tuiles 15 à 19 « En préparation », non jouables (annoncées comme telles). Derrière le titre, l'aperçu du décor du niveau 15 : thème `verger`, fil, astre ; pas de cible, pas d'étoiles, jamais simulé.
  - Texte : « Chapitre 3 · Vergers Stellaires · 5 niveaux (15 à 19) en préparation : le décor et les obstacles sont visibles ici en aperçu ; les niveaux s'ouvriront après leur validation. »
- **Fin du niveau 14** : écran « Fin du chapitre 2 — Les Courants d'Altitude sont traversés ».
  - Texte : « … La suite, le chapitre 3 « Vergers Stellaires » (niveaux 15 à 19), est en préparation : il s'ouvrira après la validation de ses niveaux. »
  - Boutons : Rejouer ce niveau · **Aperçu du chapitre 3** · Menu. **Aucun niveau 15 n'est proposé comme jouable.**
- **Chapitre 1** : texte du titre et écran de fin inchangés. Les textes des niveaux sont aussi inchangés pour le chapitre 2 (« Niveau n/14 »).
- **Continuer** : il s'appuie sur la progression des 14 niveaux jouables, sans changement. Aucun niveau n'est verrouillé.
- **Chapitre 4** : prévu (5 niveaux, 24 au total), **non créé**. Aucun onglet ni texte ne le présente comme existant.

## 8. Sauvegardes

`progress.ts` et `host.js` sont inchangés. La liste des niveaux connus de la sauvegarde est `FILAMENT_LEVELS` : elle reste à **14 niveaux, identique**, puisque les spécifications du chapitre 3 n'y entrent pas. Les sauvegardes existantes sont donc lues exactement comme avant, et rien n'est écrit tant que le joueur ne gagne pas un niveau.

Les identifiants `ch3-a` … `ch3-e` sont réservés et stables. Quand ces niveaux seront validés, le format `filament-progress-v1` pourra les contenir sans migration, comme pour le chapitre 2. IndexedDB n'a été ni ouverte ni modifiée.

## 9. Préservation des 14 niveaux

`chapter1.ts` et `chapter2.ts` sont inchangés (empreintes) : mêmes géométries, étoiles, cibles et solutions de référence. Les données du test préparé qui les concernent n'ont pas changé.

## 10. Contrôles statiques réellement effectués

| Contrôle | Résultat |
|---|---|
| Vérification de types ciblée (`tsc --noEmit`, configuration du scratchpad, à partir de `main.ts`) | **0 erreur** |
| `node --check scripts/test-filament-game-unit.mjs` | PASS |
| `git diff --no-index --check` (espaces) sur `levels.ts`, `main.ts`, `renderer.ts`, le test et `chapter3.ts` | aucune anomalie |
| Empreintes des fichiers à préserver | identiques |
| Liste blanche du lanceur | aucun chemin `ch3` (vérifié) |
| Verrou, git | verrou absent ; 0 fichier indexé ; 33 fichiers suivis modifiés, préexistants ; HEAD `b9eeeb4` |

**Non effectués** : test unitaire (interdit, préparé seulement), construction du bundle, navigateur, simulation.

## 11. Risques identifiés

1. **Rendu non vu** : la lisibilité des puits et du décor (contrastes, îlots près du bas, où certaines cibles pourraient tomber) reste à juger à l'écran.
2. **Hypothèses physiques** : CH3-C (deux puits) et CH3-D (colonne + puits) sont les plus incertaines. Un puits fort peut **capturer** la bille, avec une oscillation sans fin qui finit en `FREE_FLIGHT_TIMEOUT`.
3. **Contacts** : CH3-B touche une rampe (glissade attendue) et doit éviter deux picots ; aucun rebond n'est supposé.
4. **Difficulté** non mesurée tant qu'il n'y a pas de calibration ni d'essai en jeu.
5. Le fichier `renderer.ts` grossit (environ 1 100 lignes) ; le fond `verger` reste peint rarement.

## 12. Plan de validation future (non exécuté)

Il suivra la même procédure que le chapitre 2, **un niveau à la fois, dans l'ordre 15 → 19, arrêt général au premier échec**.

1. **Pour chaque niveau**, un script dédié à nom fixe `scripts/filament-calibrate-ch3-<lettre>.mjs` :
   - données du niveau copiées de `chapter3.ts` et comparées champ par champ (refus en cas d'écart) ;
   - séquence d'actions fixe, aucun argument, aucune boucle ni recherche ;
   - empreinte du moteur épinglée.
2. **Audit statique** avant toute autorisation : filtre du lanceur, graphe d'imports, un `trace` et un `run`. Le chemin exact n'est ajouté à la liste blanche que juste avant l'unique lancement.
3. **Avant chaque lancement** : verrou absent, aucun processus Filament actif, mémoire libre ≥ 2 Gio, CPU normal, empreintes, état git.
4. **Un lancement** : `node scripts/filament-safe-run.mjs scripts/filament-calibrate-ch3-<lettre>.mjs` ; au plus **2 trajectoires** (observation puis vérification), 600 pas chacune, **1 200 par session** (registre partagé), 2 s de calcul interne. Les limites du lanceur restent inchangées (10 s / 15 s / 350 Mio / tas de 128 Mio, handshake).
5. **Contrôles de mécanique adaptés** :
   - puits réellement traversés (bille dans le rayon) ;
   - **pas de capture** ;
   - premier contact de rampe sur sa face ;
   - aucun picot touché (CH3-B) ;
   - ventilateur réellement utile (CH3-E : troisième trajectoire « ventilateur éteint », budget de 1 800 pas, comme CH2-F v3).
6. **Intégration** seulement après WON avec 3 étoiles, code 0, processus terminé et verrou libéré. Contrôle statique de correspondance ; la spécification passe dans une liste `CHAPTER3_LEVELS`.
7. **Nouvelle mécanique** (ressort, obstacle mobile, puits commandé) : mission technique séparée, **avant** toute calibration qui en dépendrait.

## 13. En attente d'une validation humaine

- **Chapitre 2** (niveaux 9 à 14) dans le navigateur : il n'est **pas** considéré comme validé visuellement.
- **Aperçu du chapitre 3** : décor `verger`, lisibilité des puits, troisième onglet, écran de fin du chapitre 2 et bouton « Aperçu du chapitre 3 ».
- **Mouvement réduit** : scène complète et immobile.
- **Chapitre 3** : calibration progressive selon le § 12, sur décision de l'utilisateur.
