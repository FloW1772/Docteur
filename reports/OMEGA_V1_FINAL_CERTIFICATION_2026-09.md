# DOCTEUR OMEGA V1 — CERTIFICATION FINALE ET FREEZE

Date : 2026-09-23  
Périmètre : OMEGA V1 uniquement, sans nouvelle capacité.  
Verdict : **PASS pour le périmètre OMEGA V1 gelé**. La régression backend globale reste **PARTIAL** à cause de six non-passants historiques hors OMEGA, inchangés par cette certification.

## 1. Scope final

La certification couvre l'identité appareil, le pairing, les sessions authentifiées, les permissions VIEW/INTERACTIVE/ADMIN, TLS sur accès distant, la capture écran, l'injection d'entrée bornée, les actions ADMIN sémantiques, l'approbation locale, STOP/révocation, les indicateurs, l'audit, la confidentialité, les tests, le typecheck, le build et le boot serveur.

Aucune nouvelle fonction métier, route de capacité, permission, dépendance, persistance, écouteur, port, relais, transfert de fichier, accès presse-papiers, terminal, shell, accès credential, contrôle navigateur ou élévation n'a été ajouté.

Baseline Git initial :

- fichiers centraux déjà modifiés : `cortex-server/src/server.js`, `cortex-server/src/lib/sqlite.js`, `cortex-server/src/lib/logger.js` ;
- fichiers OMEGA, tests et six rapports de phase déjà présents mais non suivis ;
- dépôts imbriqués préexistants : `external/MetaGPT/.git` et `external/OpenMontage/.git` ;
- aucun reset, clean, restore, rebase, force-push ou commit automatique effectué.

## 2. Architecture réelle

Flux autoritaire confirmé :

`DEVICE IDENTITY -> PAIRING -> AUTHENTICATED SESSION -> SERVER-SIDE PERMISSION -> VIEW / INTERACTIVE / ADMIN POLICY -> LOCAL APPROVAL (high impact) -> FIXED SEMANTIC EXECUTOR -> AUDIT`

OMEGA réutilise le serveur Cortex, le processus et le port existants. Aucun listener ni port OMEGA dédié n'existe. Les quatre groupes Hono sont : contrôle local, VIEW, INTERACTIVE et ADMIN.

Les domaines d'autorisation restent séparés : les modules OMEGA n'accèdent à aucune table `maitre_*`, `monitor_*` ou `cyber_*` et n'importent aucun exécuteur MAÎTRE.

## 3. Permission model

| Permission | Niveau serveur | Capacités |
|---|---:|---|
| `OMEGA_VIEW` | 1 | écran uniquement |
| `OMEGA_INTERACTIVE` | 2 | VIEW + souris + clavier allowlistés |
| `OMEGA_ADMIN` | 3 | VIEW + INTERACTIVE + actions ADMIN sémantiques fermées |

Le niveau est lu depuis `omega_sessions.permission_level`, lui-même créé depuis le device approuvé. `body.permission`, `permissionLevel`, query/header arbitraire et état frontend ne peuvent pas l'élever. ADMIN ne signifie jamais Administrateur Windows, shell, terminal, filesystem, clipboard, credentials ou élévation.

## 4. Crypto, identité et pairing

- Ed25519 via `node:crypto` pour génération, signature et vérification.
- Empreinte SHA-256 de la clé publique.
- Clé privée locale stockée via le secret-store DPAPI sous un namespace OMEGA ; aucune clé privée en SQLite, frontend, réponse ou log.
- Code de pairing aléatoire, hashé en base, TTL fixe de 3 minutes, usage unique, maximum 5 essais.
- Création de pairing limitée à 10/minute dans le processus.
- Approbation et refus sont des étapes locales séparées ; aucun auto-accept.
- Challenge aléatoire 32 octets, TTL 2 minutes, consommé au premier essai même invalide.
- Challenge-response vérifié contre la clé publique déjà enregistrée, jamais contre une clé fournie au moment de la session.
- Re-pairing d'une identité révoquée crée une nouvelle identité au lieu de ressusciter l'ancienne.

