# Filament — exécution du premier rejeu physique unique (niveau CH1-A)

**Date :** 2026-10-23
**Verdict :** `FILAMENT_SINGLE_REPLAY_SAFE_PASS`
**Lancements :** 1, aucune relance.

Préparation : `FILAMENT_SINGLE_REPLAY_PREPARATION.md`. Aucun ancien rapport n'a été modifié.

---

## 1. État initial (lecture seule)

| Contrôle | Résultat |
|---|---|
| Branche / HEAD | `main` / `b9eeeb4`, égal à `origin/main` |
| Index Git | vide (0 fichier indexé) |
| Fichiers suivis modifiés | 27 : même ensemble qu'en début de session, aucun ajout |
| Scripts du rejeu | présents |
| Brouillons préservés | 7 sur 7, empreintes identiques au relevé de référence (rapport local non publié) |
| Synapse Run | aucune modification (`src/arcade/synapse-run`, `public/arcade`, `src/lib/arcade`) |
| Companion | `16f12cbe…` et `0c957f4a…` (action-registry, actions) |
| MAÎTRE | `511c8a3d…` et `7de23e22…` (executor, windows-exec) |
| Root Policy V2 | `a8e4f7b5…` (`root-policy.json`) |
| Guide privé | 121 fichiers ; hooks `pre-commit` et `pre-push` présents |
| Processus `node.exe` avant le test | 1 seul, sans lien avec Filament |
| Ressources | mémoire libre et charge CPU relevées avant le test (valeurs propres à la machine, non publiées) |

`Docteur-Launcher.bat` figurait déjà parmi les fichiers modifiés au début de la session. Cette mission n'y a pas
touché.

## 2. Préservation des fichiers non suivis

Aucune copie existante ne contenait la version actuelle. `arcade-safety-v1-snapshot` et `arcade-safety-v2-snapshot`
contiennent des versions antérieures.

Une nouvelle copie a donc été créée dans `.tmp/filament-replay-backup-2026-10-23/`. Le dossier n'existait pas avant.
La copie a été faite avec `cp -p`, sans déplacement, suppression ni nettoyage.

Contenu de la sauvegarde :

| Dossier | Contenu |
|---|---|
| `scripts/` | les 7 fichiers suivants : `filament-single-replay.mjs`, `filament-single-replay-fixture.mjs`, `filament-safe-run.mjs`, `filament-lab-bootstrap.mjs`, `filament-lab-lib.mjs`, `test-filament-lab-guards.mjs`, `capture-synapse-run-visual.mjs` |
| `src/arcade/filament/` | `physics.ts` |
| `drafts/` | les 7 brouillons de conception |
| `reports/` | les 8 rapports `.md` existants de `arcade-grand-evolution-2026-10` (sans les captures) |

Intégrité de la copie :

- un fichier d'empreintes, `SHA256SUMS.txt`, calculé sur les originaux ;
- `sha256sum -c` sur les copies : **23 sur 23 OK** ;
- 24 fichiers au total, 257 Ko.

## 3. Empreintes contrôlées avant lancement

| Fichier | Attendu (rapport de préparation § 5) | Constaté |
|---|---|---|
| `scripts/filament-single-replay.mjs` | `49914f760c3714833cddab9c76b2e4ea84b2f8b4a7ae22267946a32ccab109c7` | identique |
| `scripts/filament-single-replay-fixture.mjs` | `4d2bc04a034c4bffe5d7f1505ee55bc5329709e4709d9d9b69b6308981f65a0f` | identique |
| `scripts/filament-safe-run.mjs` | `f8069c1d84bc341390e8557ff209f470f7ee28c902ea5e8ce67518cf9b7c1593` | identique |
| `scripts/filament-lab-bootstrap.mjs` | `633be06b38df96877104bc7d8a1383d4a7cce783f456954f65d5527ddd8fbc6b` | identique |
| `scripts/filament-lab-lib.mjs` | `d2eeb5996ba041ffccfa211b4ec7256553385e600cfc85bb35836a2803465154` | identique |
| `src/arcade/filament/physics.ts` | `733fd8352dfd09ee2cfea66163bded689ec69ac976603d54889d43f9d9b31b59` | identique |

Le bootstrap correspond à `BOOTSTRAP_SHA256` dans le lanceur (ligne 69). `APPROVED_SCRIPTS` contient exactement
`scripts/test-filament-lab-guards.mjs` et `scripts/filament-single-replay.mjs`.

