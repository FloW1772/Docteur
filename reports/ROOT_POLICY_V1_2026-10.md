# DOCTEUR ROOT POLICY V1 — rapport final de certification

Date de certification : 2026-10-01 (Europe/Paris)  
Périmètre : Root Policy V1 uniquement  
Verdict : **PASS_WITH_LIMITATIONS**  
Statut : **NON FROZEN** — les garanties du moteur sont prouvées, mais la couverture runtime n'est pas encore globale.

## 1. Executive summary

Root Policy V1 fournit un moteur local déterministe, une policy canonique signée Ed25519, un trust anchor public en code, une détection de modification live, un anti-rollback, un audit local chaîné et un comportement fail-closed pour les opérations protégées effectivement branchées. STOP/révocation reste disponible même si la policy est absente ou altérée.

Les règles R1–R9 passent leurs tests. Le cloud reste utilisable après activation explicite, l'installation neuve est maintenant Strict Local (`strict_local_mode=true`, `cloud_enabled=false`), les secrets et contenus privés sont bloqués avant egress, les démarrages de processus branchés sont sémantiques, et les frontières OMEGA/RASSILON/Device Fabric/MAÎTRE restent séparées et inchangées.

La certification n'est pas un PASS complet : onze exécuteurs internes typés sont encore dans la catégorie de couverture progressive sans appel Root Policy direct, et les actions FILE_WRITE/FILE_DELETE ne sont pas uniformément branchées à la Root Policy. Ces chemins restent contraints par leurs contrôles existants et aucun shell arbitraire n'a été trouvé, mais ils ne constituent pas une couverture Root Policy globale démontrée. Root Policy V1 ne doit donc pas être marquée FINAL/CERTIFIED/FROZEN.

## 2. Threat model

Menaces couvertes : sortie cloud silencieuse, fuite de secrets ou contenu privé, prompt injection transformée en autorisation, confusion de trust domains, action high-impact sans approval, shell arbitraire, policy absente/corrompue, signature étrangère, rollback, modification live, SSRF/redirection via yt-dlp, reseal depuis un chemin runtime, suppression de STOP par une policy invalide.

Hors objectif : un administrateur local contrôlant entièrement la machine peut modifier le code, remplacer le trust anchor, patcher Node/le binaire ou lire la mémoire du processus. Root Policy est tamper-evident, fail-closed et inaccessible aux chemins runtime normaux ; elle n'est pas une enclave matérielle contre le propriétaire administrateur.

## 3. Architecture Root Policy

Flux : `requête sémantique -> classify/typed context -> moteur déterministe -> ALLOW | DENY | REQUIRE_APPROVAL | NOT_APPLICABLE -> garde spécialisée/exécuteur`.

Le schéma fixe en code les acteurs, actions, domaines, impacts, plafonds et capacités jamais accordables. Le document signé ne peut accorder que ce que le plafond codé permet. Le runtime charge et vérifie format canonique, hash, signature, schéma et version avant d'activer les opérations protégées. Une modification des deux fichiers est détectée par stat puis entièrement revérifiée.

## 4. R1–R9 finales

| Règle | Résultat | Preuve principale |
|---|---|---|
| R1 Strict Local | PASS | Installation neuve sondée hors mode test : Strict Local actif et cloud désactivé ; cloud explicitement activé reste fonctionnel. |
| R2 Secret/data leakage | PASS | Secrets structurés et contenu privé refusés avant provider ; focus privacy 48/48 ; audit sans payload/URL/contenu. |
| R3 Aucun bypass d'autorisation | PASS | Circumvention/DRM/paywall refusés ; aucune parole LLM ne crée une autorisation. |
| R4 High impact | PASS | REQUIRE_APPROVAL, digest exact action/module/domain/target/payload, token one-shot et expiration testés. |
| R5 Aucun shell/RPC arbitraire | PASS | SHELL_ARBITRARY toujours DENY ; PROCESS_START branché typé ; registre statique exhaustif. Quatre probes CLI `shell:true` préexistantes ont uniquement des argv littéraux de statut/version. |
| R6 Trust domains séparés | PASS | OMEGA, RASSILON, Device Fabric, AI, PLUGIN et POLICY ne s'héritent pas mutuellement. |
| R7 STOP/révocation gagne | PASS | Policy valide, absente et altérée ; STOP HTTP reste disponible et les sessions révoquées battent les commandes normales. |
| R8 Policy immuable au runtime | PASS | API read-only, aucune importation du tool dans `src/`, aucune clé privée chargée par le serveur, POLICY_UPDATE toujours DENY. |
| R9 UNKNOWN fail-closed | PASS | Policy/integrity, acteur, action, module, capability, domaine et contexte ambigu refusés pour les opérations protégées. |

