# Centre de connexions — Phase 1 backend

Date : 16 septembre 2026. Reprise du travail existant, sans reset, revert, clean Git ni commit. Aucun changement de l'UI Settings → Connexions.

## Résultat et réserve sur le compteur historique

Backend implémenté et suites présentes vertes : **530/530 tests backend**, soit **497 tests historiques + 33 tests Batch D**, sur 36 fichiers (35 historiques + Batch D). Zéro échec, annulation de test ou skip. Les 10 tests frontend de polling vidéo passent également.

**Le chiffre historique 511/511 n'est pas reproductible avec les fichiers présents.** Le total ci-dessus additionne les compteurs TAP `# tests` et `# pass` de chaque processus Node v22.22.3, sans compter les conteneurs `describe` comme des tests. Aucun test historique n'a été supprimé ou désactivé. Il serait incorrect de certifier « 511 anciens tests » : les 35 fichiers historiques exécutés en contiennent 497 selon Node. La cause de l'écart de 14 avec l'ancien rapport n'est pas établie. Le détail vérifiable est dans `connectors-certification-results.json` et les journaux `certification-test-*.mjs.log`.

## Cause exacte de l'échec repris

Reproduction avant modification, avec le profil Windows nécessaire à DPAPI : **23/24 PASS** pour `test-phase2-connectors.mjs` + `test-batch-a-robustness.mjs`.

Échec : `F1: onedrive-connector.js — every fetch() call site sets an AbortSignal.timeout`, ligne 172 initialement. Message : `expected at least 4 fetch() call sites, found 3`.

Le quatrième appel avait été déplacé vers `downloadWithSizeLimit()`. Le timeout de 60 secondes restait transmis par OneDrive. Ce n'était ni une régression du téléchargement, ni un changement de noms de credentials, ni PKCE : **l'assertion structurelle était obsolète**.

Correction initiale uniquement dans le test : vérifier les trois appels API directs puis exercer réellement le quatrième chemin, intercepter `AbortSignal.timeout(60000)` et vérifier l'identité du signal reçu par le fetch mocké. Les assertions de timeout ne sont pas supprimées. Après ajout de l'annulation, le contrôle structurel accepte également `AbortSignal.any([AbortSignal.timeout(...), ...])`.

Les 12 tests Batch C étaient déjà PASS avant correction. Le premier essai dans le bac à sable ajoutait des erreurs environnementales DPAPI (profil Windows non chargé) ; l'exécution avec profil chargé a isolé l'unique échec F1. Aucun contournement du chiffrement en production.

## PKCE, state et registre

- Registre branché sur les routes : YouTube, Google Drive et OneDrive actifs ; Dropbox/GitHub/Notion/calendriers indisponibles. Identifiants inconnus et noms de propriétés de prototype rejetés avant secret-store/OAuth/réseau.
- PKCE S256 pour les trois routes OAuth. Verifier généré avec 32 octets aléatoires, challenge SHA-256/base64url. Le verifier reste dans la Map serveur, puis dans la requête serveur d'échange de code ; jamais dans une réponse frontend.
- State lié au provider et à la redirect URI exacte ; TTL de 10 minutes ; maximum 1 000 demandes en attente par instance de route ; consommation avant l'échange, y compris si celui-ci échoue.
- Modification/suppression des credentials et déconnexion invalident les states et la synchronisation du connecteur. Une réponse OAuth tardive ne peut pas recréer les tokens après déconnexion.

## Google Drive

- Scope unique `https://www.googleapis.com/auth/drive.file`. Aucun `drive.readonly`, aucun `files.list` global.
- `POST /api/connectors/google_drive/sync` exige `file_ids` : 1 à 50 identifiants explicites valides, dédupliqués. Les fichiers doivent déjà être accessibles à l'application sous `drive.file`. Aucun Picker simulé ; le Picker reste en Phase 2.
- Lecture des métadonnées puis du contenu, import privé, déduplication persistante, refresh token indépendant et rotation lorsqu'un nouveau refresh token est fourni.
- `.txt`/`.md` : texte ; `.pdf` : parseur local existant ; `.xlsx` : résumé du classeur avec le parseur existant ; Google Docs : export texte. Les autres formats, notamment Sheets/Slides natifs, sont explicitement ignorés avec un motif.
- Helper de retry : 429, 403 `rateLimitExceeded`/`userRateLimitExceeded`, 500/502/503/504. Aucun retry pour refus de permission ou 401. Au plus trois retries par défaut, backoff exponentiel avec jitter et Retry-After, attente plafonnée à 30 secondes, annulation propagée. Corps d'erreur 403 limité à 64 KiB.
- Métadonnées limitées à 64 KiB ; fichiers/export limités à 20 MiB (20 971 520 octets). Délai API 15 s ; téléchargement 60 s, couvrant retries et flux.

