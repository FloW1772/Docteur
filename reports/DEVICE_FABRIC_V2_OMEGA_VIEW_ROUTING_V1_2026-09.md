# Device Fabric V2 — OMEGA V2 VIEW routing V1

Date de validation : 2026-09-28  
Périmètre : Phase 3, `OMEGA_V2_OUTBOUND` exact vers OMEGA V2 VIEW uniquement.

## Verdict

**PASS.** Device Fabric déclenche une session VIEW uniquement après une action utilisateur explicite, vers l'hôte OMEGA V2 nommé par le lien exact. Aucun fallback, retargeting, scheduler, routeur générique, transport de frame Fabric, canal INTERACTIVE ou ADMIN n'a été ajouté. Les modules OMEGA V2 certifiés restent inchangés.

## Implémentation du routage exact

- `device-fabric-omega-v2-routing.js` est un orchestrateur fermé exposant uniquement `startViewForFabricDevice`, `getViewStateForFabricDevice`, `stopViewForFabricDevice` et `stopSessionForFabricDevice`.
- START exige le quintuplet vu par l'UI : `fabricDeviceId`, `linkId`, `linkVersion`, `omegaV2HostId` et fingerprint lié, plus un `screenIndex` borné.
- La résolution lit le lien `OMEGA_V2_OUTBOUND` et la confiance OMEGA courante. L'identité OMEGA V1 n'est jamais acceptée comme cible OMEGA V2.
- Aucun sélecteur de cible, liste de candidats ou chemin de repli n'existe. Un hôte A indisponible échoue sur A même si B est joignable.
- La session rendue doit confirmer le même `remoteOmegaDeviceId` et la permission `VIEW`; toute autre cible est rejetée et la session nouvellement créée est arrêtée.

## Revalidation TOCTOU, lien et fingerprint

START compare d'abord les valeurs fournies par l'UI à une résolution fraîche, puis appelle une seconde fois le résolveur immédiatement avant l'unique connexion. Les deux instantanés doivent être identiques sur le device Fabric, le link ID, la version, le host ID et le fingerprint. Le résolveur relit également la confiance actuelle et refuse une confiance absente, révoquée ou dont le fingerprint ne correspond plus. Un unlink/remap/relink entre les deux lectures retourne `OMEGA_V2_LINK_CHANGED`, avec zéro connexion et zéro VIEW.

## Déclenchement utilisateur et status

- Le seul point d'entrée de connexion est le bouton **VOIR**, relié à un POST dédié.
- Le chargement de page, l'inventaire, les rafraîchissements et le polling n'appellent jamais START.
- `GET .../view/status` ne fait qu'interroger le binding en mémoire, la session OMEGA déjà connue et la résolution locale courante : zéro connexion, zéro création de session, zéro VIEW.
- `AVAILABLE = UNKNOWN` n'est pas transformé en disponibilité supposée. Si VIEW est autorisé et le lien valide, l'utilisateur peut tenter explicitement la connexion; seule une session réelle fournit ensuite une preuve de disponibilité.

## Propriété de session et intégration VIEW

Fabric conserve uniquement, en mémoire du processus, les identifiants publics opaques nécessaires à l'orchestration (`sessionId`, `streamId` et binding exact). Il ne persiste ni session active, ni clé privée, ni jeton, ni secret, ni approval. Après redémarrage, Fabric n'invente aucune session antérieure.

La connexion, le trust, TLS, le pinning, l'authentification mutuelle, les permissions, l'expiration, la révocation et les limites VIEW restent exécutés par les API OMEGA V2 existantes. Les frames PNG authentifiées sont lues directement par le client via l'endpoint OMEGA certifié; elles ne passent pas dans les routes Fabric, ne sont ni copiées, ni réencodées, ni journalisées, ni persistées par Fabric.

Le panneau Fabric est volontairement VIEW-only. Il valide le MIME et les dimensions décodées, tire au plus une frame toutes les 500 ms, désactive les événements d'entrée sur l'image, bloque presse-papiers et drag/drop, et ne contient aucun contrôle INTERACTIVE ou ADMIN.

## STOP, erreurs distantes et changement de lien

- STOP VIEW réutilise la primitive OMEGA V2 certifiée et conserve la session si elle reste connectée.
- STOP SESSION réutilise la primitive OMEGA V2 certifiée, puis oublie le binding Fabric en mémoire.
- Un STOP distant, une expiration ou une coupure réseau est reflété comme état arrêté/déconnecté sans reconnexion automatique.
- Si le lien change pendant une VIEW, la session reste propriété d'OMEGA. Le status indique `linkChanged`; aucune nouvelle opération n'est redirigée vers le nouveau lien et le STOP de la session déjà détenue vise son session ID exact.

## Routes et garde-fous

Routes ajoutées :

- `POST /api/device-fabric/devices/:id/omega-v2/view/start`
- `GET /api/device-fabric/devices/:id/omega-v2/view/status`
- `POST /api/device-fabric/devices/:id/omega-v2/view/stop`
- `POST /api/device-fabric/devices/:id/omega-v2/session/stop`

Elles réutilisent les gardes loopback/origin, la limite de body JSON et la validation stricte du schéma. START est limité à 10 tentatives/minute/device; STOP VIEW et STOP SESSION à 30/minute/device. Les erreurs exposées sont des codes sûrs normalisés. Aucune route `/interactive`, `/input`, `/mouse`, `/keyboard`, `/admin`, `/execute`, `/command`, `/shell`, `/rpc` ou `/raw` n'a été ajoutée.

