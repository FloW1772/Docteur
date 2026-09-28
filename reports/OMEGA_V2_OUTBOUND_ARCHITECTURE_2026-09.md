# DOCTEUR OMEGA V2 — Client sortant

## Audit d'architecture et de sécurité — Phase 1

Date : 2026-09-24  
Statut : architecture uniquement  
Verdict : **READY_FOR_PHASE_2**

## 1. Objet et périmètre

Cette phase définit l'architecture d'un véritable client OMEGA sortant permettant à
ce poste de demander une session vers un appareil OMEGA distant explicitement
approuvé sur un LAN privé.

Cette phase ne réalise aucune implémentation. Elle ne modifie ni OMEGA V1, ni
RASSILON V1, ni Device Fabric V1, ni les routes, ni SQLite, ni l'interface, ni TLS,
ni les dépendances. Elle ne crée aucun mécanisme de contrôle autonome.

Les principes non négociables sont les suivants :

- OMEGA V1 entrant reste intact et demeure la référence certifiée ;
- la confiance est directionnelle et explicite ;
- aucune identité, clé, session ou autorisation n'est héritée de RASSILON ou de
  Device Fabric ;
- TLS est obligatoire, avec validation stricte et épinglage d'identité ;
- seuls des appels sémantiques fermés sont exposés ;
- l'appareil distant conserve la priorité absolue, notamment pour STOP ;
- aucun shell, terminal, exécutable arbitraire, transfert de fichiers, presse-papiers
  ou accès aux identifiants n'entre dans le périmètre ;
- aucune découverte Internet, aucun relais, tunnel ou changement de pare-feu n'est
  autorisé.

## 2. État réel d'OMEGA V1

### 2.1 Direction actuelle

OMEGA V1 est un système **entrant** :

```text
client distant approuvé  --->  serveur OMEGA de ce poste
                              VIEW / INTERACTIVE / ADMIN / STOP
```

Il ne contient pas de client réseau permettant à ce poste d'ouvrir une session
OMEGA vers un autre poste. Les modules OMEGA examinés n'emploient pas de primitive
sortante HTTPS/TLS ou WebSocket. Les routes existantes servent le côté hôte.

La projection Device Fabric confirme cette sémantique : le rôle existant
`OMEGA_CLIENT` représente un appareil distant qui agit sur ce poste, avec la
direction `REMOTE_ACTS_ON_THIS_PC`. Le routage OMEGA V1 reste indisponible avec la
raison `omega_outbound_client_not_implemented`.

### 2.2 Identité et confiance actuelles

Les données V1 décrivent des clients entrants approuvés :

- `omega_devices` conserve l'identifiant, la clé publique, l'empreinte, le niveau
  de permission et l'état de révocation du client distant ;
- `omega_pairings` porte le flux de jumelage entrant ;
- `omega_sessions` porte les sessions accordées à ces clients ;
- les clés privées ne sont pas stockées dans SQLite.

Le générateur d'identité OMEGA existe dans le code, mais aucun chemin de production
audité ne provisionne une identité locale utilisable comme client sortant. Il n'y a
donc pas d'identité sortante existante qui puisse être supposée ou recyclée.

Une ligne V1 signifie uniquement :

```text
le client A est autorisé à agir sur l'hôte B
```

Elle ne signifie jamais :

```text
l'hôte B est autorisé à agir sur le client A
```

### 2.3 Pairing, session et anti-rejeu actuels

Le pairing V1 utilise un code temporaire, une demande de permission, une clé
publique et une empreinte. Le challenge d'authentification est à usage unique et
éphémère. Les sessions expirent après quinze minutes et la permission effective
provient de l'enregistrement serveur ; un client ne peut donc pas s'élever seul.

Les routes de pairing, challenge et création de session sous `/omega/*` sont
réservées au loopback. Les routes de données LAN exigent ensuite une session. Le
flux de test V1 complet fonctionne localement, mais ces routes de contrôle ne
constituent pas un protocole de création de session sortante sur le LAN.

Le mécanisme V1 fait avancer une chaîne de nonce avant certaines validations métier.
Une erreur ultérieure — limite de débit, écran invalide, capture échouée ou action
administrative refusée — peut survenir sans remettre le nonce suivant au client.
Cela peut désynchroniser le client et le serveur. En outre, la preuve V1 ne lie pas
explicitement, dans une signature unique, le device, la session, l'horodatage, le
nonce, la méthode, le chemin et le hash du corps.

Conclusion : le futur client ne doit pas être un simple wrapper des routes et de la
chaîne de nonce V1. Il exige un protocole V2 additionnel, sans changement de
comportement V1.

### 2.4 TLS et exposition actuels

OMEGA V1 utilise le listener Cortex existant. Quand `LOCAL_NETWORK=true`, le
listener s'attache à `0.0.0.0` et le démarrage exige `certs/key.pem` et
`certs/cert.pem`. Les chemins distants OMEGA refusent un transport non TLS ; le
loopback HTTP reste un cas local V1.

