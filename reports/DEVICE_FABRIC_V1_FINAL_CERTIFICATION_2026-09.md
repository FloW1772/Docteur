# DOCTEUR DEVICE FABRIC V1 — CERTIFICATION FINALE (PHASE 4)

Date : 2026-09-24 · Baseline : Phase 3 PASS (non commitée, au-dessus de `517b364`)

**Références** :

- `reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md` (Phase 1) ;
- `reports/DEVICE_FABRIC_INVENTORY_LINKING_V1_2026-09.md` (Phase 2) ;
- `reports/DEVICE_FABRIC_RASSILON_ROUTING_V1_2026-09.md` (Phase 3) ;
- `reports/RASSILON_V1_FINAL_CERTIFICATION_2026-09.md` ;
- `reports/OMEGA_V1_FINAL_CERTIFICATION_2026-09.md`.

**Objet** : durcir, finaliser l'UX, rendre les limites visibles, compléter les tests de sécurité, puis certifier et geler Device Fabric V1.

**Aucun ajout de capacité** : pas de client OMEGA, pas de routage OMEGA, pas de heartbeat, pas de renouvellement de session RASSILON, pas de primitive d'annulation, pas d'Internet ni de relais, aucun nouvel agent, executor, transport ou listener.

**OMEGA V1 et RASSILON V1 : 0 fichier modifié.** Aucun fichier `omega-*` / `rassilon-*` ; `sqlite.js` −0 ligne ; aucune table `omega_*` / `rassilon_*` touchée.

---

## 1. Durcissements apportés en Phase 4 (défauts réels trouvés à l'audit)

| # | Défaut constaté | Correction |
|---|---|---|
| H1 | La machine d'états des opérations n'était pas imposée : `finish()` écrasait le statut sans condition, donc une opération terminale pouvait être réécrite ou « complétée » deux fois. | `transitionFabricOperation` : `UPDATE … WHERE status IN (états sources autorisés)`. Table `FABRIC_OPERATION_TRANSITIONS` exportée. Un état terminal n'a aucune sortie. L'audit n'est écrit que si la transition s'applique. |
| H2 | Un résultat signé dont `completionTimestamp` précède le dispatch (rejeu, résultat périmé) était accepté. | COMPLETED exige un horodatage valide, pas dans le futur (+60 s de tolérance entre machines), et **postérieur au dispatch − 60 s**. Sinon `result_stale` ou `result_timestamp_invalid`. |
| H3 | Une projection agent en erreur (base agent illisible) faisait échouer **tout** l'inventaire en 500. | Seul le lien concerné passe `AGENT_ERROR` : trust UNKNOWN, disponibilité ERROR, routage refusé (`agent_projection_error`). Si le domaine opposé est illisible, la vérification de réutilisation de clé est impossible et le lien est traité comme non sûr. `/agents` renvoie `agentErrors`. |
| H4 | Les routes refusées avant création d'opération étaient auditées sans appareil ni agent. | `FABRIC_ROUTE_REJECTED` porte le `fabricDeviceId` (s'il existe) et la famille d'agent (OMEGA / RASSILON) déduite de l'action, avec une raison sûre. |
| H5 | L'UI n'actualisait pas la fraîcheur : un AVAILABLE affiché restait affiché au-delà de la fenêtre de 30 s. L'expiration de session n'était pas visible. | Présence (`VERIFIED` / `STALE` / `NOT_VERIFIED` / `REVOKED`, dernière vérification, âge, fenêtre) et session (`VALID` / `EXPIRING` / `EXPIRED` / `REVOKED` / `NONE`, expiration) sont exposées, **sans identifiant**. L'UI vieillit localement ces valeurs (horloge locale, **aucun appel réseau**) : AVAILABLE → UNKNOWN après 30 s, session → EXPIRED à échéance, boutons désactivés. |
| H6 | Toute erreur serveur s'affichait « API injoignable ». | Erreur interne distinguée (`internal_error`). Les messages non-code ne sont jamais recopiés ; seule leur signification (API injoignable) est affichée. |
| H7 | Liste des champs interdits incomplète pour les types exécutables. | Ajout de `endpoint`, `dll`, `exe`, `bat`, `ps1`, `psm1`, `vbs`, `msi`, `process`, `spawn`, `cmdline`, `commandline`, `library`. |
| H8 | Après un routage refusé, l'état « CONFIRMER » restait armé : le clic suivant envoyait sans nouvelle confirmation. | Toute confirmation est consommée par la tentative, quel qu'en soit le résultat. |
| H9 | OMEGA : libellé à préciser. | « Routing : NOT AVAILABLE » et « Raison : OMEGA outbound client not implemented » (`routingReason = omega_outbound_client_not_implemented`). Disponibilité toujours UNKNOWN. |