## 5. Actions, acteurs, domaines, modules et capacités

Comptage recalculé depuis le code final :

- 34 actions sémantiques ;
- 26 actions protégées ;
- 10 types d'acteurs ;
- 15 trust domains ;
- 17 modules ;
- 31 capacités ;
- 5 capacités never-granted ;
- 25 patterns de routes.

Les capacités never-granted sont les capacités de mutation policy, shell arbitraire et installation/démarrage d'extensions qui ne peuvent pas être accordées à un module V1.

## 6. Policy format

Schéma : `docteur.root-policy/1`. Version active : `1`. Le fichier doit être du JSON UTF-8 canonique, clés triées, sans whitespace non canonique, BOM ni newline finale. Toute différence de bytes est détectée avant acceptation.

Hash SHA-256 actif : `77706b420e6020bcddd4523abcd99d7a26c613381c0f072d61ee5e0dad049ee8`.

## 7. Signature et trust anchors

Signature : Ed25519 sur les bytes canoniques. Le trust anchor public est dans `src/lib/root-policy/trust-anchors.js`, séparé du document signé. Le `keyId` actif commence par `7b6352d8f75a0dc9`.

La clé de signature privée n'est ni dans le repo ni dans le runtime. Une enveloppe chiffrée `signing-key.enc.json` existe hors repo dans le répertoire humain local prévu ; son contenu n'a pas été lu pendant cette certification. Elle utilise scrypt + AES-256-GCM. Aucune variable de passphrase n'était présente dans l'environnement lors du contrôle. La passphrase n'est jamais documentée ici.

## 8. Anti-rollback

Le loader refuse une version sous le plancher de release et toute version inférieure au `highestVersionSeen` persistant. Les tests couvrent version ancienne authentiquement signée, mismatch document/signature et nouvelle version live suivie d'un rollback.

Limite opérationnelle : sur cette copie, aucun état persistant de boot production n'existait encore ; le plancher V1 s'applique déjà et le premier boot production persistera `highestVersionSeen=1`.

## 9. Tamper detection

Sont détectés : byte/value modifié, troncature, fichier vide, JSON invalide, whitespace/newline/BOM, ordre ou duplication de clés, hash remplacé, signature modifiée, signature étrangère, trust anchor inconnu et document permissif correctement signé mais hors plafond.