Le serveur calcule et expose l'empreinte du certificat public. Le certificat généré
par l'outil actuel est auto-signé, mais sa compatibilité avec une validation stricte
sur une adresse IP distante — notamment son SAN IP — n'est pas garantie. Une
réémission explicite peut donc être nécessaire avant tout usage V2. Il ne faut ni
désactiver la validation TLS ni transformer une première connexion non authentifiée
en ancre de confiance.

### 2.5 Permissions et surfaces sémantiques actuelles

OMEGA V1 distingue déjà trois niveaux :

- `VIEW` : capture d'écran bornée et transmise en mémoire ;
- `INTERACTIVE` : événements pointeur/clavier typés, bornés et filtrés ;
- `ADMIN` : registre fermé d'actions connues, sans commande libre.

Les protections observées incluent notamment :

- image PNG en mémoire, taille maximale de 8 Mio, dimension maximale de 7680,
  cinq images par seconde au plus et délai de capture de cinq secondes ;
- lots interactifs de vingt événements au plus, vingt requêtes par seconde, corps
  de 8 Kio, bornes pointeur strictes, molette limitée et touches autorisées ;
- actions administratives sans argument libre, lecture limitée, une confirmation
  locale à la fois pour les actions à fort impact, résultat limité à 512 Kio ;
- indicateur local visible et mécanisme STOP local ;
- révocation invalidant les sessions associées.

La liste administrative exacte est :

| Classe | Actions autorisées |
|---|---|
| Lecture seule | `GET_SYSTEM_INFO`, `GET_PROCESS_LIST`, `GET_SERVICE_STATUS`, `GET_NETWORK_STATUS`, `GET_DISK_STATUS` |
| Fort impact avec confirmation locale distante | `LOCK_WORKSTATION`, `REQUEST_LOGOFF`, `REQUEST_RESTART`, `REQUEST_SHUTDOWN` |

Il n'existe aucune route RPC générique, aucun shell distant et aucune exécution
arbitraire dans cette surface.

### 2.6 Indicateur et STOP actuels

L'indicateur Windows expose le type de session et le mode. Son bail doit être
rafraîchi chaque seconde et expire après cinq secondes. Le STOP local de l'hôte met
fin à la session. Le STOP distant authentifié termine lui aussi la session, les
modes VIEW/INTERACTIVE, l'indicateur et les confirmations administratives en attente.

Dans certains chemins VIEW/INTERACTIVE V1, l'échec d'affichage de l'indicateur est
traité au mieux et ne bloque pas nécessairement l'opération. V2 devra être plus
strict : aucune activation distante ne doit réussir si l'indicateur visible de
l'hôte distant n'est pas confirmé.

### 2.7 Audit et persistance actuels

Les événements V1 sont validés par une liste fermée. Les tables VIEW/INTERACTIVE
conservent de l'état, mais pas les pixels ni le texte des frappes. Le schéma actuel
n'impose pas toutes les relations par clés étrangères et ne fournit pas un cycle de
nettoyage complet ; cela reste une limite V1 connue.

Les nouveaux événements sortants ne doivent pas être injectés implicitement dans
l'énumération figée V1. V2 emploiera une surface d'audit additionnelle dédiée.

## 3. Séparation architecturale V1 / V2

OMEGA V2 doit ajouter deux rôles nettement séparés :

```text
Poste A                                  Poste B
-----------------------------            -----------------------------
OMEGA V2 outbound client   -- TLS -->    OMEGA V2 inbound adapter
identité "controller"                    identité "host"
session locale en mémoire                autorisation entrante explicite
API sémantique fermée                    moteurs V1 bornés réutilisables
```

Le côté serveur V2 sera un adaptateur additionnel sur le listener TLS existant, par
exemple sous un préfixe dédié `/api/omega-v2/*`. Il ne rendra pas les routes de
contrôle V1 accessibles à distance et ne modifiera pas leur comportement. Il pourra
réutiliser les moteurs sémantiques déjà bornés — capture, entrée, registre ADMIN,
indicateur et STOP — derrière une authentification et des enveloppes V2 distinctes.

La séparation logique proposée est :

- `omega-v2-outbound-client` : transport sortant et machine d'état locale ;
- `omega-v2-identity` : identités à rôles séparés ;
- `omega-v2-trust-store` : pairs sortants explicitement approuvés ;
- `omega-v2-protocol` : canonicalisation, signatures et anti-rejeu ;
- `omega-v2-server-adapter` : handshake et opérations entrantes V2 ;
- `omega-v2-outbound-audit` : journal fermé sans contenu sensible.

Ce découpage ne désigne pas des fichiers à créer durant cette phase ; il fixe les
frontières à respecter pendant l'implémentation ultérieure.

## 4. Modèle d'identité

### 4.1 Identités à rôles séparés

Chaque installation V2 dispose de deux identités OMEGA indépendantes :

1. une identité **outbound controller**, utilisée lorsque ce poste demande à agir
   sur un hôte distant ;
2. une identité **inbound host**, utilisée lorsque ce poste atteste le service
   auquel un contrôleur distant se connecte.

Les paires de clés sont distinctes. Les signatures sont également séparées par un
domaine de protocole et un rôle (`OMEGA-V2/CONTROLLER/...` ou
`OMEGA-V2/HOST/...`). Une signature obtenue dans un rôle ne peut ainsi pas servir
comme oracle dans l'autre.

