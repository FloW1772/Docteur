# DOCTEUR DEVICE FABRIC — PHASE 3 : ROUTAGE RASSILON SÛR V1

Date : 2026-09-24 · Baseline : Phase 2 PASS (non commitée, arbre au-dessus de `517b364`) · Références : `reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md`, `reports/DEVICE_FABRIC_INVENTORY_LINKING_V1_2026-09.md`, `reports/RASSILON_V1_FINAL_CERTIFICATION_2026-09.md`

**Construit**, et rien d'autre : le routage sémantique **RASSILON uniquement**, de l'appareil Fabric vers **exactement** son worker RASSILON lié :

- SAFE_CPU_TASK et EMBEDDING_BATCH ;
- vérification du résultat signé ;
- journal des opérations ;
- corrélation ;
- UI.

**Absent** :

- routage OMEGA (aucun client OMEGA sortant) ;
- repli vers un autre worker, retry automatique ;
- STOP ALL ;
- annulation (§8) ;
- toute clé, session ou jeton stocké par Fabric.

**OMEGA V1 et RASSILON V1 : 0 fichier modifié**, 0 table `omega_*` / `rassilon_*` modifiée (`git status` ne liste aucun fichier `omega` / `rassilon` ; `sqlite.js` −0 ligne).

---

## 1. Audit préalable (ce que RASSILON gelé expose réellement)

| Élément | Constat | Conséquence |
|---|---|---|
| `dispatchRassilonRemoteJob({ …, preferredDeviceId, devices })` | Si `preferredDeviceId` est **introuvable** dans `devices`, le scheduler choisit parmi **tous** les `devices` (F7). S'il est trouvé mais inéligible, il renvoie `no_eligible_worker`, sans repli. | Fabric passe **`devices: [workerExact]`** : le scheduler ne voit qu'un seul worker, donc aucun repli n'est possible. |
| `pollRassilonRemoteResult({ worker, jobId, sessionId })` | Vérifie la signature, le `jobId` attendu et le `workerId` attendu. Exige le `sessionId` sortant en paramètre. | Fabric lit le `sessionId` **transitoirement** et le passe uniquement à cette fonction : jamais stocké, jamais renvoyé, jamais journalisé. |
| `refreshRassilonWorkerStatus` | Seul moyen existant de rafraîchir la présence d'un worker (un appel `/status` authentifié). | Utilisé uniquement sur **action explicite** (bouton « VÉRIFIER LA DISPONIBILITÉ »), jamais en boucle. |
| Annulation | Le worker expose `/rassilon-lan/jobs/:id/cancel`, mais RASSILON n'a **aucune primitive côté controller** et **aucun test** de cet endpoint. | **Non implémentée** (§8). |
| Sessions | TTL de 15 min, créées **uniquement** au pairing, jamais renouvelées. `getRassilonOutboundSession` ne vérifie pas l'expiration. | Fabric vérifie lui-même l'expiration. Le routage n'est possible que dans les 15 min qui suivent un pairing RASSILON (limite RASSILON V1). |
| STOP local | `killAllRassilonWork` révoque les sessions **entrantes et sortantes**. | Le routage devient immédiatement indisponible, et toute opération en cours échoue. |
| `ensureLocalRassilonDevice()` | Appelée **par RASSILON** dans `dispatch` (signature). | Fabric exige que l'identité locale **existe déjà** (`local_rassilon_identity_missing`) : il ne provoque jamais sa création. |

## 2. Conception de la cible exacte

```
POST /api/device-fabric/route { fabricDeviceId, actionType, semanticPayload, resourceBudget? }
 └ validateRouteRequest   : enum fermé + schéma strict par action (plus strict que RASSILON)
 └ resolveExactRassilonTarget(fabricDeviceId)
     lien RASSILON actif ─ linkState OK (pas MISSING / FINGERPRINT_MISMATCH / CROSS_AGENT_KEY_REUSE)
     trust TRUSTED (pas REVOKED / UNKNOWN) ─ sens THIS_PC_SENDS_COMPUTE (worker)
     SUPPORTED = AUTHORIZED = AVAILABLE = YES et routable ─ UNKNOWN ≠ YES
     relecture du worker exact : non révoqué, empreinte == empreinte du lien, rôle WORKER/BOTH
     session sortante non révoquée et non expirée ─ identité RASSILON locale existante
 └ dispatchRassilonRemoteJob({ jobType, payload, resourceBudget, preferredDeviceId: worker.deviceId, devices: [worker] })
     RASSILON signe ; le worker revalide session, signature, permission, allowlist d'executors,
     schéma, ressources, batterie, inactivité, STOP, révocation, anti-replay
 └ contrôle : dispatched.worker.deviceId === job.targetDeviceId === worker exact, sinon FAILED target_mismatch
 └ suivi borné (une seule opération, aucun re-dispatch) : pollRassilonRemoteResult sur le worker exact
     + isResultBoundToTarget : workerId === attendu, jobId === attendu, verifyRemoteResult(clé publique du worker exact)
     + summarizeVerifiedOutput : schéma de sortie strict ; SHA recalculé localement ; vecteurs contrôlés puis jetés
 └ COMPLETED uniquement si tout est valide ; sinon FAILED / CANCELLED avec un code sûr
```

