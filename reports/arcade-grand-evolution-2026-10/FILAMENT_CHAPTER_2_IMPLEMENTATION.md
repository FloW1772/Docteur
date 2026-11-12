# Filament — chapitre 2 « Courants d'Altitude » : implémentation (FILAMENT-4)

**Date :** 2026-10-23
**Verdict :** `FILAMENT_CHAPTER_2_PARTIAL`

Ce qui est fait : le code, l'interface, le décor et les spécifications des six niveaux.

Ce qui manque, volontairement : la cible, les étoiles et la solution vérifiée de chaque niveau. Ces éléments
n'existent qu'après une simulation supervisée, que cette mission interdisait. Aucun niveau du chapitre 2 n'est donc
jouable ; ils sont affichés « en préparation ».

Pendant cette mission : aucune simulation physique, aucun lancement du lanceur, aucun navigateur, aucun GPU, aucun
benchmark, aucun build, aucun commit ni push.

---

## 1. État initial du chapitre 1

- **Niveaux :** 8 niveaux dans `chapter1.ts` (`fe2b5c6e…`), joués et appréciés par l'utilisateur.
- **Sauvegarde :** confirmée par l'utilisateur après fermeture et réouverture. Elle passe par le stockage de l'Arcade
  (GAME-3), avec la clé `arcade:v1:filament`.
- **Fichiers au départ :** tous identiques aux copies `filament-content-visual-backup` (18 sur 18) et
  `filament-progress-save-backup` (9 sur 9). L'état de départ est donc déjà conservé.
- **Git :** HEAD `b9eeeb4` ; 0 fichier indexé ; 33 fichiers suivis modifiés.

## 2. Capacités réellement présentes dans le moteur (`physics.ts`, lu, non modifié)

| Capacité | Présente | Détail |
|---|---|---|
| Courants d'air (zones de vent) | **oui** | `CurrentDef {x, y, w, h, ax, ay}` : rectangle aligné sur les axes, accélération constante tant que le **centre** de la bille est dedans, sans atténuation |
| Direction et intensité | **oui** | le vecteur `(ax, ay)`, en unités/s² (gravité : 900) |
| Courant cyclique | **oui** | `timing {period, on, phase}` en ticks : actif quand `(tick + phase) mod period < on` |
| Ventilateur activable | **oui** | `fan {initiallyOn, device}` et action `{ type: 'TOGGLE', current }`, qui inverse `fanOn` ; `device` est une position, sans effet physique |
| Objets propulseurs | via les courants | pas d'autre propulseur |
| Murs et tremplins | **oui** | segments `wall` (restitution 0,3) et `deflector` (0,78) |
| Failles, picots, puits stellaires | **oui** | non utilisés par les ventilateurs |
| Collisions avec le décor | non | les îles, l'arche et les nuages sont purement décoratifs |

Le laboratoire supervisé accepte jusqu'à 8 courants et les actions `TOGGLE` (`LEVEL_LIMITS`, `validateActions`).

## 3. Mécaniques prises en charge par le jeu après cette mission

- **Vent visible :** zone, chevrons de direction, traînées animées, anneau de cycle (voir § 8).
- **Ventilateurs jouables :**
  - `session.ts`, avec `requestToggle` et `firstFan` ;
  - `input.ts`, avec `pickFan` et la touche **F** ;
  - `main.ts` : toucher ou cliquer sur l'appareil, ou utiliser le bouton « Ventilateur » ;
  - `renderer.ts` dessine les appareils et leurs pales.
- **Garde-fous sur `TOGGLE` :** la demande n'est acceptée que pour un courant **qui possède un ventilateur**, pendant
  la partie, une fois par tick, et elle est appliquée au tick suivant, après les coupes.
- **Chapitre 1 :** sans ventilateur, il transmet exactement les mêmes listes d'actions au moteur qu'avant.

## 4. Mécaniques manquantes

Rien ne manque dans le moteur pour ce chapitre.

Restent à faire, **hors de cette mission** : le placement de la cible et des étoiles, et la solution de référence de
chaque niveau. Les deux exigent la simulation supervisée (§ 16).

Le dessin des puits stellaires et des picots n'est pas fait ; il concerne le chapitre 3.

## 5. Les six niveaux (spécifications, `src/arcade/filament/chapter2.ts`)

