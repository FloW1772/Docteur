# DOCTEUR DEVICE FABRIC — PHASE 1 : ARCHITECTURE ET AUDIT DE SÉCURITÉ

Date : 2026-09-24 · Mode : audit et architecture uniquement · Baseline : `517b364` (arbre propre)

**Périmètre** : concevoir Device Fabric au-dessus d'OMEGA V1 et de RASSILON V1, tous deux certifiés PASS et gelés (FROZEN).

**Aucune modification** d'OMEGA, de RASSILON, de la base, des routes, de l'UI, du TLS, du pairing ou des permissions. Aucune dépendance, aucun service, aucun listener, aucun test réseau.

**Seul fichier créé** : ce rapport.

**Sources auditées** :

- `reports/OMEGA_V1_FINAL_CERTIFICATION_2026-09.md` et `reports/RASSILON_V1_FINAL_CERTIFICATION_2026-09.md` (lus intégralement) ;
- `cortex-server/src/lib/omega-*.js` et `src/routes/omega*.js` ;
- `cortex-server/src/lib/rassilon-*.js` et `src/routes/rassilon*.js` ;
- schémas `omega_*` et `rassilon_*` de `sqlite.js`, intégration `server.js` ;
- frontend : `RassilonStatusBadge.tsx`, `RassilonSettingsTab.tsx`, `TopBar.tsx`, `SettingsModal.tsx`, registres voix et intents.

---

## 1. Constats d'audit qui façonnent l'architecture

Ces faits, vérifiés dans le code, déterminent l'architecture plus que les intentions de la mission. Chacun est repris plus loin.

| # | Constat | Preuve | Conséquence Fabric |
|---|---|---|---|
| F1 | **OMEGA V1 est uniquement côté hôte.** Les appareils `omega_devices` sont des clients distants qui se pairent *vers* ce Docteur pour voir ou piloter *cette* machine. Cortex ne contient aucun client OMEGA sortant. | `routes/omega.js` : « no fetch()/http(s) client anywhere » ; aucun `https.request`/`fetch` dans `omega-*.js` | « Voir l'écran du PC salon » **ne peut pas** être routé par Fabric vers OMEGA V1. Il faudrait un client OMEGA (mission OMEGA V2 distincte). |
| F2 | **RASSILON est bidirectionnel.** `rassilon_devices.role` vaut `CONTROLLER` (peut m'envoyer des jobs) ou `WORKER` (je peux lui en envoyer) ; `BOTH` est accepté par la route LAN. | `sqlite.js` l. 1542 ; `routes/rassilon-lan.js` | Une capacité n'a de sens qu'avec son **sens**. Fabric doit afficher « ce que l'appareil peut faire ici » séparément de « ce que ce PC peut lui demander ». |
| F3 | Mêmes primitives d'identité, **domaines distincts**. Les deux agents utilisent Ed25519 et une empreinte SHA-256 hex du SPKI-DER, avec des namespaces DPAPI séparés (`omega-device-key:` et `rassilon-device-key:`). | `omega-identity.js`, `rassilon-identity.js` | Une empreinte identique dans les deux domaines signifierait une **clé réutilisée**. C'est une violation à signaler, jamais une preuve de lien. |
| F4 | **Aucune liveness temps réel côté OMEGA.** `omega_devices.last_seen` n'est écrit qu'à la vérification du challenge (création de session). Aucune projection n'expose les sessions actives par appareil ; `GET /omega/sessions/:id` exige de connaître l'id. | `omega-pairing.js` l. 403 ; `omega-session.js` | La disponibilité OMEGA vaut **UNKNOWN** tant qu'OMEGA n'expose pas de projection. Pas de faux ONLINE. |
| F5 | **Aucun « STOP ALL » OMEGA exportable.** `endSession(sessionId)` agit par session, `revokeDevice()` est une révocation et non un STOP. | `omega-session.js`, `omega-devices.js` | Un futur « STOP ALL DEVICE ACTIVITY » ne peut stopper que RASSILON (`killAllRassilonWork`). La partie OMEGA reste NOT_SUPPORTED en V1 et ne doit jamais être remplacée par une révocation. |
| F6 | **La présence RASSILON n'est rafraîchie que par un échange authentifié** : `refreshRassilonWorkerStatus` ou une requête entrante. Il n'y a pas de heartbeat périodique. ONLINE < 30 s, STALE < 90 s, sinon OFFLINE. | `rassilon-scheduler.js`, `sqlite.js` `touchRassilonSession` | Fabric agrège cet état sans créer de heartbeat. La fraîcheur affichée provient de RASSILON. |
| F7 | **Repli silencieux de RASSILON sur un autre worker.** Si le `preferredDeviceId` passé à `dispatchRassilonRemoteJob` est *introuvable* (révoqué, filtré, inconnu), le code bascule sur la sélection parmi **tous** les workers. | `rassilon-controller.js` l. 145-147 | Menace « routage vers le mauvais appareil ». Fabric Phase 3 devra passer `devices: [workerLié]` et revérifier `worker.deviceId`. |
| F8 | **`ensureLocalRassilonDevice()` n'est pas une lecture** : il génère une identité RASSILON si elle est absente. | `rassilon-pairing.js` l. 47-58 | Fabric ne doit jamais l'appeler. Lecture seule via `getRassilonLocalDevice` / `getRassilonIdentity`. |
| F9 | **Pairing RASSILON bidirectionnel fusionné.** Une seule ligne par `device_id` : un second pairing en sens inverse écrase `role`, `permission_set`, endpoint et pin TLS. Un re-pairing après révocation remet `revoked_at = NULL` sur la même ligne, alors qu'OMEGA crée une **nouvelle** ligne. | `sqlite.js` `upsertRassilonDevice` | Limite RASSILON V1, sans escalade constatée : l'entrant exige toujours CONTROLLER/BOTH + session. Fabric fige l'empreinte au moment du lien et ne suppose jamais un rôle unique stable. |
| F10 | OMEGA garde `omega_sessions.nonce` en clair ; RASSILON garde `tls_certificate_pem` et `public_key_pem` dans `rassilon_devices`. | schémas | Fabric ne lit **jamais** les tables agents en SQL direct. Il passe par des fonctions de lecture listées, puis projette sur une liste blanche. |
| F11 | Plans réseau : le **plan de contrôle** OMEGA et RASSILON est loopback + Host + Origin localhost. Le **plan de données** OMEGA passe par l'écouteur Cortex principal (HTTPS LAN si `LOCAL_NETWORK=true`). RASSILON LAN a son propre écouteur, qui ne sert que `/rassilon-lan/*`. | `routes/omega.js`, `routes/rassilon.js`, `server.js` | L'API Fabric appartient au plan de contrôle local, jamais au plan de données. Le test d'isolation RASSILON Phase 5, qui énumère dynamiquement `src/routes/*`, couvrira automatiquement un futur préfixe `/device-fabric`. |
| F12 | La voix, les intents, les agents et les outils LLM ne référencent ni OMEGA ni RASSILON. | grep `src/lib/voice*`, registres | Invariant à préserver : aucun déclencheur automatique (voix, agent, LLM) ne doit atteindre une route Fabric sans mission dédiée. |
| F13 | Il n'existe aucune UI OMEGA côté frontend (limite déclarée d'OMEGA V1). | grep `src/` | « Open OMEGA » ne peut pas ouvrir une UI qui n'existe pas. En Phase 2, cette action ouvre au mieux un panneau Fabric en lecture seule des données publiques OMEGA. |

