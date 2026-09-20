# Observateur V1 — Migration Sentinel V1 → Observateur

Date : 2026-09-20

## Objectif et décision de périmètre

Migration produit/UX de **SENTINEL** (module d'audit de sécurité web
externe, autorisé, non destructif) vers **OBSERVATEUR** : module unifié
de surveillance passive et d'audit web autorisé. Observateur n'est **ni
un antivirus, ni un EDR, ni un moteur de quarantaine, ni un moteur de
remédiation, ni un système de contre-attaque** — ces responsabilités
reviennent à un futur module (MAITRE), qui n'existe pas encore et n'a
pas été démarré dans cette mission.

Décision explicite de périmètre V1 :
- Renommage **UI/UX uniquement**. Aucun fichier backend, route, ou table
  SQLite existant n'a été renommé (`cyber-*.js`, `/api/cyber-audit/*`,
  `cyber_audit_*` restent identiques) — compatibilité et stabilité des
  271 tests certifiés priment sur l'esthétique interne.
- Nouveau code backend sous préfixe **`monitor-`** (fonction technique
  anglaise, comme `cyber-*` sert déjà la marque française "Audit Web"),
  additif uniquement — aucune table ni route existante modifiée.
- Collecteur de surveillance passive : commandes OS locales
  (`netstat -ano` + `tasklist` sur Windows, `ss`/`ps` implémenté mais non
  testé en profondeur sur Linux/macOS ce cycle), aucune dépendance
  native, aucune capture de paquets.

## Threat model — surveillance passive

- **Collecte** : uniquement ce que l'OS rend disponible sans privilège
  supplémentaire — connexions actives, PID, nom de processus, adresse/
  port locaux et distants, protocole, état, horodatage. Volume
  approximatif toujours à `0` par défaut (non fiable sans compteurs
  privilégiés côté OS).
- **Jamais** : injection de paquets, MITM, déchiffrement TLS, capture de
  identifiants, scan de ports distants, scan Internet/LAN actif,
  modification du trafic.
- **Privacy by construction** : `monitor-privacy-guard.js` est
  l'unique point de passage entre le collecteur et la persistance —
  liste blanche stricte de champs (`processName`, `pid`, `remoteAddress`,
  `remotePort`, `localPort`, `protocol`, `state`, `timestamp`,
  `approxBytes`). Aucun champ mot de passe/cookie/token/Authorization/
  corps de message/payload HTTPS/document n'existe dans le schéma —
  il n'y a littéralement aucune colonne où les stocker.
- **IA** : Ollama optionnel, appelé uniquement à la génération de
  rapport (jamais par évènement), timeout strict, ne décide jamais seul
  d'une sévérité ni d'un verdict "attaque confirmée" — ce texte n'existe
  nulle part dans le code. Cloud AI : `cloudAiEnabled` à `false` par
  défaut, **aucune voie d'envoi cloud implémentée en V1** (champ de
  configuration présent pour un usage futur uniquement).

## Architecture

```
ObservateurStudioModal (frontend, lazy chunk, 9 onglets)
    ├── WEB AUDIT tab → CyberAuditStudioModal (bare, panneau réutilisé sans changement de comportement)
    └── OVERVIEW/LIVE/NETWORK/APPLICATIONS/ANOMALIES/REPORTS/HISTORY/SETTINGS
    ↓ fetch (monitor-studio.ts)
routes/monitor.js (API sémantique, loopback-only, délègue uniquement à l'orchestrateur)
    ↓
monitor-orchestrator.js
    ├── monitor-service.js (scheduler setInterval unique, start/pause/resume réels)
    │     ├── monitor-collector.js (netstat/tasklist, execFile, timeout 5s)
    │     ├── monitor-privacy-guard.js (liste blanche — chokepoint unique)
    │     ├── monitor-aggregator.js (upsert par fenêtre horaire — croissance bornée)
    │     ├── monitor-anomaly.js (règles déterministes) + monitor-baseline.js
    │     ├── monitor-performance-guard.js (dégradation auto si surcharge)
    │     ├── monitor-report-scheduler.js + monitor-report.js (Ollama optionnel, timeout)
    │     └── monitor-retention.js (purge bornée, monitor_* uniquement)
    └── sqlite.js (monitor_connections/monitor_processes/monitor_anomalies/monitor_reports/monitor_events)
```

