# DOCTEUR OMEGA V2 OUTBOUND — Transport V1

## Phase 2 — Secure transport + authenticated session

Date : 2026-09-24  
Verdict : **PASS**  
Périmètre : transport TLS sortant, identités OMEGA V2, confiance directionnelle,
authentification mutuelle, sessions courtes, anti-rejeu, état et STOP uniquement.

## 1. Résultat

La fondation OMEGA V2 outbound est implémentée de façon additive. Ce poste peut
ouvrir une session authentifiée vers un hôte OMEGA V2 explicitement approuvé sur un
LAN privé. La cible réseau, le certificat, l'identité applicative, la session et
chaque requête/réponse sont liés cryptographiquement.

Cette phase n'ajoute aucune exécution VIEW, INTERACTIVE ou ADMIN. Elle n'ajoute
aucun écran, événement d'entrée, action administrative, shell, fichier,
presse-papiers, credential, relais ou listener.

OMEGA V1, RASSILON V1 et Device Fabric V1 restent fonctionnellement inchangés.
L'unique intégration au serveur existant est le montage du nouveau groupe de routes
sur le listener Cortex déjà présent.

## 2. Modules ajoutés

| Module | Responsabilité |
|---|---|
| `omega-outbound-protocol.js` | domaines cryptographiques, canonicalisation, hash, signatures, permissions, horloge et nonces |
| `omega-outbound-identity.js` | identités Ed25519 controller/host et clés privées DPAPI |
| `omega-outbound-store.js` | tables additives `omega_v2_*`, trust directionnel, sessions, replay et audit |
| `omega-outbound-network.js` | politique LAN privé, profil Windows Private et client HTTPS strict |
| `omega-outbound-client.js` | handshake sortant, sessions, status signé, STOP et nettoyage |
| `routes/omega-outbound.js` | API locale protégée et adaptateur serveur OMEGA V2 TLS |
| `fixtures/omega-outbound-server-child.mjs` | processus hôte isolé du harness TLS |

`server.js` importe et monte uniquement la nouvelle route. Aucune route OMEGA V1,
RASSILON ou Device Fabric n'a été modifiée.

## 3. Identités et isolation des secrets

Deux identités Ed25519 différentes sont créées à la demande :

- `ov2c-*` / rôle `CONTROLLER` pour les requêtes sortantes ;
- `ov2h-*` / rôle `HOST` pour les challenges et réponses du serveur.

Les clés privées sont stockées exclusivement dans le secret-store DPAPI sous les
namespaces `omega-v2-role-key:controller:*` et `omega-v2-role-key:host:*`. SQLite
ne reçoit que l'identifiant, le rôle, la clé publique et son empreinte SHA-256.

La clé privée ne quitte pas le module d'identité : les autres modules demandent une
signature sur un domaine fermé. Aucun KeyObject ou PEM privé n'est retourné aux
routes, au frontend, aux logs ou à l'audit.

Les namespaces OMEGA V1, RASSILON et Device Fabric ne sont jamais consultés pour
authentifier OMEGA V2.

## 4. Confiance directionnelle

Deux stores distincts existent :

- `omega_v2_outbound_trust` : hôtes distants auxquels ce controller peut demander
  une session ;
- `omega_v2_inbound_trust` : controllers explicitement admis par cet hôte.

Un enregistrement `omega_devices` V1 ne crée aucune confiance V2. Le test de route
insère volontairement un appareil V1 ADMIN puis confirme que la connexion outbound
reste `DEVICE_UNTRUSTED`.

Chaque trust fixe : identité publique, empreinte d'identité, permission maximale et,
pour le sens sortant, IPv4/port/certificat/empreinte TLS exacts. Une modification
silencieuse d'un trust actif est refusée. Il faut révoquer puis enregistrer à nouveau
explicitement.

## 5. Réseau privé

Le client accepte uniquement :

- une IPv4 numérique RFC1918 ;
- une interface Windows dont la catégorie résolue est exactement `Private` ;
- une destination déjà enregistrée ;
- l'adresse exacte observée sur le socket TLS.

`Public`, `Unknown`, `DomainAuthenticated`, IP publique, DNS, loopback de production
et adresse non configurée sont refusés. Le contrôle Windows utilise un appel
PowerShell fixe et read-only à `Find-NetRoute`/`Get-NetConnectionProfile`, avec une
IPv4 préalablement normalisée ; aucun argument de commande libre n'est accepté.

Le loopback est autorisé uniquement par injection explicite dans le harness. Il
n'existe ni découverte mDNS/UDP, ni scan, proxy, relais, STUN/TURN, UPnP, NAT
traversal, tunnel inverse ou modification de pare-feu.

