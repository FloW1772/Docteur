# Filament — sauvegarde de progression V1 (FILAMENT-3)

**Date :** 2026-10-23
**Verdict :** `FILAMENT_PROGRESS_SAVE_V1_IMPLEMENTED_AWAITING_MANUAL_CHECK`

Point de départ : l'utilisateur a essayé la version à huit niveaux. Le jeu fonctionne, les huit niveaux lui plaisent,
aucun problème majeur. En revanche, les étoiles ne survivent pas à la fermeture.

Périmètre de cette mission : implémentation et contrôles statiques uniquement.

- **Non lancés :** navigateur, serveur, simulation physique, test GPU, benchmark, build.
- **Non exécutés :** les tests préparés.
- **Git :** aucun commit, aucun push.

---

## 1. Analyse du système Arcade (lecture du code actuel)

| Élément | Constat |
|---|---|
| Bac à sable | `<iframe sandbox="allow-scripts">` (`ARCADE_IFRAME_SANDBOX`), sans `allow-same-origin` : origine opaque. La page n'a donc ni `localStorage` utilisable, ni cookies, ni accès à Docteur |
| CSP de la page | `default-src 'none'; … connect-src 'none'` : aucun réseau possible depuis le jeu |
| Protocole | v1, avec enveloppe exacte (canal, version, `gameId`, `instanceId`), plus un `requestId` pour les sauvegardes. L'hôte n'accepte un message que si `event.source` est la fenêtre du cadre actif ; l'origine ne prouve rien pour une origine opaque |
| Persistance existante | **GAME-3**, déjà utilisée par Synapse Run : magasin détenu par l'hôte (`src/lib/arcade/saves.ts`), base IndexedDB dédiée `docteur-arcade`, distincte de Notebook (`docteur-db`), de Companion, de Cortex et du Device Fabric |
| Messages de sauvegarde | `ARCADE_SAVE_LOAD`, `ARCADE_SAVE_WRITE {saveVersion, data}` et `ARCADE_SAVE_DELETE`, avec la réponse `ARCADE_SAVE_RESULT` |
| Clé d'enregistrement | `arcade:v1:<gameId>`, **dérivée du registre** et jamais d'une donnée du message. Un jeu ne peut donc nommer que sa propre sauvegarde |
| Contrôles de l'hôte | capacité `LOCAL_SAVE_V1` et fenêtre de `saveVersion` déclarées dans le registre ; données JSON strictes ; 64 Kio au plus ; 4 requêtes simultanées au plus par instance ; réponse seulement à la fenêtre qui a demandé, si elle est toujours le cadre actif ; aucune requête avant READY |
| Robustesse | enregistrement illisible ou plus récent : jamais écrasé (`CORRUPT_SAVE` ou `UNSUPPORTED_SAVE_VERSION`) ; stockage indisponible : code `STORAGE_UNAVAILABLE`, sans planter |
| Interface hôte | sur la carte du jeu (`ArcadePanel`) : état de la sauvegarde, plus un **effacement en deux étapes** de la seule sauvegarde de ce jeu. Sous le cadre : la ligne d'état de la sauvegarde |
| Progression de Filament avant cette mission | en mémoire uniquement (`best[]` dans `main.ts`), perdue à la fermeture ; les 8 niveaux étaient tous ouverts |

## 2. Architecture choisie

```
Filament (game.js, cadre opaque) ── événements DOM de la même page ──► host.js
host.js ── ARCADE_SAVE_LOAD / ARCADE_SAVE_WRITE + requestId (protocole v1) ──► hôte Arcade (ArcadeGameHost)
hôte ── answerArcadeSaveRequest (save-bridge.ts) ──► magasin GAME-3 (saves.ts)
magasin ──► IndexedDB « docteur-arcade », magasin « saves », clé « arcade:v1:filament »
```

## 3. Justification

- **Mécanisme existant :** c'est le mécanisme déjà audité et certifié pour Synapse Run (GAME-3), sans aucune
  modification du protocole, de l'hôte, du pont ni du magasin.
- **Isolement :** l'iframe reste isolée. Elle ne fait que demander, et seul l'hôte touche au stockage.
- **Aucun ajout :** aucune nouvelle base, aucun nouveau stockage, aucun réseau, aucune dépendance.
- **Activation :** le jeu déclare simplement `LOCAL_SAVE_V1` et sa fenêtre de version dans le registre fermé.

