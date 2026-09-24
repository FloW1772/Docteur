# DOCTEUR DEVICE FABRIC — PHASE 2 : INVENTAIRE + LIAISON SÛRE V1

Date : 2026-09-24 · Baseline : `517b364` (arbre propre, seul `reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md` non suivi) · Référence : `reports/DEVICE_FABRIC_ARCHITECTURE_2026-09.md` (Phase 1, READY_FOR_PHASE_2)

**Périmètre construit** :

- inventaire Device Fabric et `fabricDeviceId` ;
- liens explicites OMEGA et RASSILON ;
- agrégation en lecture seule des capacités et des états ;
- création, renommage et suppression logique ;
- link et unlink ;
- audit ;
- API locale ;
- onglet APPAREILS ;
- tests.

**Hors périmètre, et absent du code** :

- aucun routage d'action ;
- aucun dispatch RASSILON, aucune action OMEGA ;
- aucun courtier de session, aucun jeton ni clé partagés ;
- aucun héritage de confiance ou de permission ;
- aucun heartbeat, aucune découverte réseau, aucun nouveau listener.

**OMEGA V1 et RASSILON V1 : 0 fichier modifié.** Les fichiers `omega-*` et `rassilon-*` sont inchangés, et les tables `omega_*` / `rassilon_*` n'ont pas changé de schéma.

---

## 1. Fichiers

| Fichier | Nature |
|---|---|
| `cortex-server/src/lib/device-fabric.js` | nouveau : service (validation, liaison, audit, état calculé) |
| `cortex-server/src/lib/device-fabric-agents.js` | nouveau : adaptateurs agents en lecture seule |
| `cortex-server/src/routes/device-fabric.js` | nouveau : API locale |
| `cortex-server/src/lib/sqlite.js` | +154 / −0 : bloc de schéma `fabric_*` et bloc de store délimité (`// ── DEVICE FABRIC Phase 2 store` … `END`) |
| `cortex-server/src/server.js` | +2 : import et `app.route('/api', createDeviceFabricRoute({ logger }))` |
| `src/lib/cortex/client.ts` | +111 : types `Fabric*` et 8 méthodes `deviceFabric*` |
| `src/components/settings/DeviceFabricSettingsTab.tsx` | nouveau : UI Devices |
| `src/components/modals/SettingsModal.tsx` | onglet `devices` (« APPAREILS »), sur le même modèle que `rassilon` |
| `cortex-server/test-device-fabric-core.mjs`, `-route.mjs`, `-static-audit.mjs` | nouveaux tests backend |
| `scripts/device-fabric-harness.jsx`, `scripts/test-device-fabric-browser.mjs` | nouveaux tests navigateur |
| `reports/DEVICE_FABRIC_INVENTORY_LINKING_V1_2026-09.md` | ce rapport |

## 2. Schéma

Trois tables, créées de façon additive (`CREATE … IF NOT EXISTS`) dans un bloc `exec` dédié, après le bloc RASSILON. Il n'y a **aucune** clé étrangère vers `omega_*` ou `rassilon_*`, et aucun matériel de clé, de session, de jeton, de pairing ou de certificat. L'état en ligne n'est **jamais** stocké.

| Table | Colonnes | Contraintes |
|---|---|---|
| `fabric_devices` | `fabric_device_id`, `display_name`, `status` (`ACTIVE` / `REMOVED`), `created_at`, `updated_at`, `removed_at` | `CHECK` sur le préfixe `fdev-*`, longueur du nom 1–64, `status` fermé |
| `fabric_agent_links` | `link_id`, `fabric_device_id` (FK interne vers `fabric_devices`), `agent_type`, `agent_device_id`, `agent_fingerprint`, `link_status` (`ACTIVE` / `UNLINKED`), `linked_at`, `unlinked_at` | `agent_type` ∈ {`OMEGA`, `RASSILON`} ; empreinte de 64 caractères. **Index uniques partiels** : `(agent_type, agent_device_id)` et `(fabric_device_id, agent_type)` sur les liens `ACTIVE` |
| `fabric_audit` | `id`, `created_at`, `event_type`, `fabric_device_id`, `agent_type`, `agent_device_id`, `reason` | `event_type` en **enum fermé via CHECK** ; `reason` ≤ 64 caractères |