Références officielles consultées pour l'implémentation : [téléchargement/export Drive](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [gestion des erreurs et quotas](https://developers.google.com/workspace/drive/api/guides/handle-errors). Consultation documentaire uniquement ; aucun appel authentifié ou test de compte réel.

## Isolation des credentials / anti-overwrite

Conservation des clés existantes par connecteur : `oauth_client_<provider>_id`, `oauth_client_<provider>_secret`, `<provider>_oauth_refresh_token`. `clientFamily` est descriptif ; YouTube et Google Drive ne s'écrasent pas mutuellement. Pas de migration implicite ni remplacement global des secrets.

Les lectures des connecteurs utilisent `migrateLegacy: false` dans le secret-store : elles ne déclenchent plus indirectement la migration du champ historique `cloud_api_keys`. Le comportement des lecteurs IA existants reste celui par défaut.

Tests avec sentinelles fictives : modification, suppression et déconnexion Google Drive/OneDrive préservent les valeurs **et les ciphertexts** de Groq, OpenRouter, Gemini, Anthropic, OpenAI, FreeLLMAPI et NotebookLM, ainsi que les credentials du connecteur voisin. Test séparé du champ legacy pour prouver l'absence de migration déclenchée par les connecteurs.

Les erreurs amont ne sont plus recopiées dans les logs ni dans `last_sync_error`, que l'endpoint de statut expose au frontend. Messages fixes, sans token/URL sensible.

## Téléchargement, annulation et confidentialité

`downloadWithSizeLimit()` ne contient aucun fallback `res.arrayBuffer()`. Absence de corps : erreur contrôlée. Taille déclarée et compteur réel des chunks contrôlés ; dépassement : annulation du lecteur. Limites invalides rejetées avant fetch. Erreurs de lecture sanitisées, y compris avec une classe d'erreur générique.

OneDrive conserve 20 MiB, 60 s, `OneDriveFileTooLargeError`, `ONEDRIVE_FILE_TOO_LARGE` et ses messages spécifiques. Signal utilisateur combiné au timeout. Tests d'annulation avant fetch, à la prise du lecteur et pendant une lecture en attente.

`POST /api/connectors/:provider/cancel` annule la synchronisation active ; le signal de la requête est également transmis. Une seule synchronisation par provider, rejet concurrent en 409, libération du verrou en `finally`. Les éléments déjà importés avant une annulation restent conservés ; il n'y a pas de rollback destructif.

Les imports YouTube/OneDrive/Drive portent `private=true`, `privacy=true`, `egress_policy=local_only` et une provenance `<provider>_private` dans leurs métadonnées. Les chemins RAG/recherche/comparaison/chat utilisent aussi ces métadonnées, même si le drapeau de page est absent ou effacé. Les métadonnées sont conservées lors de la construction des sources de contexte. Notebook hérite de la page et de sa politique ; mémoire : propagation depuis la source et déduplication séparée entre public et privé. Les guards cloud et le routage local existants restent actifs ; Ollama local reste autorisé.

Limite préexistante conservée : la synchronisation OneDrive importe encore titre/métadonnées ; son téléchargement binaire borné reste un helper non branché à l'extraction de contenu de cette route. Ce comportement n'a pas été présenté comme une nouvelle extraction complète.

## Vérification

Commande reproductible : `node scripts/test-connectors-certification.mjs`. Chaque fichier tourne dans son propre processus avec `DOCTEUR_TEST_MODE=1`, fetch réel bloqué par préchargement, et mocks explicites dans les tests. Bases `:memory:` ou répertoires `data-test-*` dédiés.