---

## 2. Modèle OMEGA actuel (audité)

- **Rôle** : Docteur est l'**hôte**. Un appareil distant se paire avec un code haché (TTL 3 min, usage unique, 5 essais max), puis reçoit une approbation locale explicite. Il ouvre ensuite une session : challenge Ed25519 signé par la clé que l'appareil **garde chez lui**, vérifié contre la clé publique enregistrée.
- **Permission** : `permission_level` entier. 1 = VIEW, 2 = INTERACTIVE, 3 = ADMIN (cumulatif), lu côté serveur depuis `omega_sessions`. ADMIN n'est jamais l'administrateur Windows.
- **Sessions** : 15 min ; nonce en chaîne, tourné à chaque requête validée.
- **Transport** : TLS réel obligatoire hors loopback (`socket.encrypted`), en-têtes forwarded ignorés.
- **Plans** : contrôle loopback (`/omega/*`) et données sur l'écouteur principal (`/omega/view|interactive|admin/*`).
- **STOP et révocation** :
  - STOP : `endSession()` par session. Les indicateurs WinForms visibles offrent un STOP local.
  - Révocation : `revokeDevice()` révoque sessions et indicateurs et bloque le device. Un re-pairing crée une nouvelle identité.
- **Audit** : `omega_audit`, enum fermé, détails ≤ 4000 caractères.
- **Projections publiques** : `listDevices()` → `{ id, displayName, fingerprint, permissionLevel, createdAt, lastSeen, revokedAt }`, sans clé publique.

## 3. Modèle RASSILON actuel (audité)

- **Identité locale** : `rassilon_local_device` + `rassilon_identity` (clé publique). La clé privée est dans le DPAPI, namespace `rassilon-device-key:`.
- **Pairs** : `rassilon_devices`, rôles `CONTROLLER` ou `WORKER` (et `BOTH` accepté), permissions `RASSILON_COMPUTE_SAFE` et `RASSILON_EMBEDDING`. La politique locale (`acceptedJobTypes`) prime.
- **Pairing** : code et TTL, usage unique, confirmation locale explicite, preuves mutuelles signées, pin TLS.
- **Sessions** : entrantes (15 min) et sortantes (`rassilon_outbound_sessions`). Chaque requête est signée (horodatage ±60 s, nonce unique, hash du corps).
- **Jobs** : signés, liés à `targetDeviceId`, executors fermés `SAFE_CPU_TASK` et `EMBEDDING_BATCH`. Les résultats sont signés et liés au `jobId`.
- **Écouteur LAN** : dédié, TLS, bind RFC1918, OFF par défaut.
- **Autorité locale** :
  - `killAllRassilonWork()` : STOP, qui révoque toutes les sessions et coupe le LAN.
  - révocation par appareil ;
  - pause automatique (batterie, activité, RAM) ; ni PAUSE manuelle ni STOP ne reprennent automatiquement.
- **Projections publiques** :
  - `deviceView` de `/rassilon/devices` : sans clé, sans certificat, sans id de session ;
  - `getRassilonDeviceSessionView()` : sens, dates, `active`, sans identifiant ;
  - `deriveDevicePresence()` ;
  - `getRassilonStatus()` ;
  - `getRassilonLanRuntimeStatus()`.

## 4. Frontières de confiance

```
┌──────────────── Docteur (cette machine) ────────────────────────────────┐
│                                                                          │
│  Utilisateur local (UI loopback, Host/Origin localhost)                  │
│        │                                                                 │
│        ▼                                                                 │
│  ┌─────────────── DEVICE FABRIC (métadonnées, 0 clé, 0 session) ──────┐  │
│  │ fabric_devices · fabric_agent_links · fabric_audit                 │  │
│  │ lecture : projections agents   ·   Phase 3 : appels API locales    │  │
│  └───────────┬──────────────────────────────────────┬─────────────────┘  │
│              │ lecture seule                        │ lecture seule      │
│  ┌───────────▼──────── OMEGA (domaine A) ──┐  ┌─────▼── RASSILON (dom. B)┐│
│  │ omega_* · clé DPAPI omega-device-key:   │  │ rassilon_* · DPAPI       ││
│  │ sessions nonce-chain · permission 1..3  │  │ rassilon-device-key:     ││
│  │ plan données sur écouteur Cortex (TLS)  │  │ sessions signées · jobs  ││
│  └───────────▲─────────────────────────────┘  │ écouteur LAN dédié (TLS) ││
│              │ clients OMEGA entrants          └─────▲──────────▲─────────┘│
└──────────────┼───────────────────────────────────────┼──────────┼─────────┘
               │                                       │ entrant  │ sortant
        appareil distant                        controllers   workers
      (clé OMEGA chez lui)                       distants     distants
```

**Règles de frontière :**

1. Fabric n'est **pas** un domaine de confiance. Il ne signe, ne vérifie, n'authentifie ni ne pairise rien.
2. Aucune flèche ne relie directement OMEGA à RASSILON. Toute séquence inter-agents passe par l'utilisateur local et par l'API propre de chaque agent.
3. Fabric n'est joignable que depuis le plan de contrôle local : jamais depuis l'écouteur LAN RASSILON, jamais par une session OMEGA ou RASSILON.

## 5. Modèle d'identité logique

- `fabricDeviceId` = `fdev-<UUIDv4>` aléatoire et **opaque**, jamais dérivé d'une clé, d'un matériel, d'un hostname, d'une IP ou d'une MAC.
- C'est une **étiquette d'inventaire** qui ne porte aucune permission. Aucun agent ne lit jamais la table Fabric pour décider d'une autorisation.
- Un appareil Fabric spécial, **« Ce PC »** (`isLocal = 1`, au plus un), regroupe :
  - l'identité RASSILON locale ;
  - le rôle d'**hôte OMEGA**. OMEGA V1 n'a pas d'auto-identité : ce rôle se matérialise par le nombre de clients OMEGA appairés, pas par un lien d'identité.
- `displayName` est choisi localement (« PC Bureau », « PC Salon », « Laptop »). Ce n'est **jamais** un identifiant de sécurité.

## 6. Modèle de lien agent

Cardinalité : un `fabricDevice` → 0 ou 1 lien OMEGA actif, et 0 ou 1 lien RASSILON actif. Une identité agent → au plus un `fabricDevice` actif.

Chaque lien fige :

- `agentType` ∈ {`OMEGA`, `RASSILON`} ;
- `agentDeviceId` ;
- `agentFingerprintAtLink` ;
- `agentRoleAtLink` ∈ {`OMEGA_CLIENT`, `RASSILON_CONTROLLER`, `RASSILON_WORKER`, `RASSILON_BOTH`, `RASSILON_LOCAL`} ;
- `linkAssurance` ;
- `linkedAt` ;
- `linkStatus` ∈ {`ACTIVE`, `UNLINKED`}.

Un lien est :

- **explicite** : action utilisateur, jamais automatique ;
- **auditable** : `FABRIC_AGENT_LINKED` / `FABRIC_AGENT_UNLINKED` ;
- **révocable** : l'unlink n'agit que sur le lien.

