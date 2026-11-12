# Filament — validation unique du délai du lanceur sur un processus inactif

**Date :** 2026-10-23
**Verdict :** `FILAMENT_WATCHDOG_IDLE_TIMEOUT_PASS`
**Lancements :** 1, sans relance.

**Calcul :** aucun calcul physique, aucune charge processeur, aucune allocation volontaire, aucun GPU ni navigateur.

Historique : `FILAMENT_SINGLE_REPLAY_EXECUTION.md` (rejeu CH1-A, `SAFE_PASS`). Aucun ancien rapport n'a été modifié.

---

## 1. État initial (lecture seule)

| Contrôle | Résultat |
|---|---|
| Branche / HEAD | `main` / `b9eeeb4` |
| Index Git | 0 fichier |
| Fichiers suivis modifiés | 27 (ensemble inchangé) |
| Empreintes Filament | identiques à la fin du rejeu |
| Copie de sécurité `.tmp/filament-replay-backup-2026-10-23/` | intacte, 23 sur 23 OK ; non modifiée |
| Verrou `.tmp/filament-lab/run.lock` | absent |
| Processus `node.exe` | un seul, sans lien avec Filament |
| Ressources | mémoire libre et charge CPU relevées avant le test (valeurs propres à la machine, non publiées) |

Empreintes Filament de départ :

| Fichier | Empreinte (16 premiers caractères) |
|---|---|
| `scripts/filament-safe-run.mjs` | `f8069c1d84bc3413` |
| `scripts/filament-lab-bootstrap.mjs` | `633be06b38df9687` |
| `scripts/filament-lab-lib.mjs` | `d2eeb5996ba041ff` |
| `src/arcade/filament/physics.ts` | `733fd8352dfd09ee` |
| `scripts/filament-single-replay.mjs` | `49914f760c371483` |
| `scripts/filament-single-replay-fixture.mjs` | `4d2bc04a034c4bff` |

## 2. Audit statique du lanceur et du bootstrap

Les deux fichiers ont été lus intégralement pendant cette session. Leurs empreintes étaient identiques à celles de la
lecture, et les points critiques ont été recontrôlés dans le fichier actuel :

| Point | Code actuel |
|---|---|
| Délai de l'enfant | `HARD_LIMIT_MS = 10_000` (l. 52), armé juste après `spawn` (l. 338), attente du départ comprise |
| Échéance du lanceur | `LAUNCHER_MAX_MS = 15_000` (l. 53), minuterie `unref`, puis `kill` de l'enfant, libération du verrou et code 9 |
| Mémoire | `RSS_LIMIT_BYTES` = 350 Mio, `HEAP_LIMIT_MB` = 128 (`--max-old-space-size`) |
| Lancement | un seul `spawn(process.execPath, …)` avec `shell: false`, `detached: false` (l. 281) |
| Concurrence | verrou exclusif `wx` (l. 103) |
| Surveillance | `tasklist` en chemin absolu ; préflight obligatoire ; toute mesure illisible d'un enfant vivant entraîne l'arrêt (code 8) |
| Arrêt | uniquement `child.kill()` sur le handle possédé (l. 332) ; aucun arrêt par nom |
| Nettoyage | `finish()` efface les minuteries ; `releaseLock()` dans `finally` (l. 269), dans `exit` (l. 426) et sur les chemins 9 et 10 |
| **Code de dépassement de délai** | `stop('TIME_LIMIT')`, puis à l'`exit` de l'enfant, `byVerdict.TIME_LIMIT = EXIT.TIME_LIMIT = 3` (l. 63, 403-404) |
| Arrêt non confirmé | si l'`exit` n'arrive pas dans les `KILL_CONFIRM_MS` = 2 000 ms : code **6** (`TERMINATION_UNCONFIRMED`) |
| Bootstrap | `START_WAIT_MS` = 6 s ; ferme le canal avant d'importer la cible ; empreinte `633be06b…` égale à `BOOTSTRAP_SHA256` |

Conclusion : le code de dépassement de délai est bien **3**, à condition que la fin de l'enfant soit constatée. Les
règles `ARCADE_TEST_RULES.md` (commande `node` directe, pas de pipeline, pas d'arrière-plan, pas de relance, une
seule exécution) ont été respectées.

## 3. Script d'attente retenu

`scripts/test-filament-watchdog-idle.mjs` : nouveau fichier de 1 495 octets, SHA-256
`7c855c8645c954a0bc124338aa74ec755de761cf04464a06b720d22b9deaab6d`.

Fonctionnement :

- **Attente :** une seule minuterie Node de `IDLE_MS` = 12 000 ms, soit 2 s de plus que la limite. Le processus dort
  ensuite dans la boucle d'événements.
- **Garde de supervision :** sans le nonce de session du lanceur, le script sort immédiatement avec le code 41
  (`NOT_SUPERVISED`), sans rien armer.