**Preuve d'absence de repli** :

- **Statique** : un seul site d'appel `dispatchRassilonRemoteJob`, avec `devices: [worker]` et `preferredDeviceId: worker.deviceId` imposés par test. Aucune référence à `listRassilonDevices` ni `selectRassilonWorker`, aucun second dispatch.
- **Dynamique** : un worker A indisponible, révoqué, manquant, ré-clé ou refusant, à côté d'un worker B sain, laisse **B à 0 job et 0 appel réseau**.
- **Processus réels** : B reste à 0 job, y compris après le STOP local de A.

## 3. Filtrage par capacité

Chaque refus est une opération `NOT_AVAILABLE` avec un code sûr, et 0 appel réseau :

| Condition | Code |
|---|---|
| aucun lien RASSILON | `rassilon_not_linked` |
| identité manquante | `rassilon_identity_missing` |
| empreinte changée | `rassilon_fingerprint_mismatch` |
| révoquée | `rassilon_identity_revoked` |
| pas un worker | `rassilon_target_not_a_worker` |
| SUPPORTED NO / UNKNOWN | `capability_not_supported` / `capability_support_unknown` |
| AUTHORIZED NO | `capability_not_authorized` |
| AVAILABLE NO (session absente, expirée ou révoquée) | `target_not_available` |
| AVAILABLE UNKNOWN (présence non fraîche) | `target_availability_unknown` |
| scheduler RASSILON (budget CPU/RAM, modèle) | `no_eligible_worker`, décidé par **RASSILON**, avant tout appel réseau |

`routable` n'est vrai **que** pour RASSILON, dans le sens worker, avec une identité TRUSTED, un lien OK et les trois valeurs à YES. OMEGA n'est jamais routable.

## 4. Séparation de confiance et autorité

- La confiance OMEGA n'intervient jamais. Un lien OMEGA ADMIN TRUSTED sur le même appareil ne rend pas RASSILON routable : `rassilon_not_linked` ou `rassilon_identity_revoked` (testé).
- Fabric ne détient ni clé privée, ni jeton de session, ni secret de pairing, ni clé TLS. La clé **publique** du worker exact et son pin TLS sont passés en mémoire aux fonctions RASSILON qui en ont besoin, sans être stockés par Fabric.
- Fabric ne peut ni activer RASSILON ou le LAN, ni changer quotas, gardes ou executors acceptés, ni lever un STOP. Aucune fonction de ce type n'est importable (audit statique).
- L'autorité exercée est exactement celle de l'API locale existante `/api/rassilon/jobs/dispatch` : même appelant (utilisateur local, loopback), même signature, même revalidation par le worker.

## 5. API de routage

Toutes les routes suivent la même garde que le reste de l'API Fabric : loopback, Host et Origin localhost, JSON obligatoire. Corps ≤ **64 KiB** pour `/route`, 8 KiB ailleurs. Les erreurs sont des codes sûrs, sans pile.

| Méthode et route | Effet |
|---|---|
| `POST /api/device-fabric/route` | routage explicite. Requête : `{ fabricDeviceId, actionType, semanticPayload, resourceBudget? }`, champs inconnus refusés. Réponses : `202 { operation }` ou `409 { error, operation }` (NOT_AVAILABLE ou refus par RASSILON) ; OMEGA_* → `409 not_routable` ; action inconnue → `400 action_not_supported` |
| `GET /api/device-fabric/operations?limit&offset` | lecture seule, bornée (1–100) |
| `GET /api/device-fabric/operations/:id` | id `fop-<uuid>` validé, sinon 404 |
| `POST /api/device-fabric/devices/:id/rassilon/probe` | vérification explicite de disponibilité : **un** appel `/status` authentifié vers le worker exact |