**Staleness calculée à la lecture, jamais persistée.** Un lien ACTIVE s'affiche `STALE` si l'identité agent :

- a disparu ;
- est révoquée ;
- présente une empreinte différente de `agentFingerprintAtLink`.

Un lien STALE ne sert jamais au routage. Il doit être re-confirmé ou supprimé explicitement.

**Preuve de lien (§24)**

| Option | Ce qu'elle prouve | Coût | Verdict V1 |
|---|---|---|---|
| Confirmation utilisateur explicite | Assertion de l'utilisateur local, avec les deux empreintes affichées et vérifiables hors bande sur l'appareil | Aucun changement agent | **Retenue** : `linkAssurance = USER_ASSERTED` |
| Preuve locale | Pour « Ce PC » seulement : l'identité RASSILON locale est prouvée locale (clé dans le DPAPI local) | Lecture seule | **Retenue** pour le lien local : `LOCAL_PROVEN` |
| Déclaration de lien mutuellement signée | Le même détenteur contrôle les deux clés, mais **pas** qu'il s'agit de la même machine physique | Exige de nouveaux endpoints de signature dans OMEGA **et** RASSILON (agents gelés). Risque d'**oracle de signature** entre protocoles : si la clé OMEGA signait des énoncés arbitraires, on pourrait lui faire signer un challenge de session. Imposerait un préfixe de domaine strict (`DOCTEUR_FABRIC_LINK_V1\0`) et un format canonique fermé. | **Différée** (V2 des agents), documentée |
| Hostname / IP / MAC / nom d'utilisateur Windows / displayName / égalité d'empreinte | Rien de fiable : instable, usurpable, ou violation (clé réutilisée) | — | **Interdits**, même comme suggestion automatique |

Garde-fous du lien V1 :

- l'identité se choisit dans la liste renvoyée par l'agent, jamais en texte libre ;
- `confirmFingerprint` doit reproduire l'empreinte courante ;
- une identité déjà liée ailleurs, révoquée, ou dont l'empreinte apparaît dans l'autre domaine est refusée.

## 7. Modèle de capacités

Trois notions, jamais confondues, chacune avec **une source de vérité agent** et **un sens** :

| Notion | Définition | Source |
|---|---|---|
| **SUPPORTED** | L'appareil sait techniquement faire X | Annonce de l'appareil ; **non fiable** car auto-déclarée |
| **AUTHORIZED** | Un utilisateur a accordé X, et à qui | Enregistrement de permission de l'agent |
| **CURRENTLY AVAILABLE** | Une session ou une présence actuelle permettrait X maintenant | État de session et de présence de l'agent |

| Lien | Sens | SUPPORTED | AUTHORIZED | AVAILABLE |
|---|---|---|---|---|
| OMEGA_CLIENT | l'appareil → **agit sur ce PC** | non annoncé par OMEGA : « — » | `permissionLevel` (VIEW ⊂ INTERACTIVE ⊂ ADMIN) accordé **par ce PC** | **UNKNOWN** en V1 (F4) ; affiche « dernière session : `lastSeen` » |
| RASSILON_WORKER | **ce PC → envoie des jobs** à l'appareil | `capabilities.safeExecutorTypes` annoncé par le worker, avec horodatage | `permissionSet` accordé **par le worker** à ce PC | presence ONLINE + session sortante active + non révoqué |
| RASSILON_CONTROLLER | l'appareil → **envoie des jobs à ce PC** | — | `permissionSet` accordé **par ce PC** ∩ `acceptedJobTypes` locaux | session entrante active + worker local activé |
| RASSILON_LOCAL (Ce PC) | local | `AVAILABLE_EXECUTORS` | `acceptedJobTypes` | `state` ∈ {IDLE, WORKING} et `enabled` |

Règles :

- AUTHORIZED n'est jamais déduit de SUPPORTED.
- AVAILABLE n'implique jamais AUTHORIZED.
- Rien, dans un agent, n'est jamais déduit d'un fait de l'autre agent.
- L'agrégat reste purement descriptif.

## 8. Modèle de routage (Phase 3, non implémenté)

```
utilisateur local ──► Fabric : résout fabricDeviceId → lien ACTIF (non STALE) du bon agentType
                      Fabric : vérifie actionType ∈ enum fermé
                      ──► API locale de l'agent (même fonction que l'UI agent) avec cible épinglée
                          ──► l'agent refait TOUT : auth, session, permission, politique locale,
                              révocation, anti-replay, ressources
                      ◄── résultat lié à {fabricDeviceId, agentType, agentDeviceId, agentRef, correlationId}
```

**Enum fermé `FabricActionType`** : `OMEGA_VIEW`, `OMEGA_INTERACTIVE`, `OMEGA_ADMIN`, `RASSILON_SAFE_CPU`, `RASSILON_EMBEDDING`. Pas de `EXEC`, `COMMAND`, `SHELL`, `SCRIPT`, `PROCESS`, `FILE`, ni de valeur libre.

| actionType | Cible V1 | Comportement |
|---|---|---|
| `RASSILON_SAFE_CPU` | lien `RASSILON_WORKER` ou `RASSILON_BOTH` | `dispatchRassilonRemoteJob({ jobType: 'SAFE_CPU_TASK', payload, resourceBudget, devices: [workerLié] })`, puis contrôle `worker.deviceId === agentDeviceId` (F7) |
| `RASSILON_EMBEDDING` | idem | idem avec `EMBEDDING_BATCH` |
| `OMEGA_VIEW`, `OMEGA_INTERACTIVE`, `OMEGA_ADMIN` | — | **`NOT_ROUTABLE_OMEGA_V1_NO_CLIENT`** (F1) : Cortex ne peut pas ouvrir de session OMEGA vers un autre hôte. L'enum est réservé ; son activation exige une mission OMEGA V2 « client ». Aucun contournement par injection d'entrées ou par un autre agent. |

Pas de repli : si la cible n'est pas éligible, la requête échoue avec `TARGET_UNAVAILABLE`. Il n'y a jamais de re-routage vers un autre appareil ou un autre agent.

**Pas d'exécuteur générique.** Fabric n'expose ni `run(command)`, ni `execute(task)`, ni shell, terminal, RPC arbitraire ou outil générique. `semanticPayload` est validé par le **schéma propre de l'agent cible** (`validateJobSchema` de RASSILON et sa liste de clés interdites). Fabric rejette aussi en amont tout champ `command`, `cmd`, `shell`, `script`, `exec`, `executable`, `url`, `path`, `file`, ainsi que tout champ d'autorité (`sessionId`, `token`, `nonce`, `signature`, `permission`, `permissionLevel`, `preferredDeviceId`).

### 8.1 Flux OMEGA (§29)

Voici le flux cible, **inactivable en V1** :

1. L'utilisateur agit sur un **client OMEGA**.
2. Le client prouve son identité à l'hôte distant (challenge).
3. L'hôte valide la session, le nonce et la permission.
4. L'hôte exécute l'action sémantique, avec une approbation locale si l'action est à fort impact.
5. Le résultat revient au client.