Statut des six niveaux : **`PENDING_VALIDATION`**.

**Ce que contient chaque spécification :**

- **géométrie :** chaque fil est tendu au départ (construction `pend()` ou fil vertical), et la bille ne démarre
  jamais dans une zone de vent ;
- **jeu :** les vents, les obstacles et les failles ;
- **description :** l'intention, et un texte de scène pour les lecteurs d'écran.

**L'hypothèse de solution :** les actions dans `design.actions` et la règle de placement de la cible dans
`design.place`. C'est une **hypothèse**, calculée à la main d'après les périodes de pendule et les accélérations ;
**rien n'a été simulé**.

**Ce qui est absent, volontairement :** la cible et les étoiles.

| # | Code | Titre | Éléments | Intention | Hypothèse de solution | Placement de la cible |
|---|---|---|---|---|---|---|
| 9 | CH2-A | Premier souffle | 1 fil (bille immobile), vent latéral +1000 | découvrir le vent, sans contrainte de temps | coupe au tick 20 | descente à travers y = 440 |
| 10 | CH2-B | La traversée | balancier 60°, courant porteur (+400 ; −600), faille | couper au point bas et se laisser porter | coupe au tick 82 | traversée de x = 600 |
| 11 | CH2-C | Les jardins suspendus | balancier 50°, rivière d'air (+900 ; −700), îlot de cristal (tremplin), faille | entrer en douceur dans le courant ; couper trop tôt fait traverser le courant | coupe au tick 66 | traversée de x = 700 |
| 12 | CH2-D | Vents contraires | 1 fil (bille immobile) ; courant vers la droite, puis courant vers la gauche **cyclique** (240 ticks, actif 120) | couper pour traverser le second courant pendant qu'il souffle | coupe au tick 20 | descente à travers y = 460 |
| 13 | CH2-E | Le souffle des cristaux | 1 fil au-dessus d'une faille ; **ventilateur** ascendant (+500 ; −1700), éteint au départ | première action sur le vent : allumer pour être soulevé | allumage au tick 10, puis coupe au tick 30 | descente à travers y = 420 |
| 14 | CH2-F | Le passage des nuages | balancier 55°, courant de nuages, **ventilateur**, muret, faille | finale : couper au point bas, être porté, puis allumer pour franchir le muret | allumage au tick 10, puis coupe au tick 76 | traversée de x = 720 |

Le jeu ne s'en sert pas : ces actions servent uniquement au protocole de validation.

## 6. Objectifs de chaque niveau

