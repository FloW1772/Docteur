# Filament — Plan de contrôle qualité manuel des 24 niveaux

Date : 2026-10-24 · Dépôt : `C:\dev\Docteur` · HEAD : `b9eeeb4` (inchangé) · Point de départ : `DOCTEUR_FILAMENT_CHAPTER_4_SEQUENTIAL_VALIDATION_CHECKPOINT`

**Verdict de préparation : `FILAMENT_24_LEVELS_READY_FOR_USER_MANUAL_QA`**

Ce document prépare **ton** essai dans le navigateur. Aucun rendu n'a été observé et aucune partie n'a été jouée pendant cette mission. Les audits ci-dessous viennent de la **lecture du code**. Aucun niveau, aucune sauvegarde et aucun fichier du jeu n'a été modifié.

Deux problèmes **non bloquants** ont été trouvés en lisant le code. Ils sont seulement documentés (§ 3.3 et § 3.4).

---

## 1. État des 24 niveaux

| Chapitre | Niveaux | Validation physique (simulation supervisée) | Essai manuel |
|---|---|---|---|
| 1 — Jardins de l'Aube | 1 à 8 | oui | **déjà essayés et appréciés** |
| 2 — Courants d'Altitude | 9 à 14 | oui | à faire |
| 3 — Vergers Stellaires | 15 à 19 | oui | à faire |
| 4 — Lisière du Crépuscule | 20 à 24 | oui | à faire |

- 24 identifiants uniques, numérotés de 1 à 24 dans l'ordre du jeu, 0 niveau « En préparation ». Contrôle des données en lecture seule, sans moteur.
- La « validation physique » signifie qu'une séquence d'actions précise gagne avec 3 étoiles dans la simulation. **Elle ne dit rien** de la lisibilité, du confort, ni de la marge de timing laissée à un vrai joueur.

## 2. Les quatre chapitres (lecture du code de rendu)

| Chapitre | Décor prévu (`renderer.ts`) | Mécaniques | Écran de fin |
|---|---|---|---|
| 1 `aube` | ciel de nuit vers l'aube, lune, collines, jardin, bourgeons lumineux | fils, murs, cristaux, failles | « Fin du chapitre 1 — Les Jardins de l'Aube sont traversés », bouton « Chapitre 2 · Premier souffle » |
| 2 `altitude` | ciel bleu, soleil doré, montagnes, îles flottantes, arche de cristal, mer de nuages | vents (chevrons et traînées), courants cycliques avec anneau de rythme, ventilateurs (boîtiers aux pales qui tournent) | « Fin du chapitre 2 », bouton « Chapitre 3 · La première orbite » |
| 3 `verger` | ciel indigo et violet, nébuleuses, constellations, planètes, îles aux arbres argentés, fruits lumineux | astres : anneau d'influence, chevrons vers le centre, cœur lumineux | « **Fin du chapitre 3 — Le cœur du verger** », bouton « Chapitre 4 · Le dernier rayon » |
| 4 `crepuscule` | du coucher de soleil (niveau 20) à la nuit (niveau 24), soleil bas et rayons, silhouettes, brume, constellations qui apparaissent, arbres, cristaux et herbes dorés, lucioles | toutes les précédentes, plus un liseré sombre autour des éléments de jeu | écran final « **Filament — Les 24 fils du voyage** » |

Rien de tout cela n'a été **vu** à l'écran.

## 3. Audit statique

### 3.1 Navigation — PASS