Fabric ne pourrait qu'**initier** ce flux, via un futur client, et présenter le résultat : il ne remplace aucune étape. Aujourd'hui, Fabric peut seulement montrer, côté hôte, quels clients OMEGA ont quels droits **sur ce PC**, et renvoyer vers le contrôle OMEGA local (pairing, révocation, STOP).

### 8.2 Flux RASSILON (§30)

1. L'utilisateur choisit l'appareil.
2. Fabric choisit RASSILON et le worker lié.
3. `dispatchRassilonRemoteJob` signe le job avec la clé RASSILON **de ce PC**. C'est la même autorité que l'API locale existante `/rassilon/jobs/dispatch`, sans rien de plus.
4. Le worker valide dans l'ordre : la session et la signature de la requête (anti-replay), l'émetteur et la cible, la permission, les `acceptedJobTypes` locaux, le schéma et les ressources.
5. Le worker exécute un executor fixe et produit un résultat signé.
6. `pollRassilonRemoteResult` vérifie la liaison jobId et worker.
7. Fabric présente le statut et le résultat.

### 8.3 Workflow inter-agents (§31, analyse seulement)

« OMEGA constate qu'un appareil est disponible » n'existe pas en V1. OMEGA ne voit que ses clients entrants, via un `lastSeen` de session.

Règle pour toute évolution : **l'information peut circuler entre agents pour l'affichage, l'autorité jamais**. Un signal OMEGA (par exemple « session active depuis le Laptop ») peut **suggérer** à l'utilisateur une action RASSILON. Il n'est jamais une entrée d'une décision RASSILON : RASSILON rafraîchit sa présence et refait toutes ses validations. Aucune règle « OMEGA ADMIN donc RASSILON autorisé », ni l'inverse.

## 9. Modèle de consentement

- Chaque agent garde son **propre** consentement, affiché séparément dans la carte :
  - OMEGA : pairing et approbation locale, niveau accordé ;
  - RASSILON : ENABLE, quotas, `acceptedJobTypes`, permissions par appareil.
- Fabric n'a **aucune** action d'activation, de quota, de sécurité ou de politique. Les boutons « Gérer dans OMEGA » et « Gérer dans RASSILON » ouvrent l'UI de l'agent.
- Lier deux identités ne vaut consentement pour rien. Le texte de confirmation l'énonce : « Ce lien est une étiquette d'inventaire. Il n'accorde aucun droit OMEGA ni RASSILON. »

## 10. Autorité locale et STOP

- Le STOP local de chaque agent gagne toujours. Fabric ne peut ni activer un agent, ni lever un STOP, ni augmenter un quota, ni désactiver une garde, ni modifier une politique locale. Aucune fonction de ce type n'est importable par un module `fabric-*`, ce qu'un audit statique vérifiera.
- **Futur bouton « STOP ALL DEVICE ACTIVITY »** (analyse) :
  - appels séparés, séquentiels et indépendants, depuis le plan de contrôle local uniquement ;
  - aucune super-session, aucun jeton commun ;
  - RASSILON : `killAllRassilonWork()` → PASS ou FAIL ;
  - OMEGA : **NOT_SUPPORTED_V1** (F5) ; l'UI renvoie vers les indicateurs STOP OMEGA visibles. **Interdit** : simuler un STOP par `revokeDevice()`, car une révocation est irréversible et relève d'une décision distincte ;
  - résultat affiché indépendamment : `OMEGA STOP : NOT_SUPPORTED_V1 / PASS / FAIL`, `RASSILON STOP : PASS / FAIL` ;
  - chaque agent audite son propre STOP ; Fabric n'enregistre qu'une corrélation.

## 11. Modèle de révocation

- Fabric **ne révoque rien**. Révoquer OMEGA (`revokeDevice`) ne touche pas RASSILON, et inversement. Ce sont des actions distinctes, dans l'UI de chaque agent.
- La carte affiche la confiance **séparément** :
  - `OMEGA : TRUSTED / REVOKED / UNKNOWN` ;
  - `RASSILON : TRUSTED / REVOKED / UNKNOWN`.
- UNKNOWN signifie : identité agent introuvable, lecture impossible ou lien STALE.
- **Suppression d'un fabricDevice** :
  - les liens passent à `UNLINKED` et l'appareil à `REMOVED` ;
  - `FABRIC_DEVICE_REMOVED` est audité ;
  - **aucun** effet sur `omega_*` ni sur `rassilon_*`.
  - La confirmation l'indique : « Cela ne révoque ni OMEGA ni RASSILON. »
- Cas particuliers :
  - **OMEGA re-pairé après révocation** : nouvelle ligne, donc nouvel `agentDeviceId`. L'ancien lien s'affiche REVOKED/STALE et il faut un nouveau lien explicite. Aucune migration automatique.
  - **RASSILON re-pairé après révocation** : même ligne, remise à TRUSTED (F9). Le lien reste valide si l'empreinte est inchangée : même clé, donc la même assertion reste vraie. Si l'empreinte change, le lien passe STALE.

## 12. Modèle d'état

L'état est **calculé à chaque lecture** à partir des projections agents. Il n'est jamais persisté, ce qui évite tout ONLINE figé.

**Sous-état par lien :**

| Agent / rôle | AVAILABLE | UNAVAILABLE | REVOKED | UNKNOWN |
|---|---|---|---|---|
| RASSILON_WORKER / BOTH | `deriveDevicePresence = ONLINE` **et** session sortante active | OFFLINE ou STALE, ou session expirée | `revokedAt` | lecture en erreur, identité absente, lien STALE |
| RASSILON_CONTROLLER | session entrante active | pas de session active | `revokedAt` | idem |
| RASSILON_LOCAL | `enabled` et `state` ∈ {IDLE, WORKING} | DISABLED, PAUSED, AUTO_PAUSED | — | `state = ERROR` → **ERROR** |
| OMEGA_CLIENT | — (aucune projection, F4) | — | `revokedAt` | **toujours UNKNOWN en V1** pour la disponibilité |

**État de l'appareil**, parmi les états demandés plus **UNKNOWN** (extension nécessaire à l'honnêteté) :

| État | Condition |
|---|---|
| ONLINE | tous les liens ACTIFS sont AVAILABLE |
| PARTIAL | au moins un lien AVAILABLE et au moins un lien non AVAILABLE (§39 : l'appareil reste utilisable pour l'agent disponible) |
| OFFLINE | tous les liens rapportent **positivement** UNAVAILABLE ou REVOKED |
| UNKNOWN | aucun lien ne peut fournir de liveness, par exemple un appareil lié seulement à un client OMEGA |
| ERROR | base Fabric indisponible, lecture agent en exception, ou agent local en ERROR |

**Pas de faux ONLINE** : ONLINE exige un signal positif et **frais**, produit par l'agent lui-même (fenêtre RASSILON de 30 s). Une absence de signal ne vaut jamais ONLINE.

**Détection en ligne (§17)** : aucun heartbeat Fabric. En Phase 3, un bouton « Actualiser » pourra appeler `refreshRassilonWorkerStatus`. C'est le transport RASSILON existant, sur action explicite de l'utilisateur, pas une boucle.

## 13. Modèle de défaillance

