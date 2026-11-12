# Durcissement de sécurité V2 — revue (2026-10-23)

**`RUNTIME_TESTS_NOT_EXECUTED`** — aucune simulation, aucun test, aucun lancement du lanceur, aucun navigateur.
Tout ce qui suit est une preuve **statique** : lecture du code, `grep`, `node --check` (analyse syntaxique sans
exécution) et `git diff --check`. Rien ici n'est une preuve d'exécution.

## 1. Incident d'origine

Incident système antérieur (BSOD 0xEF, 22/10/2026), survenu pendant une session de conception de niveaux Filament ;
cause non établie. Les mesures de protection décrites ci-dessous ont été renforcées en conséquence. Le rapport
détaillé de l'incident n'est pas publié.

## 2. Les trois défauts de `SAFE_VALIDATION_STAGE_1`

1. Surveillance mémoire en échec ouvert :
   - une mesure impossible était ignorée ;
   - la première mesure n'avait lieu qu'à 1 s ;
   - « 0 Mo » était affiché sans aucune mesure.
2. Contournement de la supervision : l'option `env` permettait à tout appelant de se déclarer supervisé.
3. Budgets cumulés par recherche, pas sur l'ensemble d'un script.

## 3. Fichiers et fonctions modifiés

| Fichier | Empreinte après (16 car.) | Modifications |
|---|---|---|
| `scripts/filament-safe-run.mjs` | `b271e04222f4fcee` | voir détail ci-dessous |
| `scripts/filament-lab-lib.mjs` | `d2eeb5996ba041ff` | voir détail ci-dessous |
| `scripts/test-filament-lab-guards.mjs` | `0884f573fd7bf169` | réécrit pour le nouveau modèle (10 tests, toujours zéro pas physique) |
| `reports/arcade-grand-evolution-2026-10/ARCADE_TEST_RULES.md` | — | nouveau : règles et liste d'exclusion |

**Lanceur, `scripts/filament-safe-run.mjs`** :

- `checkScript` : liste blanche et graphe d'imports ;
- `parseCsvRow`, `parseTasklistMemory`, `measure` : mesure fermée en cas d'échec ;
- `main` : précontrôle, jeton de session, un seul argument ;
- `supervise` : première mesure au démarrage, codes de sortie distincts, minuteur de confirmation actif ;
- échéance absolue, Ctrl+C.

**Laboratoire, `scripts/filament-lab-lib.mjs`** :

- `checkSupervisionEvidence`, `processSession` : supervision par preuve du lanceur ;
- `createSessionLedger`, `labSessionStatus` : budget de session ;
- `checkOptions` : options strictes ;
- `createMeter` : double débit, opération puis session ;
- `precheckScan` : reste de session ;
- `begin`, `run`, `scan`, `scanSummary`, `tolerance`, `trace` ;
- suppression de `assertSupervised(env)`.

Versions v1 conservées (copie) dans `.tmp/arcade-safety-v1-snapshot/` :

| Fichier | Lignes ajoutées | Lignes retirées |
|---|---|---|
| `filament-safe-run.mjs` | 252 | 79 |
| `filament-lab-lib.mjs` | 192 | 59 |
| `test-filament-lab-guards.mjs` | 101 | 35 |

`src/arcade/filament/physics.ts` n'est pas modifié (`733fd8352dfd09ee`).

## 4. Surveillance mémoire (fermée en cas d'échec)

- **Outil** : `tasklist.exe` par chemin absolu (`%SystemRoot%\System32`, sans recherche dans le PATH), sans shell,
  délai 1,5 s, sortie lue octet par octet en latin1 et limitée à 64 Kio.
- **Analyse stricte** (`parseTasklistMemory`) :
  - exactement une ligne CSV, 5 champs entre guillemets ;
  - nom d'image identique au binaire Node utilisé ;
  - PID identique ;
  - mémoire en kilo-octets entiers : chiffres seuls, ou groupes de 3 chiffres séparés par 1 à 3 caractères ni
    chiffres ni lettres ASCII (espace, espace insécable quel que soit le code page, virgule, point, apostrophe) ;
  - unité `K`, `KB` ou `Ko` ;
  - valeur plausible entre 1 Mio et 64 Gio ;
  - tout le reste est un échec explicite, avec un motif (`EMPTY_OUTPUT`, `MULTIPLE_ROWS`, `UNEXPECTED_COLUMNS`,
    `IMAGE_MISMATCH`, `PID_MISMATCH`, `UNREADABLE_MEMORY_FIELD`, `UNKNOWN_UNIT`, `IMPLAUSIBLE_VALUE`,
    `TASKLIST_ERROR_*`).
