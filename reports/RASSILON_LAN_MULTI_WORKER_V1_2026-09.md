# DOCTEUR RASSILON — SECURE LAN MULTI-MACHINE WORKERS V1 (PHASE 4)

Date : 2026-09-24  
Verdict : **PASS** pour le périmètre Phase 4, avec test physique sur un second appareil **NOT_RUN** conformément à la mission.

## 1. Périmètre et baseline

Phase 4 ajoute un transport multi-machine strictement limité au LAN IPv4 privé et explicitement activé. Le mode mono-machine des phases précédentes reste disponible et le listener LAN est OFF par défaut.

Avant modification, `git status --short` et `git diff --stat` ont été relevés. Les trois rapports certifiés ont été lus entièrement, puis le code RASSILON réel a été audité. Le dépôt était déjà non propre à cause des travaux RASSILON Phases 1 à 3 et de répertoires externes sans rapport ; ces éléments ont été préservés. OMEGA et MAÎTRE n'ont pas été modifiés.

Le plafond fonctionnel reste fermé à deux types sémantiques :

- `SAFE_CPU_TASK`
- `EMBEDDING_BATCH`

Il n'existe aucune route ou permission de shell, terminal, commande arbitraire, exécutable arbitraire, code arbitraire, transfert de fichier, téléchargement de modèle ou accès générique au système de fichiers.

## 2. Threat model

Les adversaires considérés sont : un hôte non approuvé présent sur le même LAN, un appareil anciennement approuvé puis révoqué, le rejeu d'une requête ou d'un pairing, l'usurpation d'un `deviceId`, la mutation d'un job ou d'un résultat, un certificat inattendu, un controller tentant d'augmenter ses droits, et un payload hostile cherchant une primitive d'exécution générique.

Les IP privées ne constituent jamais une preuve d'identité. Elles ne sont qu'une ACL réseau supplémentaire. L'autorisation effective demande simultanément : TLS validé et épinglé côté controller, appareil pairé non révoqué, session valide, signature Ed25519 de chaque requête, horodatage borné, nonce inédit, permission par executor, signature du job, cible exacte, schéma fermé et admission par la policy locale du worker.

Le système fail closed pour une identité inconnue, une session absente/révoquée/expirée, un certificat invalide, une signature invalide, une horloge hors fenêtre, un nonce déjà vu, une permission absente, un modèle indisponible, une ressource inconnue ou une configuration TLS invalide.

## 3. Architecture réseau et isolation

Le serveur Cortex historique conserve son listener et son comportement local-only. Il n'est jamais rebindié sur le LAN par RASSILON.

Le LAN RASSILON utilise un listener HTTPS dédié qui monte uniquement l'application Hono `rassilon-lan`. Ce choix est volontaire : réutiliser le listener Cortex aurait exposé toutes les autres routes par effet secondaire. Le listener dédié n'expose que :

- `POST /rassilon-lan/pair/request`
- `POST /rassilon-lan/pair/complete`
- `GET /rassilon-lan/status`
- `POST /rassilon-lan/heartbeat`
- `POST /rassilon-lan/jobs`
- `GET /rassilon-lan/jobs/:id`
- `POST /rassilon-lan/jobs/:id/cancel`

Toutes les routes Cortex `/api/*`, ainsi que `/shell`, `/exec`, `/run`, `/script`, `/terminal`, `/cmd`, `/powershell`, `/files`, `/upload` et `/download`, sont absentes de cette application. Un test critique vérifie notamment OMEGA, MAÎTRE et Local AI ; la séparation architecturale vaut également pour Cyber, Observateur, Voice, Code Intelligence et toutes les autres APIs Cortex.

Le bind de production exige une adresse RFC1918 IPv4 précise. `0.0.0.0`, les adresses publiques, le loopback et IPv6 sont refusés. Le loopback est autorisé uniquement par injection explicite dans le harness de test. IPv6 LAN est volontairement non supporté en V1 afin d'éviter un fail-open. Il n'y a ni discovery, ni broadcast, ni mDNS, ni UPnP, ni NAT traversal, ni STUN/TURN, ni tunnel, ni relay et ni proxy générique.

Le profil réseau doit être déclaré `Private`. Si le profil est inconnu, l'activation est refusée sauf override local explicite. Aucun changement de pare-feu, route, DNS, antivirus ou magasin global de certificats n'est effectué.

## 4. TLS

Tout transport distant est HTTPS, avec TLS 1.2 minimum. La clé et le certificat sont lus depuis des chemins locaux configurés, puis contrôlés avant ouverture du listener : présence, parsing, période de validité et correspondance clé privée/certificat. Une erreur refuse le démarrage du LAN, sans fallback HTTP.