## 4. Fichiers modifiés

| Fichier | Nature | SHA-256 (16 premiers caractères) |
|---|---|---|
| `src/arcade/filament/progress.ts` | **nouveau** : format, validation, fusion du meilleur résultat, session de sauvegarde (pur) | `ad6bdbf3b3cff12b` |
| `src/arcade/filament/main.ts` | la session sauvegardée remplace la mémoire de partie ; ligne de progression ; niveau conseillé ; meilleur résultat | `0d7afdea6ca4afc2` |
| `public/arcade/filament/host.js` | pont de sauvegarde (mêmes règles que `foundation.js` de Synapse Run) | `a5161b4d58ada856` |
| `public/arcade/filament/index.html` | + ligne `#fl-save` dans le pied de page | `1b9c5ae2ca585021` |
| `public/arcade/filament/filament.css` | style du niveau conseillé ; ligne de progression en rose si non sauvegardée | `a7f7aa61dc6edc62` |
| `src/lib/arcade/registry.ts` (suivi par Git) | Filament : + `LOCAL_SAVE_V1`, `save: {currentVersion: 1, minSupportedVersion: 1}`, description | `12997cd58d0c307c` |
| `src/content/capabilities.ts` (suivi par Git) | fiche d'aide : « étoiles et niveaux réussis sauvegardés sur cet appareil » | `19086b6e5a31b724` |
| `scripts/test-arcade-unit.mjs` (suivi par Git) | attend désormais la capacité de sauvegarde de Filament | `fae94cc19cb0475d` |
| `scripts/test-filament-progress-unit.mjs` | **nouveau**, préparé et non exécuté | `3362b4da982dceb4` |

**Inchangés** (empreintes comparées aux copies précédentes) :

- côté Arcade : `protocol.ts`, `ArcadeGameHost.tsx`, `saves.ts`, `save-bridge.ts`, `ArcadePanel.tsx`, `vite.config.ts`
  et le plugin de bundle ;
- côté Filament : `renderer.ts`, `session.ts`, `loop.ts`, `input.ts`, `chapter1.ts` (les 8 niveaux), `levels.ts` et
  `physics.ts` (`733fd835…`) ;
- Synapse Run.

## 5. Format des données (`saveVersion` 1)

```json
{ "format": "filament-progress-v1", "levels": { "ch1-a": 3, "ch1-g": 2 } }
```

- **Ce qui est stocké :** un niveau n'apparaît qu'une fois **gagné**, avec son meilleur nombre d'étoiles (0 à 3).
- **Clés :** ce sont les identifiants stables de `chapter1.ts` (`ch1-a`, `ch1-g`, `ch1-d`, `ch1-b`, `ch1-c`, `ch1-h`,
  `ch1-i`, `ch1-j`). Réordonner les niveaux ne déplace donc aucun résultat.
- **Écriture :** dans l'ordre fixe des niveaux ; la même progression donne toujours les mêmes octets. Taille : environ
  150 octets pour tout le chapitre.
- **Ce qui n'est pas stocké :** trajectoire, position, historique, journal ou donnée personnelle.
- **Enveloppe de l'hôte :** `{schema, gameId, saveVersion, createdAt, updatedAt, bytes, payload}`. Les horodatages sont
  ceux de l'hôte.

**Validation au chargement** (`validateProgress`), sur des données traitées comme non fiables. Pour être accepté, le
contenu doit avoir :

- **la forme exacte :** exactement les clés `format` et `levels` (tout champ inconnu est refusé), avec la chaîne de
  format exacte ;
- **des niveaux connus :** `levels` est un objet simple, avec au plus une entrée par niveau **connu** ; les identifiants
  inconnus sont refusés ;
- **des étoiles valides :** des entiers entre 0 et le nombre d'étoiles du niveau ;
- **une taille bornée :** au plus 2 048 octets, alors que l'hôte borne déjà à 64 Kio.

Le résultat est une nouvelle `Map`, jamais l'objet chargé lui-même. Aucun code n'est exécuté à partir des données.

