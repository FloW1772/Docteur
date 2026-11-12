# Filament — première tranche verticale jouable (FILAMENT-1)

**Date :** 2026-10-23
**Verdict :** `FILAMENT_FIRST_PLAYABLE_IMPLEMENTED_AWAITING_RUNTIME_VALIDATION`

Le code est implémenté et vérifié statiquement. **Il n'a été lancé ni dans un navigateur ni dans un serveur.**

Pendant cette mission : aucun test exécuté, aucune simulation physique, aucun build, aucun benchmark, aucune capture,
aucun commit ni push. Aucun rapport historique n'a été modifié.

---

## 1. État de Filament avant la mission

| Élément | État |
|---|---|
| Moteur | `src/arcade/filament/physics.ts` seul (PBD, 120 Hz), SHA-256 `733fd835…1b59` |
| Rejeux validés sous le lanceur | CH1-A : `WON`, 3 étoiles, tick 87 · CH1-B : `WON`, 3 étoiles (ticks 113, 130, 146), tick 221 |
| Watchdog | délai de 10 s validé (code 3) |
| Rendu, page, entrées, intégration Arcade | aucun |
| Git | HEAD `b9eeeb4`, 0 fichier indexé, 27 fichiers suivis modifiés ; tous les fichiers Filament hors Git |
| Copies locales | `filament-design-preserved-2026-10-22`, `filament-replay-backup-2026-10-23` (23 sur 23), `filament-watchdog-backup-2026-10-23`, `filament-ch1-b-backup-2026-10-23` |

## 2. Architecture finale

La simulation, l'affichage, les commandes, les niveaux et l'intégration à l'hôte sont séparés :

```
src/arcade/filament/            (bundlé dans /arcade/filament/game.js, script classique IIFE)
  physics.ts   moteur certifié, INCHANGÉ (733fd835…)
  levels.ts    les 2 niveaux approuvés (données des fixtures rejouées) + solutions de référence (non jouées)
  session.ts   une tentative : actions validées, budget de 7 200 ticks (60 s), issue
  loop.ts      pas fixe borné : ≤ 4 pas par image, retard au-delà abandonné
  input.ts     géométrie pure : tap ou clic près d'un fil, trait qui le traverse, touches
  renderer.ts  Canvas 2D « Jardins de l'Aube » ; lit l'état, ne l'écrit jamais
  main.ts      écrans, pause, commandes, événements hôte, nettoyage
public/arcade/filament/
  index.html   page statique, même CSP stricte que Synapse Run
  host.js      pont du protocole v1 (vérifications identiques à foundation.js, sans sauvegarde)
  filament.css styles d'origine, sans image, police ni ressource distante
scripts/vite-arcade-filament-bundle.mjs   plugin Vite dédié (Synapse Run conserve le sien)
```

Le flux de données est à sens unique :

- l'hôte valide les messages, puis `host.js` les transmet en événements `filament:host` ;
- `main.ts` pilote la session et la boucle, puis appelle `stepSim` ;
- le renderer lit l'état ;
- le rendu n'influe jamais sur la physique.

## 3. Fichiers créés (11 fichiers, 1 545 lignes)

| Fichier | Lignes | SHA-256 (16 premiers caractères) |
|---|---|---|
| `src/arcade/filament/levels.ts` | 79 | `ea9a8a4b6e3e4df4` |
| `src/arcade/filament/session.ts` | 86 | `2da2c0f3d7e64a13` |
| `src/arcade/filament/loop.ts` | 59 | `f84c5084a1759609` |
| `src/arcade/filament/input.ts` | 79 | `3cd8a8f947b363ce` |
| `src/arcade/filament/renderer.ts` | 357 | `77e5405ba42ba7b7` |
| `src/arcade/filament/main.ts` | 486 | `41a55fc0294a8e8d` |
| `public/arcade/filament/index.html` | 52 | `38c4dc975c253985` |
| `public/arcade/filament/host.js` | 99 | `edd7ae962b0394d2` |
| `public/arcade/filament/filament.css` | 90 | `b261cfcdaac4d4ef` |
| `scripts/vite-arcade-filament-bundle.mjs` | 78 | `9143692a8ed268b4` |
| `scripts/test-filament-game-unit.mjs` (préparé, non exécuté) | 80 | `24380975c0d192ab` |

## 4. Fichiers modifiés

Les 6 fichiers suivis par Git totalisent +65 / −11 lignes.