- **Enum d'actions** : `RASSILON_SAFE_CPU` → SAFE_CPU_TASK, `RASSILON_EMBEDDING` → EMBEDDING_BATCH. `OMEGA_VIEW`, `OMEGA_INTERACTIVE` et `OMEGA_ADMIN` sont réservés et répondent toujours `not_routable`, sans opération ni appel.
- **Aucun** endpoint `/execute`, `/run`, `/command`, `/shell`, `/tool`, `/rpc`, `/action`, `/dispatch` ou `/cancel` (404, testé et vérifié sur le vrai serveur). `GET /route` ne route rien.

**Schéma strict**, plus borné que RASSILON pour tenir sous la limite de corps LAN de 256 KiB :

| Action | Charge utile admise |
|---|---|
| SAFE_CPU `HASH_BUFFER` | hex ≤ 64 KiB, `sha256` ou `sha512` |
| SAFE_CPU `JSON_TRANSFORM_BENCH` | ≤ 1 000 items (nombres finis ou chaînes ≤ 256) |
| SAFE_CPU `VECTOR_MATH` | ≤ 16 vecteurs × ≤ 1 024 valeurs |
| EMBEDDING | ≤ 16 textes, ≤ 2 000 caractères chacun, ≤ 16 000 au total ; modèle ∈ `['nomic-embed-text']` (égal à l'allowlist RASSILON, testé) |
| `resourceBudget` | entiers : CPU 1–50 %, RAM 64–2 048 Mo, durée 1–120 s ; défaut 10 % / 256 Mo / 60 s |

Refusés, à toute profondeur : champs d'exécution (`command`, `shell`, `script`, `executable`, `path`, `url`, `powershell`, `cmd`, `javascript`, `python`, `wasm`, `binary`, `plugin`…) et champs d'autorité (`sessionId`, `token`, `nonce`, `signature`, `permission`, `preferredDeviceId`, `devices`, `targetDeviceId`…).

Le **contenu** des textes d'embedding reste une donnée pour l'executor fixe, jamais du code : « `powershell -Command …` » comme texte est vectorisé, jamais exécuté (testé).

## 6. Opérations et états

- **Table `fabric_operations`** :
  - `operation_id` (`fop-`), `correlation_id` (`fcor-`, UNIQUE), `fabric_device_id`, `agent_type` = RASSILON, `agent_device_id`, `action_type`, `job_type` ;
  - `agent_operation_id` = **jobId RASSILON**, `status`, `input_summary` (≤ 1 000), `result_summary` (≤ 4 000), `safe_error` (≤ 64) ;
  - horodatages ;
  - `CHECK` sur toutes les énumérations.
- **États** : `PENDING` → `ROUTING` → `RUNNING` → `COMPLETED` | `FAILED` | `CANCELLED`, ou `NOT_AVAILABLE` avant tout dispatch. COMPLETED n'est posé qu'après vérification complète.
- **Suivi** : une boucle bornée par opération (intervalle de 0,5 à 4 s, échéance = budget + 30 s, au plus 4 opérations actives). Elle ne fait que **relire le résultat du même job** : jamais de re-dispatch, jamais un autre worker.
  - Trois erreurs de lecture consécutives → FAILED `result_unreachable`.
  - Révocation ou STOP en cours → FAILED `target_revoked` / `session_unavailable`.
  - Échéance → FAILED `result_timeout`.
- **Redémarrage** : `recoverInterruptedFabricOperations()` est appelé au boot par `server.js`. Les opérations non terminales passent FAILED `interrupted_by_restart` ; leur job RASSILON n'est ni repris ni renvoyé.
- **Confidentialité** :
  - `input_summary` ne contient que des comptes et tailles (`kind`, `algorithm`, `inputBytes`, `itemCount`, `vectorCount`, `textCount`, `totalChars`, `model`, budget) ;
  - `result_summary` : SAFE_CPU → la sortie bornée (digest ou statistiques) ; EMBEDDING → `{ kind, model, vectorCount, dimensions, durationMs }` ;
  - **ni texte, ni vecteur, ni id de session** dans aucune table `fabric_*` (testé par balayage de toutes les lignes). Les vecteurs restent dans le stockage propre de RASSILON (`rassilon_remote_jobs.result_envelope`), comme pour tout dispatch RASSILON.

## 7. Liaison au résultat et corrélation

- Chaque résultat est lié à `{ fabricDeviceId, agentType, agentDeviceId (worker exact), agentOperationId (jobId), correlationId }`.
- `isResultBoundToTarget` exige, **en plus** de la vérification RASSILON :
  - `workerId` === worker exact ;
  - `jobId` === jobId dispatché ;
  - signature valide avec la clé publique **du worker exact**.

  Un résultat valide cryptographiquement mais signé par B est **refusé** pour un job envoyé à A (testé).
- **Sortie** : ensemble exact de clés, `kind`/`model`/comptes conformes à la requête, nombres finis, dimensions 1–8 192. Pour HASH_BUFFER, le **digest est recalculé localement** : un résultat signé mais faux est refusé.
- **Audit** : enum fermé étendu — `FABRIC_ROUTE_REQUESTED`, `_STARTED`, `_COMPLETED`, `_FAILED`, `_CANCELLED`, `_REJECTED` — avec `operation_id` et `correlation_id`. L'audit RASSILON gelé n'est **pas** modifié : la corrélation passe par le `jobId`, présent dans `rassilon_audit.job_id` et `rassilon_remote_jobs`.
- **Migration** : une base Phase 2 a `fabric_audit` avec l'ancien `CHECK`. Elle est reconstruite une fois (création, copie, remplacement, index), avec tous les ids et lignes conservés. Seule `fabric_audit` est touchée (testé sur une base Phase 2 réelle).

## 8. Annulation : NOT_IMPLEMENTED

RASSILON V1 n'a pas de primitive d'annulation côté controller, et l'endpoint worker `/jobs/:id/cancel` n'est couvert par aucun test RASSILON. L'implémenter obligerait Fabric à composer lui-même des requêtes du protocole RASSILON via le transport générique signé.

Conformément au §30, rien n'est ajouté. Un job annulé côté worker (STOP local) apparaît honnêtement **CANCELLED**, sur la foi du résultat signé. Pas de STOP ALL (OMEGA n'a pas de STOP global).