Chaque lien expose aussi un **`routingReason`** explicite (révoqué, périmé, clé changée, session expirée/révoquée/absente, présence non vérifiée, capacité non autorisée…), dans le même ordre que les contrôles du routeur.

## 2. Architecture finale (V1 gelée)

```
UI APPAREILS (Paramètres) ── API locale /api/device-fabric/* (loopback + Host + Origin, JSON, corps borné)
   │
   ├─ device-fabric.js        inventaire, liens explicites, état calculé à la lecture, routabilité, audit
   ├─ device-fabric-agents.js lecture seule : projections OMEGA / RASSILON (liste blanche de fonctions, figée par test)
   └─ device-fabric-routing.js seul module autorisé à appeler le controller RASSILON :
         dispatchRassilonRemoteJob({ devices: [workerLié] }) · pollRassilonRemoteResult · refreshRassilonWorkerStatus
         + verifyRemoteResult · machine d'états · suivi borné · reprise au boot
SQLite : fabric_devices · fabric_agent_links · fabric_audit · fabric_operations   (aucune FK vers omega_* / rassilon_*)
```

- **Inventaire** : `fdev-<uuid>` aléatoire. Nom local validé (charset, longueur, unicité, ni contrôle ni bidi). Suppression logique.
- **Liens** : explicites, empreinte confirmée exactement. Au plus un lien OMEGA et un lien RASSILON par appareil, une identité par appareil (index uniques partiels). Refus : identité manquante ou révoquée, clé réutilisée entre domaines, doublon. Unlink et suppression ne touchent **que** `fabric_*`.
- **États** : calculés à la lecture, jamais stockés. `ONLINE` / `PARTIAL` / `OFFLINE` / `UNKNOWN` / `ERROR`. ONLINE exige un signal frais d'un agent. Confiance **par agent** uniquement : aucune « DEVICE TRUSTED ».
- **Capacités** : SUPPORTED, AUTHORIZED, AVAILABLE, trois valeurs indépendantes (YES/NO/UNKNOWN), avec leur **sens** (« cet appareil peut agir sur ce PC », « ce PC peut envoyer du calcul à cet appareil »…). UNKNOWN ≠ YES.
- **Routage** : enum fermé `RASSILON_SAFE_CPU`, `RASSILON_EMBEDDING`. `OMEGA_*` → `not_routable`. Toute autre action → `action_not_supported`.

## 3. Cible exacte et absence de repli (revalidées)

- `fabricDeviceId` → lien RASSILON actif → identité TRUSTED, empreinte inchangée, rôle worker, session valide, présence vérifiée < 30 s, SUPPORTED = AUTHORIZED = AVAILABLE = YES → **`dispatchRassilonRemoteJob({ devices: [workerLié], preferredDeviceId: workerLié })`**. Ensuite, contrôle que `worker.deviceId` = `job.targetDeviceId` = worker lié.
- **Figé par test statique** : un seul site de dispatch, `devices: [worker]` imposé ; aucune référence à `listRassilonDevices` / `selectRassilonWorker` ; aucun second dispatch.
- **Tests** : A indisponible, révoqué, manquant, ré-clé, refusant ou arrêté, B sain → **B : 0 job, 0 appel réseau** (tests de fixtures et processus réels).
- Pas de retry, pas de reciblage. Une tentative échouée reste FAILED ou NOT_AVAILABLE.

## 4. Liaison au résultat

COMPLETED seulement si **toutes** ces conditions tiennent :

- `workerId` = worker lié ;
- `jobId` = job dispatché ;
- signature valide avec la **clé publique du worker exact** (en plus de la vérification RASSILON) ;
- horodatage non périmé et non futur ;
- schéma de sortie exact pour le type d'action (`kind`, `model`, comptes, nombres finis, dimensions) ;
- pour HASH_BUFFER, **digest recalculé localement** et identique.

Testé et refusé :

- résultat signé par un autre worker ;
- résultat d'un autre job ;
- `jobId` muté ;
- digest faux ;
- champ en trop ;
- vecteurs manquants ;
- résultat **périmé** ;
- résultat **futur** ;
- résultat **déjà consommé par une autre opération** (rejeu) ;
- **double complétion**.