| Suite demandée | Résultat |
|---|---:|
| Batch C OneDrive | 12/12 |
| Phase 2 connecteurs | 12/12 |
| Batch A robustesse | 12/12 |
| OpenRouter regression | 16/16 |
| Teacher fallback | 11/11 |
| Privacy guard | 33/33 |
| Egress certification | 7/7 |
| Strict local centralized | 6/6 |
| Phase 5 Notebook | 17/17 |
| Phase 3 mémoire | 26/26 |
| Batch D | 33/33 |
| Tous les fichiers backend | 530/530 |
| Polling vidéo frontend, supplémentaire | 10/10 |

Les dernières corrections du helper sont également couvertes par la relance finale ciblée des quatre fichiers connecteurs (69 tests), journal `connectors-final-targeted-tests.log`.

`test-maintenance.mjs` conserve la correction FINAL-F1 (`chat_model` explicite). Sa lecture de vraies clés via un enfant ouvrant `data/cortex.sqlite` a été retirée et remplacée par trois valeurs fictives sur `:memory:` ; `--live` est désormais refusé dans cette suite.

Exclusions inchangées : `test-find-eval.mjs` (navigateur interactif), `test-regression-api.mjs` (serveur persistant), `test-video-manual.mjs` (réseau réel). `test-setup.mjs` est un module de préparation, pas une suite.

Typecheck : **PASS**, `node node_modules/typescript/bin/tsc --noEmit`, projet TypeScript racine. Le backend est en JavaScript sans tsconfig dédié ; validation syntaxique `node --check` des 14 fichiers backend concernés : PASS. Ne pas confondre une invocation de tsc depuis cortex-server, qui remonte au tsconfig frontend, avec un typecheck JavaScript du backend.

Build : **PASS**, `npm run build` (`tsc && vite build`). Avertissements Vite de dépréciation et de taille de chunks, aucun échec. `git diff --check` : PASS.

## Données réelles

Aucune ouverture SQL de la base utilisateur par les tests. Comparaison des empreintes SHA-256, tailles et dates de modification avant/après, y compris WAL/SHM : **identiques**.

| Fichier | Taille | SHA-256 avant = après |
|---|---:|---|
| cortex.sqlite | 19 542 016 | A163EF4157795CA5FC3A95E8082ECFF2D68EEA4AB9EA7404E7B78D2BCC522ED2 |
| cortex.sqlite-wal | 4 124 152 | 062D646B65BC1E3903E77BB1DE755BEBCDE23608A401577468E3DC83AB9726A2 |
| cortex.sqlite-shm | 32 768 | 165628E4A512B22BFD5B03A376448CBF4B5A0495FB3FD743A9583C6D47198AF6 |

Credentials réels modifiés : **0**. Données utilisateur supprimées : **0**. Appels cloud live des tests : **0**. Vrai OAuth : **0**. Dépendances installées : **0**. Aucun `shell:true` ajouté ou utilisé dans les commandes de cette reprise.

## Fichiers de cette reprise

Sous `cortex-server/` :

- `src/lib/connector-registry.js` (déjà présent : commentaire d'isolation corrigé, registre branché) ; `src/lib/pkce.js` (déjà présent, intégré sans réécriture).
- `src/lib/connectors/download-limits.js`, `onedrive-connector.js`, `youtube-connector.js`.
- `src/lib/connectors/google-drive-connector.js`, `google-drive-rate-limit.js` (nouveaux).
- `src/lib/secret-store.js`, `src/lib/source-privacy.js` (nouveau), `src/lib/memory.js`.
- `src/routes/connectors.js`, `src/routes/notebook.js`, `src/routes/chat.js`, `src/server.js`.
- `test-batch-a-robustness.mjs`, `test-maintenance.mjs`, `test-batch-d-connectors.mjs` (nouveau).

À la racine : `scripts/test-connectors-certification.mjs`, `scripts/test-connectors-offline-guard.mjs`, ce rapport et les journaux/résultats de certification dans `reports/`. Les autres changements Git constatés à l'arrivée appartiennent au travail antérieur et sont conservés. Aucun fichier source frontend modifié pendant cette reprise.

**STOP : aucune Phase 2 UI engagée, aucun compte réel connecté.**
