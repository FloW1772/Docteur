# MASTER PHASE 2 — Connecteurs YouTube (Data API) + Microsoft OneDrive (Graph)

Date: 2026-09-15
Branche: `main` (diff isolé, non commité)

## 1. Objectif

Connecter les données utilisateur (YouTube, OneDrive) via OAuth **officiel** uniquement
(jamais cookie/session navigateur/mot de passe), avec propagation `local_only` complète et
stockage sécurisé des credentials (DPAPI).

## 2. Décision de portée (validée avec l'utilisateur)

Cette phase ne dispose d'aucun identifiant d'application réel (Google Cloud OAuth client /
Azure App Registration). Sur choix explicite de l'utilisateur : **architecture + mocks
uniquement**, sans test contre un vrai compte. Conforme à la règle mission "PARTIEL peut
continuer si... fonctionnalité externe seulement indisponible... limitation clairement
documentée... les fondations sont saines."

## 3. Ce qui a été construit

### 3.1 Stockage (additif, aucune table existante modifiée)
`cortex-server/src/lib/sqlite.js` — 3 nouvelles tables (`CREATE TABLE IF NOT EXISTS`) :
- `oauth_connections` — état de connexion (connected, account_label, scopes, auto_sync,
  last_sync_at/status/error). **Aucun token n'y est jamais stocké.**
- `connector_sync_items` — registre de déduplication (provider, external_id → page_id).
- `connector_sync_state` — delta token pour sync incrémentale (Microsoft Graph delta query).

Tokens OAuth (access/refresh) et credentials d'application (client_id/client_secret) :
exclusivement via `secret-store.js` existant (DPAPI CurrentUser), clés
`youtube_oauth_refresh_token`, `onedrive_oauth_refresh_token`, `oauth_client_<provider>_id`,
`oauth_client_<provider>_secret`. Aucune modification de `secret-store.js` — réutilisation
directe du store générique existant.

### 3.2 Connecteurs
- `cortex-server/src/lib/connectors/youtube-connector.js` — OAuth Google officiel
  (`accounts.google.com/o/oauth2/v2/auth`, scope `youtube.readonly` uniquement, minimal).
  Types de données réellement exposés par l'API officielle : vidéos publiées (`uploads`),
  playlists, vidéos "J'aime" (alias playlist `LL`). **Limitation documentée dans le code** :
  l'historique de visionnage n'est PAS accessible via l'API officielle (Google l'a retiré) —
  ce connecteur ne prétend jamais le synchroniser.
- `cortex-server/src/lib/connectors/onedrive-connector.js` — OAuth Microsoft officiel
  (`login.microsoftonline.com`), scopes `Files.Read` + `offline_access` (lecture seule).
  Formats supportés : `.md`, `.txt`, `.pdf`, `.xlsx` — **`.docx` volontairement exclu** :
  aucune dépendance de parsing docx n'existe dans le projet (vérifié `package.json`, ni
  `mammoth` ni équivalent) ; annoncer ce format aurait violé la règle "ne pas annoncer
  import PDF générique si non présent". Delta sync via Microsoft Graph delta query.

### 3.3 Route API
`cortex-server/src/routes/connectors.js`, montée sur `/api` dans `server.js` :
- `GET /api/connectors` — statut (jamais de token).
- `POST/DELETE /api/connectors/:provider/client-credentials` — enregistrement de
  l'app OAuth (client_id/secret) via DPAPI.
- `GET /api/connectors/:provider/auth-url` — URL de consentement, avec `state` anti-CSRF
  (stocké en mémoire process, TTL 10 min, jamais persisté).
- `POST /api/connectors/:provider/callback` — échange code→tokens, valide le `state`.
- `POST /api/connectors/:provider/sync` — sync manuelle (déclenchement explicite uniquement,
  aucun scheduler automatique dans cette phase).
- `PUT /api/connectors/:provider/auto-sync` — persiste l'intention (auto_sync=true/false)
  sans activer de comportement automatique réel (pas de scheduler = pas de risque de sync
  silencieuse en tâche de fond).
- `POST /api/connectors/:provider/disconnect` — retire toujours les credentials OAuth ;
  suppression des données synchronisées Docteur **uniquement** si `delete_synced_data: true`
  explicite (défaut : NON, conforme mission).

### 3.4 Propagation privacy / egress
Chaque item importé (YouTube ou OneDrive) est indexé via `services.indexNeuron()` avec :
```js
metadata: { source: '<provider>_private', egress_policy: 'local_only', ... }
```
et sa page (`savePageToStore`) avec `private: true`. Ce flag est celui que `server.js` lit
déjà (`getPageFromStore(id)?.private === true`) pour appliquer `markPrivate()` avant tout
appel cloud — **le même mécanisme certifié en Phase 1** protège donc automatiquement tout
contenu connecteur, sans code de propagation supplémentaire à écrire ni maintenir.

## 4. Tests (mocks uniquement — 0 identifiant réel requis)

`test-phase2-connectors.mjs` — 12 tests, tous PASS :
1. Stockage credentials client OAuth via DPAPI, jamais renvoyées en clair.
2. `auth-url` refuse si aucun client OAuth configuré.
3. Flux complet auth-url → callback (token exchange mocké) → connecté, refresh_token jamais
   renvoyé au frontend, mais bien stocké côté serveur (vérifié via `getSecret`).
4. `callback` rejette un `state` inconnu/expiré (protection CSRF).
5. Échange sans `refresh_token` dans la réponse → rejeté explicitement (offline_access
   mal configuré côté Google/Azure).