Les tests couvrent mauvais code, expiration, réutilisation, brute force, mauvaise clé/signature, challenge réutilisé, device inconnu/révoqué, pairing concurrent et absence de secrets dans les logs/audits.

## 5. Session security

- Session UUID serveur, TTL fixe 15 minutes.
- Binding device et permission côté serveur.
- Nonce initial aléatoire 24 octets puis rotation à chaque requête validée.
- Nonce obsolète/réutilisé, mauvais device, session expirée, terminée ou révoquée : refus fermé.
- Aucun redémarrage Cortex ne restaure silencieusement une session : les autorités auxiliaires (challenges, throttles, approbations) sont process-locales et les indicateurs expirent sur perte de heartbeat.

## 6. TLS et réseau LAN

- Accès OMEGA non-loopback : socket TLS réel obligatoire (`socket.encrypted`).
- En-têtes forwarded ignorés pour cette décision.
- HTTP autorisé uniquement en loopback pour l'usage local Cortex.
- `LOCAL_NETWORK=true` lie l'écouteur existant à `0.0.0.0` mais refuse le démarrage sans `certs/key.pem` et `certs/cert.pem`.
- Avec certificats, le même écouteur est créé en HTTPS ; aucun port de fallback HTTP LAN.
- Seule l'empreinte publique du certificat est exposée ; aucune clé privée loggée ou retournée.
- Aucun trust-store automatique, aucune élévation, aucun STUN/TURN/WebRTC, tunnel, UPnP/NAT-PMP ou relais cloud.

Le smoke final a utilisé `127.0.0.1:3100` en HTTP loopback. `/api/omega/status` a répondu 200, VIEW sans preuve 400 et ADMIN sans preuve 401. Un premier smoke sur 3099 avait aussi démarré correctement ; son PID résiduel a été identifié par le port puis arrêté exactement avant le run final. Aucun kill par nom de processus n'a été utilisé. Le PID exact du run final a ensuite été arrêté et le port libéré.

## 7. VIEW

- Capture Windows user-space via `System.Windows.Forms` / `System.Drawing` dans un script fixe.
- Sélection explicite d'un seul écran ; aucun mode implicite « tous les écrans ».
- Index entier validé et borné à l'inventaire courant.
- PNG vérifié, 8 MiB maximum, dimension maximale 7680, timeout capture 5 s.
- Pull/polling avec backpressure structurelle et plafond 5 FPS par session.
- Changements de résolution exposés dans les métadonnées.
- Aucun driver, hook, injection DLL ou module kernel.

Correction de certification : `/api/omega/view/screens`, auparavant en divergence avec son commentaire et accessible sans preuve de session, exige maintenant `sessionId`, `deviceId` et nonce valide, puis retourne le nonce suivant.

VIEW ne contient aucun import ou chemin d'injection souris/clavier/ADMIN. Les tentatives d'un device VIEW contre INTERACTIVE et ADMIN sont refusées côté serveur.

## 8. INTERACTIVE

Le mécanisme Windows est `user32.dll!SendInput` via `omega-input.ps1`, appelé par `execFile`, `shell:false`, `-File`, chemin absolu et arguments numériques/enum validés.

Allowlist souris : `MOVE`, `LEFT_DOWN`, `LEFT_UP`, `RIGHT_DOWN`, `RIGHT_UP`, `WHEEL`.  
Allowlist clavier : `KEY_DOWN`, `KEY_UP` et VK fermés (A-Z, chiffres, ponctuation OEM définie, navigation, modificateurs et F1-F12).

Limites : 20 événements/batch, 20 requêtes/s/session, body 8 KiB, coordonnées entières dans l'écran sélectionné, normalisation 0..65535, wheel -3..3, timeout 4 s par événement.

`wScan` reste 0. `KEYEVENTF_UNICODE`, texte libre, scan-code brut, `SendKeys`, `mouse_event` et `keybd_event` sont absents. Les audits conservent type/compte/statut, jamais le texte ou un historique complet des touches : OMEGA n'est pas un keylogger.