Les clés privées sont protégées localement par DPAPI sous des namespaces OMEGA V2
propres au rôle. Elles ne figurent jamais dans SQLite, les logs, Device Fabric ou
RASSILON. SQLite peut conserver uniquement :

- l'identifiant public stable ;
- la clé publique et son empreinte ;
- le rôle ;
- les métadonnées de création, rotation et révocation.

Il n'existe aucune clé maîtresse, aucune identité partagée entre agents et aucun
secret transversal.

### 4.2 Identité de transport et identité applicative

L'identité TLS et l'identité OMEGA applicative ont des responsabilités différentes :

- le certificat TLS authentifie le point de terminaison réseau exact et chiffre le
  canal ;
- la clé OMEGA host signe le transcript du handshake et les réponses ;
- la clé OMEGA controller signe les demandes et prouve l'autorisation entrante
  explicitement accordée par l'hôte.

La validation des deux couches est obligatoire. Une réussite applicative ne
compense jamais un échec TLS, et inversement.

## 5. Modèle de confiance directionnelle

### 5.1 Règle de base

La confiance est un arc orienté :

```text
A controller  -- autorisé à agir -->  B host
```

Elle ne crée pas l'arc inverse. Un appareil déjà présent dans `omega_devices` comme
client entrant ne devient pas un hôte sortant approuvé. Un contrôle inverse exige
un nouveau pairing explicite, une nouvelle validation du certificat et de
l'identité hôte, puis une autorisation locale sur l'autre machine.

Les enregistrements V1 ne sont jamais migrés automatiquement vers V2. Une éventuelle
association d'affichage est informative et ne transporte aucune autorisation.

### 5.2 Bundle public de pairing

L'hôte B produit localement un bundle public et temporaire contenant au minimum :

- version du protocole ;
- identifiant public `omegaDeviceId` du rôle host ;
- clé publique et empreinte de l'identité host ;
- certificat public complet et empreinte SHA-256 ;
- adresse IPv4 RFC1918 exacte et port TLS ;
- identifiant de pairing, expiration et code de validation à usage limité.

Ce bundle est transféré et vérifié par un canal humain explicite : affichage local,
QR ou import de fichier public. Aucune clé privée ne le quitte. La première connexion
réseau ne peut pas remplacer cette validation hors bande.

Sur B, l'utilisateur accepte explicitement l'identité controller de A et choisit la
permission maximale accordée. Sur A, l'utilisateur confirme explicitement l'identité
host et le certificat de B. Le pairing n'est validé que lorsque les deux preuves
correspondent.

### 5.3 Révocation et changement d'identité

Une révocation :

- refuse toute nouvelle session ;
- termine immédiatement les sessions actives associées ;
- arrête VIEW, INTERACTIVE et ADMIN ;
- efface les secrets éphémères en mémoire ;
- produit un événement d'audit sans secret.

Un changement de certificat, d'empreinte ou de clé host échoue fermé avec
`TLS_MISMATCH` ou `DEVICE_UNTRUSTED`. Il n'existe aucune mise à jour silencieuse :
une revalidation ou un nouveau pairing explicite est requis.

## 6. Politique réseau et TLS

### 6.1 LAN privé uniquement

Avant toute ouverture de socket, le client vérifie :

1. que l'interface utilisée par la route possède le profil Windows `Private` ;
2. que la cible est une adresse IPv4 numérique RFC1918 ;
3. que l'adresse correspond exactement au pair approuvé ;
4. qu'aucun proxy, redirect ou nom DNS alternatif n'intervient.

Un profil `Public`, `Unknown` ou indéterminable entraîne un refus. Une adresse
publique, loopback hors harness de test, link-local ou non prévue entraîne un refus.
Le contrôle du profil devra utiliser une lecture locale bornée, idéalement les
primitives Node disponibles et, si nécessaire sous Windows, un script PowerShell
fixe sans argument exécutable fourni par l'utilisateur.

Le système ne modifie jamais le pare-feu, le profil réseau, le routage ou le magasin
de certificats. Il n'emploie ni multicast de découverte, ni cloud, ni relais, ni
UPnP, ni STUN/TURN, ni tunnel inverse.

### 6.2 Validation TLS

Le client utilise les primitives natives Node `https`/`tls` :

- `rejectUnauthorized: true` reste obligatoire ;
- le certificat public approuvé est fourni comme ancre `ca` dédiée au pair ;
- `checkServerIdentity` contrôle le certificat, l'adresse attendue et l'empreinte
  SHA-256 épinglée ;
- l'adresse réelle du socket pair est comparée à l'IPv4 RFC1918 attendue ;
- les redirections sont refusées ;
- aucune négociation HTTP en repli n'est tentée ;
- aucun proxy d'environnement n'est utilisé ;
- seules les versions TLS modernes prises en charge sont admises.

Le certificat doit contenir un SAN compatible avec l'adresse IP approuvée. Si le
certificat V1 actuel ne le permet pas, l'opérateur doit en générer ou installer un
nouveau explicitement puis refaire la validation. Aucune exception de type
`rejectUnauthorized: false` n'est acceptable, même temporairement.

## 7. Handshake et création de session

### 7.1 Séquence

