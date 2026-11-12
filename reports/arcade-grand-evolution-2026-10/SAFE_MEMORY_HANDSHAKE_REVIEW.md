# Arcade safety V3 — synchronisation de la mesure mémoire (2026-10-23)

**Revue statique uniquement — `RUNTIME_TESTS_NOT_EXECUTED`.** Aucun test, aucune simulation, aucun lancement du
lanceur. Les résultats historiques de Stage 2 (`SAFE_VALIDATION_STAGE_2.md`) ne sont pas modifiés.

## 1. Pourquoi Stage 2 donnait 10/10 et le code 11

Le lanceur demandait la première mesure (`tasklist`) au démarrage de l'enfant. Mais l'enfant chargeait et exécutait
ses 10 tests en 155 ms, avant la réponse de cette mesure. Le lanceur a alors correctement refusé de déclarer un
succès (`NOT_MEASURED`, code 11). Les 10 assertions, elles, étaient réussies. Le problème venait de la
synchronisation, pas de la vitesse du test.

## 2. Mécanisme retenu

Une poignée de main par canal IPC Node (`stdio: [..., 'ipc']`), propre à l'unique enfant créé. Le lanceur ne lance
plus directement le script approuvé, mais un **bootstrap minimal épinglé**, `scripts/filament-lab-bootstrap.mjs` :

- il n'importe que `node:crypto`, `node:path` et `node:url` ;
- il n'accède à aucun fichier, n'utilise pas le réseau et ne crée aucun processus ;
- il ne fait ni boucle ni polling ;
- son SHA-256 (`633be06b…bc6b`) est inscrit dans le lanceur (`BOOTSTRAP_SHA256`), qui refuse une copie modifiée
  (code 7).

**Rien du script approuvé** (ni ses imports, ni ses assertions) n'est évalué avant le signal de démarrage : il n'est
chargé que par un `import()` dynamique, exécuté après validation du signal.

## 3. Fichiers modifiés

| Fichier | État | Empreinte |
|---|---|---|
| `scripts/filament-lab-bootstrap.mjs` | nouveau | `633be06b38df96877104bc7d8a1383d4a7cce783f456954f65d5527ddd8fbc6b` |
| `scripts/filament-safe-run.mjs` | modifié (voir ci-dessous) | `fe878c7c36b1f09af9f28ff515c5c5f74926a23782e38e42d4f4be7df44d6bd8` |
| `scripts/test-filament-lab-guards.mjs` | **inchangé** | `0884f573…e466` |
| `scripts/filament-lab-lib.mjs` | **inchangé** | `d2eeb599…5154` |
| `src/arcade/filament/physics.ts` | **inchangé** | `733fd835…1b59` |

Modifications du lanceur :

- en-tête ;
- constantes `BOOTSTRAP` et `BOOTSTRAP_SHA256` ;
- nouveaux codes 13, 14 et 15 ;
- `checkBootstrap()` ;
- `main()` et `supervise()`.

La version V2 du lanceur est conservée dans `.tmp/arcade-safety-v2-snapshot/`.

## 4. Séquence parent-enfant

1. Le lanceur vérifie la liste blanche et le graphe d'imports du script approuvé, puis l'empreinte du bootstrap.
2. Il prend le verrou, qui contient le hash du nonce de session et son propre PID.
3. Précontrôle : il mesure son propre PID (`LAUNCHER_PREFLIGHT_MEMORY_MEASURED`).
4. Il lance **le bootstrap** : `process.execPath`, `shell: false`, non détaché, tas de 128 Mio, IPC. Le script
   approuvé est passé en argument. Le délai de 10 s démarre ici et couvre aussi l'attente.
5. Le bootstrap vérifie le canal IPC, la forme de la cible et le nonce. Il arme une échéance de 6 s, puis envoie
   `FILAMENT_BOOTSTRAP_READY {v:1, pid}`. Il attend ensuite par événement, sans boucle active.
