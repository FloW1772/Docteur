# Filament — exécution du rejeu unique CH1-B

**Date :** 2026-10-23
**Verdict :** `FILAMENT_CH1_B_SINGLE_REPLAY_PASS`
**Lancements :** 1, sans relance.

Préparation : `FILAMENT_CH1_B_SAFE_PREPARATION.md`. Aucun ancien rapport n'a été modifié.

---

## 1. Préconditions (lecture seule)

| Contrôle | Résultat |
|---|---|
| Rapport de préparation | présent |
| `scripts/filament-replay-ch1-b.mjs` | `c48f661ccb8e9f2eac78214f6721f7bc4645827f83f8fde2a2e222ba4196e847`, égal au rapport |
| `scripts/filament-replay-ch1-b-fixture.mjs` | `b122cfb92b2c59c9ef1a56412b66f37dbb6f12fc17cc8e3ac8ba9659e0b35c17`, égal |
| `scripts/filament-safe-run.mjs` | `6c324a21802bd64ad30c8591dafb994f6dd4238b9377616a57d973b16724c4af`, égal ; `diff` nul avec la copie auditée |
| `scripts/filament-lab-bootstrap.mjs` | `633be06b…bc6b`, égal à `BOOTSTRAP_SHA256` (l. 71) |
| `scripts/filament-lab-lib.mjs` | `d2eeb599…5154`, égal |
| `src/arcade/filament/physics.ts` | `733fd835…1b59`, égal |
| Brouillon source `ch1.mjs` | `ee21a65e…`, égal ; fixture conforme (aides `pend` et `seg` et fragments vérifiés lors de la préparation) |
| Liste blanche | contient `scripts/filament-replay-ch1-b.mjs` (l. 63) ; aucun script de conception |
| Graphe d'imports | 4 fichiers : modules intégrés autorisés, `./filament-lab-lib.mjs`, `./filament-replay-ch1-b-fixture.mjs`, `../src/arcade/filament/physics.ts` ; `FORBIDDEN_TEXT` sans correspondance |
| Verrou | absent : `.tmp/filament-lab/` vide |
| Processus Filament actifs | aucun ; un seul `node.exe`, sans lien avec le test |
| Copies locales | `filament-replay-backup` 23 sur 23 ; `filament-watchdog-backup` 2 sur 2 ; `filament-ch1-b-backup` 3 sur 3 |
| Machine | mémoire libre et charge CPU relevées avant le test (valeurs propres à la machine, non publiées) |
| Git | `b9eeeb4` ; 0 fichier indexé ; 27 fichiers modifiés |

Audit statique : **PASS**.

## 2. Commande exécutée (une seule fois, au premier plan, délai d'outil de 30 s)

```
node scripts/filament-safe-run.mjs scripts/filament-replay-ch1-b.mjs
```

La commande a été encadrée par une simple mesure d'horloge PowerShell et la lecture de `$LASTEXITCODE`, sans pipeline,
sans argument ni arrière-plan.

## 3. Sortie complète

```
{"launcher":"filament-safe-run","event":"APPROVED","script":"scripts/filament-replay-ch1-b.mjs","graph":["scripts/filament-replay-ch1-b.mjs","scripts/filament-lab-lib.mjs","scripts/filament-replay-ch1-b-fixture.mjs","src/arcade/filament/physics.ts"],"bootstrap":"scripts/filament-lab-bootstrap.mjs"}
{"launcher":"filament-safe-run","event":"MONITOR_READY","evidence":"LAUNCHER_PREFLIGHT_MEMORY_MEASURED","launcherRssMB":42}
{"launcher":"filament-safe-run","event":"STARTED","pid":14012,"script":"scripts/filament-replay-ch1-b.mjs","bootstrap":"scripts/filament-lab-bootstrap.mjs","hardLimitMs":10000,"rssLimitMB":350,"heapMB":128,"pollMs":700}
{"launcher":"filament-safe-run","event":"CHILD_READY","pid":14012,"afterMs":70}
{"launcher":"filament-safe-run","event":"START_SENT","pid":14012,"afterMs":196,"evidence":"CHILD_STARTUP_MEMORY_MEASURED","startupRssMB":41}
{"bootstrap":"filament-lab","event":"START_ACCEPTED","pid":14012,"startupRssKB":42096}
{"launcher":"filament-safe-run","event":"CHANNEL_CLOSED","pid":14012,"started":true,"afterMs":198}
{"replay":"filament-ch1-b-single-cut","verdict":"PASS","outcome":"WON","loss":null,"stars":3,"tick":221,"starAt":[113,130,146],"final":{"x":609.575,"y":384.169},"estimateWinTickRange":[160,180],"checks":{"recordedOutcome":true,"recordedStars":true,"noLoss":true,"oneCandidate":true,"stepsWithinBudget":true,"sessionOpen":true},"session":{"steps":221,"candidates":1,"elapsedMs":4,"terminal":null}}
{"launcher":"filament-safe-run","event":"FINISHED","pid":14012,"exitCode":0,"verdict":"EXITED","elapsedMs":253,"memoryStatus":"STARTUP_ONLY_MEASURED","launcherPreflight":{"status":"LAUNCHER_PREFLIGHT_MEMORY_MEASURED","rssMB":42},"childStartup":{"status":"CHILD_STARTUP_MEMORY_MEASURED","samples":1,"peakMB":41},"childRuntime":{"status":"CHILD_RUNTIME_MEMORY_NOT_OBSERVED","samples":0,"peakMB":null},"started":true}
LAUNCHER_EXIT=0 WALL_MS=611
```