| Situation | Affichage | Routage |
|---|---|---|
| OMEGA disponible, RASSILON hors ligne | PARTIAL ; RASSILON UNAVAILABLE avec « dernière confirmation il y a X » | RASSILON_* → `TARGET_UNAVAILABLE` |
| RASSILON en ligne, OMEGA hors ligne | PARTIAL ou UNKNOWN (OMEGA non mesurable en V1) | RASSILON_* autorisé à tenter ; l'agent décide |
| Les deux hors ligne | OFFLINE ou UNKNOWN, jamais ONLINE | refus |
| Identité révoquée | REVOKED en rouge pour cet agent seulement | refus pour cet agent |
| Session expirée | UNAVAILABLE (« session expirée — ré-appairer dans RASSILON ») | refus ; Fabric ne renouvelle aucune session |
| Agent en ERROR | ERROR, avec le code d'erreur sûr de l'agent | refus |
| Échec TLS ou pin | UNAVAILABLE, avec le code de l'agent (`rassilon_tls_pin_mismatch`…) | refus, sans nouvelle tentative silencieuse |
| Base Fabric indisponible | bandeau ERROR ; **les UI OMEGA et RASSILON restent pleinement fonctionnelles**, car Fabric n'est pas sur leur chemin critique | tout le routage Fabric est refusé |

## 14. Corrélation d'audit

- `fabric_audit` reçoit un **enum fermé** : `FABRIC_DEVICE_CREATED`, `FABRIC_DEVICE_RENAMED`, `FABRIC_AGENT_LINKED`, `FABRIC_AGENT_UNLINKED`, `FABRIC_DEVICE_REMOVED`, `FABRIC_ROUTE_SELECTED` (Phase 3).
  - Extensions à acter en Phase 3 : `FABRIC_ROUTE_REJECTED`, `FABRIC_STOP_ALL_REQUESTED`.
- **Corrélation par référence, sans écriture dans les journaux agents.** Chaque événement de routage porte :
  - `correlationId` (UUID Fabric) ;
  - `fabricDeviceId`, `agentType`, `agentDeviceId` ;
  - `agentRef`, l'identifiant natif de l'agent (RASSILON : `jobId`, déjà présent dans `rassilon_audit.job_id` et `rassilon_remote_jobs`).
- La jointure se fait à la lecture. OMEGA et RASSILON gardent leurs journaux intacts, sans fusion ni duplication.
- Détails ≤ 1 KB. Jamais de payload, de texte d'embedding, de vecteur, de clé, de session, de nonce ou de token.
- **Pas de résultat anonyme** : tout résultat présenté est lié au quintuplet `{fabricDeviceId, agentType, agentDeviceId, agentRef, correlationId}`, et le `jobId` du résultat signé est revérifié par RASSILON (liaison obligatoire depuis la Phase 5).

## 15. Conception de la base (Phase 2, non appliquée)

Tables dans le namespace `fabric_*`, créées de façon additive. **Aucune écriture** dans `omega_*` ni `rassilon_*`. Pas de clé étrangère vers les tables agents : les références sont des valeurs validées au moment du lien, pour ne pas coupler les schémas ni bloquer une suppression côté agent.

```sql
CREATE TABLE IF NOT EXISTS fabric_devices (
  fabric_device_id TEXT PRIMARY KEY CHECK (fabric_device_id GLOB 'fdev-*'),
  display_name     TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
  local_notes      TEXT CHECK (local_notes IS NULL OR length(local_notes) <= 500),
  is_local         INTEGER NOT NULL DEFAULT 0 CHECK (is_local IN (0, 1)),
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_single_local
  ON fabric_devices(is_local) WHERE is_local = 1 AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS fabric_agent_links (
  link_id                   TEXT PRIMARY KEY,
  fabric_device_id          TEXT NOT NULL REFERENCES fabric_devices(fabric_device_id),
  agent_type                TEXT NOT NULL CHECK (agent_type IN ('OMEGA', 'RASSILON')),
  agent_device_id           TEXT NOT NULL CHECK (length(agent_device_id) BETWEEN 1 AND 128),
  agent_fingerprint_at_link TEXT NOT NULL CHECK (length(agent_fingerprint_at_link) = 64),
  agent_role_at_link        TEXT NOT NULL CHECK (agent_role_at_link IN
    ('OMEGA_CLIENT', 'RASSILON_CONTROLLER', 'RASSILON_WORKER', 'RASSILON_BOTH', 'RASSILON_LOCAL')),
  link_assurance            TEXT NOT NULL CHECK (link_assurance IN ('USER_ASSERTED', 'LOCAL_PROVEN')),
  link_status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (link_status IN ('ACTIVE', 'UNLINKED')),
  linked_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unlinked_at               TEXT
);
-- une identité agent → au plus un appareil actif ; un appareil → au plus un lien actif par agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_link_identity
  ON fabric_agent_links(agent_type, agent_device_id) WHERE link_status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_link_per_agent
  ON fabric_agent_links(fabric_device_id, agent_type) WHERE link_status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS fabric_audit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_type       TEXT NOT NULL CHECK (event_type IN ('FABRIC_DEVICE_CREATED', 'FABRIC_DEVICE_RENAMED',
                     'FABRIC_AGENT_LINKED', 'FABRIC_AGENT_UNLINKED', 'FABRIC_DEVICE_REMOVED', 'FABRIC_ROUTE_SELECTED')),
  fabric_device_id TEXT,
  agent_type       TEXT CHECK (agent_type IS NULL OR agent_type IN ('OMEGA', 'RASSILON')),
  agent_device_id  TEXT,
  correlation_id   TEXT,
  agent_ref        TEXT,
  result           TEXT NOT NULL DEFAULT '',
  detail           TEXT NOT NULL DEFAULT '{}' CHECK (length(detail) <= 1000)
);
```

La table ne contient ni clé privée, ni secret de session, ni secret de pairing, ni token, ni IP, ni MAC, ni numéro de série, ni nom d'utilisateur Windows. L'état en ligne n'y figure pas (§12).

**Liste blanche de lecture inter-domaines** (fonctions exportées existantes, lecture pure, projection immédiate) :

| Agent | Fonctions autorisées | Champs retenus |
|---|---|---|
| OMEGA | `listDevices()` (`omega-devices.js`) | `id`, `displayName`, `fingerprint`, `permissionLevel`, `lastSeen`, `revokedAt` |
| RASSILON | `listRassilonDevices()` (projeté aussitôt), `getRassilonDeviceSessionView()`, `deriveDevicePresence()`, `getRassilonStatus()`, `getRassilonLanRuntimeStatus()`, `getRassilonLocalDevice()`, `getRassilonIdentity()` | `deviceId`, `displayName`, `fingerprint`, `role`, `permissionSet`, `capabilities.safeExecutorTypes`, `status`, `lastSeenAt`, `revokedAt`, `session.{direction, active, expiresAt}`. **Exclus** : `publicKeyPem`, `tlsCertificatePem`, `endpointHost`, `endpointPort` |

Appels ajoutés en **Phase 3 seulement** : `dispatchRassilonRemoteJob`, `pollRassilonRemoteResult`, `refreshRassilonWorkerStatus` (sur clic), `killAllRassilonWork` (STOP ALL).

**Imports interdits** à tout `fabric-*.js`, vérifiés par audit statique :