```text
Utilisateur A         Client A                Host B
    |                    |                       |
    | cible exacte       |                       |
    |------------------->|                       |
    |                    | profil Private/RFC1918|
    |                    | TLS + pin exact       |
    |                    |---------------------->|
    |                    |<-- challenge signé B--|
    |                    | vérifie identité B    |
    |                    |-- preuve signée A --->|
    |                    |                       | vérifie grant A
    |                    |<-- session signée ----|
    |<-- CONNECTED ------|                       |
```

Le transcript du handshake lie au minimum : version, domaine de protocole,
identités controller et host, certificat épinglé, adresse/port exacts, deux
challenges aléatoires, horodatage, permission demandée et hash du transcript.

L'hôte choisit la permission effective dans l'intersection entre la demande et le
grant local approuvé. Le client, Device Fabric et le réseau ne peuvent jamais
augmenter cette permission.

### 7.2 Données de session

Une session logique contient :

- `sessionId` ;
- `localDeviceId` — identité controller ;
- `remoteDeviceId` — identité host exacte ;
- `permission` ;
- `createdAt` ;
- `expiresAt` ;
- état anti-rejeu borné ;
- `status`.

La durée maximale proposée reste quinze minutes, cohérente avec V1. Le serveur peut
choisir une durée plus courte. Le `sessionId` est un identifiant, pas un bearer
token suffisant : chaque requête exige une nouvelle signature valide.

Le client conserve les secrets de session et les nonces uniquement en mémoire. Le
serveur ne persiste, si nécessaire, que les métadonnées non secrètes, empreintes et
états anti-rejeu bornés. Aucun token brut, clé privée ou secret de session n'est
écrit dans SQLite.

Une perte réseau, un arrêt de processus, une expiration ou une erreur d'identité
termine la session. Il n'existe ni restauration, ni reprise, ni reconnexion
automatique.

## 8. Enveloppes authentifiées et anti-rejeu

### 8.1 Requête

Chaque requête possède un `requestId`/`operationId` unique et un nonce aléatoire d'au
moins 192 bits. La signature controller couvre une représentation canonique de :

```text
protocolDomain
protocolVersion
localDeviceId
remoteDeviceId
sessionId
requestId
operationId
timestamp
nonce
httpMethod
canonicalPath
sha256(exactBodyBytes)
```

L'hôte vérifie, dans cet ordre logique :

- la session active et non expirée ;
- les identités et la cible exactes ;
- la méthode et le chemin sémantique attendus ;
- le hash du corps reçu ;
- une dérive d'horloge maximale proposée de 60 secondes ;
- l'unicité du nonce, du `requestId` et de l'`operationId` dans la session ;
- la signature controller ;
- la permission et les limites applicables.

L'état anti-rejeu est borné par la durée et le nombre maximum d'opérations de la
session. Une entrée expirée est supprimée de façon déterministe. Le rejet d'une
opération métier ne désynchronise aucun nonce séquentiel partagé.

### 8.2 Réponse

Toute réponse applicative est signée par l'identité host et lie :

```text
protocolDomain
protocolVersion
localDeviceId
remoteDeviceId
sessionId
requestId
operationId
timestamp
statusCode
sha256(exactResponseBytes)
```

Le client rejette une réponse dont l'identité distante, la session, la requête,
l'opération, le hash ou la signature diffère. Une réponse valide provenant d'un
autre appareil n'est jamais acceptée. Il n'existe aucun fallback vers un autre
device en cas d'indisponibilité de la cible.

## 9. Machine d'état du client

États fermés :

```text
DISCONNECTED
CONNECTING
AUTHENTICATING
CONNECTED
VIEWING
INTERACTIVE
ADMIN
STOPPING
ERROR
```

Transitions principales :

```text
DISCONNECTED -> CONNECTING -> AUTHENTICATING -> CONNECTED
CONNECTED -> VIEWING | INTERACTIVE | ADMIN
VIEWING | INTERACTIVE | ADMIN -> CONNECTED
CONNECTED | mode actif -> STOPPING -> DISCONNECTED
tout état actif -> ERROR -> DISCONNECTED (après nettoyage local)
```

`CONNECTED` n'est publié qu'après TLS, authentification mutuelle et création réelle
de la session. Pour éviter toute ambiguïté lorsque plusieurs capacités coexistent,
l'état de connexion est conservé séparément de la collection fermée des modes
actifs ; l'état public ci-dessus est une projection déterministe.

Les erreurs publiques sont fermées et non sensibles :

- `TLS_MISMATCH` ;
- `DEVICE_REVOKED` ;
- `DEVICE_UNTRUSTED` ;
- `NETWORK_UNAVAILABLE` ;
- `SESSION_EXPIRED` ;
- `PERMISSION_DENIED` ;
- `REMOTE_STOPPED` ;
- `RATE_LIMITED`.

Aucune erreur n'expose de clé, nonce, contenu d'écran, frappe ou détail de commande.

## 10. API applicative fermée

La future API locale propose uniquement des opérations typées :