## 4. Résultats

### Handshake et mémoire

| Mesure | Valeur |
|---|---|
| Préflight du lanceur | 42 Mo |
| Bootstrap prêt | 70 ms |
| Mémoire de l'enfant avant la simulation | **41 Mo** (42 096 Ko), 1 mesure |
| Signal de départ | `START_SENT` à 196 ms, puis `START_ACCEPTED` et canal fermé à 198 ms, avant la sortie du rejeu |
| Mémoire pendant le calcul | **NOT_OBSERVED**, statut `STARTUP_ONLY_MEASURED`. Le calcul a duré 4 ms, bien moins que l'intervalle de mesure de 700 ms |

### Durées

| Mesure | Valeur |
|---|---|
| Enfant | 253 ms |
| Commande complète | 611 ms |
| Calcul, selon le registre | 4 ms |

### Physique

| Mesure | Valeur | Référence |
|---|---|---|
| Trajectoires / candidats | 1 / 1 | 1 |
| Pas physiques | **221** | ≤ 600 |
| Issue | **WON**, `loss = null` | WON (journal de conception) |
| Étoiles | **3** | 3 (journal) |
| Ticks des étoiles | **113, 130, 146** | non enregistrés |
| Tick de victoire | **221** | non enregistré ; estimation 160–180 |
| Position finale | (609,575 ; 384,169) | — |
| Session | ouverte, aucun budget atteint | — |

**Résultat conforme à la solution historique : OUI**, sur les seuls critères enregistrés : issue `WON` et 3 étoiles.

**Écart avec l'estimation :** le tick de victoire réel (221) est en dehors de mon estimation non contractuelle de
160 à 180.

- Les étoiles sont prises entre 21 et 54 ticks après la coupe, ce qui est cohérent avec un vol direct.
- La victoire arrive **75 ticks après la troisième étoile**, avec une position finale à droite et au-dessus du centre
  de la cible.
- L'orbe a donc sans doute rebondi dans l'entonnoir avant d'entrer dans la cible. L'estimation, fondée uniquement sur
  la longueur du vol jusqu'aux étoiles, ne tenait pas compte de ce passage.
- Ce n'était pas un critère, et rien n'a été ajusté.

Une seule exécution a eu lieu. Elle montre que le rejeu est **cohérent** avec la référence, pas que le déterminisme
entre exécutions est démontré.

## 5. Arrêt et état après le test

| Contrôle | Résultat |
|---|---|
| Code de sortie | **0** |
| Délai de 10 s / échéance de 15 s | non déclenchés |
| Arrêt forcé | non utilisé ; l'enfant s'est terminé de lui-même (`EXITED`) |
| PID 14012 | absent ; 0 processus dont il serait le parent |
| `node.exe` restants | uniquement le processus sans lien déjà présent avant le test |
| Verrou | libéré (`.tmp/filament-lab/` vide) |
| Ressources après le test | relevées (valeurs propres à la machine, non publiées) |
| Ralentissement / BSOD | aucun observé |

## 6. Intégrité

| Élément | État |
|---|---|
| Rejeu CH1-B, fixture, lanceur, bootstrap, laboratoire, moteur | empreintes inchangées |
| Rejeu CH1-A et script d'attente | empreintes inchangées |
| 7 brouillons | inchangés |
| Copies locales | 23 sur 23, 2 sur 2 et 3 sur 3 OK ; aucune n'a été modifiée |
| Companion | `16f12cbe`, `0c957f4a` |
| MAÎTRE | `511c8a3d`, `7de23e22` |
| Root Policy | `a8e4f7b5` |
| `Docteur-Launcher.bat` | `cd1871b6`, inchangé |
| Guide privé | 121 fichiers ; hooks `pre-commit` et `pre-push` présents |
| Synapse Run | 0 modification |
| Git | HEAD `b9eeeb4` ; 0 fichier indexé ; 27 fichiers modifiés (ensemble inchangé) ; 0 commit ; 0 push |

Seul fichier créé par cette mission : ce rapport.

## 7. Limites restantes

- **Mémoire pendant le calcul :** non observée (statut `STARTUP_ONLY_MEASURED`).
- **Déterminisme entre plusieurs exécutions :** non démontré, une seule exécution ayant eu lieu.
- **Chemins d'arrêt non validés dynamiquement :** codes 4, 5, 6, 8, 9, 10, 13–15 et 20–23.
- **Processus descendants :** pas de Job Object ; la protection repose sur le filtre statique.
- **Liste blanche :** contrôle par chemin, pas par empreinte.
- **Cause du BSOD 0xEF :** inconnue.
- **Fichiers hors Git :** les fichiers Filament restent hors Git, sauvegardés seulement sous `.tmp/`.
- **Tick de victoire :** désormais observé (221), mais il ne vient d'aucune référence historique indépendante.