## Audit

L'audit Fabric contient uniquement l'orchestration :

- `FABRIC_OMEGA_V2_VIEW_REQUESTED`
- `FABRIC_OMEGA_V2_VIEW_STARTED`
- `FABRIC_OMEGA_V2_VIEW_FAILED`
- `FABRIC_OMEGA_V2_VIEW_STOPPED`

Les champs sont limités au device Fabric, host OMEGA V2, raison sûre et timestamp. Les audits OMEGA restent la source de vérité sécurité/session/action. Aucun octet de frame, token, secret ou clé privée n'est journalisé.

## Preuves exact-target et TLS

Le harness réel lance deux hôtes OMEGA séparés A et B, avec identités/états SQLite séparés et TLS réel. Fabric A est lié à A, Fabric B à B. START A crée une session VIEW authentifiée sur A, récupère une frame PNG signée, puis STOP VIEW et STOP SESSION réussissent. La DB de B contient zéro session entrante. Après arrêt de A, B reste disponible; une nouvelle tentative sur Fabric A échoue sur A et B reste à zéro session. Résultat : **1/1 PASS**.

Les tests unitaires couvrent aussi : mauvaise cible retournée, lien stale, fingerprint changé, révocation, TOCTOU version 1→2, absence de fallback, status local, STOP exact, limites, schémas et audits sûrs.

## Tests navigateur

Harness Device Fabric étendu : **117/117 PASS**. Il couvre notamment le clic explicite, `AVAILABLE UNKNOWN`, affichage de frame, preuve de disponibilité après session, STOP VIEW, STOP SESSION, STOP distant, drop réseau, expiration, révocation, lien stale, mauvais device Fabric/OMEGA et absence d'entrée distante pour clic, clavier, molette et drag/drop. Les 100 assertions Phase 2 restent incluses et vertes.

## Régressions et validations

| Validation | Résultat |
|---|---:|
| Device Fabric complet | 146/146 PASS |
| Migration Fabric | 3/3 PASS |
| Audit statique Phase 3 | 21/21 PASS |
| Browser Device Fabric | 117/117 PASS |
| Harness TLS deux cibles | 1/1 PASS |
| OMEGA V2 | 77/77 PASS |
| OMEGA V1 | 224/227, 0 fail, 3 skips historiques |
| RASSILON | 252/253, 0 fail, 1 skip Ollama historique |
| TypeScript `tsc --noEmit` | PASS |
| Build | PASS |
| Boot isolé | PASS (3/3 contrôles) |
| Diff des fichiers OMEGA V2 gelés | 0 fichier |

Campagne backend globale : **2662/2669**, 4 skips historiques, 3 échecs environnementaux, **0 échec NEW**. Les trois échecs sont hors changements Phase 3 : `test-find-eval.mjs` faute de serveur frontend sur `localhost:5173`, et deux détections Windows de port sous concurrence (`test-port-preflight.mjs`). Le fichier port-preflight est inchangé; son rejeu isolé donne 7/8 avec la socket enfant signalée libre par l'environnement. Aucun test Device Fabric, OMEGA ou RASSILON n'échoue.

## Audit secrets, artefacts et gitignore

Le scan des changements runtime Fabric trouve zéro clé privée OMEGA, zéro token, zéro secret de session, zéro approval et zéro écriture de frame. Le harness crée uniquement un certificat et une clé de test éphémères sous `os.tmpdir()`, avec suppression récursive enregistrée en teardown. Les règles Git ignorent certificats, DB de test, frame dumps/captures, logs et états temporaires. Sources, tests et ce rapport sont trackables.

## Fichiers Phase 3

- `cortex-server/src/lib/device-fabric-omega-v2-routing.js`
- `cortex-server/src/lib/sqlite.js`
- `cortex-server/src/routes/device-fabric.js`
- `cortex-server/test-device-fabric-migration.mjs`
- `cortex-server/test-device-fabric-omega-v2-route.mjs`
- `cortex-server/test-device-fabric-omega-v2-view.mjs`
- `cortex-server/test-device-fabric-omega-v2-view-harness.mjs`
- `cortex-server/test-device-fabric-static-audit.mjs`
- `scripts/test-device-fabric-browser.mjs`
- `src/components/settings/DeviceFabricSettingsTab.tsx`
- `src/components/settings/FabricOmegaV2ViewPanel.tsx`
- `src/lib/cortex/client.ts`
- `reports/DEVICE_FABRIC_V2_OMEGA_VIEW_ROUTING_V1_2026-09.md`

## Limites connues

- Aucun second appareil physique n'a été sollicité : `NOT_RUN`, conformément à la mission.
- Le binding de session Fabric est volontairement mémoire-only et disparaît au redémarrage; OMEGA reste propriétaire et source de vérité de sa session.
- Le comportement VIEW, les limites de frame et les délais réseau restent ceux d'OMEGA V2 certifié.
- Les trois échecs environnementaux de la campagne backend globale sont décrits ci-dessus; ils ne touchent aucun fichier modifié ni aucun test Device Fabric.

Phase 4 n'est pas commencée. INTERACTIVE, ADMIN, automation, voix, agent et scheduler restent hors périmètre.