La suppression est **logique** (`REMOVED` / `UNLINKED`) pour conserver l'historique. Un lien fermé libère l'identité, qui peut être reliée ensuite.

## 3. Modèle d'appareil Fabric

- `fabricDeviceId` = `fdev-` + `crypto.randomUUID()`, sous forme d'UUID v4 validé par regex stricte. Il n'est jamais dérivé d'une IP, d'un hostname, d'une MAC, d'un nom d'utilisateur ou d'un identifiant agent (testé).
- `displayName` : métadonnée d'interface locale sans aucun droit.
  - Normalisation NFC, suppression des espaces superflus, longueur de 1 à 64 caractères.
  - Allowlist de caractères : lettres de toute écriture, marques combinantes, chiffres, espace et `._-'()#&+:/@!?`. Donc **ni** `<` `>` `"` `\`, **ni** caractère de contrôle ou bidi.
  - Unicité insensible à la casse, pour éviter deux « PC Bureau » trompeurs.
- Au plus 256 appareils actifs.

## 4. Modèle de lien agent

- Pour chaque appareil : 0 ou 1 lien OMEGA et 0 ou 1 lien RASSILON. Les quatre combinaisons sont valides : aucun, OMEGA seul, RASSILON seul, les deux.
- **Liaison explicite uniquement.** `POST …/link` exige `{ agentType, agentDeviceId, confirmFingerprint }`. L'empreinte confirmée doit être **exactement** l'empreinte courante de l'identité, normalisée en minuscules.
  - Aucune liaison automatique (IP, hostname, MAC, nom d'utilisateur, `displayName`) : il n'existe aucun code pour cela, et c'est testé.
- **Rejets** (codes sûrs, tous audités en `FABRIC_LINK_REJECTED`) :

| Code | Cas |
|---|---|
| `agent_identity_not_found` | l'identité n'existe pas ; aucune identité n'est jamais créée |
| `agent_identity_revoked` | l'identité est révoquée : politique conservatrice, aucun nouveau lien |
| `fingerprint_confirmation_mismatch` | l'empreinte confirmée ne correspond pas |
| `cross_agent_key_reuse` | l'empreinte existe dans **n'importe quelle** identité de l'autre domaine |
| `agent_identity_already_linked` | l'identité est déjà liée à un autre appareil |
| `agent_type_already_linked_on_device` | l'appareil a déjà un lien de ce type |
| `agent_link_conflict` | course détectée par les index uniques |

- **Unlink** : ne ferme **que** la ligne `fabric_agent_links`. Il ne révoque rien, ne supprime aucune clé et n'invalide aucune session OMEGA ou RASSILON. Un test compare les tables agents octet par octet avant et après.
- **Suppression d'appareil** : ferme l'appareil et ses liens. Si des liens existent, elle exige `?confirm=REMOVE_LINKS`, sinon `409 removal_requires_link_confirmation`. Elle ne touche jamais aux trust stores des agents.
- **Liens dégradés**, jamais supprimés automatiquement (§45) :

| `linkState` | Condition | Effet |
|---|---|---|
| `MISSING` | l'identité agent n'existe plus | trust UNKNOWN, availability UNAVAILABLE |
| `FINGERPRINT_MISMATCH` | l'identité existe mais sa clé a changé | trust UNKNOWN, rien n'est projeté |
| `CROSS_AGENT_KEY_REUSE` | la clé apparaît désormais aussi dans l'autre domaine | trust UNKNOWN, rien n'est projeté |
| `REVOKED` (trust) | l'identité a été révoquée après le lien | lien visible, trust REVOKED, AVAILABLE = NO |

## 5. Adaptateur OMEGA en lecture seule

`getOmegaDevicesForFabric()` / `getOmegaDeviceForFabric(id)` s'appuient sur les lectures existantes de `sqlite.js` (`getAllOmegaDevices`, `getOmegaDeviceById`), projetées aussitôt sur une liste blanche :

- champs exposés : `agentType`, `agentDeviceId`, `displayName`, `fingerprint`, `role: OMEGA_CLIENT`, `trust`, `revokedAt`, `lastSessionAt`, `permissionLevel` ;
- champs exclus : clé publique, sessions, nonces, pairing.

Les modules `omega-*` ne sont pas importés : `omega-pairing.js` tire le graphe de gestion des clés. La table des niveaux est recopiée (`OMEGA_VIEW: 1`, `OMEGA_INTERACTIVE: 2`, `OMEGA_ADMIN: 3`) et un test vérifie qu'elle est égale à la constante OMEGA.

**Sens réel** : l'appareil agit **sur ce PC**, car OMEGA V1 est côté hôte uniquement.

| Capacité | Valeur |
|---|---|
| SUPPORTED | YES sous Windows (implémentation OMEGA V1), NO ailleurs |
| AUTHORIZED | niveau accordé par ce PC ; NO si révoqué |
| AVAILABLE | **toujours UNKNOWN** (NO si révoqué) : OMEGA n'expose aucune projection de sessions actives par appareil |
| `routable` | `false` |

`lastSessionAt` correspond au `last_seen` d'OMEGA, écrit uniquement à l'authentification d'une session. Il est affiché comme « dernière session », jamais comme une présence.

## 6. Adaptateur RASSILON en lecture seule

`getRassilonDevicesForFabric()` / `getRassilonDeviceForFabric(id)` utilisent uniquement :

- `listRassilonDevices`, `getRassilonDevice`, `getRassilonDeviceSessionView`, `getRassilonLocalDevice`, `listRassilonIdentities` (`sqlite.js`) ;
- `deriveDevicePresence` (`rassilon-scheduler.js`) ;
- `getRassilonStatus` (`rassilon-worker.js`).

Cette liste est **figée par le test statique**.

- **N'appelle jamais `ensureLocalRassilonDevice()`**, qui peut générer une identité. Un test statique vérifie son absence, et un test dynamique vérifie qu'aucune identité locale n'apparaît après lecture.
- Aucune lecture de session hors de la projection sans identifiant `getRassilonDeviceSessionView()`. Elle fusionne entrant et sortant (limite RASSILON F9) : une session rapportée dans l'autre sens vaut « inconnu pour ce sens », jamais « aucune ».
- **Exclus** : `publicKeyPem`, `tlsCertificatePem`, `endpointHost`, `endpointPort`, blob `capabilities`, identifiants de session. Les champs internes `_…` sont retirés avant toute sortie.
- **Identité locale** (`RASSILON_LOCAL`) : listée **seulement si RASSILON l'a déjà créée**. `listRassilonIdentities` est utilisé pour montrer une identité locale révoquée comme REVOKED.

| Rôle | Sens affiché | SUPPORTED | AUTHORIZED | AVAILABLE (agent) |
|---|---|---|---|---|
| `RASSILON_WORKER` | « Ce PC peut envoyer du calcul à cet appareil » | exécuteurs **annoncés** par le worker ; UNKNOWN s'il n'en a jamais annoncé | `permissionSet` accordé par le worker | UNAVAILABLE si révoqué ou sans session sortante active ; AVAILABLE si session active **et** présence ONLINE (< 30 s) ; sinon UNKNOWN |
| `RASSILON_CONTROLLER` | « Cet appareil peut envoyer du calcul à ce PC » | YES (registre fermé de ce PC) | `permissionSet` ∩ `acceptedJobTypes` locaux | idem avec la session entrante ; UNAVAILABLE si le worker local est désactivé ou en pause ; ERROR si le worker local est en ERROR |
| `RASSILON_BOTH` | les deux blocs | — | — | meilleur des deux ; ERROR prioritaire |
| `RASSILON_LOCAL` | « Worker RASSILON de ce PC » | YES | `acceptedJobTypes` | AVAILABLE si activé et IDLE/WORKING ; ERROR si ERROR ; sinon UNAVAILABLE |

Pas de heartbeat : la présence RASSILON n'est rafraîchie que par un échange authentifié (F6). Faute d'ONLINE frais, l'état est UNKNOWN, **jamais** un faux ONLINE ni un faux OFFLINE.

**Nuance documentée** : `getRassilonStatus()` appelle `getRassilonSettings()`, qui crée la ligne de réglages par défaut (`enabled=0`) si elle n'existe pas. Le boot RASSILON la crée déjà. Fabric n'y fait appel que pour un lien CONTROLLER, BOTH ou LOCAL, et ce n'est jamais une identité. Les tests créent cette ligne avant leurs instantanés, comme le boot.

## 7. Agrégation des capacités

Chaque capacité porte **trois valeurs distinctes**, SUPPORTED, AUTHORIZED et AVAILABLE, chacune ∈ {`YES`, `NO`, `UNKNOWN`}, plus `routable: false`. Elles ne sont jamais réduites à un booléen.

Règle de AVAILABLE :

- NO si l'agent est UNAVAILABLE ou ERROR, ou si SUPPORTED ou AUTHORIZED vaut NO ;
- YES uniquement si l'agent est AVAILABLE **et** que SUPPORTED et AUTHORIZED valent YES ;
- UNKNOWN sinon.

Exemple testé : un worker supporte SAFE_CPU_TASK mais ne l'autorise pas. On obtient `YES / NO / NO`, tandis qu'EMBEDDING_BATCH donne `YES / YES / YES`.

## 8. Séparation de confiance

- La confiance est affichée **par agent** (`OMEGA trust` / `RASSILON trust`). Il n'existe **aucun** champ de confiance global au niveau de l'appareil (testé).
- Aucune valeur d'un agent n'entre dans le calcul de l'autre.
- Tests explicites :
  - OMEGA TRUSTED + RASSILON REVOKED, et l'inverse : aucune contamination ;
  - OMEGA ADMIN n'autorise rien côté RASSILON ;
  - un worker RASSILON tout-permis n'élève pas un client OMEGA VIEW.

## 9. Règles d'état (calculées à la lecture)

| État de l'appareil | Règle |
|---|---|
| UNKNOWN | aucun lien, **ou** aucun lien AVAILABLE avec au moins un UNKNOWN |
| ERROR | au moins un lien ERROR |
| ONLINE | **tous** les liens AVAILABLE |
| PARTIAL | au moins un lien AVAILABLE et au moins un lien non AVAILABLE |
| OFFLINE | tous les liens UNAVAILABLE (révoqué, manquant, sans session) |

Conséquences :

- Un appareil OMEGA seul est UNKNOWN, et ne peut **jamais** être ONLINE en V1.
- OMEGA UNKNOWN + RASSILON AVAILABLE donne **PARTIAL**, conformément à l'exemple de la mission.
- ONLINE exige toujours un signal positif et frais émis par un agent.

## 10. API (loopback uniquement)

Toutes les routes ci-dessous sont montées sous `/api` et protégées par la même garde que `routes/omega.js` et `routes/rassilon.js` :

- adresse source loopback, sinon 403 ;
- Host localhost, sinon 403 (anti-DNS rebinding, vérifié sur le vrai serveur) ;
- Origin localhost http(s), sinon 403 ;
- JSON obligatoire pour POST/PATCH (415) ;
- corps ≤ 8 KiB (413) ;
- champs inconnus → `400 unknown_field` ;
- erreurs = `{ ok: false, error: <code> }`. Toute erreur inattendue devient un `500 internal_error` générique, sans message ni pile.

| Méthode et route | Effet |
|---|---|
| `GET /api/device-fabric/devices` | liste des appareils avec état calculé |
| `GET /api/device-fabric/devices/:id` | détail |
| `POST /api/device-fabric/devices` `{ displayName }` | création (201) |
| `PATCH /api/device-fabric/devices/:id` `{ displayName }` | renommage |
| `DELETE /api/device-fabric/devices/:id[?confirm=REMOVE_LINKS]` | suppression logique |
| `GET /api/device-fabric/agents` | identités OMEGA et RASSILON (projections) + `linkedFabricDeviceId` |
| `POST /api/device-fabric/devices/:id/link` `{ agentType, agentDeviceId, confirmFingerprint }` | lien explicite |
| `DELETE /api/device-fabric/devices/:id/link/:agentType` | unlink |
| `GET /api/device-fabric/audit?limit=` | audit (1 à 500) |

**Aucun endpoint `/route`, `/execute`, `/run`, `/action`, `/command`, `/dispatch`**, ni aucune action agent (view, interactive, admin, jobs, revoke, pair, enable, stop). Tous répondent 404 (testé sur 23 chemins × 2 méthodes, et sur le vrai serveur).

Audit : enum fermé (`FABRIC_DEVICE_CREATED`, `_RENAMED`, `_REMOVED`, `FABRIC_AGENT_LINKED`, `_UNLINKED`, `FABRIC_LINK_REJECTED`), imposé en code **et** par un `CHECK` SQL. Contenu : ids, type d'agent, raison sûre, horodatage. Ni nom, ni empreinte, ni clé, ni session, ni jeton.

## 11. UI : onglet APPAREILS

L'onglet APPAREILS apparaît dans Paramètres, à côté de RASSILON. Il suit le même modèle que l'onglet RASSILON et contourne le chargement des réglages du router.

- **Bandeau** : « Un lien est une étiquette d'inventaire : il n'accorde aucun droit OMEGA ni RASSILON… Aucun routage d'action dans cette version. »
- **Actions**, et uniquement celles-ci : CREATE DEVICE, RENAME, DELETE (en deux étapes), LINK OMEGA, LINK RASSILON, UNLINK OMEGA, UNLINK RASSILON (en deux étapes), REFRESH. Aucun FULL CONTROL, CONTROL DEVICE, RUN, ROUTE, DISPATCH, REVOKE, PAIR, STOP ni ENABLE (testé).
- **Carte d'appareil** :
  - nom, badge `Overall <état>` ;
  - une section OMEGA et une section RASSILON, chacune avec : Lié OUI/NON, Trust, Disponibilité, empreinte courte (8…8, complète en infobulle), libellé de **sens**, tableau SUPPORTED/AUTHORIZED/AVAILABLE par capacité ;
  - « Routing : NOT AVAILABLE » (OMEGA) ou « NOT YET ENABLED » (RASSILON) ;
  - dernière session OMEGA ou dernière confirmation RASSILON.
- **Dialogue de lien** :
  - ne liste que les identités **non liées et non révoquées** ;
  - affiche l'appareil Fabric, le type d'agent, l'identité agent et l'**empreinte complète** ;
  - la confirmation reste désactivée tant que la case « J'ai vérifié cette empreinte sur l'appareil. Ce lien n'accorde aucun droit. » n'est pas cochée ;
  - le dialogue reste ouvert si le lien est refusé.
- **Suppression** : message « Cela ne révoque ni OMEGA ni RASSILON et ne touche à aucune clé ni session. »
- **Honnêteté** : pendant le chargement, états UNKNOWN. Si l'API est injoignable : bandeau d'alerte, tous les états, confiances et capacités affichés en UNKNOWN (aucun ONLINE ou TRUSTED périmé), actions de modification désactivées.
- **XSS** :
  - rendu React texte uniquement, sans `dangerouslySetInnerHTML` ;
  - les noms venant des agents (non fiables, par exemple fournis au pairing OMEGA) sont débarrassés des caractères de contrôle et bidi et tronqués ;
  - les erreurs sont traduites depuis un dictionnaire de codes fermé, ou affichées en texte.

## 12. Tests

| Suite | Résultat |
|---|---|
| `test-device-fabric-core.mjs` | 25/25 |
| `test-device-fabric-route.mjs` | 8/8 |
| `test-device-fabric-static-audit.mjs` | 11/11 |
| **Backend Device Fabric** (3 fichiers) | **44/44**, 0 fail, 0 cancelled, 0 skipped |
| **Navigateur** `scripts/test-device-fabric-browser.mjs` | **40/40** |

**Couverture backend** :

- CRUD ; id aléatoire ; validation du nom (longueur, charset, XSS, contrôle et bidi, doublons) ;
- liens OMEGA et RASSILON, un de chaque ;
- confirmation d'empreinte exacte ; même clé (au lien et découverte ensuite) ; doublons (logique et index SQL) ;
- identité manquante (aucune création) ; identité révoquée (refus du nouveau lien, lien existant REVOKED) ;
- liens STALE (MISSING, FINGERPRINT_MISMATCH) ;
- unlink et suppression sans aucun effet sur les tables agents (instantané) ; absence de liaison automatique (même IP, même nom) ;
- énumération en lecture seule sans création d'identité RASSILON ;
- règle d'état complète ; OMEGA seul UNKNOWN ; séparation SUPPORTED/AUTHORIZED/AVAILABLE ; pas de faux ONLINE (présence de 45 s → UNKNOWN, session expirée → UNAVAILABLE) ; PARTIAL ;
- séparation de confiance et de permissions dans les deux sens ; sens CONTROLLER soumis à la politique locale et à l'ERROR local ; identité locale ;
- audit (enum, champs, `CHECK` SQL, absence de secrets).

**Sécurité API** : appelant distant 403 sur les 9 routes ; Origin et Host étrangers 403 ; 413 / 415 / 400 ; id malformé 400 ; champs inconnus refusés (y compris `sessionId`, `ip`, `permission`, `trusted`) ; conflit de même clé en 409 sans pile ; 500 générique sans détail ; aucune surface de routage.

**Audit statique** :

- aucun `ensureLocalRassilonDevice` ;
- aucune exécution, aucun shell, `eval` ou `Function` ;
- aucun réseau (fetch, http(s), net, tls, dgram, WebSocket, listen, découverte) ;
- imports limités à une liste blanche exacte, et fonctions agents autorisées figées ;
- aucune clé, secret-store, DPAPI, signature, session, nonce ou jeton ;
- aucun dispatch, stop, enable, revoke ni mutation agent ;
- le SQL Fabric ne référence que `fabric_*` ;
- frontend en texte seul ;
- aucun intent vocal, outil d'agent ou registre de commandes ne référence Device Fabric.

**Navigateur** :

- ouverture, état vide, création, renommage ;
- dialogue OMEGA (seules les identités non liées et non révoquées ; empreinte complète ; confirmation obligatoire) ;
- libellés de sens ; OMEGA UNKNOWN et NOT AVAILABLE ;
- conflit de même clé ; lien RASSILON ; PARTIAL ; SUPPORTED/AUTHORIZED/AVAILABLE distincts ; confiance séparée ; REVOKED ;
- absence de toute action de contrôle ou de routage ; unlink ;
- XSS (nom agent, nom Fabric, erreur API) ; suppression avec confirmation des liens ;
- ONLINE uniquement avec un signal frais ; API injoignable → UNKNOWN, sans ONLINE ni TRUSTED périmé, actions désactivées ; aucune erreur de page.

## 13. Régressions, compilation, démarrage

| Contrôle | Résultat |
|---|---|
| OMEGA (`test-omega-*.mjs`, 14 fichiers) | **224/227**, 3 skipped (plateforme non-Windows, préexistants), 0 fail. Identique à la certification. |
| RASSILON (`test-rassilon-*.mjs`, 16 fichiers) | **252/253**, 1 skipped (smoke Ollama réel NOT_RUN), 0 fail. Le test d'isolation LAN dynamique couvre maintenant aussi `/device-fabric` (404 sur l'app LAN). |
| Régressions pertinentes (74 fichiers : Strict Local, privacy, Local AI, port, egress, OMEGA, MAÎTRE, Monitor, Cyber) | **1247/1251**, 1 fail `test-port-preflight.mjs` (**ENVIRONMENTAL** : timeout PowerShell 5 s, inchangé depuis `f0388f2`), 3 skipped |
| Navigateur pertinent | RASSILON 36/36 (SettingsModal modifié) · Voice UX 86/86 · MAÎTRE 27/27 · Observateur 25/25 · Cyber 25/25 |
| Régression backend complète | voir §13.1 |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS (avertissement préexistant de taille de chunk) |
| Démarrage serveur (2 boots, base et port isolés, 3998) | PASS (détail ci-dessous) |

Détail du démarrage :

- routes Fabric à 200 en loopback ; Origin étranger 403 ; Host `evil.example` et hôte de type rebinding 403 (sonde `http.request` brute, car `fetch` ignore l'en-tête Host) ;
- `/route`, `/dispatch` et `/execute` → 404 ;
- OMEGA `/api/omega/status` 200 ; RASSILON DISABLED et LAN DISABLED, inchangés ;
- **aucune identité RASSILON créée** ;
- seul listener : `127.0.0.1:3998` ; aucun nouveau port ; pas d'`EADDRINUSE` ; port libéré ; persistance de l'inventaire entre deux boots.

### 13.1 Régression backend complète

Commande : `node --test --test-timeout=180000 --experimental-test-module-mocks test-*.mjs`, sur 151 fichiers (148 + 3 Fabric).

| Tests | Pass | Fail | Cancelled | Skipped |
|---|---|---|---|---|
| 2492 | 2485 | 2 | 1 | 4 |

Écart avec la baseline RASSILON Phase 5 (2448 tests, 2439 pass) : **+44 tests, exactement les tests Device Fabric**. Aucun échec **NEW**.

| Test | Classe | Cause |
|---|---|---|
| `test-find-eval.mjs` | ENVIRONMENTAL | exige un serveur de dev sur `localhost:5173` |
| `test-video-manual.mjs` | HISTORICAL | chemin dépendant du répertoire courant (`cortex-server/cortex-server/data/tmp`) |
| `test-regression-api.mjs` (cancelled) | HISTORICAL — handle ouvert | `serve()` sur le port 3002 jamais fermé |

`test-port-preflight.mjs` passe cette fois : il est bien instable pour des raisons d'environnement (timeout PowerShell). Aucun de ces fichiers n'a été modifié.

## 14. Invariants de sécurité

| Invariant | Valeur | Preuve |
|---|---|---|
| Clé privée partagée | 0 | aucune clé côté Fabric ; imports de secret-store et d'identité interdits (test statique) |
| Session partagée | 0 | aucune session lue ou stockée ; champs d'autorité refusés |
| Stockage de jeton agent | 0 | schéma et store sans jeton (test statique sur le SQL) |
| Héritage de confiance / de permission | 0 / 0 | tests de séparation dans les deux sens |
| Réutilisation d'auth inter-agents | 0 | aucun code d'auth dans Fabric |
| Création automatique d'agent | 0 | tests : identité manquante et énumération |
| Appels `ensureLocalRassilonDevice` | 0 | tests statique et dynamique |
| Liaison auto par IP / par hostname | 0 / 0 | aucun code ; test « même IP, même nom » |
| Routage distant | 0 | aucun endpoint (404 testés) |
| Shell distant / exécuteur générique | 0 / 0 | test statique |
| Listener réseau ajouté | 0 | démarrage : seul `127.0.0.1:3998` |
| Cloud / Internet / découverte | 0 | test statique réseau |

## 15. Limites connues

1. **OMEGA sans disponibilité ni routage** : pas de client OMEGA sortant ni de projection de sessions (F1, F4). La disponibilité OMEGA vaut toujours UNKNOWN et le routage NOT AVAILABLE. Un appareil OMEGA seul ne peut pas être ONLINE.
2. **Lien = assertion de l'utilisateur** (`USER_ASSERTED`), fondée sur l'empreinte vérifiée hors bande. Pas de preuve cryptographique croisée : elle exigerait de modifier les agents gelés.
3. **Présence RASSILON sans heartbeat** (F6) : un worker jamais rafraîchi par RASSILON reste UNKNOWN ou UNAVAILABLE dans Fabric, par honnêteté.
4. **Pairing RASSILON bidirectionnel fusionné** (F9) : une seule ligne par appareil. Fabric affiche le rôle courant ; une session rapportée dans l'autre sens est UNKNOWN pour ce sens.
5. `getRassilonSettings()` peut créer la ligne de réglages par défaut (`enabled=0`) si RASSILON n'a jamais démarré (§6). Ce n'est jamais une identité.
6. Inventaire propre à cette instance Docteur, sans synchronisation (Strict Local).
7. Aucun événement Fabric n'est transmis aux agents, et inversement. Les journaux restent séparés (corrélation par référence prévue en Phase 3).
8. `test-port-preflight.mjs` reste ENVIRONMENTAL, hors Fabric.

## 16. Checkpoint

```
DOCTEUR DEVICE FABRIC PHASE 2 CHECKPOINT