## 9. UI (onglet APPAREILS)

- **OMEGA** : « Routing : **NOT AVAILABLE FOR OUTBOUND CONTROL** ». Aucun bouton de vue ni de contrôle (testé).
- **RASSILON worker**, trois actions bornées seulement :
  - **VÉRIFIER LA DISPONIBILITÉ** : sonde explicite du worker exact.
  - **CALCUL TEST** : SHA-256 d'un tampon constant. Actif uniquement si SAFE_CPU_TASK est routable, avec une confirmation qui nomme le worker exact (nom + empreinte courte).
  - **EMBEDDINGS** : une ligne par texte, modèle local autorisé, limites affichées, validation frontend (le backend et RASSILON revalident), confirmation qui nomme le worker exact.
- **Tableau OPÉRATIONS RASSILON** : appareil, agent et worker, action, statut, durée, résumé sûr, jobId, corrélation en infobulle. Il est relu (GET seul) toutes les 2 s tant qu'une opération est en cours. Un refus reste affiché (NOT_AVAILABLE) avec son message.
- **Explicite uniquement** : aucune requête `/route` au chargement, à l'actualisation, au lien ou à la sonde (testé). Le premier clic ne fait que demander confirmation. Les appels `/route` et `/probe` utilisent une **requête unique sans retry réseau** (`deviceFabricPostOnce`), car le helper commun `apiFetch` réessaie en cas d'erreur réseau et pourrait dupliquer un job.
- **Aucun** bouton RUN, EXECUTE, COMMAND, FULL CONTROL, ROUTE, DISPATCH, REVOKE, PAIR, STOP ou ENABLE.
- **XSS** : nom d'appareil, erreurs d'opération, résumé de résultat et nom de modèle sont rendus en texte (nettoyage contrôle/bidi, troncature). Aucun `dangerouslySetInnerHTML`.
- **Pas de déclencheur automatique** : aucun intent vocal, outil d'agent, MetaGPT, agent Business, registre de commandes ou agent LLM ne référence Device Fabric. Le seul appelant de `deviceFabricRoute(` est l'onglet APPAREILS (audit statique).

## 10. Tests