```text
connectOmegaDevice(deviceId)
createOmegaSession(deviceId, permission)
startOmegaView(sessionId)
sendOmegaPointer(sessionId, pointerEvent)
sendOmegaKeyboard(sessionId, keyboardEvent)
runOmegaAdminAction(sessionId, action)
stopOmegaSession(sessionId)
stopAllOutboundSessions()
getOmegaOutboundStatus()
disconnectOmegaDevice(deviceId)
```

Les identifiants sont résolus dans le trust store local. Aucun appelant ne fournit
une URL, une méthode HTTP, un chemin arbitraire, un script, une commande, des
arguments d'exécutable ou un payload opaque.

Il n'existe pas de méthode `rpc`, `execute`, `shell`, `terminal`, `runCommand`,
`sendFile`, `clipboard`, `credential` ou `connectAny`. Toute nouvelle capacité
exigera une extension explicite de l'énumération, une validation, un audit et une
certification.

## 11. Conception VIEW

`startOmegaView(sessionId)` :

- exige une session exacte avec permission `VIEW` ou supérieure explicitement
  accordée ;
- exige que l'indicateur local de B soit visible avant la première image ;
- capture uniquement un écran explicitement sélectionné selon le contrat fermé ;
- conserve les images en mémoire et ne crée aucune capture automatique sur disque ;
- limite la cadence à cinq images par seconde au maximum ;
- limite chaque image à 8 Mio et chaque dimension à 7680 ;
- applique un timeout de capture de cinq secondes ;
- vérifie longueur, hash signé, signature, magic PNG et dimensions avant exposition ;
- libère les buffers dès consommation ou arrêt.

Le client n'enregistre pas automatiquement les images, ne génère pas de miniature
persistante et ne les écrit pas dans les logs ou l'audit.

## 12. Conception INTERACTIVE

INTERACTIVE exige une permission distincte et l'acceptation locale visible sur B.
Le serveur distant doit confirmer son indicateur avant d'accepter le premier
événement. Un échec d'indicateur ferme le mode.

Les seuls événements autorisés sont :

- pointeur absolu borné à l'écran déclaré ;
- boutons et transitions explicitement énumérés ;
- molette bornée ;
- touches virtuelles figurant dans l'allowlist ;
- aucun texte ou script libre.

Les limites V1 sont conservées comme minimum : vingt événements par lot, vingt
requêtes par seconde, corps de 8 Kio, molette de -3 à 3 et délai borné par événement.
Les événements invalides sont rejetés en totalité, sans exécution partielle
ambiguë. Le contenu des frappes ne figure jamais dans l'audit.

Il n'existe aucune tentative de contourner l'UAC, le secure desktop, l'écran de
connexion, une politique OS ou une confirmation locale.

## 13. Conception ADMIN

ADMIN reste un registre fermé, sans argument libre. Seules les actions suivantes
existent dans V1 :

Lecture seule :

- `GET_SYSTEM_INFO` ;
- `GET_PROCESS_LIST` ;
- `GET_SERVICE_STATUS` ;
- `GET_NETWORK_STATUS` ;
- `GET_DISK_STATUS`.

Fort impact, avec confirmation locale sur B à chaque demande :

- `LOCK_WORKSTATION` ;
- `REQUEST_LOGOFF` ;
- `REQUEST_RESTART` ;
- `REQUEST_SHUTDOWN`.

La confirmation distante doit nommer l'appareil controller, l'action et
l'expiration. Un acquiescement global ou mémorisé n'est pas permis. La fenêtre
proposée reste trente secondes, une seule action à fort impact peut attendre et un
intervalle minimal de trente secondes s'applique. Les lectures restent limitées à
trente par minute et le résultat à 512 Kio.

Le client n'interprète pas le résultat comme une commande. Aucun paramètre ne peut
devenir une ligne de commande, un chemin d'exécutable, un script ou du PowerShell
arbitraire.

## 14. STOP et fin de session

### 14.1 STOP local sur l'appareil contrôlé

Le STOP local de B est suprême. Il :

- termine immédiatement la session côté B ;
- annule capture, entrée et confirmations ADMIN ;
- fait disparaître l'indicateur après nettoyage ;
- invalide toute requête en vol ou ultérieure ;
- retourne, si le canal le permet encore, `REMOTE_STOPPED` signé ;
- ne requiert ni permission ni approbation de A.

Le STOP de A ne remplace jamais ce mécanisme local.

### 14.2 STOP du contrôleur

`stopOmegaSession(sessionId)` envoie une demande sémantique signée au device exact,
puis ferme localement la session et efface ses secrets, même si l'accusé distant
n'arrive pas. Il n'autorise aucune autre action pendant `STOPPING`.

`stopAllOutboundSessions()` est une primitive locale d'urgence : elle tente un STOP
signé et borné pour chaque session, puis ferme immédiatement toutes les sessions
locales. Elle n'est ni un broadcast réseau ni un substitut aux STOP locaux de chaque
hôte.

Perte réseau, expiration, révocation et arrêt du client entraînent le même nettoyage
local. Aucune reconnexion automatique n'est lancée.

## 15. Limites, débits et timeouts proposés