UIPI reste autoritaire. Aucun UIAccess, RunAs, bypass UAC, secure-desktop bypass ou contournement Ctrl+Alt+Del.

## 9. ADMIN

Allowlist exacte :

- read-only : `GET_SYSTEM_INFO`, `GET_PROCESS_LIST`, `GET_SERVICE_STATUS`, `GET_NETWORK_STATUS`, `GET_DISK_STATUS` ;
- high impact : `LOCK_WORKSTATION`, `REQUEST_LOGOFF`, `REQUEST_RESTART`, `REQUEST_SHUTDOWN`.

Les lectures sont bornées (processus/services 200, réseau 64, disques 32), timeout 8 s, résultat JSON 512 KiB maximum. Elles n'exposent ni mémoire/command line de processus, environnement, handles, cookies, tokens, clés ou secrets navigateur.

Les actions high impact utilisent uniquement `LockWorkStation` et `ExitWindowsEx` dans le script fixe. Aucune action destructive réelle n'a été exécutée : **NOT_RUN** ; les tests utilisent un exécuteur factice.

## 10. Approbation locale

- `OMEGA_ADMIN` requis avant toute requête.
- Une seule requête high impact pending par session.
- TTL demande 30 s ; intervalle minimum high impact 30 s.
- Fenêtre locale visible `OMEGA ADMIN REQUEST` avec `ALLOW ONCE` et `DENY`.
- Timeout, fermeture, STOP, expiration, restart ou révocation => DENY/invalidation.
- Endpoints d'approbation HTTP : loopback strict + Origin localhost obligatoire.
- Le remote ne peut pas s'auto-approuver.
- Binding SHA-256 recalculé sur `sessionId`, `deviceId`, action, arguments normalisés, expiry et nonce d'approbation aléatoire.
- Approbation consommable une fois ; mutation RESTART -> SHUTDOWN refusée.
- `requestId` est lié à une action et idempotent : aucune double exécution.

## 11. STOP et révocation

STOP VIEW/INTERACTIVE arrête la projection correspondante et termine la session sous-jacente. Les routes LAN de screens/status/STOP exigent désormais une preuve `sessionId + deviceId + nonce`, supprimant les anciens chemins de lecture/arrêt non authentifiés.

Correction de certification : `endSession()` est désormais le STOP global central. Il :

- termine `omega_sessions` ;
- marque VIEW et INTERACTIVE stoppés ;
- arrête tous les indicateurs exacts de la session ;
- invalide les demandes ADMIN via le registre de cycle de vie.

La révocation marque le device, révoque toutes ses sessions, invalide les pending ADMIN, supprime toute clé locale éventuelle du namespace et arrête les indicateurs exacts du device. Les anciennes sessions sont inutilisables.

## 12. Indicateurs et process cleanup

Modes persistants : `VIEW ONLY ACTIVE`, `INTERACTIVE CONTROL ACTIVE`, `ADMIN SESSION ACTIVE`, plus prompt `ADMIN REQUEST`.

Les indicateurs WinForms sont visibles, always-on-top, présents dans la barre des tâches et offrent un STOP local. Heartbeat 1 s, expiration du lease 5 s, cleanup exact par session/device/expiry/restart/révocation. Aucun kill global de `node.exe` ou `powershell.exe`.

Correction de certification : le manager déclarait `admin` mais rejetait ce mode lors de la validation. L'enum est maintenant réellement accepté et testé.

## 13. Audit, logs et privacy

`omega_audit` utilise un enum fermé. Les détails sont limités à 4000 caractères et la lecture à 1000 lignes maximum. Les événements couvrent pairing, session, replay, VIEW, INTERACTIVE, TLS et ADMIN.

Le logger partagé masque pairing code, code, session token, private key, private-key PEM, device-key PEM et nonce. Aucun frame écran, contenu clavier, texte tapé, credential ou clé TLS privée n'est audité/loggé. Le scan statique n'a trouvé aucune signature de clé privée, API key ou token dans les fichiers OMEGA/tests/rapports.