| Point | Constat dans le code | Reste à observer |
|---|---|---|
| Quatre chapitres | `FILAMENT_CHAPTERS` : ch1 à ch4, avec un onglet et une grille chacun (`buildLevelGrid`) | affichage des 4 onglets |
| Ordre et unicité | 24 identifiants uniques ; `number` = position + 1 | — |
| Accès aux niveaux | **Aucun verrou** : les 24 tuiles sont cliquables. La progression marque seulement le « niveau conseillé ». C'est le fonctionnement d'origine (niveaux 1 à 8) | joue quand même dans l'ordre (§ 6) |
| Niveaux « En préparation » | aucun (`PENDING_LEVELS` vide) | aucune tuile « En préparation » ne doit apparaître |
| Continuer | `progress.firstOpen()` renvoie le **premier niveau non gagné** dans l'ordre 1 → 24, ou le dernier si tout est gagné. Le bouton affiche « Continuer · Niveau n » | après les niveaux 1 à 8 gagnés : « Continuer · Niveau 9 » |
| Touche N | seulement sur l'écran de victoire, et seulement si `getLevel(index + 1)` existe ; `getLevel(24)` vaut `null` | N après le niveau 24 ne fait rien |
| Fins des chapitres 1, 2 et 3 | voir § 9 | textes et boutons |
| Écran final | n'apparaît que si aucun chapitre ne suit, que 24 niveaux sont intégrés et qu'aucun n'est en attente, **au moment de gagner le dernier niveau du chapitre 4**. Il n'existe aucun autre chemin vers cet écran | après la victoire au niveau 24 uniquement |
| Retour à l'Arcade | bouton du jeu → événement `filament:exit-request` → `host.js` envoie `ARCADE_EXIT_REQUEST`, uniquement si le jeu est actif ou en pause. L'arrêt passe par `teardown()` | retour à la liste des jeux |
| Effacement involontaire | **aucun** bouton du jeu n'efface la progression. L'effacement n'existe que dans l'Arcade, avec son contrôle en deux étapes | — |

### 3.2 Sauvegardes — PASS

