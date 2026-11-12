# Validation unique du handshake mémoire (2026-10-23)

**Verdict : `ARCADE_MEMORY_HANDSHAKE_SINGLE_TEST_PASS`** (périmètre limité, voir § 4).

## 1. Contrôles préalables (lecture seule) : 12 sur 12 PASS

| Fichier | Empreinte |
|---|---|
| Lanceur | `fe878c7c…` |
| Bootstrap | `633be06b…` (identique à `BOOTSTRAP_SHA256`) |
| Test | `0884f573…` |
| Laboratoire | `d2eeb599…` |
| Moteur | `733fd835…` |

Toutes les empreintes sont identiques au checkpoint.

- **Graphe** : test → laboratoire → moteur ; le bootstrap n'importe que `node:crypto`, `node:path` et `node:url`.
  Aucun nom d'API interdit.
- **Import du test** : uniquement par l'`import()` du bootstrap, après `started = true`.
- **Limites** : 10 s / 15 s / 128 Mio / 350 Mio ; liste blanche d'un seul script ; aucune relance ; aucun verrou ni
  processus Filament préexistant.

## 2. Exécution unique

Commande, lancée une fois au premier plan (PowerShell, sans pipeline) :
`node scripts/filament-safe-run.mjs scripts/test-filament-lab-guards.mjs`

| Ordre réel | Événement |
|---|---|
| 1 | `APPROVED` (graphe et bootstrap) |
| 2 | `MONITOR_READY`, `LAUNCHER_PREFLIGHT_MEMORY_MEASURED`, lanceur 42 Mo |
| 3 | `STARTED`, PID 444 |
| 4 | `CHILD_READY` à 69 ms |
| 5 | `START_SENT` à 250 ms, `CHILD_STARTUP_MEMORY_MEASURED`, enfant 41 Mo |
| 6 | `START_ACCEPTED` (bootstrap, `startupRssKB` 42 208) |
| 7 | `CHANNEL_CLOSED` à 253 ms, `started: true` |
| 8 | TAP : 10 tests, 10 réussis, 0 échec, 0 annulé, 0 ignoré, 0 à faire (19,8 ms) |
| 9 | `FINISHED`, code 0, 328 ms |

Résultats de mémoire et de durée :

| Élément | Valeur |
|---|---|
| `memoryStatus` | `STARTUP_ONLY_MEASURED` |
| `childRuntime` | `CHILD_RUNTIME_MEMORY_NOT_OBSERVED` |
| Durée totale de la commande | 620 ms |

Aucune assertion n'a précédé `START_SENT` : la sortie TAP n'apparaît qu'après `START_ACCEPTED` et `CHANNEL_CLOSED`.
Le test 10 confirme 0 pas physique et 0 candidat.

## 3. Après exécution

- Enfant 444 absent, verrou libéré, 0 processus Node lié à Filament, 0 `tasklist` actif.
- HEAD `b9eeeb4`, index vide, 27 fichiers suivis modifiés (inchangé).
- Fichiers de sécurité, moteur, Companion, MAÎTRE et Root Policy inchangés.
- Brouillons (7) et guide privé (121 fichiers, hooks) préservés.

## 4. Portée

**Ce que la réussite valide** :

- le handshake fonctionne en conditions réelles : bootstrap prêt, mesure valide du PID exact, signal unique accepté,
  canal fermé ;
- le test a démarré **après** la mesure ;
- les 10 assertions ont réussi ;
- l'arrêt et le nettoyage sont propres.

**Ce qu'elle ne valide pas** :

- la mémoire pendant les assertions (non observée : 20 ms de tests, une mesure toutes les 700 ms) ;
- l'arrêt sur délai, sur dépassement mémoire ou sur défaillance de mesure en cours d'exécution ;
- les codes 13 à 15 et 20 à 23 ;
- la protection des processus descendants ;
- la sécurité des recherches physiques, des tests graphiques et des anciennes suites ;
- l'absence de futur BSOD (minidump non analysé).