## 4. Audit statique avant lancement

L'audit complet date de la préparation. Les fichiers étant identiques octet par octet (§ 3), il reste valable. Il a
été complété juste avant le lancement par trois vérifications :

- **Recherche avec l'expression `FORBIDDEN_TEXT` du lanceur** sur les 4 fichiers du graphe : aucune occurrence. Le
  graphe ne contient donc :
  - aucun appel de processus, thread ou réseau ;
  - aucun `require` ;
  - aucun import dynamique.
- **Contenu du script :**
  - aucun shell ni fonction shell ;
  - aucune recherche, aucun `scan` ;
  - aucune boucle non bornée : la boucle physique est plafonnée à 600 ticks ;
  - aucune écriture de fichier, aucune base, aucune donnée utilisateur ;
  - aucun navigateur, aucun GPU.
- **Verrou :** `.tmp/filament-lab/` était vide, donc `run.lock` était absent.

Résultat : **PASS**.

## 5. Commande exécutée

Une seule fois, au premier plan, depuis `C:\dev\Docteur`, avec un délai d'outil de 30 s :

```
node scripts/filament-safe-run.mjs scripts/filament-single-replay.mjs
```

La commande a été encadrée par une simple mesure d'horloge PowerShell (`Get-Date`) et une lecture de
`$LASTEXITCODE`, sans pipeline, sans argument supplémentaire et sans arrière-plan.

## 6. Sortie complète

```
{"launcher":"filament-safe-run","event":"APPROVED","script":"scripts/filament-single-replay.mjs","graph":["scripts/filament-single-replay.mjs","scripts/filament-lab-lib.mjs","scripts/filament-single-replay-fixture.mjs","src/arcade/filament/physics.ts"],"bootstrap":"scripts/filament-lab-bootstrap.mjs"}
{"launcher":"filament-safe-run","event":"MONITOR_READY","evidence":"LAUNCHER_PREFLIGHT_MEMORY_MEASURED","launcherRssMB":42}
{"launcher":"filament-safe-run","event":"STARTED","pid":25892,"script":"scripts/filament-single-replay.mjs","bootstrap":"scripts/filament-lab-bootstrap.mjs","hardLimitMs":10000,"rssLimitMB":350,"heapMB":128,"pollMs":700}
{"launcher":"filament-safe-run","event":"CHILD_READY","pid":25892,"afterMs":71}
{"launcher":"filament-safe-run","event":"START_SENT","pid":25892,"afterMs":263,"evidence":"CHILD_STARTUP_MEMORY_MEASURED","startupRssMB":41}
{"bootstrap":"filament-lab","event":"START_ACCEPTED","pid":25892,"startupRssKB":42116}
{"launcher":"filament-safe-run","event":"CHANNEL_CLOSED","pid":25892,"started":true,"afterMs":265}
{"replay":"filament-ch1-a-single-cut","verdict":"PASS","outcome":"WON","loss":null,"stars":3,"tick":87,"starAt":[33,54,70],"final":{"x":400,"y":397.875},"checks":{"recordedOutcome":true,"recordedStars":true,"analyticLoss":true,"analyticTick":true,"analyticStarTicks":true,"oneCandidate":true,"stepsWithinBudget":true,"sessionOpen":true},"session":{"steps":87,"candidates":1,"elapsedMs":2,"terminal":null}}
{"launcher":"filament-safe-run","event":"FINISHED","pid":25892,"exitCode":0,"verdict":"EXITED","elapsedMs":323,"memoryStatus":"STARTUP_ONLY_MEASURED","launcherPreflight":{"status":"LAUNCHER_PREFLIGHT_MEMORY_MEASURED","rssMB":42},"childStartup":{"status":"CHILD_STARTUP_MEMORY_MEASURED","samples":1,"peakMB":41},"childRuntime":{"status":"CHILD_RUNTIME_MEMORY_NOT_OBSERVED","samples":0,"peakMB":null},"started":true}
LAUNCHER_EXIT=0 WALL_MS=675
```

## 7. Résultats

### Handshake et mémoire