Le controller utilise le certificat PEM approuvé comme CA locale, conserve `rejectUnauthorized: true`, applique la vérification de nom standard puis compare `fingerprint256` au pin enregistré. Le pairing vérifie également que le certificat fourni correspond au fingerprint confirmé. Une identité TLS inattendue est donc refusée avant l'échange applicatif.

Les timeouts de handshake, headers, keep-alive, requête et appel controller sont bornés. Les réponses sont bornées à 600 KiB côté transport ; l'enveloppe résultat RASSILON a sa propre limite plus stricte de 512 KiB.

## 5. Identités, trust et pairing

Chaque appareil dispose de sa propre identité RASSILON Ed25519, sous le namespace secret `rassilon-device-key:<deviceId>`. La clé privée est protégée par le mécanisme local existant et n'est jamais stockée en clair dans SQLite. Les tables ne contiennent que les clés publiques et fingerprints. Aucune identité OMEGA ou clé MAÎTRE n'est réutilisée.

Le registre `rassilon_devices` conserve l'identité publique, le rôle (`CONTROLLER`, `WORKER` ou `BOTH`), le jeu de permissions, le endpoint épinglé, la présence et la révocation. Les nouvelles tables restent toutes dans le namespace RASSILON : local device, configuration LAN, devices, pairings, sessions entrantes, sessions sortantes, nonces et remote jobs.

Pairing worker :

1. Une action locale crée un identifiant, un code à 8 chiffres, un nonce worker et une expiration de 2 minutes maximum.
2. Seul le hash SHA-256 du code lié au `pairingId` est persisté.
3. Le controller présente sa clé publique, son fingerprint, un nonce, les permissions demandées et une preuve Ed25519 couvrant les deux challenges et les deux identités attendues.
4. Le worker vérifie cette preuve et renvoie sa propre preuve Ed25519.
5. Le trust reste en attente jusqu'à une confirmation locale explicite. Le worker ne peut accorder qu'un sous-ensemble des permissions demandées.
6. Le controller signe la complétion ; le worker crée alors une session de 15 minutes et signe la réponse.
7. Le token de pairing devient `USED`. Les états expiré, annulé, refusé ou déjà utilisé ne peuvent pas être rejoués.

Le controller enregistre le worker seulement après validation de sa preuve signée. Les pairings sortants en attente restent en mémoire ; un redémarrage les invalide donc de manière sûre. La rotation V1 est manuelle : révoquer l'ancienne identité, générer/remplacer l'identité locale, puis pairer à nouveau. Une ancienne identité révoquée ne redevient pas valide automatiquement.

## 6. Permissions et autorité locale

Les seules permissions réseau sont :

| Job | Permission requise |
|---|---|
| `SAFE_CPU_TASK` | `RASSILON_COMPUTE_SAFE` |
| `EMBEDDING_BATCH` | `RASSILON_EMBEDDING` |

Un appareil pairé ne reçoit aucun droit implicite. Le rôle controller est requis pour soumettre. Le type doit aussi figurer dans `acceptedJobTypes` du worker local ; une activation LAN avec liste vide est refusée.

Il n'existe aucune route distante pour activer RASSILON, activer le LAN, changer les quotas, modifier les types acceptés, désactiver les gardes, reprendre après STOP ou pousser un modèle. Les routes d'administration restent sur l'API locale protégée par les contrôles loopback/origin existants.

Le budget effectif est le minimum entre la demande du job, la policy controller et les capacités annoncées du worker. Le worker répète ensuite ses propres contrôles d'admission : sa policy locale reste l'autorité finale.

## 7. Authentification des requêtes et anti-replay

Chaque requête sensible lie cryptographiquement : `deviceId`, `sessionId`, timestamp, nonce, méthode HTTP, chemin exact et SHA-256 du body. La signature Ed25519 est vérifiée avec la clé du registre de trust. La session doit être non révoquée, non expirée et attachée au même appareil.

La fenêtre d'horloge est de ±60 secondes. Chaque nonce est persisté avec une contrainte d'unicité par session ; une répétition est refusée. Une mutation du body, de la méthode, du chemin, de l'appareil, de la session ou de l'heure casse la preuve.

Les limites mémoire/process sont : pairing 8/minute/source, authentification 60/minute/source, soumissions 20/minute/appareil et polling 120/minute/appareil. Le body LAN est limité à 256 KiB.

## 8. Jobs, scheduler et capacités