**Doublons :** le JSON normalisé par l'hôte ne peut pas contenir deux fois la même clé, et l'écriture est canonique.

**Extensibilité :** un futur chapitre fera passer `saveVersion` à 2.

- Le jeu migrera alors les données v1 vers v2, en conservant `minSupportedVersion: 1`.
- Un ancien jeu qui rencontrerait une sauvegarde v2 serait refusé par la fenêtre de version de l'hôte
  (`UNSUPPORTED_SAVE_VERSION`). Il la protégerait au lieu de l'écraser.

## 6. Validation du protocole

Aucun nouveau type de message : seuls les types de la liste blanche existante sont utilisés.

**Côté `host.js`**, une réponse n'est acceptée que si toutes ces conditions sont réunies :

- elle vient de `event.source === window.parent` et de `event.origin === origine de l'hôte` ;
- son enveloppe a exactement les clés attendues, ce canal, cette version, `gameId === 'filament'` et l'`instanceId` de
  ce lancement ;
- son `requestId` correspond à une requête **envoyée par cette page et encore en attente**, pour la même opération ;
- son contenu est conforme : un code d'erreur de la liste fixe, ou `EMPTY` / `FOUND` (avec un `saveVersion`
  numérique) / `SAVED`.

Les autres règles du pont :

- au plus 4 requêtes en attente ;
- le jeu ne peut demander qu'une écriture `{saveVersion entier positif, data}`, et seulement si l'état est actif ou en
  pause ;
- **aucune suppression possible depuis le jeu** ;
- après `ARCADE_STOP`, plus rien n'est accepté, y compris les réponses tardives, et les écouteurs sont retirés.

**Côté hôte** (code GAME-3 inchangé) :

- la fenêtre du cadre actif, après READY ;
- la clé tirée du registre ;
- la capacité `LOCAL_SAVE_V1` ;
- la fenêtre de version ;
- un JSON strict de 64 Kio au plus ;
- au plus 4 requêtes en cours ;
- une réponse seulement si le demandeur est toujours le cadre actif.

Un message de sauvegarde d'un autre jeu, ou d'une autre fenêtre, est rejeté par les contrôles existants.

## 7. Séparation de l'iframe et du stockage

- La page Filament n'appelle ni `localStorage`, ni `indexedDB`, ni le réseau (vérifié par recherche).
- Elle ne connaît ni la clé, ni la base, ni le magasin : elle ne fait que demander.
- L'hôte est seul à écrire, dans la base `docteur-arcade`, distincte de toutes les données privées : notes, mémoire,
  Companion, MAÎTRE, Notebook, Knowledge Graph.
- Rien ne quitte l'appareil.

## 8. Niveaux débloqués

**Règle actuelle conservée :** les 8 niveaux restent ouverts. C'était le comportement de la version que l'utilisateur
a essayée et appréciée. Il n'existe donc pas d'état « verrouillé », et rien n'oblige à recommencer.

Ce que la grille affiche maintenant, à partir de la progression sauvegardée :

- **niveau réussi :** liseré doré et étoiles obtenues ;
- **niveau conseillé :** le premier non réussi, avec un liseré turquoise et « niveau conseillé » pour les lecteurs
  d'écran ;
- **autres niveaux :** disponibles.

Le bouton « Continuer » ouvre le premier niveau non réussi selon la progression sauvegardée, ou le dernier si tout est
réussi. Aucun niveau inexistant n'est proposé.

## 9. Meilleurs résultats

`recordWin` n'écrit que si le résultat **améliore** le meilleur, ou s'il s'agit d'une première victoire.

| Exemple | Résultat |
|---|---|
| 2 étoiles, puis 1 étoile | rien n'est écrit, le meilleur reste 2 |
| ensuite 3 étoiles | le meilleur passe à 3 |
| échec ou redémarrage | aucun appel, rien ne change |

Victoires obtenues pendant le chargement : elles sont gardées en mémoire, puis fusionnées avec ce qui est stocké en
prenant le maximum par niveau, et écrites si quelque chose a progressé.

Écritures :

- une seule à la fois ;
- les changements survenus pendant une écriture sont regroupés en une écriture de suivi ;
- aucune écriture dans la boucle de jeu ni par image : seulement à la fin d'un niveau gagné.