| Surface | Limite de conception |
|---|---|
| Connexion TLS | 5 s |
| Handshake/authentification | 10 s |
| Création de session | 5 par minute et par pair |
| Échecs d'authentification | 5 sur 5 min, puis temporisation locale de 5 min |
| Sessions sortantes actives | 4 maximum par processus, une cible exacte par session |
| Corps handshake/session JSON | 16 Kio maximum |
| Corps VIEW | 4 Kio maximum hors image |
| Image VIEW | 8 Mio, 7680 par dimension, 5 fps, timeout 5 s |
| Corps INTERACTIVE | 8 Kio maximum |
| INTERACTIVE | 20 événements/lot, 20 requêtes/s |
| Exécution événement | timeout 4 s par événement |
| Corps ADMIN | 16 Kio maximum |
| ADMIN lecture | 30/min/session |
| ADMIN fort impact | 1 en attente, intervalle 30 s, confirmation 30 s |
| Résultat ADMIN | 512 Kio maximum, timeout 8 s |
| Dérive d'horloge | ±60 s |
| Session | 15 min maximum, sans renouvellement implicite |

Les limites s'appliquent côté client et côté serveur. Le serveur reste l'autorité en
cas de valeur plus restrictive. Les compteurs ne sont jamais partagés avec
RASSILON, Fabric ou un autre agent.

## 16. Audit sortant

Une table ou un journal V2 distinct utilise une énumération fermée :

- `OUTBOUND_SESSION_REQUESTED` ;
- `OUTBOUND_SESSION_ESTABLISHED` ;
- `OUTBOUND_SESSION_DENIED` ;
- `OUTBOUND_VIEW_STARTED` ;
- `OUTBOUND_INTERACTIVE_STARTED` ;
- `OUTBOUND_ADMIN_REQUESTED` ;
- `OUTBOUND_STOP` ;
- `OUTBOUND_SESSION_EXPIRED` ;
- `OUTBOUND_TLS_FAILURE`.

Chaque entrée peut contenir l'heure, les identifiants publics locaux/distants,
`sessionId`, `operationId`, type d'action, résultat fermé et code d'erreur sûr.

Sont interdits dans l'audit : clé privée, secret/token, nonce brut si sa conservation
n'est pas strictement nécessaire, bundle de session, pixels, image, texte de frappe,
données de presse-papiers, identifiants utilisateur, mot de passe et corps de
réponse sensible. Les hash ne doivent pas permettre de reconstruire un secret à
faible entropie.

## 17. Relation future avec Device Fabric V2

Device Fabric V1 reste inchangé. Sa projection `OMEGA_CLIENT` décrit le sens entrant
et ne doit jamais être détournée pour le sens sortant.

Une phase Device Fabric V2 ultérieure pourra créer un rôle distinct, par exemple
`OMEGA_OUTBOUND_HOST`, et une association :

```text
fabricDeviceId -> omegaDeviceId public
```

Cette association ne reçoit jamais :

- clé publique utilisée comme autorisation implicite ;
- clé privée ;
- certificat privé ;
- endpoint libre ;
- token ou secret de session ;
- nonce ;
- capacité RPC générique.

Fabric peut afficher l'identité publique et un statut dérivé. Toute demande de
connexion doit provenir d'une action utilisateur locale explicite et appeler l'API
OMEGA fermée. Fabric n'est pas une autorité d'authentification et ne peut pas
augmenter la permission. Aucun agent, LLM, voix ou règle autonome ne déclenche un
contrôle.

## 18. UX future

La surface prévue est `Apps > PC > OMEGA`. Elle affiche clairement :

- l'identité et l'empreinte du device cible ;
- l'adresse LAN privée épinglée ;
- l'état réel de connexion ;
- la permission accordée ;
- les modes `VIEW`, `INTERACTIVE`, `ADMIN` ;
- un bouton `STOP` immédiatement accessible.

Elle ne présente jamais une session comme connectée avant authentification réelle.
Elle n'utilise pas les libellés `FULL CONTROL`, `SHELL` ou `TERMINAL`. Les erreurs
d'identité ou de certificat exigent une revalidation distincte, sans bouton de
contournement rapide.

## 19. Modèle de menaces