Un job distant conserve la signature sémantique existante en plus de l'authentification de transport. Le schéma fermé comprend `targetDeviceId`, qui fait partie des octets signés. Le worker exige une égalité exacte avec son identité locale et exige également que `issuerId` égale l'identité du transport. Un job signé pour Worker A ne peut donc pas être transposé sur Worker B.

Le scheduler controller est déterministe. Il filtre les appareils online, non révoqués, ayant un rôle worker, la permission, l'executor, le modèle éventuel et les ressources. Il trie ensuite par profondeur de queue, RAM disponible décroissante puis `deviceId` lexical. La présence devient `STALE` après 30 secondes et `OFFLINE` après 90 secondes. Un échec de dispatch marque le job `LOST`; il n'y a aucune migration. Toute relance doit créer un nouveau UUID.

Les capacités annoncées sont limitées à l'identifiant RASSILON, l'état, les executors sûrs acceptés, les IDs de modèles allowlistés réellement installés, les budgets CPU/RAM disponibles selon policy, GPU/VRAM seulement si une mesure fiable existe, un état batterie résumé et la profondeur de queue. Aucun username, hostname, MAC, numéro de série, chemin home, variable d'environnement, document, processus, logiciel sans rapport, credential ou historique IP n'est annoncé.

`EMBEDDING_BATCH` distant exige simultanément la permission, l'acceptation locale du type, le modèle allowlisté installé et les ressources. Aucun modèle n'est téléchargé ou poussé. Le chemin réel Ollama sur une seconde machine n'a pas été exécuté faute de second appareil et d'instance Ollama disponible ; les couches schéma, permission, scheduler et executor injecté sont testées.

## 9. Résultats authentifiés

Le worker produit une enveloppe structurée bornée contenant `jobId`, `workerId`, état, sortie sûre, métriques bornées, raison d'erreur, timestamp de fin, hash SHA-256 et signature Ed25519. Le controller vérifie le hash, la signature et le `workerId` attendu avant persistance.

Les nombres non finis, profondeurs excessives, tableaux ou chaînes excessifs, réponses au-delà de 512 KiB et champs interdits tels que stdout/stderr arbitraires, environnement, credentials ou dumps de fichiers sont refusés.

## 10. STOP, révocation et crash recovery

Le STOP local est prioritaire : il refuse les nouvelles soumissions, annule la queue, tente l'annulation du job actif, révoque les sessions entrantes et sortantes, désactive la configuration LAN persistée et ferme le listener avant de répondre à la route locale. Il émet `LOCAL_STOP`. Aucun controller ne possède de route permettant d'annuler ce STOP ou de réactiver le worker.

Le controller distant peut seulement annuler l'un de ses propres jobs ; l'opération émet `REMOTE_STOP` puis `REMOTE_JOB_CANCELLED`. La révocation d'un appareil révoque ses sessions. Les requêtes futures échouent. Un worker révoqué n'est plus sélectionné par le scheduler.

La restauration du listener au boot n'est possible que si l'activation LAN avait été persistée explicitement, si le worker est lui-même encore activé et si TLS reste valide. Sinon le listener reste fermé. Les jobs locaux `RUNNING` d'un crash deviennent `INTERRUPTED`, les jobs en queue sont annulés et rien ne reprend silencieusement.

## 11. Audit

L'enum d'audit fermé comprend les événements requis : `PAIRING_STARTED`, `PAIRING_SUCCEEDED`, `PAIRING_FAILED`, `DEVICE_REVOKED`, `SESSION_CREATED`, `SESSION_REJECTED`, `REMOTE_JOB_RECEIVED`, `REMOTE_JOB_ACCEPTED`, `REMOTE_JOB_REJECTED`, `REMOTE_JOB_STARTED`, `REMOTE_JOB_COMPLETED`, `REMOTE_JOB_FAILED`, `REMOTE_JOB_CANCELLED`, `REMOTE_STOP`, `LOCAL_STOP`, plus `LAN_ENABLED` et `LAN_DISABLED`.

Les résumés sont bornés. Ils ne contiennent ni secrets, ni clés privées, ni textes complets d'embedding, ni vecteurs complets.

## 12. Tests et preuves

### Suite RASSILON finale

Commande : `node --test test-rassilon-*.mjs`

- tests : 241
- pass : 240
- fail : 0
- cancelled : 0
- skipped : 1

Le skip est le smoke test Ollama réel : aucune instance locale avec modèle allowlisté n'était disponible. Le chemin `EMBEDDING_BATCH` est néanmoins couvert avec provider injecté, y compris succès, indisponibilité, sortie invalide, replay, signature incorrecte et queue mixte.