L'écran de victoire rappelle le meilleur résultat quand il est supérieur à celui de la partie.

## 10. Traitement des erreurs

| Situation | Statut | Comportement |
|---|---|---|
| Aucune sauvegarde | READY | progression vide ; « Progression : aucune pour l'instant » |
| Stockage refusé ou en échec (`STORAGE_UNAVAILABLE`, `STORAGE_FAILED`, …) | UNAVAILABLE | le jeu continue, les étoiles restent visibles pendant la partie, rien n'est déclaré sauvegardé ; ligne en rose et une annonce unique |
| Données invalides, enregistrement illisible ou `saveVersion` inconnue | PROTECTED | rien n'est écrit : la sauvegarde est **conservée telle quelle** ; la ligne indique de l'effacer depuis la liste de l'Arcade pour repartir de zéro |
| Écriture en cours | READY | « Progression : enregistrement… », jamais « enregistrée » avant la réponse `SAVED` de l'hôte |
| Écriture échouée | FAILED | message discret ; nouvelle tentative à la prochaine victoire (une par victoire, sans minuterie ni boucle) |
| Fermeture rapide ou réponse tardive | — | `host.js` ignore tout après STOP ; l'hôte ne répond qu'au cadre actif ; chaque lancement a un nouvel `instanceId` et ses propres `requestId` |
| Requêtes trop nombreuses | — | `SAVE_BUSY`, traité comme un échec d'écriture |

## 11. Contrôles statiques réalisés

- `tsc` ciblé (configuration temporaire hors du dépôt) : **0 erreur** (84 fichiers, 0,41 s, 102 Mo).
- `node --check` : `host.js` et 3 fichiers de test, tous OK.
- `git diff --check` : propre. Aucun espace en fin de ligne.
- Recherche dans le jeu : aucun `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`,
  `eval`, `innerHTML`, `setInterval`, `setTimeout`, ni appel au laboratoire ou à `scan`.
- Audit des permissions :
  - `ARCADE_IFRAME_SANDBOX` vaut toujours `'allow-scripts'` ;
  - CSP inchangée ;
  - protocole inchangé (même empreinte) ;
  - Synapse Run : 0 modification ;
  - entrée de registre de Synapse Run identique.

## 12. Tests préparés, non exécutés

`scripts/test-filament-progress-unit.mjs` comporte 9 tests, purs ou en `vm`, sans navigateur ni physique :

- validation (formes, format, identifiants inconnus, bornes, taille) ;
- première victoire, meilleur conservé, montée à 3 étoiles ;
- regroupement des écritures et nouvelle tentative après un échec ;
- fusion chargement + victoires en mémoire ;
- statuts PROTECTED et UNAVAILABLE, second chargement ignoré ;
- registre (Filament sauvegardable, Synapse Run inchangé) ;
- `host.js` : LOAD après INIT, réponses acceptées seulement pour ses propres requêtes, autre jeu refusé ;
- `host.js` : écritures bornées et vérifiées, rien après STOP.

Correspondance avec les 14 scénarios demandés :

- **couverts par ces tests unitaires :** 6, 9, 10, 11, 12, 13 et 14 (registre) ;
- **à vérifier manuellement :** 1 à 5, 7 et 8, qui demandent un navigateur (§ 16).

Les tests existants mis à jour (`test-arcade-unit.mjs`, `test-filament-game-unit.mjs`) n'ont pas été exécutés non plus.

## 13. Risques résiduels

- **Rien n'a été vu en fonctionnement :** l'aller-retour réel avec IndexedDB et le ressenti de la ligne de
  progression n'ont pas encore été observés.
- **Stockage du navigateur :** si le navigateur efface ses données de site (mode privé, nettoyage), la progression
  disparaît. C'est inhérent à un stockage local.
- **Sauvegarde effacée par l'utilisateur :** l'effacement en deux étapes de la carte Arcade remet la progression à
  zéro ; c'est voulu.
- **Fichiers hors Git :** les fichiers Filament ne sont pas suivis. `registry.ts`, `capabilities.ts` et
  `test-arcade-unit.mjs` mélangent ces changements avec d'autres modifications non commitées, à séparer lors d'un
  futur commit.