- `secret-store.js` ;
- `generateDeviceIdentity`, `signWithDeviceKey`, `deleteDeviceKey` (des deux agents) ;
- `ensureLocalRassilonDevice` (F8) ;
- pairing, `createSession`, `validateAndAdvanceSession`, `endSession`, `revokeDevice`, `revokeRassilonDevice` ;
- `enableRassilon`, `changeRassilonSettings`, `startRassilonLanServer` ;
- `omega-windows-exec.js`, `maitre-*`, `node:child_process`, `node:http(s)`, `node:net` ;
- toute écriture SQL `omega_*` ou `rassilon_*`.

## 16. API conceptuelle (future, non créée)

Toutes les routes sont montées sous `/api/device-fabric/*` avec la même garde que `routes/omega.js` et `routes/rassilon.js` : loopback, Host et Origin localhost, JSON obligatoire, corps ≤ 8 KB, identifiants validés par regex. Elles ne sont **jamais** montées sur l'app LAN RASSILON et n'acceptent **aucune** session OMEGA ou RASSILON.

| Méthode et route | Phase | Effet |
|---|---|---|
| `GET /api/device-fabric/devices` | 2 | liste avec état calculé et capacités sur trois niveaux |
| `GET /api/device-fabric/devices/:id` | 2 | détail d'un appareil |
| `POST /api/device-fabric/devices` `{ displayName }` | 2 | crée un appareil |
| `PATCH /api/device-fabric/devices/:id/name` `{ displayName }` | 2 | renomme |
| `POST /api/device-fabric/devices/:id/link` `{ agentType, agentDeviceId, confirmFingerprint }` | 2 | lie une identité existante ; refus si déjà liée, révoquée, empreinte différente, ou empreinte présente dans l'autre domaine |
| `DELETE /api/device-fabric/devices/:id/link/:agent` | 2 | unlink (lien seulement) |
| `DELETE /api/device-fabric/devices/:id` | 2 | suppression logique (§11) ; route nécessaire à §15, absente de la liste de la mission |
| `POST /api/device-fabric/route` `{ fabricDeviceId, actionType, semanticPayload }` | 3 | enum fermé ; renvoie `{ correlationId, fabricDeviceId, agentType, agentDeviceId, agentRef, status }` |
| `GET /api/device-fabric/route/:correlationId` | 3 | statut et résultat vérifiés par l'agent |

Exemple de charge utile de routage (Phase 3) :

```json
{
  "fabricDeviceId": "fdev-5b1c…",
  "actionType": "RASSILON_EMBEDDING",
  "semanticPayload": { "texts": ["…"], "model": "nomic-embed-text" }
}
```

Refusés : `command`, `script`, `executable`, `shell`, `url`, `path`, `file`, tout champ d'autorité, et toute clé inconnue au premier niveau.

## 17. Concept UX : page DEVICES