| Fichier | Modification |
|---|---|
| `src/lib/arcade/registry.ts` | + `'filament'` dans `ArcadeGameId` ; + capacité `HOST_EXIT_REQUEST` ; + champ `controlsHint` (texte de Synapse Run repris **à l'identique** depuis l'hôte) ; + entrée Filament |
| `src/lib/arcade/protocol.ts` | + événement `ARCADE_EXIT_REQUEST`, avec une charge vide imposée |
| `src/components/arcade/ArcadeGameHost.tsx` | traitement de la demande de sortie (après READY, et seulement si la capacité est déclarée) ; aide clavier lue dans `game.controlsHint` ; ligne de sauvegarde « aucune pour ce jeu » quand `save` vaut `null` |
| `vite.config.ts` | + 1 import et + 1 plugin (`arcadeFilamentBundlePlugin()`) |
| `scripts/test-arcade-unit.mjs` | registre à 2 jeux, CSP et ressources de la page Filament, analyse de `ARCADE_EXIT_REQUEST` |
| `scripts/test-arcade-browser.mjs` | scénario B : 2 cartes au lieu de 1 |

En plus, `src/content/capabilities.ts` reçoit une phrase sur Filament dans la fiche Arcade (l. 131) et le mot-clé
`filament`. Ce fichier contenait déjà d'autres modifications non commitées ; elles n'ont pas été touchées.

Le nombre de fichiers suivis modifiés passe donc de 27 à 33.

## 5. Origine des niveaux

`levels.ts` reprend **champ pour champ** les fixtures rejouées sous le lanceur :

- `scripts/filament-single-replay-fixture.mjs` (CH1-A) ;
- `scripts/filament-replay-ch1-b-fixture.mjs` (CH1-B).

Pour CH1-B, l'aide `pend` est recopiée telle quelle, ce qui donne exactement le même nombre flottant pour la position
de départ. Les solutions (CH1-A : coupe au tick 4, victoire au tick 87 ; CH1-B : coupe au tick 92, victoire au
tick 221) sont gardées dans `reference`. Elles ne servent qu'aux vérifications : **le jeu ne coupe jamais un fil de
lui-même.** Le test préparé compare les données aux fixtures avec `deepStrictEqual`.

Aucun niveau n'a été créé. Les chapitres 2 à 4 n'ont pas été touchés.

## 6. Système de rendu

Le rendu utilise **Canvas 2D standard**, sans WebGL, sans Three.js et sans aucune dépendance. La page ne force
aucune option GPU. Le navigateur peut toutefois accélérer Canvas 2D selon ses réglages habituels.

Ambiance « Jardins de l'Aube » :

- ciel bleu nuit qui s'éclaircit en violet puis en rose d'aube ;
- 70 étoiles décoratives à position déterministe, dont 12 scintillent ;
- une constellation discrète et deux collines en silhouette ;
- une bille chaude au halo doré ;
- des fils clairs avec des ancres annulaires ;
- des étoiles à 5 branches ;
- un halo cible turquoise qui pulse doucement ;
- des murs lavande lisibles, sur trois épaisseurs.

L'identité visuelle est originale. Aucun élément ne vient de Cut the Rope.

Économie de ressources :

- **contextes :** 2 contextes créés une seule fois, celui du canvas et celui d'un calque de fond hors écran ;
- **fond :** redessiné seulement au redimensionnement ou au changement du mode mouvement réduit ;
- **dessin :** dégradés et forme d'étoile créés une fois puis réutilisés par translation ; aucun `shadowBlur` ni filtre ;
- **résolution :** densité de pixels limitée à 2, avec un plafond de 2 560 × 1 600 pixels ;
- **traînée :** tampon circulaire fixe de 24 points ;
- **effets de coupe :** au plus un par fil ;
- **arrêt :** canvas remis à 0 × 0.

## 7. Boucle de jeu et limites

- **Pas fixe :** les pas de 1/120 s du moteur, à travers l'accumulateur de `loop.ts`.
- **Retard borné :**
  - un écart entre deux images est compté au plus 100 ms ;
  - au plus **4 pas physiques par image** ;
  - le retard au-delà est abandonné : un PC lent voit le jeu au ralenti, il ne rattrape pas des milliers de pas.
- **Tentative bornée :**
  - fins prévues par le moteur : cible, sortie d'écran, immobilisation, 12 s de vol libre ;
  - en plus, `ATTEMPT_TICK_LIMIT` = 7 200 ticks (60 s), au-delà desquels la tentative est perdue (`TIME_UP`).
- **Aucune recherche :** aucun appel au laboratoire, à `scan`, `scanSummary`, `tolerance`, `trace` ou `replay()`.
  Le test statique préparé le vérifie.