## 5. Modèle d'opération

| Cible | Depuis |
|---|---|
| ROUTING | PENDING |
| RUNNING | ROUTING |
| COMPLETED / CANCELLED | RUNNING |
| FAILED | PENDING, ROUTING, RUNNING |
| NOT_AVAILABLE | PENDING, ROUTING |

- Les états terminaux sont immuables (testé pour chaque cible). Exactement un audit de complétion par opération.
- **Redémarrage** : une opération non terminale devient FAILED `interrupted_by_restart` (jamais COMPLETED). Le job n'est ni repris ni renvoyé. L'UI l'affiche « interrompue par un redémarrage (non reprise) ».
- **Refus** : toute route refusée produit un code sûr et apparaît dans l'audit (et dans les opérations quand l'appareil existe : NOT_AVAILABLE). Aucun job n'est lancé. L'UI affiche le refus.
- **Confidentialité** : les opérations ne conservent que comptes, tailles, modèle, durée, jobId, worker et statut. **Aucun texte, aucun vecteur, aucun id de session.**
- **Annulation** : **NOT_IMPLEMENTED**. RASSILON V1 n'a pas de primitive d'annulation côté controller. Aucun bouton CANCEL, et la limite est écrite dans l'UI.

## 6. UX finale (onglet APPAREILS)

- **Carte** : nom, Overall (recalculé avec le vieillissement local).
- **OMEGA** : lié, trust, disponibilité **UNKNOWN**, capacités sur trois niveaux, « Routing : NOT AVAILABLE », « Raison : OMEGA outbound client not implemented ». Aucun bouton VIEW, INTERACTIVE ou ADMIN.
- **RASSILON** : lié, trust, disponibilité, capacités sur trois niveaux, **Présence** (VERIFIED/STALE/NOT_VERIFIED/REVOKED) et **Session** (VALID/EXPIRING/EXPIRED/REVOKED/NONE). Affiche « Dernière vérification : … · fraîcheur N s / fenêtre 30 s · session expire dans N min », le statut de routage et sa raison.
- **Actions RASSILON** :
  - VÉRIFIER LA DISPONIBILITÉ : **une** tentative, aucun job, aucun retry ;
  - CALCUL TEST et EMBEDDINGS : bornés, confirmation en deux étapes nommant le worker exact, **une** tentative sans retry réseau (`deviceFabricPostOnce`, jamais `apiFetch`).
- **Opérations récentes** : appareil, worker, action, statut, durée, résumé sûr, jobId ; erreurs traduites (périmé, non conforme, interrompue…).
- **États vides et d'erreur** :
  - aucun appareil ;
  - API injoignable → UNKNOWN partout ;
  - erreur interne Fabric → message dédié et UNKNOWN ;
  - projection agent en erreur → bandeau, lien AGENT_ERROR, Overall ERROR, aucune action ;
  - identité périmée ou révoquée → avertissement et routage désactivé ;
  - session expirée → « SESSION EXPIRED — refaire le pairing dans RASSILON ».
- **Aucun** bouton FULL CONTROL, CONTROL PC, RUN ANYTHING, EXECUTE COMMAND, TERMINAL, RUN, ROUTE, DISPATCH, REVOKE, PAIR, STOP, ENABLE ou CANCEL.
- **XSS** : rendu React en texte uniquement. Caractères de contrôle et bidi retirés, troncature. Testé avec `<script>`, `<img onerror>`, `javascript:`, entités HTML, balises `<b>`, 400 caractères Unicode hors BMP, dans les noms d'appareil et d'agent, noms de modèle, erreurs d'opération, résumés et raisons d'audit.

## 7. Limites OMEGA et RASSILON (héritées, visibles, non contournées)

| Limite | Effet dans Fabric |
|---|---|
| OMEGA V1 sans client sortant | OMEGA_* NOT_ROUTABLE, disponibilité UNKNOWN, raison affichée |
| Pas de projection de sessions OMEGA ni de STOP global OMEGA | pas de STOP ALL |
| Présence RASSILON rafraîchie seulement par échange authentifié | sonde explicite obligatoire ; fraîcheur 30 s, puis UNKNOWN |
| Sessions RASSILON de 15 min, jamais renouvelées | EXPIRING puis EXPIRED ; routage NOT_AVAILABLE ; refaire le pairing dans RASSILON |
| Pas de primitive d'annulation côté controller | annulation NOT_IMPLEMENTED |
| Repli F7 de `dispatchRassilonRemoteJob` | neutralisé par `devices: [workerLié]` |