## 6. TLS et pinning

Le transport utilise `node:https` et `node:tls` :

- `rejectUnauthorized: true` ;
- certificat approuvé fourni comme CA dédiée au pair ;
- contrôle SAN/hostname/IP standard par `tls.checkServerIdentity` ;
- empreinte SHA-256 exacte vérifiée dans `checkServerIdentity` ;
- adresse réelle du socket égale à l'IPv4 attendue ;
- redirection, proxy et fallback HTTP absents ;
- réponse JSON limitée à 64 Kio et timeout borné.

Un certificat valide avec un mauvais pin, un certificat inconnu, un mauvais SAN/IP
ou une identité host incorrecte échoue fermé.

### Constat SAN

Le certificat généré par `@vitejs/plugin-basic-ssl` contient dans l'environnement
audité :

- `DNS:localhost` ;
- `DNS:[::1]` ;
- `IP:127.0.0.1` ;
- une IP link-local IPv6.

Il convient au harness loopback, mais ne garantit pas le SAN de l'IPv4 RFC1918 du
poste. Le transport accepte déjà un certificat opérateur correctement émis avec ce
SAN, sans contournement. Le générateur V1 n'a pas été modifié automatiquement et
aucun trust système n'est installé. La compatibilité SAN du certificat V1 générique
est donc **PARTIAL** jusqu'à fourniture explicite d'un certificat LAN compatible.

## 7. Handshake mutuellement authentifié

Séquence implémentée :

1. sélection d'un `remoteDeviceId` exact ;
2. contrôle RFC1918 et profil Private ;
3. TLS strict, SAN et pin ;
4. challenge host signé, lié aux deux devices, aux deux nonces, au certificat et à
   l'expiration ;
5. vérification locale de l'identité host épinglée ;
6. preuve controller signée sur le transcript et la permission demandée ;
7. vérification du controller contre le trust entrant explicite ;
8. permission bornée par le plafond de l'hôte ;
9. session créée et réponse signée par le host.

Le challenge est consommé au premier essai et expire après 60 secondes. Toute étape
échouée ferme la requête et ne crée aucune session.

## 8. Sessions et permissions

Une session contient uniquement :

- `sessionId` ;
- `localOmegaDeviceId` ;
- `remoteOmegaDeviceId` ;
- `permission` parmi `VIEW`, `INTERACTIVE`, `ADMIN` ;
- `createdAt` ;
- `expiresAt` ;
- `status`, fin et raison sûre.

Le TTL est fixé à quinze minutes. Il n'existe aucun bearer secret retourné au
frontend. Le `sessionId` seul n'autorise rien : toute requête doit être signée par
l'identité controller.

Les permissions suivent l'ordre fermé VIEW < INTERACTIVE < ADMIN, mais aucune route
de capacité n'existe en Phase 2. Une session ne peut pas changer de niveau ; une
future élévation exigera une nouvelle approbation/session.

Au boot, toute session V2 persistée comme active devient `INTERRUPTED`. Aucun secret
de session n'est persisté et aucune session n'est reprise.

## 9. Anti-rejeu V2

Chaque requête signe le domaine `OMEGA-V2/CONTROLLER/REQUEST` et lie :

- `localDeviceId` et `remoteDeviceId` ;
- `sessionId` et `requestId` UUID ;
- timestamp dans une fenêtre de ±60 secondes ;
- nonce aléatoire de 192 bits à usage unique ;
- méthode HTTP ;
- chemin exact ;
- SHA-256 des octets JSON du payload.

Le serveur conserve uniquement le hash du nonce, jamais le nonce brut, avec une
contrainte unique `(session, requestId)` et `(session, nonceHash)`. La consommation
est atomique SQLite et bornée par le TTL.

Chaque réponse signe `OMEGA-V2/HOST/RESPONSE` avec les deux devices, la session, le
requestId, le timestamp, le code HTTP et le hash exact du payload. Le client refuse
toute réponse d'un autre device, d'une autre session ou d'une autre requête.

Le harness confirme le rejet d'un replay exact, nonce malformé, timestamp périmé,
mauvaise session et mauvais device.

## 10. Status, STOP, révocation et panne réseau

Les états client internes utilisés sont `CONNECTING`, `AUTHENTICATING`, `CONNECTED`,
`STOPPING`, `ERROR` et `DISCONNECTED`. `CONNECTED` n'est atteint qu'après TLS,
authentification mutuelle et session signée.