## 14. Database

Tables additives uniquement : `omega_devices`, `omega_pairings`, `omega_sessions`, `omega_audit`, `omega_view_sessions`, `omega_interactive_sessions`. Aucun secret privé ou frame n'est stocké ; le pairing code n'est conservé que sous forme de hash et les entrées clavier seulement sous forme de compteurs.

Les relations sont cohérentes par identifiants applicatifs mais ne sont pas matérialisées par des contraintes SQLite `FOREIGN KEY`. Les lectures sont bornées ; les lignes historiques/audit ne font pas l'objet d'une rétention physique dédiée. Ces deux points sont des limitations connues de maintenance, pas des contournements d'autorisation.

## 15. API inventory

Toutes les routes utilisent le listener Cortex existant.

| Classe | Méthode et route | Autorité / accès | Effet |
|---|---|---|---|
| Control | `GET /omega/status` | loopback + host/origin guard | résumé/audit borné |
| Control | `GET /omega/devices`, `GET /omega/devices/:id` | loopback | lecture devices |
| Control | `POST /omega/pairing/start`, `/verify`, `/approve`, `/deny` | loopback, body 16 KiB | cycle pairing |
| Control | `GET /omega/pairing/:id` | loopback | état pairing |
| Control | `POST /omega/challenge` | loopback | challenge one-time |
| Control | `POST /omega/sessions` | loopback + signature device | crée session |
| Control | `GET /omega/sessions/:id` | loopback | état sans nonce |
| Control | `POST /omega/sessions/:id/validate` | loopback + device/nonce | rotation nonce |
| Control | `DELETE /omega/sessions/:id` | loopback | STOP global |
| Control | `POST /omega/devices/:id/revoke` | loopback | révocation globale |
| VIEW | `GET /omega/view/screens` | TLS distant/HTTP loopback + session/device/nonce + VIEW | écrans + rotation nonce |
| VIEW | `POST /omega/view/:sessionId/start` | idem | démarre VIEW/indicateur |
| VIEW | `GET /omega/view/:sessionId/frame` | idem | un frame PNG borné |
| VIEW | `GET /omega/view/:sessionId/status` | idem | état + rotation nonce |
| VIEW | `POST /omega/view/:sessionId/stop` | idem | STOP global |
| INTERACTIVE | `POST /omega/interactive/:sessionId/start` | TLS distant/HTTP loopback + session/device/nonce + INTERACTIVE | démarre contrôle |
| INTERACTIVE | `POST /omega/interactive/:sessionId/input` | idem + allowlists/bounds | SendInput borné |
| INTERACTIVE | `GET /omega/interactive/:sessionId/status` | idem | état + rotation nonce |
| INTERACTIVE | `POST /omega/interactive/:sessionId/stop` | idem | STOP global |
| ADMIN | `GET /omega/admin/status` | TLS distant/HTTP loopback + session/device/nonce + ADMIN | statut/allowlist |
| ADMIN | `GET /omega/admin/system`, `/processes`, `/services`, `/network`, `/disks` | idem | lecture sémantique bornée |
| ADMIN | `POST /omega/admin/actions` | idem + action high impact fermée | crée demande locale |
| ADMIN | `GET /omega/admin/actions/:actionId` | idem + binding session/device | état demande |
| Local approval | `POST .../:actionId/approve-local`, `/deny-local` | loopback + Origin localhost | ALLOW ONCE / DENY |

Aucune route `/shell`, `/exec`, `/run`, `/powershell`, `/cmd`, `/files`, `/upload`, `/download`, `/clipboard`, `/credentials`, `/install`, `/service` ou `/persist`.

## 16. Forbidden capabilities et command injection

Confirmé absent : remote browse/upload/download/delete/rename/move/execute-file, clipboard read/write/sync, Credential Manager/LSASS/SAM/browser password-cookie/SSH key/DPAPI extraction, service/task/startup/Run/RunOnce/watchdog/respawn, relay/cloud/NAT traversal, auto-update, élévation et secure-desktop bypass.