## 8. Tests

| Suite | Résultat |
|---|---|
| `test-device-fabric-core.mjs` | 25/25 |
| `test-device-fabric-migration.mjs` | 2/2 |
| `test-device-fabric-route.mjs` | 11/11 |
| `test-device-fabric-routing.mjs` | **28/28** (+6 Phase 4 : machine d'états, périmé/futur/rejeu, audit des refus, champs exécutables, présence/session/raisons, projection en erreur) |
| `test-device-fabric-static-audit.mjs` | **18/18** (+4 Phase 4 : tentative unique côté client, importateurs du module de routage, minuteries sans sonde ni route, aucun chemin voix/CommandBar/agents/scheduler) |
| **Backend Device Fabric** (5 fichiers) | **84/84**, 0 fail, 0 cancelled, 0 skipped |
| **Navigateur** `scripts/test-device-fabric-browser.mjs` | **79/79** |
| **Processus réels** (1 contrôleur + 2 workers RASSILON, bases séparées, TLS local ; hors dépôt, dans le scratchpad de session) | **13/13** |
| Second appareil physique | **NOT_RUN** |

**Navigateur (79)** :

- inventaire, création, renommage, suppression ; liens et déliens avec empreinte ; UNKNOWN, PARTIAL, REVOKED ; OMEGA NOT_ROUTABLE avec raison ;
- sonde explicite ; routage calcul test et embeddings (bornes, validation) ; refus ; opérations FAILED et interrompues ;
- **présence VERIFIED → STALE par vieillissement local sans aucun appel réseau** ; session EXPIRED ;
- **abort réseau → exactement 1 tentative** ; projection en erreur ; erreur interne ; API injoignable ;
- XSS sur toutes les sources ; aucune annulation, aucune action générique.

**Processus réels (13)** :

- pairing réel avec A et B ; non routable avant sonde ; sonde TLS → READY ;
- SAFE_CPU vers A (digest vérifié), jobId exact sur A ; EMBEDDING vers A ;
- **A : exactement 1 job par opération (2/2), B : 0** ; présence et session exposées sans identifiant ; aucun appel de job vers B ;
- STOP local de A → échec sur A, **B toujours 0**, aucun job supplémentaire sur A.

## 9. Régressions, compilation, démarrage, hygiène

| Contrôle | Résultat |
|---|---|
| RASSILON (16 fichiers) | **252/253**, 1 skip (Ollama réel NOT_RUN), 0 fail — identique à la baseline |
| OMEGA (14 fichiers) | **224/227**, 3 skips plateforme, 0 fail — identique |
| Régressions pertinentes (Strict Local, privacy, Local AI, port, egress, OMEGA, MAÎTRE, Monitor, Cyber, Device Fabric) | **1331/1335** ; 1 fail `test-port-preflight.mjs` (**ENVIRONMENTAL**, timeout PowerShell) ; 3 skips |
| Navigateur pertinent | Device Fabric 79/79 · RASSILON 36/36 · Voice UX 86/86 · MAÎTRE 27/27 · Observateur 25/25 · Cyber 25/25 |
| Régression backend complète | voir §9.1 |
| `npx tsc --noEmit` / `npm run build` | PASS / PASS (avertissement préexistant de taille de chunk) |
| Démarrage isolé (2 boots) | PASS (détail ci-dessous) |
| Scan de secrets | **PASS** (voir ci-dessous) |
| `.gitignore` | **PASS** (voir ci-dessous) |

**Démarrage** :

- routes Fabric enregistrées ; `/route` OMEGA → `409 not_routable` ; appareil non lié → `409 rassilon_not_linked` et opération NOT_AVAILABLE ;
- 7 routes génériques → 404 ; Host et Origin étrangers → 403 ;
- OMEGA 200 ; RASSILON DISABLED et LAN DISABLED, inchangés ; 0 identité RASSILON créée ;
- seul listener `127.0.0.1:3996` ; pas d'`EADDRINUSE`.

**Scan de secrets** :

- 19 fichiers modifiés ou nouveaux (hors `external/`) : 0 clé privée, 0 jeton, 0 secret de session, 0 mot de passe, 0 identifiant réel ;
- fichiers suivis : seules mentions PEM = fixture `privatebytes` et regex de `gen-cert.mjs` (connues, non secrètes).

**`.gitignore`** :

- ignorés : bases de test `data-test-device-fabric-*`, base runtime, WAL, logs, cache Vite des tests navigateur ;
- tout le code, les tests et les rapports Fabric restent suivables ;
- aucune règle ajoutée.

### 9.1 Régression backend complète

Commande : `node --test --test-timeout=180000 --experimental-test-module-mocks test-*.mjs`, sur 153 fichiers.

| Tests | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|
| 2532 | 2523 | 4 | 1 | 4 |

Écart avec la baseline Phase 3 (2522 tests, 2513 pass, 4 fail, 1 cancelled, 4 skipped) : **+10 tests et +10 pass, exactement les nouveaux tests Phase 4** (routage +6, audit statique +4). Mêmes non-passants, **aucun échec NEW**, aucun dans Device Fabric.

| Test | Classe | Cause |
|---|---|---|
| `test-port-preflight.mjs` (2) | ENVIRONMENTAL | timeout de 5 s de la sonde PowerShell `Get-NetTCPConnection` (instable : passe parfois) |
| `test-find-eval.mjs` | ENVIRONMENTAL | exige un serveur de dev sur `localhost:5173` |
| `test-video-manual.mjs` | HISTORICAL | chemin dépendant du répertoire courant |
| `test-regression-api.mjs` (cancelled) | HISTORICAL — handle ouvert | `serve()` sur le port 3002 jamais fermé |

## 10. Invariants de sécurité finaux

| Invariant | Valeur | Preuve |
|---|---|---|
| Clé privée partagée / session ou jeton partagé | 0 / 0 | aucun import de secret-store, d'identité ou de signature ; l'id de session sortant n'est passé qu'aux fonctions RASSILON (test statique) et n'apparaît dans aucune ligne `fabric_*` ni vue (tests) |
| Héritage de confiance / de permission | 0 / 0 | tests de séparation dans les deux sens ; OMEGA ADMIN ne rend jamais RASSILON routable |
| Réutilisation d'auth inter-agents | 0 | aucun courtier de session ; tables et preuves distinctes |
| Liaison automatique | 0 | aucun code ; tests même IP, même nom |
| Routage / retry / reciblage automatiques | 0 / 0 / 0 | déclenchement uniquement par clic confirmé ; tentative unique client (test statique + abort réseau) ; un seul dispatch |
| Routage par voix / par agent | 0 / 0 | seuls importateurs : l'onglet APPAREILS, `client.ts`, `SettingsModal` ; backend : route Fabric et reprise au boot |
| Shell distant / exécuteur générique / exécutable ou code arbitraire | 0 / 0 / 0 / 0 | enum fermé, champs exécutables refusés, audit statique |
| Routage OMEGA | 0 | `not_routable` ; aucun import OMEGA hors lecture via `sqlite.js` |
| Nouveau listener / relais cloud / registre Internet / changement pare-feu | 0 / 0 / 0 / 0 | démarrage : un seul listener ; audit statique réseau |
| Heartbeat / sonde automatique | 0 | seul `setInterval` réseau : relecture GET des opérations en cours ; horloge locale sans appel (tests statique + navigateur) |
| Renouvellement de session | 0 | aucun code de session côté Fabric |

## 11. Limites connues

1. Second appareil physique : **NOT_RUN**. La preuve repose sur trois processus réels en TLS local et des workers de test (vrais executors, vraies signatures).
2. OMEGA non routable, sans disponibilité ni STOP global (aucun client ni projection OMEGA).
3. Annulation controller : **NOT_IMPLEMENTED** ; pas de STOP ALL.
4. Sessions RASSILON de 15 min non renouvelées ; sonde explicite requise, fraîcheur 30 s ; pas de heartbeat.
5. Vecteurs d'embedding vérifiés mais non conservés par Fabric (résumé seulement) ; smoke Ollama réel NOT_RUN.
6. Une opération interrompue par un redémarrage reste FAILED ; elle n'est pas reprise.
7. Historiques `fabric_audit` / `fabric_operations` sans purge dédiée (comme OMEGA V1) ; pas de nettoyage destructif ajouté.
8. `test-port-preflight.mjs` : ENVIRONMENTAL, hors Fabric.

## 12. Verdict

Toutes les conditions de certification (§54) sont remplies :

- OMEGA et RASSILON intacts ;
- inventaire, liaison et cible exacte PASS ; repli 0 ;
- résultats d'un mauvais worker et d'un mauvais job refusés ;
- aucun retry, reciblage ni routage autonome ; routage OMEGA 0 ;
- tests Device Fabric et navigateur à 0 échec ; aucune nouvelle régression ;
- typecheck, build, démarrage et scan de secrets PASS.

**DEVICE FABRIC V1 : PASS — FROZEN.** Toute extension (OMEGA V2, Device Fabric Internet, automatisation inter-agents) relève d'une mission distincte.

## 13. Checkpoint

```
DOCTEUR DEVICE FABRIC V1 FINAL CERTIFICATION CHECKPOINT

OMEGA V1 untouched : PASS
RASSILON V1 untouched : PASS
Inventory : PASS
Explicit linking : PASS
Trust separation : PASS
Capability separation : PASS
UNKNOWN/PARTIAL honesty : PASS
Exact RASSILON target : PASS
Fallback worker : 0
Automatic retry : 0
Automatic retargeting : 0
Wrong-worker result rejected : PASS
Wrong-job result rejected : PASS
Result schema validation : PASS
SAFE_CPU_TASK routing : PASS
EMBEDDING_BATCH routing : PASS (provider simulé dans le worker ; smoke Ollama réel NOT_RUN)
Availability probe : PASS
Probe auto-retry : 0
Heartbeat : 0
RASSILON session expiry handled : PASS
Session renewal : 0
Controller cancellation : NOT_IMPLEMENTED
OMEGA VIEW routing : 0
OMEGA INTERACTIVE routing : 0
OMEGA ADMIN routing : 0
Shared private key : 0
Shared session/token : 0
Trust inheritance : 0
Permission inheritance : 0
Cross-agent auth reuse : 0
Autonomous routing : 0
Voice routing : 0
Agent routing : 0
Remote shell : 0
Generic executor : 0
Arbitrary executable : 0
Arbitrary code : 0
Cloud relay : 0
Internet registry : 0
New network listener : 0
Strict Local : PASS
Audit : PASS
UI : PASS
XSS protection : PASS
Device Fabric backend tests : 84/84
Device Fabric browser tests : 79/79
Real-process TLS harness : 13/13
Real physical second device : NOT_RUN
OMEGA regression : 224/227, 3 skips historiques, 0 fail (identique)
RASSILON regression : 252/253, 1 skip Ollama, 0 fail (identique)
Relevant regressions : PASS (1331/1335 ; 1 fail ENVIRONMENTAL port-preflight ; navigateur 79/79, 36/36, 86/86, 27/27, 25/25, 25/25)
Full backend regression : 153 fichiers ; 2532 tests ; 2523 pass ; 4 fail ; 1 cancelled ; 4 skipped ; 0 NEW (port-preflight ×2 et find-eval ENVIRONMENTAL ; video-manual et regression-api HISTORICAL)
Typecheck : PASS
Build : PASS
Server boot : PASS
Secret scan : PASS
Gitignore : PASS
Files changed : cortex-server/src/lib/sqlite.js (transitionFabricOperation), cortex-server/src/lib/device-fabric.js (AGENT_ERROR, routingReason, erreurs de projection), cortex-server/src/lib/device-fabric-agents.js (présence/session détaillées), cortex-server/src/lib/device-fabric-routing.js (machine d'états, résultat périmé, audit des refus, champs exécutables), cortex-server/src/routes/device-fabric.js (agentErrors), src/lib/cortex/client.ts (types), src/components/settings/DeviceFabricSettingsTab.tsx (fraîcheur/session/raisons, vieillissement local, erreurs, confirmation consommée) ; tests : cortex-server/test-device-fabric-routing.mjs, cortex-server/test-device-fabric-static-audit.mjs, scripts/test-device-fabric-browser.mjs ; rapport : reports/DEVICE_FABRIC_V1_FINAL_CERTIFICATION_2026-09.md
Known limitations : second appareil physique NOT_RUN ; OMEGA non routable (aucun client, ni projection de sessions, ni STOP global) ; annulation controller NOT_IMPLEMENTED, pas de STOP ALL ; sessions RASSILON de 15 min non renouvelées, sonde explicite requise, fraîcheur 30 s, pas de heartbeat ; vecteurs non conservés par Fabric ; smoke Ollama réel NOT_RUN ; opérations interrompues non reprises ; historiques sans purge dédiée ; port-preflight ENVIRONMENTAL
Report : reports/DEVICE_FABRIC_V1_FINAL_CERTIFICATION_2026-09.md
Final verdict : PASS
Freeze status : FROZEN
```

**STOP : ni Phase 5, ni OMEGA V2, ni Device Fabric Internet, ni automatisation inter-agents. OMEGA et RASSILON ne sont pas modifiés.**