- **Précontrôle** : avant tout lancement, mesure du propre PID du lanceur (un `node.exe` connu). En cas d'échec :
  `FILAMENT_MEMORY_MONITOR_UNAVAILABLE`, code 8, aucun enfant créé.
- **Mesures** : dès l'événement `spawn` (le PID est valide), puis toutes les 700 ms, une seule à la fois.
  Sur 10 s, cela fait environ 16 appels à `tasklist` au maximum, l'un après l'autre.
- **Échec d'une mesure sur un enfant vivant** : arrêt immédiat de cet enfant seul, code 8. Aucune nouvelle
  tentative, aucun plafond relevé.
- **Ligne absente** : si l'enfant a déjà disparu (`process.kill(pid, 0)` le confirme), son événement `exit` est en
  attente et ce n'est pas un échec. S'il est encore vivant, c'est un échec.
- **Dépassement de 350 Mio** : code 4. Le tas reste limité à 128 Mio, ce qui ne borne pas la mémoire native.
- **Rapport mémoire** :

  | Statut | Pic rapporté |
  |---|---|
  | `MEASURED` | valeur mesurée, avec le nombre de mesures |
  | `NOT_MEASURED` | `null`, jamais 0 |
  | `MONITOR_FAILED` | `null` ou valeur partielle, avec le motif |

  Un enfant qui se termine avec 0 sans aucune mesure renvoie le code 11 (`SUPERVISION_INCOMPLETE`), jamais 0.

## 5. Contournement `env` supprimé

- L'option `env` n'existe plus. Les options sont strictes : seulement `budget` et `signal`, plus `step`, `maxTick`
  et `gap` pour les recherches, et `limit` pour `tolerance`. Toute autre clé (`env`, `session`…) ou une option non
  objet (l'ancien argument numérique de `trace`) est refusée avec `FILAMENT_SEARCH_INVALID`, avant tout le reste.
- La supervision repose sur une preuve fournie par le lanceur vivant :
  - un nonce aléatoire de 32 octets, différent à chaque exécution, transmis uniquement à l'enfant
    (`FILAMENT_LAB_SESSION`) ;
  - le fichier verrou ne contient que son SHA-256 et le PID du lanceur ;
  - le laboratoire exige à la fois que le hash corresponde et que le propriétaire du verrou soit son processus
    parent (`process.ppid`).
  - Aucun jeton statique ni clé n'est stocké dans le dépôt. Une variable d'environnement seule ne suffit plus.
- **Limite** : ce n'est pas une sandbox. Du JavaScript écrit exprès pour la contourner le peut : lire le verrou,
  forger le contexte, pré-enregistrer un faux registre sur `globalThis`, ou importer directement `physics.ts` hors
  des outils officiels. Le but est d'empêcher les exécutions accidentelles et de rendre le lanceur obligatoire pour
  les outils officiels.

## 6. Budget global par script

Un registre unique par processus (`SESSION_BUDGET`) : 2 000 candidats, 200 000 pas, 8 s (sous les 10 s externes).

- Ses compteurs vivent dans une fermeture. L'objet est gelé et enregistré une seule fois sur `globalThis` sous un
  symbole non modifiable et non reconfigurable : une seconde instance du module le partage, et aucun objet fourni
  par l'appelant ne peut le remplacer.
- Chaque pas et chaque candidat de `run` (rejeu borné), `scan`, `scanSummary`, `tolerance` et `trace` est débité
  du budget de l'opération puis de la session.
- Le précontrôle refuse aussi une grille plus grande que le reste de la session.
- Une limite de session dépassée, ou une annulation, ferme la session pour de bon : toute opération suivante est
  refusée avec `FILAMENT_LAB_SESSION_EXHAUSTED`. Une nouvelle tentative après erreur ne remet rien à zéro.
- Le temps de session est vérifié à l'ouverture de chaque opération, à chaque candidat et tous les 64 pas : une
  suite d'appels courts ne peut pas le dépasser.
- Les budgets restent des plafonds qu'on peut seulement abaisser. Il n'y a pas d'interface en ligne de commande,
  et le lanceur refuse tout argument supplémentaire.
- Une recherche interrompue n'est jamais comptée comme une défaite : erreur typée, ou `UNRESOLVED` au plafond par
  candidat.

## 7. Politique des processus

- Un seul enfant : `process.execPath`, `shell: false`, `detached: false`, `--max-old-space-size=128`, sans
  nouvelle tentative.
- Arrêt uniquement par le handle de l'enfant créé (`child.kill()`). Aucun arrêt par nom, aucun autre PID.
- Arrêt non confirmé en 2 s : code 6 avec le PID exact, tubes détachés, aucune escalade. Le minuteur de
  confirmation est désormais actif : il se déclenche même si les tubes de l'enfant sont déjà fermés.
- Échéance absolue du lanceur : 15 s (verrou libéré, code 9). Ctrl+C : arrêt de l'enfant, verrou libéré, code 10.
  Sortie normale : verrou libéré dans `finally` et sur l'événement `exit`, uniquement s'il appartient au PID courant.
- Verrou exclusif sur la machine (`wx`). Un verrou périmé n'est supprimé qu'avec `--clear-stale-lock`, si son
  propriétaire n'existe plus.
- Scripts : liste blanche `APPROVED_SCRIPTS = ['scripts/test-filament-lab-guards.mjs']`, un argument et un seul.
  Contrôle statique du graphe d'imports complet :
  - au plus 16 fichiers locaux de 512 Kio ;
  - imports relatifs dans le dépôt, ou modules `node:` d'une courte liste (test, assert, fs, path, url, crypto) ;
  - aucun paquet, aucune URL, aucun import dynamique, aucun chargeur CommonJS ;
  - aucun nom d'API de processus, de thread, de réseau ou de VM ;
  - `physics.ts` accessible seulement via le laboratoire.

## 8. Limites de protection des descendants

Il n'y a pas de Windows Job Object : Node n'expose pas cette API, et aucune dépendance native n'a été ajoutée.
Un petit-enfant survivrait donc à l'arrêt de l'enfant. La protection repose sur deux éléments :

- le refus statique, qui reste un filtre de texte et non une frontière d'isolation (du code obfusqué ou une API
  imprévue pourrait y échapper) ;
