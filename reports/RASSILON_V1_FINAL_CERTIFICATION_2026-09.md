# DOCTEUR RASSILON V1 — CERTIFICATION FINALE (PHASE 5)

Date : 2026-09-24 · Node v22.22.3 · Windows 11 · branche `main` (tout RASSILON est non commité)

Ce rapport reprend la Phase 5 interrompue (limite d'usage) et la termine. Il ne recommence pas RASSILON, n'ouvre ni Phase 6 ni V2. C'est l'unique rapport final V1 ; les rapports Phase 1-4 restent la référence de conception :

- `reports/RASSILON_ARCHITECTURE_2026-09.md`
- `reports/RASSILON_LOCAL_WORKER_V1_2026-09.md`
- `reports/RASSILON_LOCAL_ENRICHMENT_V1_2026-09.md`
- `reports/RASSILON_LAN_MULTI_WORKER_V1_2026-09.md`

---

## 1. Audit de reprise

Tout le code RASSILON est **non suivi** par Git (`??`) ; `git diff` sur `rassilon-controller.js`, `rassilon-remote-result.js`, `rassilon-settings.js` est donc vide par construction. L'audit a porté sur le contenu réel des fichiers, identifiés par date de modification.

| Catégorie | Fichiers |
|---|---|
| Backend Phase 5 (modifiés le 24/09 ~13:30) | `rassilon-worker.js`, `rassilon-remote-result.js`, `rassilon-settings.js`, `rassilon-controller.js`, `routes/rassilon.js`, `sqlite.js` (projections) |
| Frontend Phase 5 (créés) | `src/components/rassilon/RassilonStatusBadge.tsx`, `src/components/settings/RassilonSettingsTab.tsx` |
| Frontend Phase 5 (modifiés, suivis) | `src/App.tsx` (+1), `TopBar.tsx` (+4), `SettingsModal.tsx` (onglet), `src/lib/cortex/client.ts` (+171, types et méthodes RASSILON) |
| Tests Phase 5 | `cortex-server/test-rassilon-v1-hardening.mjs`, `scripts/test-rassilon-browser.mjs`, `scripts/rassilon-harness.jsx` |
| Backend suivi modifié | `cortex-server/src/server.js` (+39/-1 : imports, init, route, arrêt LAN), `cortex-server/src/lib/sqlite.js` (+671/-0) |

**Tests jamais exécutés jusqu'au bout avant cette reprise :**

- `test-rassilon-v1-hardening.mjs` → **échouait** (voir B1).
- `scripts/test-rassilon-browser.mjs` → **plantait** sur deux sélecteurs Playwright ambigus (`/ENABLE/` correspondait aussi à `LAN ENABLE` ; `/Autoriser SAFE_CPU_TASK/` à deux éléments). Aucune de ses assertions n'avait donc jamais tourné.

---

## 2. Bugs réels trouvés et corrigés

Seuls des bugs démontrés par un test réel ont été corrigés. Aucun refactor, aucune nouvelle fonctionnalité.

| # | Gravité | Fichier | Défaut démontré | Correction |
|---|---|---|---|---|
| B1 | **Critique** | `cortex-server/src/routes/rassilon-lan.js` | `authenticated` était enregistré sur `/rassilon-lan/jobs` **et** `/rassilon-lan/jobs/*`. Dans Hono, `/jobs/*` couvre aussi `/jobs` : l'authentification tournait deux fois et la seconde passe rejetait son propre nonce (`401 request_replay`). **Aucun job distant ne pouvait être soumis via la vraie route LAN.** Les tests Phase 4 appelaient `authenticateLanRequest` directement et ne le voyaient pas. | Suppression de l'enregistrement redondant (commentaire explicatif). |
| B2 | Moyenne | `cortex-server/src/lib/rassilon-executors.js` | L'annulation d'EMBEDDING_BATCH lève `RassilonEmbeddingError('job_cancelled')`, inconnue du worker. Un STOP, une révocation ou un cancel laissaient le job en **FAILED** au lieu de **CANCELLED**, et un timeout embedding n'était pas classé `job_timed_out`. Le calcul s'arrêtait bien ; seul l'état enregistré était faux. | L'adaptateur EMBEDDING_BATCH traduit l'erreur en `RassilonExecutionError('job_cancelled')`. |
| B3 | Moyenne (§13) | `src/components/settings/RassilonSettingsTab.tsx` | Après un premier chargement réussi, si l'API devenait injoignable, l'onglet continuait d'afficher l'état **périmé** (`RASSILON IDLE`, `LAN ACTIVE`) avec un simple bandeau d'erreur. Il affichait aussi `LAN OFF` avant d'avoir reçu l'état LAN. | Nouvel état `unreachable` : RASSILON et LAN affichent `UNKNOWN` tant que le dernier poll a échoué ou que l'état n'est pas chargé. STOP reste disponible. |
| B4 | Durcissement | `cortex-server/src/lib/rassilon-remote-result.js` | `verifyRemoteResult` avait `expectedJobId = null` par défaut et testait sa véracité (`''` ignoré) : l'API autorisait un résultat du job A comme résultat de n'importe quel job. L'unique appelant de production passait le jobId, donc aucune exploitation réelle. | `expectedJobId` devient **obligatoire** (chaîne non vide), sinon `false`. |
| B5 | Durcissement | `cortex-server/src/lib/rassilon-lan-auth.js` | `requiredPermissionForJob('__proto__')` renvoyait `Object.prototype` au lieu de `null` (recherche par prototype). `permissionSet.includes()` refusait quand même, donc aucune exploitation. | Recherche en propriété propre (`Object.hasOwn`). |

Ajustement de test lié : `test-rassilon-lan-security.mjs` passe désormais `expectedJobId` (conséquence de B4).

---

## 3. Architecture finale (V1 gelée)

- **Worker local** (`rassilon-worker.js`) : machine d'états `DISABLED | IDLE | WORKING | PAUSED | AUTO_PAUSED | ERROR`, OFF par défaut, file bornée (10), un job actif, reprise après crash (`RUNNING → INTERRUPTED`, file annulée au redémarrage).
- **Registre d'executors fermé** : `SAFE_CPU_TASK` (HASH_BUFFER, JSON_TRANSFORM_BENCH, VECTOR_MATH) et `EMBEDDING_BATCH` (client Ollama existant, liste blanche `nomic-embed-text`). Aucun executor générique.
- **API locale** `/api/rassilon/*` : loopback seulement, contrôle Host et Origin, JSON obligatoire, corps ≤ 64 KB.
- **LAN** : listener dédié `https.createServer` (TLS ≥ 1.2) qui ne monte que `createRassilonLanRoute`, bind IPv4 RFC1918, profil réseau Private exigé, OFF par défaut. Aucun repli HTTP.
- **Confiance** : identités Ed25519 (clé privée dans le secret-store DPAPI, jamais en table), pairing à code et TTL, usage unique, confirmation locale explicite, preuves mutuelles signées, sessions de 15 min.
- **Requêtes LAN** : signature par requête sur appareil, session, horodatage (±60 s), nonce à usage unique, méthode, chemin et hash du corps. Rate limits par source et par appareil.
- **Jobs distants** : signés par l'émetteur, liés à `targetDeviceId`, permission par type d'executor, et les `acceptedJobTypes` locaux priment.
- **Résultats** : enveloppe signée par le worker, hash du contenu, liaison obligatoire au `jobId` attendu et au worker.
- **UX** : badge d'état permanent dans la TopBar, onglet RASSILON (consentement et quotas, LAN, pairing, appareils et révocation, audit, STOP confirmé).

---

## 4. UX Phase 5

| Élément | Constat |
|---|---|
| Badge TopBar | Reflète uniquement `/rassilon/status` + `/rassilon/lan/status` ; API injoignable → `RASSILON UNKNOWN` et libellé « État indisponible ». |
| Onglet RASSILON | Défaut `RASSILON DISABLED` / `LAN OFF` ; chargement → `UNKNOWN` ; API en erreur → `UNKNOWN` + `role=alert` (après B3). |
| STOP | Double confirmation, toujours cliquable (y compris API injoignable), déclenche `/rassilon/stop`. |
| Pairing | Code, expiration, empreinte worker, challenge public ; permissions demandées cochables une à une, CONFIRMER / REFUSER. |
| Appareils | Nom, présence, rôle, empreinte courte, permissions, session (active ou révoquée) ; REVOKE à confirmation. |
| Audit | Heure, événement, appareil, type de job, statut ; aucune charge utile. |
| Données non fiables | Rendu React texte uniquement ; `dangerouslySetInnerHTML` et `innerHTML` : 0 dans le code RASSILON. |

Projections backend (vérifiées par test) : `/rassilon/devices` n'expose ni `publicKeyPem`, ni `tlsCertificatePem`, ni `sessionId`, ni nonce, ni clé privée ; `/rassilon/audit` n'expose ni `result_summary`, ni payload, ni texte, ni vecteur, ni signature, ni token. `/rassilon/jobs/:id` (API locale Phase 2 de récupération de résultat, non utilisée par l'UX) renvoie les vecteurs, qui sont le produit du job, mais jamais le texte d'entrée.

---

## 5. Preuves de test

### 5.1 Suite backend RASSILON — `node --test --test-timeout=120000 test-rassilon-*.mjs` (depuis `cortex-server/`)

| Fichiers | Tests | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|---|
| 16 | 253 | 252 | 0 | 0 | 1 |

Skip unique, documenté : `test-rassilon-embedding-smoke.mjs`, **NOT_RUN** car aucune instance Ollama locale avec modèle autorisé n'est joignable. Aucun modèle téléchargé.

`test-rassilon-v1-hardening.mjs` : 12/12 (7 d'origine + 5 ajoutés).

| Ajout | Couverture |
|---|---|
| Allowlist executors | `JOB_TYPES` et `AVAILABLE_EXECUTORS` = exactement `SAFE_CPU_TASK`, `EMBEDDING_BATCH` ; 12 valeurs hostiles refusées par les settings, le schéma de job et la table de permissions (`GENERIC`, `SHELL`, `EXEC`, `LLM_INFERENCE`, casse, espace, `''`, `*`, `__proto__`, `constructor`…) ; types non-chaîne refusés. |
| Liaison résultat ↔ jobId | Cas valide accepté. Refusés : jobId attendu faux, absent ou vide, jobId muté, signature d'un autre job (seule, et avec son hash), signature transplantée, workerId faux, clé worker fausse, workerId muté, output, status, errorReason ou timestamp altérés. `pollRassilonRemoteResult` refuse aussi un résultat d'un autre job ou d'un autre worker. |
| Route LAN, type hors liste | Job signé `GENERIC_EXECUTOR` → `403 permission_denied`, rien n'est enregistré. |
| STOP de bout en bout | Route locale `/rassilon/stop` → worker DISABLED → job en file CANCELLED → job actif interrompu (CANCELLED, arrêt anticipé) → session distante révoquée → LAN persisté OFF → rejeu `401` → nouvelle session : `400 rassilon_disabled` → aucune route enable, resume ou settings sur le LAN → 3 sweeps sains : reste DISABLED → ERROR : 3 sweeps, reste ERROR. |
| Isolation réseau | Tous les préfixes de `src/routes/*` sont découverts dynamiquement (OMEGA, MAÎTRE, monitor/Observateur, cyber-audit, voice, local-ai, code-intel, metagpt, sherlock, investment, rassilon…). Chacun, avec et sans `/api`, en GET et POST, répond **404** sur l'app LAN (≥ 200 chemins sondés). |

### 5.2 Navigateur RASSILON — `node scripts/test-rassilon-browser.mjs`

**PASS 36/36**, contre 0 exécutée auparavant (le script plantait). Couverture : badge OFF et LAN OFF depuis l'API ; ouverture de l'onglet par le badge ; état de chargement `UNKNOWN` ; défaut OFF ; LAN OFF ; STOP visible ; bornes frontend ; ENABLE, PAUSE, RESUME ; état WORKING avec nom de controller XSS rendu en texte ; LAN ENABLE ; pairing et permissions ; XSS dans pairing et appareil ; REFUSER ; révocation ; LAN DISABLE ; STOP UI → API ; ERROR (message XSS inerte) ; audit ; nom d'appareil `javascript:` en texte ; aucune balise `img`, `script` ou `b` ni lien `javascript:` issue des données ; API injoignable → `UNKNOWN`, aucun `IDLE` ou `LAN ACTIVE` périmé, alerte visible, STOP actif ; badge `UNKNOWN` quand le backend est injoignable ; zéro erreur de page.

### 5.3 Harnais de certification TLS réels (hors dépôt, certificats jetables générés par `openssl` dans le scratchpad de session)

| Harnais | Résultat | Contenu |
|---|---|---|
| Boucle TLS, 1 processus, vrai listener `startRassilonLanServer` | **12/12** | Soumission signée 202, rejeu 401 `request_replay`, embedding exécuté, résultat vérifié par `pollRassilonRemoteResult`, texte d'entrée absent, mauvaise cible 403, autre CA refusée, pin incorrect refusé, HTTP clair → `ECONNRESET`, `/api/omega/status` 404, non authentifié 401, après STOP `ECONNREFUSED`. |
| **Deux processus, deux bases, TLS loopback** | **16/16** | Pin faux refusé avant connexion ; requête de pairing → `AWAITING_LOCAL_CONFIRMATION` ; complétion sans confirmation → `local_confirmation_required` ; confirmation locale avec **une seule** permission ; session ; challenge à usage unique (`pairing_already_used`) ; controller ne stocke que la permission approuvée ; statut authentifié → ONLINE et capacités ; **`dispatchRassilonRemoteJob` réel** → worker apparié ; EMBEDDING_BATCH COMPLETED et vérifié ; texte absent ; ordonnanceur controller refuse SAFE_CPU_TASK non approuvé ; worker refuse le même job forcé (`permission_denied`) ; révocation côté worker → requêtes et jobs suivants `session_invalid`. |

Seul point non exercé par ces harnais : le garde « endpoint IPv4 privé » du transport controller, qui refuse `127.0.0.1` par design. Il est couvert unitairement (`test-rassilon-lan-security.mjs`, ACL RFC1918).

### 5.4 Régressions pertinentes (74 fichiers : Strict Local, privacy, Local AI, hardware/model-fit, port preflight, egress, OMEGA, MAÎTRE, Monitor/Observateur, Cyber ; sqlite couvert par `maitre-db` et `monitor-db`)

| Tests | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|
| 1251 | 1247 | 1 | 0 | 3 |

- Fail : `test-port-preflight.mjs` → **ENVIRONMENTAL** (voir 5.6).
- Skips : 3 tests OMEGA « non-Windows platform » (skips conditionnels préexistants).

Navigateur pertinent : Voice UX **86/86**, MAÎTRE Studio **27/27**, Observateur Studio **25/25**, Cyber Audit Studio **25/25**.

### 5.5 Régression backend complète — `node --test --test-timeout=180000 --experimental-test-module-mocks test-*.mjs`

148 fichiers de test (hors `test-setup.mjs`).

| Tests | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|
| 2448 | 2439 | 4 | 1 | 4 |

### 5.6 Classification des échecs (aucun n'est NEW, aucun fichier concerné n'est modifié par RASSILON)

| Test | Classe | Cause |
|---|---|---|
| `test-port-preflight.mjs` (2 tests) | ENVIRONMENTAL | La sonde PowerShell `Get-NetTCPConnection` atteint son timeout de 5 s et renvoie `undetermined` (durées ≈ 5 030 ms). Module inchangé depuis `f0388f2`. |
| `test-find-eval.mjs` | ENVIRONMENTAL | Nécessite un serveur de dev sur `localhost:5173` (`ERR_CONNECTION_REFUSED`). |
| `test-video-manual.mjs` | HISTORICAL | Chemin dépendant du cwd : `cortex-server/cortex-server/data/tmp` (`ENOENT`). |
| `test-regression-api.mjs` (cancelled) | HISTORICAL — **handle ouvert** | Démarre `serve()` sur le port 3002 sans jamais le fermer, donc le fichier ne se termine jamais sous `node --test` (timeout 180 s). Non corrigé : module sans lien avec RASSILON. |
| `scripts/test-frontend-browser.mjs` | ENVIRONMENTAL | Le scan de dépendances Vite parcourt les HTML des dépôts imbriqués non suivis `external/MetaGPT` et `external/OpenMontage` et échoue au parsing. Le pré-bundling est sauté et l'import du harnais échoue. Les suites qui fixent `optimizeDeps.entries`, dont RASSILON, ne sont pas affectées. |
| `scripts/test-v21-final-browser.mjs`, `test-v21-visual-browser.mjs` | HISTORICAL | Chevauchement `.hud2-corner--bl` / `.hud2-command-bar` à 768 px. Le harnais V2.1 (daté du 18/09) monte `TopBar` **sans** `onRassilonOpen`, donc le badge RASSILON n'y est pas rendu ; les composants HUD ont changé après, dans les commits voix et MAÎTRE du 20-21/09. |

### 5.7 Compilation, build, démarrage

| Contrôle | Résultat |
|---|---|
| `npx tsc --noEmit` (racine) | **PASS** (exit 0) |
| `npm run build` | **PASS** (exit 0, precache 37 entrées). Avertissement préexistant documenté : taille de chunk (`chunkSizeWarningLimit`). |
| Démarrage serveur | **PASS**, 2 démarrages successifs, base, LanceDB et logs isolés dans le scratchpad (jamais la base réelle), port 3999. |

Détail du démarrage : RASSILON `enabled:false` / `DISABLED` ; LAN `DISABLED` ; 0 appareil ; `/rassilon-lan/status` et `/api/rassilon-lan/status` → 404 sur le serveur principal ; Origin étranger → 403. Le seul listener du processus est `127.0.0.1:3999`, sans nouveau port permanent (3443 absent) et sans `EADDRINUSE`. Le port est libéré après l'arrêt, puis le second démarrage est identique. Sous Windows, `child.kill()` termine le processus (pas de SIGINT interceptable) ; le chemin gracieux SIGINT/SIGTERM → `stopRassilonLanServer` reste câblé dans `server.js`.

---

## 6. Invariants de sécurité

Vérifiés par l'audit statique (`test-rassilon-static-audit.mjs` + scan manuel de tout `rassilon-*.js`, `routes/rassilon*.js` et de l'UI RASSILON), les tests et les harnais.

| Invariant | Compte |
|---|---|
| Arbitrary shell / executable / code | 0 / 0 / 0 |
| Remote terminal | 0 |
| Code shipping | 0 |
| File transfer | 0 |
| Crypto mining | 0 (types de mining explicitement refusés par le schéma) |
| Credential access | 0 |
| Screen capture, keylogging, clipboard | 0 / 0 / 0 |
| Remote enable, quota escalation, safety disable | 0 / 0 / 0 (aucune route LAN correspondante ; 404 vérifié) |
| Automatic model download | 0 (`ollama pull` absent ; modèle absent → `model_not_available`) |
| Internet exposure | 0 (bind RFC1918 seulement, ACL source RFC1918) |
| Cloud relay, UPnP, STUN, TURN, reverse tunnel | 0 |
| Firewall auto-change | 0 (aucun `netsh` ni `New-NetFirewallRule`) |
| Other Cortex APIs exposed via LAN | 0 (≥ 200 chemins sondés, tous 404) |

Occurrences du scan statique, toutes examinées :

- `spawn`, `child_process` : commentaires seulement ; aucun import de `child_process` dans `rassilon-*.js`.
- `powershell`, `exec`, `shell`, `cmd` : liste de clés interdites du schéma de job.
- `https.createServer` : le listener TLS LAN.
- « firewall » : texte UI « aucune règle firewall automatique ».

Les sondes batterie et inactivité utilisent le helper existant `runReadOnlyPowerShell` (`shell:false`, scripts constants, timeout). La sonde d'inactivité ne renvoie qu'une durée (`GetLastInputInfo`), aucun contenu de saisie.

**Confidentialité** : credentials 0, écran 0, presse-papiers 0, keylogging 0, données navigateur 0, crawl de documents 0, système de fichiers arbitraire 0 (scratch confiné). Logs de texte d'embedding : 0. Logs de vecteurs : 0 (`rassilon-embedding.js` n'appelle aucun logger ; audit borné).

**Base de données** : `sqlite.js` +671/−0, uniquement `CREATE TABLE/INDEX IF NOT EXISTS rassilon_*`. Aucun DROP ni ALTER, aucune table `omega_*`, `maitre_*`, `monitor_*` ou `cyber_*` touchée. Seul DELETE : purge des nonces expirés.

---

## 7. Sécurité des ressources (formulation honnête)

- **CPU : SOFT GUARD.** Contrôle d'admission, ordonnancement coopératif entre blocs et timeout mural. Aucun plafond noyau.
- **RAM : SOFT, mesurée au niveau du processus Cortex entier**, pas par job.
- **Ollama : processus externe**, sans plafond CPU ni RAM imposé par RASSILON. Un appel `embed()` en cours ne peut pas être interrompu physiquement ; l'annulation agit entre les textes.

Ce n'est **pas** une isolation dure.

**Batterie et inactivité** (`test-rassilon-battery-idle.mjs`, 17 tests) : AC, batterie, batterie faible, absence de batterie et sonde inconnue sont couverts. Batterie inconnue : pas de pause d'office ; seul `ON_BATTERY` déclenche. Inactivité : actif, inactif, et sonde inconnue → pause conservatrice. Pression RAM ou télémétrie RAM indisponible → pause.

**Pause et reprise** : pause automatique ; hystérésis de 2 sweeps sains ; reprise automatique. PAUSE manuelle : jamais reprise automatiquement ni écrasée. STOP : jamais repris. ERROR : jamais repris silencieusement (sweep ignoré en ERROR, `enable()` revalide le registre).

---

## 8. Scan de secrets avant certification

| Périmètre | Résultat |
|---|---|
| Fichiers modifiés et nouveaux (51, hors `external/`) | 0 bloc PEM privé, 0 token réel. Occurrences : code de masquage préexistant (`freellmapi_key`, colonne SQL `delta_token`). |
| Fichiers suivis (790) | 0 clé privée réelle. Mentions PEM = regex de rédaction (`external-agent-*`, `gen-cert.mjs`) et fixture `privatebytes`. Chaînes `sk-…` = fixtures synthétiques. `AKIA…` = faux positif dans le blob base64 WASM de `public/tesseract/`. |
| Historique (22 commits) | 0 clé privée, 0 token réel (motifs `sk-ant-api`, `sk-proj-`, `ghp_`, `github_pat_`, `AIza`, `xox`). |
| Artefacts RASSILON d'exécution | Bases de test `data-test-*/` ignorées ; runtime `cortex-server/data/` ignoré ; TLS `certs/` ignoré. |

Verdict : **PASS**.

---

## 9. Limites connues

1. **Test sur deux machines réelles : NOT_RUN.** Le multi-machine est prouvé par deux processus et deux bases en TLS loopback, pas sur deux hôtes physiques. Non encore observés en réel : bind sur une IP LAN réelle, règle de pare-feu Windows (manuelle, jamais automatique) et détection du profil réseau.
2. **Smoke Ollama réel : NOT_RUN** (Ollama local absent). EMBEDDING_BATCH est vérifié de bout en bout avec un client Ollama simulé à la frontière du client.
3. Le garde « endpoint IPv4 privé » du transport controller n'est couvert qu'unitairement : le loopback est refusé par design.
4. Le transport controller passe une IP comme `servername` TLS, d'où l'avertissement Node `DEP0123`. Cosmétique : l'épinglage repose sur `ca` + empreinte.
5. Ressources : soft guard (section 7).
6. B1 montre que les tests Phase 4 étaient purement unitaires sur la chaîne LAN. Les harnais TLS de la section 5.3 ne sont pas dans le dépôt : ils utilisent des certificats générés par `openssl`, dans le scratchpad de session.

---

## 10. Checkpoint

```
DOCTEUR RASSILON V1 FINAL CERTIFICATION CHECKPOINT

Local worker : PASS
Multi-machine LAN worker : PASS (2 processus / 2 DB / TLS loopback 16/16 ; B1 corrigé)
Default OFF : PASS
LAN default OFF : PASS
Visible UX : PASS
Local STOP : PASS
Pairing : PASS
Mutual authentication : PASS
TLS mandatory : PASS
HTTP LAN fallback : 0
Replay protection : PASS
Target binding : PASS
Remote result job binding : PASS
Device permissions : PASS
Device revocation : PASS
Local policy precedence : PASS
SAFE_CPU_TASK : PASS
EMBEDDING_BATCH : PASS (provider simulé ; smoke Ollama réel NOT_RUN)
Remote embedding integration test : PASS
Real second-device test : NOT_RUN
CPU guard : PARTIAL (soft guard, par conception)
RAM guard : PARTIAL (whole-process, Ollama non couvert)
Battery guard : PASS
Idle guard : PASS
Automatic pause/resume : PASS
Manual pause never auto-resumes : PASS
Crash recovery : PASS
Audit : PASS

Arbitrary shell : 0
Arbitrary executable : 0
Arbitrary code : 0
Remote terminal : 0
Code shipping : 0
File transfer : 0
Crypto mining : 0
Credential access : 0
Screen capture : 0
Keylogging : 0
Clipboard : 0
Remote enable : 0
Remote quota escalation : 0
Remote safety disable : 0
Automatic model download : 0
Internet exposure : 0
Cloud relay : 0
UPnP : 0
STUN/TURN : 0
Reverse tunnel : 0
Firewall auto-modification : 0
Other Cortex APIs exposed on LAN : 0

Strict Local : PASS
RASSILON backend tests : 252/253 (16 fichiers)
RASSILON browser tests : 36/36
Skipped : 1 (smoke Ollama réel, NOT_RUN documenté)
Failed : 0
Cancelled : 0
Relevant regressions : PASS (1247/1251 ; 1 fail ENVIRONMENTAL port-preflight ; 3 skips plateforme)
Full backend regression : 2439 pass / 4 fail / 1 cancelled / 4 skipped sur 2448, tous classés ENVIRONMENTAL ou HISTORICAL, 0 NEW
Typecheck : PASS
Build : PASS
Server boot : PASS
Secret scan : PASS

Known limitations : section 9
Report : reports/RASSILON_V1_FINAL_CERTIFICATION_2026-09.md

Final verdict : PASS
Freeze status : FROZEN
```

---

## 11. Audit Git/GitHub (lecture seule : aucun add, commit, push, rm, reset, clean, checkout ni restore)

- **État** : `main` à égalité avec `origin/main` (0 commit non poussé). 6 fichiers suivis modifiés + `.gitignore`. 46 fichiers RASSILON non suivis, tous visibles par Git (0 ignoré par erreur). Deux dépôts imbriqués non suivis. Aucun fichier suivi ne correspond à une règle d'ignore.
- **Gap démontré puis corrigé** (`.gitignore` racine) : une clé TLS (`*.key`, `*.pem`, `*.pfx`, `*.p12`) ou une base SQLite (`*.db`, `*.sqlite*` et leurs fichiers WAL/SHM) placée hors de `certs/` ou `cortex-server/data/` n'était pas ignorée. Or `RASSILON_LAN_TLS_KEY_PATH`, `RASSILON_LAN_TLS_CERT_PATH` et `SQLITE_PATH` peuvent pointer ailleurs. 0 fichier suivi ne correspond à ces extensions : rien d'existant n'est masqué.
- **Couverture RASSILON** : base runtime, scratch et logs sous `cortex-server/data/` ; bases de test sous `data-test-*/` ; clés et certificats TLS sous `certs/` + extensions ; cache Vite du test navigateur sous `.tmp/`. La clé privée d'identité (blob DPAPI) et l'état des sessions et du pairing vivent dans la base, donc sont ignorés avec elle.
- **Secrets suivis** : 0. Clés privées suivies : 0. Base ou état runtime suivi : 0.
- **Historique** : 0 secret réel et 0 clé privée dans les 22 commits. Des bases de test ont été commitées puis retirées : `cortex-server/data-test-fallback/*.db`, `cortex-server/data-test-strict-local/test.db`, `data-test-strict-local/test.db`. Elles sont déjà sur `origin/main`. Inspectées : ≤ 8 lignes chacune, aucune valeur de forme secret. Sans risque ; aucune réécriture d'historique nécessaire.
- **Dépôts imbriqués** : `external/MetaGPT` (7 changements locaux) et `external/OpenMontage` (2), tête détachée, non suivis, non modifiés par cet audit. **Attention** : un `git add -A` ou `git add .` les ajouterait comme dépôts embarqués (gitlinks sans `.gitmodules`).
- **Branche locale** `worktree-agent-a92a80d074bc61998` (worktree sous `.claude/`, ignoré) : locale seulement, non poussée.

```
DOCTEUR RASSILON V1 — GIT/GITHUB SAFETY CHECKPOINT

RASSILON V1 certified : PASS
RASSILON V1 frozen : PASS
Root .gitignore : PASS (gap clés et SQLite hors répertoires dédiés corrigé)
cortex-server .gitignore : PASS
RASSILON source trackable : PASS
RASSILON tests trackable : PASS
RASSILON reports trackable : PASS
TLS private keys ignored : PASS
RASSILON identity secrets ignored : PASS
Pairing/session secrets ignored : PASS
Runtime DB ignored : PASS
SQLite WAL/SHM ignored : PASS
Scratch ignored : PASS
Logs ignored : PASS
Test temp ignored : PASS
Tracked real secrets : 0
Tracked private keys : 0
Tracked runtime DB/state : 0
Accidentally ignored source/tests/reports : 0
Broad unsafe ignore rules : 0
Nested external repos modified : 0
Files requiring manual untrack : aucun
.gitignore rules added : *.key *.pem *.pfx *.p12 *.db *.db-wal *.db-shm *.sqlite *.sqlite3 *.sqlite-wal *.sqlite-shm
Secret scan : PASS
GitHub push readiness : PASS
Manual actions required before push : ajouter les chemins RASSILON explicitement (pas de `git add -A` / `git add .`), sinon external/MetaGPT et external/OpenMontage partiraient comme gitlinks ; décider séparément du sort de ces deux dépôts
Files changed by Git/GitHub audit : .gitignore
```