6. Le lanceur mesure le PID dès l'événement `spawn`, puis toutes les 700 ms, une mesure à la fois.
7. Quand il a **reçu READY pour ce PID et obtenu une mesure valide**, il envoie **un seul** signal sur le canal de
   cet enfant :
   `FILAMENT_START {v:1, pid, sessionHash, measuredAt, startupRssKB}`.
8. Le bootstrap valide le signal :
   - clés exactes ;
   - type et version ;
   - `pid` égal à son propre PID ;
   - `sessionHash` égal au SHA-256 de son nonce ;
   - âge de `measuredAt` ≤ 3 s.
9. Il cesse alors d'écouter, **ferme le canal** (le script approuvé ne dispose d'aucun canal vers le lanceur), puis
   importe le script approuvé. Les tests s'exécutent.
10. La surveillance continue normalement : mêmes intervalles, même échec fermé, même plafond de 350 Mio.
11. À la sortie de l'enfant, le lanceur choisit le code, journalise les preuves, nettoie et libère le verrou.

## 5. Cas d'échec gérés (aucune assertion ne commence)

| Situation | Résultat |
|---|---|
| Échec ou format inattendu de la mesure avant le démarrage | `FILAMENT_MEMORY_MONITOR_UNAVAILABLE`, enfant arrêté, code 8. Aucun signal envoyé. |
| L'enfant disparaît avant toute mesure, ou finit sans avoir été démarré | code 13 (`NOT_STARTED`), jamais 0 |
| Délai de 10 s atteint pendant l'attente | arrêt ciblé, code 3 |
| Le lanceur disparaît, ou le canal se ferme avant le démarrage | le bootstrap quitte avec le code 22 sans rien importer. Pas de signal sous 6 s : code 21. |
| Signal invalide, périmé, ou destiné à un autre PID ou à une autre session | le bootstrap quitte avec le code 20 sans rien importer |
| Signal répété | sans effet : le bootstrap n'écoute plus et a fermé le canal ; un démarrage ne peut avoir lieu qu'une fois |
| Message inattendu de l'enfant (avant ou après READY) | `PROTOCOL_VIOLATION`, arrêt, code 15 |
| L'envoi du signal échoue | code 14 |
| Échec d'une mesure pendant les assertions | arrêt fermé, code 8, inchangé |
| Script qui envoie lui-même une « preuve de mesure » | impossible : la preuve est la mesure faite par le lanceur. Le canal est fermé avant l'import, et le lanceur n'accepte de l'enfant que READY, une seule fois. |

## 6. Politique de mesure et de rapport

Preuves distinctes dans `FINISHED` :

| Preuve | Signification |
|---|---|
| `launcherPreflight` | `LAUNCHER_PREFLIGHT_MEMORY_MEASURED` |
| `childStartup` | `CHILD_STARTUP_MEMORY_MEASURED` (nombre de mesures, pic) : mesure **avant** toute assertion |
| `childRuntime` | `CHILD_RUNTIME_MEMORY_MEASURED`, ou `CHILD_RUNTIME_MEMORY_NOT_OBSERVED` si aucune mesure n'a **commencé** après le signal |
| `monitor` | `MEMORY_MONITOR_FAILED` avec le motif, le cas échéant |
| `memoryStatus` | jamais « MEASURED » seul : `STARTUP_ONLY_MEASURED`, `STARTUP_AND_RUNTIME_MEASURED`, `RUNTIME_ONLY_MEASURED`, `NOT_MEASURED` ou `MONITOR_FAILED` |

Une mesure est classée selon le moment où elle a **commencé**. Une mesure lancée avant le signal reste
« startup », même si elle se termine après : rien n'est attribué à tort à la phase de test.