| Niveau | Objectif |
|---|---|
| 9 | Comprendre la direction du vent, sans aucune pression |
| 10 | Anticiper une poussée horizontale ; l'échec visible est la faille |
| 11 | Lire l'interaction entre le vent et un obstacle : le cristal renvoie la bille |
| 12 | Observer un indice du décor (l'anneau de cycle) pour choisir l'instant de la coupe |
| 13 | Agir sur le vent : une action claire, bornée, sans contrainte d'ordre stricte |
| 14 | Combiner balancier, courant et ventilateur ; trois étoiles prévues après placement |

Les marges de timing sont **inconnues** tant que rien n'est simulé.

## 7. Nouvelles commandes

| Commande | Effet |
|---|---|
| Toucher ou cliquer l'appareil d'un ventilateur | rayon de 26 à la souris, 42 au toucher ; prioritaire sur les fils |
| Touche **F** | premier ventilateur du niveau |
| Bouton « Ventilateur : éteint / allumé » | `aria-pressed`, 48 px, visible seulement dans un niveau qui a un ventilateur |

Annonces vocales : « Ventilateur allumé » ou « Ventilateur éteint », au tick où le changement s'applique.

Le reste est inchangé : couper, pause, recommencer, retour à l'Arcade.

## 8. Nouveau décor « Courants d'Altitude — Les Jardins du Vent »

Le thème `altitude` est appelé avec `setTheme`.

**Fond**, peint dans le calque mis en cache :

- **ciel :** bleu céleste, d'un matin doré au premier niveau vers le plein jour au dernier, avec des teintes jamais
  saturées ;
- **soleil :** doré, avec son halo ;
- **lointain :** fins nuages hauts et deux plans de montagnes célestes lavande ;
- **arche de cristal :** très légère ;
- **îles flottantes :** trois, avec herbe, racines pendantes et éclats de cristal ; purement décoratives ;
- **vent :** trois longs rubans de vent ;
- **mer de nuages :** trois rangées, la plus proche la plus claire ;
- **vignette :** légère.

**Hiérarchie** : sur ce ciel plus clair, les éléments de jeu reçoivent un fin contour sombre (fils, étoiles,
anneau de la cible, bille). Les murs deviennent ardoise et les tremplins turquoise.

**Vent visible**, pour tout niveau qui a des courants :

- **zone :** voile léger et bord pointillé ;
- **chevrons de direction :** statiques, donc lisibles aussi en **mouvement réduit**, et pâles quand le courant est
  inactif ;
- **traînées animées :** 12 au plus par zone, découpées au cadre de la zone, uniquement sans mouvement réduit ;
- **courant cyclique :** un **anneau** indique la part restante de la phase en cours ;
- **ventilateur :** un appareil rond ; ses pales tournent quand il est allumé (fixes en mouvement réduit) ; un lien
  pointillé le relie à sa zone.

**Chapitre 1 :** même dessin qu'avant. Le thème `aube` garde le même fond et les mêmes valeurs de couleur, sans passe
de contour, et le chapitre 1 n'a pas de courant. Le diff du renderer, une fois le passage de `COLOR.` à `pal.` mis de
côté, ne modifie qu'une condition, et sans effet sur le chapitre 1 : `twinkle` s'applique au thème `aube` seulement.

## 9. Optimisations graphiques

- **Fond :** toujours un calque unique, repeint seulement au redimensionnement, au changement de niveau ou de thème,
  ou au changement du mode mouvement réduit.
- **Formes :** les îles et les nuages sont des formes simples, sans texture ni image.
- **Par image et par zone :**
  - chevrons : un seul tracé, borné par la taille de la zone (au plus environ 190 pour une zone grande comme le
    monde) ;
  - traînées : 12 au plus, en un seul tracé.
- **Courants :** 8 au plus par niveau (limite du laboratoire).
- **Interdits respectés :** aucune allocation par image, aucun `shadowBlur`, aucun filtre, aucun WebGL, aucune
  dépendance.

## 10. Navigation entre chapitres

**Écran titre :**

- **onglets :** « Chapitre 1 · Jardins de l'Aube » et « Chapitre 2 · Courants d'Altitude » (`role="tab"`,
  `aria-selected`) ;
- **grille du chapitre 2 :** 6 tuiles **« En préparation »**, avec bord pointillé et `aria-disabled`. Activer une
  tuile annonce seulement qu'elle s'ouvrira après validation ;
- **aperçu derrière le menu :** quand l'onglet 2 est choisi, la scène du niveau 9 apparaît avec son décor, ses fils et
  ses vents, **sans cible ni étoiles** ; elle n'est jamais simulée.
- **bandeau :** il indique « aperçu du niveau 9 », et le canevas annonce « niveau en préparation, pas encore
  jouable ».

**Fin du niveau 8 :** l'écran « Fin du chapitre 1 » explique que le chapitre 2 (niveaux 9 à 14) est en préparation et
propose « Aperçu du chapitre 2 ».

**Conservés :** « Continuer » (chapitre 1), pause, recommencer, retour à l'Arcade.

## 11. Compatibilité avec les sauvegardes existantes

| Élément | État |
|---|---|
| `progress.ts` (format `filament-progress-v1`) | **inchangé** (`ad6bdbf3…`) |
| Base IndexedDB, clé, protocole, hôte, magasin | **inchangés** (empreintes identiques ; `saves.ts` et `save-bridge.ts` sans aucune modification Git) |
| `host.js` | **inchangé** (`a5161b4d…`) |
| Niveaux sauvegardés | `FILAMENT_LEVELS` contient toujours **les 8 niveaux du chapitre 1 seulement**. La progression et les écritures n'utilisent que cette liste. Les niveaux en préparation ne sont jamais comptés, enregistrés ni proposés par « Continuer » |
| Identifiants | stables : `ch1-*` inchangés ; `ch2-a` à `ch2-f` réservés |
| Extension future | **sans changement de format ni migration**. Le format v1 est un dictionnaire `{identifiant → étoiles}` validé contre la liste des niveaux connus du jeu : il suffira d'ajouter les niveaux validés du chapitre 2 à cette liste |
| Version plus ancienne du jeu | si une version antérieure rencontrait une sauvegarde contenant des `ch2-*`, elle la classerait PROTECTED et ne l'écraserait pas : pas de perte |
| Migration destructive | **aucune** |

À noter : un commentaire de `progress.ts` (FILAMENT-3) annonçait un passage à `saveVersion` 2 pour un nouveau
chapitre. L'analyse ci-dessus montre que ce n'est pas nécessaire. Le commentaire n'a **pas** été modifié, pour ne pas
toucher au fichier validé ; il reste à corriger lors d'une future mission.

## 12. Fichiers

### Créés

| Fichier | SHA-256 (16 premiers caractères) |
|---|---|
| `src/arcade/filament/chapter2.ts` (spécifications, aucun import) | `fbd6955f27610117` |
| `scripts/filament-design-ch2.mjs` (protocole préparé ; **absent de la liste blanche**, non exécuté) | `78e1c7a22dac6f46` |

### Modifiés, non suivis par Git

| Fichier | Modification | SHA-256 (16 premiers caractères) |
|---|---|---|
| `src/arcade/filament/levels.ts` | chapitres, niveaux en préparation, `previewLevel` ; `FILAMENT_LEVELS` inchangé dans son contenu | `0820b0884d89d433` |
| `src/arcade/filament/session.ts` | `requestToggle`, `firstFan`, `toggledFans` | `fbf9a4792e01c03f` |
| `src/arcade/filament/input.ts` | `pickFan`, touche F | `2a98d5285c4e0ade` |
| `src/arcade/filament/renderer.ts` | thème `altitude`, palette, vent, ventilateurs, contours | `4e92125dbe788263` |
| `src/arcade/filament/main.ts` | onglets, tuiles en préparation, aperçu, ventilateur, transition 8 → 9 | `041137010b001630` |
| `public/arcade/filament/index.html` | bouton Ventilateur ; conteneur de la grille | `fc0be1e0118c90c9` |
| `public/arcade/filament/filament.css` | onglets, tuiles en préparation, bouton Ventilateur | `9d15a774b91b9faf` |
| `scripts/test-filament-game-unit.mjs` | tests du chapitre 2 (préparés, non exécutés) | `358905812dad9a09` |

### Inchangés

- **Moteur et niveaux :** `physics.ts`, `chapter1.ts`, `progress.ts`, `loop.ts`.
- **Page et intégration :** `host.js`, registre, protocole, hôte, `vite.config.ts` et les deux plugins de bundle.
- **Lanceur et laboratoire :** le lanceur, sa liste blanche et le laboratoire.
- **Synapse Run.**

**Aucun fichier suivi par Git n'a été modifié par cette mission :** le nombre de fichiers modifiés reste à 33.

Copie de sécurité : `.tmp/filament-chapter2-backup-2026-10-23/` (10 sur 10).

## 13. Contrôles statiques effectués

- `tsc` ciblé (configuration temporaire hors du dépôt) : **0 erreur** (85 fichiers, 0,44 s, 108 Mo). Exécuté après
  chaque étape.
- `node --check` : `filament-design-ch2.mjs`, `test-filament-game-unit.mjs` et `host.js`, tous OK.
- Aucun espace en fin de ligne.
- **Jeu :** aucun `fetch`, `XMLHttpRequest`, `WebSocket`, stockage direct, `eval`, `innerHTML`, `webgl`,
  `setInterval`, `setTimeout`, ni appel au laboratoire ou à `scan`. La seule boucle `while` du jeu (`main.ts`) vide
  une liste finie de fonctions de nettoyage.
- **Script préparé :** le filtre `FORBIDDEN_TEXT` du lanceur, reproduit avec `grep`, ne trouve rien dans son graphe.
  `chapter2.ts` n'importe rien. Le script est **absent** de `APPROVED_SCRIPTS` (0 occurrence).
- **Chapitre 1 :** `chapter1.ts`, `progress.ts`, `physics.ts`, `loop.ts` et `host.js` sont identiques aux copies.

## 14. Simulations non exécutées

- Aucune trajectoire du chapitre 2 n'a été calculée par le moteur.
- Aucune cible ni étoile n'a été placée.
- Aucune marge n'a été mesurée.
- Le script de conception préparé n'a pas été lancé, et le lanceur le refuserait.
- Les tests préparés n'ont pas été exécutés.

## 15. Risques résiduels

- **Hypothèses non simulées :** elles peuvent échouer, par exemple si aucune traversée n'a lieu ou si le niveau n'est
  pas gagné avec 3 étoiles. La validation pourra alors demander d'ajuster la géométrie, comme pour le pont de
  FILAMENT-2.
- **Effet des courants :** il s'applique au centre de la bille, sans atténuation. La sensation de « bord de zone »
  devra être vérifiée en jeu.
- **CH2-B et CH2-F :** le balancier peut entrer dans le courant pendant sa remontée, ce qui modifie son mouvement avant
  la coupe. C'est déterministe, mais à observer.
- **Lisibilité du nouveau décor :** non vérifiée en navigateur, notamment le contraste de la cible et des failles sur
  la mer de nuages, et le coût de rendu.
- **Navigation par onglets :** ni flèches gauche et droite, ni `tabindex` itinérant ; les deux onglets restent
  atteignables par Tab.
- **Commentaire à corriger :** celui de `progress.ts` sur la version 2 (§ 11).
- **Fichiers hors Git :** les fichiers Filament ne sont toujours pas suivis.

## 16. Plan de validation supervisée (à autoriser séparément ; non exécuté)

1. **Mission dédiée :** ajouter **un seul chemin**, `scripts/filament-design-ch2.mjs`, à `APPROVED_SCRIPTS`, puis
   l'auditer (`node --check`, filtre `FORBIDDEN_TEXT`, empreintes).
2. **Un niveau par exécution, dans l'ordre 9 → 14 :**
   - fixer `TARGET` (par exemple `'ch2-a'`) ;
   - lancer une seule fois `node scripts/filament-safe-run.mjs scripts/filament-design-ch2.mjs`, au premier plan ;
   - budget d'environ 70 candidats, au plus 720 pas chacun, sous le plafond de session (2 000 candidats, 200 000 pas,
     8 s).