- le fait que le seul script approuvé, et tout son graphe (test, laboratoire, moteur), ne crée ni processus ni
  thread. Vérifié par lecture et par `grep` avec les motifs du lanceur : 0 occurrence, imports conformes.

Une isolation robuste de l'arbre de processus exigerait un Job Object (dépendance native ou outil Windows dédié) :
c'est à décider dans une mission séparée.

## 9. Vérification statique avant / après

| Invariant | v1 | v2 |
|---|---|---|
| Échec de mesure = arrêt | non | oui (code 8) |
| Précontrôle de l'outil de mesure | non | oui |
| Première mesure | à 1 s | au démarrage |
| Absence de mesure | « 0 Mo » | `null` / `NOT_MEASURED`, code 11 |
| Supervision forgeable par une option | oui (`env`) | non (preuve nonce + verrou + PID parent) |
| Budget sur l'ensemble du script | non | oui (registre de processus) |
| Scripts lancés | tout `.mjs` sous `scripts/` ou `.tmp/` | liste blanche + graphe d'imports |
| `tasklist` | trouvé via le PATH | chemin absolu |
| Minuteur de confirmation d'arrêt | non actif (risque de sortie ambiguë) | actif |
| Échéance absolue / Ctrl+C | absents | 15 s / code 10 |

Autres contrôles :

- **Syntaxe :** `node --check` OK sur les 3 scripts (analyse sans exécution).
- **Espaces :** `git diff --check` propre.
- **Graphe du test**, test → laboratoire → moteur :
  - imports `node:test`, `node:assert/strict`, `node:crypto`, `node:fs`, `node:path`, `node:url` ;
  - 0 nom interdit.

Erreurs trouvées et corrigées pendant cette revue, avant toute exécution :

1. `tasklist` était résolu via le PATH.
2. Le nom d'image était codé en dur (`node.exe`) au lieu du binaire réellement utilisé.
3. Le format mémoire était trop étroit (un nombre sans séparateurs ou un séparateur sur plusieurs octets aurait été
   refusé à tort).
4. Le littéral `'C:\Windows'` aurait donné `C:Windows` en JavaScript.
5. Le minuteur de confirmation d'arrêt était en `unref()`.