Code 0 = l'enfant a été démarré **après** une mesure valide de son PID, et le script approuvé a réussi.
Cela **ne prouve pas** que le pic mémoire des assertions a été observé. Avec un test d'environ 25 ms et une mesure
toutes les 700 ms, le résultat attendu est `STARTUP_ONLY_MEASURED` et `CHILD_RUNTIME_MEMORY_NOT_OBSERVED`, à
rapporter tel quel. Le code 11 reste réservé à une fin sans aucune mesure ; il est devenu inatteignable, puisque le
démarrage exige une mesure.

## 7. Impact sur les délais

- Le test démarre dès que les deux conditions sont réunies (READY et une mesure valide), sans durée minimale
  artificielle. En pratique, cela devrait prendre le temps d'un appel à `tasklist` (Stage 2 : environ 150 ms ou
  plus), sous réserve de vérification.
- L'attente compte dans les 10 s du lanceur, et le bootstrap a sa propre échéance de 6 s.
- Aucun appel supplémentaire à `tasklist` : même fréquence (dès le démarrage, puis toutes les 700 ms), jamais deux
  à la fois.

## 8. Risques résiduels

- La mesure au démarrage ne couvre pas les pics pendant les assertions ; un pic peut toujours survenir entre deux
  mesures. Le tas reste plafonné à 128 Mio, ce qui n'inclut pas la mémoire native.
- Après le signal, le canal est fermé : si le lanceur meurt **après** le démarrage, l'enfant termine seul son test.
  Celui-ci reste borné par les budgets du laboratoire (8 s de session) et par sa propre brièveté. Avant le démarrage,
  la disparition du lanceur arrête le bootstrap (code 22).
- Fenêtre théorique entre la vérification de l'empreinte du bootstrap et son lancement (quelques ms), si un tiers
  modifiait le fichier à cet instant. Ce n'est pas une sandbox.
- Pas de Job Object : la protection contre les petits-enfants repose toujours sur un filtre statique. Le bootstrap
  et le graphe approuvé ne créent aucun processus.
- Hypothèse non vérifiée en fonctionnement : `node:test` exécute normalement des tests enregistrés par un module
  importé dynamiquement après le démarrage du processus. C'est le comportement documenté de Node, mais cela reste
  à confirmer par la prochaine exécution.
- Course théorique déjà connue : un PID réutilisé à l'instant de la fin de l'enfant donnerait un faux code 8, du
  côté sûr.
- Le minidump n'est pas analysé, et aucune garantie contre un futur BSOD n'existe.

## 9. Contrôles statiques réalisés

- **Relecture intégrale** du lanceur, du bootstrap, du laboratoire et du test.
- **Imports du bootstrap** : `node:crypto`, `node:path`, `node:url`. Aucune occurrence de `child_process`,
  `worker_threads`, `readFile`, `writeFile`, `fetch`, `spawn`, `exec`, `setInterval`, `while` ni `for(;;)`. Un seul
  `import()`, après validation du signal.
- **Graphe du script approuvé, inchangé** : test → laboratoire → moteur, modules `node:` autorisés, 0 nom interdit.
- **`node --check`** OK sur les 4 scripts (analyse sans exécution).
- **`git diff --check`** propre.
- **Empreinte** du bootstrap présente exactement une fois dans le lanceur et égale au fichier.

## 10. Tests dynamiques restant à autoriser (aucun lancé)

**Proposition unique** : `node scripts/filament-safe-run.mjs scripts/test-filament-lab-guards.mjs`.

Lecture attendue du résultat :

| Code | Signification |
|---|---|
| 0, avec `childStartup = CHILD_STARTUP_MEMORY_MEASURED` et `START_SENT` avant les résultats TAP | réussite minimale ; `childRuntime` est rapporté tel quel |
| 8 / 13 / 14 / 15 / 20–23 | échec documenté, sans relance |

Vérifications à prévoir plus tard, chacune sur autorisation séparée et sans processus artificiellement bloqué :

- mesure impossible ;
- disparition avant la mesure ;
- fermeture du canal ;
- signal non autorisé ;
- délai atteint avant la mesure ;
- verrou libéré ;
- absence d'orphelin.