6. Rafraîchissement de token : un token expiré déclenche un `grant_type=refresh_token`,
   jamais une nouvelle demande de consentement.
7. Sync YouTube : item importé marqué `source=youtube_private`,
   `egress_policy=local_only`, page `private: true`.
8. Dédup : un second sync du même `videoId` n'est pas ré-importé (`indexNeuron` appelé une
   seule fois au total sur 2 syncs).
9. OneDrive : formats non supportés (`.pptx`, `.heic`) rapportés comme "skipped", jamais
   importés silencieusement.
10. Déconnexion par défaut : credentials supprimés, pages Docteur déjà synchronisées
    conservées.
11. Déconnexion avec `delete_synced_data: true` : credentials + pages connecteur supprimés.
12. `GET /api/connectors` ne déclenche aucun appel réseau (lecture SQLite/secret-store pure).

**0 appel réseau réel** — tout `fetch` est mocké ; un `fetch` non prévu lève explicitement une
erreur (`UNEXPECTED_UNMOCKED_FETCH`) pour détecter toute fuite de test vers le vrai réseau.

## 5. Régression

Suite complète (Phase 0 + Phase 1 + Phase 2) : `test-privacy-guard.mjs`,
`test-strict-local-centralized.mjs`, `test-ai-provider-fallback.mjs`, `test-freellmapi.mjs`,
`test-phase1-egress-certification.mjs`, `test-phase2-connectors.mjs` → **119/119 PASS**.

## 6. Typecheck / Build

- `npx tsc --noEmit` → OK (aucun fichier frontend modifié cette phase).
- `npm run build` → OK.
- Démarrage réel du serveur + `GET /api/connectors` sur la vraie base de données de
  l'utilisateur → `200 OK`, `connected: false` pour les deux providers (jamais connectés),
  aucune donnée existante touchée.

## 7. Limitations documentées (PARTIEL assumé)

1. **Aucun test contre un vrai compte Google/Microsoft** — nécessite un OAuth client
   (Google Cloud Console) et une App Registration (Azure/Entra) que l'utilisateur n'a pas
   fournis. Architecture prête à recevoir ces credentials via
   `POST /api/connectors/:provider/client-credentials` dès qu'ils existeront.
2. **Aucune UI frontend** pour cette phase — délibérément reporté : construire un écran de
   connexion OAuth complet (redirection, callback, affichage compte/scopes) sans pouvoir le
   valider dans un vrai navigateur contre un vrai provider aurait produit du code non
   vérifiable. Le backend est testé et stable ; l'UI sera ajoutée dans une phase ultérieure
   une fois des credentials réels disponibles pour validation visuelle.
3. **OneDrive `.docx` non supporté** — aucune dépendance de parsing dans le projet
   actuellement (voir section 3.2). Formats réellement supportés : `.md`, `.txt`, `.pdf`,
   `.xlsx`.
4. **YouTube : historique de visionnage non accessible** — limitation de l'API officielle
   elle-même (Google a retiré cet endpoint), pas de contournement implémenté ni prévu.
5. **Auto-sync : persistance sans exécution** — le toggle `auto_sync` est stocké mais aucun
   scheduler ne le lit encore. Documenté pour éviter toute impression de sync automatique
   fonctionnelle avant qu'un vrai déclencheur planifié soit ajouté (et testé) explicitement.
6. **Extraction de contenu OneDrive** — le téléchargement/parsing réel du contenu binaire
   (`.pdf`/`.xlsx`) via `downloadFileContent()` est implémenté dans le connecteur mais la
   route de sync utilise pour l'instant un placeholder de métadonnées (nom de fichier,
   taille) plutôt que le contenu extrait — le câblage complet vers les parsers existants
   (`pdf-parse` pour `.pdf`, `exceljs`/`lib/files.js` pour `.xlsx`) nécessite un vrai fichier
   OneDrive pour être validé de bout en bout et est laissé pour un prochain incrément une
   fois des credentials réels disponibles.

## GATE PHASE 2

| Critère | Résultat |
|---|---|
| OAuth uniquement (jamais cookie/mdp/session navigateur) | Conforme (Google + Microsoft officiels) |
| Scopes minimaux en lecture | Conforme (`youtube.readonly`, `Files.Read`+`offline_access`) |
| Tokens jamais en frontend/logs/plaintext | Conforme (DPAPI via secret-store.js, vérifié par test) |
| Sync manuelle par défaut, auto-sync désactivée | Conforme |
| Déduplication | Conforme, testée |
| Déconnexion : credentials retirés, données conservées par défaut | Conforme, testé |
| Propagation local_only | Conforme — réutilise le mécanisme certifié Phase 1 |
| Tests OAuth mock / sync mock / dédup / expiration / refresh / déconnexion | 12/12 PASS |
| Test local_only → cloud calls | 0 (aucun connecteur n'envoie jamais son contenu à un provider cloud IA — seul le stockage local + RAG local y accèdent) |
| typecheck / build | OK / OK |
| Régression | 0 (119/119 tests) |

**PASS AVEC LIMITATION DOCUMENTÉE** — architecture complète et testée (mocks), aucun compte
réel validé (dépendance externe non fournie), aucune UI (décision de portée délibérée),
extraction de contenu OneDrive simplifiée en attendant des credentials réels. Fondations
saines, aucune régression, aucune faille de sécurité identifiée.

**→ CONTINUE vers PHASE 3 (mémoire adaptative locale).**