`stopOmegaOutboundSession(sessionId)` :

- tente un STOP sémantique signé ;
- annule les requêtes pendantes ;
- ferme le transport ;
- termine toujours l'état local ;
- est idempotent pour une session déjà connue.

`stopAllOmegaOutboundSessions()` ne traite que les sessions actives de ce controller
et n'est pas un broadcast distant.

Une sonde de status signée s'exécute toutes les cinq secondes pendant une session.
Elle détecte STOP, révocation et expiration distants, nettoie immédiatement l'état
local observé et se désarme. Elle ne reconnecte et ne réessaie jamais. Une panne
réseau termine également la session locale avec `network_drop`.

La révocation entrante termine toutes les sessions du controller. La révocation
sortante termine les sessions locales du host concerné et interdit les connexions
suivantes.

## 11. API

### Contrôle local

Le namespace `/api/omega/outbound/*` est loopback-only, protégé contre Host/Origin
étrangers et limité à 64 Kio :

- lecture des identités publiques ;
- enregistrement/révocation explicites des hosts et controllers ;
- connexion à un device exact ;
- liste, lecture/status et STOP d'une session ;
- STOP ALL outbound ;
- audit borné.

### Adaptateur distant

Le namespace `/api/omega-v2/*`, sur le listener Cortex existant, contient seulement :

- challenge ;
- création de session ;
- status signé ;
- STOP signé.

Il exige TLS même en loopback de production. Il n'existe aucune route VIEW,
INTERACTIVE, ADMIN, `sendRaw`, requête générique, RPC, proxy, action, commande,
shell, fichier ou clipboard.

## 12. Limites et quotas

- corps distant : 16 Kio ; contrôle local : 64 Kio ; réponse distante : 64 Kio ;
- connexion/auth/request : timeout 10 secondes par défaut ;
- dix tentatives de connexion/challenge par minute et par device ;
- soixante status par minute et par session ;
- session : quinze minutes ; challenge : une minute ; dérive : ±60 secondes ;
- aucun socket pendant indéfiniment ; les requêtes actives sont détruites au STOP.

## 13. Audit et confidentialité

Enum fermé :

- `OUTBOUND_CONNECT_REQUESTED` ;
- `OUTBOUND_TLS_ESTABLISHED` ;
- `OUTBOUND_AUTHENTICATED` ;
- `OUTBOUND_SESSION_CREATED` ;
- `OUTBOUND_SESSION_DENIED` ;
- `OUTBOUND_SESSION_STOPPED` ;
- `OUTBOUND_SESSION_EXPIRED` ;
- `OUTBOUND_REMOTE_REVOKED` ;
- `OUTBOUND_TLS_FAILURE` ;
- `OUTBOUND_AUTH_FAILURE`.

L'audit ne reçoit ni clé privée, certificat complet, preuve brute, nonce brut,
secret de session, écran, frappe ou credential. Les détails sont bornés à 2000
caractères. Un type arbitraire est rejeté.

## 14. Harness TLS à deux processus

Le harness automatique crée dans `%TEMP%` :

- processus A controller, base et identité propres ;
- processus B host, autre base et autre identité ;
- certificat et clé TLS runtime ;
- vrai listener HTTPS loopback et vrai client `https` ;
- aucun mock TLS.

Il valide : connexion, authentification mutuelle, session, VIEW/INTERACTIVE/ADMIN
comme permissions uniquement, certificat inconnu, mauvais pin, mauvaise IP/SAN,
mauvais device, device inconnu/révoqué, expiration, replay, nonce invalide,
timestamp périmé, mauvaise session, absence des routes de capacité, STOP client,
STOP ALL, STOP distant automatique, révocation et chute réseau sans reconnexion.

Les fichiers temporaires sont supprimés après fermeture des deux bases/processus.

## 15. Résultats de tests

| Contrôle | Résultat |
|---|---|
| OMEGA V2 outbound | **10/10**, 0 fail, 0 cancelled, 0 skipped |
| Harness TLS deux processus | **PASS** |
| OMEGA V1 | **224/227**, 0 fail, 3 skips historiques |
| Device Fabric V1 | **84/84**, 0 fail |
| RASSILON V1 | **252/253**, 0 fail, 1 skip Ollama historique |
| Typecheck `npx tsc --noEmit` | **PASS** |
| Build `npm run build` | **PASS**, avertissement historique de chunks |
| Boot isolé | **PASS** |
| Scan statique sécurité | **PASS** |
| Scan secrets | **PASS** |
| `.gitignore` | **PASS** |
| Second appareil physique | **NOT_RUN** |