La modification live est détectée au prochain contrôle protégé (fenêtre d'environ une seconde) puis les opérations protégées passent en fail-closed.

## 10. Fail-closed

Policy absente, illisible, corrompue, non canonique, mal signée ou rollbackée : les opérations protégées reçoivent `DENY_POLICY_INVALID`. Les opérations non protégées restent disponibles pour que l'application affiche son état et permette la récupération humaine locale.

## 11. STOP/révocation

`DEVICE_STOP` est une classe spéciale codée : elle est autorisée indépendamment de la validité de la policy et de l'état de session. Les routes STOP/révocation OMEGA, RASSILON et Device Fabric ont été exercées avec policy valide, absente et altérée.

Inventaire routes certifiées recalculé : 149 routes analysées, 49 reconnues/gatées, dont 19 routes STOP ; 100 routes de lecture, inventaire, pairing, approval ou statut restent aux frontières certifiées existantes.

## 12. Cloud AI

Le choke point unique `privacy-guard.guardCloudCall` appelle Root Policy avant les providers texte, images et Groq STT. Une installation production neuve est Strict Local et cloud off. Le mode test opte explicitement pour un baseline cloud simulé via `DOCTEUR_TEST_MODE=1`; ce comportement n'est pas celui du runtime production.

Cloud explicitement activé + contenu neutre : autorisé. Strict Local, cloud off, secret structuré ou contenu privé : refus avant appel provider.

## 13. Secret/privacy enforcement

Le scan des fichiers production Root Policy/policy/tool/boot n'a trouvé aucune forme de clé privée ou token. Les seules formes sensibles du périmètre de tests sont des marqueurs/fixtures intentionnels. Le focus credential isolation/privacy/Strict Local passe 48/48 hors sandbox DPAPI.

Les logs Root Policy ne conservent que des identifiants bornés : événement, code, action, module, type d'acteur, domaine et version. Ils n'enregistrent ni prompt, URL, headers, cookie, token ni payload.

## 14. Process execution

Le launcher d'agents externes appelle `PROCESS_START` avant spawn avec executor connu, argv typés et sans commande libre. yt-dlp passe par l'action média et le proxy. Les CLI cloud passent d'abord par le choke point AI_CLOUD.

Le registre statique recense tous les imports `child_process`. Les exécuteurs non encore branchés Root Policy sont listés dans les limites de couverture ; ils utilisent des binaires fixes, argv typés et, sauf quatre probes de statut/version strictement littérales, `shell:false`.

## 15. Web Egress integration

Les entrées `safeFetch`, vérification externe, browser proxy et media proxy consultent Root Policy avant la décision de destination du Web Egress Guard. Le guard conserve la responsabilité DNS/IP, redirections, pinning et classifications réseau.

## 16. Media/yt-dlp integration

Chemin final : `yt-dlp -> proxy loopback Media Egress -> Web Egress Guard -> DNS/redirections/CDN validés -> Internet`.

Preuves finales :

- refus Root Policy avant spawn ;
- proxy sans credentials dans argv ;
- redirect public vers interne : contrôle non protégé atteint l'interne, chemin proxy = zéro connexion interne ;
- URL interne directe et chaîne de redirects refusées ;
- téléchargements directs et redirects publics fonctionnels ;
- HLS local réel via ffmpeg fonctionnel ;
- smoke public `DOCTEUR_NETWORK_TESTS=1` : metadata YouTube, petit téléchargement audio YouTube format public 234 (<20 Mo) et extrait HLS public borné à 2 secondes, 8/8 PASS ;
- `spawnInjected:true` absent ; le seam est calculé uniquement par comparaison avec un faux spawn injecté.

Cookies/session navigateur ne sont utilisés que lorsqu'ils sont explicitement configurés par l'utilisateur ; ils ne sont pas journalisés.

## 17. Frozen modules strategy

OMEGA V1/V2 outbound, RASSILON, Device Fabric, MAÎTRE, Monitor, Cyber et Notebook n'importent pas Root Policy. Le middleware sémantique se place au-dessus des routes certifiées, sans recréer leur moteur ADMIN ni leur approval flow.

Fichiers frozen modifiés par Root Policy : **0**. L'audit statique Device Fabric passe 23/23.

## 18. Static bypass audit

La suite `test-root-policy-static-audit.mjs` passe 12/12. Elle vérifie pureté du moteur, absence d'I/O/LLM, immutabilité runtime, API read-only, ordre de boot, choke points cloud/web/media, tous les spawns yt-dlp, registre de subprocess exhaustif, couverture des routes certifiées, STOP, absence de modification frozen et absence de second moteur ADMIN.

## 19. Coverage matrix

| Surface | Classe | Justification |
|---|---|---|
| Cloud AI | COVERED_BY_ROOT_POLICY | Choke point unique + privacy guard avant provider. |
| Web fetch/browser egress | COVERED_BY_ROOT_POLICY | Hook Root Policy puis Web Egress Guard. |
| Media/yt-dlp | COVERED_BY_ROOT_POLICY | MEDIA_INSPECT/DOWNLOAD + proxy obligatoire avant spawn. |
| External agents | COVERED_BY_ROOT_POLICY | PROCESS_START sémantique avant spawn. |
| OMEGA V1/V2 | COVERED_BY_FROZEN_CERTIFIED_BOUNDARY | Routes d'impact reconnues par middleware ; approval exact reste dans OMEGA. |
| RASSILON | COVERED_BY_FROZEN_CERTIFIED_BOUNDARY | Jobs/STOP reconnus ; pairing/session/job schema restent certifiés. |
| Device Fabric | COVERED_BY_FROZEN_CERTIFIED_BOUNDARY | Exact-target et routes d'impact reconnues ; aucun fichier frozen modifié. |
| MAÎTRE | COVERED_BY_FROZEN_CERTIFIED_BOUNDARY | Exécution après proposition/approval/re-check ; route execute reconnue. |
| Notebook | COVERED_BY_FROZEN_CERTIFIED_BOUNDARY | Suites NB2–NB7 et privacy passent ; cloud passe par le choke point global. |
| Connecteurs | READ_ONLY_NON_IMPACT pour le périmètre V1 | Grants runtime actuels limités à CONNECTOR.READ ; secrets DPAPI testés. |
| Publish/send/transfer | NOT_APPLICABLE | Capacités préparées mais aucun executor de publication/envoi V1 actif. |
| Plugin/MCP install/start | NOT_APPLICABLE + NEVER_GRANTED | Aucun module ne reçoit ces capacités ; pas d'endpoint runtime. |
| Exécuteurs internes typés (11 fichiers) | GAP | Registre exhaustif et argv bornés, mais pas encore d'appel Root Policy direct. |
| FILE_WRITE/FILE_DELETE général | GAP | Catalogue et décisions existent, mais branchement runtime non uniforme hors frontières déjà certifiées. |
| Futur Runtime Supervisor | NOT_APPLICABLE | Non commencé conformément à la mission. |

Les deux lignes GAP empêchent le qualificatif « couverture globale » et le freeze.

## 20. Tests dédiés

Commande finale des six suites : 104 tests, 18 suites, 104 pass, 0 fail, 0 cancelled, 0 skipped, 10 737 ms.

Répartition connue : moteur 30, intégrité 38, média local 7, static audit 12, gate 5, intégration 12. La suite réseau conditionnelle séparée ajoute 8/8 PASS avec réseau public activé.

## 21. Real harness

Le boot proof démarre le vrai serveur trois fois sur des données temporaires loopback :

- VALID : `VALID/VERIFIED`, opérations protégées activées ;
- CORRUPTED : `HASH_MISMATCH`, tamper détecté, opérations protégées 503/fail-closed, STOP disponible ;
- MISSING : `POLICY_MISSING`, fail-closed, STOP disponible ;
- API mutante Root Policy : POST/PUT/PATCH/DELETE = 404 ;
- audit chain valide pour chaque boot ;
- répertoire policy réel inchangé.

Les scénarios signature invalide, clé étrangère, rollback, restauration live d'une paire valide et récupération sont couverts dans les 38 tests d'intégrité.

## 22. Full backend regressions

Commande : `node test-manifest.mjs --run --test-timeout=180000 --test-concurrency=3` avec reporter TAP durable.

Résultat terminal final : **3150 tests / 3143 pass / 0 fail / 0 cancelled / 7 skipped**, 53 suites, durée 209 102,867 ms. Aucun `not ok`.

Les skips sont environnementaux/non applicables : quatre preuves Ollama/nomic réelles indisponibles, deux branches « non-Windows » non applicables sous Windows et une action d'entrée réelle volontairement non exécutée. La suite Internet média, skippée dans le sweep par défaut, a ensuite été exécutée explicitement et passe 8/8.

Régression frozen dédiée : 1607 tests / 1600 pass / 0 fail / 0 cancelled / 7 skipped, 86 231,909 ms. Le sweep backend final, postérieur, recouvre également ces familles.

## 23. Typecheck/build/boot

- Typecheck : PASS via `npm run build` (`tsc`, code 0).
- Build : PASS ; Vite 8.1.3, 1760 modules, PWA générée, code 0. L'avertissement de taille de chunks est non bloquant.
- Boot : PASS ; vrai serveur loopback démarré dans les trois états, status Root Policy disponible, Media Egress attendu avant `serve()`, aucune erreur Media Egress observée. Le health HTTP vaut 503 dans l'environnement de preuve uniquement parce qu'Ollama est absent ; le serveur répond et le boot est effectif.
- Aucun listener public inattendu : boot proof force et observe `127.0.0.1`; le défaut serveur hors `LOCAL_NETWORK` est loopback.
- Aucun appel cloud au démarrage n'a été observé ; Strict Local production est le défaut.

## 24. Secret/privacy/Git hygiene

- Focus credentials/privacy/Strict Local : 48/48 PASS.
- Scan production Root Policy : aucune forme de private key/token détectée.
- Clé chiffrée hors repo ; passphrase absente de l'environnement.
- Aucune nouvelle dépendance Root Policy ; Node natif suffit.
- `package-lock.json` et les manifests serveur n'ont pas reçu de dépendance Root Policy.
- Deux repos imbriqués préexistants détectés sous `external/MetaGPT` et `external/OpenMontage`; aucun n'a été modifié par cette mission.
- `git diff --check` : PASS (avertissements CRLF seulement, aucune erreur whitespace).
- Worktree préexistant très chargé : 184 entrées finales (39 modified, 145 untracked). Les modifications hors scope ont été préservées.
- Mutations Git effectuées : 0 (`add/commit/push/reset/clean/stash` jamais appelés).

## 25. Recovery / break-glass

État réel : la paire active V1 est valide. La clé privée chiffrée hors repo existe. Aucune copie `policy/recovery/` n'existe encore car V1 est la première signature ; le tool créera cette copie avant tout remplacement futur.

Procédure humaine locale :

1. arrêter les actions protégées et conserver le canal STOP/local ;
2. ouvrir un terminal local humain, idéalement élevé et hors automatisation IA ;
3. sauvegarder la paire active et l'état anti-rollback ;
4. exécuter `root-policy-tool.mjs verify` et relever le plus haut numéro accepté ;
5. si une paire recovery existe, la vérifier ; ne jamais restaurer une version inférieure au plus haut numéro accepté ;
6. sinon, utiliser la clé chiffrée hors repo et saisir la passphrase interactivement pour signer une policy revue avec une version strictement suffisante ;
7. revérifier la paire, réappliquer `acl-lock`, puis redémarrer ou attendre la détection live ;
8. contrôler `/api/root-policy/status` et la chaîne d'audit avant de réactiver les opérations protégées.

Le break-glass n'est exposé par aucun endpoint, plugin, MCP, connecteur ou outil runtime. Une IA ne doit jamais recevoir la passphrase ni lancer cette cérémonie.

## 26. Limites connues

1. Onze exécuteurs internes typés restent non branchés directement à Root Policy : browser, code-intel git/search, ComfyUI installer, disk-space, Kiwix, MetaGPT, OpenMontage, process-tree, secret-store et Sherlock. Ils sont bornés et inventoriés, mais constituent un GAP de couverture.
2. FILE_WRITE/FILE_DELETE ne sont pas uniformément interceptés hors modules déjà certifiés ; GAP de couverture.
3. Quatre probes CLI cloud préexistantes utilisent `shell:true`, uniquement avec des argv littéraux `--version`, `auth status` ou `login status`; toute nouvelle occurrence fait échouer l'audit.
4. La copie de récupération précédente n'existe pas encore sur cette première version signée ; la récupération actuelle passe par une nouvelle signature humaine hors runtime.
5. L'état anti-rollback persistant de la machine sera créé au premier boot production ; le plancher V1 est déjà actif.
6. Un administrateur local complet peut remplacer le code/trust anchor ou patcher le runtime.
7. Quatre preuves qualitatives Ollama réelles n'ont pas été exécutées faute de modèles/service local ; elles sont étrangères à Root Policy.

## 27. Fichiers modifiés

Composants Root Policy et certification :

- `cortex-server/src/lib/root-policy/{schema,default-policy,loader,engine,route-map,audit,index,trust-anchors}.js`
- `cortex-server/src/routes/root-policy.js`
- `cortex-server/policy/root-policy.json`
- `cortex-server/policy/root-policy.sig.json`
- `cortex-server/policy/signing-log.jsonl`
- `cortex-server/root-policy-tool.mjs`
- `cortex-server/root-policy-boot-proof.mjs`
- `cortex-server/src/lib/media-egress.js`
- `cortex-server/test-root-policy-{engine,integrity,media,static-audit,gate,integration}.mjs`

Touchpoints runtime branchés : serveur, privacy guard, Web Egress Guard, image/cloud STT, launcher d'agents externes et appels yt-dlp/media. La correction finale ajoute aussi le défaut production Strict Local dans `src/lib/sqlite.js` sans modifier les préférences déjà persistées.

Corrections de reprise : fermeture SQLite du test d'intégration sous Windows, arrêt portable du boot proof, identité OS réelle pour les ACL du tool, preuve production Strict Local en sous-processus, et smoke média public réellement téléchargeant.

Les nombreux autres fichiers modified/untracked du worktree préexistaient ou appartiennent à d'autres missions ; ils n'ont pas été nettoyés, reset ni revendiqués par ce rapport.

## 28. Verdict

Les mécanismes cryptographiques, R1–R9, fail-closed, STOP, cloud/privacy, Web Egress, media/yt-dlp, non-régression frozen, build, boot et backend complet passent.

Verdict final : **PASS_WITH_LIMITATIONS** à cause des deux GAP de couverture runtime (exécuteurs internes typés et filesystem général). Root Policy V1 ne reçoit pas le statut FINAL/CERTIFIED/FROZEN dans cet état.