```
┌ DEVICES ─────────────────────────────────────── [+ Ajouter un appareil] ┐
│ ┌ PC Bureau ─────────────────────────────────────── PARTIAL ──────────┐ │
│ │ OMEGA     TRUSTED · client · empreinte 3f9a…c21e                    │ │
│ │   Peut faire SUR CE PC : VIEW · INTERACTIVE     (accordé par ce PC) │ │
│ │   Disponibilité : inconnue (V1) · dernière session : 12:04          │ │
│ │ RASSILON  TRUSTED · worker · empreinte 81d0…7b44                    │ │
│ │   Supporté (annoncé) : SAFE_CPU_TASK, EMBEDDING_BATCH               │ │
│ │   Autorisé (par PC Bureau) : EMBEDDING_BATCH                        │ │
│ │   Disponible : NON — dernière confirmation il y a 7 min             │ │
│ │ [Gérer dans OMEGA]  [Ouvrir RASSILON]  [Lier/délier]  [Renommer]    │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ Lien = étiquette d'inventaire. N'accorde aucun droit OMEGA ou RASSILON. │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Carte** : nom, état global, puis pour chaque agent : confiance, rôle et **sens**, empreinte courte (complète dépliable), SUPPORTED, AUTHORIZED, AVAILABLE, dernière confirmation.
- **Actions** :
  - « Ouvrir RASSILON » ouvre l'onglet existant (`setSettingsInitialTab('rassilon')`).
  - « Gérer dans OMEGA » ouvre au mieux un panneau lecture seule en Phase 2 (F13).
  - **Aucun** bouton « FULL CONTROL », « Activer tout » ni « Tout autoriser ».
- **Dialogue de lien** : choix dans la liste de l'agent (jamais un id saisi), les deux empreintes affichées, case « J'ai vérifié l'empreinte sur l'appareil », avertissement « aucun droit accordé ».
- **Dialogue de suppression** : « Cela ne révoque ni OMEGA ni RASSILON. »
- **Données non fiables** (`displayName`, noms agents, codes d'erreur) :
  - rendu React en texte uniquement, jamais `dangerouslySetInnerHTML` ;
  - suppression des caractères de contrôle et bidi (U+202A–U+202E, U+2066–U+2069) ;
  - longueur bornée ;
  - le nom n'est jamais présenté comme preuve (pas de « ✓ vérifié » dérivé d'un nom).
- **Honnêteté** : API Fabric injoignable → `UNKNOWN` partout. C'est le même comportement que le badge et l'onglet RASSILON après le correctif B3 de la Phase 5.

## 18. Modèle de menaces

| Menace | Scénario | Mitigation | Phase |
|---|---|---|---|
| Confusion d'identité | OMEGA A lié par erreur à RASSILON B | choix dans une liste, empreintes affichées et `confirmFingerprint`, confirmation explicite, unlink, audit, aucun lien automatique ; le lien n'ayant aucune autorité, l'impact est un mauvais étiquetage, borné par la revalidation agent | 2 |
| Escalade inter-agents | « OMEGA ADMIN donc RASSILON autorisé » | aucune lecture d'autorisation inter-domaine ; agents inchangés ; le lien n'est jamais une entrée de décision agent ; tests de séparation | 2-3 |
| Mapping périmé | agent révoqué ou re-pairé (OMEGA → nouvelle ligne) | staleness calculée (absent, révoqué, empreinte différente) ; STALE jamais routable | 2 |
| Usurpation d'appareil | un tiers imite « PC Salon » | l'identité, c'est la clé agent (pairing et challenge des agents) ; le nom n'est qu'une étiquette | 2 |
| Collision de hostname | deux « DESKTOP-XYZ » | le hostname n'est ni lu ni stocké | 2 |
| Réaffectation d'IP | une IP DHCP change de machine | l'IP n'entre pas dans l'identité Fabric ; RASSILON épingle le certificat TLS | 2 |
| Révoqué affiché trusted | état Fabric périmé | l'état n'est jamais persisté ; relu à chaque requête depuis l'agent | 2 |
| Confusion de session | session OMEGA présentée à RASSILON, ou l'inverse | tables distinctes (`omega_sessions` / `rassilon_sessions`), schémas de preuve distincts (nonce en chaîne / en-têtes `x-rassilon-*` signés), Fabric ne manipule aucune session | par construction |
| Transfert de jetons | Fabric convertit un jeton d'un agent en jeton de l'autre | Fabric ne lit, ne stocke ni ne transmet aucun jeton ; champs d'autorité refusés dans l'API | 2-3 |
| Usurpation de capacité | un worker annonce EMBEDDING sans pouvoir le faire | SUPPORTED étiqueté « annoncé » ; le routage exige AUTHORIZED ; le worker revalide à l'exécution | 2-3 |
| Mauvais appareil ciblé | repli du dispatch (F7) | `devices: [workerLié]` et vérification `worker.deviceId` ; aucun re-routage | 3 |
| Confusion de résultat | résultat du job A présenté pour B | quintuplet de liaison ; liaison jobId obligatoire côté RASSILON | 3 |
| Confusion d'audit | journaux fusionnés ou ambigus | journaux séparés ; corrélation par `agentRef` ; pas de copie d'événements | 2-3 |
| Tromperie d'UI | nom homoglyphe ou bidi, « (vérifié) » dans un nom | nettoyage, empreinte visible, statuts issus de l'agent et jamais du nom | 2 |
| Réutilisation de clé entre domaines | même clé Ed25519 dans OMEGA et RASSILON | empreintes croisées comparées ; si égales, lien refusé et alerte | 2 |
| Oracle de signature | futur lien cross-signé qui fait signer un challenge | lien cryptographique différé ; si un jour adopté : préfixe de domaine fixe et format canonique fermé | V2 agents |
| CSRF / DNS rebinding | une page web appelle `/api/device-fabric/*` | garde loopback + Host + Origin localhost, JSON obligatoire | 2 |
| Exposition LAN | Fabric joignable depuis le LAN | jamais monté sur l'app LAN RASSILON ; contrôle loopback sur l'écouteur principal ; le test d'isolation dynamique RASSILON couvre le nouveau préfixe | 2 |
| **R-1 : OMEGA INTERACTIVE pilote l'UI locale** | un client OMEGA INTERACTIVE ou ADMIN clique dans l'UI Docteur locale (lier, dispatcher, confirmer un pairing RASSILON) | risque **préexistant** d'OMEGA V1 + RASSILON V1, sans rapport avec Fabric : INTERACTIVE équivaut à l'utilisateur local pour l'UI. Indicateur OMEGA persistant visible. Recommandation Phase 3 : refuser le routage Fabric et afficher un bandeau tant qu'une session OMEGA INTERACTIVE ou ADMIN est active, ce qui exige une projection de session OMEGA (mission OMEGA dédiée) | 3 |
| **R-2 : déclenchement automatique** | voix, agent ou outil LLM (prompt injection) qui dispatche des textes sensibles vers un worker | F12 : aucun binding aujourd'hui ; invariant « aucun intent, outil ou agent → route Fabric » vérifié statiquement ; toute ouverture future demande une mission dédiée avec confirmation utilisateur | 2-3 |
| Falsification de la base Fabric | un acteur local réécrit `fabric_*` | l'accès local en écriture à la base est déjà hors modèle ; les liens n'ont aucune autorité, donc l'impact se limite à l'étiquetage ; empreinte revérifiée au routage | 2 |

## 19. Analyse du « confused deputy »

**Principe.** Autorité(Fabric) ⊆ autorité de l'utilisateur local sur les API de contrôle locales existantes, ∩ politique de l'agent cible. Jamais ⊃.

1. **Fabric ne possède aucun pouvoir propre** : aucune clé, aucune session, aucun jeton, aucune approbation. Il n'y a rien à « prêter ».
2. **Le seul pouvoir exercé en Phase 3** est de signer un job avec la clé RASSILON de ce PC via `dispatchRassilonRemoteJob`. C'est exactement ce que fait déjà l'API locale `/rassilon/jobs/dispatch`, avec le même appelant (utilisateur local), et le worker distant refait toute sa validation.
3. **Scénario de la mission** (« Fabric possède une autorité OMEGA et appelle RASSILON ») : **impossible par construction**.
   - Fabric ne détient pas d'autorité OMEGA.
   - OMEGA V1 n'a pas de client sortant.
   - Les clés ne sont pas partagées : RASSILON vérifie ses propres clés publiques `rassilon_devices`, OMEGA les siennes.
   - Aucun module Fabric n'importe de fonction de signature.
4. **Appelants distants** :
   - un client OMEGA n'atteint que le plan de données OMEGA ;
   - un controller RASSILON n'atteint que `/rassilon-lan/*` (test d'isolation Phase 5 : tous les préfixes de `src/routes` → 404) ;
   - l'API Fabric est loopback. Aucun principal distant ne peut donc utiliser Fabric comme adjoint.
5. **Résidu R-1** : un client OMEGA INTERACTIVE agit via le bureau, donc comme l'utilisateur local. Ce n'est pas un chemin Fabric : c'est la sémantique déclarée d'INTERACTIVE. Fabric ne l'aggrave pas (aucun droit nouveau) et la Phase 3 peut le réduire.

## 20. Plan de tests (futur)

**Phase 2** : unitaires, routes Hono en mémoire, base de test isolée `data-test-fabric-*`, jamais la base réelle.

- **CRUD** : créer, renommer, supprimer un appareil. Contrôler aussi la longueur du nom, les caractères de contrôle et bidi, et le payload XSS rendu en texte.
- **Lien OMEGA** : lien avec la bonne empreinte ; refus sur empreinte fausse, identité révoquée ou identité inconnue.
- **Lien RASSILON** : WORKER, CONTROLLER, LOCAL (`LOCAL_PROVEN`).
- **Doublons** : même identité liée à deux appareils, et deux liens OMEGA sur le même appareil → refus (index partiels).
- **Unlink et suppression** : les lignes `omega_*` et `rassilon_*` restent identiques octet par octet (instantané avant/après).
- **Staleness** : révocation agent → STALE ; re-pairing OMEGA (nouvel id) → ancien lien STALE ; empreinte RASSILON changée → STALE.
- **Réutilisation de clé** : même clé dans les deux domaines → lien refusé et alerte.
- **États** : ONLINE, PARTIAL, OFFLINE, UNKNOWN, ERROR, fenêtres de présence RASSILON à 29 s, 31 s et 91 s, et « jamais ONLINE sans signal frais ».
- **Capacités** : les trois niveaux sont distincts, le sens est correct, et AUTHORIZED n'est jamais déduit de SUPPORTED.
- **Séparation** :
  - un device TRUSTED OMEGA et lié n'obtient rien côté RASSILON (dispatch refusé), et inversement ;
  - `omega_sessions` et `rassilon_sessions` restent inchangées après chaque opération Fabric.
- **Jetons croisés**, en tests négatifs contre les agents gelés, sans les modifier :
  - un `sessionId` RASSILON présenté à une route de données OMEGA → refus ;
  - un `sessionId`, un nonce ou des en-têtes OMEGA présentés à `/rassilon-lan/*` → 401.
- **Garde API** : non-loopback 403, Host étranger 403, Origin étranger 403, non-JSON 415, corps volumineux 413.
- **Strict Local et réseau** : aucun listener ni port nouveau (démarrage isolé) ; aucun fetch sortant ; préfixe absent de l'app LAN (test d'isolation existant).
- **Isolation de la base** : aucune requête Fabric ne touche `omega_*` ni `rassilon_*` en écriture (audit statique et instantané).
- **Audit statique `fabric-*.js`** : imports interdits (§15), aucun `child_process`, `exec`, `eval`, `new Function`, http(s) ni net, aucun binding voix ou outil.
- **Browser** : carte, états, dialogues, XSS, API injoignable → UNKNOWN, absence de bouton FULL CONTROL.

**Phase 3** :

- **routage RASSILON** : cible épinglée ; worker révoqué → `TARGET_UNAVAILABLE` **sans** repli (F7) ; worker non autorisé → refus agent ;
- actions `OMEGA_*` → `NOT_ROUTABLE_OMEGA_V1_NO_CLIENT` ;
- actionType hors enum et champs d'autorité ou de commande → 400 ;
- liaison de résultat par le quintuplet ; corrélation `jobId` ↔ `rassilon_audit` ;
- STOP ALL : résultats indépendants ; OMEGA NOT_SUPPORTED ; aucune révocation déclenchée.

## 21. Invariants de sécurité Device Fabric V1

| Invariant | Valeur de conception | Garantie |
|---|---|---|
| Clé privée partagée | 0 | Fabric n'a aucune clé ; imports de signature et secret-store interdits |
| Jeton de session partagé | 0 | aucune lecture ni stockage de session ; champs d'autorité refusés |
| Héritage de confiance | 0 | le lien n'est jamais une entrée de décision agent |
| Héritage de permission | 0 | idem ; capacités descriptives seulement |
| Réutilisation d'auth inter-agents | 0 | tables et schémas de preuve distincts ; aucun courtier de session |
| Shell distant / exécuteur générique | 0 / 0 | enum d'actions fermé ; aucune API d'exécution |
| Code arbitraire / exécutable arbitraire | 0 / 0 | aucun `child_process`, `eval` ni `Function` |
| Activation automatique | 0 | aucune fonction enable importable |
| Contournement de quota / de sécurité | 0 / 0 | aucune fonction settings ou garde importable |
| Relais cloud / registre Internet | 0 / 0 | aucun client réseau ; inventaire local à cette instance |
| Modification du pare-feu | 0 | aucune commande système |

## 22. Dépendances

Phase 1 : aucune. Phases 2 à 4 : **aucune dépendance nécessaire**. SQLite `better-sqlite3` (index partiels, CHECK), Hono et `node:crypto` (`randomUUID`) sont déjà présents.

## 23. Limites connues

1. **OMEGA non routable en V1 (F1)** : il n'y a pas de client OMEGA dans Cortex. Les actions `OMEGA_*` sont réservées dans l'enum mais inactivables sans mission OMEGA V2 « client ».
2. **Pas de disponibilité OMEGA (F4)**, **pas de STOP ALL OMEGA (F5)**, **pas d'UI OMEGA (F13)**. Chacun exige une projection ou une fonction OMEGA nouvelle, hors gel.
3. **Assurance de lien V1 = assertion utilisateur.** Le lien cryptographique croisé exige des évolutions des deux agents. Même signé, il prouve le co-contrôle des clés, pas l'identité physique.
4. **RASSILON V1** (gelé, à documenter et non à corriger ici) :
   - repli de `preferredDeviceId` introuvable vers n'importe quel worker (F7) ;
   - pairing bidirectionnel fusionné en une ligne (F9) ;
   - présence rafraîchie uniquement par échange authentifié (F6).
   - Une mission de maintenance RASSILON distincte peut les traiter si l'utilisateur le souhaite.
5. **Portée par instance** : chaque Docteur a son propre inventaire Fabric. Il n'y a ni synchronisation ni vue globale, par choix Strict Local.
6. **R-1 et R-2** (§18) : risques résiduels préexistants ou futurs, à traiter en Phase 3.
7. Windows-first, hérité des agents.

## 24. Feuille de route

- **Phase 2 : inventaire et liaison sûre uniquement.**
  - Tables `fabric_*` (§15).
  - Agrégation d'état en lecture seule (liste blanche §15).
  - Capacités sur trois niveaux.
  - API §16 (routes de Phase 2).
  - Page DEVICES.
  - Liaison et déliaison explicites.
  - Tests §20 Phase 2.
  - Pas de routage, pas de STOP ALL. Puis STOP.
- **Phase 3 : routage sûr.** RASSILON_* vers le worker lié, avec cible épinglée et contrôle F7 ; `NOT_ROUTABLE` pour OMEGA_* ; corrélation `jobId` ; STOP ALL RASSILON-seul avec OMEGA NOT_SUPPORTED ; mitigation R-1 si une projection OMEGA existe.
- **Phase 4 : workflows inter-agents bornés.** Suggestions d'affichage, jamais d'autorité (§8.3). Corrélation d'audit étendue. Toujours sans fusion de privilèges.
- **Prérequis hors Fabric** (missions distinctes, jamais implicites) :
  - OMEGA : client sortant, projection de sessions par appareil, fonction de STOP global ;
  - RASSILON : maintenance F7 et F9 ;
  - éventuellement, énoncé de lien signé à domaine séparé dans les deux agents.

## 25. Verdict

Critères §57 :

- OMEGA reste indépendant ✔
- RASSILON reste indépendant ✔
- pas de confiance transitive ✔
- pas de clé commune ✔
- pas de session commune ✔
- aucune autorité générique ✔
- STOP local prioritaire ✔
- routage futur sémantique uniquement ✔
- namespace de base séparé ✔
- compatible Strict Local ✔

Les limites F1, F4, F5 et F7 n'empêchent pas la Phase 2 (inventaire et liaison). Elles bornent la Phase 3 et sont documentées.

```
DOCTEUR DEVICE FABRIC PHASE 1 CHECKPOINT

OMEGA V1 preserved : PASS
RASSILON V1 preserved : PASS
Separate trust domains : PASS
Shared private key : 0
Shared session token : 0
Trust inheritance : 0
Permission inheritance : 0
Cross-agent auth reuse : 0
fabricDeviceId model : PASS
OMEGA identity link model : PASS
RASSILON identity link model : PASS
Explicit device linking : PASS
Automatic link by IP/hostname : 0
Capability aggregation : PASS
Capability vs permission separation : PASS
Routing model : PASS (RASSILON routable ; OMEGA_* réservé et NOT_ROUTABLE en V1, faute de client OMEGA)
Agent-side policy revalidation : PASS
Local STOP precedence : PASS
Independent revocation : PASS
Partial availability : PASS
Audit correlation : PASS
Database isolation : PASS
Strict Local : PASS
Internet registry : 0
Cloud relay : 0
Firewall modification : 0
Remote shell : 0
Generic executor : 0
Arbitrary code : 0
Arbitrary executable : 0
Threat model : PASS
Confused deputy protection : PASS
Test plan : PASS
Files changed : reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md
Report : reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md
Known limitations : OMEGA V1 sans client sortant (OMEGA_* non routable) ; pas de disponibilité, de STOP ALL ni d'UI OMEGA ; lien V1 = assertion utilisateur ; RASSILON : repli preferredDeviceId (F7), pairing bidirectionnel fusionné (F9), présence sans heartbeat (F6) ; inventaire par instance ; risques résiduels R-1 (OMEGA INTERACTIVE pilote l'UI locale) et R-2 (déclencheurs automatiques) ; Windows-first
Verdict : READY_FOR_PHASE_2
```

**STOP : la Phase 2 n'est pas commencée. OMEGA et RASSILON ne sont pas modifiés.**