- **Watchdog manqué :** si la minuterie arrive à son terme, le script écrit `WATCHDOG_MISSED` et sort avec le code 40.
  Ce code ne peut être confondu ni avec le code 3 ni avec une réussite.
- **Sortie :** une seule ligne au démarrage, aucun journal répétitif.

Le script ne contient :

- aucun import ;
- aucune boucle (ni `while`, ni `for`, ni `setInterval`) ;
- aucune récursion ;
- aucune allocation de tableau ou de tampon ;
- aucun accès fichier ou réseau ;
- aucun processus ;
- aucune physique.

### Graphe d'imports

Le graphe se réduit à `scripts/test-filament-watchdog-idle.mjs`, un seul fichier sans aucun import. Le lanceur l'a
confirmé : `"graph":["scripts/test-filament-watchdog-idle.mjs"]`.

### Admission dans le lanceur

`scripts/filament-safe-run.mjs` reçoit 1 ligne de commentaire et 1 ligne modifiée. Le chemin exact est ajouté à
`APPROVED_SCRIPTS`. Le `diff` contre la copie auditée ne montre rien d'autre.

| | Empreinte |
|---|---|
| Avant | `f8069c1d…` |
| Après | `c47c6a247954ef043a33955282dde6f58502bcc5b0fa8f7235d5e2d765143ff8` |

Aucun budget, aucune minuterie et aucune logique de supervision n'ont été modifiés.

## 4. Gate statique