- **Pas d'alerte en cas de blocage :** un enregistrement protégé (`PROTECTED`) bloque l'écriture jusqu'à son
  effacement ; l'utilisateur doit lire la ligne de progression pour le savoir.

## 14. Préservation des autres modules

| Élément | État |
|---|---|
| Companion | `16f12cbe`, `0c957f4a` |
| MAÎTRE | `511c8a3d`, `7de23e22` |
| Root Policy | `a8e4f7b5` |
| `Docteur-Launcher.bat` | `cd1871b6` |
| Guide privé | 121 fichiers ; hooks `pre-commit` et `pre-push` présents |
| Notebook, Docteur Memory, Knowledge Graph | non touchés |
| Synapse Run | 0 modification |
| Copies locales | toutes intactes (23 sur 23, 2 sur 2, 3 sur 3, 19 sur 19, 18 sur 18) |
| Nouvelle copie | `.tmp/filament-progress-save-backup-2026-10-23/` (9 sur 9) |
| Git | HEAD `b9eeeb4` ; 0 fichier indexé ; 33 fichiers suivis modifiés (ensemble inchangé) ; 0 commit ; 0 push |

## 15. Proposition de répartition des 24 niveaux (à approuver, non commencée)

Le chapitre 1 garde ses 8 niveaux. Les 16 restants se répartissent en 6 + 5 + 5, chaque chapitre apportant une
mécanique que le moteur sait **déjà** simuler.

| Chapitre | Niveaux | Thème et décor | Mécanique nouvelle | Remarque |
|---|---|---|---|---|
| 1 · Jardins de l'Aube | 8 (fait) | nuit vers aube, collines, jardin | fils, tremplin, balancier, murs, faille | sauvegardé (v1) |
| 2 · Courants d'Altitude | 6 | matin pâle, mer de nuages, voiles et cerfs-volants abstraits | courants d'air **cycliques**, puis **ventilateurs** que le joueur actionne (action `TOGGLE`, déjà prévue par le moteur) | demande le dessin des courants (absent du rendu actuel) |
| 3 · Vergers Stellaires | 5 | nuit violette profonde, arbres-constellations, comètes | **puits stellaires** (gravité locale) et **picots** de rebond | demande le dessin des puits |
| 4 · Lisière du Crépuscule | 5 | soleil couchant, reflets d'eau, lucioles | combinaison : plusieurs fils, courants, puits et failles ; finale | difficulté la plus haute, sans fenêtre de timing plus étroite que celle de CH1-B |

Principes pour la suite :

- **Difficulté :** progressive à l'intérieur de chaque chapitre ; chaque chapitre commence par un niveau de découverte
  sans contrainte de timing, comme CH1-G.
- **Conception :** constructive, comme pour FILAMENT-2 (solution choisie, cible et étoiles placées sur la trajectoire
  tracée, puis rejeu et mesure de tolérance bornés). Toujours sous le lanceur supervisé, sans aucune grille
  exhaustive.
- **Sauvegarde :** passage à `saveVersion` 2 (identifiants `ch2-…`, etc.), avec migration de v1 dans le jeu et
  `minSupportedVersion: 1`.

## 16. Procédure du futur test manuel (à autoriser séparément, 5 minutes au plus)

1. Démarrer Docteur comme d'habitude, ouvrir l'Arcade, puis Filament.
   - **À vérifier :** la ligne du bas passe de « vérification… » à « aucune pour l'instant » (première fois).
2. Gagner le niveau 1.
   - **À vérifier :** la ligne indique « enregistrement… » puis « enregistrée sur cet appareil » ; au retour au menu,
     le niveau 1 porte ses étoiles et le niveau 2 est conseillé.
3. Rejouer le niveau 1 en obtenant moins d'étoiles (ou perdre).
   - **À vérifier :** le meilleur résultat est conservé.
4. Quitter avec « Retour à l'Arcade ».
   - **À vérifier :** la carte Filament indique « Sauvegarde locale disponible ».
5. Relancer Filament.
   - **À vérifier :** les étoiles sont retrouvées et « Continuer · Niveau 2 » est proposé.
6. Facultatif : fermer complètement Docteur, le relancer, et vérifier l'étape 5 de nouveau.
7. En cas de message en rose (stockage indisponible ou illisible) : le noter, sans insister.