| Suite | Résultat |
|---|---|
| `test-device-fabric-core.mjs` | 25/25 |
| `test-device-fabric-migration.mjs` | 2/2 (nouveau) |
| `test-device-fabric-route.mjs` | 11/11 (+3 Phase 3) |
| `test-device-fabric-routing.mjs` | 22/22 (nouveau) |
| `test-device-fabric-static-audit.mjs` | 14/14 (étendu Phase 3) |
| **Backend Device Fabric** (5 fichiers) | **74/74**, 0 fail, 0 cancelled, 0 skipped |
| **Navigateur** `scripts/test-device-fabric-browser.mjs` | **58/58** |
| **Processus réels** (hors dépôt, contrôleur + workers A et B, bases séparées, TLS loopback) | **10/10** |

**`test-device-fabric-routing.mjs`** : les workers de test exécutent les **vrais executors RASSILON** (`runJobExecutor`), vérifient la signature du job contre l'identité RASSILON de ce PC, contrôlent qu'ils sont bien la cible, et signent leurs résultats avec leur propre clé Ed25519. Le dispatch et la lecture passent par les vraies fonctions RASSILON ; seul le transport TLS est remplacé par un journal d'appels. Couverture :

- SAFE_CPU (trois sortes) de bout en bout, avec la corrélation jobId ↔ `rassilon_remote_jobs` ;
- EMBEDDING de bout en bout, sans texte ni vecteur dans `fabric_*` ;
- **CRITIQUE** : A indisponible → NOT_AVAILABLE et **B à 0 job, 0 appel** ;
- A révoqué / identité manquante / clé changée → refus, B intouché ;
- filtrage complet (SUPPORTED NO et UNKNOWN, AUTHORIZED NO, AVAILABLE UNKNOWN, AVAILABLE NO ; tout à YES → routé) ;
- **revalidation RASSILON** (scheduler hors budget → `no_eligible_worker` sans appel ; worker `permission_denied` → FAILED, **1 seul POST**, B intouché) ;
- **confusion de résultat** (signature d'un autre worker, résultat d'un autre job, jobId muté, digest faux, champ en trop, vecteurs manquants → FAILED ; exact → COMPLETED) ;
- liaison A/B unitaire ;
- FAILED/CANCELLED du worker jamais présentés comme COMPLETED ;
- échéance → `result_timeout` avec 1 seul dispatch ;
- **STOP local RASSILON** (opération en cours → FAILED `session_unavailable`, routage ensuite indisponible, aucun autre worker) ;
- OMEGA_* NOT_ROUTABLE et actions inconnues refusées sans trace ni appel ;
- séparation de confiance ;
- charges hostiles (18 champs à deux profondeurs, 6 « kinds » d'exécution, 10 charges invalides, 5 budgets invalides → 0 appel ; contenu textuel traité comme donnée) ;
- aucune requête par lecture ou listing ;
- sonde explicite (un appel `/status` au worker exact seulement) ;
- confidentialité (aucun id de session, texte, vecteur ou clé dans `fabric_*` ni dans les vues) ;
- reprise au boot ;
- API des opérations bornée.

**Navigateur** :

- aucune requête `/route` au chargement ou à l'actualisation ;
- OMEGA « NOT AVAILABLE FOR OUTBOUND CONTROL », sans bouton ;
- CALCUL TEST désactivé tant que la capacité n'est pas AUTHORIZED ; sonde explicite ;
- confirmation qui nomme le worker exact ; corps `/route` strict ; ligne d'opération (appareil, action, 42 ms, digest) ;
- embeddings : limites affichées, validation (17 lignes refusées), corps exact textes + modèle, résumé 2 × 768 ;
- modèle XSS inerte ; refus NOT_AVAILABLE affiché ; une seule requête par confirmation ;
- actions désactivées pour un worker révoqué ; aucune action générique ;
- XSS global inerte ; API injoignable → UNKNOWN.

**Processus réels** (worker A et worker B dans deux processus, chacun avec sa base et son listener TLS réel ; contrôleur Fabric dans un troisième) :

- pairing réel avec les deux ;
- lien Fabric vers A seulement ; avant la sonde, non routable ;
- sonde → READY ;
- SAFE_CPU routé vers A et digest vérifié ; A a exécuté exactement ce jobId ;
- EMBEDDING routé vers A ;
- **B : 0 job**, aucun appel de job vers B ;
- STOP local de A → le routage échoue sur A (`dispatch_failed`, FAILED), **B toujours à 0 job**.

## 11. Régressions, compilation, démarrage

| Contrôle | Résultat |
|---|---|
| RASSILON (16 fichiers) | **252/253**, 1 skip (smoke Ollama NOT_RUN), 0 fail — identique à la baseline |
| OMEGA (14 fichiers) | **224/227**, 3 skips plateforme, 0 fail — identique |
| Régressions pertinentes (Strict Local, privacy, Local AI, port, egress, OMEGA, MAÎTRE, Monitor, Cyber + Device Fabric) | **1320/1325** ; 2 fail `test-port-preflight.mjs` (**ENVIRONMENTAL**, timeout PowerShell) ; 3 skips |
| Navigateur pertinent | Device Fabric 58/58 · RASSILON 36/36 · Voice UX 86/86 · MAÎTRE 27/27 · Observateur 25/25 · Cyber 25/25 |
| Régression backend complète | voir §11.1 |
| `npx tsc --noEmit` / `npm run build` | PASS / PASS (avertissement préexistant de taille de chunk) |
| Démarrage serveur (2 boots, base et port isolés) | PASS (détail ci-dessous) |

Détail du démarrage :

- `/route` OMEGA → `409 not_routable` ; appareil non lié → `409 rassilon_not_linked` et opération NOT_AVAILABLE ;
- `/operations` 200 ; 7 routes génériques → 404 ;
- Host et Origin étrangers → 403 ;
- OMEGA 200 ; RASSILON DISABLED et LAN DISABLED, inchangés ; 0 identité RASSILON créée ;
- seul listener `127.0.0.1:3996` ; pas d'`EADDRINUSE`.

### 11.1 Régression backend complète

Commande : `node --test --test-timeout=180000 --experimental-test-module-mocks test-*.mjs`, sur 153 fichiers.

| Tests | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|
| 2522 | 2513 | 4 | 1 | 4 |

Écart avec la baseline Phase 2 (2492 tests, 2485 pass) : **+30 tests, exactement les nouveaux tests Device Fabric** (routage 22, migration 2, route +3, audit statique +3). **Aucun échec NEW.**

| Test | Classe | Cause |
|---|---|---|
| `test-port-preflight.mjs` (2) | ENVIRONMENTAL | timeout de 5 s de la sonde PowerShell `Get-NetTCPConnection` ; passé en Phase 2, échoue ici : instable |
| `test-find-eval.mjs` | ENVIRONMENTAL | exige un serveur de dev sur `localhost:5173` |
| `test-video-manual.mjs` | HISTORICAL | chemin dépendant du répertoire courant |
| `test-regression-api.mjs` (cancelled) | HISTORICAL — handle ouvert | `serve()` sur le port 3002 jamais fermé |

Aucun de ces fichiers n'a été modifié.

## 12. Limites connues

1. **Pas de second appareil physique** : NOT_RUN. Le routage exact est prouvé par des workers de test (vrais executors, vraies signatures) et par trois processus réels en TLS loopback.
2. **OMEGA non routable** (aucun client OMEGA sortant) : OMEGA_* reste NOT_ROUTABLE.
3. **Annulation non implémentée** (§8) ; **pas de STOP ALL**.
4. **Sessions RASSILON de 15 min, non renouvelées** : le routage n'est possible que peu après un pairing RASSILON, puis `target_not_available` jusqu'au prochain pairing. Limite RASSILON V1, affichée honnêtement.
5. **Présence** : sans sonde explicite récente (< 30 s), la disponibilité est UNKNOWN et le routage refusé. C'est volontaire (pas de heartbeat), mais il faut cliquer « VÉRIFIER LA DISPONIBILITÉ » avant d'envoyer.
6. **Vecteurs d'embedding** vérifiés mais non conservés par Fabric : l'UI n'en montre qu'un résumé. Ils restent dans `rassilon_remote_jobs` (stockage RASSILON).
7. **Smoke Ollama réel** : NOT_RUN (Ollama absent). Les embeddings des tests passent par le client simulé de l'executor RASSILON.
8. Une opération interrompue par un redémarrage devient FAILED et n'est pas reprise, même si le worker a terminé le job.
9. Le garde « endpoint IPv4 privé » du transport RASSILON n'est pas exercé par les tests en processus réels (loopback), comme en certification RASSILON.
10. **Constats RASSILON V1** consignés sans correction : `SESSION_CREATED` inscrit l'id de session dans `rassilon_audit.result_summary` (non exposé par l'API) ; repli F7 et fusion F9 (Phase 1).