- **`requestAnimationFrame` :**
  - une seule boucle à la fois (garde `!rafId`, ajoutée après relecture) ;
  - arrêt dès que plus rien ne bouge : pause, ou menus en mouvement réduit ;
  - annulation à l'arrêt.

## 8. Commandes du joueur

| Mode | Commande |
|---|---|
| Souris | clic à moins de 22 unités d'un fil, ou trait qui le traverse ; le fil survolé est mis en évidence et le curseur devient une croix |
| Tactile | toucher à moins de 38 unités, ou glisser ; `touch-action: none` sur le canvas ; bouton « Couper le fil » de 48 px |
| Clavier | Espace, Entrée ou X : couper le fil suivant ; 1 à 8 : couper ce fil ; P ou Échap : pause ; R : recommencer ; N : niveau suivant après une victoire |

Garde-fous :

- une corde déjà coupée, ou déjà demandée pour le tick suivant, n'est pas recoupée ;
- un indice invalide est refusé avant d'atteindre le moteur ;
- toute action est refusée en pause, sur un menu ou après la fin du niveau ;
- une touche maintenue n'agit qu'une fois ;
- Espace ou Entrée sur un bouton actionne ce bouton, jamais une coupe ;
- le jeu ne reçoit aucun paramètre d'action de l'extérieur : l'hôte ne transmet que INIT, PAUSE, RESUME et STOP.

## 9. Menus

| Écran | Contenu |
|---|---|
| Titre | « Filament — Les Liens du Ciel » ; boutons « Commencer · Niveau 1 » et « Niveau 2 · Le balancier » |
| Présentation d'un niveau | titre, conseil, rappel des commandes ; boutons « Jouer » et « Menu » |
| Victoire | étoiles obtenues sur 3 ; pour CH1-A : « Niveau suivant · Le balancier », « Rejouer », « Menu » ; pour CH1-B : « Fin de la préversion » (2 niveaux, d'autres plus tard), « Rejouer ce niveau », « Recommencer au niveau 1 », « Menu » |
| Échec | raison en clair (sortie du ciel, immobilisation, dérive, temps écoulé…) ; boutons « Réessayer » et « Menu » |
| Arrêt | « Filament est arrêté » |

Bandeau du haut :

- titre ;
- chapitre, numéro et nom du niveau ;
- compteur ★☆☆ ;
- boutons Pause, Recommencer et « Retour à l'Arcade ».

Accessibilité :

- **pour les lecteurs d'écran :** le canvas porte une description textuelle du niveau (`aria-label`), et une région
  `aria-live` annonce les coupes, les étoiles, la victoire et l'échec ;
- **focus :** focus visible en or ; le focus ne bouge que si le cadre l'a déjà (`document.hasFocus()`, comme Synapse
  Run, ajouté après relecture) ;
- **petits écrans :** mise en page adaptée en dessous de 480 px de large et de 360 px de haut ;
- **mouvement réduit :** préférence de l'hôte (`ARCADE_INIT.reducedMotion`) ou `prefers-reduced-motion`. Sont alors
  supprimés le scintillement, la pulsation, la traînée, l'animation de coupe et celle de cueillette. Les obstacles
  et la mécanique restent identiques.

## 10. Pause

La pause suit les trois raisons indépendantes de Synapse Run :

| Raison | Déclenchement | Levée |
|---|---|---|
| `PLAYER` | P, Échap ou le bouton Pause | « Reprendre » |
| `HOST` | `ARCADE_PAUSE` de Docteur | uniquement `ARCADE_RESUME` ; le menu l'explique |
| `HIDDEN` | page masquée ; ajoute aussi `PLAYER` | au retour, le jeu ne reprend jamais seul : le menu attend « Reprendre » |

Pendant une pause :

- la physique est figée ;
- la boucle d'affichage est arrêtée ;
- l'accumulateur est remis à zéro à la reprise.

## 11. Intégration à l'Arcade

- **Catalogue :** Filament est inscrit dans le registre fermé, avec la route fixe `/arcade/filament/index.html`.
  - statut `PLAYABLE_CORE` et disponibilité `PLAYABLE_PREVIEW` : badges « Jouable » et « Version préliminaire » ;
  - étape suivante affichée : **« VALIDATION VISUELLE »** ;
  - description indiquant qu'il s'agit d'une préversion de deux niveaux, sans sauvegarde.
- **Bundle :** un plugin Vite séparé.
  - en développement, `game.js` est servi depuis la mémoire ;
  - `vite build` l'émet dans `dist/`, et le précache PWA le reprend (motif `**/*.{js,css,html,…}` existant) ;
  - `navigateFallbackDenylist` couvre déjà `/arcade/`.