Le seul lanceur restant est `runFixedPowerShellScript()` : exécutable absolu, `-File`, scripts repository fixes, arguments regex-validés, `shell:false`, timeout et buffers bornés. Le helper exporté `runFixedInlineCommand(script)`, inutilisé mais trop générique pour le freeze, a été supprimé pendant la certification. Les payloads shell/path traversal restent des données rejetées ; aucune commande n'est exécutée.

## 17. Tests et security negatives

Suite finale `cortex-server/test-omega-*.mjs`, fichier par fichier dans le contexte Windows normal requis par DPAPI/WMI/desktop APIs :

- 14 fichiers ;
- 227 tests ;
- 224 pass ;
- 0 fail ;
- 0 cancelled ;
- 3 skipped attendus (chemin non-Windows et scénarios réels d'injection opt-in).

Baseline précédent : 220/223, 3 skipped. Différence : +4 tests pass, couvrant écrans authentifiés, status/STOP VIEW authentifiés, status/STOP INTERACTIVE authentifiés et STOP global session.

Couverture négative confirmée : unpaired, revoked, expired, mauvaise signature/clé/device, mauvais nonce/replay, falsification permission, VIEW input, INTERACTIVE ADMIN, remote self-approval, approval replay/expiry/mutation, HTTP LAN, TLS absent, input/body/frame oversized, rate limits, XSS, shell/path payloads et STOP.

## 18. Régression, typecheck, build et boot

Régression finale, méthodologie historique `node --test --test-timeout=20000` fichier par fichier :

- 133 fichiers ;
- 2173 tests ;
- 2164 pass ;
- 3 fail ;
- 3 cancelled ;
- 3 skipped.

Les six non-passants sont exactement le baseline historique hors OMEGA :

- cancelled : `test-cyber-audit-crawler.mjs`, `test-maitre-executor-level2.mjs`, `test-regression-api.mjs` ;
- fail : `test-find-eval.mjs`, `test-video-manual.mjs`, `test-video-pipeline.mjs`.

Aucun fichier concerné n'a été modifié par la certification. L'écart de +4 tests par rapport au baseline 2169 correspond uniquement aux nouveaux tests OMEGA passants. Relevant regressions : **PASS**.

- `npx tsc --noEmit` : PASS.
- `npm run build` : PASS ; avertissement historique de gros chunks uniquement.
- syntaxe JS OMEGA : PASS.
- parseur PowerShell des scripts OMEGA : PASS.
- server boot : PASS ; routes OMEGA enregistrées, aucun `EADDRINUSE`, aucun listener/port additionnel.

## 19. Git hygiene et dépendances

- Nouvelle dépendance OMEGA : 0. OMEGA utilise Node built-ins et Hono déjà présent.
- Runtime/session/frame/screenshot OMEGA suivi : 0.
- Certificat/clé privée suivi : 0.
- Scratch DB OMEGA suivi : 0.
- Secrets suivis/détectés dans le périmètre : 0.
- Le dépôt contient deux captures génériques préexistantes suivies (`screenshot_render.png`, `screenshot_render2.png`) hors OMEGA ; elles n'ont pas été supprimées automatiquement.
- Les artefacts de build restent gérés par les règles existantes du dépôt.

## 20. Known limitations

- Windows-first pour capture, SendInput, DPAPI, indicateurs et actions natives.
- Certificat LAN géré manuellement ; pas de trust install automatique ni mTLS. L'identité applicative reste Ed25519 challenge-response au-dessus de TLS.
- Aucun relais Internet : fonctionnement direct local/LAN uniquement.
- Pas de frontend OMEGA complet dans cette V1 ; les garanties sont backend et UI Windows locale pour indicateurs/approbations.
- UIPI limite l'entrée vers les applications élevées ; secure desktop et Ctrl+Alt+Del non contrôlables.
- LOCK/LOGOFF/RESTART/SHUTDOWN réels non exécutés pendant les tests.
- FPS volontairement conservateur (5) et transport VIEW par polling.
- Rate limits, challenges, throttles et pending ADMIN sont process-locales et repartent vides après restart.
- Pas de test automatisé entre deux machines physiques ; les routes utilisent de vraies requêtes Hono et une vraie crypto, avec APIs Windows réelles testées séparément.
- Relations `omega_*` non contraintes par FK et absence de purge physique dédiée des historiques/audits.
- Les six non-passants backend historiques hors OMEGA demeurent.

## OMEGA V1 FROZEN SCOPE

Inclus et gelé :

- VIEW écran borné ;
- INTERACTIVE souris/clavier allowlistés ;
- ADMIN semantic allowlist exacte documentée ci-dessus ;
- identité/pairing/session/TLS/approval/STOP/revocation/indicateurs/audit nécessaires à ces trois niveaux.

Explicitement non inclus : shell, terminal, fichiers, clipboard, credentials, persistence, cloud relay, automatic elevation, secure-desktop bypass, arbitrary execution, portable USB, contrôle mobile et nouvelles actions ADMIN.

Toute extension future exige une nouvelle mission/version.

## DOCTEUR OMEGA V1 FINAL CERTIFICATION CHECKPOINT

Architecture :
PASS

Device identity :
PASS

Pairing :
PASS

Session security :
PASS

Nonce/replay protection :
PASS

Revocation :
PASS

TLS remote enforcement :
PASS

HTTP LAN fallback :
0

VIEW :
PASS

VIEW cannot inject :
PASS

INTERACTIVE :
PASS

Keyboard allowlist :
PASS

Mouse bounds :
PASS

UIPI boundary preserved :
PASS

Secure desktop bypass :
0

ADMIN permission :
PASS

Semantic ADMIN allowlist :
PASS

Local approval :
PASS

Remote self-approval :
0

Approval binding :
PASS

Approval one-time use :
PASS

STOP :
PASS

Persistent indicators :
PASS

Remote hide indicator :
0

Arbitrary shell :
0

Generic command executor :
0

Arbitrary PowerShell :
0

Arbitrary executable launch :
0

Automatic elevation :
0

UAC bypass :
0

Credential access :
0

Clipboard access :
0

File transfer :
0

Hidden persistence :
0

Cloud relay :
0

Keylogging :
0

Secret exposure :
0

Strict Local :
PASS

OMEGA tests :
224/227

OMEGA skipped :
3

OMEGA failed :
0

OMEGA cancelled :
0

Full backend regression :
133 files; 2173 tests; 2164 pass; 3 fail; 3 cancelled; 3 skipped; six historical non-passers only

Relevant regressions :
PASS

Typecheck :
PASS

Build :
PASS

Server boot :
PASS

Runtime files tracked :
0 OMEGA

Secrets tracked :
0

Files changed by certification :
`cortex-server/src/lib/omega-view.js`, `cortex-server/src/lib/omega-interactive.js`, `cortex-server/src/lib/omega-indicator.js`, `cortex-server/src/lib/omega-session.js`, `cortex-server/src/lib/omega-windows-exec.js`, `cortex-server/src/routes/omega-view.js`, `cortex-server/src/routes/omega-interactive.js`, `cortex-server/test-omega-view-route.mjs`, `cortex-server/test-omega-interactive-route.mjs`, `cortex-server/test-omega-hardening.mjs`, `cortex-server/test-omega-session.mjs`, `reports/OMEGA_V1_FINAL_CERTIFICATION_2026-09.md`

Known limitations :
Windows-first; certificat LAN manuel; aucun relais Internet; aucun frontend OMEGA complet; UIPI/secure desktop; actions destructives réelles NOT_RUN; polling 5 FPS; états auxiliaires process-locaux; pas de test deux machines physiques; relations DB sans FK et historique sans purge dédiée; six non-passants backend historiques hors OMEGA

OMEGA V1 frozen scope :
PASS

Final verdict :
PASS

**STOP — OMEGA V2 / Phase 6 et toute extension sont hors périmètre.**