| Mesure | Valeur |
|---|---|
| Préflight du lanceur | 42 Mo, mesure réussie |
| Bootstrap prêt (`CHILD_READY`) | 71 ms |
| Mémoire de l'enfant avant rejeu | **41 Mo** (42 116 Ko), 1 échantillon |
| Signal de départ | `START_SENT` à 263 ms, puis `START_ACCEPTED` et canal fermé à 265 ms, **avant** toute sortie du rejeu |
| Mémoire pendant le rejeu | **NOT_OBSERVED** (`CHILD_RUNTIME_MEMORY_NOT_OBSERVED`, 0 échantillon) |
| Statut mémoire | `STARTUP_ONLY_MEASURED` |

### Durées

| Mesure | Valeur |
|---|---|
| Enfant supervisé (du lancement à la fin) | 323 ms |
| Commande complète | 675 ms |
| Simulation dans le registre du laboratoire | 2 ms |

### Résultat physique

| Mesure | Valeur | Référence |
|---|---|---|
| Trajectoires (candidats) | 1 | 1 |
| Pas physiques | **87** | ≤ 600 |
| Issue | **WON**, `loss = null` | WON (journal de conception) |
| Étoiles | **3**, prises aux ticks 33, 54 et 70 | 3 (journal) ; 33, 54, 70 (calcul) |
| Tick de victoire | 87 | 87 (calcul) |
| Position finale | (400 ; 397,875) | y = 397,875 (calcul) |
| Session du laboratoire | ouverte (`terminal = null`), aucun budget atteint | — |

Ce résultat montre la **cohérence d'une exécution** avec la référence enregistrée et avec le calcul indépendant. Il ne
prouve pas le déterminisme entre plusieurs exécutions : une seule a eu lieu.

## 8. Arrêt et état après le test

| Contrôle | Résultat |
|---|---|
| Code de sortie du lanceur | 0 (code de l'enfant transmis, départ mesuré) |
| Enfant 25892 | terminé ; `Get-Process` ne le trouve plus |
| Délai de 10 s / échéance de 15 s | non déclenchés |
| Arrêt forcé (`child.kill`) | non utilisé |
| Verrou | libéré (`.tmp/filament-lab/` vide) |
| `node.exe` restants | uniquement le processus sans lien déjà présent avant le test ; **aucun processus de test orphelin** |
| Ressources après le test | relevées (valeurs propres à la machine, non publiées) |
| Ralentissement ou BSOD | aucun observé pendant la session ; un BSOD ultérieur ne pourrait être signalé que par l'utilisateur |

## 9. Intégrité après le test

| Élément | État |
|---|---|
| Fichiers Filament (scripts, moteur, test de garde-fous, capture) | 8 sur 8 identiques aux empreintes d'avant le test |
| Companion, MAÎTRE, Root Policy | empreintes inchangées |
| Guide privé | 121 fichiers ; hooks présents |
| Synapse Run | aucune modification |
| Git | HEAD `b9eeeb4` ; 0 fichier indexé ; 27 fichiers suivis modifiés (ensemble inchangé) ; 0 commit ; 0 push |

Seuls fichiers créés par cette mission :

- `.tmp/filament-replay-backup-2026-10-23/` ;
- ce rapport.

## 10. Limites restantes

- **Mémoire pendant le calcul non mesurée :** le rejeu a duré 2 ms, trop peu pour une mesure toutes les 700 ms. Le
  pic mémoire pendant les pas physiques reste inconnu ; seul le démarrage est prouvé.
- **Chemins d'arrêt non validés dynamiquement :** ils n'ont pas été déclenchés et n'ont pas été provoqués.
  - délai de 10 s (code 3) et échéance de 15 s (code 9) ;
  - limite RSS (code 4) et échec de la surveillance (code 8) ;
  - arrêt non confirmé (code 6) ;
  - codes de protocole 13–15 et codes du bootstrap 20–23 ;
  - refus d'une deuxième exécution (code 5) ;
  - erreurs typées du laboratoire et code 30.
- **Déterminisme entre exécutions non démontré :** une seule exécution a eu lieu.
- **Isolation statique seulement :** pas de Job Object ; l'absence de processus descendants repose sur l'analyse du
  graphe d'imports.
- **Cause du BSOD 0xEF toujours inconnue :** l'analyse du minidump n'a pas été faite.
- **Fichiers hors Git :** les fichiers Filament ne sont pas suivis. Ils existent seulement sur ce disque et dans les
  copies sous `.tmp/`.
- **Charge du PC :** une charge CPU de fond, due à d'autres programmes, était présente. Le test ne la mesure pas
  et ne l'explique pas.