- **Sauvegarde :** **reportée**, avec `save: null`. Pour la réutiliser, il faudrait un second pont de sauvegarde dans
  la page, que l'audit de cette mission ne couvre pas. La carte n'affiche donc pas de commande de sauvegarde.
- **Sortie :** le bouton « Retour à l'Arcade » envoie `ARCADE_EXIT_REQUEST`, avec une charge vide.
  - l'hôte l'accepte seulement après READY, depuis la fenêtre du cadre actif, et pour un jeu qui déclare
    `HOST_EXIT_REQUEST` ;
  - il fait alors exactement ce que fait son bouton « Arrêter » (STOP puis fermeture) ;
  - Synapse Run ne déclare pas cette capacité : une telle demande venant de lui serait ignorée et comptée comme message
    rejeté.

## 12. Sécurité du bac à sable

| Protection | État |
|---|---|
| `<iframe sandbox="allow-scripts">` | inchangé (`ARCADE_IFRAME_SANDBOX`), sans `allow-same-origin` |
| Politique de permissions | inchangée : aucune caméra, aucun micro, aucun plein écran délégué… |
| CSP de la page | identique caractère pour caractère à Synapse Run (vérifiée par le test préparé) : `connect-src 'none'`, `script-src 'self'`, etc. |
| Validation de l'enveloppe | dans `host.js` comme dans le protocole de l'hôte : canal, version, `gameId`, `instanceId`, clés exactes ; `event.source` égal au parent, `event.origin` égal à l'origine de l'hôte |
| Réseau, stockage, évaluation de code | aucun `fetch`, `WebSocket`, `localStorage`, `indexedDB`, `eval`, import dynamique ni WebGL (vérifié par grep) |
| Données de Docteur | aucun accès à MAÎTRE, Notebook, Companion ou aux bases ; aucun nouveau canal |

## 13. Préservation de Synapse Run

**Fichiers de Synapse Run :** aucune modification. Sont concernés :

- `src/arcade/synapse-run/*` ;
- `public/arcade/synapse-run/*` ;
- `scripts/vite-arcade-game-bundle.mjs`, dont la sortie certifiée ne peut pas changer ;
- `ArcadePanel.tsx`, `arcade.css`, `saves.ts` et `save-bridge.ts`.

**Fichiers partagés :** modifiés sans effet sur Synapse Run.

- le texte d'aide clavier passe dans le registre, à l'identique ;
- la ligne de sauvegarde est inchangée pour un jeu qui a une sauvegarde ;
- la demande de sortie est sans effet sur Synapse Run, qui ne déclare pas `HOST_EXIT_REQUEST` ;
- `ARCADE_GAMES[0]` reste Synapse Run, dont dépendent les tests de sauvegarde.

## 14. Contrôles statiques réalisés

| Contrôle | Résultat |
|---|---|
| `node --check` (`host.js`, plugin de bundle, 3 fichiers de test) | 5 sur 5 OK |
| `tsc --noEmit` ciblé (configuration temporaire hors du dépôt : Filament, `src/lib/arcade`, `src/components/arcade`) | **0 erreur** ; 82 fichiers, 0,37 s, 104 Mo ; relancé après les corrections |
| `git diff --check` (7 fichiers suivis modifiés) | propre |
| Espacement des 11 nouveaux fichiers (`--no-index`) | propre |
| Recherche d'API interdites et de boucles | seule boucle `while` : celle de `loop.ts`, bornée à 4 pas. Le vidage des fonctions de nettoyage est borné. La boucle de `replay()` dans `physics.ts` n'est pas utilisée |
| Moteur, laboratoire, lanceur, bootstrap, fixtures | empreintes inchangées |
| Synapse Run | 0 fichier modifié |

Défauts trouvés et corrigés par relecture, avant toute exécution :

1. **Deux boucles d'animation possibles :** à la fin d'un niveau, `finishAttempt()` relançait l'animation depuis
   `frame()`.
2. **Partie figée sans menu :** une partie démarrée pendant une pause de Docteur restait figée. Elle affiche
   maintenant le menu de pause.
3. **Allocations répétées :** des objets étaient alloués à chaque mouvement de pointeur. Ils sont maintenant
   préparés une fois par tentative.
4. **Vol de focus :** le focus pouvait être pris à la page de Docteur.
5. **Petit décalage de rendu :** l'interpolation s'appliquait aussi pendant les pauses.

## 15. Tests dynamiques non effectués

Aucun de ces tests n'a été exécuté :