3. **Lecture du résultat :**
   - **critères :** `WON` avec 3 étoiles, l'essai sans action ne gagne pas, et une tolérance mesurée ;
   - **en cas d'échec** (`NO_CROSSING`, `LOST`, étoiles manquantes, fenêtre trop étroite, viser au moins ±4 ticks pour
     les niveaux d'introduction) : ajuster la géométrie à la main, le documenter, puis relancer seulement sur
     autorisation. Jamais de grille ni de recherche.
4. **Copie des données :** reporter à la main la cible, les étoiles et la référence (ticks de victoire et d'étoiles)
   dans les données du jeu, puis faire passer le niveau en « validé » pour qu'il rejoigne la liste jouable.
5. **Vérification globale :** quand les six niveaux sont validés, un script de vérification (sur le modèle de
   `filament-verify-chapter1.mjs`) rejoue les 14 niveaux, soit 28 candidats.
6. **Contrôle de la sauvegarde :** les niveaux validés du chapitre 2 rejoignent `FILAMENT_LEVELS` et la liste des
   niveaux connus de la progression (format v1 inchangé). Vérifier que la sauvegarde existante du chapitre 1 se
   recharge à l'identique.

## 17. Plan de validation manuelle ultérieure (après le § 16, 5 minutes)

1. **Chapitre 1 inchangé :** ouvrir Filament ; les étoiles sont retrouvées et le décor nocturne est identique.
2. **Aperçu du chapitre 2 :** choisir l'onglet ; vérifier la lisibilité du décor et des vents, et les tuiles du
   chapitre.
3. **Niveaux du chapitre 2, une fois validés :**
   - niveau 9 : direction du vent comprise ;
   - niveau 12 : anneau de cycle compréhensible ;
   - niveau 13 : bouton et touche F ;
   - niveau 14 : finale jouable.
4. **Sauvegarde :** les étoiles du chapitre 2 sont enregistrées et retrouvées après fermeture, et celles du chapitre 1
   sont intactes.
5. **Confort :** pas de ralentissement ; essai en mouvement réduit si possible.