| Contrôle | Résultat |
|---|---|
| Attente uniquement événementielle | PASS |
| Aucune boucle CPU | PASS |
| Aucune simulation physique | PASS (aucun import du laboratoire ni du moteur) |
| Aucun processus descendant | PASS (`FORBIDDEN_TEXT` sans correspondance) |
| Aucun shell récursif | PASS |
| Aucun navigateur ni GPU | PASS |
| Aucun réseau | PASS |
| Aucune donnée personnelle | PASS |
| Mémoire initiale surveillée | PASS (poignée de main V3 inchangée) |
| Timeout extérieur indépendant | PASS (minuterie du lanceur, indépendante de l'enfant) |
| Arrêt sur handle du bon enfant | PASS |
| Libération du verrou | PASS |
| Absence de retry | PASS |
| Script fixe et audité | PASS |

Contrôles complémentaires :

- `node --check` : OK sur les 2 fichiers ;
- aucune erreur d'espacement ;
- le nom du script respecte l'expression de cible du bootstrap.

## 5. Exécution

Une seule fois, au premier plan, depuis `C:\dev\Docteur`, avec un délai d'outil de 40 s :

```
node scripts/filament-safe-run.mjs scripts/test-filament-watchdog-idle.mjs
```

Sortie complète :

```
{"launcher":"filament-safe-run","event":"APPROVED","script":"scripts/test-filament-watchdog-idle.mjs","graph":["scripts/test-filament-watchdog-idle.mjs"],"bootstrap":"scripts/filament-lab-bootstrap.mjs"}
{"launcher":"filament-safe-run","event":"MONITOR_READY","evidence":"LAUNCHER_PREFLIGHT_MEMORY_MEASURED","launcherRssMB":42}
{"launcher":"filament-safe-run","event":"STARTED","pid":21224,"script":"scripts/test-filament-watchdog-idle.mjs","bootstrap":"scripts/filament-lab-bootstrap.mjs","hardLimitMs":10000,"rssLimitMB":350,"heapMB":128,"pollMs":700}
{"launcher":"filament-safe-run","event":"CHILD_READY","pid":21224,"afterMs":65}
{"launcher":"filament-safe-run","event":"START_SENT","pid":21224,"afterMs":265,"evidence":"CHILD_STARTUP_MEMORY_MEASURED","startupRssMB":41}
{"bootstrap":"filament-lab","event":"START_ACCEPTED","pid":21224,"startupRssKB":42200}
{"launcher":"filament-safe-run","event":"CHANNEL_CLOSED","pid":21224,"started":true,"afterMs":268}
{"idle":"filament-watchdog","event":"IDLE_ARMED","pid":21224,"idleMs":12000}
{"launcher":"filament-safe-run","event":"STOPPING","pid":21224,"reason":"TIME_LIMIT","elapsedMs":10011,"memoryStatus":"STARTUP_AND_RUNTIME_MEASURED",...,"childStartup":{"status":"CHILD_STARTUP_MEMORY_MEASURED","samples":1,"peakMB":41},"childRuntime":{"status":"CHILD_RUNTIME_MEMORY_MEASURED","samples":13,"peakMB":41},"started":true}
{"launcher":"filament-safe-run","event":"FINISHED","pid":21224,"exitCode":3,"verdict":"TIME_LIMIT","elapsedMs":10016,"memoryStatus":"STARTUP_AND_RUNTIME_MEASURED",...,"childRuntime":{"status":"CHILD_RUNTIME_MEMORY_MEASURED","samples":13,"peakMB":41},"started":true}
LAUNCHER_EXIT=3 WALL_MS=10505
```

Les champs `launcherPreflight` des deux dernières lignes, identiques à `MONITOR_READY`, sont abrégés en `...`.

## 6. Résultats

| Mesure | Valeur |
|---|---|
| PID de l'enfant | 21224 |
| Bootstrap prêt | 65 ms |
| Mémoire initiale de l'enfant | 41 Mo (42 200 Ko), 1 mesure, avant le départ |
| Signal de départ | envoyé à 265 ms, accepté, canal fermé à 268 ms |
| Mesures pendant l'attente | 13 mesures, pic 41 Mo (`CHILD_RUNTIME_MEMORY_MEASURED`) |
| Statut mémoire | `STARTUP_AND_RUNTIME_MEASURED` : première observation réelle de la mémoire en cours d'exécution |
| Déclenchement du délai | `STOPPING` / `TIME_LIMIT` à **10 011 ms** après le lancement de l'enfant |
| Fin de l'enfant constatée | à **10 016 ms**, soit 5 ms après l'ordre d'arrêt, bien avant la limite de confirmation de 2 s |
| Code de sortie | **3**, égal à `EXIT.TIME_LIMIT` du code |
| Durée totale de la commande | 10 505 ms, sous l'échéance absolue de 15 s, qui ne s'est pas déclenchée |
| `WATCHDOG_MISSED` (code 40) | absent : la minuterie de 12 s n'a jamais expiré |

Classement : **expiration attendue et maîtrisée**. Ce n'est pas une réussite normale du script, qui n'a pas pu finir.

## 7. Preuve de terminaison et état après le test

| Contrôle | Résultat |
|---|---|
| Événement `exit` reçu par le lanceur | oui : `FINISHED` avec le verdict `TIME_LIMIT`, et non `TERMINATION_UNCONFIRMED` |
| PID 21224 | absent (`Get-Process` ne le trouve plus) |
| Processus dont le parent est 21224 | 0 |
| `node.exe` restants | uniquement le processus sans lien déjà présent avant le test |
| Verrou | libéré (`.tmp/filament-lab/` vide) |
| Ressources après le test | relevées (valeurs propres à la machine, non publiées) |
| Autres processus arrêtés | aucun ; aucune commande d'arrêt manuelle n'a été utilisée |

## 8. Charge

| Élément | Valeur |
|---|---|
| Simulations physiques | 0 |
| Recherches | 0 |
| GPU | 0 |
| Navigateurs | 0 |
| Benchmarks | 0 |
| Processeur sollicité volontairement | non |
| Mémoire allouée volontairement | non |

## 9. Intégrité et Git final

| Élément | État |
|---|---|
| Moteur, laboratoire, bootstrap, rejeu, fixture | empreintes inchangées |
| 7 brouillons | inchangés |
| Copie `filament-replay-backup` | 23 sur 23 OK |
| Companion | `16f12cbe`, `0c957f4a` |
| MAÎTRE | `511c8a3d`, `7de23e22` |
| Root Policy | `a8e4f7b5` |
| `Docteur-Launcher.bat` | `cd1871b6`, identique à la mission précédente ; sa modification précédait la session |
| Guide privé | 121 fichiers ; hooks `pre-commit` et `pre-push` présents |
| Synapse Run | 0 modification |
| Git | HEAD `b9eeeb4` ; 0 fichier indexé ; 27 fichiers modifiés (ensemble inchangé) ; 0 commit ; 0 push |

Nouvelle copie légère : `.tmp/filament-watchdog-backup-2026-10-23/`. Elle contient le script d'attente et le lanceur
actuel, avec `SHA256SUMS.txt` (2 sur 2 OK). La copie précédente n'a pas été touchée.

## 10. Limites non vérifiées

- **Ce test ne vaut que pour le délai de 10 s sur un enfant inactif.** Un enfant saturant le processeur pourrait
  retarder les mesures, mais l'arrêt se fait toujours par le handle ; ce cas n'a pas été testé et ne doit pas l'être
  par saturation.
- **Processus descendants :** l'arrêt de l'enfant ne prouve rien pour d'éventuels petits-enfants. Il n'y a pas de Job
  Object, et le refus des processus repose sur le filtre statique.
- **Échéance absolue de 15 s (code 9) :** non déclenchée.
- **Arrêt non confirmé (code 6) :** non déclenché.
- **Limite mémoire de 350 Mio (code 4) :** non testée. Elle ne doit pas l'être par une allocation massive.
- **Échec de surveillance (code 8) :** non testé.
- **Codes de protocole 13–15 et codes du bootstrap 20–23 :** non testés.
- **Refus d'une deuxième exécution concurrente (code 5) :** non testé.
- **Interruption par Ctrl+C (code 10) :** non testée.
- **Cause du BSOD 0xEF :** toujours non établie.
- **Fichiers hors Git :** les fichiers Filament restent hors Git, sauvegardés seulement sous `.tmp/`.