- `test-arcade-unit.mjs` et `test-arcade-browser.mjs` (modifiés) ;
- `test-filament-game-unit.mjs` (préparé) ;
- un build Vite ;
- le serveur de développement ;
- le navigateur et Playwright ;
- toute simulation ou capture ;
- un benchmark ;
- la session de jeu (`session.ts`) appelée dans un vrai navigateur.

**Rien n'est validé en fonctionnement.** En particulier, n'ont jamais été vérifiés :

- l'affichage réel ;
- la sensibilité des commandes ;
- le bundle Vite de Filament ;
- le précache ;
- le comportement de la sortie demandée par le jeu.

## 16. Fonctionnalités manquantes

- Sauvegarde de la progression (étoiles par niveau, niveau débloqué).
- Son.
- Aide fondée sur la solution de référence.
- Plusieurs fils, courants d'air et puits stellaires dans le rendu : le moteur les gère, mais aucun niveau approuvé
  ne les utilise. Le rendu ne trace ni courants ni puits.
- Niveaux au-delà de CH1-B.
- Tests de la session à exécuter sous le lanceur supervisé (à préparer).

## 17. Plan du premier test visuel contrôlé (à autoriser séparément)

1. **Préparation, sans exécution :**
   - vérifier les empreintes du § 3 et la copie `.tmp/filament-first-playable-backup-2026-10-23/` (19 sur 19) ;
   - vérifier qu'aucun serveur Docteur ne tourne.
2. **Lancement, par l'utilisateur ou sur sa demande explicite :**
   - démarrer Docteur avec le lanceur habituel, sans option GPU ni suite graphique ;
   - le serveur de développement construit `game.js` en mémoire au premier chargement.
3. **Parcours dans le navigateur habituel, en une session courte (5 minutes au plus) :**
   - Arcade, puis carte Filament, puis « Jouer à Filament » ;
   - titre, puis niveau 1 : couper à la souris, observer la chute, les 3 étoiles et la victoire ;
   - niveau suivant, puis niveau 2 : couper au bas du balancier ;
   - au moins une fois : un échec, Pause, Recommencer, Retour à l'Arcade ;
   - si possible : le clavier (Espace) et le bouton « Couper le fil ».
4. **À observer :**
   - lisibilité ;
   - fluidité ;
   - absence d'erreur « Fermé par sécurité » ;
   - charge du processeur dans le Gestionnaire des tâches ;
   - fermeture propre.
5. **En cas d'anomalie :** fermer le jeu et décrire ce qui s'est passé, sans campagne de tests.

## 18. Risques résiduels

- **Code jamais exécuté :** des défauts d'exécution restent possibles. Le premier symptôme serait une erreur de
  `game.js`, et l'hôte fermerait alors le cadre par sécurité.
- **Comportement de la sortie demandée par le jeu :** non vérifié.
- **Équilibre de CH1-B :** la fenêtre de réussite est étroite (environ −4 / +6 ticks, soit environ 80 ms). Elle peut
  être difficile à la main. Rien n'est ajusté sans mesure.
- **Coût du rendu :** non mesuré, ni en rendu logiciel ni en rendu matériel. Le canvas plein cadre redessine 60 fois
  par seconde pendant une partie.
- **Accélération du navigateur :** Canvas 2D peut être accéléré par le navigateur. Ce n'est pas une absence de GPU.
- **Tests existants modifiés sans exécution :** ces tests ne protègent donc pas encore contre une régression. Les
  suites navigateur de l'Arcade forcent SwiftShader et restent exclues par `ARCADE_TEST_RULES.md`.
- **Fichiers hors Git :** les fichiers Filament ne sont pas suivis. Ils sont sauvegardés seulement sous `.tmp/`.
- **Mélange de modifications :** `capabilities.ts` mélange désormais une modification Filament et des modifications
  Companion antérieures, à séparer au moment d'un futur commit.
- **Cause du BSOD :** inconnue.

## Intégrité

| Élément | État |
|---|---|
| Companion | `16f12cbe`, `0c957f4a` |
| MAÎTRE | `511c8a3d`, `7de23e22` |
| Root Policy | `a8e4f7b5` |
| `Docteur-Launcher.bat` | `cd1871b6`, inchangé |
| Guide privé | 121 fichiers |
| Notebook et Knowledge Graph | non touchés |
| Copies `.tmp` | toutes présentes ; `filament-replay-backup` 23 sur 23 OK |
| Nouvelle copie | `.tmp/filament-first-playable-backup-2026-10-23/` (19 fichiers, `SHA256SUMS.txt` 19 sur 19 OK) |
| Git | 0 fichier indexé, 0 commit, 0 push |