- **Format** : `filament-progress-v1` (saveVersion 1). Le jeu n'écrit rien lui-même : il passe par `host.js`, puis par l'IndexedDB `docteur-arcade` (clé `arcade:v1:filament`), qui appartient à l'Arcade. `progress.ts` (`ad6bdbf3`) et `host.js` (`a5161b4d`) sont inchangés.
- **Validation au chargement** : seuls les identifiants **connus** sont acceptés, avec des étoiles entières entre 0 et le maximum du niveau. Une sauvegarde issue des niveaux 1 à 8, ou de 1 à 19, est un sous-ensemble des 24 identifiants : elle **reste valide**.
- **Taille** : environ 350 octets pour 24 niveaux, sous le plafond de 2 048.
- **Écriture** : une seule écriture par changement utile (première victoire ou plus d'étoiles). Le meilleur score n'est jamais abaissé.
- **Sauvegarde illisible ou plus récente** : elle est conservée telle quelle (état `PROTECTED`) et rien n'est écrit.

### 3.3 Commandes — **un problème au niveau 23** (non bloquant à la souris et au tactile)

- La touche **F** et le bouton **« Ventilateur »** appellent `toggleFan(attempt.firstFan())`, c'est-à-dire le **premier** ventilateur du niveau seulement (`session.ts`, `firstFan`).
- Les niveaux 13, 14, 19 et 24 n'ont qu'un ventilateur : aucun problème.
- Le **niveau 23 en a deux** :
  - F ou le bouton basculent **le vent contraire** (allumé au départ). Une première pression l'éteint, ce qui est correct ; une deuxième **le rallume**.
  - Le **ventilateur ascendant** (à gauche) ne s'allume **qu'en cliquant ou en touchant son boîtier**.
- L'introduction du niveau dit pourtant « Ventilateur : touchez-le, cliquez dessus ou appuyez sur F ».
- **Conséquence** : un joueur au clavier seul ne peut pas finir le niveau 23, et un joueur qui appuie deux fois sur F perd sans comprendre.
- **Je n'ai rien corrigé.** Recommandation (§ 12) : une mission séparée, sur les commandes uniquement, sans toucher à la physique.

### 3.4 Textes hors du jeu — périmés (non bloquant)

- `src/lib/arcade/registry.ts` (carte du jeu dans l'Arcade) et `src/content/capabilities.ts` décrivent encore Filament comme « **premier chapitre de huit niveaux** ».
- Ces deux fichiers portaient **déjà** des modifications non commitées avant cette mission, et la mission n'autorise pas à les changer : non modifiés.

### 3.5 Mouvement réduit — PASS

- Le jeu lit `prefers-reduced-motion` (`matchMedia`) et suit aussi l'indicateur `reducedMotion` envoyé par Docteur. Il réagit en direct aux changements.
- **En mouvement réduit**, le moteur de rendu supprime : scintillement, pulsations, lucioles, traînée, rotation des pales et des halos, effets de coupe et éclat de victoire. Les étoiles du décor sont alors peintes dans le fond. Les chevrons des vents et des astres restent affichés, **sans animation**.
- La boucle d'animation s'arrête sur les menus.

### 3.6 Canvas et petits écrans — PASS (à observer)

- **Monde et canvas** : le monde de 800 × 500 est **mis à l'échelle et centré** dans le canvas, avec des bandes si besoin ; il n'est jamais rogné. La résolution est plafonnée (DPR ≤ 2, ≤ 2560 × 1600 pixels). Le canvas suit la taille de la zone de jeu (`ResizeObserver`).
- **Menus** : la carte fait au plus 480 px de large et défile si elle est trop haute. Les 4 onglets passent à la ligne. La grille a 4 colonnes, 2 sous 520 px de large, et redevient à 4 colonnes si la hauteur est inférieure à 380 px.
- **Risques visuels prévus** :
  - cible très proche d'un astre : niveaux 17 (≈ 33 unités) et 19 (≈ 29) ;
  - cible collée au bord gauche : niveau 23 (bord du halo à 19 unités) ;
  - cible dans l'anneau de l'astre : niveau 24 (à 144 du centre, pour un rayon de 200) ;
  - lucioles du chapitre 4 dans la zone de jeu : minuscules, peu visibles, sans collision.

## 4. Vérifications visuelles restantes, toutes dans le navigateur

1. Les quatre décors : couleurs, profondeur, rien qui masque le jeu.
2. Lisibilité des fils, ancres, étoiles, halos, vents, boîtiers de ventilateurs, astres, failles, murs et pierres, sur chaque décor. Au chapitre 4, en particulier sur l'horizon clair du niveau 20.
3. Les anneaux de rythme des courants cycliques (niveaux 12, 18, 21 et 24).
4. Le passage d'un niveau à l'autre, puis d'un chapitre à l'autre.
5. Le mode mouvement réduit (réglage Windows « Effets d'animation » désactivé) : scène complète, sans animation.
6. Une fenêtre étroite, ou un téléphone si tu en as l'usage : onglets, grille et boutons.

## 5. Ce qu'il faut savoir avant de jouer

- **Commandes** :
  - couper : cliquer sur le fil, tracer un trait à travers, ou appuyer sur Espace (qui coupe le fil suivant, dans l'ordre) ; les touches 1 à 8 coupent un fil précis ;
  - ventilateur : cliquer ou toucher son boîtier, ou appuyer sur F (attention au niveau 23, § 3.3) ;
  - pause : P ; recommencer : R ; niveau suivant après une victoire : N.
- **Solutions de référence** : c'est ce que la simulation a joué. Le temps est compté **depuis le début de la tentative**. Elles servent de repère, pas de mode d'emploi obligatoire.
- **Courants cycliques et bille au repos** (niveaux 18 et 24) : on peut aussi attendre un cycle complet. Couper exactement une période plus tard (2 s au niveau 18, 2,5 s au niveau 24) reproduit, par déduction, la même trajectoire. C'est une **déduction logique, pas un essai**.

## 6. Fiche de test des niveaux 9 à 24

**Règles** :

- joue dans l'**ordre normal** : 9, 10, …, 24, en utilisant « Continuer » ou la tuile conseillée ;
- ne modifie ni la sauvegarde ni IndexedDB, et n'injecte rien ;
- note ce que tu vois vraiment ;
- les captures d'écran sont facultatives, seulement si elles t'aident.

| N° | Niveau | À observer en priorité | Solution de référence (simulation) |
|---|---|---|---|
| 9 | Premier souffle | vent constant vers la droite, lisible | coupe vers 0,17 s |
| 10 | La traversée | balancier, coupe au plus bas | coupe vers 0,68 s |
| 11 | Les jardins suspendus | la bille **glisse** sur la rampe de cristal (pas de rebond) | coupe vers 0,55 s |
| 12 | Vents contraires | vent cyclique contraire, anneau de rythme | coupe vers 0,17 s |
| 13 | Le souffle des cristaux | ventilateur à allumer, arc de relance | ventilateur vers 0,08 s, coupe vers 0,25 s |
| 14 | Le passage des nuages | **voir § 7** | ventilateur vers 0,08 s, coupe vers 0,63 s |
| 15 | La première orbite | premier astre : anneau, chevrons, courbure | coupe vers 0,17 s |
| 16 | Les fruits suspendus | passer entre les deux fruits, glisser sur la rampe | coupe vers 0,68 s |
| 17 | L'appel des astres | **voir § 7** | coupe vers 0,68 s |
| 18 | Le jardin renversé | **voir § 7** | coupe vers 0,25 s |
| 19 | Le cœur du verger | **voir § 7** | ventilateur vers 0,08 s, coupes vers 0,17 s et 0,98 s |
| 20 | Le dernier rayon | rayon doré lisible sur le ciel clair, passage au-dessus du pilier | coupe vers 0,68 s |
| 21 | Les ombres mouvantes | ordre des coupes (fil **gauche** d'abord) ; pierres ; les « ombres » ne sont **que visuelles** | coupes vers 0,17 s puis 0,79 s (au plus bas) |
| 22 | Entre deux horizons | distinguer l'astre (en haut à gauche) de la colonne (à droite) | coupe vers 0,68 s |
| 23 | Les fils du crépuscule | **voir § 7** | vent contraire éteint vers 0,08 s, ventilateur ascendant allumé vers 0,12 s, coupes vers 0,17 s et 0,98 s |
| 24 | Au-delà de la lisière | **voir § 7 (priorité haute)** | ventilateur vers 0,08 s, coupe vers 0,25 s |

### Grille de retour, à remplir en jouant

Valeurs possibles :

- Décor et Commandes : OUI / NON ;
- Terminé : OUI / NON ;
- Étoiles : 0 à 3 ;
- Difficulté : FACILE / ÉQUILIBRÉE / DIFFICILE / FRUSTRANTE.

| N° | Nom | Décor visible | Commandes fonctionnelles | Terminé | Étoiles | Difficulté | Bug ou anomalie | Capture (facultative) |
|---|---|---|---|---|---|---|---|---|
| 9 | Premier souffle | | | | | | | |
| 10 | La traversée | | | | | | | |
| 11 | Les jardins suspendus | | | | | | | |
| 12 | Vents contraires | | | | | | | |
| 13 | Le souffle des cristaux | | | | | | | |
| 14 | Le passage des nuages | | | | | | | |
| 15 | La première orbite | | | | | | | |
| 16 | Les fruits suspendus | | | | | | | |
| 17 | L'appel des astres | | | | | | | |
| 18 | Le jardin renversé | | | | | | | |
| 19 | Le cœur du verger | | | | | | | |
| 20 | Le dernier rayon | | | | | | | |
| 21 | Les ombres mouvantes | | | | | | | |
| 22 | Entre deux horizons | | | | | | | |
| 23 | Les fils du crépuscule | | | | | | | |
| 24 | Au-delà de la lisière | | | | | | | |

**Résumé final**, à remplir :

- Niveaux appréciés :
- Niveaux trop faciles :
- Niveaux trop difficiles :
- Problèmes visuels :
- Problèmes de commandes :
- Problèmes de sauvegarde :
- Problèmes bloquants :
- Niveau 24, appréciation (une seule réponse) : juste et amusant / difficile mais compréhensible / excessivement précis / frustrant ou presque impossible

## 7. Points critiques

### Niveau 14 — Le passage des nuages

- **Ventilateur** : son boîtier est en bas, au centre-droit. Vérifier qu'il est visible et qu'il réagit au clic et à F (un seul ventilateur ici).
- **Rivière de nuages** : la bille y plane, puis le ventilateur la relève.
- **Cible** : très haute, en (722, 131). Elle est derrière un **muret** vertical (x = 690, de y = 300 au sol), que la bille doit survoler.
- **Défaite** : ventilateur laissé éteint, la bille doit perdre de façon compréhensible (en simulation, elle sortait de l'écran).
- **Ensuite** : l'écran « Fin du chapitre 2 » doit proposer « Chapitre 3 · La première orbite ».

### Niveau 17 — L'appel des astres

- La cible (605, 393) est à **≈ 33 unités** du centre du second astre (600, 360) : le halo d'arrivée recouvre presque le cœur doré. Vérifier qu'on distingue bien le halo (turquoise et vert, en forme de fleur) de l'astre (doré).

### Niveau 18 — Le jardin renversé

- La colonne d'air **ne souffle que par intermittence** (cycle de 2 s, active pendant 1 s).
- Vérifier qu'on comprend quand elle souffle : opacité de la zone, chevrons, traînées, et **anneau de rythme** autour de la colonne.
- Couper pour que la bille y tombe **pendant** qu'elle souffle.

### Niveau 19 — Le cœur du verger

- La cible (745, 265) est à **≈ 29 unités** du centre de l'astre (730, 290) : le halo chevauche le cœur. Vérifier sa lisibilité.
- Vérifier aussi que les **deux coupes** se comprennent : la première lance le balancement sur le second fil, la seconde coupe ce fil au plus bas.
- **Ensuite** : écran « Fin du chapitre 3 — Le cœur du verger », avec le bouton « Chapitre 4 · Le dernier rayon ».

### Niveau 23 — Les fils du crépuscule

- **Quatre actions** : éteindre le vent contraire (boîtier au centre, allumé au départ), allumer le ventilateur ascendant (boîtier à gauche), couper le fil de droite, puis le second au plus bas.
- **Attention à F** (§ 3.3) : utilise la **souris ou le tactile** pour le ventilateur de gauche. Si tu essaies F, note ce qui se passe.
- **Mur** : à gauche, il est passé de 55,8 unités en simulation.
- **Cible** : collée au bord gauche (bord du halo à 19 unités). Vérifier qu'elle est entière et visible.

### Niveau 24 — Au-delà de la lisière — **PRIORITÉ HAUTE**

1. **Ventilateur** : allumer le boîtier, en bas à gauche (souris, tactile ou F).
2. **Astre** : en haut à droite. Lisibilité de ses anneaux sur le ciel presque nocturne.
3. **Rafale cyclique** : zone à droite, devant le mur, avec un anneau de rythme (cycle de 2,5 s, active pendant 1 s). La bille doit y arriver **pendant** le souffle. Avec la coupe de référence à 0,25 s, elle y arrive vers 1,9 s.
4. **Mur final** : en simulation, la bille ne le passe qu'avec **7,8 unités** de marge au-delà du contact. C'est très peu.
5. **Timing** : est-ce qu'on gagne sans précision excessive ? **La tolérance réelle n'a pas été mesurée**, et cette mission n'en a pas fait de simulation.
6. **Trois étoiles** : (281, 224), (422, 160), (580, 231).
7. **Cible** : (748, 236), derrière le mur, dans l'anneau de l'astre.
8. **Écran final** : « Filament — Les 24 fils du voyage » doit apparaître **après** la victoire, et pas avant.

**Ton avis** (une seule réponse) : juste et amusant · difficile mais compréhensible · excessivement précis · frustrant ou presque impossible.

## 8. Reprise de sauvegarde (procédure non destructive)

1. Lance Docteur **normalement**, comme d'habitude.
2. Ouvre l'Arcade, puis Filament.
3. Lis la ligne de progression (« Progression retrouvée sur cet appareil. ») et vérifie les étoiles des niveaux 1 à 8 dans la grille.
4. Termine **un niveau auquel tu as normalement accès** (le niveau conseillé, par exemple le 9).
5. Vérifie ses étoiles dans la grille et la ligne « Progression enregistrée sur cet appareil. ».
6. Quitte Docteur normalement.
7. Relance Docteur.
8. Rouvre Filament.
9. Vérifie que ce niveau et ses étoiles ont été conservés.
10. Vérifie que « Continuer » propose le niveau suivant non gagné.

Pendant cette procédure, ne supprime pas IndexedDB, ne crée pas de nouvelle sauvegarde, ne réinitialise rien et n'utilise aucun script. Si la ligne indique « illisible ou plus récente » ou « stockage indisponible », note-le tel quel et ne fais rien de plus.

## 9. Écrans de fin à vérifier

| Après | Kicker attendu | Titre | Boutons |
|---|---|---|---|
| Niveau 8 | Fin du chapitre 1 | Les Jardins de l'Aube sont traversés | Chapitre 2 · Premier souffle · Rejouer ce niveau · Menu |
| Niveau 14 | Fin du chapitre 2 | Les Courants d'Altitude sont traversés | Chapitre 3 · La première orbite · Rejouer ce niveau · Menu |
| Niveau 19 | **Fin du chapitre 3 — Le cœur du verger** | Les Vergers Stellaires sont traversés | Chapitre 4 · Le dernier rayon · Rejouer ce niveau · Menu |
| Niveaux 20 à 23 | Niveau n réussi | La bille a rejoint le halo | Niveau suivant · … · Rejouer · Menu |
| Niveau 24 | Fin du chapitre 4 — Au-delà de la lisière | **Filament — Les 24 fils du voyage** | Rejouer ce niveau · Menu |

Le texte de l'écran final rappelle les 4 chapitres, les étoiles du dernier niveau et celles du voyage entier, puis dit « Merci d'avoir joué. ».

## 10. Signaler un bug

Pour chaque problème, il suffit de noter :

- le numéro du niveau et ce que tu faisais (coupe, ventilateur, à quel moment à peu près) ;
- ce que tu as vu, et ce que tu attendais ;
- s'il se reproduit en recommençant (R) ;
- le mode (souris, tactile ou clavier ; mouvement réduit oui ou non) ;
- une capture si tu le souhaites, déposée où tu veux et indiquée par son chemin.

Toute correction de niveau sera une **mission séparée, ciblée, avec ses propres contrôles** : une seule hypothèse et un lancement supervisé.

## 11. Tests non exécutés pendant cette mission

- Aucun essai dans un navigateur, aucun rendu observé, aucune capture.
- Aucune simulation physique, ni pour la tolérance de timing du niveau 24, ni pour les autres niveaux.
- Test unitaire préparé `scripts/test-filament-game-unit.mjs` : non exécuté.
- Aucune lecture de la vraie sauvegarde ni de l'IndexedDB.
- Ni Docteur ni l'Arcade n'ont été lancés.

## 12. Recommandations, seulement si le test confirme un problème

- **Niveau 24 trop précis** : une mission distincte avec une seule hypothèse (par exemple abaisser le sommet du mur, ou élargir ou renforcer la rafale), une seule configuration, un lancement supervisé et le contrôle du ventilateur éteint.
- **Niveau 23 au clavier** : une mission « commandes » sans aucun changement physique. Par exemple, faire viser par F le ventilateur le plus utile, ou ajouter une touche par ventilateur, et adapter le texte d'introduction.
- **Textes de l'Arcade** (« huit niveaux ») : les mettre à jour quand ces deux fichiers seront traités dans leur propre lot de modifications.
- **Lisibilité des cibles proches des astres** (niveaux 17, 19 et 24) : seulement si tu trouves la cible confuse, par un ajustement du rendu, sans toucher à la physique.

## Intégrité

- **Fichiers créés ou modifiés** : ce rapport seulement, plus la mémoire de l'assistant.
- **Fichiers non modifiés** :
  - niveaux : `chapter1.ts` à `chapter4.ts` (`fe2b5c6e` `3d3971ab` `b730adf6` `8ef63699`) ;
  - code du jeu : `levels.ts` `d23668ba`, `main.ts` `741f28fe`, `renderer.ts` `39a684c4`, `physics.ts` `733fd835` ;
  - sauvegarde : `progress.ts` `ad6bdbf3`, `host.js` `a5161b4d` ;
  - laboratoire : lanceur `f0cd7d69` (liste blanche inchangée), bootstrap `633be06b`, lib `d2eeb599`.
- **Interdits respectés** : aucune simulation, aucun script de calibration, aucun navigateur, aucun GPU. Le Node existant n'a pas été touché.
- **Git** : 33 fichiers suivis modifiés, préexistants ; 0 indexé, 0 commit, 0 push.

**Checkpoint : `DOCTEUR_FILAMENT_MANUAL_QA_PREPARATION_CHECKPOINT`**