Aucune de ces tables ni aucun de ces fichiers ne partage de code
d'écriture avec `cyber_audit_*` / `cyber-*.js`.

## Performance et bornage

- Agrégation par **fenêtre horaire** (`window_bucket`) : une connexion
  interrogée en continu produit UNE ligne mise à jour (`sample_count++`),
  jamais une ligne par sondage — vérifié par test à 1000 échantillons
  synthétiques (`test-monitor-aggregator.mjs`) et 5000 échantillons/cycle
  (`test-monitor-performance-benchmark.mjs`).
- Écritures SQLite **batchées** (une transaction par cycle de collecte),
  jamais une écriture par évènement individuel.
- `monitor-performance-guard.js` mesure durée de cycle / évènements par
  minute / écritures par minute sur une fenêtre glissante bornée
  (30 cycles) ; au-delà des seuils, l'intervalle de collecte double
  automatiquement (plafonné à 5 minutes) et l'état `MONITORING DEGRADED`
  est exposé dans `/api/monitor/status` et l'onglet OVERVIEW.
- Un seul minuteur (`setInterval`) actif à la fois, vérifié après cycles
  répétés start/pause/resume/stop.

## Anomalies — V1 déterministe

Règles implémentées, chacune une fonction pure : nouvelle destination
inhabituelle (nécessite une baseline existante — une première visite
n'est jamais une anomalie), nouveau port en écoute, nouveau processus
avec activité réseau, volume nettement supérieur à la moyenne, connexion
répétitive inhabituelle, nouvelle destination externe d'un composant
Docteur non répertoriée. Trois sévérités uniquement : `OBSERVATION`,
`SUSPICIOUS`, `REQUIRES_REVIEW` — aucune chaîne "attaque"/"malware"
n'existe dans le code (vérifié par test). Les lignes `REQUIRES_REVIEW`
portent un champ `security_signal` JSON
(`{source:'observateur', category, severity, confidence, evidenceRef}`)
— stocké et affiché uniquement, aucun mécanisme d'émission vers MAITRE
puisque MAITRE n'existe pas.

## Relation avec MAITRE

Bouton "OPEN IN MAITRE" présent sur les anomalies `REQUIRES_REVIEW`,
**désactivé**, avec infobulle explicite ("MAITRE n'est pas encore
disponible"). Aucune action de blocage, quarantaine ou modification
système n'est implémentée où que ce soit dans Observateur.

## UI (Observateur Studio)

`ObservateurStudioModal.tsx` — construit sur les primitives Studio
partagées (`StudioShell`/`StudioTabs`/`StudioStatus`/`StudioEmptyState`),
9 onglets (OVERVIEW/LIVE/NETWORK/APPLICATIONS/ANOMALIES/REPORTS/
WEB AUDIT/HISTORY/SETTINGS). Identité visuelle calme (badges de sévérité
neutre/orange/rouge sourds, jamais un rouge d'alerte permanent). Un seul
widget "Observateur" au Command Center (remplace l'ancien widget "Cyber
Audit" — Web Audit devient un onglet interne plutôt qu'un second widget,
pour éviter la surcharge du rail déjà à 6 modules). `PAUSE MONITORING`
appelle réellement `pauseMonitorService()` (arrête le `setInterval`),
ce n'est pas un simple masquage d'UI.

`CyberAuditStudioModal.tsx` a reçu une prop `bare` optionnelle
(défaut `false`) permettant de rendre son contenu sans son propre
`StudioShell` quand il est intégré comme onglet — extraction pure,
comportement inchangé en usage standalone, vérifiée par les 25 tests
Playwright existants qui passent sans modification de logique (seul le
titre affiché a été mis à jour : "Cyber Audit Studio — SENTINEL" →
"Audit Web — Observateur").

## Tests

- Backend Observateur (nouveaux) : **88/88**
  (`test-monitor-privacy-guard`, `test-monitor-aggregator`,
  `test-monitor-db`, `test-monitor-config`, `test-monitor-anomaly`,
  `test-monitor-baseline`, `test-monitor-performance-guard`,
  `test-monitor-service-lifecycle`, `test-monitor-report`,
  `test-monitor-report-scheduler`, `test-monitor-retention`,
  `test-monitor-route`, `test-monitor-cloud-default-off`,
  `test-monitor-collector`, `test-monitor-performance-benchmark`).
- Backend Cyber Audit (régression, non touché fonctionnellement) :
  **272/272** — exécuté après tous les changements de cette mission,
  aucune régression.
- Navigateur Observateur Studio (nouveau) : **24/24** (Playwright,
  backend mocké, 9 onglets, démarrage/pause/reprise réels, placeholder
  MAITRE inerte vérifié, absence de fuite système dans le DOM,
  desktop/mobile/piège de focus via `studio-browser-checks.mjs`).
- Navigateur Cyber Audit Studio (régression) : **25/25** — inchangé,
  vérifié après l'extraction `bare` et le renommage de titre.
- Typecheck : PASS. Build (`tsc && vite build`) : PASS.
- Suite complète Docteur (hors périmètre cyber-audit/monitor) : non
  ré-exécutée dans cette mission — seules les suites directement
  concernées par la migration ont été vérifiées. Recommandé avant tout
  déploiement : lancer la suite complète du dépôt.

## Limitations (documentées, jamais masquées)

- Analyse du parsing `netstat`/`tasklist` : dégradation gracieuse en cas
  de format inattendu (locale Windows non anglaise, colonnes absentes),
  mais aucune matrice de test multi-version Windows n'a été exécutée —
  recommandé : un test de fumée manuel avant certification finale sur
  d'autres postes Windows que la machine de développement.
- Sans élévation de privilèges, certains noms de processus d'autres
  utilisateurs peuvent rester partiels ("processus inconnu") — comportement
  volontaire, jamais une exception non gérée.
- Volume de données transférées (`approxBytes`) : toujours `0` en V1 —
  ni `netstat` ni `tasklist` n'exposent de compteur fiable sans
  privilège ; documenté explicitement plutôt que fabriqué.
- Export cloud IA : NOT IMPLEMENTED (champ de configuration existe,
  aucune voie d'envoi codée).
- Ré-analyse/comparaison historique multi-versions de baseline :
  la baseline est dérivée de l'historique persistant (bornée par la
  rétention), pas un instantané figé — pas de limitation supplémentaire
  au-delà de la fenêtre de rétention configurée.
- Linux/macOS : chemins `ss`/`ps` implémentés mais non testés en
  profondeur ce cycle (poste de développement Windows).

## Certification

| Élément | Statut |
|---|---|
| Renommage produit Sentinel → Observateur (UI) | PASS |
| Web Audit existant (zéro régression) | PASS |
| Surveillance passive (connexions + processus) | PASS |
| Corrélation processus/réseau | PASS |
| Conception à faible surcharge | PASS |
| Buffers bornés | PASS |
| Planification de rapports | PASS |
| Rapports résumés | PASS |
| Rapports détaillés | PASS |
| Détection d'anomalies (déterministe) | PASS |
| Pause / Reprise (réelle) | PASS |
| Rétention (bornée, purge sûre) | PASS |
| Ollama optionnel | PASS |
| Cloud optionnel (config only, non implémenté) | PASS |
| Stockage de payload brut | 0 obtenu |
| Secrets stockés | 0 obtenu |
| Remédiation automatique | 0 obtenu |
| Observateur Studio | PASS |
| Command Center | PASS |
| Régression Cyber existante | PASS |
| Tests | 88+272 backend, 24+25 navigateur — tous PASS |
| Typecheck | PASS |
| Build | PASS |

## OBSERVATEUR V1 : PASS

STOP — ne pas démarrer MAITRE dans cette mission.