| Menace | Risque | Mitigations obligatoires |
|---|---|---|
| Homme du milieu | Interception ou modification | TLS strict, CA dédiée, pin SHA-256, identité host signée, aucune première confiance réseau |
| Usurpation d'appareil | Faux hôte ou faux contrôleur | Identités à rôles séparés, pairing bilatéral, signatures applicatives, device exact |
| Remplacement de certificat | Prise de contrôle après rotation hostile | Échec fermé, `TLS_MISMATCH`, aucune mise à jour automatique, revalidation explicite |
| Détournement de session | Usage d'un `sessionId` volé | `sessionId` non-bearer, signature de chaque opération, session courte, secrets mémoire |
| Rejeu | Réexécution d'une action valide | Horodatage borné, nonce 192 bits, `requestId`/`operationId` uniques, cache anti-rejeu |
| Mauvaise cible | Action envoyée au mauvais poste | adresse et `remoteDeviceId` épinglés, aucune redirection, une cible par session |
| Mauvais résultat | Réponse d'un autre poste/opération | signature host et liaison session/device/request/opération/hash |
| Élévation de permission | VIEW transformé en ADMIN | permission décidée par B, vérifiée à chaque appel, API et routes séparées |
| Élévation de mode | événement interactif injecté dans VIEW | opérations fermées, permission et état contrôlés côté serveur |
| Appareil révoqué ou stale | Session conservée après retrait | vérification à chaque requête, révocation immédiate, durée 15 min |
| Frame malveillante/surdimensionnée | mémoire, parser, déni de service | limite 8 Mio, hash, PNG magic, dimensions, cadence et timeout |
| Flood input/admin | déni de service ou actions multiples | quotas client/serveur, lots bornés, une confirmation forte en attente |
| Confused deputy | Fabric/agent emprunte l'autorité OMEGA | aucune clé ou session partagée, appel sémantique, geste utilisateur obligatoire |
| Token inter-agent | réutilisation RASSILON/Fabric/agent | aucun token transversal, namespaces et domaines cryptographiques séparés |
| Abus de reconnexion | maintien furtif du contrôle | aucune reconnexion, nouvelle action utilisateur et nouvelle session requises |
| Tromperie UI | fausse cible ou faux état | empreinte/cible visibles, `CONNECTED` après handshake seulement, STOP permanent |
| Échec d'indicateur | contrôle invisible sur B | activation V2 fail-closed tant que l'indicateur n'est pas confirmé |
| Downgrade HTTP | perte de confidentialité/authenticité | aucune URL HTTP, aucun fallback, TLS obligatoire avant protocole |
| Réseau public | exposition hors LAN attendu | profil Private obligatoire et RFC1918 exact, Public/Unknown refusé |
| Injection de commande | exécution arbitraire | registre fermé, aucun argument libre, `shell:false`, pas de RPC générique |
| UAC/secure desktop | contournement de consentement OS | aucun bypass, refus explicite des surfaces protégées |
| Persistance cachée | reprise de contrôle | aucune session persistée, aucun autoconnect, secrets mémoire effacés |

## 20. Plan de tests de Phase 2 et suivantes

### 20.1 Identité et confiance

- génération et stockage DPAPI séparés des identités controller/host ;
- absence de clé privée dans SQLite, logs, Fabric et RASSILON ;
- pairing A vers B sans création de B vers A ;
- ancien device V1 non reconnu automatiquement comme pair V2 ;
- révocation avant et pendant une session ;
- rotation de certificat ou clé refusée sans revalidation ;
- impossibilité d'utiliser une signature host comme signature controller.

### 20.2 Réseau et TLS

- profil Private + IPv4 RFC1918 exact accepté ;
- profils Public et Unknown refusés ;
- IP publique, DNS, redirect, proxy et mauvaise IP refusés ;
- certificat correct et pin correct acceptés ;
- certificat valide mais mauvais pin refusé ;
- pin correct mais identité host incorrecte refusée ;
- certificat expiré, mauvais SAN ou chaîne invalide refusé ;
- vérification qu'aucun chemin HTTP n'est tenté ;
- aucune modification du pare-feu ou du profil réseau.

### 20.3 Session et anti-rejeu

- `CONNECTED` absent avant fin du handshake ;
- durée de quinze minutes au plus ;
- signature altérée, mauvais body hash, méthode ou path refusés ;
- timestamp hors fenêtre refusé ;
- nonce, `requestId` ou `operationId` rejoué refusé ;
- `localDeviceId`, `remoteDeviceId` ou `sessionId` incorrect refusé ;
- réponse signée pour un autre device/session/request refusée ;
- perte réseau terminant les modes sans reconnexion ;
- arrêt de processus ne restaurant aucune session.

### 20.4 VIEW

- démarrage avec permission correcte et indicateur visible ;
- VIEW refusé si l'indicateur ne démarre pas ;
- image valide en mémoire, jamais persistée automatiquement ;
- frame supérieure à 8 Mio, dimension excessive, PNG invalide ou hash faux refusé ;
- cadence et timeout appliqués ;
- STOP local B préemptant immédiatement le flux.

### 20.5 INTERACTIVE

- acceptation locale et permission exigées ;
- pointeur, boutons, molette et touches allowlistés ;
- coordonnées, touche, lot ou taille invalides refusés ;
- limite de débit appliquée sans exécution partielle ;
- aucune frappe dans l'audit ;
- UAC et secure desktop non contournés ;
- STOP local B dominant le STOP et l'état de A.

### 20.6 ADMIN

- seules les neuf actions exactes sont acceptées ;
- tout argument, nom inconnu ou payload opaque est refusé ;
- cinq lectures fonctionnent sous quota ;
- quatre actions fortes exigent une confirmation locale unique ;
- refus, expiration et STOP annulent l'action ;
- une seule confirmation en attente et délai de trente secondes ;
- résultat supérieur à 512 Kio ou hors timeout refusé ;
- absence de shell, PowerShell et exécutable arbitraires.

### 20.7 STOP et audit

- STOP du contrôleur ferme sa session exacte ;
- `stopAllOutboundSessions()` nettoie toutes les sessions locales sans broadcast ;
- STOP local distant a toujours priorité ;
- révocation et expiration déclenchent un arrêt ;
- événements d'audit fermés présents ;
- aucun secret, pixel ou texte de frappe dans l'audit.

## 21. Harness TLS à deux processus

Le test d'intégration reproductible utilise deux processus isolés :