## 13. Checkpoint

```
DOCTEUR DEVICE FABRIC PHASE 3 CHECKPOINT

OMEGA V1 untouched : PASS
RASSILON V1 untouched : PASS
Fabric inventory preserved : PASS
RASSILON exact target resolution : PASS
Fallback to another worker : 0
Wrong-worker result rejected : PASS
Wrong-job result rejected : PASS
Fingerprint mismatch routing denied : PASS
Revoked worker routing denied : PASS
Stale worker routing denied : PASS
SUPPORTED gating : PASS
AUTHORIZED gating : PASS
AVAILABLE gating : PASS
RASSILON policy revalidation : PASS
SAFE_CPU_TASK routing : PASS
EMBEDDING_BATCH routing : PASS (provider simulé dans le worker ; smoke Ollama réel NOT_RUN)
Cloud fallback : 0
Automatic model download : 0
OMEGA VIEW routing : 0
OMEGA INTERACTIVE routing : 0
OMEGA ADMIN routing : 0
Trust inheritance : 0
Permission inheritance : 0
Cross-agent auth reuse : 0
Shared private key : 0
Shared session/token : 0
Autonomous routing : 0
Voice-triggered routing : 0
Agent-triggered routing : 0
Generic executor : 0
Remote shell : 0
Arbitrary executable : 0
Arbitrary code : 0
Internet relay : 0
New network listener : 0
Strict Local : PASS
Operation audit : PASS
Cancellation : NOT_IMPLEMENTED (aucune primitive d'annulation certifiée côté controller RASSILON V1)
Device Fabric UI : PASS
XSS protection : PASS
Device Fabric backend tests : 74/74
Device Fabric browser tests : 58/58
RASSILON regressions : PASS (252/253, 1 skip Ollama NOT_RUN)
OMEGA regressions : PASS (224/227, 3 skips plateforme)
Relevant regressions : PASS (1320/1325 ; 2 fail ENVIRONMENTAL port-preflight ; navigateur 58/58, 36/36, 86/86, 27/27, 25/25, 25/25)
Full backend regression : 153 fichiers ; 2522 tests ; 2513 pass ; 4 fail ; 1 cancelled ; 4 skipped ; 0 NEW (port-preflight ×2 et find-eval ENVIRONMENTAL ; video-manual et regression-api HISTORICAL)
Typecheck : PASS
Build : PASS
Server boot : PASS
Real second-device test : NOT_RUN (preuve par 3 processus réels en TLS loopback : 10/10)
Files changed : cortex-server/src/lib/sqlite.js (fabric_operations, migration fabric_audit, store), cortex-server/src/server.js (+reprise au boot), cortex-server/src/lib/device-fabric.js (routabilité), cortex-server/src/lib/device-fabric-agents.js (routable déplacé), cortex-server/src/routes/device-fabric.js (/route, /operations, /probe), src/lib/cortex/client.ts (types + deviceFabricRoute/Operations/Probe sans retry), src/components/settings/DeviceFabricSettingsTab.tsx (actions bornées + opérations) ; nouveaux : cortex-server/src/lib/device-fabric-routing.js, cortex-server/test-device-fabric-routing.mjs, cortex-server/test-device-fabric-migration.mjs, reports/DEVICE_FABRIC_RASSILON_ROUTING_V1_2026-09.md ; tests mis à jour : test-device-fabric-core.mjs, test-device-fabric-route.mjs, test-device-fabric-static-audit.mjs, scripts/test-device-fabric-browser.mjs
Known limitations : second appareil physique NOT_RUN ; OMEGA non routable (aucun client) ; annulation non implémentée, pas de STOP ALL ; sessions RASSILON de 15 min non renouvelées ; sonde explicite nécessaire avant routage ; vecteurs non conservés par Fabric ; smoke Ollama réel NOT_RUN ; opérations interrompues non reprises ; garde IPv4 privée non exercée en loopback
Report : reports/DEVICE_FABRIC_RASSILON_ROUTING_V1_2026-09.md
Verdict : PASS
```

**STOP : la Phase 4 n'est pas commencée. Ni routage OMEGA, ni modification d'OMEGA ou de RASSILON.**