### Régression backend complète

Méthode stable : tous les `test-*.mjs`, timeout 180 s et mocks expérimentaux.

| Tests | Pass | Fail | Cancelled | Skipped |
|---:|---:|---:|---:|---:|
| 2542 | 2533 | 4 | 1 | 4 |

La baseline Device Fabric certifiée était 2532 / 2523 / 4 / 1 / 4. L'écart est
exactement **+10 tests et +10 pass**, soit la suite OMEGA V2. Aucun test OMEGA V2,
OMEGA V1, Device Fabric ou RASSILON n'échoue.

Non-passants hors périmètre : `test-find-eval.mjs` (serveur Vite absent),
`test-video-manual.mjs` (chemin historique), `test-regression-api.mjs` (serveur de
test non fermé) et instabilités de timeout OpenMontage/port-preflight selon la
contention. OpenMontage n'a pas été modifié ; les deux sous-tests Remotion signalés
dans le run global ont repassé isolément, tandis qu'un autre test de terminaison de
processus Windows a montré l'instabilité environnementale connue. Classification :
**0 NEW lié à OMEGA V2**.

## 16. Boot et absence d'activité automatique

Boot isolé sur `127.0.0.1:3998` :

- Cortex démarré correctement ;
- OMEGA V1 status : 200 ;
- liste outbound : 200 et zéro session ;
- challenge V2 sur HTTP : 426 ;
- base après boot : zéro identité, zéro trust entrant/sortant, zéro session ;
- aucun auto-connect, aucune action, aucun nouveau listener et aucune modification
  de pare-feu ;
- arrêt du PID exact du smoke confirmé.

Le health global était `degraded` uniquement parce qu'Ollama n'était pas connecté ;
le serveur et les routes testées étaient opérationnels.

## 17. Gitignore et secrets

Les règles existantes protègent :

- `certs/`, `*.pem`, `*.key`, `*.p12`, `*.pfx` ;
- `data-test-*`, `*.db`, `*.sqlite` et WAL/SHM ;
- logs, temp, PID et caches.

Le code, les tests, la fixture sans secret et les rapports restent trackables. Le
scan des nouveaux fichiers trouve zéro clé privée, token réel ou secret de session.
Aucun fichier de certificat ou DB de test n'est suivi.

## 18. Limites connues

1. Le certificat V1 générique n'a pas le SAN IPv4 LAN garanti : compatibilité
   **PARTIAL**. Un certificat explicitement émis pour l'IPv4 RFC1918 exacte doit
   être configuré et épinglé.
2. Un vrai second appareil physique est **NOT_RUN**. Le harness utilise deux vrais
   processus, deux bases, deux identités et TLS réel sur loopback.
3. Windows et IPv4 RFC1918 uniquement. IPv6, DNS et réseaux Domain/Public/Unknown
   sont refusés.
4. Le provisioning du trust est backend/local ; aucune UX de pairing V2 n'est
   incluse en Phase 2.
5. STOP/révocation distante est observé au prochain status signé, au plus cinq
   secondes plus tard ; il n'existe pas de canal push permanent.
6. Le rejet live d'un certificat déjà expiré n'a pas pu être généré avec l'outil
   OpenSSL local ; la vérification native Node/OpenSSL reste active et impossible à
   désactiver. Certificat inconnu, mauvais pin et mauvais SAN sont testés live.
7. Aucun test Internet, cloud ou réseau externe n'a été tenté.

## 19. Invariants Phase 2

| Invariant | Valeur |
|---|---:|
| Confiance inverse automatique | 0 |
| Clé privée/session/token partagé | 0 |
| Réutilisation auth RASSILON/Fabric | 0 |
| HTTP distant / fallback | 0 |
| Device fallback | 0 |
| Reconnexion automatique | 0 |
| VIEW exécuté | 0 |
| INTERACTIVE exécuté | 0 |
| ADMIN exécuté | 0 |
| Shell / terminal / code / exécutable arbitraire | 0 |
| Fichier / clipboard / credential | 0 |
| Cloud / Internet relay / registry public | 0 |
| UPnP / STUN / TURN / tunnel inverse | 0 |
| Modification pare-feu | 0 |
| Nouveau listener production | 0 |
| Routage Device Fabric | 0 |

## 20. Conclusion

La Phase 2 satisfait le périmètre transport et session authentifiée sans ouvrir de
capacité de contrôle. La prochaine phase peut construire VIEW sur ces primitives,
mais aucune implémentation Phase 3 n'est incluse ici.

**Verdict : PASS**