## 10. Cas négatifs préparés pour un futur test (dans le script approuvé, non exécutés)

Toujours sans pas physique :

- comptage exact comparé à une énumération arithmétique ;
- refus de la grille historique (562 475 candidats) et de la grille à pas de 15 ;
- grilles invalides (0, décimales, négatifs, `NaN`, `Infinity`, paramètre manquant, hors plafond) ;
- budgets qu'on ne peut pas relever (opération et session) ;
- compteur d'opération (pas, temps, annulation qui ferme la session, candidats) ;
- registre partagé :
  - deux opérations successives cumulent leurs pas ;
  - aucune remise à zéro, nouvelle tentative refusée ;
  - candidats cumulés ;
  - le temps de session ne peut pas être contourné par des appels courts ;
- preuve de supervision : nonce absent ou mal formé, verrou absent, PID parent différent, hash différent, cas valide ;
- refus de l'option `env`, d'une clé inconnue et de l'ancien argument numérique ;
- niveaux trop grands, actions hors bornes, tolérance trop coûteuse ;
- assertion finale : la session du processus a enregistré **0 pas et 0 candidat**.

Les cas négatifs du lanceur lui-même (refus, verrou occupé, codes 3, 4, 6, 8, 9, 10, 11) **ne sont pas** couverts
par ce script : ils demanderont des étapes distinctes, chacune autorisée séparément.

## 11. Risques résiduels

- Le minidump n'a pas été analysé ; un pilote ou le matériel peuvent avoir contribué au BSOD.
- Un watchdog applicatif ne garantit pas l'absence de plantage Windows.
- Un pic mémoire peut survenir entre deux mesures (700 ms). Le plafond de tas ne couvre pas la mémoire native.
- Pas de Job Object : les petits-enfants ne sont empêchés que par un filtre statique.
- Une commande lancée à la main, ou du JavaScript écrit exprès, contourne les outils officiels.
- Course théorique : si le PID de l'enfant est réutilisé à l'instant de sa fin, l'arrêt est déclaré à tort comme
  défaillance de surveillance (code 8). C'est un faux échec, du côté sûr.
- Un test très court peut se terminer avant la première mesure. Il renvoie alors 11 (non concluant) et non 0.
- Anciennes suites de rendu : 3 scripts suivis forcent le GPU matériel D3D11 en contournant la liste de blocage, et
  8 imposent SwiftShader (rendu logiciel, charge processeur). Ils sont non modifiés et interdits
  (`ARCADE_TEST_RULES.md`). Le rapport précédent parlait de « 5 suites GAME-7 » : le recensement exact est celui-ci.
- Contrat modifié pour les consommateurs : `assertSupervised` est supprimé ; `trace()` et les autres refusent les
  options non objet. Les scripts de conception préservés (`.tmp/filament-design-preserved-2026-10-22/`) ne sont plus
  compatibles tels quels et ne sont pas approuvés. Ils ne sont pas modifiés.
- Aucun test dynamique n'a été exécuté.

## 12. Travaux préservés

- Git : HEAD = origin/main = `b9eeeb4`, index vide, 27 fichiers suivis modifiés (inchangé).
- Moteur Filament inchangé ; brouillons (7 fichiers), captures et rapports historiques intacts.
- Synapse Run non touché.
- Inchangés : Companion COMP-5 v1.1, MAÎTRE, Root Policy, Notebook, Docteur Memory, Knowledge Graph, lanceur
  Docteur, guide privé et ses protections Git.
- Aucun verrou créé : `.tmp/filament-lab/` n'existe pas.

## 13. Protocole minimal de validation future (à autoriser séparément)

Une seule commande, au premier plan, depuis `C:\dev\Docteur`, avec un délai d'outil d'au moins 30 s, sans pipeline :

`node scripts/filament-safe-run.mjs scripts/test-filament-lab-guards.mjs`

Lecture attendue du résultat :

| Code | Signification |
|---|---|
| 0 avec `memoryStatus: MEASURED` | seul résultat acceptable comme réussite de l'étape |
| 11 | non concluant : aucune mesure prise |
| 8 | surveillance indisponible : à analyser, sans relance |
| 7 | refus : script ou graphe non conforme |
| 1 | échec d'au moins un test |
| tout autre code | échec, à documenter |

Aucune relance automatique, quel que soit le résultat.
Même réussie, cette étape ne prouvera ni le délai, ni le dépassement mémoire, ni la protection des descendants.
