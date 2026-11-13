# TESTS — STARTUP-2

> **Version publique (2026-11-13)** — copie anonymisée du rapport interne du 2026-10-22. Le contenu technique, les mesures et les verdicts sont inchangés ; les statuts sont ceux du 2026-10-22 (état au moment de la publication : addendum de FINAL_REVIEW.md).

Toutes les exécutions : 2026-10-22, Windows 11, Node 22.22.3. Aucun test n'utilise les ports 3001/5173 de production
(sauf le contrôle réel Vite, données non concernées), ni la base, ni le registre, ni le dossier Startup.

## 1. Suites nouvelles / modifiées

| Suite | Nature | Résultat | Répétitions |
|---|---|---|---|
| `scripts/test-launcher-identity.mjs` | classification pure sur instantanés synthétiques (formes de lignes de commande réelles) | 11/11 | 10 × (avec l'orchestrateur) |
| `scripts/test-docteur-launch.mjs` | machine à états, monde synthétique + horloge virtuelle | 38/38 | identité + orchestrateur : 10 × 49/49 |
| `scripts/test-launcher-lock.mjs` | verrou, répertoires temporaires, **6 processus réels en course × 10 tours** | 6/6 | 3 × |
| `scripts/test-launcher-real-processes.mjs` | **vrais processus Windows**, faux dépôt dans %TEMP%, ports éphémères, chemin console de production (`start`) | 4/4 | 3 × |
| `scripts/test-wait-for-frontend.mjs` (STARTUP-1) | test de contrat du lanceur adapté | 8/8 | – |
| `scripts/test-startup-screen-unit.mjs` | budget 120 s inchangé | 12/12 | – |

## 2. Matrice Phase A (port 3001) — §4.8

| # | Scénario | Où | Résultat |
|---|---|---|---|
| 1 | port libre | launch « cold start » | démarrage |
| 2 | backend Docteur identifié | identity + **réel** (chaîne cmd/npm/watch/server) | `DOCTEUR_BACKEND_CONFIRMED (launcher-console)` |
| 3 | ancien backend remplaçable | launch « user agrees » + **réel** (arrêt épinglé) | watcher + serveur seulement, port libéré vérifié |
| 4 | serveur HTTP étranger | launch + **réel** (node répondant `{"ok":true}` sur /api/ping) | `FOREIGN_PROCESS`, survit |
| 5 | TCP sans HTTP | **réel** | `FOREIGN_PROCESS`, survit |
| 6 | réponse HTTP trompeuse | launch (étranger qui répond comme Docteur pendant le boot) + réel #4 | `BACKEND_PORT_TAKEN` / FOREIGN |
| 7 | Node étranger | identity + launch | `OTHER_NODE_PROGRAM` |
| 8 | identité non déterminable | ligne de commande illisible, entrée Docteur non ancrée (**réel**), autre checkout | `UNKNOWN_OWNER`, refus |
| 9 | PID devenu invalide | **réel** (`TARGET_NOT_PINNABLE`) + identity (pin échoue) | rien d'arrêté |
| 10 | PID réutilisé | **réel** (même PID, date de création décalée → refus sous épinglage) ; parent recyclé dans la chaîne | refus |
| 11 | écouteur remplacé entre deux observations | **réel** (nouvelle instance identique) + launch (pendant l'attente) | refus, nouveau propriétaire intact |
| 12 | processus étranger survivant | tous les cas étrangers | vérifié (processus présent après) |
| 13 | port toujours occupé après arrêt autorisé | launch | `BACKEND_PORT_NOT_RELEASED`, pas de nouveau backend |
| 14 | pas de Chrome en cas de refus | tous les refus → code 1 ; test du .bat | Chrome seulement après exit 0 |
| 15 | pas de nouveau backend si conflit | launch (`starts` vide) | vérifié |
| 16 | aucun processus étranger terminé | `terminations` vide dans tous les refus ; réel : survie | vérifié |

Plus : écoute non-loopback, deux propriétaires, PID système 4, mauvais rôle/port, utilisateur qui refuse/ne répond pas,
revérification échouée (`BACKEND_REPLACE_REFUSED`), descendants (Chrome, kiwix-serve) exclus des cibles.

## 3. Matrice Phase B (démarrage) — §5.9

| Scénario | Résultat |
|---|---|
| readiness immédiate / lente (91 s) | prêt ; progression « N s écoulées (maximum 120 s) » toutes les 10 s, aucun % |
| jamais prêt | `BACKEND_TIMEOUT` à 120 s (borné), frontend jamais lancé |
| mauvaise réponse HTTP | ping exige 200 + `{"ok":true}` (test HTTP réel : 4 cas) ; frontend : titre Docteur |
| service étranger | `*_PORT_TAKEN` / `*_FOREIGN` |
| crash pendant l'attente | `BACKEND_CRASHED` < 30 s (watcher seul), `BACKEND_EXITED`, `FRONTEND_EXITED` |
| processus jamais apparu | `*_PROCESS_NOT_FOUND` à 20 s |
| timeout frontend | `FRONTEND_NOT_READY` à 60 s |
| frontend lent (3 s par réponse) | **réel HTTP** : prêt avec 10 s, jamais avec l'ancien 2 s |
| erreur affichée durablement | `.bat` : aucun `goto MENU`/`cls` sur le chemin d'échec, `pause` |
| réutilisation | backend/frontend sains réutilisés, 0 démarrage |
| sonde système en échec | `PROCESS_PROBE_FAILED`, rien démarré |

## 4. Matrice Phase C (cycle de vie) — §6.8

| # | Scénario | Résultat |
|---|---|---|
| 1-2 | premier / deuxième lancement | démarrage / réutilisation totale (0 démarrage) |
| 3-4 | lancements simultanés, double-clic | verrou : 1 seul gagnant sur 6 processus réels × 10 tours ; perdant `LAUNCH_ALREADY_IN_PROGRESS` sans rien démarrer |
| 5-6 | backend / frontend existants sains | réutilisés |
| 7-8 | backend / frontend absents | démarrés |
| 9 | console ancienne sans processus | signalée, jamais fermée |
| 10-11 | backend / frontend qui plantent | `BACKEND_CRASHED` / `FRONTEND_EXITED` |
| 12 | session interrompue (lanceur fermé) | verrou périmé récupéré (propriétaire disparu) |
| 13-14 | verrou périmé / actif | récupéré / refus |
| 15 | PID réutilisé | verrou : même PID autre date = périmé ; identité : refus |
| 16-18 | inconnu / étranger 3001 / étranger 5173 | refus avant tout démarrage (5173 jugé avant toute proposition d'arrêt) |
| 19 | Chrome déjà ouvert | le lanceur n'inspecte ni ne ferme Chrome ; un navigateur descendant du backend est exclu des cibles |
| 20 | arrêt + redémarrage contrôlés | remplacement accepté → nouveau backend → prêt |
| + | backend encore en démarrage (lancement précédent) | attendu, pas de doublon |
| + | ancien watcher inactif + nouveau backend lent à apparaître | pas de faux « crash » |

## 5. Phase D (réseau)

| Test | Résultat |
|---|---|
| statique : le lanceur ne contacte que 127.0.0.1/::1, aucune URL externe, aucun fetch/https/dns | PASS |
| consoles : `npm_config_update_notifier=false` ; Ollama `OLLAMA_NO_CLOUD=1`, `OLLAMA_HOST=127.0.0.1:11434`, portée limitée, environnement appelant non modifié | PASS |
| Ollama présent / en démarrage / absent / échec de lancement | jamais bloquant, message réel |
| **mesure réelle** Vite + Ollama 75 s (chemin de production) | 0 EXTERNAL, 0 LAN |
| `test-web-egress-guard` 54/54 · `test-web-egress-static-audit` 7/7 · `test-strict-local-centralized` 6/6 · `test-phase1-egress-certification` 7/7 · `test-connectors-offline-guard` 1/1 | PASS |
| LAN : `test-sec3-lan-exposure` 4/4 (1 échec isolé sous charge CPU de la mesure réseau, 4/4 sur 2 relances) · `test-final-review-lan` 3/3 · `test-nb7-local-api-security` 13/13 | PASS |
| `cortex-server/test-port-preflight` 8/8 · `test-port-preflight-probes` 24/24 (garde serveur inchangée) | PASS |

## 6. Réel (distinct du simulé)

- Vite réel via `start "Docteur Frontend"` : prêt en 3,2 s, `DOCTEUR_FRONTEND_CONFIRMED (absolute-path)`, 2e lancement → REUSE.
- Sous charge (échantillonneur réseau), ancienne sonde 2 s : jamais prête en 60 s → correction 10 s.
- Backend réel : **NON lancé** (rotation de sauvegarde, voir AUDIT §7). La chaîne backend a été validée avec un faux
  `src/server.js` lancé par le vrai `npm run dev` (`node --watch-path=src …`) dans une vraie console.

- **CLI réelle** `node scripts/docteur-launch.mjs` (3001 et 5173 tenus par des écouteurs étrangers de test) : exit 1 en
  4,4 s, `FRONTEND_PORT_FOREIGN`, diagnostic complet en français, rien démarré (0 Ollama, 0 console), écouteurs étrangers
  toujours servis, verrou libéré, journal `%LOCALAPPDATA%\Docteur\launcher\launcher.log` (PREFLIGHT → PORT_CHECK → FAILED).

## 7. Hors mission / préexistant

- `test-root-policy-static-audit` 12/13 : « FROZEN modules … differs from HEAD » = modifications MAÎTRE non commitées
  préexistantes (`maitre-executor.js`, `maitre-windows-exec.js`) ; aucun fichier de cette mission concerné.
- Contrôle de nettoyage lancé depuis bash : 4 « restes » = auto-correspondance de la commande de contrôle elle-même ;
  revérifié depuis PowerShell : 0 processus, 0 dossier temporaire.