```text
Processus A                              Processus B
client sortant réel                     serveur V2 compatible OMEGA
DB/secret store/identités A             DB/secret store/identités B
certificat public B épinglé             listener TLS loopback de test
adaptateurs client                      adaptateurs capture/input/admin injectés
```

Le loopback TLS est autorisé uniquement dans ce harness explicite. Les deux
processus possèdent des répertoires temporaires, bases, certificats et identités
séparés. Aucune identité globale de la machine de développement ne doit être
réutilisée.

Le harness doit valider la pile réelle transport + TLS + protocole et injecter des
adaptateurs inoffensifs pour éviter une action Windows réelle. Il couvre handshake,
VIEW, INTERACTIVE, ADMIN, confirmation, STOP, révocation, expiration, replay,
mauvaise cible, mauvais résultat, frame malveillante, quotas et perte réseau.

Un essai sur un second PC physique est utile pour la certification finale, mais
reste optionnel pendant les phases de construction. Son statut à cette phase est
`NOT_RUN`.

## 22. Roadmap contrôlée

1. **Phase 2 — transport, TLS, identité, pairing, session et authentification** :
   modules V2 additionnels, harness deux processus et invariants de séparation.
2. **Phase 3 — VIEW** : flux signé, mémoire bornée, indicateur fail-closed et STOP.
3. **Phase 4 — INTERACTIVE** : événements typés, consentement local et quotas.
4. **Phase 5 — ADMIN, STOP et hardening** : allowlist exacte, confirmations,
   révocation, erreurs et audit.
5. **Phase 6 — UX, certification et gel** : surface Apps > PC > OMEGA, tests
   complets, documentation et freeze.
6. **Device Fabric V2 ultérieur** : projection publique et appels fermés, sans
   héritage d'autorité.

Chaque phase doit préserver OMEGA V1 et peut être arrêtée indépendamment. Aucun
élément de Phase 2 ne doit être réalisé dans la présente mission.

## 23. Invariants de sécurité

| Invariant | Valeur exigée |
|---|---:|
| Confiance inverse automatique | 0 |
| Clé privée partagée | 0 |
| Session/token partagé | 0 |
| Réutilisation d'auth inter-agent | 0 |
| Fallback HTTP | 0 |
| Cible de secours automatique | 0 |
| Reconnexion automatique | 0 |
| Contrôle autonome | 0 |
| Contrôle déclenché par voix | 0 |
| Contrôle déclenché par agent/LLM | 0 |
| Élévation de confiance par Device Fabric | 0 |
| Shell distant | 0 |
| Terminal distant | 0 |
| Code arbitraire | 0 |
| Exécutable arbitraire | 0 |
| PowerShell arbitraire | 0 |
| Transfert de fichiers | 0 |
| Presse-papiers | 0 |
| Accès aux identifiants | 0 |
| Persistance cachée | 0 |
| Contournement UAC/secure desktop | 0 |
| Relais cloud | 0 |
| Exposition Internet conçue | 0 |
| UPnP | 0 |
| STUN/TURN | 0 |
| Tunnel inverse | 0 |
| Modification automatique du pare-feu | 0 |

## 24. Limites connues avant Phase 2

- Le contrôle de pairing/session V1 est loopback-only. Phase 2 devra donc ajouter
  un adaptateur serveur V2 authentifié en plus du client ; un wrapper client seul
  ne peut pas produire un flux LAN complet.
- Aucune identité OMEGA locale de production n'est actuellement provisionnée pour
  les rôles controller et host.
- La chaîne de nonce V1 n'offre pas la liaison complète de requête exigée et peut se
  désynchroniser après une erreur métier ; elle ne sera pas réutilisée comme
  anti-rejeu V2.
- Le certificat auto-signé actuel peut ne pas posséder le SAN IP nécessaire. Sa
  compatibilité devra être vérifiée et, si nécessaire, une réémission explicite et
  une nouvelle validation seront requises.
- La première cible est Windows et IPv4 RFC1918 privé. IPv6, autres OS, découverte
  et réseaux routés ne sont pas certifiés.
- L'indicateur V1 peut être best-effort dans certains chemins. L'adaptateur V2 devra
  rendre sa confirmation bloquante avant tout mode distant.
- Le listener principal et son exposition LAN préexistent. V2 ne doit ajouter que
  des routes explicitement activées et protégées sur ce listener, sans élargir les
  routes globales.
- Aucun test réseau, harness, second PC ou changement de code n'a été exécuté en
  Phase 1. Le test sur second PC est `NOT_RUN`.

## 25. Conclusion

L'architecture est prête pour une Phase 2 strictement additive. Elle corrige les
écarts structurels identifiés — absence de client sortant et d'identité locale,
pairing V1 non exposé au LAN, anti-rejeu insuffisamment lié et certificat à vérifier
— sans transformer ni affaiblir OMEGA V1.

La condition d'entrée en Phase 2 est de conserver ces frontières : identité à rôles
séparés, confiance directionnelle, TLS strict et épinglé, cible exacte, session
éphémère, signatures de bout en bout, opérations sémantiques fermées, consentement
visible de l'hôte et STOP local suprême.

**Verdict : READY_FOR_PHASE_2**