Les tests Phase 4 couvrent notamment : pairing mutuel et confirmation locale, expiration/annulation/seconde utilisation, mauvaises preuves et challenges mutés, permissions, authentification de requête, nonce rejoué, dérive d'horloge, body muté, mauvais appareil/signature, révocation, ACL RFC1918, target binding, sélection déterministe, résultat signé et mutations, limites de body/rate, et isolation de la surface LAN.

### Régressions pertinentes

La sélection Strict Local, Local AI, SQLite/DB, sécurité routes/origin, OMEGA, MAÎTRE et server networking passe à **135/135**, sans fail ni skip. OMEGA et MAÎTRE restent inchangés.

### Full backend

L'ancien `test-regression-api.mjs` démarre son serveur isolé mais conserve un handle ouvert ; avec `--test-timeout=20000` il termine en cancelled sans assertion en échec. Il a été exclu de la méthode stable afin de ne pas bloquer indéfiniment la suite.

Suite stable restante :

- tests : 2434
- pass : 2427
- fail : 3
- cancelled : 0
- skipped : 4

Les trois échecs sont historiques et hors RASSILON : frontend `localhost:5173` absent dans `test-find-eval.mjs`, API `mock.module` indisponible dans `test-video-pipeline.mjs`, et chemin vidéo doublé/ENOENT dans `test-video-manual.mjs`. Aucun nouveau fail RASSILON ou régression pertinente n'a été observé.

### Compilation et démarrage

- `npx tsc --noEmit` : PASS
- `npm run build` : PASS
- boot serveur local-only sur `127.0.0.1:38991` avec DB temporaire : PASS
- `GET /api/rassilon/status` : HTTP 200, `state=DISABLED`, `enabled=false`
- listener TLS loopback contrôlé : `LISTENING`, requête HTTPS reçue, tentative HTTP clair coupée avec `ECONNRESET`, STOP vers `DISABLED`
- aucun bind public, aucune modification réseau et aucun certificat installé globalement

Le harness TLS a utilisé un certificat éphémère dans `.tmp`, supprimé après test. Le test réel sur une seconde machine est **NOT_RUN**, comme demandé en l'absence d'appareil explicitement fourni.

### Audit statique

`test-rassilon-static-audit.mjs` passe pour tous les modules et routes RASSILON. La recherche manuelle demandée n'a trouvé aucun appel/code correspondant à shell, `exec`, `eval`, `new Function`, `cmd.exe`, PowerShell command, child process direct, téléchargement, installateur, persistance, modification firewall, UPnP, STUN/TURN ou reverse tunnel. L'unique match textuel est un commentaire `NO MODEL AUTO-DOWNLOAD` dans l'executor embedding.

`git diff --check` passe. Les patterns `.gitignore` existants couvrent `certs/`, `.tmp/`, `data-test-*/`, DB runtime et `*.log`, sans ignorer le code, les tests ou ce rapport.

## 13. Limites connues

- LAN V1 est IPv4 RFC1918 uniquement ; IPv6 LAN est refusé.
- Le profil Windows n'est pas détecté automatiquement : `Private` doit être fourni par l'action locale, et un profil inconnu demande un override local explicite.
- Le certificat et la rotation d'identité sont provisionnés/manuels ; aucun PKI ou renouvellement automatique n'est ajouté.
- La session courte expire après 15 minutes ; V1 repaire manuellement au lieu d'ajouter un protocole de refresh complexe.
- Le cap CPU reste un soft guard, la RAM reste mesurée au niveau du processus Cortex, et Ollama externe n'est pas hard-limité.
- L'annulation embedding reste coopérative entre les textes ; un appel Ollama déjà parti ne peut pas être préempté proprement.
- Aucun test physique second-device n'a été exécuté. Le transport a été vérifié par composants, mocks et harness TLS loopback.
- Aucun firewall n'est ouvert automatiquement ; le déploiement réel devra être configuré explicitement par l'utilisateur.

## 14. Checkpoint sécurité critique

| Propriété interdite | Valeur |
|---|---:|
| Internet exposure | 0 |
| Other Cortex APIs exposed by RASSILON LAN | 0 |
| Remote shell / arbitrary code / arbitrary executable | 0 |
| Remote filesystem / file transfer | 0 |
| Remote enable / quota escalation / safety disable | 0 |
| Model push / auto-download | 0 |
| Cloud relay / proxy / tunnel | 0 |
| Firewall auto-change | 0 |

Les points critiques de la règle de verdict sont démontrés par le code, les tests automatisés et le harness TLS : pairing explicite avec authentification mutuelle, TLS obligatoire, anti-replay, permissions par device, autorité locale, absence d'exécution générique, isolation du listener, STOP/révocation, zéro fail RASSILON et zéro nouvelle régression pertinente.