OMEGA V1 untouched : PASS
RASSILON V1 untouched : PASS
Fabric DB namespace : PASS
fabricDeviceId : PASS
Create device : PASS
Rename device : PASS
Delete device : PASS
Explicit OMEGA linking : PASS
Explicit RASSILON linking : PASS
OMEGA unlink : PASS
RASSILON unlink : PASS
Automatic linking : 0
IP-based linking : 0
Hostname-based linking : 0
Same-key cross-agent link rejected : PASS
Duplicate identity protection : PASS
OMEGA read-only projection : PASS
RASSILON read-only projection : PASS
ensureLocalRassilonDevice calls : 0
Trust inheritance : 0
Permission inheritance : 0
Cross-agent auth reuse : 0
Shared private key : 0
Shared session/token : 0
Capability aggregation : PASS
SUPPORTED/AUTHORIZED/AVAILABLE separation : PASS
UNKNOWN status : PASS
PARTIAL status : PASS
Revoked identity handling : PASS
Stale link handling : PASS
Device Fabric UI : PASS
XSS protection : PASS
Routing endpoints : 0
OMEGA routing : 0
RASSILON dispatch : 0
New network listener : 0
Cloud calls : 0
Strict Local : PASS
Device Fabric backend tests : 44/44
Device Fabric browser tests : 40/40
OMEGA relevant regressions : PASS (224/227, 3 skips préexistants)
RASSILON relevant regressions : PASS (252/253, 1 skip Ollama NOT_RUN)
Relevant regressions : PASS (1247/1251 ; 1 fail ENVIRONMENTAL port-preflight ; navigateur 36/36, 86/86, 27/27, 25/25, 25/25)
Full backend regression : 151 fichiers ; 2492 tests ; 2485 pass ; 2 fail ; 1 cancelled ; 4 skipped ; 0 NEW (find-eval ENVIRONMENTAL, video-manual HISTORICAL, regression-api HISTORICAL open handle)
Typecheck : PASS
Build : PASS
Server boot : PASS
Files changed : cortex-server/src/lib/sqlite.js (+154/−0, bloc fabric_*), cortex-server/src/server.js (+2), src/lib/cortex/client.ts (+111), src/components/modals/SettingsModal.tsx (onglet devices) ; nouveaux : cortex-server/src/lib/device-fabric.js, cortex-server/src/lib/device-fabric-agents.js, cortex-server/src/routes/device-fabric.js, cortex-server/test-device-fabric-core.mjs, cortex-server/test-device-fabric-route.mjs, cortex-server/test-device-fabric-static-audit.mjs, src/components/settings/DeviceFabricSettingsTab.tsx, scripts/device-fabric-harness.jsx, scripts/test-device-fabric-browser.mjs, reports/DEVICE_FABRIC_INVENTORY_LINKING_V1_2026-09.md
Known limitations : disponibilité OMEGA toujours UNKNOWN et routage NOT AVAILABLE (pas de client ni de projection de sessions OMEGA) ; lien = assertion utilisateur par empreinte ; présence RASSILON sans heartbeat ; pairing RASSILON bidirectionnel fusionné ; getRassilonSettings() peut créer la ligne de réglages par défaut ; inventaire par instance ; port-preflight ENVIRONMENTAL
Report : reports/DEVICE_FABRIC_INVENTORY_LINKING_V1_2026-09.md
Verdict : PASS
```

**STOP : la Phase 3 n'est pas commencée. Ni routage OMEGA, ni routage RASSILON, ni modification d'OMEGA ou de RASSILON.**
